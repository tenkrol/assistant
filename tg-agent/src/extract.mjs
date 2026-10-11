/**
 * Attachment text extraction with no external dependencies.
 *
 * The bot receives documents in chat and must turn them into text for the chat
 * model. Everything here is built on `node:zlib` and `node:buffer` alone:
 *
 *   - DOCX/XLSX/PPTX are ZIP containers, so a small central-directory reader
 *     pulls out the XML parts and a tag-aware scanner turns them into text;
 *   - PDF is parsed only far enough to find `BT…ET` text runs, optionally
 *     inflating `FlateDecode` streams — a scan stays a scan and is reported as
 *     such instead of pretending to have read it;
 *   - CSV/TSV, JSON and plain text are decoded with BOM awareness and a
 *     windows-1251 fallback for Cyrillic payloads.
 *
 * `extractText` never throws: any failure comes back as
 * `{ kind, text: '', error }`, which is what the bot shows the user.
 */

import { inflateRawSync, inflateSync } from 'node:zlib'

/** Default cap on returned text, in UTF-16 code units. */
export const MAX_TEXT_CHARS = 20_000

/** Appended to text that the cap cut short. */
export const TRUNCATION_MARKER = '\n\n[…обрезано]'

/** Rows of a spreadsheet/CSV returned before the table is cut short. */
const DEFAULT_MAX_ROWS = 500

/** Bytes inspected when deciding whether a payload is binary. */
const BINARY_SAMPLE_BYTES = 8192

/**
 * Error carrying a user-facing Russian explanation; never escapes `extractText`.
 *
 * `meta` lets a failure keep the facts that were already established, such as
 * the page count of a PDF that turned out to be a scan.
 */
class ExtractError extends Error {
  constructor(message, meta) {
    super(message)
    this.name = 'ExtractError'
    if (meta) this.meta = meta
  }
}

const EXTENSION_KINDS = new Map([
  ['pdf', 'pdf'],
  ['docx', 'docx'], ['docm', 'docx'], ['dotx', 'docx'], ['dotm', 'docx'],
  ['xlsx', 'xlsx'], ['xlsm', 'xlsx'], ['xltx', 'xlsx'], ['xltm', 'xlsx'],
  ['pptx', 'pptx'], ['pptm', 'pptx'], ['potx', 'pptx'], ['potm', 'pptx'],
  ['csv', 'csv'], ['tsv', 'csv'],
  ['json', 'json'],
  ['txt', 'text'], ['text', 'text'], ['md', 'text'], ['markdown', 'text'], ['log', 'text'], ['rst', 'text'],
  ['png', 'image'], ['jpg', 'image'], ['jpeg', 'image'], ['gif', 'image'], ['webp', 'image'],
  ['bmp', 'image'], ['tif', 'image'], ['tiff', 'image'], ['heic', 'image'], ['avif', 'image'],
])

