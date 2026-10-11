/**
 * Search over the saved conversation history.
 *
 * The matcher is deliberately lexical, not semantic: it lowercases, folds
 * `ё` into `е`, splits text into words and compares words by prefix (with one
 * narrow Russian-ending rule, see {@link wordsMatch}). That means it does not
 * know synonyms, corrections or meaning — those limits are documented on
 * {@link searchMessages} so callers can set expectations for the model.
 *
 * Everything here is a pure function over plain message records
 * (`{ role, content, at? }`); nothing is read from disk and nothing throws.
 */

/** Words are letters and digits, in any alphabet (Cyrillic included). */
const WORD_PATTERN = /[\p{L}\p{N}]+/gu

/** A one-character query matches too much to be useful, so it is rejected. */
const MIN_QUERY_CHARS = 2

/**
 * Short words are compared exactly. Below this length, prefix matching turns
 * ordinary function words ("мы", "на", "и") into wildcards that hit almost any
 * message; at this length and above, a shared stem is meaningful.
 */
const MIN_STEM_CHARS = 3

/** Russian vowels, used only by the single-final-vowel ending rule. */
const VOWELS = new Set('аеёиоуыэюя')

const DEFAULT_LIMIT = 5
const DEFAULT_CONTEXT = 1
const DEFAULT_MAX_TEXT_CHARS = 600
const DEFAULT_MAX_CONTEXT_CHARS = 200
const DEFAULT_MIN_SCORE = 1

/** Soft budget for one Telegram reply produced by {@link formatSearchResults}. */
const RESULT_CHAR_LIMIT = 3000

/**
 * Hint for the model's system prompt: when a history lookup is the right move.
 *
 * Kept short on purpose — the routing decision is "did the user ask about the
 * past", and one sentence is enough for that.
 */
export const SEARCH_HINT =
  'Когда спрашивают, что обсуждали или решали раньше, напоминают «мы говорили про…» или просят найти прошлое сообщение — ищи по истории диалога и отвечай по найденным фрагментам. Если поиск ничего не нашёл, честно скажи, что в переписке этого нет, и не выдумывай.'

/**
 * Find messages that match a query.
 *
 * Matching rules (all comparisons are case-insensitive; `ё` is folded to `е`,
 * so «Ёлка» and «елка» are the same word):
 *   - the query is trimmed, split into words and deduplicated; an empty query,
 *     a blank one or a single character yields no results;
 *   - every query word is scored separately: all words matched outrank some
 *     words matched, and word order does not matter;
 *   - an exact phrase (the query words adjacent, in order) adds the largest
 *     bonus, so it ranks above the same words scattered through the message;
 *   - a word matches another word when one is a prefix of the other, provided
 *     the shorter word has at least {@link MIN_STEM_CHARS} letters. This is why
 *     «ремонт» finds «ремонта», «ремонте», «ремонтом» (and, as a prefix,
 *     «ремонтный» too), while «купить» does NOT find «купил»: those words
 *     diverge at their endings and neither is a prefix of the other;
 *   - as the single exception, two words of at least four letters that share a
 *     three-letter stem and differ only in the last letter, which is a vowel in
 *     both, are treated as one word: «окно» finds «окна», «вода» finds «воды».
 *     This covers a common Russian noun ending without stemming verbs, so it
 *     does not resurrect «купить»/«купил»;
 *   - words shorter than {@link MIN_STEM_CHARS} must match exactly.
 *
 * Limitations, stated on purpose: there are no synonyms, no typo tolerance
 * («римонт» finds nothing), no semantics and no lemmatisation beyond the rules
 * above — «день» does not find «дня». Prefix matching is greedy, so a short
 * stem can pull in unrelated words («дом» also matches «домашний»).
 *
 * Messages whose `content` is not a string (attachments) have no text to match
 * and are never returned. A `system` role participates like any other and does
 * not change the score.
 *
 * @param {Array<{role?: string, content?: unknown, at?: unknown}>} messages -
 *   conversation history, oldest first. A non-array or `undefined` yields [].
 * @param {string} query - what to look for. Non-strings yield [].
 * @param {object} [options] - search options.
 * @param {number} [options.limit=5] - maximum number of matches returned.
 * @param {number} [options.context=1] - neighbours kept per side, see `before`/`after`.
 * @param {number} [options.maxTextChars=600] - cap for `text`, centred on the match.
 * @param {number} [options.maxContextChars=200] - cap for each `before`/`after` entry.
 * @param {number} [options.minScore=1] - minimum score to keep. `1` keeps any
 *   message with at least one matched word; raise it to keep only messages that
 *   matched more words (two words score ~254, one word ~127).
 * @returns {Array<{index: number, role: string, text: string, at: unknown, before: string[], after: string[], score: number, truncated: boolean}>}
 *   Matches sorted by score (ties: newer first, i.e. larger `index` first) and
 *   capped at `limit`. `at` is carried through untouched so the caller can render
 *   the timestamp. `before`/`after` are arrays of the neighbouring messages'
 *   texts (oldest first, up to `context` each), already truncated and with
 *   non-text neighbours skipped; at the edges they are empty arrays.
 * @throws {never} broken input is reported as an empty array, not an exception.
 */
