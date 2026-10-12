/**
 * A minimal PDF writer with Cyrillic support, built on the standard library alone.
 *
 * The built-in PDF fonts (Helvetica and friends) carry no Cyrillic, so the only honest
 * way to print Russian text is to embed a TrueType font: the glyphs go into the file as
 * `/FontFile2`, the text is addressed by glyph id (`/Encoding /Identity-H`) and a
 * `/ToUnicode` CMap keeps the result copyable and searchable.
 *
 * Everything here is deliberately small: enough of `head`, `hhea`, `hmtx`, `cmap`,
 * `OS/2`, `loca` and `glyf` to embed a font, and enough PDF to lay text out over pages.
 * `src/file-tool.mjs` owns the user-facing contract; this module only builds bytes.
 */
import { readFileSync, statSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

/** Fonts worth trying on a Linux server, then on macOS. */
const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/Library/Fonts/Arial Unicode.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
]

/** The error a caller sees when there is no font to print Cyrillic with. */
const NO_FONT_MESSAGE = 'PDF: не найден шрифт с кириллицей; передайте fontPath'

/** Page sizes in points. */
const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
  legal: [612, 1008],
}

/** Emitted when the named glyph cannot be found in the font. */
const FALLBACK_CHAR = '?'

/** Points per em for the CID widths in `/W` (a 1000-unit font is assumed, as usual). */
const FONT_UNITS_PER_EM = 1000

/** Glyphs per line in the `/W` array, only to keep the file readable. */
const WIDTHS_PER_LINE = 1000

/** Point size of a heading relative to the body size. */
const H1_SCALE = 1.6
const H2_SCALE = 1.3

/** Baseline distance, as a multiple of the point size, for body text and headings. */
const BODY_LEADING = 1.45
const HEADING_LEADING = 1.3

/** Blank space around a block, as a multiple of the body point size. */
const H1_SPACE_BEFORE = 0.9
const H2_SPACE_BEFORE = 0.6
const HEADING_SPACE_AFTER = 0.55
const BODY_SPACE_AFTER = 0.45
const BULLET_SPACE_AFTER = 0.2

/** Indent of a bullet line. */
const BULLET_INDENT = 14

/** Extra canvas when a content buffer grows. */
const CONTENT_SLACK = 4096

/** Tables that hinting and layout machinery use; a viewer does not need them. */
const DROPPED_ON_EMBED = new Set(['DSIG', 'cvt ', 'fpgm', 'prep', 'gasp', 'hdmx', 'LTSH', 'VDMX', 'kern'])

/** Largest value of each integer width, so a writer can mask without knowing internals. */
const U16_MAX = 65535
const U32_MAX = 4294967295

const u16 = (value) => value & U16_MAX
// `& 0xffffffff` keeps the sign in JavaScript, so shift the bits back into range.
const u32 = (value) => (value & U32_MAX) >>> 0

/** Round up to a multiple of four, as the sfnt format wants. */
const align4 = (value) => (value + 3) & ~3

/**
 * Find the first font file that exists.
 *
 * @param {{candidates?: Array<string>}} [options] - paths to try, defaults to the usual suspects.
 * @returns {string|undefined} the path, or `undefined` when nothing is installed.
 */
export function findFontPath({ candidates } = {}) {
  const list = Array.isArray(candidates) && candidates.length > 0 ? candidates : FONT_CANDIDATES
  for (const path of list) {
    if (typeof path !== 'string' || path === '') continue
    try {
      if (statSync(path).isFile()) return path
    } catch {
      // Not installed — the normal case for most candidates.
    }
  }
  return undefined
}

/** A growable byte sink; buffers are cheaper and more predictable than string concat. */
function createWriter(capacity = 4096) {
  let buffer = Buffer.allocUnsafe(capacity)
  let length = 0
  return {
    get length() {
      return length
    },
    write(bytes) {
      let chunk
      if (typeof bytes === 'string') chunk = Buffer.from(bytes, 'latin1')
      else if (Buffer.isBuffer(bytes)) chunk = bytes
      else throw new Error('PDF: в поток можно писать только строки и буферы')
      if (length + chunk.length > buffer.length) {
        const size = Math.max(buffer.length * 2, length + chunk.length + CONTENT_SLACK)
        const grown = Buffer.allocUnsafe(size)
        buffer.copy(grown, 0, 0, length)
        buffer = grown
      }
      chunk.copy(buffer, length)
      length += chunk.length
      return this
    },
    toBuffer() {
      return buffer.subarray(0, length)
    },
  }
}

