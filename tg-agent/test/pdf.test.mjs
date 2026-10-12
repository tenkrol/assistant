/**
 * The PDF writer: Cyrillic really lands in the file, lines stay inside the margins and
 * long text spills onto extra pages.
 *
 * The PDF is read back with small hand-written helpers instead of a parser dependency —
 * the same rule the writer itself follows. Tests that need a real font are skipped when
 * the machine has none, but the structural ones always run.
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import test from 'node:test'
import { createPdf, escapePdfText, findFontPath, wrapLines } from '../src/pdf.mjs'

const fontPath = findFontPath()

const A4_WIDTH = 595.28
const A4_MARGIN = 48
const BODY_SIZE = 11
const LATIN_SAMPLE = 'The quick brown fox jumps over the lazy dog near the river bank today. '
const LONG_WORD = 'ОченьДлинноеСловоБезЕдиногоПробела'.repeat(4)

/** Text of the `/ToUnicode` CMap, decompressed. */
function toUnicodeText(buffer) {
  const latin = buffer.toString('latin1')
  assert.match(latin, /\/ToUnicode \d+ 0 R/, 'в PDF нет ссылки на /ToUnicode')
  const at = latin.indexOf('begincmap')
  assert.ok(at > 0, 'в PDF нет тела CMap')
  const dictAt = latin.lastIndexOf('<<', at)
  const end = latin.indexOf('endobj', at)
  const streamAt = latin.indexOf('stream', dictAt)
  const dictionary = latin.slice(dictAt, streamAt)
  const from = streamAt + 'stream\n'.length
  const to = latin.lastIndexOf('endstream', end)
  const raw = Buffer.from(latin.slice(from, to), 'latin1')
  return /\/Filter\s*\/FlateDecode/.test(dictionary) ? inflateSync(raw).toString('latin1') : raw.toString('latin1')
}

/** Every page content stream, decompressed. */
function contentStreams(buffer) {
  const latin = buffer.toString('latin1')
  const streams = []
  const pattern = /stream\n/g
  let match
  while ((match = pattern.exec(latin)) !== null) {
    const from = match.index + match[0].length
    const to = latin.indexOf('endstream', from)
    if (to < 0) break
    const dictionary = latin.slice(latin.lastIndexOf('<<', match.index), match.index)
    const raw = buffer.subarray(from, to)
    let text
    try {
      text = /\/Filter\s*\/FlateDecode/.test(dictionary) ? inflateSync(raw).toString('latin1') : raw.toString('latin1')
    } catch {
      continue
    }
    // A content stream opens a text object; the CMap and the font file do not.
    if (text.startsWith('BT\n')) streams.push(text)
  }
  return streams
}

/** Text lines of a content stream: the `Td` position and the glyph ids shown there. */
function textLines(stream) {
  const lines = []
  const pattern = /(-?[\d.]+) (-?[\d.]+) Td\n((?:<[\da-fA-F]*> Tj)|(?:\[[^\]]*\] TJ))/g
  let match
  while ((match = pattern.exec(stream)) !== null) {
    const cids = []
    for (const run of match[3].matchAll(/<([\da-fA-F]*)>/g)) {
      for (let at = 0; at + 4 <= run[1].length; at += 4) cids.push(Number.parseInt(run[1].slice(at, at + 4), 16))
    }
    lines.push({ x: Number(match[1]), y: Number(match[2]), cids })
  }
  return lines
}

/** Widths from `/W`, in 1/1000 em, for every glyph the document mentions. */
function glyphWidths(latin) {
  const start = latin.indexOf('/W [')
  assert.ok(start > 0, 'в CIDFont нет массива /W')
  const end = latin.indexOf(']', start)
  const widths = new Map()
  for (const entry of latin.slice(start + 4, end).matchAll(/(\d+) \[(\d+)\]/g)) {
    widths.set(Number(entry[1]), Number(entry[2]))
  }
  return widths
}

/** Build a file and hand back both the bytes and their latin1 view. */
function build(options) {
  const buffer = createPdf({ fontPath, ...options })
  assert.ok(Buffer.isBuffer(buffer), 'createPdf должен вернуть Buffer')
  return { buffer, latin: buffer.toString('latin1') }
}

