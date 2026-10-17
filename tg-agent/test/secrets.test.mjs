/**
 * Шифрование секретов: значения уходят в репозиторий только шифртекстом.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const tool = new URL('../tools/secrets.mjs', import.meta.url).pathname

/** Запустить команду инструмента в песочнице с паролем и своими путями. */
async function secrets(dir, command, passphrase, extra = []) {
  const args = [tool, command, '--in', path.join(dir, 'test.env'), '--out', path.join(dir, 'test.env.enc'), ...extra]
  return run(process.execPath, args, { env: { ...process.env, SECRETS_PASSPHRASE: passphrase }, cwd: dir })
}

test('шифрование и расшифровка возвращают исходные значения', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'secrets-'))
  try {
    const plain = 'TELEGRAM_BOT_TOKEN=123456:ABC\nMODEL_API_KEY=sk-test\n'
    await fs.writeFile(path.join(dir, 'test.env'), plain)
    await secrets(dir, 'encrypt', 'пароль-1')
    const encrypted = await fs.readFile(path.join(dir, 'test.env.enc'), 'utf8')
    assert.equal(encrypted.includes('123456:ABC'), false, 'значение не попадает в шифртекст')
    assert.equal(encrypted.includes('sk-test'), false)
    await fs.rm(path.join(dir, 'test.env'))
    await secrets(dir, 'decrypt', 'пароль-1')
    assert.equal(await fs.readFile(path.join(dir, 'test.env'), 'utf8'), plain)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('при расшифровке выставляются права 600', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'secrets-'))
  try {
    await fs.writeFile(path.join(dir, 'test.env'), 'A=1\n')
    await secrets(dir, 'encrypt', 'пароль')
    await secrets(dir, 'decrypt', 'пароль')
    const mode = (await fs.stat(path.join(dir, 'test.env'))).mode & 0o777
    assert.equal(mode, 0o600)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('чужой пароль не расшифровывает файл', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'secrets-'))
  try {
    await fs.writeFile(path.join(dir, 'test.env'), 'A=1\n')
    await secrets(dir, 'encrypt', 'правильный')
    await assert.rejects(() => secrets(dir, 'decrypt', 'неправильный'), /не расшифровывается/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('без пароля работать отказывается', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'secrets-'))
  try {
    await fs.writeFile(path.join(dir, 'test.env'), 'A=1\n')
    await assert.rejects(() => secrets(dir, 'encrypt', ''), /нет пароля/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('check сообщает имена переменных, но не значения', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'secrets-'))
  try {
    await fs.writeFile(path.join(dir, 'test.env'), 'TELEGRAM_BOT_TOKEN=секрет\n')
    await secrets(dir, 'encrypt', 'пароль')
    const { stdout } = await secrets(dir, 'check', 'пароль')
    assert.match(stdout, /TELEGRAM_BOT_TOKEN/)
    assert.equal(stdout.includes('секрет'), false, 'значения в вывод не попадают')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
