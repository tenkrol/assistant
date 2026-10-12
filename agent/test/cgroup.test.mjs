import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { CgroupLimiter, cgroupNameFor, ownCgroupPath } from '../src/cgroup.mjs'
import { cleanup, createTestLogger, tempDir } from './helpers.mjs'

/** A fake cgroup mount with the service's directory already delegated. */
async function fakeCgroup({ leaf = 'payload', cgroupPath = '/system.slice/dsh-agent.service/payload' } = {}) {
  const root = await tempDir('cgroup-')
  const unitDir = path.join(root, 'system.slice', 'dsh-agent.service')
  const ownDir = leaf === '' ? unitDir : path.join(unitDir, leaf)
  await fs.mkdir(ownDir, { recursive: true })
  await fs.writeFile(path.join(ownDir, 'cgroup.subtree_control'), '')
  await fs.writeFile(path.join(unitDir, 'cgroup.subtree_control'), '')
  const cgroupFile = path.join(root, 'self-cgroup')
  await fs.writeFile(cgroupFile, `0::${cgroupPath}\n`)
  return { root, unitDir, ownDir, cgroupFile }
}

test('the own cgroup path is read from /proc/self/cgroup', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'cgroup')
    await fs.writeFile(file, '0::/system.slice/dsh-agent.service/payload\n')
    assert.equal(await ownCgroupPath({ cgroupFile: file }), '/system.slice/dsh-agent.service/payload')
  } finally {
    await cleanup(dir)
  }
})

test('a host without cgroup v2 is reported', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'cgroup')
    await fs.writeFile(file, '11:memory:/docker/abc\n')
    await assert.rejects(() => ownCgroupPath({ cgroupFile: file }), /cgroup v2/)
  } finally {
    await cleanup(dir)
  }
})

test('cgroup directory names are sanitised', () => {
  assert.equal(cgroupNameFor('1712-1'), 'task-1712-1')
  assert.equal(cgroupNameFor('a/b c'), 'task-a_b_c')
  assert.equal(cgroupNameFor(undefined), 'task-x')
  assert.ok(cgroupNameFor('x'.repeat(200)).length <= 66)
})

test('with a delegated payload the limiter uses the parent cgroup', async () => {
  const env = await fakeCgroup()
  try {
    const limiter = new CgroupLimiter({ root: env.root, cgroupFile: env.cgroupFile, memoryMaxBytes: 64 * 1024 * 1024, cpuPercent: 150, pidsMax: 64, logger: createTestLogger() })
    assert.equal(await limiter.probe(), true)
    // The first usable directory wins; on a real host that is the unit cgroup,
    // because the service's own processes occupy the payload leaf.
    assert.equal([env.ownDir, env.unitDir].includes(limiter.base), true)

    const subtree = await fs.readFile(path.join(limiter.base, 'cgroup.subtree_control'), 'utf8')
    assert.match(subtree, /memory/)
    assert.match(subtree, /cpu/)
    assert.match(subtree, /pids/)
  } finally {
    await cleanup(env.root)
  }
})

test('a leaf that cannot take controllers falls back to its parent', async () => {
  const env = await fakeCgroup()
  try {
    // Simulate the real constraint: the service runs in the leaf, so cgroup v2
    // refuses to enable controllers there.
    await fs.chmod(env.ownDir, 0o555)
    const limiter = new CgroupLimiter({ root: env.root, cgroupFile: env.cgroupFile, logger: createTestLogger() })
    assert.equal(await limiter.probe(), true)
    assert.equal(limiter.base, env.unitDir)
  } finally {
    await fs.chmod(env.ownDir, 0o755).catch(() => {})
    await cleanup(env.root)
  }
})

test('a task cgroup carries the memory, cpu and pids caps', async () => {
  const env = await fakeCgroup()
  try {
    const limiter = new CgroupLimiter({ root: env.root, cgroupFile: env.cgroupFile, memoryMaxBytes: 512 * 1024 * 1024, cpuPercent: 150, pidsMax: 64, logger: createTestLogger() })
    const handle = await limiter.create('task-1')
    assert.ok(handle, 'a handle is returned')

    assert.equal(await fs.readFile(path.join(handle.dir, 'memory.max'), 'utf8'), String(512 * 1024 * 1024))
    assert.equal(await fs.readFile(path.join(handle.dir, 'cpu.max'), 'utf8'), '150000 100000')
    assert.equal(await fs.readFile(path.join(handle.dir, 'pids.max'), 'utf8'), '64')

    assert.equal(await limiter.assign(handle, 4242), true)
    assert.equal(await fs.readFile(path.join(handle.dir, 'cgroup.procs'), 'utf8'), '4242')

    // A real cgroup directory holds no regular files, so the interface files are
    // removed to model that; `release` then only has to drop the directory.
    for (const file of ['memory.max', 'memory.swap.max', 'cpu.max', 'pids.max', 'cgroup.procs']) {
      await fs.rm(path.join(handle.dir, file), { force: true })
    }
    await limiter.release(handle)
    await assert.rejects(() => fs.stat(handle.dir), /ENOENT/)
  } finally {
    await cleanup(env.root)
  }
})

test('without delegation the limiter reports itself unusable instead of failing a task', async () => {
  const env = await fakeCgroup({ leaf: '', cgroupPath: '/system.slice/dsh-agent.service' })
  try {
    // Nothing is writable under a read-only-looking root: point the limiter at a
    // missing directory, which is what an undelegated host looks like.
    const limiter = new CgroupLimiter({ root: path.join(env.root, 'nope'), cgroupFile: env.cgroupFile, logger: createTestLogger() })
    assert.equal(await limiter.probe(), false)
    assert.equal(await limiter.create('task-1'), undefined)
    assert.equal(await limiter.assign(undefined, 1), false)
    await limiter.release(undefined)
  } finally {
    await cleanup(env.root)
  }
})

test('release tolerates a group that is already gone', async () => {
  const env = await fakeCgroup()
  try {
    const limiter = new CgroupLimiter({ root: env.root, cgroupFile: env.cgroupFile, logger: createTestLogger() })
    const handle = await limiter.create('task-2')
    await fs.rm(handle.dir, { recursive: true, force: true })
    await limiter.release(handle)
  } finally {
    await cleanup(env.root)
  }
})