/** A minimal, table-only TTF: enough for the parser, but carrying no glyph at all. */
function minimalTtf() {
  const makeTable = (tag, body) => {
    const padded = Buffer.alloc((body.length + 3) & ~3)
    body.copy(padded)
    return { tag, entry: Buffer.alloc(16), body: padded, length: body.length }
  }
  const head = Buffer.alloc(54)
  head.writeUInt16BE(1000, 18)
  head.writeInt16BE(0, 50)
  const maxp = Buffer.alloc(6)
  maxp.writeUInt16BE(1, 4)
  const empty = Buffer.alloc(0)
  const tables = [
    makeTable('cmap', empty),
    makeTable('glyf', empty),
    makeTable('head', head),
    makeTable('hhea', Buffer.alloc(36)),
    makeTable('hmtx', empty),
    makeTable('loca', empty),
    makeTable('maxp', maxp),
  ].sort((a, b) => (a.tag < b.tag ? -1 : 1))
  const header = Buffer.alloc(12)
  header.writeUInt32BE(0x00010000, 0)
  header.writeUInt16BE(tables.length, 4)
  const directory = Buffer.concat(tables.map((table) => table.entry))
  let offset = 12 + directory.length
  for (const table of tables) {
    table.entry.write(table.tag, 0, 4, 'latin1')
    table.entry.writeUInt32BE(offset, 8)
    table.entry.writeUInt32BE(table.length, 12)
    offset += table.body.length
  }
  return Buffer.concat([header, directory, ...tables.map((table) => table.body)], offset)
}

test('файл — это Buffer от %PDF- до %%EOF', () => {
  const { buffer, latin } = build({ title: 'Отчёт', blocks: [] })
  assert.ok(Buffer.isBuffer(buffer))
  assert.ok(latin.startsWith('%PDF-'), 'файл должен начинаться с %PDF-')
  assert.ok(latin.trimEnd().endsWith('%%EOF'), 'файл должен заканчиваться %%EOF')
  assert.match(latin, /\/Type \/Catalog/)
  assert.match(latin, /startxref/)
})

test('пустые blocks дают валидный файл с одной страницей', () => {
  const { latin } = build({ blocks: [] })
  assert.equal((latin.match(/\/Type \/Page[^s]/g) ?? []).length, 1, 'ожидалась ровно одна страница')
  assert.match(latin, /\/Count 1\b/)
  assert.ok(latin.trimEnd().endsWith('%%EOF'))
})

test('кириллица попадает в /ToUnicode', { skip: !fontPath && 'нет шрифта' }, () => {
  const { latin } = build({ title: 'Письмо', blocks: [{ type: 'p', text: 'Привет, мир! Проверка кириллицы.' }] })
  const cmap = toUnicodeText(Buffer.from(latin, 'latin1'))
  assert.match(cmap, /begincmap/)
  assert.match(cmap, /beginbfchar/)
  const mapped = new Set(
    [...cmap.matchAll(/<([\da-fA-F]{4})>\s*<([\da-fA-F]{4,6})>/g)].map((entry) => Number.parseInt(entry[2], 16)),
  )
  for (const character of ['П', 'р', 'и', 'в', 'е', 'т']) {
    assert.ok(mapped.has(character.codePointAt(0)), `нет кода для «${character}» в /ToUnicode`)
  }
})

test('шрифт встроен как Type0 / CIDFontType2 с FontFile2', { skip: !fontPath && 'нет шрифта' }, () => {
  const { latin } = build({ blocks: [{ type: 'p', text: 'Встроенный шрифт' }] })
  assert.match(latin, /\/Subtype \/Type0/)
  assert.match(latin, /\/Encoding \/Identity-H/)
  assert.match(latin, /\/Subtype \/CIDFontType2/)
  assert.match(latin, /\/CIDToGIDMap \/Identity/)
  assert.match(latin, /\/FontFile2 \d+ 0 R/)
  assert.match(latin, /\/Flags 32\b/, 'descriptor должен быть nonsymbolic')
  assert.match(latin, /\/DW 1000\b/)
  assert.match(latin, /\/BaseFont/)
})

test('длинный абзац переносится и не вылезает за поля', { skip: !fontPath && 'нет шрифта' }, () => {
  const text = Array.from({ length: 40 }, (_, index) => `Слово${index}`).join(' ')
  const { buffer, latin } = build({ blocks: [{ type: 'p', text }] })
  const lines = contentStreams(buffer).flatMap((stream) => textLines(stream))
  assert.ok(lines.length >= 5, `ожидалось несколько строк, got ${lines.length}`)
  const usable = A4_WIDTH - A4_MARGIN * 2
  const widths = glyphWidths(latin)
  for (const line of lines) {
    const width = line.cids.reduce((sum, cid) => sum + ((widths.get(cid) ?? 1000) * BODY_SIZE) / 1000, 0)
    assert.ok(width <= usable, `строка шире полей: ${width.toFixed(2)} > ${usable}`)
    assert.ok(line.x >= 0 && line.x < usable, `строка начинается вне полей: x=${line.x}`)
  }
})

