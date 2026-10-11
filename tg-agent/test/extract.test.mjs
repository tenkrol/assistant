/**
 * Tests for attachment text extraction.
 *
 * DOCX/XLSX/PPTX fixtures are assembled here as real ZIP archives — a local
 * header, a central directory and an EOCD, with deflate or stored payloads — so
 * the reader under test is exercised against the same binary shape a chat
 * client uploads. PDF fixtures are likewise hand-built with a correct xref.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { detectKind, extractText, MAX_TEXT_CHARS, TRUNCATION_MARKER } from '../src/extract.mjs'

// ---------------------------------------------------------------------------
// ZIP fixture builder
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

/**
 * Build a ZIP archive.
 *
 * `zeroLocalSizes` reproduces the data-descriptor layout, where the local
 * header carries no sizes and only the central directory is authoritative.
 */
function makeZip(entries, { zeroLocalSizes = false, store = false } = {}) {
  const parts = []
  const directory = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8')
    const stored = entry.store === true || store
    const payload = stored ? raw : deflateRawSync(raw)
    const method = stored ? 0 : 8
    const crc = crc32(raw)

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(0x21, 12)
    header.writeUInt32LE(zeroLocalSizes ? 0 : crc, 14)
    header.writeUInt32LE(zeroLocalSizes ? 0 : payload.length, 18)
    header.writeUInt32LE(zeroLocalSizes ? 0 : raw.length, 22)
    header.writeUInt16LE(name.length, 26)
    parts.push(header, name, payload)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(0x031e, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt16LE(method, 10)
    record.writeUInt16LE(0x21, 14)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(payload.length, 20)
    record.writeUInt32LE(raw.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(offset, 42)
    directory.push(record, name)

    offset += header.length + name.length + payload.length
  }
  const central = Buffer.concat(directory)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, central, eocd])
}

// ---------------------------------------------------------------------------
// OOXML fixtures
// ---------------------------------------------------------------------------

const DOCX_BODY = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Первый абзац</w:t></w:r></w:p>
    <w:p><w:r><w:t>Второй абзац</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Ячейка A1</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Ячейка B1</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Ячейка A2</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Ячейка B2</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`

const DOCX_FOOTNOTES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:id="1"><w:p><w:r><w:t>Сноска один</w:t></w:r></w:p></w:footnote>
</w:footnotes>`

const XLSX_WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Данные" sheetId="1" r:id="rId1"/>
    <sheet name="Итоги" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`

const XLSX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`

const XLSX_SHARED = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">
  <si><t>Привет</t></si>
</sst>`

const XLSX_SHEET1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>Вторая</t></is></c><c r="B2"><v>3.5</v></c></row>
  </sheetData>
</worksheet>`

const XLSX_SHEET2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1"><v>7</v></c><c r="C1"><v>9</v></c></row>
  </sheetData>
</worksheet>`

const slide = (text) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    ${text}
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`