const MIME_KINDS = new Map([
  ['application/pdf', 'pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ['application/vnd.ms-word.document.macroenabled.12', 'docx'],
  ['application/vnd.ms-excel.sheet.macroenabled.12', 'xlsx'],
  ['application/vnd.ms-powerpoint.presentation.macroenabled.12', 'pptx'],
  ['text/csv', 'csv'],
  ['application/csv', 'csv'],
  ['text/tab-separated-values', 'csv'],
  ['application/json', 'json'],
  ['text/json', 'json'],
])

const OFFICE_KINDS = new Set(['docx', 'xlsx', 'pptx'])

/**
 * Guess the attachment kind from its name, MIME type and leading bytes.
 *
 * Magic bytes win over the declared type: a chat client can rename a PDF, but
 * it cannot change `%PDF`. A ZIP container is classified by the OOXML folder
 * names it holds (`word/`, `xl/`, `ppt/`), because a bare `PK\x03\x04` says
 * nothing about which Office format it is.
 *
 * @param {object} [input] - `{ fileName, mimeType, bytes }`; every field is optional.
 * @returns {'pdf'|'docx'|'xlsx'|'pptx'|'csv'|'json'|'text'|'image'|'unknown'}
 */
export function detectKind(input = {}) {
  const { fileName, mimeType, bytes } = input ?? {}
  const buffer = toBuffer(bytes)
  const extension = extensionOf(fileName)
  const mime = normalizeMime(mimeType)
  const hinted = EXTENSION_KINDS.get(extension) ?? MIME_KINDS.get(mime)

  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
    return zipKind(buffer, hinted)
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf'
  if (imageKindFromBytes(buffer) !== null) return 'image'
  if (hinted) return hinted
  if (mime.startsWith('text/')) return 'text'
  if (mime.startsWith('image/')) return 'image'

  // Nothing declared and nothing magic: a text payload still deserves a kind.
  if (buffer.length > 0 && !hasBinaryBytes(buffer)) {
    const { text } = decodeSourceText(buffer)
    const head = text.trimStart()
    if (head.startsWith('{') || head.startsWith('[')) {
      try {
        JSON.parse(text)
        return 'json'
      } catch {
        // Not JSON after all; it is plain text.
      }
    }
    return 'text'
  }
  return 'unknown'
}

/**
 * Extract readable text from an attachment.
 *
 * Never throws. On failure the result is `{ kind, text: '', error }` with a
 * Russian message ready to be shown to the user, plus the same `meta` shape as
 * a success so the caller can still report the file size.
 *
 * @param {object} [input] - `{ fileName, mimeType, bytes, limits }`.
 * @param {Buffer|Uint8Array|ArrayBuffer|string} [input.bytes] - file contents.
 * @param {object} [input.limits] - `maxChars` overrides {@link MAX_TEXT_CHARS}, `maxRows` caps a table.
 * @returns {{kind: string, text: string, truncated: boolean, meta: object, error?: string}}
 */
export function extractText(input = {}) {
  const { fileName, mimeType, bytes, limits } = input ?? {}
  const buffer = toBuffer(bytes)
  const kind = detectKind({ fileName, mimeType, bytes: buffer })
  const maxChars = positiveInt(limits?.maxChars ?? limits?.maxTextChars, MAX_TEXT_CHARS)
  const maxRows = positiveInt(limits?.maxRows, DEFAULT_MAX_ROWS)
  const meta = { bytes: buffer.length }
  if (fileName !== undefined && fileName !== null && `${fileName}` !== '') meta.fileName = String(fileName)
  if (mimeType !== undefined && mimeType !== null && `${mimeType}` !== '') meta.mimeType = String(mimeType)

  try {
    if (buffer.length === 0) throw new ExtractError('пустой файл: извлекать нечего')
    const extracted = extractByKind(kind, buffer, { maxRows })
    return finish(kind, extracted.text, { ...meta, ...extracted.meta }, maxChars)
  } catch (error) {
    const failed = error instanceof ExtractError ? error : null
    const message = failed ? failed.message : `не удалось разобрать файл: ${error?.message ?? error}`
    return { kind, text: '', truncated: false, meta: { ...meta, ...(failed?.meta ?? {}) }, error: message }
  }
}

/** Route one buffer to its extractor. */
function extractByKind(kind, buffer, { maxRows }) {
  switch (kind) {
    case 'pdf': return extractPdf(buffer)
    case 'docx': return extractDocx(buffer)
    case 'xlsx': return extractXlsx(buffer)
    case 'pptx': return extractPptx(buffer)
    case 'csv': return extractDelimited(buffer, maxRows)
    case 'json': return extractJson(buffer)
    case 'text': return extractPlainText(buffer)
    case 'image': return extractImage(buffer)
    default:
      if (isOle2(buffer)) {
        throw new ExtractError('старый формат Office (.doc/.xls/.ppt) не поддерживается — пересохраните файл как .docx/.xlsx/.pptx')
      }
      throw new ExtractError('не удалось определить формат файла: поддерживаются PDF, DOCX, XLSX, PPTX, CSV/TSV, JSON, TXT/MD и изображения')
  }
}

// ---------------------------------------------------------------------------
// ZIP container (DOCX / XLSX / PPTX)
// ---------------------------------------------------------------------------

/**
 * Read the archive's central directory.
 *
 * The central directory is authoritative: local headers may carry zero sizes
 * when the writer used a data descriptor, so sizes and offsets are taken from
 * here. ZIP64 records and extra fields are honoured for large spreadsheets.
 *
 * @param {Buffer} buffer - whole archive.
 * @returns {Map<string, object>} entry name -> descriptor.
 */
function readZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd === -1) throw new ExtractError('это не ZIP-архив: не найдена запись end of central directory')
  let entryCount = buffer.readUInt16LE(eocd + 10)
  let centralOffset = buffer.readUInt32LE(eocd + 16)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  if (entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    const zip64 = readZip64EndOfCentralDirectory(buffer, eocd)
    if (zip64) {
      entryCount = zip64.entryCount
      centralOffset = zip64.centralOffset
    }
  }

  const entries = new Map()
  let offset = centralOffset
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    let compressedSize = buffer.readUInt32LE(offset + 20)
    let uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    let localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    const extra = buffer.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength)

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      const zip64 = readZip64Extra(extra, { compressedSize, uncompressedSize, localOffset })
      compressedSize = zip64.compressedSize
      uncompressedSize = zip64.uncompressedSize
      localOffset = zip64.localOffset
    }

    entries.set(name, {
      name,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
      encrypted: (flags & 0x1) === 1,
      directory: name.endsWith('/'),
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Scan backwards for the EOCD signature, skipping any archive comment. */
function findEndOfCentralDirectory(buffer) {
  const lowest = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= lowest; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  return -1
}

/** Follow the ZIP64 locator that precedes a 16-bit-overflowed EOCD. */
function readZip64EndOfCentralDirectory(buffer, eocdOffset) {
  const locator = eocdOffset - 20
  if (locator < 0 || buffer.readUInt32LE(locator) !== 0x07064b50) return null
  const record = Number(buffer.readBigUInt64LE(locator + 8))
  if (record + 56 > buffer.length || buffer.readUInt32LE(record) !== 0x06064b50) return null
  return {
    entryCount: Number(buffer.readBigUInt64LE(record + 32)),
    centralOffset: Number(buffer.readBigUInt64LE(record + 48)),
  }
}

/** Pull the 64-bit sizes/offset out of a central-directory extra field. */
function readZip64Extra(extra, current) {
  const result = { ...current }
  let offset = 0
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset)
    const size = extra.readUInt16LE(offset + 2)
    const body = extra.subarray(offset + 4, offset + 4 + size)
    if (id === 0x0001) {
      let cursor = 0
      if (result.uncompressedSize === 0xffffffff && cursor + 8 <= body.length) {
        result.uncompressedSize = Number(body.readBigUInt64LE(cursor))
        cursor += 8
      }
      if (result.compressedSize === 0xffffffff && cursor + 8 <= body.length) {
        result.compressedSize = Number(body.readBigUInt64LE(cursor))
        cursor += 8
      }
      if (result.localOffset === 0xffffffff && cursor + 8 <= body.length) {
        result.localOffset = Number(body.readBigUInt64LE(cursor))
      }
      return result
    }
    offset += 4 + size
  }
  return result
}

