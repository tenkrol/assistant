/**
 * File writers for bot replies: XLSX, DOCX, CSV and plain text.
 *
 * The mirror image of `extract.mjs`. That module reads Office containers and
 * tabular text that arrive from the user; this one builds the same shapes for
 * the answer, so the bot can send a report as a spreadsheet or a letter as a
 * document. No npm package is involved: an OOXML file *is* a ZIP full of XML,
 * so a small ZIP writer plus string templates are enough, and every byte
 * produced here can be read back by `extract.mjs` — which is exactly what the
 * test suite does, next to real-world checks with openpyxl and python-docx.
 *
 *   - {@link createXlsx} builds a SpreadsheetML package: workbook, worksheets,
 *     a shared-string table and a minimal styles part. Strings, numbers,
 *     booleans and dates survive the round trip; line breaks are preserved.
 *   - {@link createDocx} builds a WordprocessingML package: a title, paragraphs
 *     with `## ` subheadings, `**bold**` runs, line breaks and an optional
 *     table with a header row.
 *   - {@link createCsv} and {@link createText} emit UTF-8, with a BOM where a
 *     BOM is what makes Excel read Cyrillic correctly.
 *   - {@link pickFormat} maps a file name to the writer that should handle it.
 *
 * Everything is deterministic: ZIP timestamps are pinned to 1980-01-01 unless
 * a caller passes `date`, so the same data always produces identical bytes.
 *
 * What is deliberately not supported: formulas, number formats, merged cells,
 * cell/paragraph styling beyond headings, bold, a table grid and borders,
 * images, hyperlinks, comments and multiple sections.
 */

import { deflateRawSync } from 'node:zlib'

/** UTF-8 byte-order mark; Excel needs it to read Cyrillic CSV/TXT correctly. */
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

const SPREADSHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'

const XLSX_MAIN_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
const XLSX_SHEET_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
const XLSX_STYLES_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'
const XLSX_STRINGS_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml'
const DOCX_MAIN_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
const DOCX_STYLES_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'

/** Excel's hard limit for a sheet name. */
const MAX_SHEET_NAME = 31

/** Characters Excel refuses inside a sheet name. */
const FORBIDDEN_SHEET_CHARS = /[\\/?*[\]:]/g

/** MS-DOS date for 1980-01-01, the earliest the format can express. */
const DOS_EPOCH_DATE = 0x21

/**
 * Minimal but complete spreadsheet styles part.
 *
 * Excel insists on at least two fills (none and gray125) even when nothing is
 * styled; font 1 is bold and stays available for a future header row.
 */
const XLSX_STYLES = XML_HEADER + `<styleSheet xmlns="${SPREADSHEET_NS}">`
  + '<fonts count="2">'
  + '<font><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/></font>'
  + '</fonts>'
  + '<fills count="2">'
  + '<fill><patternFill patternType="none"/></fill>'
  + '<fill><patternFill patternType="gray125"/></fill>'
  + '</fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="2">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '</cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>'

/**
 * Minimal Word styles part: defaults, Normal, two heading levels and the table
 * styles python-docx and Word expect to find by name.
 */
const DOCX_STYLES = XML_HEADER + `<w:styles xmlns:w="${WORD_NS}">`
  + '<w:docDefaults>'
  + '<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>'
  + '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>'
  + '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>'
  + '</w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>'
  + '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
  + '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>'
  + '<w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>'
  + '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
  + '<w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr>'
  + '<w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>'
  + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>'
  + '<w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/>'
  + '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar>'
  + '<w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>'
  + '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/>'
  + '</w:tblCellMar></w:tblPr></w:style>'
  + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/>'
  + '<w:basedOn w:val="TableNormal"/><w:uiPriority w:val="59"/>'
  + '<w:tblPr><w:tblBorders>'
  + '<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
  + '<w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
  + '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
  + '<w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
  + '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
  + '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
  + '</w:tblBorders></w:tblPr></w:style>'
  + '</w:styles>'

