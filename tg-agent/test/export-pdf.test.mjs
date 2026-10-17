/**
 * `/export` и его необязательный формат.
 *
 * Главное здесь — что текстовая выгрузка осталась прежней строкой в строку, а
 * PDF собирается из тех же разделов, начинается с `%PDF-` и содержит кириллицу
 * заголовков. Если на машине нет шрифта с кириллицей, PDF-тесты пропускаются:
 * окружение не должно делать прогон красным.
 */
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import test from 'node:test'
import { createCommandRouter } from '../src/core/commands.mjs'
import { ExportPdfError, buildExportDocument, buildExportPdf } from '../src/core/export.mjs'
import { findFontPath } from '../src/pdf.mjs'

const fontPath = findFontPath()

/** Поддельный бот: маршрутизатору нужны только данные и две отправки. */
function createBot({ profiles, reminders, history, model = 'test-model', sendDocument } = {}) {
  const sent = []
  const files = []
  return {
    config: { model: { name: model } },
    profiles,
    reminders,
    history,
    sent,
    files,
    async send(chatId, text) {
      sent.push({ chatId, text })
      return { messageId: sent.length }
    },
    async sendFile(chatId, file, replyToMessageId) {
      files.push({ chatId, file, replyToMessageId })
      return sendDocument ? sendDocument(file) : true
    },
  }
}

/** Полный профиль: все разделы непустые, данные легко узнать в файле. */
function fullBot(options = {}) {
  return createBot({
    profiles: {
      store: {
        facts: () => [{ id: '1', text: 'его зовут Андрей' }, { id: '2', text: 'живёт в Москве' }],
        city: () => 'Москва',
        persona: () => 'дружелюбный',
        mood: () => 'весёлый',
      },
    },
    history: {
      model: () => 'test-model',
      voice: () => true,
      messages: () => [
        { role: 'user', content: 'привет' },
        { role: 'assistant', content: 'здравствуйте' },
      ],
    },
    reminders: {
      store: {
        list: () => [{ id: '10', dueAt: '2026-10-20T06:00:00.000Z', repeat: 'daily', text: 'пить воду' }],
      },
    },
    ...options,
  })
}

const message = { chat: { id: 500, type: 'private' }, from: { id: 7 }, message_id: 42 }

/** Символы, которые писатель PDF положил в `/ToUnicode`. */
function cmapCharacters(buffer) {
  const latin = buffer.toString('latin1')
  const at = latin.indexOf('begincmap')
  assert.ok(at > 0, 'в PDF нет тела `/ToUnicode`')
  const dictAt = latin.lastIndexOf('<<', at)
  const end = latin.indexOf('endobj', at)
  const streamAt = latin.indexOf('stream', dictAt)
  const dictionary = latin.slice(dictAt, streamAt)
  const from = streamAt + 'stream\n'.length
  const to = latin.lastIndexOf('endstream', end)
  const raw = Buffer.from(latin.slice(from, to), 'latin1')
  const cmap = /\/Filter\s*\/FlateDecode/.test(dictionary) ? inflateSync(raw).toString('latin1') : raw.toString('latin1')
  const characters = new Set()
  for (const match of cmap.matchAll(/^<[0-9a-f]{4}> <([0-9a-f]{4,8})>$/gim)) {
    const hex = match[1]
    for (let index = 0; index < hex.length; index += 4) {
      characters.add(String.fromCharCode(Number.parseInt(hex.slice(index, index + 4), 16)))
    }
  }
  return characters
}

/** Кириллица строки должна быть в CMap: значит, текст действительно нарисован. */
function assertHasText(characters, text) {
  for (const character of text) {
    if (/\s/.test(character)) continue
    assert.ok(characters.has(character), `в PDF нет символа «${character}» из «${text}»`)
  }
}

/** `/Title` записан UTF-16BE в hex — читаем его обратно. */
function pdfTitle(buffer) {
  const match = /\/Title <FEFF([0-9a-f]+)>/i.exec(buffer.toString('latin1'))
  assert.ok(match, 'в PDF нет `/Title`')
  let title = ''
  for (let index = 0; index < match[1].length; index += 4) {
    title += String.fromCharCode(Number.parseInt(match[1].slice(index, index + 4), 16))
  }
  return title
}

test('/export без аргумента остаётся прежней текстовой выгрузкой', async () => {
  const bot = fullBot()
  await createCommandRouter(bot).runCommand({ name: 'export', args: '' }, message)

  assert.equal(bot.files.length, 1, 'текстовая выгрузка уходит файлом')
  const { fileName, bytes } = bot.files[0].file
  assert.match(fileName, /^vygruzka-\d{4}-\d{2}-\d{2}\.md$/, 'имя текстового файла не изменилось')
  const text = bytes.toString('utf8')
  const date = /^Дата: (.+)$/m.exec(text)?.[1]
  assert.ok(date && !Number.isNaN(Date.parse(date)), 'в выгрузке есть ISO-дата')
  // Формат зафиксирован дословно: это и есть проверка «поведение не изменилось».
  assert.equal(text, [
    '# Выгрузка из бота',
    '',
    `Дата: ${date}`,
    '',
    '## Настройки',
    '',
    '- город: Москва',
    '- характер: дружелюбный',
    '- настроение: весёлый',
    '- модель: test-model',
    '- озвучка ответов: включена',
    '',
    '## Что бот помнит',
    '',
    '- №1: его зовут Андрей',
    '- №2: живёт в Москве',
    '',
    '## Напоминания',
    '',
    '- №10 2026-10-20T06:00:00.000Z (daily): пить воду',
    '',
    '## История диалога (последние сообщения)',
    '',
    '**Вы:** привет',
    '**Бот:** здравствуйте',
    '',
  ].join('\n'))
})