/** Inflate one entry; stored entries are returned as-is. */
function readEntry(entries, buffer, name) {
  const entry = entries.get(name)
  if (!entry || entry.directory) return null
  if (entry.encrypted) throw new ExtractError(`запись ${name} зашифрована, прочитать её без пароля нельзя`)
  if (entry.localOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) {
    throw new ExtractError(`повреждён локальный заголовок записи ${name}`)
  }
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26)
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28)
  const start = entry.localOffset + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (end > buffer.length) throw new ExtractError(`запись ${name} выходит за границы архива`)
  const raw = buffer.subarray(start, end)

  if (entry.method === 0) return raw
  if (entry.method === 8) return inflateRawSync(raw)
  throw new ExtractError(`запись ${name} сжата методом ${entry.method}, который не поддерживается`)
}

/** UTF-8 text of one entry, or `null` when the entry is absent. */
function readEntryText(entries, buffer, name) {
  const raw = readEntry(entries, buffer, name)
  return raw === null ? null : raw.toString('utf8')
}

/** Classify an OOXML container by the top-level folders inside it. */
function zipKind(buffer, hinted) {
  let names = []
  try {
    names = [...readZipEntries(buffer).keys()]
  } catch {
    names = []
  }
  if (names.some((name) => name.startsWith('word/'))) return 'docx'
  if (names.some((name) => name.startsWith('xl/'))) return 'xlsx'
  if (names.some((name) => name.startsWith('ppt/'))) return 'pptx'
  return hinted && OFFICE_KINDS.has(hinted) ? hinted : 'unknown'
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

/** Collect body text plus footnotes/endnotes from a Word package. */
function extractDocx(buffer) {
  const entries = readZipEntries(buffer)
  const documentXml = readEntryText(entries, buffer, 'word/document.xml')
  if (documentXml === null) throw new ExtractError('в архиве нет word/document.xml — это не DOCX')

  let text = docxPartToText(documentXml)
  const parts = ['word/footnotes.xml', 'word/endnotes.xml']
  let hasNotes = false
  for (const part of parts) {
    const xml = readEntryText(entries, buffer, part)
    if (xml === null) continue
    const notes = docxPartToText(xml)
    if (notes !== '') {
      const title = part.includes('footnotes') ? 'сноски' : 'концевые сноски'
      text += `\n\n--- ${title} ---\n${notes}`
      hasNotes = true
    }
  }

  return {
    text,
    meta: {
      paragraphs: (documentXml.match(/<\/w:p>/g) ?? []).length,
      tables: (documentXml.match(/<w:tbl\b/g) ?? []).length,
      footnotes: hasNotes,
      parts: entries.size,
    },
  }
}

/**
 * Turn a WordprocessingML part into text.
 *
 * Only `w:t` carries visible text, so anything else between tags is ignored
 * (that also drops field instructions). Paragraphs become newlines, table rows
 * become tab-separated lines, and a paragraph inside a cell is flattened to a
 * space so the row stays on one line.
 */
function docxPartToText(xml) {
  const pieces = []
  let cell = null
  let run = null
  const emit = (value) => { (cell ?? pieces).push(value) }

  for (const match of xml.matchAll(/<[^>]*>|[^<]+/g)) {
    const token = match[0]
    if (!token.startsWith('<')) {
      if (run) run.push(decodeXmlEntities(token))
      continue
    }
    const name = elementName(token)
    const selfClosing = token.endsWith('/>')
    if (name === 'w:t' && !selfClosing) { run = []; continue }
    if (name === '/w:t') {
      if (run) { emit(run.join('')); run = null }
      continue
    }
    if (selfClosing) {
      if (name === 'w:tab') emit('\t')
      else if (name === 'w:br' || name === 'w:cr') emit('\n')
      continue
    }
    if (name === 'w:tc') { cell = []; continue }
    if (name === '/w:tc') {
      // Written straight to `pieces`: `emit` would push it back into the very
      // cell that is about to be discarded.
      if (cell) pieces.push(`${cell.join('').trim()}\t`)
      cell = null
      continue
    }
    if (name === '/w:tr') { emit('\n'); continue }
    if (name === '/w:p') {
      if (cell) cell.push(' ')
      else emit('\n')
    }
  }
  return cleanupText(pieces.join(''))
}

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

/** Collect text of every slide, in numeric slide order. */
function extractPptx(buffer) {
  const entries = readZipEntries(buffer)
  const slides = [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => fileNumber(a) - fileNumber(b))
  if (slides.length === 0) throw new ExtractError('в архиве нет ppt/slides/slide*.xml — это не PPTX')

  const blocks = slides.map((name, index) => {
    const number = fileNumber(name) || index + 1
    return `--- слайд ${number} ---\n${pptxSlideToText(readEntryText(entries, buffer, name) ?? '')}`
  })
  return { text: blocks.join('\n\n'), meta: { slides: slides.length } }
}

/** DrawingML paragraphs become lines; only `a:t` holds visible text. */
function pptxSlideToText(xml) {
  const pieces = []
  let run = null
  for (const match of xml.matchAll(/<[^>]*>|[^<]+/g)) {
    const token = match[0]
    if (!token.startsWith('<')) {
      if (run) run.push(decodeXmlEntities(token))
      continue
    }
    const name = elementName(token)
    const selfClosing = token.endsWith('/>')
    if (name === 'a:t' && !selfClosing) { run = []; continue }
    if (name === '/a:t') {
      if (run) { pieces.push(run.join('')); run = null }
      continue
    }
    if (name === '/a:p' || name === '/a:br' || (selfClosing && name === 'a:br')) pieces.push('\n')
  }
  return cleanupText(pieces.join(''))
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

/** Render each worksheet as a tab-separated table under a sheet heading. */
function extractXlsx(buffer) {
  const entries = readZipEntries(buffer)
  const workbookXml = readEntryText(entries, buffer, 'xl/workbook.xml')
  if (workbookXml === null) throw new ExtractError('в архиве нет xl/workbook.xml — это не XLSX')

  const worksheetNames = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => fileNumber(a) - fileNumber(b))
  if (worksheetNames.length === 0) throw new ExtractError('в архиве нет листов xl/worksheets/sheet*.xml')

  const sharedStrings = parseSharedStrings(readEntryText(entries, buffer, 'xl/sharedStrings.xml') ?? '')
  const relsXml = readEntryText(entries, buffer, 'xl/_rels/workbook.xml.rels') ?? ''
  const sheets = resolveSheets(workbookXml, relsXml, worksheetNames)

  const blocks = []
  let totalRows = 0
  for (const sheet of sheets) {
    const xml = readEntryText(entries, buffer, sheet.path)
    if (xml === null) continue
    const rows = parseSheetRows(xml, sharedStrings)
    totalRows += rows.length
    blocks.push(`--- Лист: ${sheet.name} ---\n${rows.map(renderRow).join('\n')}`)
  }
  if (blocks.length === 0) throw new ExtractError('не удалось прочитать ни одного листа XLSX')

  return {
    text: blocks.join('\n\n'),
    meta: { sheets: sheets.map((sheet) => sheet.name), sheetCount: sheets.length, rows: totalRows },
  }
}

/** Map sheet names to worksheet paths using the workbook relationships. */
function resolveSheets(workbookXml, relsXml, worksheetNames) {
  const relationships = new Map(
    [...relsXml.matchAll(/<Relationship\b[^>]*\/?>/g)].map((match) => [attribute(match[0], 'Id'), attribute(match[0], 'Target')]),
  )
  const sheets = []
  for (const [index, tag] of [...workbookXml.matchAll(/<sheet\b[^>]*\/?>/g)].entries()) {
    const name = attribute(tag[0], 'name') ?? `Лист${index + 1}`
    const target = relationships.get(attribute(tag[0], 'r:id'))
    let path = normalizeZipPath(target)
    if (!path || !worksheetNames.includes(path)) path = worksheetNames[index] ?? null
    if (path) sheets.push({ name, path })
  }
  for (const path of worksheetNames) {
    if (!sheets.some((sheet) => sheet.path === path)) sheets.push({ name: `Лист${sheets.length + 1}`, path })
  }
  return sheets
}

/** Shared strings: each `<si>` may be split across several `<t>` runs. */
function parseSharedStrings(xml) {
  if (xml === '') return []
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)]
    .map((match) => collectTagText(match[1] ?? '', 't'))
}