export function searchMessages(messages, query, options = {}) {
  try {
    if (!Array.isArray(messages) || messages.length === 0) return []
    if (typeof query !== 'string') return []
    const trimmed = query.trim()
    if (trimmed.length < MIN_QUERY_CHARS) return []
    const queryWords = [...new Set(tokenize(normalize(trimmed)))]
    if (queryWords.length === 0) return []

    const opts = normalizeOptions(options)
    if (opts.limit <= 0) return []

    const matches = []
    for (let index = 0; index < messages.length; index += 1) {
      const entry = describe(messages[index])
      if (!entry.content) continue
      const score = scoreMessage(entry.content, queryWords)
      if (!score || score.total < opts.minScore) continue
      const clipped = clipText(entry.content, opts.maxTextChars, score.anchor)
      matches.push({
        index,
        role: entry.role,
        text: clipped.text,
        at: entry.at,
        before: neighbours(messages, index, -1, opts),
        after: neighbours(messages, index, 1, opts),
        score: score.total,
        truncated: clipped.truncated,
      })
    }

    matches.sort((a, b) => b.score - a.score || b.index - a.index)
    return matches.slice(0, opts.limit)
  } catch {
    return []
  }
}

/**
 * Render search results as a Telegram-ready Markdown string (the caller runs it
 * through `markdownToTelegramHtml`, which turns `**…**` into bold).
 *
 * Matched words are wrapped in `**`, keeping the original case. The list never
 * exceeds ~3000 characters; when it has to stop early it ends with
 * `… (ещё N совпадений)`.
 *
 * @param {Array<object>} results - output of {@link searchMessages}.
 * @param {object} [options] - rendering options.
 * @param {string} [options.query] - echoed back when nothing was found.
 * @param {string} [options.timeZone='Europe/Moscow'] - zone for message times.
 * @returns {string} reply body, empty results included.
 */
export function formatSearchResults(results, { query, timeZone = 'Europe/Moscow' } = {}) {
  const list = Array.isArray(results) ? results.filter((result) => result && typeof result === 'object') : []
  const question = typeof query === 'string' ? query.trim() : ''
  if (list.length === 0) return `По запросу «${question}» ничего не нашлось в нашей переписке.`

  const queryWords = [...new Set(tokenize(normalize(question)))]
  const lines = list.map((result, position) => `${position + 1}. ${formatResult(result, queryWords, timeZone)}`)

  // Drop entries from the tail until the body plus the "ещё N" footer fits.
  let included = lines.length
  while (included > 0) {
    const body = lines.slice(0, included).join('\n')
    const remaining = lines.length - included
    const footer = remaining > 0 ? `\n… (ещё ${remaining} ${pluralMatches(remaining)})` : ''
    const full = body + footer
    if (full.length <= RESULT_CHAR_LIMIT) return full
    included -= 1
  }

  // A single result can only be this large if the caller raised maxTextChars;
  // showing a cut-off first line beats returning nothing.
  const first = lines[0]
  return first.length <= RESULT_CHAR_LIMIT ? first : `${first.slice(0, RESULT_CHAR_LIMIT - 1)}…`
}

/** One result line: `[Вы, 09.10 14:20] текст` with matches in bold. */
function formatResult(result, queryWords, timeZone) {
  const label = roleLabel(result.role)
  const stamp = formatStamp(result.at, timeZone)
  const header = stamp ? `[${label}, ${stamp}]` : `[${label}]`
  const text = typeof result.text === 'string' ? result.text : ''
  return `${header} ${highlight(text, queryWords)}`
}

