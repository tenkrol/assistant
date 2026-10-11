/**
 * The `file` tool: turn what the model produced into a document the user can open.
 *
 * The bot could only *accept* files; this closes the other direction. The tool builds
 * the bytes and hands them to the core, which sends them with the platform adapter —
 * the tool never talks to the network itself.
 *
 * Formats are written by `src/office-write.mjs` (no dependencies, so a fresh server
 * needs nothing installed).
 */
import { createCsv, createDocx, createText, createXlsx, pickFormat } from './office-write.mjs'

/** Formats the model may ask for. */
const FORMATS = ['xlsx', 'docx', 'csv', 'md', 'txt']

/** Largest file worth sending through a messenger. */
const MAX_BYTES = 8 * 1024 * 1024

/** Rows per sheet: beyond this the model should split the report itself. */
const MAX_ROWS = 5000

/** Replace characters that must not reach a file name. */
function safeName(name, fallback = 'file') {
  const clean = String(name ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
  return clean === '' ? fallback : clean
}

/** A table as `{ header, rows }`, validated. */
function tableOf(rows) {
  const header = Array.isArray(rows?.header) ? rows.header.map((cell) => String(cell ?? '')) : undefined
  const body = Array.isArray(rows?.rows) ? rows.rows : Array.isArray(rows) ? rows : []
  const table = body.filter(Array.isArray).map((row) => row.map((cell) => (cell == null ? '' : String(cell))))
  return { header, table }
}

/**
 * Build the tool.
 *
 * @param {object} [options] - `{ date }` for deterministic tests.
 * @returns {{definition: object, execute: Function, executeDetailed: Function}} the tool.
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
          format: { type: 'string', enum: FORMATS, description: 'xlsx — таблица Excel, docx — документ Word, csv — таблица, md/txt — текст.' },
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

  return {
    definition,
    executeDetailed,
    execute: async (args, context) => (await executeDetailed(args, context)).text,
  }
}

export { FORMATS, MAX_BYTES, pickFormat, safeName }
