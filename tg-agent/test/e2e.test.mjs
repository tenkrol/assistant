/**
 * End-to-end run of the real entry point in a hermetic directory.
 *
 * The child gets only PATH/HOME and a generated `.env`, so these tests also
 * cover the documented `.env` loading path and can never reach the real Telegram
 * or the real model provider by accident.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createModelStub, createTelegramStub, testEnv, textUpdate, waitFor } from './helpers.mjs'

const entry = fileURLToPath(new URL('../src/index.mjs', import.meta.url))

/** Only the interpreter's own environment: configuration must come from `.env`. */
const minimalEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test' })

async function spawnBot(dir) {
  const child = spawn(process.execPath, [entry], { cwd: dir, env: minimalEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => { output.stdout += chunk })
  child.stderr.on('data', (chunk) => { output.stderr += chunk })
  return { child, output }
}

const writeEnvFile = (dir, values) =>
  fs.writeFile(path.join(dir, '.env'), Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n')

test('reads .env, answers one message, and shuts down cleanly on SIGTERM', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-e2e-'))
  const telegramStub = await createTelegramStub({ updates: [textUpdate({ text: 'привет из e2e', updateId: 1, userId: 777 })] })
  const modelStub = await createModelStub({ responses: [{ content: 'ответ из e2e' }] })
  t.after(async () => {
    await telegramStub.close()
    await modelStub.close()
    await fs.rm(dir, { recursive: true, force: true })
  })

  // LOG_LEVEL=info on purpose: the test asserts on the startup lines.
  await writeEnvFile(dir, {
    ...testEnv({
      telegramApiBase: telegramStub.apiBase,
      modelBaseUrl: modelStub.baseUrl,
      dataDir: './data',
    }),
    LOG_LEVEL: 'info',
  })
  const { child, output } = await spawnBot(dir)
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })

  await waitFor(() => output.stdout.includes('bot started'), { timeout: 15000, what: 'startup log' })
  const sent = await waitFor(() => telegramStub.state.sends[0], { timeout: 15000, what: 'the reply' })
  assert.equal(sent.text, 'ответ из e2e')
  assert.equal(sent.chat_id, 555)

  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  child.kill('SIGTERM')
  const outcome = await waitFor(() => Promise.resolve(exited), { timeout: 15000, what: 'shutdown' })
  const { code } = await outcome
  assert.equal(code, 0, `stderr: ${output.stderr}`)
  assert.match(output.stdout, /bot stopped/)

  const history = JSON.parse(await fs.readFile(path.join(dir, 'data', 'history.json'), 'utf8'))
  assert.deepEqual(history.chats['555'].messages.map((m) => m.content), ['привет из e2e', 'ответ из e2e'])
  const offset = JSON.parse(await fs.readFile(path.join(dir, 'data', 'offset.json'), 'utf8'))
  assert.equal(offset.offset, 2)
})

test('exits with code 2 and a readable message when no configuration is present', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-e2e-empty-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  const { child, output } = await spawnBot(dir)
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  const code = await new Promise((resolve) => child.once('exit', resolve))
  assert.equal(code, 2)
  assert.match(output.stderr, /configuration error: TELEGRAM_BOT_TOKEN/)
})
