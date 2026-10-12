import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DshTaskRunner } from '../src/dsh-task.mjs'
import { createTestLogger, cleanup, tempDir } from './helpers.mjs'

const fixture = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'fake-dsh.sh')

/** A runner wired to the fake dsh, with the mode the test needs. */
function runnerFor(dir, { mode = 'ok', timeoutMs = 10_000, extraEnv = {}, ...options } = {}) {
  return new DshTaskRunner({
    command: fixture,
    workspaceDir: dir,
    dshHome: path.join(dir, 'dsh-home'),
    profile: 'headless',
    permissionMode: 'workspace-write',
    apiKey: 'sk-test',
    timeoutMs,
    logger: createTestLogger(),
    env: { ...process.env, FAKE_DSH_NODE: process.execPath, FAKE_DSH_MODE: mode, ...extraEnv },
    ...options,
  })
}

test('a successful run yields the answer and the summed usage', async () => {
  const dir = await tempDir()
  try {
    const events = []
    const runner = runnerFor(dir, { onEvent: (event) => events.push(event) })
    const result = await runner.run({ task: 'посчитай 2+2' })

    assert.equal(result.ok, true)
    assert.equal(result.exitCode, 0)
    assert.match(result.text, /Задача: посчитай 2\+2/)
    assert.equal(result.sessionId, 'session-test-0001')
    assert.equal(result.usage.steps, 2)
    assert.equal(result.usage.inputTokens, 110)
    assert.equal(result.usage.outputTokens, 25)
    assert.equal(result.usage.cacheReadTokens, 35)
    assert.equal(result.usage.totalTokens, 170)
    assert.deepEqual(result.tools, ['bash'])
    assert.ok(events.some((event) => event.type === 'final'))
  } finally {
    await cleanup(dir)
  }
})

test('a run over its token budget is stopped instead of paid for', async () => {
  const dir = await tempDir()
  try {
    const runner = runnerFor(dir, { tokenBudget: 100 })
    const result = await runner.run({ task: 'задача, которая пошла вразнос' })
    assert.equal(result.budgetExceeded, true)
    assert.equal(result.ok, false)
    assert.ok(result.usage.totalTokens >= 150, `посчитано ${result.usage.totalTokens}`)
    // The fake writes both steps before SIGTERM lands, so the step counter cannot
    // prove the kill: what matters is that the ceiling was noticed and the run
    // was stopped (in a live run the next step needs a model round-trip).
  } finally {
    await cleanup(dir)
  }
})

test('a run under its budget is untouched', async () => {
  const dir = await tempDir()
  try {
    const result = await runnerFor(dir, { tokenBudget: 10_000 }).run({ task: 'посчитай 2+2' })
    assert.equal(result.budgetExceeded, false)
    assert.equal(result.ok, true)
    assert.equal(result.usage.totalTokens, 170)
  } finally {
    await cleanup(dir)
  }
})

test('the budget is off by default and can be switched off explicitly', async () => {
  const dir = await tempDir()
  try {
    const result = await runnerFor(dir, { tokenBudget: 0 }).run({ task: 'посчитай 2+2' })
    assert.equal(result.budgetExceeded, false)
    assert.equal(result.ok, true)
  } finally {
    await cleanup(dir)
  }
})

test('the task travels on stdin and never in argv', async () => {
  const dir = await tempDir()
  try {
    const runner = runnerFor(dir, { mode: 'args' })
    const result = await runner.run({ task: '--дашборд с дефисами' })
    const observed = JSON.parse(result.text)
    // The profile comes from --profile only: no stray profile word that would
    // become part of the task, and the task itself never appears in argv.
    assert.deepEqual(observed.argv, ['--profile', 'headless', '--json', '-'])
    assert.equal(observed.argv.includes('--дашборд с дефисами'), false)
    // macOS resolves the temporary directory through the /private symlink.
    assert.equal(await fs.realpath(observed.cwd), await fs.realpath(dir))
  } finally {
    await cleanup(dir)
  }
})

test('a session id is passed through to dsh', async () => {
  const dir = await tempDir()
  try {
    const runner = runnerFor(dir, { mode: 'args' })
    const result = await runner.run({ task: 'продолжи', sessionId: 'session-abc' })
    const observed = JSON.parse(result.text)
    assert.deepEqual(observed.argv, ['--profile', 'headless', '--json', '--session-id', 'session-abc', '-'])
  } finally {
    await cleanup(dir)
  }
})

