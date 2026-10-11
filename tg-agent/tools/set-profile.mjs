#!/usr/bin/env node
/**
 * Update the bot's public profile: Telegram description, commands and the VK
 * community description.
 *
 * The texts live here on purpose: Telegram keeps them on its side, so a new feature
 * only reaches the profile when this script runs. Keep the wording in step with what
 * the deployment can really do — `/help` is generated from the code, this file is not.
 *
 * Usage:
 *
 *   node tools/set-profile.mjs            # show what would change
 *   node tools/set-profile.mjs --apply    # send the changes
 *
 * Reads TELEGRAM_BOT_TOKEN and VK_TOKEN from `.env` (or the environment).
 */
import fs from 'node:fs'

/** Shown in a Telegram profile, at most 120 characters. */
const SHORT_DESCRIPTION = 'Ассистент: напоминания и календарь, фото и документы, файлы на выход, опросы, конспект видео.'

/** Shown on the empty chat screen, at most 512 characters. */
const DESCRIPTION = `Пишите словами — я сам вызову нужный инструмент.

• Отвечу, поищу в сети, прочту страницу
• Напоминания с кнопками «отложить» и «отменить»
• Календарь: «запиши стоматолога 15 октября в 11:30»
• Дайджест в 8:00: погода, праздники, советы
• Помню факты и город; в группах личное не подмешиваю
• Фото и документы: PDF, DOCX, XLSX
• Голосовые: расшифрую и отвечу голосом
• Пришлю файл: Excel, Word, CSV
• Конспект видео с YouTube
• Опросы с кнопками
• Характер и настроение: /character, /mood

Команды — /help`

/** The Telegram command menu, also used inside group chats. */
const COMMANDS = [
  ['new', 'Начать диалог заново'],
  ['mode', 'Стиль ответов: кратко, подробно, код, письмо'],
  ['voice', 'Озвучивать ответы голосом (вкл/выкл)'],
  ['character', 'Характер бота: дружелюбный, с юмором, деловой…'],
  ['mood', 'Настроение: сегодняшнее или закрепить своё'],
  ['reminders', 'Список напоминаний'],
  ['cancel', 'Отменить напоминание по номеру'],
  ['calendar', 'Ближайшие события: встречи, приёмы, дни рождения'],
  ['city', 'Город для погоды по умолчанию'],
  ['memory', 'Что бот о вас помнит'],
  ['forget', 'Забыть факт: номер или all'],
  ['search', 'Поиск по нашей переписке'],
  ['export', 'Выгрузить ваши данные файлом'],
  ['model', 'Модель для этого чата'],
  ['stats', 'Расход токенов за сегодня'],
  ['digest', 'Прислать дайджест сейчас'],
  ['server', 'Состояние сервера, где работает бот'],
  ['whoami', 'Показать ваш ID'],
  ['help', 'Что я умею и список команд'],
]

/** The community description in VK. */
const VK_DESCRIPTION = 'Ассистент «Дом TenKrol»: напоминания и календарь, память о вас, фото и документы, файлы на выход, опросы, конспект видео. Утренний дайджест в 8:00. Напишите «что ты умеешь?» — расскажу подробнее.'

const VK_GROUP_ID = '242075818'
const TELEGRAM_LIMITS = { short: 120, description: 512 }

/** Read `.env` next to the project root without pulling in a dependency. */
function readEnv() {
  const env = { ...process.env }
  try {
    for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (match && env[match[1]] === undefined) env[match[1]] = match[2]
    }
  } catch {
    // No .env: the environment must carry the tokens.
  }
  return env
}

const env = readEnv()
const apply = process.argv.includes('--apply')

/** Fail before touching the network when a limit would be exceeded. */
function validate() {
  const problems = []
  if (SHORT_DESCRIPTION.length > TELEGRAM_LIMITS.short) problems.push(`короткое описание: ${SHORT_DESCRIPTION.length} > ${TELEGRAM_LIMITS.short}`)
  if (DESCRIPTION.length > TELEGRAM_LIMITS.description) problems.push(`описание: ${DESCRIPTION.length} > ${TELEGRAM_LIMITS.description}`)
  for (const [command, description] of COMMANDS) {
    if (!/^[a-z0-9_]{1,32}$/.test(command)) problems.push(`команда «${command}»: недопустимое имя`)
    if (description.length > 256) problems.push(`команда «${command}»: описание длиннее 256`)
  }
  return problems
}

const problems = validate()
if (problems.length > 0) {
  process.stderr.write(`профиль не обновлён:\n  ${problems.join('\n  ')}\n`)
  process.exit(1)
}

/** POST one Telegram method. */
async function telegram(method, payload) {
  const token = env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан')
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!body.ok) throw new Error(`${method}: ${body.description ?? response.status}`)
  return body.result
}

/** Call one VK method with the community token. */
async function vk(method, params) {
  const token = env.VK_TOKEN
  if (!token) throw new Error('VK_TOKEN не задан')
  const query = new URLSearchParams({ ...params, access_token: token, v: '5.199' })
  const response = await fetch(`https://api.vk.com/method/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: query,
    signal: AbortSignal.timeout(20_000),
  })
  const body = await response.json()
  if (body.error) throw new Error(`${method}: ${body.error.error_msg}`)
  return body.response
}

if (!apply) {
  process.stdout.write([
    'Что будет установлено (запустите с --apply, чтобы применить):',
    `  короткое описание: ${SHORT_DESCRIPTION.length} симв.`,
    `  описание:          ${DESCRIPTION.length} симв.`,
    `  команд:            ${COMMANDS.length} (личные чаты и группы)`,
    `  VK:                описание сообщества ${VK_GROUP_ID}`,
    '',
  ].join('\n'))
  process.exit(0)
}

const done = []
try {
  await telegram('setMyShortDescription', { short_description: SHORT_DESCRIPTION })
  done.push('Telegram: короткое описание')
  await telegram('setMyDescription', { description: DESCRIPTION })
  done.push('Telegram: описание')
  const commands = COMMANDS.map(([command, description]) => ({ command, description }))
  await telegram('setMyCommands', { commands })
  await telegram('setMyCommands', { commands, scope: { type: 'all_group_chats' } })
  done.push('Telegram: команды (личка и группы)')
} catch (error) {
  process.stderr.write(`Telegram: ${error.message}\n`)
}
try {
  await vk('groups.edit', { group_id: VK_GROUP_ID, description: VK_DESCRIPTION })
  done.push('VK: описание сообщества')
} catch (error) {
  process.stderr.write(`VK: ${error.message}\n`)
}

process.stdout.write(`${done.length > 0 ? `обновлено:\n  ${done.join('\n  ')}\n` : 'ничего не обновлено\n'}`)