/** Read a font table, or `undefined` when the tag is absent or the range is broken. */
function readTable(font, tables, tag) {
  const entry = tables.get(tag)
  if (!entry) return undefined
  const from = entry.offset
  const to = from + entry.length
  if (from < 0 || to > font.length || entry.length <= 0) return undefined
  return font.subarray(from, to)
}

/** `head`: units per em, bounding box and the format of `loca`. */
function parseHead(view, table) {
  return {
    unitsPerEm: view.getUint16(table.byteOffset + 18, false),
    yMin: view.getInt16(table.byteOffset + 38, false),
    yMax: view.getInt16(table.byteOffset + 42, false),
    indexToLocFormat: view.getInt16(table.byteOffset + 50, false),
  }
}

/** `hhea`: ascent, descent and how many glyphs live in `hmtx`. */
function parseHhea(view, table) {
  return {
    ascender: view.getInt16(table.byteOffset + 4, false),
    descender: view.getInt16(table.byteOffset + 6, false),
    numberOfHMetrics: view.getUint16(table.byteOffset + 34, false),
  }
}

/** `maxp`: the glyph count, used to sanity-check `loca`. */
function parseMaxp(view, table) {
  return { numGlyphs: view.getUint16(table.byteOffset + 4, false) }
}

/** `OS/2`: typographic metrics and the embedding permission in `fsType`. */
function parseOs2(view, table) {
  if (table.length < 78) return { version: 0, fsType: 0, typoAscender: 0, typoDescender: 0, capHeight: 0 }
  const version = view.getUint16(table.byteOffset, false)
  return {
    version,
    fsType: view.getUint16(table.byteOffset + 8, false),
    typoAscender: view.getInt16(table.byteOffset + 68, false),
    typoDescender: view.getInt16(table.byteOffset + 70, false),
    // sCapHeight only exists from version 2 on; older tables end before it.
    capHeight: version >= 2 && table.length >= 90 ? view.getInt16(table.byteOffset + 88, false) : 0,
  }
}

/** One `cmap` subtable as a `Map` from code point to glyph id. */
function parseCmapSubtable(font, view, offset, format) {
  const map = new Map()
  if (format === 4) {
    const segCountX2 = view.getUint16(offset + 6, false)
    const segCount = segCountX2 >> 1
    const endAt = offset + 14
    const startAt = endAt + segCountX2 + 2
    const deltaAt = startAt + segCountX2
    const rangeAt = deltaAt + segCountX2
    for (let segment = 0; segment < segCount; segment += 1) {
      const end = view.getUint16(endAt + segment * 2, false)
      const start = view.getUint16(startAt + segment * 2, false)
      if (start > end || end === 0xffff) continue
      const delta = view.getInt16(deltaAt + segment * 2, false)
      const rangeOffset = view.getUint16(rangeAt + segment * 2, false)
      for (let code = start; code <= end; code += 1) {
        let gid
        if (rangeOffset === 0) {
          gid = u16(code + delta)
        } else {
          const at = rangeAt + segment * 2 + rangeOffset + (code - start) * 2
          if (at + 2 > font.length) continue
          gid = view.getUint16(at, false)
          if (gid !== 0) gid = u16(gid + delta)
        }
        if (gid !== 0) map.set(code, gid)
      }
    }
    return map
  }
  if (format === 12) {
    const groups = view.getUint32(offset + 12, false)
    for (let group = 0; group < groups; group += 1) {
      const at = offset + 16 + group * 12
      if (at + 12 > font.length) break
      const start = view.getUint32(at, false)
      const end = view.getUint32(at + 4, false)
      const startGid = view.getUint32(at + 8, false)
      // A malformed group would otherwise ask for millions of entries.
      if (end < start || end - start > 0x10ffff) continue
      for (let code = start; code <= end; code += 1) map.set(code, u32(startGid + (code - start)))
    }
    return map
  }
  return map
}

