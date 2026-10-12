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
const A4_HEIGHT = 841.89
const A4_MARGIN = 48
const BODY_SIZE = 11
const LATIN_SAMPLE = 'The quick brown fox jumps over the lazy dog near the river bank today. '
// Long enough that even the real font cannot fit it on one line.
const LONG_WORD = 'ОченьДлинноеСловоБезЕдиногоПробела'.repeat(30)

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

/** Glyph ids inside a `Tj` or `TJ` operand. */
function cidsOf(operand) {
  const cids = []
  for (const run of operand.matchAll(/<([\da-fA-F]*)>/g)) {
    for (let at = 0; at + 4 <= run[1].length; at += 4) cids.push(Number.parseInt(run[1].slice(at, at + 4), 16))
  }
  return cids
}

/**
 * Walk the content stream the way a viewer does.
 *
 * `Td` is relative, so the absolute position only falls out of the sequence of moves —
 * exactly the property that a wrong `Td` would break.
 */
function textLines(stream) {
  const lines = []
  let x = 0
  let y = 0
  let size = 0
  for (const line of stream.split('\n')) {
    const move = /^(-?[\d.]+) (-?[\d.]+) Td$/.exec(line)
    if (move) {
      x += Number(move[1])
      y += Number(move[2])
      continue
    }
    const font = /^\/\w+ ([\d.]+) Tf$/.exec(line)
    if (font) {
      size = Number(font[1])
      continue
    }
    const show = /^(<[\da-fA-F]*> Tj|\[[^\]]*\] TJ)$/.exec(line)
    if (show) lines.push({ x, y, size, cids: cidsOf(show[1]) })
  }
  return lines
}

/** Widths from `/W`, in 1/1000 em, for every glyph the document mentions. */
function glyphWidths(latin) {
  // Anchor on the key: `/CIDToGIDMap /Identity /W [ ... ]` is the CIDFont's own array.
  const key = latin.indexOf('/CIDToGIDMap /Identity /W [')
  assert.ok(key > 0, 'в CIDFont нет массива /W')
  const start = latin.indexOf('/W [', key)
  const end = latin.lastIndexOf(']', latin.indexOf('>>', start))
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
  // `/BaseFont` is a PDF name, so the slash is part of it.
  assert.match(latin, /\/BaseFont \/[A-Za-z]/)
  assert.match(latin, /\/FontName \/[A-Za-z]/)
})

test('строки идут сверху вниз внутри полей страницы', { skip: !fontPath && 'нет шрифта' }, () => {
  // Regression: the coordinates are relative `Td` moves, so a wrong sign or a repeated
  // absolute value used to throw every line off the page or on top of another one.
  const blocks = [
    { type: 'h1', text: 'Заголовок' },
    { type: 'p', text: 'Первый абзац достаточно длинный, чтобы занять две строки целиком.' },
    { type: 'bullet', text: 'Пункт' },
  ]
  const { buffer } = build({ blocks })
  // `textLines` accumulates the relative moves, so these are absolute baselines.
  const drawn = contentStreams(buffer).flatMap((stream) => textLines(stream))
  // One heading, one paragraph line and one bullet — all three must be on the sheet.
  assert.ok(drawn.length >= 3, `ожидалось не меньше трёх строк, got ${drawn.length}`)
  for (const line of drawn) {
    assert.ok(line.y > A4_MARGIN && line.y < A4_HEIGHT - A4_MARGIN, `базовая линия вне полей: y=${line.y.toFixed(2)}`)
  }
  for (let index = 1; index < drawn.length; index += 1) {
    assert.ok(drawn[index].y < drawn[index - 1].y, `строка ${index} не ниже предыдущей: ${drawn[index].y} >= ${drawn[index - 1].y}`)
  }
  // The bullet is indented and the heading is larger than the body text.
  assert.ok(drawn.some((line) => line.x > 0), 'у пункта списка должен быть отступ')
  assert.equal(drawn[0].size > drawn[1].size, true, 'заголовок должен быть крупнее абзаца')
})

test('длинный абзац переносится и не вылезает за поля', { skip: !fontPath && 'нет шрифта' }, () => {
  const text = Array.from({ length: 120 }, (_, index) => `Слово${index}`).join(' ')
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
  // The title goes out as a UTF-16BE hex string, which needs no escaping at all.
  const hex = /^\/Title <FEFF([\dA-Fa-f]+)>/.exec(latin.slice(latin.lastIndexOf('/Title')))
  assert.ok(hex, 'заголовок должен быть записан как UTF-16BE hex-строка')
  assert.equal(Number.parseInt(hex[1].slice(0, 4), 16), 'С'.codePointAt(0), 'заголовок должен начинаться с «С»')
})

test('без шрифта createPdf падает с понятной ошибкой', () => {
  // The candidate list is what says "no font here", so hand over one that cannot exist.
  const candidates = ['/nonexistent/tg-agent/font.ttf']
  assert.equal(findFontPath({ candidates }), undefined)
  assert.throws(
    () => createPdf({ candidates, blocks: [] }),
    /кириллицей; передайте fontPath/,
    'ожидалось сообщение про отсутствующий шрифт с кириллицей',
  )
})

test('нечитаемый файл шрифта даёт понятную ошибку', () => {
  assert.throws(() => createPdf({ fontPath: '/tmp/tg-agent-pdf-broken.ttf', blocks: [] }), /шрифт/i)
})

test('символ без глифа заменяется на ? и не роняет генератор', { skip: !fontPath && 'нет шрифта' }, () => {
  // Private-use code points have no glyph in the usual system fonts.
  const { latin } = build({ blocks: [{ type: 'p', text: `Есть \uE000 и \uF8FF` }] })
  assert.ok(latin.startsWith('%PDF-'))
  assert.ok(latin.trimEnd().endsWith('%%EOF'))
  assert.match(latin, /\/ToUnicode/)
  // The substitute glyph's cid maps to `?`, so the text stays readable when copied.
  assert.match(toUnicodeText(Buffer.from(latin, 'latin1')), /<003f>/)
})

test('обрезанный файл шрифта не роняет процесс', () => {
  // A short file must fail as a readable error, never as an out-of-bounds crash.
  const path = '/tmp/tg-agent-pdf-truncated.ttf'
  writeFileSync(path, Buffer.alloc(64, 7))
  assert.throws(() => createPdf({ fontPath: path, blocks: [] }), /шрифт/i)
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
  assert.match(latin, /\/Title <FEFF/)
  const lines = contentStreams(buffer).flatMap((stream) => textLines(stream))
  // Four one-line blocks, two wrapped paragraphs, the blank line in the second one.
  assert.ok(lines.length >= 5, `ожидалось не меньше пяти строк, got ${lines.length}`)
  // Two heading sizes must appear, or h1/h2 were silently treated as body text.
  const sizes = new Set([...contentStreams(buffer).join('').matchAll(/\/F1 ([\d.]+) Tf/g)].map((entry) => entry[1]))
  assert.ok(sizes.size >= 2, `ожидались разные размеры заголовков, got ${[...sizes].join(', ')}`)
})