/**
 * Build a spreadsheet the bot can send as `.xlsx`.
 *
 * @param {object} [options]
 * @param {Array<{name?: string, rows?: Array<Array<unknown>>}>} [options.sheets] -
 *   one entry per worksheet; `rows` is an array of arrays of cell values.
 *   Strings, finite numbers, booleans and `Date` are written as such; `null`,
 *   `undefined` and `''` leave the cell empty.
 * @param {boolean} [options.compress] - deflate the parts (default `true`).
 * @param {Date} [options.date] - ZIP timestamp; omitted means a fixed 1980 date.
 * @returns {Buffer} a complete, valid XLSX package. Never throws: no sheets,
 *   no rows and no cells still produce a workbook with one empty sheet.
 */
export function createXlsx({ sheets, compress = true, date } = {}) {
  const normalized = normalizeSheets(sheets)
  const used = new Set()
  const names = normalized.map((sheet, index) => uniqueSheetName(sanitizeSheetName(sheet.name, index), used))
  const shared = createSharedStrings()

  const sheetFiles = []
  const sheetReferences = []
  names.forEach((name, index) => {
    const number = index + 1
    sheetReferences.push(`<sheet name="${escapeXmlAttribute(name)}" sheetId="${number}" r:id="rId${number}"/>`)
    sheetFiles.push({ name: `xl/worksheets/sheet${number}.xml`, data: worksheetXml(normalized[index].rows, shared) })
  })

  const stringsRel = names.length + 2
  const relationships = names.map((_name, index) =>
    `<Relationship Id="rId${index + 1}" Type="${OFFICE_REL_NS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
  relationships.push(`<Relationship Id="rId${names.length + 1}" Type="${OFFICE_REL_NS}/styles" Target="styles.xml"/>`)
  relationships.push(`<Relationship Id="rId${stringsRel}" Type="${OFFICE_REL_NS}/sharedStrings" Target="sharedStrings.xml"/>`)

  const overrides = [
    `<Override PartName="/xl/workbook.xml" ContentType="${XLSX_MAIN_TYPE}"/>`,
    ...names.map((_name, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="${XLSX_SHEET_TYPE}"/>`),
    `<Override PartName="/xl/styles.xml" ContentType="${XLSX_STYLES_TYPE}"/>`,
    `<Override PartName="/xl/sharedStrings.xml" ContentType="${XLSX_STRINGS_TYPE}"/>`,
  ]

  // The shared-string table is rendered only after every sheet registered its
  // strings, so the array order below is load-bearing.
  const files = [
    { name: '[Content_Types].xml', data: contentTypesXml(overrides) },
    { name: '_rels/.rels', data: rootRelsXml('xl/workbook.xml') },
    { name: 'xl/workbook.xml', data: XML_HEADER
      + `<workbook xmlns="${SPREADSHEET_NS}" xmlns:r="${OFFICE_REL_NS}">`
      + `<sheets>${sheetReferences.join('')}</sheets>`
      + '</workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: relationshipsXml(relationships) },
    { name: 'xl/styles.xml', data: XLSX_STYLES },
    ...sheetFiles,
    { name: 'xl/sharedStrings.xml', data: shared.toXml() },
  ]
  return createZip(files, { compress, date })
}

/**
 * Build a Word document the bot can send as `.docx`.
 *
 * @param {object} [options]
 * @param {string} [options.title] - leading Heading 1 paragraph, when non-empty.
 * @param {Array<string>} [options.paragraphs] - body text. A line starting with
 *   `## ` becomes a Heading 2 paragraph; `**text**` inside a line becomes a bold
 *   run; `\n` inside a line becomes a line break.
 * @param {{header?: Array<unknown>, rows?: Array<Array<unknown>>}} [options.table] -
 *   optional table; `header` is rendered bold.
 * @param {boolean} [options.compress] - deflate the parts (default `true`).
 * @param {Date} [options.date] - ZIP timestamp; omitted means a fixed 1980 date.
 * @returns {Buffer} a complete, valid DOCX package. Never throws: an empty
 *   request still produces an openable document with an empty body.
 */