/** Pick the best `cmap` subtable: Windows full Unicode, then BMP, then legacy Unicode. */
function parseCmap(font, view, table) {
  const count = view.getUint16(table.byteOffset + 2, false)
  const formats = new Map()
  const wanted = new Set([4, 12])
  for (let index = 0; index < count; index += 1) {
    const record = table.byteOffset + 4 + index * 8
    const platform = view.getUint16(record, false)
    const encoding = view.getUint16(record + 2, false)
    const offset = table.byteOffset + view.getUint32(record + 4, false)
    if (offset + 2 > font.length) continue
    const format = view.getUint16(offset, false)
    if (!wanted.has(format)) continue
    // 3/10 is the full Unicode range, 3/1 the BMP, 0/* the legacy Unicode platform.
    const score = platform === 3 && encoding === 10 ? 4 : platform === 0 && format === 12 ? 3 : platform === 3 && encoding === 1 ? 2 : 1
    const previous = formats.get(format)
    if (!previous || score > previous.score) formats.set(format, { offset, format, score })
  }
  const chosen = formats.get(12) ?? formats.get(4)
  if (!chosen) throw new Error('cmap: нет таблицы формата 4 или 12')
  return parseCmapSubtable(font, view, chosen.offset, chosen.format)
}

/** `loca` plus `glyf`: the byte range of every glyph, ready to be embedded unchanged. */
function parseGlyphs(view, loca, glyf, numGlyphs) {
  const offsets = new Uint32Array(numGlyphs + 1)
  const lengths = new Uint32Array(numGlyphs)
  const short = loca.length < (numGlyphs + 1) * 4
  const step = short ? 2 : 4
  for (let index = 0; index <= numGlyphs; index += 1) {
    const at = index * step
    if (at + step > loca.length) {
      offsets[index] = glyf.length
      continue
    }
    offsets[index] = short ? view.getUint16(loca.byteOffset + at, false) * 2 : view.getUint32(loca.byteOffset + at, false)
  }
  for (let gid = 0; gid < numGlyphs; gid += 1) {
    const from = Math.min(offsets[gid], glyf.length)
    const to = Math.min(Math.max(offsets[gid + 1], from), glyf.length)
    offsets[gid] = from
    lengths[gid] = to - from
  }
  offsets[numGlyphs] = glyf.length
  return { offsets, lengths, glyf }
}

/** Sum of the big-endian 32-bit words of a table, with zero padding. */
function tableChecksum(data) {
  let sum = 0
  for (let at = 0; at < data.length; at += 4) sum = u32(sum + data.readUInt32BE(at))
  return u32(sum)
}

/**
 * Rebuild the font as a standalone sfnt: the tables we kept, with fresh checksums.
 *
 * The embedded font is a whole font, not a subset, so the glyph ids used by the content
 * stream stay valid in the copy a viewer reads. Hinting tables are dropped because their
 * programs would reference a `glyf` table that is no longer byte-identical — a viewer
 * does not need them.
 */
function buildFontFile(keptTables, glyphs, indexToLocFormat) {
  const kept = new Map()
  for (const [tag, bytes] of keptTables) {
    if (bytes.length > 0) kept.set(tag, bytes)
  }
  kept.set('glyf', glyphs.glyf)
  kept.set('loca', Buffer.alloc((glyphs.lengths.length + 1) * (indexToLocFormat === 0 ? 2 : 4)))
  const tags = [...kept.keys()].sort()
  const numTables = tags.length
  const entrySelector = Math.max(0, Math.floor(Math.log2(numTables)))
  const searchRange = 16 * 2 ** entrySelector
  const header = Buffer.alloc(12)
  header.writeUInt32BE(0x00010000, 0)
  header.writeUInt16BE(numTables, 4)
  header.writeUInt16BE(searchRange, 6)
  header.writeUInt16BE(entrySelector, 8)
  header.writeUInt16BE(numTables * 16 - searchRange, 10)
  const directory = Buffer.alloc(numTables * 16)
  const chunks = []
  let offset = 12 + numTables * 16
  tags.forEach((tag, index) => {
    const source = kept.get(tag)
    const padded = align4(source.length)
    const data = Buffer.alloc(padded)
    source.copy(data, 0, 0, source.length)
    if (tag === 'loca') {
      // The per-glyph ranges are already computed, so rewrite `loca` from them.
      glyphs.offsets.forEach((value, gid) => {
        if (indexToLocFormat === 0) data.writeUInt16BE(value >> 1, gid * 2)
        else data.writeUInt32BE(value, gid * 4)
      })
    }
    const at = index * 16
    directory.write(tag, at, 4, 'latin1')
    directory.writeUInt32BE(tableChecksum(data), at + 4)
    directory.writeUInt32BE(offset, at + 8)
    directory.writeUInt32BE(source.length, at + 12)
    chunks.push(data)
    offset += padded
  })
  const file = Buffer.concat([header, directory, ...chunks], offset)
  // `head.checkSumAdjustment` covers the whole file, so it is patched once at the end.
  const headAt = file.readUInt32BE(12 + tags.indexOf('head') * 16 + 8)
  file.writeUInt32BE(0, headAt + 8)
  file.writeUInt32BE(u32(0xb1b0afba - tableChecksum(file)), headAt + 8)
  return file
}