/** One row per `<row>`, cells placed by their `r` reference so gaps stay empty. */
function parseSheetRows(xml, sharedStrings) {
  const rows = []
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
    const cells = []
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1]
      const body = cellMatch[2] ?? ''
      const value = cellValue(attribute(attrs, 't') ?? 'n', body, sharedStrings)
      const reference = attribute(attrs, 'r')
      const index = reference ? columnIndex(reference) : cells.length
      if (index < 0) { cells.push(value); continue }
      while (cells.length < index) cells.push('')
      cells[index] = value
    }
    rows.push(cells)
  }
  return rows
}

/** A cell value: shared string index, inline string, boolean, or literal `<v>`. */
function cellValue(type, body, sharedStrings) {
  if (type === 's') {
    const index = Number(firstMatch(body, /<v>([\s\S]*?)<\/v>/))
    return sharedStrings[index] ?? ''
  }
  if (type === 'inlineStr') return collectTagText(body, 't')
  if (type === 'b') return firstMatch(body, /<v>([\s\S]*?)<\/v>/) === '1' ? 'TRUE' : 'FALSE'
  return decodeXmlEntities(firstMatch(body, /<v>([\s\S]*?)<\/v>/) ?? '')
}

const renderRow = (cells) => cells.map((cell) => String(cell).replace(/[\t\r\n]+/g, ' ')).join('\t')

/** Turn column letters (`A`, `AB`) into a zero-based index. */
function columnIndex(reference) {
  const letters = /^[A-Za-z]+/.exec(reference)?.[0]
  if (!letters) return -1
  let value = 0
  for (const letter of letters.toUpperCase()) value = value * 26 + (letter.charCodeAt(0) - 64)
  return value - 1
}

// ---------------------------------------------------------------------------
// CSV / TSV
// ---------------------------------------------------------------------------