export function createDocx({ title, paragraphs, table, compress = true, date } = {}) {
  const body = []
  const heading = cellText(title)
  if (heading !== '') body.push(paragraphXml(heading, { styleId: 'Heading1' }))

  for (const item of normalizeParagraphs(paragraphs)) {
    const text = String(item)
    if (text.startsWith('## ')) body.push(paragraphXml(text.slice(3), { styleId: 'Heading2' }))
    else body.push(paragraphXml(text))
  }

  const tableXml = renderTable(table)
  if (tableXml !== '') body.push(tableXml)

  body.push('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701" w:header="708" w:footer="708" w:gutter="0"/>'
    + '</w:sectPr>')

  const files = [
    { name: '[Content_Types].xml', data: contentTypesXml([
      `<Override PartName="/word/document.xml" ContentType="${DOCX_MAIN_TYPE}"/>`,
      `<Override PartName="/word/styles.xml" ContentType="${DOCX_STYLES_TYPE}"/>`,
    ]) },
    { name: '_rels/.rels', data: rootRelsXml('word/document.xml') },
    { name: 'word/document.xml', data: XML_HEADER
      + `<w:document xmlns:w="${WORD_NS}"><w:body>${body.join('')}</w:body></w:document>` },
    { name: 'word/_rels/document.xml.rels', data: relationshipsXml([
      `<Relationship Id="rId1" Type="${OFFICE_REL_NS}/styles" Target="styles.xml"/>`,
    ]) },
    { name: 'word/styles.xml', data: DOCX_STYLES },
  ]
  return createZip(files, { compress, date })
}

/**
 * Build CSV bytes for `.csv`/`.tsv` replies.
 *
 * Quoting follows RFC 4180: a field is quoted when it contains the delimiter, a
 * double quote or a line break, and embedded quotes are doubled. Records end
 * with CRLF, which is what Excel writes.
 *
 * @param {object} [options]
 * @param {Array<Array<unknown>>} [options.rows] - rows of cell values.
 * @param {string} [options.delimiter] - field separator, `,` by default.
 * @returns {Buffer} UTF-8 bytes **with** a BOM.
 */
export function createCsv({ rows, delimiter = ',' } = {}) {
  const separator = typeof delimiter === 'string' && delimiter !== '' ? delimiter : ','
  const records = normalizeRows(rows).map((row) => row.map((cell) => csvField(cell, separator)).join(separator))
  const text = records.length === 0 ? '' : `${records.join('\r\n')}\r\n`
  return Buffer.concat([UTF8_BOM, Buffer.from(text, 'utf8')])
}

/**
 * Build plain-text bytes for `.txt` and `.md` replies.
 *
 * @param {object} [options]
 * @param {string} [options.text] - the whole body.
 * @param {string} [options.fileName] - used to decide the BOM: `.md`/`.markdown`
 *   are written without one, everything else (`.txt`) with one.
 * @param {boolean} [options.bom] - explicit override for the decision above.
 * @returns {Buffer} UTF-8 bytes, BOM-prefixed unless the name is Markdown.
 */
export function createText({ text, fileName, bom } = {}) {
  const body = Buffer.from(text === null || text === undefined ? '' : String(text), 'utf8')
  const withBom = typeof bom === 'boolean' ? bom : !/\.(md|markdown)$/i.test(String(fileName ?? '').trim())
  return withBom ? Buffer.concat([UTF8_BOM, body]) : body
}