/** Human label mirroring the bot's own history export. */
function roleLabel(role) {
  if (role === 'user') return 'Вы'
  if (role === 'assistant') return 'Бот'
  return typeof role === 'string' && role !== '' ? role : 'Сообщение'
}

/**
 * `DD.MM HH:mm` in `timeZone`, or '' when there is no usable timestamp.
 *
 * Accepts a `Date`, an ISO string, or a number (seconds or milliseconds). An
 * unknown zone falls back to the system one instead of throwing.
 */
function formatStamp(at, timeZone) {
  const date = toDate(at)
  if (!date) return ''
  const build = (zone) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone || undefined,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
  let formatter
  try {
    formatter = build(timeZone)
  } catch {
    formatter = build('')
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]))
  return `${parts.day}.${parts.month} ${parts.hour}:${parts.minute}`
}

function toDate(at) {
  if (at instanceof Date) return Number.isNaN(at.getTime()) ? null : at
  if (typeof at === 'number' && Number.isFinite(at)) return dateFromNumber(at)
  if (typeof at === 'string') {
    const trimmed = at.trim()
    if (trimmed === '') return null
    if (/^-?\d+$/.test(trimmed)) return dateFromNumber(Number(trimmed))
    const date = new Date(trimmed)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return null
}

/** Epoch values below 1e12 are read as seconds; above, as milliseconds. */
function dateFromNumber(value) {
  const date = new Date(Math.abs(value) < 1e12 ? value * 1000 : value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Wrap matched words in `**` without touching their case.
 *
 * Words containing markup characters are skipped: inserting asterisks next to a
 * stray `*` or backtick could change how the Markdown converter reads the text.
 */
function highlight(text, queryWords) {
  if (text === '' || queryWords.length === 0) return text
  const spans = []
  for (const match of text.matchAll(WORD_PATTERN)) {
    if (matchTextWord(normalize(match[0]), queryWords)) {
      spans.push({ start: match.index, end: match.index + match[0].length })
    }
  }
  if (spans.length === 0) return text
  let out = ''
  let cursor = 0
  for (const span of spans) {
    if (span.start < cursor) continue
    const fragment = text.slice(span.start, span.end)
    if (/[*`\n]/.test(fragment)) continue
    out += `${text.slice(cursor, span.start)}**${fragment}**`
    cursor = span.end
  }
  return out + text.slice(cursor)
}

/** Score one message; null when no query word occurs in it. */
function scoreMessage(content, queryWords) {
  const tokens = []
  for (const match of content.matchAll(WORD_PATTERN)) {
    tokens.push({ word: normalize(match[0]), index: match.index })
  }
  if (tokens.length === 0) return null

  const matched = new Set()
  let occurrences = 0
  let anchor = 0
  for (const token of tokens) {
    const word = matchTextWord(token.word, queryWords)
    if (!word) continue
    if (occurrences === 0) anchor = token.index
    occurrences += 1
    matched.add(word)
  }
  if (matched.size === 0) return null

  const phrase = hasPhrase(tokens, queryWords)
  const coverage = matched.size / queryWords.length
  const total = (phrase ? 1000 : 0) + matched.size * 100 + Math.round(coverage * 50) + Math.min(occurrences, 5) * 2
  return { total, anchor }
}

/** True when the query words appear as a contiguous run, in order. */
function hasPhrase(tokens, queryWords) {
  for (let start = 0; start + queryWords.length <= tokens.length; start += 1) {
    let ok = true
    for (let offset = 0; offset < queryWords.length; offset += 1) {
      if (!wordsMatch(queryWords[offset], tokens[start + offset].word)) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

/** The query word this text word matches, or null. */
function matchTextWord(textWord, queryWords) {
  for (const queryWord of queryWords) {
    if (wordsMatch(queryWord, textWord)) return queryWord
  }
  return null
}

/**
 * Prefix-based word comparison (see {@link searchMessages} for the full rules).
 *
 * `a` is a query word, `b` a text word; the relation is symmetric.
 */
function wordsMatch(a, b) {
  if (a === b) return true
  const shorter = a.length <= b.length ? a : b
  const longer = a.length <= b.length ? b : a
  if (shorter.length < MIN_STEM_CHARS) return false
  if (longer.startsWith(shorter)) return true
  // о↔а and similar single-vowel endings: окно/окна, вода/воды.
  if (shorter.length > MIN_STEM_CHARS) {
    const stem = shorter.slice(0, -1)
    if (longer.startsWith(stem)) {
      const replacement = longer[shorter.length - 1]
      if (replacement !== undefined && VOWELS.has(shorter[shorter.length - 1]) && VOWELS.has(replacement)) {
        return true
      }
    }
  }
  return false
}

/** Lowercase and fold `ё` into `е`, so both spellings are one word. */
function normalize(text) {
  return text.toLowerCase().replace(/ё/g, 'е')
}

/** Words of an already-normalised string. */
function tokenize(normalised) {
  return normalised.match(WORD_PATTERN) ?? []
}

/** A message's usable role, text and timestamp; non-text content is absent. */
function describe(message) {
  try {
    if (!message || typeof message !== 'object') return { role: '', content: '', at: undefined }
    const content = typeof message.content === 'string' ? message.content : ''
    return { role: typeof message.role === 'string' ? message.role : '', content, at: message.at }
  } catch {
    // A getter that throws is broken input; skip the message, not the search.
    return { role: '', content: '', at: undefined }
  }
}

/** Texts of up to `context` neighbours in `direction` (-1 back, 1 forward). */
function neighbours(messages, index, direction, opts) {
  if (opts.context <= 0) return []
  const positions = []
  for (let step = 1; step <= opts.context; step += 1) {
    const position = index + direction * step
    if (position < 0 || position >= messages.length) break
    positions.push(position)
  }
  if (direction < 0) positions.reverse() // oldest first, like the history itself
  const texts = []
  for (const position of positions) {
    const text = describe(messages[position]).content
    if (text === '') continue
    texts.push(clipContext(text, opts.maxContextChars))
  }
  return texts
}

/** Fit `text` into `maxTextChars`, keeping the match (`anchor`) visible. */
function clipText(text, limit, anchor) {
  const max = Math.max(1, Math.floor(limit))
  if (text.length <= max) return { text, truncated: false }
  if (max < 3) {
    const start = Math.max(0, Math.min(anchor, text.length - max))
    return { text: text.slice(start, start + max), truncated: true }
  }
  const core = max - 2
  let start = Math.max(0, Math.min(anchor - Math.floor(core / 2), text.length - core))
  start = safeStart(text, start)
  let end = Math.min(text.length, start + core)
  end = safeEnd(text, end, start)
  const head = start > 0
  const tail = end < text.length
  const out = `${head ? '…' : ''}${text.slice(start, end)}${tail ? '…' : ''}`
  return { text: out.length <= max ? out : out.slice(0, max), truncated: true }
}

/** Truncate one context neighbour from the front, appending an ellipsis. */
function clipContext(text, limit) {
  const max = Math.max(1, Math.floor(limit))
  if (text.length <= max) return text
  const end = safeEnd(text, max - 1, 0)
  return `${text.slice(0, end)}…`
}

/** Move a start index off the low half of a surrogate pair. */
function safeStart(text, start) {
  if (start <= 0 || start >= text.length) return start
  const unit = text.charCodeAt(start)
  return unit >= 0xdc00 && unit <= 0xdfff ? start - 1 : start
}

/** Move an end index so it never splits a surrogate pair. */
function safeEnd(text, end, floor) {
  if (end <= floor || end >= text.length) return end
  const unit = text.charCodeAt(end)
  return unit >= 0xdc00 && unit <= 0xdfff ? end - 1 : end
}

/** Sanitise `options`, ignoring non-numeric or nonsensical values. */
function normalizeOptions(options) {
  const source = options && typeof options === 'object' ? options : {}
  return {
    limit: intOption(source.limit, DEFAULT_LIMIT, 0),
    context: intOption(source.context, DEFAULT_CONTEXT, 0),
    maxTextChars: intOption(source.maxTextChars, DEFAULT_MAX_TEXT_CHARS, 1),
    maxContextChars: intOption(source.maxContextChars, DEFAULT_MAX_CONTEXT_CHARS, 1),
    minScore: Number.isFinite(source.minScore) ? source.minScore : DEFAULT_MIN_SCORE,
  }
}

function intOption(value, fallback, minimum) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.floor(value))
}

/** Russian plural for the "ещё N …" footer. */
function pluralMatches(count) {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return 'совпадение'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'совпадения'
  return 'совпадений'
}