test('the child sees the model key, the workspace home and no telemetry', async () => {
  const dir = await tempDir()
  try {
    const runner = runnerFor(dir, { mode: 'env' })
    const result = await runner.run({ task: 'проверь окружение' })
    const env = JSON.parse(result.text)
    assert.equal(env.DEEPSEEK_API_KEY, 'sk-test')
    assert.equal(env.DSH_HOME, path.join(dir, 'dsh-home'))
    assert.equal(env.DSH_PERMISSION_MODE, 'workspace-write')
    assert.equal(env.DSH_TELEMETRY_DISABLED, '1')
  } finally {
    await cleanup(dir)
  }
})

test('a failing run keeps the exit code, the error events and the stderr tail', async () => {
  const dir = await tempDir()
  try {
    const result = await runnerFor(dir, { mode: 'fail' }).run({ task: 'сломайся' })
    assert.equal(result.ok, false)
    assert.equal(result.exitCode, 1)
    assert.equal(result.text, '')
    assert.deepEqual(result.errors, ['модель недоступна'])
    assert.match(result.stderr, /MODEL_ERROR/)
  } finally {
    await cleanup(dir)
  }
})

test('a hung run is killed by the timeout, whole process group included', async () => {
  const dir = await tempDir()
  try {
    const started = Date.now()
    const result = await runnerFor(dir, { mode: 'hang', timeoutMs: 400 }).run({ task: 'зависни' })
    const elapsed = Date.now() - started
    assert.equal(result.ok, false)
    assert.equal(result.timedOut, true)
    assert.ok(elapsed < 8000, `run should end soon after the timeout, took ${elapsed} ms`)
  } finally {
    await cleanup(dir)
  }
})

test('an abort signal stops the run', async () => {
  const dir = await tempDir()
  try {
    const controller = new AbortController()
    const promise = runnerFor(dir, { mode: 'hang', timeoutMs: 30_000 }).run({ task: 'стой', signal: controller.signal })
    setTimeout(() => controller.abort(), 150)
    const result = await promise
    assert.equal(result.aborted, true)
    assert.equal(result.ok, false)
    assert.equal(result.timedOut, false)
  } finally {
    await cleanup(dir)
  }
})

test('non-JSON noise on stdout is ignored, the answer still arrives', async () => {
  const dir = await tempDir()
  try {
    const result = await runnerFor(dir, { mode: 'badjson' }).run({ task: 'шум' })
    assert.equal(result.ok, true)
    assert.equal(result.text, 'ответ из шумного потока')
  } finally {
    await cleanup(dir)
  }
})

test('a run without an answer is a failure, not an empty message', async () => {
  const dir = await tempDir()
  try {
    const result = await runnerFor(dir, { mode: 'empty' }).run({ task: 'молчи' })
    assert.equal(result.ok, false)
    assert.equal(result.turnReason.kind, 'completed')
    assert.match(result.errors.join(' '), /без ответа/)
  } finally {
    await cleanup(dir)
  }
})

test('a missing dsh binary is reported, not hung on', async () => {
  const dir = await tempDir()
  try {
    const runner = new DshTaskRunner({
      command: path.join(dir, 'нет-такого-dsh'),
      workspaceDir: dir,
      dshHome: dir,
      logger: createTestLogger(),
    })
    const result = await runner.run({ task: 'привет' })
    assert.equal(result.ok, false)
    assert.ok(result.spawnError, 'the spawn error is kept for diagnostics')
  } finally {
    await cleanup(dir)
  }
})

test('a run is placed in its own cgroup and the group is handed back', async () => {
  const dir = await tempDir()
  try {
    const calls = []
    const cgroup = {
      async create(id) {
        calls.push({ kind: 'create', id })
        return { dir: '/fake/task' }
      },
      async assign(handle, pid) {
        calls.push({ kind: 'assign', handle, pid })
        return true
      },
      async release(handle) {
        calls.push({ kind: 'release', handle })
      },
    }
    const result = await runnerFor(dir, { cgroup }).run({ task: 'привет', id: 'task-42' })
    assert.equal(result.ok, true)
    assert.deepEqual(calls[0], { kind: 'create', id: 'task-42' })
    assert.equal(calls[1].kind, 'assign')
    assert.ok(calls[1].pid > 0, 'the child pid is placed in the group')

    // The release is fire-and-forget, so give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(calls.some((call) => call.kind === 'release'), true)
  } finally {
    await cleanup(dir)
  }
})
