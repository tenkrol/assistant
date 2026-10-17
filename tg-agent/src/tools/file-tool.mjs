/**
 * Инструмент `file`: то, что подготовила модель, становится документом.
 *
 * Бот раньше только *принимал* файлы; этот инструмент закрывает обратное
 * направление. Он собирает байты и передаёт их ядру, а отправляет их адаптер
 * платформы — сам инструмент в сеть не ходит.
 *
 * Форматы пишет `src/office-write.mjs` без зависимостей: на чистом сервере
 * ничего не нужно доустанавливать.
 */
import { createCsv, createDocx, createText, createXlsx, pickFormat } from '../office-write.mjs'
import { createPdf, findFontPath } from '../pdf.mjs'
import { createTool } from './contract.mjs'

/** Форматы, которые может попросить модель. */
const FORMATS = ['xlsx', 'docx', 'csv', 'md', 'txt', 'pdf']

/** Предел файла, который имеет смысл отправлять в мессенджер. */
const MAX_BYTES = 8 * 1024 * 1024

/** Строк на лист: больше — модель должна сама разбить отчёт на части. */
const MAX_ROWS = 5000

/** Убрать символы, которым не место в имени файла. */
function safeName(name, fallback = 'file') {
  const clean = String(name ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
  return clean === '' ? fallback : clean
}

/** Таблица в виде `{ header, rows }` после проверки формы. */
function tableOf(rows) {
  const header = Array.isArray(rows?.header) ? rows.header.map((cell) => String(cell ?? '')) : undefined
  const body = Array.isArray(rows?.rows) ? rows.rows : Array.isArray(rows) ? rows : []
  const table = body.filter(Array.isArray).map((row) => row.map((cell) => (cell == null ? '' : String(cell))))
  return { header, table }
}

/** Текст и таблица инструмента — в блоки PDF: заголовки, абзацы, пункты, строки. */
function pdfBlocks({ title, text, table }) {
  const blocks = []
  if (title) blocks.push({ type: 'h1', text: String(title) })
  for (const chunk of String(text ?? '').split(/\n{2,}/)) {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (trimmed.startsWith('## ')) blocks.push({ type: 'h2', text: trimmed.slice(3) })
      else if (/^[-*•]\s+/.test(trimmed)) blocks.push({ type: 'bullet', text: trimmed.replace(/^[-*•]\s+/, '') })
      else blocks.push({ type: 'p', text: trimmed.replace(/\*\*/g, '') })
    }
  }
  if (table?.rows?.length) {
    if (Array.isArray(table.header) && table.header.length > 0) blocks.push({ type: 'h2', text: table.header.join(' | ') })
    for (const row of table.rows) blocks.push({ type: 'p', text: (Array.isArray(row) ? row : [row]).join(' | ') })
  }
  return blocks
}

/**
 * Собрать инструмент файлов.
 *
 * @param {object} [options] - `{ date }` для воспроизводимых тестов.
 * @returns {{definition: object, executeDetailed: Function, execute: Function}} инструмент.
 */
export function createFileTool({ date } = {}) {
  const definition = {
    type: 'function',
    function: {
      name: 'file',
      description:
        'Собрать файл и отправить его пользователю в чат. Используй, когда просят «пришли таблицей», «сделай документ», '
        + '«выгрузи в Excel», «оформи отчётом» или когда данных много и в сообщении они нечитаемы.',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: FORMATS, description: 'xlsx — таблица Excel, docx — документ Word, csv — таблица, md/txt — текст, pdf — документ PDF.' },
          name: { type: 'string', description: 'Имя файла без расширения, по-русски, коротко: «отчёт за октябрь».' },
          title: { type: 'string', description: 'Заголовок внутри файла (для docx и md).' },
          text: { type: 'string', description: 'Содержимое для docx/md/txt: абзацы через пустую строку, подзаголовки с «## », **жирный**.' },
          table: {
            type: 'object',
            description: 'Таблица для xlsx/csv или вставка в docx: header — заголовки, rows — строки.',
            properties: {
              header: { type: 'array', items: { type: 'string' } },
              rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
            },
          },
          caption: { type: 'string', description: 'Подпись к файлу в чате (одна строка).' },
        },
        required: ['format', 'name'],
      },
    },
  }

  const executeDetailed = async (args = {}) => {
    const format = String(args.format ?? '').trim().toLowerCase()
    if (!FORMATS.includes(format)) {
      return { text: `Ошибка инструмента file: формат должен быть одним из ${FORMATS.join(', ')}.` }
    }
    const base = safeName(args.name)
    const { header, table } = tableOf(args.table)
    const text = typeof args.text === 'string' ? args.text : ''
    if (table.length > MAX_ROWS) {
      return { text: `Ошибка инструмента file: слишком много строк (${table.length}), максимум ${MAX_ROWS}. Разделите отчёт на части.` }
    }
    let bytes
    try {
      if (format === 'xlsx') {
        if (table.length === 0) return { text: 'Ошибка инструмента file: для xlsx нужна таблица (table.header и table.rows).' }
        const sheetName = safeName(args.title ?? base, 'Лист1').slice(0, 31)
        bytes = createXlsx({ sheets: [{ name: sheetName, rows: [...(header ? [header] : []), ...table] }], date })
      } else if (format === 'csv') {
        if (table.length === 0) return { text: 'Ошибка инструмента file: для csv нужна таблица.' }
        bytes = createCsv({ rows: [...(header ? [header] : []), ...table] })
      } else if (format === 'docx') {
        const paragraphs = []
        if (args.title) paragraphs.push(`# ${args.title}`)
        paragraphs.push(...text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean))
        bytes = createDocx({ title: args.title, paragraphs, table: header || table.length > 0 ? { header, rows: table } : undefined, date })
      } else if (format === 'pdf') {
        const fontPath = findFontPath()
        if (!fontPath) return { text: 'Ошибка инструмента file: на сервере нет шрифта с кириллицей для PDF.' }
        const blocks = pdfBlocks({ title: args.title, text, table: header?.length || table.length ? { header, rows: table } : undefined })
        if (blocks.length === 0) return { text: 'Ошибка инструмента file: для pdf нужен text или table.' }
        bytes = createPdf({ title: args.title ?? base, blocks, fontPath })
      } else {
        const body = [args.title ? `# ${args.title}` : '', text].filter(Boolean).join('\n\n')
        if (body.trim() === '') return { text: 'Ошибка инструмента file: для текстового файла нужно поле text.' }
        bytes = createText({ text: `${body}\n`, fileName: `${base}.${format}`, bom: format === 'txt' })
      }
    } catch (error) {
      return { text: `Ошибка инструмента file: не удалось собрать файл (${error?.message ?? error}).` }
    }
    if (!bytes || bytes.length === 0) return { text: 'Ошибка инструмента file: файл получился пустым.' }
    if (bytes.length > MAX_BYTES) {
      return { text: `Ошибка инструмента file: файл ${Math.round(bytes.length / 1024 / 1024)} МБ — больше предела ${MAX_BYTES / 1024 / 1024} МБ. Сократите данные.` }
    }
    const fileName = `${base}.${format}`
    const caption = typeof args.caption === 'string' && args.caption.trim() !== '' ? args.caption.trim().slice(0, 900) : undefined
    return {
      text: `Файл «${fileName}» готов (${Math.max(1, Math.round(bytes.length / 1024))} КБ) и отправлен в чат.`,
      file: { bytes, fileName, caption },
    }
  }

  return createTool({ definition, executeDetailed })
}

export { FORMATS, MAX_BYTES, pickFormat, safeName }