/** Parse a delimited text into a tab-separated table, capped at `maxRows`. */
function extractDelimited(buffer, maxRows) {
  const { text, encoding } = readTextual(buffer)
  const { rows, delimiter } = parseDelimited(text)
  const shown = rows.slice(0, maxRows)
  const lines = shown.map(renderRow)
  if (rows.length > shown.length) lines.unshift(`Всего строк: ${rows.length}, показаны первые ${shown.length}`)
  return {
    text: lines.join('\n'),
    meta: {
      encoding,
      delimiter: delimiter === '\t' ? '\\t' : delimiter,
      rows: rows.length,
      shownRows: shown.length,
      columns: rows.reduce((max, row) => Math.max(max, row.length), 0),
    },
  }
}

/** RFC 4180-ish parser: quoted fields, doubled quotes, embedded newlines. */
function parseDelimited(text) {
  const delimiter = detectDelimiter(text)
  const rows = []
  let row = []
  let field = ''
  let quoted = false

  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++ }
        else quoted = false
      } else {
        field += char
      }
      continue
    }
    if (char === '"' && field === '') { quoted = true; continue }
    if (char === delimiter) { row.push(field); field = ''; continue }
    if (char === '\r') continue
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += char
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return { rows, delimiter }
}

/** Pick the delimiter that appears most often outside quotes in the first lines. */
function detectDelimiter(text) {
  const sample = text.slice(0, 64 * 1024)
  const counts = new Map([[',', 0], [';', 0], ['\t', 0]])
  let quoted = false
  for (let index = 0; index < sample.length; index++) {
    const char = sample[index]
    if (char === '"') { quoted = !quoted; continue }
    if (quoted) continue
    if (counts.has(char)) counts.set(char, counts.get(char) + 1)
  }
  let best = ','
  for (const [delimiter, count] of counts) {
    if (count > counts.get(best)) best = delimiter
  }
  return best
}

// ---------------------------------------------------------------------------
// JSON / plain text
// ---------------------------------------------------------------------------

/** Pretty-print JSON; invalid input is reported as an error, not raw text. */
function extractJson(buffer) {
  const { text, encoding } = readTextual(buffer)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ExtractError(`JSON не разобрался: ${error?.message ?? error}`)
  }
  const meta = { encoding, type: Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed }
  if (Array.isArray(parsed)) meta.items = parsed.length
  else if (parsed !== null && typeof parsed === 'object') meta.keys = Object.keys(parsed).length
  return { text: JSON.stringify(parsed, null, 2), meta }
}

/** Plain text, returned verbatim after a binary/encoding check. */
function extractPlainText(buffer) {
  const { text, encoding, lossy } = readTextual(buffer)
  return { text, meta: { encoding, ...(lossy ? { lossy: true } : {}), lines: text === '' ? 0 : text.split('\n').length } }
}

/** Decode bytes as text, refusing payloads that are clearly binary. */
function readTextual(buffer) {
  // UTF-16 encodes every ASCII character with a zero byte, so the NUL test is
  // meaningful only when no UTF-16 BOM says the payload is text.
  if (!hasUtf16Bom(buffer)) {
    const sample = buffer.subarray(0, BINARY_SAMPLE_BYTES)
    if (sample.includes(0)) throw new ExtractError('похоже на бинарный файл: в содержимом есть нулевые байты')
  }
  const decoded = decodeSourceText(buffer)
  const control = countControlChars(decoded.text)
  if (decoded.text.length > 0 && control / decoded.text.length > 0.1) {
    throw new ExtractError(`похоже на бинарный файл: ${control} управляющих символов на ${decoded.text.length} знаков`)
  }
  if (decoded.lossy) {
    const replacements = countOccurrences(decoded.text, '\uFFFD')
    if (decoded.text.length === 0 || replacements / decoded.text.length > 0.05) {
      throw new ExtractError('не удалось определить кодировку: файл не является текстом в UTF-8 или windows-1251')
    }
  }
  return decoded
}

/**
 * Decode bytes with BOM awareness.
 *
 * UTF-8 is tried strictly first. When it fails and the high bytes look like
 * single-byte Cyrillic, windows-1251 is used — a frequent case for CSV exports
 * from Russian accounting software. Anything else falls back to a lossy UTF-8
 * decode flagged as `lossy`, which the caller turns into an error when the
 * damage is severe.
 */
function decodeSourceText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: decodeWith('utf-16le', buffer.subarray(2)), encoding: 'utf-16le' }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: decodeWith('utf-16be', buffer.subarray(2)), encoding: 'utf-16be' }
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: decodeWith('utf-8', buffer.subarray(3)), encoding: 'utf-8' }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' }
  } catch {
    // Not valid UTF-8: try the most likely single-byte Cyrillic codepage.
  }
  if (looksLikeCyrillicSingleByte(buffer)) {
    try {
      return { text: decodeWith('windows-1251', buffer), encoding: 'windows-1251' }
    } catch {
      // ICU without windows-1251; fall through to a lossy UTF-8 decode.
    }
  }
  return { text: decodeWith('utf-8', buffer), encoding: 'utf-8', lossy: true }
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/** Extract text from `BT…ET` runs; a PDF without any text layer is an error. */
function extractPdf(buffer) {
  const pages = countPdfPages(buffer)
  const blocks = []
  for (const stream of pdfStreams(buffer)) {
    const content = stream.flate ? inflateFirst(stream.candidates) : stream.candidates[0]
    if (!content) continue
    const text = pdfContentToText(content)
    if (text !== '') blocks.push(text)
  }

  const text = cleanupText(blocks.join('\n\n'))
  // Embedded subset fonts carry custom encodings, so a PDF can have a text
  // layer that decodes to control characters. That is as useless as a scan and
  // deserves the same honest answer rather than mojibake for the model.
  if (text === '' || !hasReadablePdfText(text)) {
    throw new ExtractError(
      'PDF без текстового слоя (скан) — нужен OCR; распознавание изображений здесь не поддерживается',
      { pages },
    )
  }
  return { text, meta: { pages, streams: blocks.length } }
}