test('очень длинное слово переносится по буквам', { skip: !fontPath && 'нет шрифта' }, () => {
  const { buffer } = build({ blocks: [{ type: 'p', text: LONG_WORD }] })
  const lines = contentStreams(buffer).flatMap((stream) => textLines(stream))
  assert.ok(lines.length > 1, 'слово без пробелов должно разбиться на несколько строк')
})

test('запасной вариант переноса держится в лимите', () => {
  // The exported helper is exercised on its own, with a measuring function of its own.
  const measure = (value) => value.length
  const lines = wrapLines(`короткое ${LONG_WORD}`, 12, measure)
  assert.ok(lines.length > 1, 'одно длинное слово должно разбиться на несколько строк')
  for (const line of lines) assert.ok(measure(line) <= 12, `строка длиннее лимита: «${line}»`)
})

test('многострочный текст занимает больше одной страницы', { skip: !fontPath && 'нет шрифта' }, () => {
  const { buffer, latin } = build({ blocks: [{ type: 'p', text: LATIN_SAMPLE.repeat(80) }] })
  const pages = (latin.match(/\/Type \/Page[^s]/g) ?? []).length
  assert.ok(pages > 1, `ожидалось больше одной страницы, got ${pages}`)
  const count = Number(/\/Count (\d+)/.exec(latin)?.[1])
  assert.ok(count > 1, `/Count должен быть больше 1, got ${count}`)
  assert.equal(count, pages, '/Count должен совпадать с числом страниц')
  // Every page owns its content stream, so each one can be laid out independently.
  assert.equal(contentStreams(buffer).length, pages)
})

test('спецсимволы ( ) \\ не ломают файл', { skip: !fontPath && 'нет шрифта' }, () => {
  const text = 'Скобки (круглые) и обратный \\ слеш, ещё (одна) пара).'
  const { latin } = build({ title: 'Спец (символы) \\ тест', blocks: [{ type: 'p', text }] })
  assert.ok(latin.startsWith('%PDF-'))
  assert.ok(latin.trimEnd().endsWith('%%EOF'))
  assert.match(latin, /\/ToUnicode/)
  const escaped = escapePdfText(text)
  assert.match(escaped, /\\\(/)
  assert.match(escaped, /\\\)/)
  assert.match(escaped, /\\\\/)
  // The title lives in the Info dictionary as an escaped literal string.
  assert.match(latin.slice(latin.lastIndexOf('/Title')), /\\\(/)
})

test('без шрифта createPdf падает с понятной ошибкой', () => {
  assert.throws(
    () => createPdf({ fontPath: undefined, blocks: [] }),
    /кириллицей; передайте fontPath/,
    'ожидалось сообщение про отсутствующий шрифт с кириллицей',
  )
})

test('нечитаемый файл шрифта даёт понятную ошибку', () => {
  assert.throws(() => createPdf({ fontPath: '/tmp/tg-agent-pdf-broken.ttf', blocks: [] }), /шрифт/i)
})

test('шрифт без глифов не роняет генератор', () => {
  const path = '/tmp/tg-agent-pdf-minimal.ttf'
  writeFileSync(path, minimalTtf())
  const bytes = createPdf({ fontPath: path, blocks: [{ type: 'p', text: 'Привет' }] })
  const latin = bytes.toString('latin1')
  assert.ok(Buffer.isBuffer(bytes))
  assert.ok(latin.startsWith('%PDF-'))
  assert.ok(latin.trimEnd().endsWith('%%EOF'))
  assert.match(latin, /\/ToUnicode/)
})

test('h1, h2, bullet и spacer дают целый документ', { skip: !fontPath && 'нет шрифта' }, () => {
  const blocks = [
    { type: 'h1', text: 'Заголовок первого уровня' },
    { type: 'p', text: 'Первый абзац.\n\nИ второй абзац после пустой строки.' },
    { type: 'h2', text: 'Подзаголовок' },
    { type: 'bullet', text: 'Пункт списка' },
    { type: 'bullet', text: 'Ещё один пункт' },
    { type: 'spacer', height: 24 },
    { type: 'p', text: 'Хвост документа.' },
  ]
  const { buffer, latin } = build({ title: 'Полный документ', blocks })
  assert.match(latin, /\/Title \(/)
  const lines = contentStreams(buffer).flatMap((stream) => textLines(stream))
  assert.ok(lines.length >= 7, `ожидалось не меньше семи строк, got ${lines.length}`)
})
