import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { OcrClient } from '../src/ocr.mjs'
import { createTestLogger } from './helpers.mjs'

/** A child process stub with the streams `OcrClient` listens to. */
function stubChild({ stdout = '', stderr = '', code = 0, error, onKill } = {}) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => onKill?.()
  setImmediate(() => {
    if (stdout) child.stdout.write(stdout)
    if (stderr) child.stderr.write(stderr)
    child.stdout.end()
    child.stderr.end()
    if (error) child.emit('error', error)
    else child.emit('close', code)
  })
  return child
}

test('recognised text is returned', async () => {
  const calls = []
  const client = new OcrClient({
    languages: 'rus+eng',
    logger: createTestLogger(),
    spawnImpl: (command, args) => {
      calls.push({ command, args })
      return stubChild({ stdout: 'Привет, мир\n' })
    },
  })
  const result = await client.extract({ path: '/tmp/скан.png' })
  assert.equal(result.text, 'Привет, мир')
  assert.deepEqual(calls[0].args, ['/tmp/скан.png', 'stdout', '-l', 'rus+eng'])
})

test('a tesseract failure carries its code and stderr', async () => {
  const client = new OcrClient({
    logger: createTestLogger(),
    spawnImpl: () => stubChild({ stderr: 'Error: cannot read input', code: 1 }),
  })
  const result = await client.extract({ path: '/tmp/x.png' })
  assert.equal(result.text, '')
  assert.match(result.error, /кодом 1/)
  assert.match(result.error, /cannot read input/)
})

test('an image without text is reported as such', async () => {
  const client = new OcrClient({ spawnImpl: () => stubChild({ stdout: '   \n' }) })
  const result = await client.extract({ path: '/tmp/пусто.png' })
  assert.match(result.error, /не нашлось текста/)
})

test('a missing tesseract binary is reported, not thrown', async () => {
  const client = new OcrClient({
    spawnImpl: () => {
      throw new Error('spawn tesseract ENOENT')
    },
  })
  const result = await client.extract({ path: '/tmp/x.png' })
  assert.match(result.error, /tesseract не запустился/)
})

test('an async spawn error is reported too', async () => {
  const client = new OcrClient({ spawnImpl: () => stubChild({ error: new Error('ENOENT') }) })
  const result = await client.extract({ path: '/tmp/x.png' })
  assert.match(result.error, /недоступен/)
})

test('probe reports whether the executable answers', async () => {
  const good = new OcrClient({ spawnImpl: () => stubChild({ code: 0 }) })
  assert.equal(await good.probe(), true)
  const bad = new OcrClient({ spawnImpl: () => stubChild({ code: 1 }) })
  assert.equal(await bad.probe(), false)
  const missing = new OcrClient({
    spawnImpl: () => {
      throw new Error('ENOENT')
    },
  })
  assert.equal(await missing.probe(), false)
})

test('a disabled client does nothing', async () => {
  const client = new OcrClient({ command: '' })
  assert.equal(client.enabled, false)
  const result = await client.extract({ path: '/tmp/x.png' })
  assert.match(result.error, /отключён/)
})
