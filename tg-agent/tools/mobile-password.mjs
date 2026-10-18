#!/usr/bin/env node
/**
 * Выдать пароль и секрет для мобильного сайта.
 *
 * Пароль хранится только scrypt-хешем, поэтому открытый текст нужен ровно один раз:
 * чтобы сообщить его владельцу. Скрипт ничего не пишет в репозиторий и не логирует
 * значения; вывод перенаправляйте в файл с правами 600.
 *
 *   node tools/mobile-password.mjs --generate
 *   echo 'мой-пароль' | node tools/mobile-password.mjs --password-stdin
 *
 * Первый режим печатает `MOBILE_PASSWORD=...` (его надо сохранить вне репозитория)
 * и готовые строки для `.env`. Второй — только хеш и секрет.
 */
import crypto from 'node:crypto'
import { createSessionSecret, hashPassword } from '../src/mobile-auth.mjs'

const args = new Set(process.argv.slice(2))

function usage() {
  process.stdout.write([
    'Использование:',
    '  node tools/mobile-password.mjs --generate           сгенерировать пароль и секрет',
    '  echo \'пароль\' | node tools/mobile-password.mjs --password-stdin   захешировать свой пароль',
    '',
    'Вывод содержит секреты. Не коммитьте его и не пересылайте в чат.',
    ''
  ].join('\n'))
}

function randomPassword() {
  // 24 символа base64url — около 144 бит энтропии, вводить вручную неудобно,
  // поэтому генерируем короткую, но стойкую фразу из 18 байт.
  return crypto.randomBytes(18).toString('base64url')
}

function printEnv(password, generated) {
  const hash = hashPassword(password)
  const secret = createSessionSecret()
  const lines = []
  if (generated) lines.push('# Пароль (показывается один раз, сохраните вне репозитория):')
  if (generated) lines.push(`MOBILE_PASSWORD=${password}`)
  lines.push(`MOBILE_PASSWORD_HASH=${hash}`)
  lines.push(`MOBILE_SESSION_SECRET=${secret}`)
  process.stdout.write(lines.join('\n') + '\n')
}

async function readStdinLine() {
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
    if (Buffer.concat(chunks).includes(10)) break
  }
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0]
}

async function main() {
  if (args.has('--help') || args.has('-h')) {
    usage()
    return
  }
  if (args.has('--generate')) {
    const password = randomPassword()
    printEnv(password, true)
    return
  }
  if (args.has('--password-stdin')) {
    const password = (await readStdinLine()).trim()
    if (password.length < 8) {
      process.stderr.write('Пароль короче 8 символов — отказываюсь.\n')
      process.exitCode = 1
      return
    }
    printEnv(password, false)
    return
  }
  usage()
  process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`ошибка: ${error?.message ?? error}\n`)
  process.exitCode = 1
})
