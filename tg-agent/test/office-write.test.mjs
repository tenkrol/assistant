/**
 * Tests for the file writers in `src/office-write.mjs`.
 *
 * The primary check is a round trip through `src/extract.mjs`: the reader that
 * parses attachments from the user must be able to read what the bot produces.
 * That is complemented by two independent validators:
 *
 *   - the ZIP containers are unpacked here with `node:zlib` and inspected part
 *     by part, so a missing relationship or a bad central directory is caught;
 *   - when the bundled Python with `openpyxl`/`python-docx` is present, the
 *     real libraries open the generated files. Their absence skips those tests
 *     instead of failing them.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { inflateRawSync } from 'node:zlib'
import { detectKind, extractText } from '../src/extract.mjs'
import { createCsv, createDocx, createText, createXlsx, pickFormat } from '../src/office-write.mjs'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// ZIP reader for the generated containers
// ---------------------------------------------------------------------------

/** Read a generated archive through its central directory. */
function readZip(buffer) {
  let eocd = buffer.length - 22
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--
  assert.ok(eocd >= 0, 'EOCD record not found')

  const count = buffer.readUInt16LE(eocd + 10)
  const entries = new Map()
  let offset = buffer.readUInt32LE(eocd + 16)

  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'central directory header expected')
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const dosTime = buffer.readUInt16LE(offset + 12)
    const dosDate = buffer.readUInt16LE(offset + 14)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `local header of ${name} expected`)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(start, start + compressedSize)

    entries.set(name, {
      name,
      flags,
      method,
      dosTime,
      dosDate,
      uncompressedSize,
      data: method === 0 ? Buffer.from(raw) : inflateRawSync(raw),
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

const textOf = (entries, name) => {
  const entry = entries.get(name)
  assert.ok(entry, `archive is missing ${name}`)
  return entry.data.toString('utf8')
}

// ---------------------------------------------------------------------------
// Optional Python validators (openpyxl / python-docx)
// ---------------------------------------------------------------------------

const PYTHON = '/Users/andryukovy/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3'

const OPENPYXL_SCRIPT = [
  'import json, sys',
  'from openpyxl import load_workbook',
  'workbook = load_workbook(sys.argv[1])',
  'sheet = workbook[workbook.sheetnames[0]]',
  'rows = [[cell.value for cell in row] for row in sheet.iter_rows()]',
  'types = [[cell.data_type for cell in row] for row in sheet.iter_rows()]',
  'print(json.dumps({"sheets": workbook.sheetnames, "rows": rows, "types": types}, ensure_ascii=False, default=str))',
].join('\n')

const PYTHON_DOCX_SCRIPT = [
  'import json, sys',
  'from docx import Document',
  'document = Document(sys.argv[1])',
  'paragraphs = [{"text": p.text, "style": p.style.name, "bold": [bool(r.bold) for r in p.runs]} for p in document.paragraphs]',
  'tables = [[[cell.text for cell in row.cells] for row in table.rows] for table in document.tables]',
  'print(json.dumps({"paragraphs": paragraphs, "tables": tables}, ensure_ascii=False, default=str))',
].join('\n')

let pythonSupport

/** Check once whether the bundled Python can import both libraries. */
function pythonLibraries() {
  pythonSupport ??= (async () => {
    if (!existsSync(PYTHON)) return { ok: false, reason: `bundled Python not found at ${PYTHON}` }
    try {
      await execFileAsync(PYTHON, ['-c', 'import openpyxl, docx'], { timeout: 30_000 })
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: `openpyxl/python-docx unavailable: ${String(error.message).split('\n')[0]}` }
    }
  })()
  return pythonSupport
}

/** Write `bytes` to a throwaway file, run a Python script on it, parse JSON. */
async function runPython(t, script, fileName, bytes) {
  const directory = mkdtempSync(join(tmpdir(), 'office-write-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, fileName)
  writeFileSync(file, bytes)
  const { stdout } = await execFileAsync(PYTHON, ['-c', script, file], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
  return JSON.parse(stdout)
}

// ---------------------------------------------------------------------------
// Round trip through the attachment reader
// ---------------------------------------------------------------------------

test('XLSX with two sheets round-trips through extractText', () => {
  const bytes = createXlsx({
    sheets: [
      {
        name: 'Данные',
        rows: [
          ['Товар', 'Цена', 'Заметка'],
          ['Хлеб', 42, 'свежий'],
          ['Молоко', 3.5, 'первая\nвторая'],
        ],
      },
      { name: 'Итоги', rows: [['Итого', 45.5]] },
    ],
  })

  assert.ok(Buffer.isBuffer(bytes))
  assert.equal(detectKind({ fileName: 'report.xlsx', bytes }), 'xlsx')

  const result = extractText({ fileName: 'report.xlsx', bytes })
  assert.equal(result.error, undefined)
  assert.equal(result.truncated, false)
  assert.deepEqual(result.meta.sheets, ['Данные', 'Итоги'])
  assert.equal(result.meta.sheetCount, 2)
  assert.equal(result.meta.rows, 4)
  assert.match(result.text, /--- Лист: Данные ---/)
  assert.match(result.text, /Товар\tЦена\tЗаметка/)
  assert.match(result.text, /Хлеб\t42\tсвежий/)
  assert.match(result.text, /Молоко\t3\.5\tпервая вторая/)
  assert.match(result.text, /--- Лист: Итоги ---/)
  assert.match(result.text, /Итого\t45\.5/)
  assert.ok(result.text.indexOf('--- Лист: Данные ---') < result.text.indexOf('--- Лист: Итоги ---'))
})

test('DOCX with title, paragraphs, bold and a table round-trips through extractText', () => {
  const bytes = createDocx({
    title: 'Отчёт за месяц',
    paragraphs: [
      'Обычный абзац',
      '## Подзаголовок',
      'Жирный **текст** и обычный',
      'Первая строка\nвторая строка',
    ],
    table: {
      header: ['Показатель', 'Значение'],
      rows: [['Продажи', '100'], ['Возвраты', '5']],
    },
  })

  assert.equal(detectKind({ fileName: 'письмо.docx', bytes }), 'docx')

  const result = extractText({ fileName: 'письмо.docx', bytes })
  assert.equal(result.error, undefined)
  assert.match(result.text, /Отчёт за месяц\nОбычный абзац\nПодзаголовок/)
  assert.match(result.text, /Жирный текст и обычный/)
  assert.match(result.text, /Первая строка\nвторая строка/)
  assert.match(result.text, /Показатель\tЗначение/)
  assert.match(result.text, /Продажи\t100/)
  assert.match(result.text, /Возвраты\t5/)
  assert.equal(result.meta.tables, 1)
  assert.ok(result.text.indexOf('Показатель') < result.text.indexOf('Продажи'))
})

test('XLSX keeps line breaks and preserves them for the spreadsheet reader', () => {
  const bytes = createXlsx({ sheets: [{ name: 'S', rows: [['первая\nвторая']] }] })
  const shared = textOf(readZip(bytes), 'xl/sharedStrings.xml')
  assert.match(shared, /xml:space="preserve"/)
  assert.match(shared, /<t xml:space="preserve">первая\nвторая<\/t>/)

  const result = extractText({ fileName: 'a.xlsx', bytes })
  assert.equal(result.error, undefined)
  assert.match(result.text, /первая вторая/)
})

// ---------------------------------------------------------------------------
// Real libraries, when the bundled Python provides them
// ---------------------------------------------------------------------------

test('openpyxl opens the generated XLSX and reads the same values', async (t) => {
  const support = await pythonLibraries()
  if (!support.ok) {
    t.skip(support.reason)
    return
  }

  const bytes = createXlsx({
    sheets: [
      {
        name: 'Данные',
        rows: [
          ['Товар', 'Цена', 'Заметка'],
          ['Хлеб', 42, 'первая\nвторая'],
          ['Молоко', 3.5, null],
        ],
      },
      { name: 'Итоги', rows: [['Итого', 45.5]] },
    ],
  })

  const report = await runPython(t, OPENPYXL_SCRIPT, 'report.xlsx', bytes)
  assert.deepEqual(report.sheets, ['Данные', 'Итоги'])
  assert.deepEqual(report.rows[0], ['Товар', 'Цена', 'Заметка'])
  assert.deepEqual(report.rows[1], ['Хлеб', 42, 'первая\nвторая'])
  assert.deepEqual(report.rows[2], ['Молоко', 3.5, null])
  assert.equal(report.types[0][0], 's', 'a text cell must be a shared string')
  assert.equal(report.types[1][1], 'n', 'a number cell must stay numeric')
})

test('python-docx opens the generated DOCX and sees styles, bold and the table', async (t) => {
  const support = await pythonLibraries()
  if (!support.ok) {
    t.skip(support.reason)
    return
  }

  const bytes = createDocx({
    title: 'Отчёт за месяц',
    paragraphs: ['Обычный абзац', '## Подзаголовок', 'Жирный **текст** и обычный', 'Первая\nвторая'],
    table: { header: ['Показатель', 'Значение'], rows: [['Продажи', '100']] },
  })

  const report = await runPython(t, PYTHON_DOCX_SCRIPT, 'report.docx', bytes)
  const texts = report.paragraphs.map((paragraph) => paragraph.text)
  assert.deepEqual(texts.slice(0, 5), [
    'Отчёт за месяц',
    'Обычный абзац',
    'Подзаголовок',
    'Жирный текст и обычный',
    'Первая\nвторая',
  ])
  assert.equal(report.paragraphs[0].style, 'Heading 1')
  assert.equal(report.paragraphs[1].style, 'Normal')
  assert.equal(report.paragraphs[2].style, 'Heading 2')
  assert.deepEqual(report.paragraphs[3].bold, [false, true, false])
  assert.deepEqual(report.tables, [[['Показатель', 'Значение'], ['Продажи', '100']]])
})

// ---------------------------------------------------------------------------
// Package structure
// ---------------------------------------------------------------------------

test('the XLSX package holds every part a spreadsheet needs', () => {
  const entries = readZip(createXlsx({ sheets: [{ name: 'S', rows: [[1]] }] }))
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/sharedStrings.xml']) {
    assert.ok(entries.has(name), `missing ${name}`)
  }
  assert.ok([...entries.keys()].some((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)), 'no worksheet part')
  for (const entry of entries.values()) {
    assert.equal(entry.flags & 0x0800, 0x0800, `${entry.name} must carry the UTF-8 name flag`)
    assert.equal(entry.method, 8, `${entry.name} must be deflated`)
    assert.equal(entry.data.length, entry.uncompressedSize, `${entry.name} has a wrong size`)
  }
  assert.match(textOf(entries, 'xl/workbook.xml'), /<sheet name="S" sheetId="1" r:id="rId1"\/>/)
  assert.match(textOf(entries, 'xl/_rels/workbook.xml.rels'), /Target="worksheets\/sheet1\.xml"/)
})

test('the DOCX package holds every part a document needs', () => {
  const entries = readZip(createDocx({ paragraphs: ['x'] }))
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml']) {
    assert.ok(entries.has(name), `missing ${name}`)
  }
  const documentXml = textOf(entries, 'word/document.xml')
  assert.match(documentXml, /^<\?xml version="1\.0" encoding="UTF-8" standalone="yes"\?>\n/)
  assert.match(documentXml, /<w:document xmlns:w="http:\/\/schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main">/)
  assert.match(documentXml, /<w:body>/)
  assert.match(documentXml, /<w:sectPr>/)
  assert.match(textOf(entries, '_rels/.rels'), /Target="word\/document\.xml"/)
})

test('generated bytes are deterministic and the ZIP date is a fixed 1980 stamp', () => {
  const spec = { sheets: [{ name: 'S', rows: [['a', 1, true]] }] }
  assert.deepEqual(createXlsx(spec), createXlsx(spec))
  assert.deepEqual(createDocx({ title: 't', paragraphs: ['a'] }), createDocx({ title: 't', paragraphs: ['a'] }))
  assert.deepEqual(createCsv({ rows: [['a', 1]] }), createCsv({ rows: [['a', 1]] }))

  const entry = readZip(createXlsx(spec)).get('xl/workbook.xml')
  assert.equal(entry.dosDate, 0x21, 'default stamp is 1980-01-01')
  assert.equal(entry.dosTime, 0, 'default stamp is 00:00:00')

  const dated = readZip(createXlsx({ ...spec, date: new Date(2024, 0, 2, 3, 4, 5) })).get('xl/workbook.xml')
  assert.equal(((dated.dosDate >> 9) & 0x7f) + 1980, 2024)
  assert.equal((dated.dosDate >> 5) & 0x0f, 1)
  assert.equal(dated.dosDate & 0x1f, 2)
  assert.equal(dated.dosTime >> 11, 3)
})

// ---------------------------------------------------------------------------
// CSV and plain text
// ---------------------------------------------------------------------------

test('CSV is BOM-prefixed and quotes delimiters, quotes and newlines', () => {
  const bytes = createCsv({
    rows: [
      ['имя', 'значение', 'комментарий'],
      ['Иванов, И.', 'сказал "привет"', 'первая\nвторая'],
    ],
  })
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  const text = bytes.subarray(3).toString('utf8')
  assert.equal(
    text,
    'имя,значение,комментарий\r\n"Иванов, И.","сказал ""привет""","первая\nвторая"\r\n',
  )

  const result = extractText({ fileName: 'люди.csv', bytes })
  assert.equal(result.error, undefined)
  assert.equal(result.meta.rows, 2)
  assert.equal(result.meta.columns, 3)
  assert.match(result.text, /Иванов, И\.\tсказал "привет"\tпервая вторая/)
})

test('CSV delimiter is configurable and semicolon text is not quoted', () => {
  const bytes = createCsv({ rows: [['a', 'b'], ['1', '2']], delimiter: ';' })
  assert.equal(bytes.subarray(3).toString('utf8'), 'a;b\r\n1;2\r\n')

  const tabbed = createCsv({ rows: [['a', 'b']], delimiter: '\t' })
  assert.equal(tabbed.subarray(3).toString('utf8'), 'a\tb\r\n')

  // A comma is plain data when the delimiter is a semicolon.
  const data = createCsv({ rows: [['Иванов, И.', 'x', 'y']], delimiter: ';' })
  assert.equal(data.subarray(3).toString('utf8'), 'Иванов, И.;x;y\r\n')
  const reread = extractText({ fileName: 'a.csv', bytes: data })
  assert.equal(reread.meta.delimiter, ';')
  assert.match(reread.text, /Иванов, И\.\tx\ty/)
})

test('createText adds a BOM for .txt and omits it for .md', () => {
  const plain = createText({ text: 'привет', fileName: 'заметки.txt' })
  assert.deepEqual([...plain.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  assert.equal(plain.subarray(3).toString('utf8'), 'привет')
  assert.equal(extractText({ fileName: 'заметки.txt', bytes: plain }).text, 'привет')

  const markdown = createText({ text: '# Заголовок', fileName: 'README.md' })
  assert.equal(markdown.toString('utf8'), '# Заголовок')

  // No file name at all: plain text, so the BOM stays.
  assert.deepEqual([...createText({ text: 'x' }).subarray(0, 3)], [0xef, 0xbb, 0xbf])
  assert.equal(createText({ text: 'x', bom: false }).toString('utf8'), 'x')
  assert.deepEqual([...createText({ text: 'x', fileName: 'a.MD' }).subarray(0, 1)], [0x78], 'extension case is ignored')
})

// ---------------------------------------------------------------------------
// Escaping and edge cases
// ---------------------------------------------------------------------------

test('XML metacharacters and Cyrillic survive both writers', () => {
  const value = 'ООО «Ромашка» & <партнёр> "кавычки" \'апостроф\''

  const xlsx = createXlsx({ sheets: [{ name: 'A&B <тест>', rows: [[value]] }] })
  const shared = textOf(readZip(xlsx), 'xl/sharedStrings.xml')
  assert.match(shared, /&amp;/)
  assert.match(shared, /&lt;партнёр&gt;/)
  assert.doesNotMatch(shared, /<партнёр>/)
  const fromXlsx = extractText({ fileName: 'a.xlsx', bytes: xlsx })
  assert.equal(fromXlsx.error, undefined)
  assert.deepEqual(fromXlsx.meta.sheets, ['A&B <тест>'])
  assert.ok(fromXlsx.text.includes(value), fromXlsx.text)

  const docx = createDocx({ title: 'A & B', paragraphs: [value], table: { header: ['<h>'], rows: [['&']] } })
  const documentXml = textOf(readZip(docx), 'word/document.xml')
  assert.match(documentXml, /&lt;партнёр&gt;/)
  assert.doesNotMatch(documentXml, /<w:t xml:space="preserve"><партнёр>/)
  const fromDocx = extractText({ fileName: 'a.docx', bytes: docx })
  assert.equal(fromDocx.error, undefined)
  assert.match(fromDocx.text, /A & B/)
  assert.ok(fromDocx.text.includes(value), fromDocx.text)
  assert.match(fromDocx.text, /<h>\n&/)
})

test('sheet names are sanitised, truncated to 31 chars and kept unique', () => {
  const long = 'Очень длинное имя листа которое заведомо превышает лимит'
  const bytes = createXlsx({
    sheets: [
      { name: 'Данные[1]:итог?/*', rows: [['first']] },
      { name: long, rows: [['second']] },
      { name: 'Данные[1]:итог?/*', rows: [['third']] },
      { name: "'", rows: [['fourth']] },
      { name: '', rows: [['fifth']] },
    ],
  })

  const result = extractText({ fileName: 'a.xlsx', bytes })
  assert.equal(result.error, undefined)
  assert.equal(result.meta.sheetCount, 5)
  assert.deepEqual(result.meta.sheets, [
    'Данные 1 итог',
    long.slice(0, 31).trim(),
    'Данные 1 итог (2)',
    'Лист4',
    'Лист5',
  ])
  for (const name of result.meta.sheets) {
    assert.ok(name.length > 0 && name.length <= 31, `bad length: ${JSON.stringify(name)}`)
    assert.doesNotMatch(name, /[\\/?*\[\]:]/)
  }

  // The forbidden characters never reach the workbook part.
  const workbook = textOf(readZip(bytes), 'xl/workbook.xml')
  assert.deepEqual(
    [...workbook.matchAll(/<sheet name="([^"]*)"/g)].map((match) => match[1]),
    ['Данные 1 итог', long.slice(0, 31).trim(), 'Данные 1 итог (2)', 'Лист4', 'Лист5'],
  )
})

test('empty input still produces valid, openable packages', () => {
  const xlsx = createXlsx({})
  const workbookEntries = readZip(xlsx)
  assert.ok(workbookEntries.has('xl/worksheets/sheet1.xml'))
  const fromXlsx = extractText({ fileName: 'empty.xlsx', bytes: xlsx })
  assert.equal(fromXlsx.error, undefined)
  assert.deepEqual(fromXlsx.meta.sheets, ['Лист1'])
  assert.equal(fromXlsx.meta.sheetCount, 1)

  // No sheets, empty sheets, empty rows, empty cells and gaps.
  const sparse = createXlsx({ sheets: [{ name: 'X', rows: [[], [null, undefined, '']] }, { rows: [['только']] }] })
  const fromSparse = extractText({ fileName: 'sparse.xlsx', bytes: sparse })
  assert.equal(fromSparse.error, undefined)
  assert.equal(fromSparse.meta.sheetCount, 2)
  assert.deepEqual(fromSparse.meta.sheets, ['X', 'Лист2'])
  assert.match(fromSparse.text, /только/)

  const docx = createDocx({})
  assert.ok(readZip(docx).has('word/document.xml'))
  assert.equal(extractText({ fileName: 'empty.docx', bytes: docx }).error, undefined)
  assert.equal(extractText({ fileName: 'no-args.docx', bytes: createDocx() }).error, undefined)
  assert.equal(extractText({ fileName: 'null-docx.docx', bytes: createDocx({ title: '', paragraphs: [], table: null }) }).error, undefined)

  assert.equal(createCsv({ rows: [] }).toString('utf8'), '\uFEFF')
  assert.equal(createCsv().toString('utf8'), '\uFEFF')
  assert.equal(createText({}).toString('utf8'), '\uFEFF')
  assert.ok(Buffer.isBuffer(createXlsx({ sheets: null })))
})

test('a header-only or empty table does not break the document', () => {
  const noRows = extractText({ fileName: 'a.docx', bytes: createDocx({ table: { header: ['A', 'B'] } }) })
  assert.equal(noRows.error, undefined)
  assert.match(noRows.text, /A\tB/)

  const noHeader = extractText({ fileName: 'b.docx', bytes: createDocx({ table: { rows: [['1', '2']] } }) })
  assert.equal(noHeader.error, undefined)
  assert.match(noHeader.text, /1\t2/)

  const empty = extractText({ fileName: 'c.docx', bytes: createDocx({ table: { header: [], rows: [] } }) })
  assert.equal(empty.error, undefined)
  assert.doesNotMatch(textOf(readZip(createDocx({ table: { header: [], rows: [] } })), 'word/document.xml'), /<w:tbl>/)
})

test('pickFormat maps extensions, case-insensitively', () => {
  assert.equal(pickFormat('report.xlsx'), 'xlsx')
  assert.equal(pickFormat('REPORT.XLSX'), 'xlsx')
  assert.equal(pickFormat('отчёт.xlsm'), 'xlsx')
  assert.equal(pickFormat('письмо.docx'), 'docx')
  assert.equal(pickFormat('ПИСЬМО.DOCX'), 'docx')
  assert.equal(pickFormat('data.csv'), 'csv')
  assert.equal(pickFormat('data.TSV'), 'csv')
  assert.equal(pickFormat('заметки.md'), 'md')
  assert.equal(pickFormat('guide.markdown'), 'md')
  assert.equal(pickFormat('readme.txt'), 'txt')
  assert.equal(pickFormat('/tmp/some dir/файл.txt'), 'txt')
  assert.equal(pickFormat('archive.zip'), undefined)
  assert.equal(pickFormat('без-расширения'), undefined)
  assert.equal(pickFormat(''), undefined)
  assert.equal(pickFormat('   '), undefined)
  assert.equal(pickFormat(undefined), undefined)
  assert.equal(pickFormat(null), undefined)
  assert.equal(pickFormat(42), undefined)
})
