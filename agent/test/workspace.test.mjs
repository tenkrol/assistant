import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  collectOutputs,
  ensureInstructions,
  ensureWorkspace,
  formatSize,
  mimeOf,
  isPhoto,
  pruneReservedDirs,
  readDeliverable,
  snapshot,
} from '../src/workspace.mjs'
import { cleanup, tempDir } from './helpers.mjs'

test('the workspace gets its reserved directories', async () => {
  const dir = await tempDir()
  try {
    await ensureWorkspace(dir)
    for (const reserved of ['inbox', 'outbox']) {
      const stat = await fs.stat(path.join(dir, reserved))
      assert.ok(stat.isDirectory())
    }
  } finally {
    await cleanup(dir)
  }
})

test('the snapshot keeps the reserved directories and drops instructions and hidden files', async () => {
  const dir = await tempDir()
  try {
    await ensureWorkspace(dir)
    await fs.writeFile(path.join(dir, 'AGENTS.md'), 'правила')
    await fs.writeFile(path.join(dir, '.hidden'), 'x')
    await fs.writeFile(path.join(dir, 'nested.txt'), 'x')
    await fs.mkdir(path.join(dir, 'src'))
    await fs.writeFile(path.join(dir, 'src', 'main.py'), 'print(1)')
    await fs.writeFile(path.join(dir, 'inbox', 'from-user.txt'), 'x')
    await fs.writeFile(path.join(dir, 'outbox', 'result.txt'), 'x')

    const files = await snapshot(dir)
    const names = [...files.keys()].sort()
    // inbox/outbox are visible so deliverables can be detected, but the
    // instruction file and dotfiles are not candidates at all.
    assert.deepEqual(names, [
      path.join('inbox', 'from-user.txt'),
      'nested.txt',
      path.join('outbox', 'result.txt'),
      path.join('src', 'main.py'),
    ])

    // A user upload is never collected as a result of the task.
    const { selected } = await collectOutputs({ before: new Map(), after: files, dir })
    assert.deepEqual(selected.map((entry) => entry.relPath).sort(), [
      'nested.txt',
      path.join('outbox', 'result.txt'),
      path.join('src', 'main.py'),
    ])
  } finally {
    await cleanup(dir)
  }
})

test('collectOutputs reports only what changed, newest first, outbox first', async () => {
  const dir = await tempDir()
  try {
    await ensureWorkspace(dir)
    await fs.writeFile(path.join(dir, 'old.txt'), 'старый')
    const before = await snapshot(dir)

    await new Promise((resolve) => setTimeout(resolve, 10))
    await fs.writeFile(path.join(dir, 'scratch.txt'), 'черновик')
    await fs.writeFile(path.join(dir, 'outbox', 'отчёт.docx'), 'документ')
    const after = await snapshot(dir)

    const { selected } = await collectOutputs({ before, after, dir })
    assert.deepEqual(selected.map((entry) => entry.relPath), [path.join('outbox', 'отчёт.docx'), 'scratch.txt'])
    assert.equal(selected[0].outbox, true)
    assert.equal(selected[1].outbox, false)
    assert.equal(selected[0].photo, false)
  } finally {
    await cleanup(dir)
  }
})

test('collectOutputs honours the file limit and reports the rest', async () => {
  const dir = await tempDir()
  try {
    await ensureWorkspace(dir)
    const before = await snapshot(dir)
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await fs.writeFile(path.join(dir, name), 'x')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const after = await snapshot(dir)
    const { selected, skipped } = await collectOutputs({ before, after, dir, maxFiles: 2 })
    assert.equal(selected.length, 2)
    assert.deepEqual(skipped, ['a.txt'])
  } finally {
    await cleanup(dir)
  }
})

test('collectOutputs flags an oversized file instead of dropping it silently', async () => {
  const dir = await tempDir()
  try {
    await ensureWorkspace(dir)
    const before = await snapshot(dir)
    await fs.writeFile(path.join(dir, 'big.bin'), Buffer.alloc(2048))
    const after = await snapshot(dir)
    const { selected } = await collectOutputs({ before, after, dir, maxBytes: 1024 })
    assert.equal(selected.length, 1)
    assert.equal(selected[0].tooLarge, true)
  } finally {
    await cleanup(dir)
  }
})

test('readDeliverable reads bytes, mime and refuses oversized files', async () => {
  const dir = await tempDir()
  try {
    await ensureWorkspace(dir)
    const target = path.join(dir, 'outbox', 'план.md')
    await fs.writeFile(target, '# план')
    const file = await readDeliverable({ path: target, relPath: 'outbox/план.md', size: 6 })
    assert.equal(file.bytes.toString('utf8'), '# план')
    assert.equal(file.mime, 'text/markdown')

    const refused = await readDeliverable({ path: target, relPath: 'outbox/план.md', size: 999 }, { maxBytes: 5 })
    assert.match(refused.error, /лимита/)
  } finally {
    await cleanup(dir)
  }
})

test('mime and photo detection follow the extension', () => {
  assert.equal(mimeOf('/x/отчёт.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.equal(mimeOf('/x/данные.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.equal(mimeOf('/x/график.png'), 'image/png')
  assert.equal(mimeOf('/x/что-то.unknownext'), 'application/octet-stream')
  assert.equal(isPhoto('/x/график.PNG'), true)
  assert.equal(isPhoto('/x/отчёт.pdf'), false)
})

test('ensureInstructions installs the template once and never overwrites it', async () => {
  const dir = await tempDir()
  try {
    await ensureWorkspace(dir)
    const template = path.join(dir, 'AGENTS.md.template')
    await fs.writeFile(template, 'правила окружения')
    assert.equal(await ensureInstructions(dir, template), true)
    assert.equal(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8'), 'правила окружения')

    await fs.writeFile(path.join(dir, 'AGENTS.md'), 'мои правки')
    assert.equal(await ensureInstructions(dir, template), false)
    assert.equal(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8'), 'мои правки')
  } finally {
    await cleanup(dir)
  }
})

test('pruning touches only the reserved directories and only old files', async () => {
  const dir = await tempDir()
  try {
    await ensureWorkspace(dir)
    const old = path.join(dir, 'inbox', 'старый.pdf')
    const fresh = path.join(dir, 'inbox', 'свежий.pdf')
    const scratch = path.join(dir, 'черновик.py')
    await fs.writeFile(old, 'x')
    await fs.writeFile(fresh, 'x')
    await fs.writeFile(scratch, 'x')
    const past = new Date(Date.now() - 30 * 24 * 3600 * 1000)
    await fs.utimes(old, past, past)

    const removed = await pruneReservedDirs(dir, { retentionDays: 14 })
    assert.equal(removed, 1)
    await assert.rejects(() => fs.access(old))
    await fs.access(fresh)
    await fs.access(scratch)
  } finally {
    await cleanup(dir)
  }
})

test('sizes are formatted for people', () => {
  assert.equal(formatSize(512), '512 Б')
  assert.equal(formatSize(2048), '2.0 КБ')
  assert.equal(formatSize(3 * 1024 * 1024), '3.0 МБ')
})