const FORMAT_BY_EXTENSION = new Map([
  ['xlsx', 'xlsx'], ['xlsm', 'xlsx'], ['xltx', 'xlsx'], ['xltm', 'xlsx'],
  ['docx', 'docx'], ['docm', 'docx'], ['dotx', 'docx'], ['dotm', 'docx'],
  ['csv', 'csv'], ['tsv', 'csv'],
  ['md', 'md'], ['markdown', 'md'],
  ['txt', 'txt'], ['text', 'txt'],
])

/**
 * Guess which writer should handle a file name.
 *
 * @param {string} [fileName] - a name, a path; the extension decides.
 * @returns {'xlsx'|'docx'|'csv'|'md'|'txt'|undefined} `undefined` for anything
 *   unknown. The comparison is case-insensitive, so `.XLSX` works.
 */
export function pickFormat(fileName) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(fileName ?? '').trim())
  return match ? FORMAT_BY_EXTENSION.get(match[1].toLowerCase()) : undefined
}

// ---------------------------------------------------------------------------
// XLSX parts
// ---------------------------------------------------------------------------

/** One `<worksheet>`: a dimension hint plus every row and cell. */
function worksheetXml(rows, shared) {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const dimension = rows.length === 0 || width === 0 ? 'A1' : `A1:${columnName(width - 1)}${rows.length}`

  const rendered = rows.map((row, rowIndex) => {
    const reference = rowIndex + 1
    const cells = []
    row.forEach((value, columnIndex) => {
      const cell = cellXml(value, `${columnName(columnIndex)}${reference}`, shared)
      if (cell !== '') cells.push(cell)
    })
    return cells.length === 0 ? `<row r="${reference}"/>` : `<row r="${reference}">${cells.join('')}</row>`
  })

  return XML_HEADER
    + `<worksheet xmlns="${SPREADSHEET_NS}">`
    + `<dimension ref="${dimension}"/>`
    + `<sheetData>${rendered.join('')}</sheetData>`
    + '</worksheet>'
}

/** One `<c>`: numbers and booleans stay typed, everything else is a string. */
function cellXml(value, reference, shared) {
  const cell = classifyCell(value)
  if (cell.type === 'empty') return ''
  if (cell.type === 'number') return `<c r="${reference}"><v>${cell.text}</v></c>`
  if (cell.type === 'boolean') return `<c r="${reference}" t="b"><v>${cell.value ? 1 : 0}</v></c>`
  if (cell.text === '') return ''
  return `<c r="${reference}" t="s"><v>${shared.add(cell.text)}</v></c>`
}

/** Decide how one JavaScript value should be stored in a spreadsheet cell. */
function classifyCell(value) {
  if (value === null || value === undefined) return { type: 'empty' }
  if (typeof value === 'boolean') return { type: 'boolean', value }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { type: 'string', text: String(value) }
    return { type: 'number', text: String(value) }
  }
  if (typeof value === 'bigint') return { type: 'number', text: value.toString() }
  if (value instanceof Date) return { type: 'string', text: cellText(value) }
  const text = String(value)
  return text === '' ? { type: 'empty' } : { type: 'string', text }
}