const MEANINGFUL_PDF_CHARACTER = /[\p{L}\p{N}\p{P}\p{Zs}]/u

/** Letters, digits and punctuation must dominate; otherwise it is font gibberish. */
function hasReadablePdfText(text) {
  const sample = text.replace(/\s+/g, '')
  if (sample === '') return false
  let meaningful = 0
  for (const char of sample) {
    if (MEANINGFUL_PDF_CHARACTER.test(char)) meaningful++
  }
  return meaningful / sample.length >= 0.5
}

/** Page count from `/Type /Page`, with the page tree `/Count` as a fallback. */
function countPdfPages(buffer) {
  const latin = buffer.toString('latin1')
  const pages = (latin.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length
  if (pages > 0) return pages
  let declared = 0
  for (const match of latin.matchAll(/\/Count\s+(\d+)/g)) declared = Math.max(declared, Number(match[1]))
  return declared
}

/** Every `stream … endstream` payload, flagged when its dictionary says Flate. */
function pdfStreams(buffer) {
  const latin = buffer.toString('latin1')
  const streams = []
  let index = 0
  while (index < latin.length) {
    const at = latin.indexOf('stream', index)
    if (at === -1) break
    if (at >= 3 && latin.startsWith('endstream', at - 3)) { index = at + 6; continue }
    if (at > 0 && /[A-Za-z0-9]/.test(latin[at - 1])) { index = at + 6; continue }

    let start = at + 6
    if (latin[start] === '\r') start++
    if (latin[start] === '\n') start++
    const end = latin.indexOf('endstream', start)
    if (end === -1) break
    let stop = end
    if (latin[stop - 1] === '\n') stop--
    if (latin[stop - 1] === '\r') stop--

    // The EOL before `endstream` is not data, but a compressed stream's last
    // byte can itself be `\n` or `\r`; offer several slices and let the
    // inflater pick the one that decodes.
    const candidates = [buffer.subarray(start, stop)]
    if (stop + 1 <= end) candidates.push(buffer.subarray(start, stop + 1))
    if (stop + 1 < end) candidates.push(buffer.subarray(start, end))

    // The dictionary sits immediately before the keyword; a balanced
    // `<< … >>` ending right here belongs to this stream, an earlier one does not.
    const window = latin.slice(Math.max(0, at - 4096), at)
    const dictStart = window.lastIndexOf('<<')
    let dictionary = ''
    if (dictStart !== -1) {
      const candidate = window.slice(dictStart)
      if (candidate.trimEnd().endsWith('>>')) dictionary = candidate
    }
    streams.push({ candidates, flate: /\/FlateDecode\b/.test(dictionary) })
    index = end + 9
  }
  return streams
}

/** Inflate the first candidate slice that decodes, trying zlib then raw deflate. */
function inflateFirst(candidates) {
  for (const candidate of candidates) {
    if (candidate.length === 0) continue
    try {
      return inflateSync(candidate)
    } catch {
      // Not a zlib-wrapped stream; try raw deflate below.
    }
    try {
      return inflateRawSync(candidate)
    } catch {
      // Try the next candidate slice.
    }
  }
  return null
}

/**
 * A minimal PDF content-stream interpreter tuned for text.
 *
 * It tracks operands until an operator arrives, then keeps the strings shown by
 * `Tj`, `'`, `"` and `TJ`; positioning operators start a new line. Kern values
 * below −100 in a `TJ` array are treated as a word gap.
 */
function pdfContentToText(content) {
  const source = Buffer.isBuffer(content) ? content.toString('latin1') : String(content)
  const lines = []
  const operands = []
  let line = ''
  const flush = () => { if (line !== '') { lines.push(line); line = '' } }
  const last = (predicate) => [...operands].reverse().find(predicate)

  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === '(') {
      const literal = readPdfLiteral(source, index)
      operands.push({ str: literal.bytes })
      index = literal.next
      continue
    }
    if (char === '<' && source[index + 1] !== '<') {
      const hex = readPdfHex(source, index)
      operands.push({ str: hex.bytes })
      index = hex.next
      continue
    }
    if (char === '[') {
      const array = readPdfArray(source, index)
      operands.push({ array: array.items })
      index = array.next
      continue
    }
    if (' \t\r\n\f\0'.includes(char)) { index++; continue }
    if (char === '%') {
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index++
      continue
    }
    if (char === '/') {
      let end = index + 1
      while (end < source.length && !' \t\r\n\f\0/[]<>()'.includes(source[end])) end++
      operands.push({ name: source.slice(index, end) })
      index = end
      continue
    }
    if (/[0-9+\-.]/.test(char)) {
      let end = index
      while (end < source.length && /[0-9+\-.eE]/.test(source[end])) end++
      operands.push({ num: Number(source.slice(index, end)) })
      index = end
      continue
    }
    if (char === '<' || char === '>') { index += source[index + 1] === char ? 2 : 1; continue }
    if (char === ']' || char === ')') { index++; continue }

    let end = index
    while (end < source.length && !' \t\r\n\f\0/[]<>()'.includes(source[end])) end++
    const operator = source.slice(index, end)
    index = end === index ? index + 1 : end

    if (operator === 'Tj' || operator === "'" || operator === '"') {
      if (operator !== 'Tj') flush()
      const operand = last((entry) => entry.str)
      if (operand) line += decodePdfBytes(operand.str)
      if (operator !== 'Tj') flush()
    } else if (operator === 'TJ') {
      const array = last((entry) => entry.array)
      for (const item of array?.array ?? []) {
        if (item.str) line += decodePdfBytes(item.str)
        else if (typeof item.num === 'number' && item.num <= -100) line += ' '
      }
    } else if (['Td', 'TD', 'T*', 'Tm', 'ET', 'BT'].includes(operator)) {
      flush()
    }
    operands.length = 0
  }
  flush()
  return cleanupText(lines.join('\n'))
}

