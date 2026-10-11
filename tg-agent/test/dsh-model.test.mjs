import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DshModel, DshModelError } from '../src/dsh-model.mjs'

/**
 * Write an executable sh stub into a temp directory.
 *
 * @param {import('node:test').TestContext} t - test context, used for cleanup.
 * @param {string | ((dir: string) => string)} body - shell body after the shebang, or a builder receiving the temp dir.
 * @returns {Promise<{dir: string, file: string}>} stub location.
 */
async function withStub(t, body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-model-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'dsh-stub.sh')
  const script = typeof body === 'function' ? body(dir) : body
  await fs.writeFile(file, `#!/bin/sh\n${script}\n`, 'utf8')
  await fs.chmod(file, 0o755)
  return { dir, file }
}

/** Build a model around a stub, with a short default timeout. */
const makeModel = (command, options = {}) => new DshModel({ command, timeoutMs: 5000, ...options })

const user = (content) => ({ role: 'user', content })

/** Read a stub's `args.txt`: the four argv entries, prompt included. */
async function readArgs(dir) {
  const raw = await fs.readFile(path.join(dir, 'args.txt'), 'utf8')
  const [flag, profile, mode, ...rest] = raw.trimEnd().split('\n')
  return { argv: [flag, profile, mode], prompt: rest.join('\n') }
}

/** Poll until `pid` disappears, so a killed child is observed as reaped. */
async function waitForProcessExit(pid, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return true
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

/** Read the pid a stub recorded for the process the model should kill. */
const readPid = async (dir) => Number.parseInt(await fs.readFile(path.join(dir, 'pid.txt'), 'utf8'), 10)

/** Wait until a stub has created its marker file, then return its text. */
async function waitForFile(file, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(file, 'utf8')
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw new Error(`timed out waiting for ${file}`)
}

test('runs the CLI with the profile and prompt, returning trimmed stdout', async (t) => {
  const { dir, file } = await withStub(t, (tmp) => `
printf '%s\\n' "$@" > '${tmp}/args.txt'
printf '  привет, мир  \\n'
`)
  const model = makeModel(file)
  const result = await model.complete({ messages: [user('привет')] })

  assert.deepEqual(result, { text: 'привет, мир', model: 'dsh:headless' })
  const { argv, prompt } = await readArgs(dir)
  assert.deepEqual(argv, ['--profile', 'headless', 'headless'])
  assert.match(prompt, /Пользователь: привет/)
  assert.match(prompt, /Ответь на последнее сообщение пользователя\./)
})

test('flattens system, user and assistant messages in order', async (t) => {
  const { dir, file } = await withStub(t, (tmp) => `
printf '%s\\n' "$@" > '${tmp}/args.txt'
printf 'ok\\n'
`)
  const model = makeModel(file)
  await model.complete({
    messages: [
      { role: 'system', content: 'Ты полезный ассистент.' },
      user('первый вопрос'),
      { role: 'assistant', content: 'первый ответ' },
      user('второй вопрос'),
    ],
  })

  const { prompt } = await readArgs(dir)
  const order = [
    'Ты полезный ассистент.',
    'Пользователь: первый вопрос',
    'Ассистент: первый ответ',
    'Пользователь: второй вопрос',
    'Ответь на последнее сообщение пользователя.',
  ].map((fragment) => {
    const index = prompt.indexOf(fragment)
    assert.notEqual(index, -1, `missing fragment: ${fragment}`)
    return index
  })
  for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], 'fragments are out of order')
})

test('skips empty messages when building the prompt', async (t) => {
  const { dir, file } = await withStub(t, (tmp) => `
printf '%s\\n' "$@" > '${tmp}/args.txt'
printf 'ok\\n'
`)
  const model = makeModel(file)
  await model.complete({ messages: [user('   '), user('настоящий вопрос'), { role: 'system', content: '' }] })

  const { prompt } = await readArgs(dir)
  assert.match(prompt, /Пользователь: настоящий вопрос/)
  assert.doesNotMatch(prompt, /Пользователь: {3}/)
})