/**
 * Read a TrueType font (a `.ttf`, or the first face of a `.ttc`).
 *
 * @param {string} fontPath - the file to read.
 * @returns {object} metrics, glyph ranges, the kept raw tables and the embeddable bytes.
 */
function parseTtf(fontPath) {
  const font = readFileSync(fontPath)
  if (font.length < 12) throw new Error('файл короче заголовка sfnt')
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength)
  let sfnt = 0
  if (view.getUint32(0, false) === 0x74746366) {
    // A `.ttc` is a collection: take the first face and use its table directory.
    if (font.length < 16) throw new Error('оборванный заголовок ttc')
    const faces = view.getUint32(8, false)
    if (faces < 1) throw new Error('ttc без шрифтов')
    sfnt = view.getUint32(12, false)
    if (sfnt + 12 > font.length) throw new Error('ttc: смещение первого шрифта за пределами файла')
  }
  const numTables = view.getUint16(sfnt + 4, false)
  const tables = new Map()
  for (let index = 0; index < numTables; index += 1) {
    const at = sfnt + 12 + index * 16
    if (at + 16 > font.length) break
    tables.set(font.toString('latin1', at, at + 4), {
      offset: view.getUint32(at + 8, false),
      length: view.getUint32(at + 12, false),
    })
  }
  const headBytes = readTable(font, tables, 'head')
  const hheaBytes = readTable(font, tables, 'hhea')
  const maxpBytes = readTable(font, tables, 'maxp')
  const hmtxBytes = readTable(font, tables, 'hmtx')
  const cmapBytes = readTable(font, tables, 'cmap')
  const locaBytes = readTable(font, tables, 'loca')
  const glyfBytes = readTable(font, tables, 'glyf')
  const os2Bytes = readTable(font, tables, 'OS/2')
  if (!headBytes || !hheaBytes || !maxpBytes || !hmtxBytes || !cmapBytes || !locaBytes || !glyfBytes) {
    throw new Error('нет обязательных таблиц head/hhea/maxp/hmtx/cmap/loca/glyf')
  }
  const head = parseHead(view, headBytes)
  const hhea = parseHhea(view, hheaBytes)
  const { numGlyphs } = parseMaxp(view, maxpBytes)
  const os2 = os2Bytes ? parseOs2(view, os2Bytes) : { version: 0, fsType: 0, typoAscender: 0, typoDescender: 0, capHeight: 0 }
  const unitsPerEm = head.unitsPerEm > 0 ? head.unitsPerEm : FONT_UNITS_PER_EM
  const metricCount = hhea.numberOfHMetrics > 0 ? Math.min(hhea.numberOfHMetrics, numGlyphs) : 1
  const advances = new Uint16Array(numGlyphs)
  for (let gid = 0; gid < numGlyphs; gid += 1) {
    const at = (gid < metricCount ? gid : metricCount - 1) * 4
    if (at + 2 > hmtxBytes.length) break
    advances[gid] = view.getUint16(hmtxBytes.byteOffset + at, false)
  }
  const kept = new Map()
  for (const tag of tables.keys()) {
    if (DROPPED_ON_EMBED.has(tag) || tag === 'loca') continue
    const bytes = readTable(font, tables, tag)
    if (bytes) kept.set(tag, bytes)
  }
  const glyphs = parseGlyphs(view, locaBytes, glyfBytes, numGlyphs)
  return {
    path: fontPath,
    codeToGlyph: parseCmap(font, view, cmapBytes),
    unitsPerEm,
    advances,
    numGlyphs,
    ascender: hhea.ascender,
    descender: hhea.descender,
    yMin: head.yMin,
    yMax: head.yMax,
    os2,
    embed: buildFontFile(kept, glyphs, head.indexToLocFormat),
  }
}

/** Parsed fonts are cached: reading a 23 MB file twice would be rude. */
const fontCache = new Map()

/** Parse a font once per process. */
function loadFont(fontPath) {
  const cached = fontCache.get(fontPath)
  if (cached) return cached
  let font
  try {
    font = parseTtf(fontPath)
  } catch (error) {
    throw new Error(`PDF: не удалось прочитать шрифт ${fontPath} (${error?.message ?? error})`)
  }
  fontCache.set(fontPath, font)
  return font
}