/** Read a `( … )` literal string, honouring escapes and nested parentheses. */
function readPdfLiteral(source, start) {
  const bytes = []
  let depth = 1
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      const next = source[index + 1]
      if (next === undefined) { index++; continue }
      if (next === 'n') { bytes.push(0x0a); index += 2; continue }
      if (next === 'r') { bytes.push(0x0d); index += 2; continue }
      if (next === 't') { bytes.push(0x09); index += 2; continue }
      if (next === 'b') { bytes.push(0x08); index += 2; continue }
      if (next === 'f') { bytes.push(0x0c); index += 2; continue }
      if (next === '\n') { index += 2; continue }
      if (next === '\r') { index += source[index + 2] === '\n' ? 3 : 2; continue }
      if (next >= '0' && next <= '7') {
        let end = index + 1
        let value = 0
        let digits = 0
        while (digits < 3 && end < source.length && source[end] >= '0' && source[end] <= '7') {
          value = value * 8 + (source.charCodeAt(end) - 48)
          end++
          digits++
        }
        bytes.push(value & 0xff)
        index = end
        continue
      }
      bytes.push(next.charCodeAt(0) & 0xff)
      index += 2
      continue
    }
    if (char === '(') { depth++; bytes.push(0x28); index++; continue }
    if (char === ')') {
      depth--
      index++
      if (depth === 0) break
      bytes.push(0x29)
      continue
    }
    if (char === '\r') { bytes.push(0x0a); index += source[index + 1] === '\n' ? 2 : 1; continue }
    if (char === '\n') { bytes.push(0x0a); index++; continue }
    bytes.push(char.charCodeAt(0) & 0xff)
    index++
  }
  return { bytes: Buffer.from(bytes), next: index }
}

/** Read a `< … >` hex string; a trailing odd digit is padded with zero. */
function readPdfHex(source, start) {
  const digits = []
  let index = start + 1
  while (index < source.length && source[index] !== '>') {
    if (/[0-9a-fA-F]/.test(source[index])) digits.push(source[index])
    index++
  }
  if (source[index] === '>') index++
  if (digits.length % 2 === 1) digits.push('0')
  return { bytes: Buffer.from(digits.join(''), 'hex'), next: index }
}

/** Read a `[ … ]` array of strings and numbers, as used by `TJ`. */
function readPdfArray(source, start) {
  const items = []
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (char === ']') { index++; break }
    if (char === '(') {
      const literal = readPdfLiteral(source, index)
      items.push({ str: literal.bytes })
      index = literal.next
      continue
    }
    if (char === '<' && source[index + 1] !== '<') {
      const hex = readPdfHex(source, index)
      items.push({ str: hex.bytes })
      index = hex.next
      continue
    }
    if (/[0-9+\-.]/.test(char)) {
      let end = index
      while (end < source.length && /[0-9+\-.eE]/.test(source[end])) end++
      items.push({ num: Number(source.slice(index, end)) })
      index = end
      continue
    }
    index++
  }
  return { items, next: index }
}

/** Decode a PDF string's bytes: UTF-16BE BOM, UTF-8, Cyrillic, then Latin-1. */
function decodePdfBytes(bytes) {
  if (bytes.length === 0) return ''
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return decodeWith('utf-16be', bytes.subarray(2))
  const utf8 = decodeWith('utf-8', bytes)
  if (!utf8.includes('\uFFFD')) return utf8
  if (looksLikeCyrillicSingleByte(bytes)) {
    try {
      return decodeWith('windows-1251', bytes)
    } catch {
      // Fall through to Latin-1.
    }
  }
  return bytes.toString('latin1')
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/**
 * Images carry no text: the model receives the picture itself. Only simple
 * header facts are reported so the bot can describe the attachment.
 */
function extractImage(buffer) {
  const meta = { ...(imageKindFromBytes(buffer) ? { format: imageKindFromBytes(buffer) } : {}), ...(imageSize(buffer) ?? {}) }
  return { text: '', meta }
}

/** Format of a bitmap by its magic bytes, or `null`. */
function imageKindFromBytes(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg'
  if (buffer.length >= 6 && buffer.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif'
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  if (buffer.length >= 26 && buffer[0] === 0x42 && buffer[1] === 0x4d && buffer.readUInt16LE(6) === 0 && buffer.readUInt32LE(10) >= 26) return 'bmp'
  if (buffer.length >= 4 && (buffer.subarray(0, 4).toString('latin1') === 'II*\0' || buffer.subarray(0, 4).toString('latin1') === 'MM\0*')) return 'tiff'
  return null
}

/** Pixel dimensions for the common bitmap headers, when they are cheap to read. */
function imageSize(buffer) {
  const format = imageKindFromBytes(buffer)
  if (format === 'png' && buffer.length >= 24 && buffer.subarray(12, 16).toString('latin1') === 'IHDR') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (format === 'gif' && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  }
  if (format === 'bmp' && buffer.length >= 26) {
    return { width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)) }
  }
  if (format === 'webp' && buffer.length >= 30) {
    const chunk = buffer.subarray(12, 16).toString('latin1')
    if (chunk === 'VP8X') return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 }
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
    }
  }
  if (format === 'jpeg') return jpegSize(buffer)
  return null
}