test('rejects an empty conversation without spawning', async () => {
  let spawned = 0
  const model = new DshModel({
    command: '/bin/true',
    spawnImpl: () => {
      spawned++
      throw new Error('spawn must not be called')
    },
  })

  await assert.rejects(() => model.complete({ messages: [] }), (error) => {
    assert.ok(error instanceof DshModelError)
    assert.match(error.message, /no messages to send/)
    return true
  })
  await assert.rejects(() => model.complete({}), DshModelError)
  assert.equal(spawned, 0)
})

test('reports a non-zero exit with its code and stderr tail', async (t) => {
  const { file } = await withStub(t, `
printf 'boom: bad config\\n' >&2
exit 3
`)
  const model = makeModel(file)
  await assert.rejects(() => model.complete({ messages: [user('привет')] }), (error) => {
    assert.ok(error instanceof DshModelError)
    assert.equal(error.code, 3)
    assert.match(error.message, /exited with code 3/)
    assert.match(error.message, /boom: bad config/)
    assert.match(error.stderr, /boom: bad config/)
    return true
  })
})

test('rejects an empty stdout from a successful run', async (t) => {
  const { file } = await withStub(t, `
printf '   \\n'
exit 0
`)
  const model = makeModel(file)
  await assert.rejects(() => model.complete({ messages: [user('привет')] }), (error) => {
    assert.ok(error instanceof DshModelError)
    assert.match(error.message, /dsh returned an empty answer/)
    return true
  })
})

test('kills the child and times out', async (t) => {
  const { dir, file } = await withStub(t, (tmp) => `
echo $$ > '${tmp}/pid.txt'
exec sleep 5
`)
  // 1 s rather than a few hundred ms: under a loaded test runner the shell needs
  // time to write its pid file, and the assertion below checks that pid.
  const model = makeModel(file, { timeoutMs: 1000 })
  const started = Date.now()
  await assert.rejects(() => model.complete({ messages: [user('привет')] }), (error) => {
    assert.ok(error instanceof DshModelError)
    assert.match(error.message, /dsh run timed out after 1000 ms/)
    return true
  })
  assert.ok(Date.now() - started < 3000, 'timeout must not wait for the child')
  assert.equal(await waitForProcessExit(await readPid(dir)), true)
})

test('kills the child when the signal aborts', async (t) => {
  const { dir, file } = await withStub(t, (tmp) => `
echo $$ > '${tmp}/pid.txt'
exec sleep 5
`)
  const model = makeModel(file)
  const controller = new AbortController()
  const started = Date.now()
  const pending = model.complete({ messages: [user('привет')], signal: controller.signal })
  let pid
  try {
    pid = Number.parseInt(await waitForFile(path.join(dir, 'pid.txt')), 10)
  } finally {
    // Abort only once the stub is running, so the kill is observable.
    controller.abort()
  }
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, 'AbortError')
    return true
  })
  assert.ok(Date.now() - started < 2000, 'abort must not wait for the child')
  assert.equal(await waitForProcessExit(pid), true)
})

test('kills the child when stdout exceeds the output cap', async (t) => {
  const { file } = await withStub(t, `
i=0
while [ "$i" -lt 1024 ]; do
  printf '%0100d' 0
  i=$((i+1))
done
`)
  const model = makeModel(file, { maxOutputBytes: 1000 })
  await assert.rejects(() => model.complete({ messages: [user('привет')] }), (error) => {
    assert.ok(error instanceof DshModelError)
    assert.match(error.message, /dsh output exceeded 1000 bytes/)
    return true
  })
})

test('passes DSH_HOME to the child when home is configured', async (t) => {
  const { file } = await withStub(t, `
printf '%s' "$DSH_HOME"
`)
  const model = makeModel(file, { home: '/tmp/dsh-home-for-tests' })
  const result = await model.complete({ messages: [user('привет')] })
  assert.equal(result.text, '/tmp/dsh-home-for-tests')
})

test('derives the model name from the profile', () => {
  const model = new DshModel({ command: '/bin/true', profile: 'work' })
  assert.equal(model.name, 'dsh:work')
})