/** Font units to PDF text space (a 1000-unit em), the convention `/W` expects. */
const toPdfWidth = (units, unitsPerEm) => (units * FONT_UNITS_PER_EM) / unitsPerEm

/** A PDF stream object: dictionary entries plus a (optionally compressed) payload. */
function streamObject(dict, payload, compress = false) {
  const body = compress ? deflateSync(payload) : payload
  const head = Buffer.from(`<< ${dict}${compress ? ' /Filter /FlateDecode' : ''} /Length ${body.length} >>\nstream\n`, 'latin1')
  return [head, body, Buffer.from('\nendstream', 'latin1')]
}

/** A code point as UTF-16BE hex, so an astral character lands as a surrogate pair. */
function utf16Hex(code) {
  if (code > 0xffff) {
    const value = code - 0x10000
    return (0xd800 + (value >> 10)).toString(16) + (0xdc00 + (value & 0x3ff)).toString(16)
  }
  return code.toString(16).padStart(4, '0')
}

/** The `/ToUnicode` CMap: it is what makes the text copyable and searchable. */
function toUnicodeCMap(pairs) {
  const lines = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
  ]
  // 100 entries per section is the limit the CMap format itself imposes.
  for (let at = 0; at < pairs.length; at += 100) {
    const chunk = pairs.slice(at, at + 100)
    lines.push(`${chunk.length} beginbfchar`)
    for (const [cid, code] of chunk) lines.push(`<${cid.toString(16).padStart(4, '0')}> <${utf16Hex(code)}>`)
    lines.push('endbfchar')
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end')
  return Buffer.from(`${lines.join('\n')}\n`, 'latin1')
}

/** `/W` for the glyphs actually used: `[gid [width] gid [width] ...]`. */
function widthsArray(pairs) {
  const chunks = []
  let line = '/W ['
  let count = 0
  for (const [gid, width] of pairs) {
    if (count >= WIDTHS_PER_LINE) {
      chunks.push(`${line}\n`)
      line = ''
      count = 0
    }
    line += `${count === 0 ? '' : ' '}${gid} [${Math.round(width)}]`
    count += 1
  }
  chunks.push(`${line}]\n`)
  return chunks.join('')
}

/** Resolve `pageSize` into `[width, height]` in points. */
function pageDimensions(pageSize) {
  if (Array.isArray(pageSize) && pageSize.length === 2) return [Number(pageSize[0]), Number(pageSize[1])]
  const named = PAGE_SIZES[String(pageSize ?? 'a4').toLowerCase()]
  if (named) return [...named]
  throw new Error(`PDF: неизвестный размер страницы «${pageSize}»`)
}

/**
 * Escape `(`, `)` and `\` inside a PDF literal string.
 *
 * @param {string} text - the raw text.
 * @returns {string} the same text, safe inside `( )`.
 */
export function escapePdfText(text) {
  return String(text).replace(/([\\()])/g, '\\$1')
}

/**
 * Break text into lines that each fit into `maxWidth`.
 *
 * A word that is too long for a line of its own is broken letter by letter, so nothing
 * ever overflows the margins.
 *
 * @param {string} text - the paragraph; a line break inside it starts a new line.
 * @param {number} maxWidth - the usable width, in points.
 * @param {(text: string) => number} measureWidth - width of a run, in points.
 * @returns {Array<string>} the lines, each no wider than `maxWidth`.
 */
export function wrapLines(text, maxWidth, measureWidth) {
  const lines = []
  const measure = typeof measureWidth === 'function' ? measureWidth : (value) => value.length
  for (const paragraph of String(text ?? '').split('\n')) {
    if (paragraph === '') {
      lines.push('')
      continue
    }
    const words = paragraph.split(/[ \t\u00a0]+/).filter((word) => word !== '')
    if (words.length === 0) {
      lines.push('')
      continue
    }
    let current = ''
    const flush = () => {
      if (current !== '') lines.push(current)
      current = ''
    }
    for (const word of words) {
      if (measure(word) > maxWidth) {
        // A word too long for a line of its own is broken letter by letter.
        flush()
        let piece = ''
        let pieceWidth = 0
        for (const character of word) {
          const width = measure(character)
          if (piece !== '' && pieceWidth + width > maxWidth) {
            lines.push(piece)
            piece = ''
            pieceWidth = 0
          }
          piece += character
          pieceWidth += width
        }
        current = piece
        continue
      }
      const withSpace = current === '' ? word : `${current} ${word}`
      if (current !== '' && measure(withSpace) > maxWidth) {
        lines.push(current)
        current = word
        continue
      }
      current = withSpace
    }
    flush()
  }
  return lines
}

