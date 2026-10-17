#!/usr/bin/env node
/**
 * Секреты проекта: открытым текстом в репозитории не лежит ничего.
 *
 * Значения хранятся в `secrets/prod.env.enc` — шифртекст (AES-256-GCM, ключ из пароля
 * через scrypt). Пароль берётся из переменной окружения SECRETS_PASSPHRASE: она не
 * попадает ни в аргументы командной строки (иначе видна в списке процессов), ни в файл.
 *
 *   SECRETS_PASSPHRASE=… node tg-agent/tools/secrets.mjs encrypt   # .env → secrets/prod.env.enc
 *   SECRETS_PASSPHRASE=… node tg-agent/tools/secrets.mjs decrypt   # secrets/prod.env.enc → .env
 *   SECRETS_PASSPHRASE=… node tg-agent/tools/secrets.mjs check     # проверить, что расшифровывается
 *
 * Пути можно переопределить: --in <файл> --out <файл>.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = process.env.PROJECT_ROOT ?? path.resolve(here, '../..')
const args = process.argv.slice(2)
const command = args.find((a) => !a.startsWith('--'))
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}
const plainPath = path.resolve(root, option('in', 'tg-agent/.env'))
const encryptedPath = path.resolve(root, option('out', 'secrets/prod.env.enc'))
const passphrase = process.env.SECRETS_PASSPHRASE ?? ''
const SCRYPT = { N: 16384, r: 8, p: 1 }

/** Ключ шифрования из пароля и соли. */
function key(salt) {
  return scryptSync(passphrase, salt, 32, SCRYPT)
}

function fail(message, code = 1) {
  console.error(`secrets: ${message}`)
  process.exit(code)
}

if (!passphrase) fail('нет пароля: задайте SECRETS_PASSPHRASE в окружении', 2)
if (!command) fail('команда: encrypt | decrypt | check', 2)

if (command === 'encrypt') {
  let text
  try {
    text = fs.readFileSync(plainPath, 'utf8')
  } catch {
    fail(`не читается ${plainPath}`)
  }
  if (text.trim() === '') fail(`${plainPath} пуст — нечего шифровать`)
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(salt), iv)
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const envelope = {
    v: 1,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
  fs.mkdirSync(path.dirname(encryptedPath), { recursive: true })
  fs.writeFileSync(encryptedPath, JSON.stringify(envelope, null, 2) + '\n', { mode: 0o600 })
  console.log(`зашифровано: ${path.relative(root, plainPath)} → ${path.relative(root, encryptedPath)} (открытым текстом в репозиторий не попадает)`)
} else if (command === 'decrypt') {
  const envelope = readEnvelope()
  const text = decrypt(envelope)
  fs.mkdirSync(path.dirname(plainPath), { recursive: true })
  fs.writeFileSync(plainPath, text, { mode: 0o600 })
  fs.chmodSync(plainPath, 0o600)
  console.log(`расшифровано: ${path.relative(root, encryptedPath)} → ${path.relative(root, plainPath)} (права 600)`)
} else if (command === 'check') {
  readEnvelope()
  const envelope = readEnvelope()
  const text = decrypt(envelope)
  const lines = text.split('\n').filter((line) => /^[A-Z0-9_]+=/.test(line))
  console.log(`проверка прошла: файл расшифровывается, переменных ${lines.length}, имён: ${lines.map((l) => l.split('=')[0]).join(', ')}`)
} else {
  fail(`неизвестная команда «${command}»`, 2)
}

/** Прочитать и проверить конверт шифртекста. */
function readEnvelope() {
  let raw
  try {
    raw = fs.readFileSync(encryptedPath, 'utf8')
  } catch {
    fail(`не читается ${encryptedPath}: секреты ещё не зашифрованы`)
  }
  let envelope
  try {
    envelope = JSON.parse(raw)
  } catch {
    fail(`${encryptedPath} повреждён`)
  }
  if (envelope?.v !== 1 || !envelope.salt || !envelope.iv || !envelope.tag || !envelope.data) {
    fail(`${encryptedPath}: незнакомый формат (ожидался v=1)`)
  }
  return envelope
}

/** Расшифровать текст конверта. */
function decrypt(envelope) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(Buffer.from(envelope.salt, 'base64')), Buffer.from(envelope.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    fail('не расшифровывается: неверный пароль или файл повреждён', 3)
  }
}