test('/export без аргумента на пустых данных показывает прежние заглушки', async () => {
  const bot = createBot()
  await createCommandRouter(bot).runCommand({ name: 'export', args: '' }, message)
  const text = bot.files[0].file.bytes.toString('utf8')
  assert.match(text, /^- город: не задан$/m)
  assert.match(text, /^- характер: обычный$/m)
  assert.match(text, /^- настроение: меняется само$/m)
  assert.match(text, /^- модель: test-model$/m)
  assert.match(text, /^- озвучка ответов: выключена$/m)
  assert.match(text, /^— пока ничего$/m)
  assert.match(text, /^— нет$/m)
})

test('/export pdf присылает валидный PDF с теми же разделами', { skip: !fontPath && 'нет шрифта с кириллицей' }, async () => {
  const bot = fullBot()
  // Формат разбирается без учёта регистра и лишних пробелов.
  await createCommandRouter(bot).runCommand({ name: 'export', args: ' PDF ' }, message)

  assert.equal(bot.sent.length, 0, 'при успехе не должно быть текстового ответа')
  assert.equal(bot.files.length, 1, 'PDF отправлен одним файлом')
  const { fileName, bytes, caption } = bot.files[0].file
  assert.match(fileName, /^vygruzka-\d{4}-\d{2}-\d{2}\.pdf$/, 'имя файла оканчивается на .pdf')
  assert.equal(caption, 'Ваши данные из бота')
  assert.ok(Buffer.isBuffer(bytes), 'отправляются байты')
  assert.ok(bytes.length > 1000, `PDF слишком маленький: ${bytes.length} байт`)
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'файл начинается с %PDF-')
  assert.match(bytes.toString('latin1'), /%%EOF\s*$/)

  assert.equal(pdfTitle(bytes), 'Выгрузка из бота')
  const characters = cmapCharacters(bytes)
  for (const heading of ['Настройки', 'Что бот помнит', 'Напоминания', 'История диалога (последние сообщения)']) {
    assertHasText(characters, heading)
  }
  // Те же данные, что и в тексте, а не отдельная выборка.
  for (const value of ['Москва', 'его зовут Андрей', 'пить воду', 'здравствуйте']) {
    assertHasText(characters, value)
  }
})

test('/export pdf: нет шрифта — понятный текст, а не падение', async () => {
  const bot = fullBot()
  await createCommandRouter(bot).runCommand({ name: 'export', args: 'pdf' }, message)
  // На машине со шрифтом проверяем успех, без шрифта — текст с причиной.
  if (fontPath) {
    assert.equal(bot.files.length, 1)
    assert.equal(bot.sent.length, 0)
  } else {
    assert.equal(bot.files.length, 0)
    assert.equal(bot.sent.length, 1)
    assert.match(bot.sent[0].text, /шрифт/i)
  }
})

test('ошибка сборки PDF объясняется пользователю и не роняет команду', async () => {
  const bot = fullBot({
    profiles: {
      store: {
        facts: () => {
          throw new Error('хранилище недоступно')
        },
      },
    },
  })
  await createCommandRouter(bot).runCommand({ name: 'export', args: 'pdf' }, message)
  assert.equal(bot.files.length, 0, 'битый PDF не отправляется')
  assert.equal(bot.sent.length, 1, 'пользователь получил объяснение')
  assert.match(bot.sent[0].text, /хранилище недоступно/)
})

test('buildExportPdf отказывается без данных, без шрифта и с нечитаемым шрифтом', () => {
  assert.throws(() => buildExportPdf(null), (error) => error instanceof ExportPdfError && /нет данных/.test(error.message))
  const document = buildExportDocument({ bot: fullBot(), chatId: 500, userId: 7 })
  // Пустой fontPath — тот же случай, что «на сервере нет шрифта»: текст с причиной.
  assert.throws(
    () => buildExportPdf(document, { fontPath: '' }),
    (error) => error instanceof ExportPdfError && /нет шрифта с кириллицей/.test(error.message),
  )
  assert.throws(
    () => buildExportPdf(document, { fontPath: '/нет/такого/шрифта.ttf' }),
    (error) => error instanceof ExportPdfError && /Не удалось собрать PDF/.test(error.message),
  )
})

test('/export с другим аргументом сохраняет прежнюю текстовую выгрузку', async () => {
  const bot = fullBot()
  await createCommandRouter(bot).runCommand({ name: 'export', args: 'docx' }, message)
  assert.equal(bot.sent.length, 0, 'текстовый путь не отвечает сообщением')
  assert.equal(bot.files.length, 1, 'по-прежнему уходит markdown-файл')
  assert.match(bot.files[0].file.fileName, /\.md$/, 'чужой формат не меняет расширение')
  assert.match(bot.files[0].file.bytes.toString('utf8'), /^# Выгрузка из бота/m)
})