/**
 * Render one encoded line as a `Tj` (or a `TJ` when kerning adjustments help).
 *
 * @param {Array<number>} cids - glyph ids of the line.
 * @param {Array<boolean>} breaks - true where a glyph opens a new run.
 * @param {Array<number>} widths - width of every glyph, in 1/1000 em.
 * @param {number} size - the point size in effect.
 * @returns {string} the PDF operator.
 */
function showText(cids, breaks, widths, size) {
  const runs = []
  const kerns = []
  let current = []
  for (let index = 0; index < cids.length; index += 1) {
    if (breaks[index] && current.length > 0) {
      runs.push(current)
      kerns.push(-(FONT_UNITS_PER_EM - widths[index - 1]))
      current = []
    }
    current.push(index)
  }
  if (current.length > 0) runs.push(current)
  const hexRuns = runs.map((run) => `<${run.map((index) => cids[index].toString(16).padStart(4, '0')).join('')}>`)
  if (hexRuns.length === 1) return `${hexRuns[0]} Tj`
  const items = []
  hexRuns.forEach((hex, index) => {
    if (index > 0) items.push(((kerns[index - 1] * size) / FONT_UNITS_PER_EM).toFixed(2))
    items.push(hex)
  })
  return `[${items.join(' ')}] TJ`
}

/** Strip the directory and extension from a path, for `/BaseFont` and `/FontName`. */
function fontName(fontPath) {
  const base = String(fontPath).split(/[\\/]/).pop() ?? 'Embedded'
  const clean = base.replace(/\.(ttf|ttc|otf)$/i, '').replace(/[^\w-]/g, '')
  return clean === '' ? 'Embedded' : clean
}

