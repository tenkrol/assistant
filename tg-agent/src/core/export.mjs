/**
 * Выгрузка данных пользователя: один источник разделов для текста и PDF.
 *
 * Раньше `/export` собирал markdown прямо в маршрутизаторе. Теперь разделы
 * строятся один раз, а текст и PDF — только раскладки этих разделов. Так
 * содержимое двух форматов не может разойтись: оба видят одни и те же данные.
 */
import { createPdf, findFontPath } from '../pdf.mjs'

/** Предел файла, который имеет смысл отправлять в мессенджер (как у инструмента file). */
export const MAX_PDF_BYTES = 8 * 1024 * 1024

/** Ошибка сборки PDF, у которой уже есть понятный пользователю текст. */
export class ExportPdfError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ExportPdfError'
  }
}

/**
 * Собрать выгрузку об одном человеке в одном чате.
 *
 * Источники данных — те же, что были у команды: профиль, история и хранилище
 * напоминаний. Никаких обращений к сети и новых полей здесь нет.
 *
 * @param {object} options - `bot`, `chatId`, `userId` и, для тестов, `now`.
 * @returns {{title: string, date: string, sections: Array<object>}} документ.
 */
export function buildExportDocument({ bot, chatId, userId, now = new Date() } = {}) {
  // Ключ истории — id чата строкой, тот же ключ, что у диалога.
  const chatKey = String(chatId)
  const profile = bot?.profiles?.store
  const facts = profile?.facts?.(userId) ?? []
  const activeReminders = bot?.reminders?.store.list(chatId, userId) ?? []
  const messages = bot?.history?.messages?.(chatKey) ?? []
  return {
    title: 'Выгрузка из бота',
    date: now.toISOString(),
    sections: [
      {
        title: 'Настройки',
        items: [
          { kind: 'bullet', text: `город: ${profile?.city?.(userId) ?? 'не задан'}` },
          { kind: 'bullet', text: `характер: ${profile?.persona?.(userId) ?? 'обычный'}` },
          { kind: 'bullet', text: `настроение: ${profile?.mood?.(userId) ?? 'меняется само'}` },
          { kind: 'bullet', text: `модель: ${bot?.history?.model?.(chatKey) ?? bot?.config?.model?.name ?? 'по умолчанию'}` },
          { kind: 'bullet', text: `озвучка ответов: ${bot?.history?.voice?.(chatKey) ? 'включена' : 'выключена'}` },
        ],
      },
      {
        title: 'Что бот помнит',
        empty: '— пока ничего',
        items: facts.map((fact) => ({ kind: 'bullet', text: `№${fact.id}: ${fact.text}` })),
      },
      {
        title: 'Напоминания',
        empty: '— нет',
        items: activeReminders.map((reminder) => ({
          kind: 'bullet',
          text: `№${reminder.id} ${reminder.dueAt} (${reminder.repeat ?? 'none'}): ${reminder.text}`,
        })),
      },
      {
        title: 'История диалога (последние сообщения)',
        // Пустая история — это просто пустой раздел, заглушка здесь не нужна.
        items: messages.map((entry) => {
          const who = entry.role === 'user' ? 'Вы' : entry.role === 'assistant' ? 'Бот' : entry.role
          const content = typeof entry.content === 'string' ? entry.content : '(вложение)'
          return { kind: 'paragraph', text: `**${who}:** ${content}` }
        }),
      },
    ],
  }
}

/** Пункты раздела с учётом заглушки для пустого списка. */
function sectionItems(section) {
  if (section.items.length > 0) return section.items
  return section.empty ? [{ kind: 'paragraph', text: section.empty }] : []
}

/**
 * Разложить документ в прежний markdown-текст.
 *
 * Формат намеренно повторяет старую выгрузку строка в строку: им пользуются
 * люди и тесты, и менять его вместе с PDF никто не просил.
 *
 * @param {object} document - результат {@link buildExportDocument}.
 * @returns {string} текст файла, оканчивающийся переводом строки.
 */
export function exportToMarkdown(document) {
  const lines = [`# ${document.title}`, '', `Дата: ${document.date}`]
  for (const section of document.sections) {
    lines.push('', `## ${section.title}`, '')
    for (const item of sectionItems(section)) {
      lines.push(item.kind === 'bullet' ? `- ${item.text}` : item.text)
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * Разложить документ в блоки PDF.
 *
 * В PDF нет жирного шрифта, поэтому markdown-разметка `**…**` снимается —
 * смысл строки от этого не меняется.
 *
 * @param {object} document - результат {@link buildExportDocument}.
 * @returns {Array<object>} блоки `{ type, text }` для `createPdf`.
 */
export function exportToPdfBlocks(document) {
  const blocks = [
    { type: 'h1', text: document.title },
    { type: 'p', text: `Дата: ${document.date}` },
  ]
  for (const section of document.sections) {
    blocks.push({ type: 'h2', text: section.title })
    for (const item of sectionItems(section)) {
      blocks.push({
        type: item.kind === 'bullet' ? 'bullet' : 'p',
        text: String(item.text).replace(/\*\*/g, ''),
      })
    }
  }
  return blocks
}

/**
 * Собрать PDF из готового документа.
 *
 * Любая причина отказа превращается в {@link ExportPdfError} с текстом для
 * пользователя; наружу не должно улетать сырое исключение писателя PDF.
 *
 * @param {object} document - результат {@link buildExportDocument}.
 * @param {{fontPath?: string}} [options] - подмена шрифта для тестов.
 * @returns {Buffer} байты PDF.
 */
export function buildExportPdf(document, { fontPath } = {}) {
  if (!document || !Array.isArray(document.sections) || document.sections.length === 0) {
    throw new ExportPdfError('Не удалось собрать PDF: в выгрузке нет данных.')
  }
  const path = fontPath === undefined ? findFontPath() : fontPath
  if (path === undefined || path === null || path === '') {
    throw new ExportPdfError('PDF недоступен: на сервере нет шрифта с кириллицей. Текстовая выгрузка работает: `/export`.')
  }
  let bytes
  try {
    bytes = createPdf({ title: document.title, blocks: exportToPdfBlocks(document), fontPath: path })
  } catch (error) {
    throw new ExportPdfError(`Не удалось собрать PDF: ${error?.message ?? error}`)
  }
  if (!bytes?.length) {
    throw new ExportPdfError('Не удалось собрать PDF: файл получился пустым.')
  }
  if (bytes.length > MAX_PDF_BYTES) {
    const megabytes = Math.max(1, Math.round(bytes.length / 1024 / 1024))
    throw new ExportPdfError(`Не удалось собрать PDF: файл ${megabytes} МБ больше предела ${MAX_PDF_BYTES / 1024 / 1024} МБ.`)
  }
  return bytes
}