const paragraph = (text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`

const docxZip = ({ footnotes = false, ...options } = {}) => makeZip([
  { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
  { name: '_rels/.rels', data: '<?xml version="1.0"?><Relationships/>' },
  { name: 'word/document.xml', data: DOCX_BODY },
  ...(footnotes ? [{ name: 'word/footnotes.xml', data: DOCX_FOOTNOTES }] : []),
], options)

// ---------------------------------------------------------------------------
// PDF fixture builder
// ---------------------------------------------------------------------------

/**
 * Build a small PDF with a real xref table.
 *
 * Each page is a string (uncompressed text stream) or `{ content, deflate }`.
 * The assembly is byte-oriented because a deflated stream is binary: building
 * it as a JS string and re-encoding as UTF-8 would corrupt both the payload and
 * every xref offset after it.
 */
function buildPdf(pages) {
  const objects = []
  const pageNumbers = []
  pages.forEach((page, index) => {
    const spec = typeof page === 'string' ? { content: page } : page
    const raw = Buffer.isBuffer(spec.content) ? spec.content : Buffer.from(spec.content, 'utf8')
    const body = spec.deflate ? deflateRawSync(raw) : raw
    const pageNumber = 3 + index * 2
    const streamNumber = pageNumber + 1
    pageNumbers.push(pageNumber)
    objects[pageNumber] = Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] `
      + `/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> `
      + `/Contents ${streamNumber} 0 R >>`,
      'utf8',
    )
    objects[streamNumber] = Buffer.concat([
      Buffer.from(`<< /Length ${body.length}${spec.deflate ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'utf8'),
      body,
      Buffer.from('\nendstream', 'utf8'),
    ])
  })
  objects[1] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'utf8')
  objects[2] = Buffer.from(
    `<< /Type /Pages /Kids [${pageNumbers.map((number) => `${number} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    'utf8',
  )

  const parts = [Buffer.from('%PDF-1.4\n', 'utf8')]
  let offset = parts[0].length
  const offsets = []
  for (let number = 1; number < objects.length; number++) {
    offsets[number] = offset
    const piece = Buffer.concat([
      Buffer.from(`${number} 0 obj\n`, 'utf8'),
      objects[number],
      Buffer.from('\nendobj\n', 'utf8'),
    ])
    parts.push(piece)
    offset += piece.length
  }
  const xrefOffset = offset
  let tail = `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let number = 1; number < objects.length; number++) {
    tail += `${String(offsets[number]).padStart(10, '0')} 00000 n \n`
  }
  tail += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  parts.push(Buffer.from(tail, 'utf8'))
  return Buffer.concat(parts)
}

/** Minimal PNG header with a readable IHDR. */
function pngBytes(width, height) {
  const buffer = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'latin1')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

// ---------------------------------------------------------------------------
// detectKind
// ---------------------------------------------------------------------------

test('detectKind reads extensions and MIME types', () => {
  assert.equal(detectKind({ fileName: 'отчёт.pdf' }), 'pdf')
  assert.equal(detectKind({ fileName: 'док.docx' }), 'docx')
  assert.equal(detectKind({ fileName: 'таблица.xlsx' }), 'xlsx')
  assert.equal(detectKind({ fileName: 'преза.pptx' }), 'pptx')
  assert.equal(detectKind({ fileName: 'данные.csv' }), 'csv')
  assert.equal(detectKind({ fileName: 'данные.tsv' }), 'csv')
  assert.equal(detectKind({ fileName: 'config.JSON' }), 'json')
  assert.equal(detectKind({ fileName: 'заметки.md' }), 'text')
  assert.equal(detectKind({ fileName: 'фото.png' }), 'image')
  assert.equal(detectKind({ mimeType: 'application/pdf' }), 'pdf')
  assert.equal(detectKind({ mimeType: 'text/csv; charset=utf-8' }), 'csv')
  assert.equal(detectKind({ mimeType: 'application/json' }), 'json')
  assert.equal(detectKind({ mimeType: 'text/plain' }), 'text')
  assert.equal(detectKind({ mimeType: 'image/jpeg' }), 'image')
  assert.equal(
    detectKind({ mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    'docx',
  )
})

test('detectKind trusts magic bytes over the declared name', () => {
  assert.equal(detectKind({ fileName: 'без-имени', bytes: Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n') }), 'pdf')
  assert.equal(detectKind({ fileName: 'переименован.txt', bytes: pngBytes(1, 1) }), 'image')
  assert.equal(detectKind({ fileName: 'переименован.png', bytes: Buffer.from('%PDF-1.4\n') }), 'pdf')
})

test('detectKind inspects OOXML folders inside a ZIP', () => {
  assert.equal(detectKind({ bytes: makeZip([{ name: 'word/document.xml', data: '<w:document/>' }]) }), 'docx')
  assert.equal(detectKind({ bytes: makeZip([{ name: 'xl/workbook.xml', data: '<workbook/>' }]) }), 'xlsx')
  assert.equal(detectKind({ bytes: makeZip([{ name: 'ppt/slides/slide1.xml', data: '<p:sld/>' }]) }), 'pptx')
  // Without an Office name a plain ZIP stays unknown...
  assert.equal(detectKind({ fileName: 'архив.zip', bytes: makeZip([{ name: 'readme.txt', data: 'привет' }]) }), 'unknown')
  // ...but an Office name is kept, so extraction can report the missing part.
  assert.equal(detectKind({ fileName: 'архив.docx', bytes: makeZip([{ name: 'readme.txt', data: 'привет' }]) }), 'docx')
})

test('detectKind reports unknown for garbage and empty input', () => {
  assert.equal(detectKind({ bytes: Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]) }), 'unknown')
  assert.equal(detectKind({ bytes: Buffer.alloc(0) }), 'unknown')
  assert.equal(detectKind({}), 'unknown')
  assert.equal(detectKind(), 'unknown')
  assert.equal(detectKind(null), 'unknown')
})

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

test('DOCX paragraphs are separated and tables stay tab-separated', () => {
  const result = extractText({ fileName: 'док.docx', bytes: docxZip() })
  assert.equal(result.kind, 'docx')
  assert.equal(result.error, undefined)
  assert.equal(result.truncated, false)
  assert.match(result.text, /Первый абзац\nВторой абзац/, result.text)
  assert.match(result.text, /Ячейка A1\tЯчейка B1/, result.text)
  assert.match(result.text, /Ячейка A2\tЯчейка B2/, result.text)
  assert.ok(result.text.indexOf('Первый абзац') < result.text.indexOf('Ячейка A1'), 'body precedes the table')
  assert.equal(result.meta.tables, 1)
  assert.equal(result.meta.paragraphs, 6)
  assert.equal(result.meta.footnotes, false)
})

test('DOCX footnotes are appended when the part exists', () => {
  const result = extractText({ fileName: 'док.docx', bytes: docxZip({ footnotes: true }) })
  assert.match(result.text, /--- сноски ---/)
  assert.match(result.text, /Сноска один/)
  assert.equal(result.meta.footnotes, true)
})

test('ZIP reading survives data descriptors and stored entries', () => {
  const descriptor = extractText({ fileName: 'док.docx', bytes: docxZip({ zeroLocalSizes: true }) })
  assert.match(descriptor.text, /Первый абзац/)
  assert.match(descriptor.text, /Ячейка A2\tЯчейка B2/)

  const stored = extractText({ fileName: 'док.docx', bytes: docxZip({ store: true }) })
  assert.match(stored.text, /Второй абзац/)
})

test('a DOCX-named ZIP without word/document.xml reports a clear error', () => {
  const result = extractText({ fileName: 'док.docx', bytes: makeZip([{ name: 'word/styles.xml', data: '<x/>' }]) })
  assert.equal(result.kind, 'docx')
  assert.equal(result.text, '')
  assert.match(result.error, /word\/document\.xml/)
})

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

test('XLSX renders sheets with names, shared strings and numbers', () => {
  const bytes = makeZip([
    { name: 'xl/workbook.xml', data: XLSX_WORKBOOK },
    { name: 'xl/_rels/workbook.xml.rels', data: XLSX_RELS },
    { name: 'xl/sharedStrings.xml', data: XLSX_SHARED },
    { name: 'xl/worksheets/sheet1.xml', data: XLSX_SHEET1 },
    { name: 'xl/worksheets/sheet2.xml', data: XLSX_SHEET2 },
  ])
  const result = extractText({ fileName: 'таблица.xlsx', bytes })
  assert.equal(result.error, undefined)
  assert.match(result.text, /--- Лист: Данные ---/)
  assert.match(result.text, /Привет\t42/, result.text)
  assert.match(result.text, /Вторая\t3\.5/, result.text)
  assert.match(result.text, /--- Лист: Итоги ---/)
  // Column C sits after an empty B, so the gap is preserved.
  assert.match(result.text, /7\t\t9/, result.text)
  assert.deepEqual(result.meta.sheets, ['Данные', 'Итоги'])
  assert.equal(result.meta.sheetCount, 2)
  assert.equal(result.meta.rows, 3)
})

test('XLSX sheet order follows workbook relationships, not file order', () => {
  const bytes = makeZip([
    { name: 'xl/workbook.xml', data: XLSX_WORKBOOK },
    { name: 'xl/_rels/workbook.xml.rels', data: XLSX_RELS },
    { name: 'xl/sharedStrings.xml', data: XLSX_SHARED },
    // sheet2 is stored first; the relationship order must still win.
    { name: 'xl/worksheets/sheet2.xml', data: XLSX_SHEET2 },
    { name: 'xl/worksheets/sheet1.xml', data: XLSX_SHEET1 },
  ])
  const result = extractText({ fileName: 'таблица.xlsx', bytes })
  assert.ok(result.text.indexOf('--- Лист: Данные ---') < result.text.indexOf('--- Лист: Итоги ---'), result.text)
})

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

test('PPTX slides are numbered and separated in order', () => {
  const bytes = makeZip([
    { name: 'ppt/slides/slide1.xml', data: slide(`${paragraph('Слайд один')}${paragraph('Второй пункт')}`) },
    { name: 'ppt/slides/slide2.xml', data: slide(paragraph('Слайд два')) },
  ])
  const result = extractText({ fileName: 'преза.pptx', bytes })
  assert.equal(result.error, undefined)
  assert.match(result.text, /--- слайд 1 ---\nСлайд один\nВторой пункт/)
  assert.match(result.text, /\n\n--- слайд 2 ---\nСлайд два/)
  assert.ok(result.text.indexOf('Слайд один') < result.text.indexOf('Слайд два'))
  assert.equal(result.meta.slides, 2)
})

test('PPTX slides sort numerically, so slide 10 follows slide 2', () => {
  const bytes = makeZip([
    { name: 'ppt/slides/slide10.xml', data: slide(paragraph('Десятый')) },
    { name: 'ppt/slides/slide2.xml', data: slide(paragraph('Второй')) },
    { name: 'ppt/slides/slide1.xml', data: slide(paragraph('Первый')) },
  ])
  const result = extractText({ fileName: 'преза.pptx', bytes })
  const order = ['Первый', 'Второй', 'Десятый'].map((text) => result.text.indexOf(text))
  assert.ok(order.every((position) => position >= 0), result.text)
  assert.ok(order[0] < order[1] && order[1] < order[2], result.text)
  assert.match(result.text, /--- слайд 1 ---/)
  assert.match(result.text, /--- слайд 2 ---/)
  assert.match(result.text, /--- слайд 10 ---/)
})

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

test('PDF text is recovered from BT/ET runs and pages are counted', () => {
  const bytes = buildPdf([
    'BT /F1 12 Tf 72 720 Td (Привет, мир) Tj ET',
    'BT /F1 12 Tf 72 700 Td (Вторая страница) Tj ET',
  ])
  const result = extractText({ fileName: 'док.pdf', bytes })
  assert.equal(result.kind, 'pdf')
  assert.equal(result.error, undefined)
  assert.match(result.text, /Привет, мир/)
  assert.match(result.text, /Вторая страница/)
  assert.equal(result.meta.pages, 2)
})

test('PDF without a text layer reports the OCR hint but keeps the page count', () => {
  const bytes = buildPdf(['q 1 0 0 1 0 0 cm /Im0 Do Q', 'q 1 0 0 1 0 0 cm /Im0 Do Q'])
  const result = extractText({ fileName: 'скан.pdf', bytes })
  assert.equal(result.kind, 'pdf')
  assert.equal(result.text, '')
  assert.equal(result.truncated, false)
  assert.match(result.error, /OCR/)
  assert.equal(result.meta.pages, 2)
})

test('PDF with a FlateDecode text stream is inflated', () => {
  const bytes = buildPdf([{ content: 'BT /F1 12 Tf (Сжатый текст) Tj ET', deflate: true }])
  const result = extractText({ fileName: 'сжатый.pdf', bytes })
  assert.equal(result.error, undefined)
  assert.match(result.text, /Сжатый текст/)
  assert.equal(result.meta.pages, 1)
})

test('a PDF whose fonts decode to control characters is called unreadable', () => {
  // Real files with embedded subset fonts behave like this: BT/ET text exists,
  // but every byte decodes to a control character rather than a letter.
  const gibberish = [1, 2, 3, 4, 5, 6, 7, 8, 14, 15, 16, 17, 18].map((code) => String.fromCharCode(code)).join('')
  const bytes = buildPdf([`BT /F1 12 Tf (${gibberish}) Tj ET`])
  const result = extractText({ fileName: 'шрифты.pdf', bytes })
  assert.equal(result.text, '')
  assert.match(result.error, /OCR/)
  assert.equal(result.meta.pages, 1)
})

// ---------------------------------------------------------------------------
// CSV / TSV
// ---------------------------------------------------------------------------

test('CSV handles quoted commas and doubled quotes', () => {
  const bytes = Buffer.from('имя,значение\n"Иванов, И.","сказал ""привет"""\n', 'utf8')
  const result = extractText({ fileName: 'люди.csv', bytes })
  assert.equal(result.error, undefined)
  assert.match(result.text, /имя\tзначение/)
  assert.match(result.text, /Иванов, И\.\tсказал "привет"/, result.text)
  assert.equal(result.meta.delimiter, ',')
  assert.equal(result.meta.rows, 2)
})

test('CSV detects semicolon and tab separators', () => {
  const semicolon = extractText({ fileName: 'a.csv', bytes: Buffer.from('a;b;c\n1;2;3', 'utf8') })
  assert.equal(semicolon.meta.delimiter, ';')
  assert.match(semicolon.text, /a\tb\tc\n1\t2\t3/)

  const tabbed = extractText({ fileName: 'a.tsv', bytes: Buffer.from('a\tb\n1\t2', 'utf8') })
  assert.equal(tabbed.meta.delimiter, '\\t')
  assert.match(tabbed.text, /a\tb\n1\t2/)
})

test('CSV keeps newlines inside quoted fields on one display row', () => {
  const result = extractText({ fileName: 'a.csv', bytes: Buffer.from('a,b\n"x\ny",z', 'utf8') })
  assert.equal(result.meta.rows, 2)
  assert.match(result.text, /x y\tz/)
  assert.equal(result.text.split('\n').length, 2)
})

test('CSV caps displayed rows but reports the real total', () => {
  const rows = ['n,v']
  for (let index = 1; index <= 9; index++) rows.push(`${index},${index * 2}`)
  const result = extractText({ fileName: 'a.csv', bytes: Buffer.from(rows.join('\n'), 'utf8'), limits: { maxRows: 3 } })
  assert.equal(result.meta.rows, 10)
  assert.equal(result.meta.shownRows, 3)
  assert.match(result.text, /Всего строк: 10, показаны первые 3/)
})

// ---------------------------------------------------------------------------
// JSON and plain text
// ---------------------------------------------------------------------------

test('JSON is pretty-printed', () => {
  const result = extractText({ fileName: 'config.json', bytes: Buffer.from('{"имя":"Аня","числа":[1,2,3]}', 'utf8') })
  assert.equal(result.kind, 'json')
  assert.equal(result.error, undefined)
  assert.match(result.text, /"имя": "Аня"/)
  assert.match(result.text, /^\{\n {2}"имя"/)
  assert.equal(result.meta.type, 'object')
  assert.equal(result.meta.keys, 2)
})

test('invalid JSON is an error, not raw text', () => {
  const result = extractText({ fileName: 'broken.json', bytes: Buffer.from('{oops', 'utf8') })
  assert.equal(result.kind, 'json')
  assert.equal(result.text, '')
  assert.match(result.error, /JSON/)
})

test('TXT and MD are returned verbatim', () => {
  for (const fileName of ['заметки.txt', 'заметки.md']) {
    const result = extractText({ fileName, bytes: Buffer.from('привет\nмир', 'utf8') })
    assert.equal(result.kind, 'text')
    assert.equal(result.error, undefined)
    assert.equal(result.text, 'привет\nмир')
    assert.equal(result.meta.encoding, 'utf-8')
  }
})

test('a UTF-16 BOM selects the right decoder', () => {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('привет utf16', 'utf16le')])
  const result = extractText({ fileName: 'a.txt', bytes })
  assert.equal(result.text, 'привет utf16')
  assert.equal(result.meta.encoding, 'utf-16le')
})

test('windows-1251 Cyrillic text is decoded instead of failing', () => {
  const result = extractText({ fileName: 'a.txt', bytes: Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]) })
  assert.equal(result.meta.encoding, 'windows-1251')
  assert.equal(result.text, 'Привет')
})

test('binary bytes named as text report a binary error', () => {
  const result = extractText({ fileName: 'note.txt', bytes: Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd, 0x00]) })
  assert.equal(result.kind, 'text')
  assert.equal(result.text, '')
  assert.match(result.error, /бинарн/i)
})

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

test('images carry no text but report their size', () => {
  const result = extractText({ fileName: 'пик.png', mimeType: 'image/png', bytes: pngBytes(2, 3) })
  assert.equal(result.kind, 'image')
  assert.equal(result.text, '')
  assert.equal(result.error, undefined)
  assert.equal(result.meta.width, 2)
  assert.equal(result.meta.height, 3)
  assert.equal(result.meta.format, 'png')
})

// ---------------------------------------------------------------------------
// Limits and robustness
// ---------------------------------------------------------------------------

test('text longer than MAX_TEXT_CHARS is cut and marked', () => {
  const result = extractText({ fileName: 'long.txt', bytes: Buffer.from('a'.repeat(MAX_TEXT_CHARS + 500), 'utf8') })
  assert.equal(result.truncated, true)
  assert.equal(result.text, 'a'.repeat(MAX_TEXT_CHARS) + TRUNCATION_MARKER)
})

test('limits.maxChars overrides the default cap', () => {
  const bytes = Buffer.from('a'.repeat(MAX_TEXT_CHARS + 500), 'utf8')
  const result = extractText({ fileName: 'long.txt', bytes, limits: { maxChars: 100 } })
  assert.equal(result.truncated, true)
  assert.equal(result.text, 'a'.repeat(100) + TRUNCATION_MARKER)
  assert.ok(result.text.endsWith('[…обрезано]'))

  const short = extractText({ fileName: 'short.txt', bytes: Buffer.from('коротко', 'utf8') })
  assert.equal(short.truncated, false)
  assert.equal(short.text, 'коротко')
})

test('extractText never throws on empty or hostile input', () => {
  const inputs = [
    undefined,
    null,
    {},
    { bytes: null },
    { bytes: Buffer.alloc(0) },
    { bytes: new Uint8Array(0) },
    { bytes: 'просто строка' },
    { fileName: 5, bytes: Buffer.from([0x00, 0x01, 0x02]) },
    { bytes: Buffer.from([0xde, 0xad, 0x00, 0xbe, 0xef, 0xff, 0x00]) },
    { fileName: 'a.docx', bytes: Buffer.from('не архив', 'utf8') },
    { fileName: 'a.xlsx', bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]) },
  ]
  for (const input of inputs) {
    let result
    assert.doesNotThrow(() => { result = extractText(input) }, `threw for ${JSON.stringify(input)}`)
    assert.equal(typeof result.kind, 'string')
    assert.equal(typeof result.text, 'string')
    assert.equal(typeof result.truncated, 'boolean')
    assert.equal(typeof result.meta, 'object')
  }
})

test('an empty buffer is unknown with a clear error', () => {
  const result = extractText({ bytes: Buffer.alloc(0) })
  assert.equal(result.kind, 'unknown')
  assert.equal(result.text, '')
  assert.match(result.error, /пуст/i)
  assert.equal(result.meta.bytes, 0)
})

test('binary garbage is unknown with a clear error', () => {
  const result = extractText({ bytes: Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33]) })
  assert.equal(result.kind, 'unknown')
  assert.equal(result.text, '')
  assert.match(result.error, /формат/i)
})

test('legacy OLE2 Office files are refused with an actionable message', () => {
  const bytes = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(16),
  ])
  const result = extractText({ fileName: 'старый.doc', bytes })
  assert.equal(result.kind, 'unknown')
  assert.equal(result.text, '')
  assert.match(result.error, /старый формат/)
})