/** A PDF name literal, with everything outside the safe set escaped. */
function pdfName(value) {
  return String(value).replace(/[^\w-]/g, (character) => `#${character.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

/** The `/FontDescriptor` of the embedded font. */
function descriptorDict(font, fontFileId) {
  const scale = FONT_UNITS_PER_EM / font.unitsPerEm
  const ascent = font.os2.typoAscender || font.ascender || Math.round(font.yMax * scale)
  const descent = font.os2.typoDescender || font.descender || Math.round(font.yMin * scale)
  const yMin = Math.round(font.yMin * scale)
  const yMax = Math.round(font.yMax * scale)
  const bbox = [Math.min(yMin, descent), Math.min(yMax, ascent), Math.max(yMin, descent), Math.max(yMax, ascent)].sort((a, b) => a - b)
  const capHeight = font.os2.capHeight > 0 ? font.os2.capHeight : Math.round(ascent * 0.7)
  // Bit 1 (value 2) forbids embedding and bit 9 (value 512) allows bitmap embedding only.
  const restricted = (font.os2.fsType & 0x0002) !== 0 || (font.os2.fsType & 0x0200) !== 0
  if (restricted) throw new Error(`PDF: шрифт ${font.path} запрещает встраивание (fsType=${font.os2.fsType})`)
  return `<< /Type /FontDescriptor /FontName ${pdfName(fontName(font.path))} /Flags 32 /FontBBox [${bbox.join(' ')}] `
    + `/ItalicAngle 0 /Ascent ${ascent} /Descent ${descent} /CapHeight ${capHeight} /StemV 80 /FontFile2 ${fontFileId} 0 R >>`
}

/** Write the objects out as a cross-referenced PDF file. */
function serializePdf(objects, title) {
  const out = createWriter(1 << 20)
  out.write('%PDF-1.4\n')
  // A comment with a few high bytes tells tools the file is not plain ASCII.
  out.write(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]))
  const offsets = []
  objects.forEach((object) => {
    offsets.push(out.length)
    out.write(`${object.id} 0 obj\n`)
    for (const part of object.parts) out.write(part)
    out.write('\nendobj\n')
  })
  const infoId = objects.length + 1
  const infoAt = out.length
  const info = `<< /Producer (${escapePdfText('tg-agent')}) /Creator (${escapePdfText('tg-agent')})`
    + (title === '' ? '' : ` /Title (${escapePdfText(title)})`)
    + ' >>'
  out.write(`${infoId} 0 obj\n${info}\nendobj\n`)
  const xrefAt = out.length
  const size = objects.length + 2
  const at = new Array(size).fill(0)
  objects.forEach((object, index) => {
    at[object.id] = offsets[index]
  })
  at[infoId] = infoAt
  out.write(`xref\n0 ${size}\n0000000000 65535 f \n`)
  for (let id = 1; id < size; id += 1) out.write(`${String(at[id]).padStart(10, '0')} 00000 n \n`)
  out.write(`trailer\n<< /Size ${size} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`)
  return Buffer.from(out.toBuffer())
}

/**
 * Build a PDF document.
 *
 * @param {object} options - the document.
 * @param {string} [options.title] - `/Title` in the metadata; not printed in the body.
 * @param {Array<object>} [options.blocks] - `{ type, text }`, where type is
 *   `h1`, `h2`, `p`, `bullet` or `spacer` (which uses `height`).
 * @param {string} [options.fontPath] - a TTF to embed; `findFontPath()` is used when omitted.
 * @param {Array<string>} [options.candidates] - paths `findFontPath()` may try instead of the defaults.
 * @param {number} [options.fontSize] - body point size.
 * @param {number} [options.margin] - page margin in points.
 * @param {string|Array<number>} [options.pageSize] - `a4`, `letter`, `legal` or `[w, h]`.
 * @returns {Buffer} the bytes of the PDF.
 */
export function createPdf({ title, blocks, fontPath, candidates, fontSize = 11, margin = 48, pageSize = 'a4' } = {}) {
  const path = fontPath === undefined || fontPath === null || fontPath === '' ? findFontPath({ candidates }) : fontPath
  if (!path) throw new Error(NO_FONT_MESSAGE)
  const size = Number(fontSize)
  const pad = Number(margin)
  if (!Number.isFinite(size) || size <= 0) throw new Error('PDF: fontSize должен быть положительным числом')
  if (!Number.isFinite(pad) || pad < 0) throw new Error('PDF: margin не может быть отрицательным')
  const [pageWidth, pageHeight] = pageDimensions(pageSize)
  const usableWidth = pageWidth - pad * 2
  if (!(usableWidth > 0)) throw new Error('PDF: поля не оставляют места для текста')
  const font = loadFont(path)
  const documentTitle = typeof title === 'string' ? title : ''

  // Two passes: collect the glyphs the text needs, then draw with the finished font.
  const fallbackGid = font.codeToGlyph.get(FALLBACK_CHAR.codePointAt(0)) ?? 0
  const cidInfo = new Map()
  const cidFor = (character) => {
    const code = character.codePointAt(0)
    const known = font.codeToGlyph.get(code)
    const gid = known === undefined ? fallbackGid : known
    const cached = cidInfo.get(gid)
    if (cached) return cached
    const info = {
      gid,
      width: toPdfWidth(font.advances[gid] ?? 0, font.unitsPerEm),
      // A missing glyph is drawn as `?`, so `/ToUnicode` must say `?` as well.
      code: known === undefined ? FALLBACK_CHAR.codePointAt(0) : code,
    }
    cidInfo.set(gid, info)
    return info
  }
  /** Width of a run in 1/1000 em, the unit `/W` and the content stream both use. */
  const widthOf = (text) => {
    let width = 0
    for (const character of String(text)) width += cidFor(character).width
    return width
  }
  const encode = (text) => {
    const cids = []
    const widths = []
    const breaks = []
    for (const character of String(text)) {
      const info = cidFor(character)
      cids.push(info.gid)
      widths.push(info.width)
      breaks.push(false)
    }
    return { cids, widths, breaks }
  }

  const bulletGlyph = font.codeToGlyph.has('•'.codePointAt(0)) ? '•' : '-'
  const layout = {
    h1: { size: size * H1_SCALE, lead: HEADING_LEADING, spaceBefore: size * H1_SPACE_BEFORE, spaceAfter: size * HEADING_SPACE_AFTER },
    h2: { size: size * H2_SCALE, lead: HEADING_LEADING, spaceBefore: size * H2_SPACE_BEFORE, spaceAfter: size * HEADING_SPACE_AFTER },
    p: { size, lead: BODY_LEADING, spaceBefore: 0, spaceAfter: size * BODY_SPACE_AFTER },
    bullet: { size, lead: BODY_LEADING, spaceBefore: 0, spaceAfter: size * BULLET_SPACE_AFTER },
  }
  for (const style of Object.values(layout)) style.leading = style.size * style.lead

  // Build every line up front: a line is the unit of pagination.
  const items = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const type = typeof block?.type === 'string' ? block.type.toLowerCase() : 'p'
    if (type === 'spacer') {
      const height = Number(block?.height)
      items.push({ kind: 'space', height: Number.isFinite(height) && height > 0 ? height : size })
      continue
    }
    const style = layout[type] ?? layout.p
    if (style.spaceBefore > 0) items.push({ kind: 'space', height: style.spaceBefore })
    const indent = type === 'bullet' ? BULLET_INDENT : 0
    const text = block?.text == null ? '' : String(block.text)
    // `widthOf` is already in 1/1000 em, so only the point size is left to apply here.
    const measure = (value) => (value === '' ? 0 : (widthOf(value) * style.size) / FONT_UNITS_PER_EM)
    let first = true
    for (const line of wrapLines(text, usableWidth - indent, measure)) {
      items.push({
        kind: 'line',
        size: style.size,
        leading: style.leading,
        indent,
        // The bullet marker rides on the first line only, the way a list does.
        prefix: type === 'bullet' && first ? `${bulletGlyph} ` : '',
        // A blank line still takes vertical space, it just has nothing to show.
        text: line,
      })
      first = false
    }
    if (style.spaceAfter > 0) items.push({ kind: 'space', height: style.spaceAfter })
  }

  // Paginate: a line moves to the next page when it would cross the bottom margin.
  const pages = []
  let current = []
  let cursor = pageHeight - pad
  for (const item of items) {
    if (item.kind === 'space') {
      cursor -= item.height
      continue
    }
    if (cursor - item.leading < pad && current.length > 0) {
      pages.push(current)
      current = []
      cursor = pageHeight - pad
    }
    cursor -= item.leading
    current.push({ item, y: cursor })
  }
  pages.push(current)

  const contentStreams = pages.map((lines) => {
    const out = createWriter()
    out.write(`BT\n/F1 ${size.toFixed(2)} Tf\n`)
    let opened = false
    for (const { item, y } of lines) {
      const content = item.prefix + item.text
      if (content !== '') {
        const encoded = encode(content)
        out.write(`${item.indent} ${y.toFixed(2)} Td\n`)
        if (!opened || item.size !== size) out.write(`/F1 ${item.size.toFixed(2)} Tf\n`)
        out.write(`${showText(encoded.cids, encoded.breaks, encoded.widths, item.size)}\n`)
        opened = true
      }
      out.write(`${-item.indent} ${(-item.leading).toFixed(2)} Td\n`)
    }
    out.write('ET\n')
    return out.toBuffer()
  })

  // Objects in order: 1 catalog, 2 pages, 3 Type0 font, 4 CIDFont, 5 ToUnicode,
  // 6 font descriptor, 7 embedded TTF, then a page and its content stream per page.
  const usedGids = [...cidInfo.keys()].sort((a, b) => a - b)
  const objects = []
  let nextId = 1
  const add = (parts) => {
    objects.push({ id: nextId, parts })
    nextId += 1
    return nextId - 1
  }
  const contentId = (index) => 9 + index * 2
  add([Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1')])
  add([Buffer.from(`<< /Type /Pages /Kids [${pages.map((_, index) => `${8 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`, 'latin1')])
  add([
    Buffer.from(
      `<< /Type /Font /Subtype /Type0 /BaseFont ${pdfName(fontName(path))} /Encoding /Identity-H `
      + '/DescendantFonts [4 0 R] /ToUnicode 5 0 R >>',
      'latin1',
    ),
  ])
  add([
    Buffer.from(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont ${pdfName(fontName(path))} `
      + '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 6 0 R '
      + `/DW ${FONT_UNITS_PER_EM} /CIDToGIDMap /Identity `,
      'latin1',
    ),
    Buffer.from(widthsArray(usedGids.map((gid) => [gid, cidInfo.get(gid).width])), 'latin1'),
    Buffer.from('>>', 'latin1'),
  ])
  add(streamObject('', toUnicodeCMap(usedGids.map((gid) => [gid, cidInfo.get(gid).code]))))
  add([Buffer.from(descriptorDict(font, 7), 'latin1')])
  add(streamObject('', font.embed, true))
  pages.forEach((_, index) => {
    add([
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(2)}] `
        + `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId(index)} 0 R >>`,
        'latin1',
      ),
    ])
    add(streamObject('', contentStreams[index], true))
  })
  return serializePdf(objects, documentTitle)
}