/** Walk JPEG markers to the start-of-frame segment that holds the dimensions. */
function jpegSize(buffer) {
  let offset = 2
  while (offset + 9 <= buffer.length) {
    if (buffer[offset] !== 0xff) { offset++; continue }
    const marker = buffer[offset + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
    const length = buffer.readUInt16BE(offset + 2)
    if (length < 2) return null
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    offset += 2 + length
  }
  return null
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Cut text to `maxChars` and mark it, without splitting a surrogate pair. */
function truncateText(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false }
  let cut = maxChars
  const last = text.charCodeAt(cut - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1
  return { text: text.slice(0, cut) + TRUNCATION_MARKER, truncated: true }
}

const finish = (kind, text, meta, maxChars) => {
  const { text: cut, truncated } = truncateText(text, maxChars)
  return { kind, text: cut, truncated, meta }
}

const toBuffer = (value) => {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  return Buffer.alloc(0)
}

/** Lower-case extension without the dot, or `''`. */
function extensionOf(fileName) {
  if (typeof fileName !== 'string') return ''
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName.trim())
  return match ? match[1].toLowerCase() : ''
}

const normalizeMime = (mimeType) => (typeof mimeType === 'string' ? mimeType.split(';')[0].trim().toLowerCase() : '')

/** `OLE2` compound file magic: legacy `.doc`, `.xls`, `.ppt`. */
const isOle2 = (buffer) => buffer.length >= 8 && buffer.readUInt32LE(0) === 0xe011cfd0

/** Cheap binary sniff used when nothing else identifies the payload. */
function hasBinaryBytes(buffer) {
  if (hasUtf16Bom(buffer)) {
    const text = decodeSourceText(buffer).text
    return text.length > 0 && countControlChars(text) / text.length > 0.1
  }
  const sample = buffer.subarray(0, BINARY_SAMPLE_BYTES)
  if (sample.includes(0)) return true
  const text = decodeWith('utf-8', sample)
  const control = countControlChars(text)
  if (text.length > 0 && control / text.length > 0.1) return true
  const replacements = countOccurrences(text, '\uFFFD')
  return text.length > 0 && replacements / text.length > 0.1
}

/** A UTF-16 byte-order mark in either endianness. */
const hasUtf16Bom = (buffer) => buffer.length >= 2
  && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))

/** True when high bytes look like cp1251 Cyrillic rather than accented Latin. */
function looksLikeCyrillicSingleByte(buffer) {
  let high = 0
  let cyrillic = 0
  for (const byte of buffer) {
    if (byte >= 0x80) {
      high++
      if (byte >= 0xc0) cyrillic++
    }
  }
  return cyrillic >= 4 && cyrillic / high >= 0.7
}

function countControlChars(text) {
  let count = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) count++
  }
  return count
}

function countOccurrences(text, needle) {
  let count = 0
  let index = text.indexOf(needle)
  while (index !== -1) {
    count++
    index = text.indexOf(needle, index + needle.length)
  }
  return count
}

const decodeWith = (encoding, buffer) => new TextDecoder(encoding, { fatal: false }).decode(buffer)

/** Tag name of `<w:p>`, `</w:p>` or `<w:br/>`; closing tags keep the slash. */
function elementName(tag) {
  if (tag.startsWith('</')) return `/${tag.slice(2).replace(/[\s>].*$/s, '')}`
  return tag.slice(1).replace(/[\s/>].*$/s, '')
}

/** Decode the XML entities that appear in OOXML text. */
function decodeXmlEntities(text) {
  if (!text.includes('&')) return text
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (all, entity) => {
    if (entity.startsWith('#')) {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all
    }
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[entity]
    return named ?? all
  })
}

/** Value of one XML attribute, or `undefined`. */
function attribute(tag, name) {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)
  return match ? decodeXmlEntities(match[1]) : undefined
}

const firstMatch = (text, pattern) => pattern.exec(text)?.[1]

/** Concatenate the text of every `<tag>…</tag>` in a fragment. */
function collectTagText(xml, tag) {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g')
  return [...xml.matchAll(pattern)].map((match) => decodeXmlEntities(match[1])).join('')
}

/** Trailing number of `…/sheetN.xml`, used to sort parts by slide/sheet order. */
const fileNumber = (name) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0)

/** Resolve a relationship target to its path inside the archive. */
function normalizeZipPath(target) {
  if (!target) return null
  let value = String(target).replace(/\\/g, '/')
  if (value.startsWith('/')) value = value.slice(1)
  else if (!value.startsWith('xl/')) value = `xl/${value}`
  return value
}

/**
 * Shared cleanup for tag-derived text: trim line ends, collapse runs of spaces,
 * normalise spacing around tabs and squeeze blank lines.
 */
function cleanupText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/ {2,}/g, ' ')
    .replace(/ *\t */g, '\t')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
}

const positiveInt = (value, fallback) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback)