/** Shared-string table with de-duplication, as Excel expects. */
function createSharedStrings() {
  const items = []
  const index = new Map()
  let count = 0
  return {
    add(text) {
      count++
      const known = index.get(text)
      if (known !== undefined) return known
      index.set(text, items.length)
      items.push(text)
      return items.length - 1
    },
    toXml() {
      const body = items.map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`).join('')
      return XML_HEADER
        + `<sst xmlns="${SPREADSHEET_NS}" count="${count}" uniqueCount="${items.length}">${body}</sst>`
    },
  }
}

/** Zero-based column index to its spreadsheet letters: 0 -> A, 26 -> AA. */
function columnName(index) {
  let value = Math.max(0, Math.floor(index))
  let name = ''
  do {
    name = String.fromCharCode(65 + (value % 26)) + name
    value = Math.floor(value / 26) - 1
  } while (value >= 0)
  return name
}

/** A sheet name Excel will accept: no forbidden characters, at most 31 chars. */
function sanitizeSheetName(name, index) {
  const fallback = `Лист${index + 1}`
  const cleaned = (typeof name === 'string' ? name : '')
    .replace(FORBIDDEN_SHEET_CHARS, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Excel rejects a name that starts or ends with an apostrophe.
    .replace(/^'+|'+$/g, '')
    .slice(0, MAX_SHEET_NAME)
    .trim()
  return cleaned === '' ? fallback : cleaned
}

/** Make a sheet name unique; Excel compares names case-insensitively. */
function uniqueSheetName(name, used) {
  const taken = (candidate) => used.has(candidate.toLowerCase())
  if (!taken(name)) {
    used.add(name.toLowerCase())
    return name
  }
  for (let suffix = 2; ; suffix++) {
    const marker = ` (${suffix})`
    const candidate = name.slice(0, Math.max(1, MAX_SHEET_NAME - marker.length)) + marker
    if (!taken(candidate)) {
      used.add(candidate.toLowerCase())
      return candidate
    }
  }
}

// ---------------------------------------------------------------------------
// DOCX parts
// ---------------------------------------------------------------------------

/** One `<w:p>`, optionally styled and rendered with bold runs. */
function paragraphXml(text, { styleId, bold = false } = {}) {
  const properties = styleId ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>` : ''
  const runs = inlineRuns(String(text))
  if (runs.length === 0) return properties === '' ? '<w:p/>' : `<w:p>${properties}</w:p>`
  const rendered = runs.map((run) => runXml(bold ? { ...run, bold: true } : run)).join('')
  return `<w:p>${properties}${rendered}</w:p>`
}

/** `**bold**` segments become flagged runs; a line break becomes `<w:br/>`. */
function inlineRuns(text) {
  const runs = []
  let cursor = 0
  for (const match of text.matchAll(/\*\*([\s\S]+?)\*\*/g)) {
    if (match.index > cursor) runs.push({ text: text.slice(cursor, match.index), bold: false })
    runs.push({ text: match[1], bold: true })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) runs.push({ text: text.slice(cursor), bold: false })
  return runs.filter((run) => run.text !== '')
}

/** One `<w:r>`; `<w:rPr>` must precede the run's content. */
function runXml({ text, bold }) {
  const content = String(text)
    .split('\n')
    .map((line) => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`)
    .join('<w:br/>')
  return `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}${content}</w:r>`
}

/** Optional `<w:tbl>` with a bold header row and one cell per column. */
function renderTable(table) {
  if (table === null || typeof table !== 'object') return ''
  const header = normalizeRows(table.header === undefined ? [] : [table.header])[0] ?? []
  const rows = normalizeRows(table.rows)
  const width = Math.max(header.length, ...rows.map((row) => row.length), 0)
  if (width === 0) return ''

  const grid = `<w:tblGrid>${Array.from({ length: width }, () => '<w:gridCol w:w="2400"/>').join('')}</w:tblGrid>`
  const headerRow = header.length === 0 ? '' : rowXml(header, width, true)
  const bodyRows = rows.map((row) => rowXml(row, width, false)).join('')
  return '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>'
    + grid + headerRow + bodyRows + '</w:tbl>'
}

/** One `<w:tr>`; every cell needs at least one paragraph, empty or not. */
function rowXml(cells, width, bold) {
  const rendered = []
  for (let index = 0; index < width; index++) {
    const text = index < cells.length ? cellText(cells[index]) : ''
    rendered.push(`<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${paragraphXml(text, { bold })}</w:tc>`)
  }
  return `<w:tr>${rendered.join('')}</w:tr>`
}

// ---------------------------------------------------------------------------
// Package plumbing
// ---------------------------------------------------------------------------

/**
 * Assemble a ZIP archive: local headers, central directory, EOCD.
 *
 * Names are always marked UTF-8 (flag `0x0800`) and timestamps default to
 * 1980-01-01 00:00 so identical input gives identical bytes.
 *
 * @param {Array<{name: string, data: Buffer|string}>} files - archive entries.
 * @param {{compress?: boolean, date?: Date}} [options]
 * @returns {Buffer}
 */
function createZip(files, { compress = true, date } = {}) {
  const stamp = dosStamp(date)
  const local = []
  const central = []
  let offset = 0

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data ?? ''), 'utf8')
    const payload = compress ? deflateRawSync(raw) : raw
    const method = compress ? 8 : 0
    const crc = crc32(raw)

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(stamp.time, 10)
    header.writeUInt16LE(stamp.date, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(payload.length, 18)
    header.writeUInt32LE(raw.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28)
    local.push(header, name, payload)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt16LE(method, 10)
    record.writeUInt16LE(stamp.time, 12)
    record.writeUInt16LE(stamp.date, 14)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(payload.length, 20)
    record.writeUInt32LE(raw.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt16LE(0, 30)
    record.writeUInt16LE(0, 32)
    record.writeUInt16LE(0, 34)
    record.writeUInt16LE(0, 36)
    record.writeUInt32LE(0, 38)
    record.writeUInt32LE(offset, 42)
    central.push(record, name)

    offset += header.length + name.length + payload.length
  }

  const directory = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, eocd])
}

/** A `Date` as MS-DOS date/time fields; no or invalid date pins 1980-01-01. */
function dosStamp(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return { time: 0, date: DOS_EPOCH_DATE }
  }
  const year = Math.min(2107, Math.max(1980, date.getFullYear()))
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

/** Standard CRC-32, required by every ZIP entry. */
function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

const contentTypesXml = (overrides) => XML_HEADER
  + `<Types xmlns="${CONTENT_TYPES_NS}">`
  + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
  + `<Default Extension="xml" ContentType="application/xml"/>`
  + overrides.join('')
  + '</Types>'

const rootRelsXml = (target) => relationshipsXml([
  `<Relationship Id="rId1" Type="${OFFICE_REL_NS}/officeDocument" Target="${target}"/>`,
])

const relationshipsXml = (relationships) => XML_HEADER
  + `<Relationships xmlns="${PACKAGE_REL_NS}">${relationships.join('')}</Relationships>`

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Text of a cell value; `null`/`undefined` are empty, dates are ISO strings. */
function cellText(value) {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString()
  return String(value)
}

/** One CSV field, quoted exactly when RFC 4180 requires it. */
function csvField(value, delimiter) {
  const text = cellText(value)
  const needsQuotes = text.includes('"') || text.includes(delimiter) || /[\r\n]/.test(text)
  if (!needsQuotes) return text
  return `"${text.replace(/"/g, '""')}"`
}

/** Escape text for an XML text node, normalising line endings on the way. */
function escapeXml(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Escape text for a double-quoted XML attribute. */
function escapeXmlAttribute(value) {
  return escapeXml(value)
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
}

/** Force a value into "array of arrays" shape without ever throwing. */
function normalizeRows(rows) {
  if (!Array.isArray(rows)) return []
  return rows.map((row) => {
    if (Array.isArray(row)) return row
    if (row === null || row === undefined) return []
    return [row]
  })
}

/** Sheets of a workbook: missing/blank entries become one empty sheet. */
function normalizeSheets(sheets) {
  const list = Array.isArray(sheets) ? sheets : []
  const normalized = list.map((sheet) => ({
    name: sheet && typeof sheet === 'object' ? sheet.name : undefined,
    rows: normalizeRows(sheet && typeof sheet === 'object' ? sheet.rows : undefined),
  }))
  return normalized.length === 0 ? [{ name: undefined, rows: [] }] : normalized
}

/** Paragraphs of a document: anything that is not a string is stringified. */
function normalizeParagraphs(paragraphs) {
  if (!Array.isArray(paragraphs)) return []
  return paragraphs.map((item) => (item === null || item === undefined ? '' : String(item)))
}
