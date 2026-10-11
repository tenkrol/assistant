/**
 * Markdown -> Telegram HTML conversion and message splitting.
 *
 * Telegram's MarkdownV2 flavour is unforgiving: a single unescaped character
 * rejects the whole message. HTML mode with explicit escaping is far safer, so
 * replies are converted here and every chunk is guaranteed to be both within
 * Telegram's length limit and tag-balanced.
 */

/** Telegram's hard limit for one message body. */
export const TELEGRAM_MESSAGE_LIMIT = 4096

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttribute = (text) => escapeHtml(text).replace(/"/g, '&quot;')

/** Tags this converter emits; each entry knows how to reopen and close itself. */
const TAG_PATTERNS = [
  { open: /^<pre><code(?: class="[^"]*")?>/, entry: (tag) => ({ open: tag, close: '</code></pre>' }) },
  { open: /^<pre>/, entry: (tag) => ({ open: tag, close: '</pre>' }) },
  { open: /^<(b|i|s|code)>/, entry: (tag) => ({ open: tag, close: `</${tag.slice(1, -1)}>` }) },
  { open: /^<a href="[^"]*">/, entry: (tag) => ({ open: tag, close: '</a>' }) },
]
const CLOSE_PATTERN = /^<\/(b|i|s|code|pre|a)>/

const openTag = (tag) => {
  for (const pattern of TAG_PATTERNS) {
    if (pattern.open.test(tag)) return pattern.entry(tag)
  }
  return null
}

/**
 * Convert a subset of Markdown to the HTML that Telegram accepts.
 *
 * Supported: fenced code blocks, inline code, bold, italic, strikethrough,
 * links, ATX headings and bullet lists. Everything else is passed through as
 * escaped text, so an unparsed construct can never break `parse_mode: HTML`.
 */
export function markdownToTelegramHtml(markdown) {
  if (typeof markdown !== 'string' || markdown === '') return ''
  const pieces = []
  const fence = /```([^\n`]*)\n?([\s\S]*?)```/g
  let cursor = 0
  for (const match of markdown.matchAll(fence)) {
    pieces.push(inlineMarkdown(markdown.slice(cursor, match.index)))
    const language = match[1].trim().replace(/[^\w+#.-]/g, '')
    const code = escapeHtml(match[2].replace(/\n$/, ''))
    pieces.push(`<pre><code${language ? ` class="language-${language}"` : ''}>${code}</code></pre>`)
    cursor = match.index + match[0].length
  }
  // An unterminated ``` stays here as plain text; the code-span rule below
  // accepts only non-empty runs of one or two backticks, so a stray fence is
  // escaped instead of being mangled.
  pieces.push(inlineMarkdown(markdown.slice(cursor)))
  return pieces.join('')
}

/** Convert one non-fenced segment: code spans first, then block and inline marks. */
function inlineMarkdown(segment) {
  if (segment === '') return ''
  const out = []
  const codeSpan = /(`{1,2})([^\n`]+?)\1/g
  let cursor = 0
  for (const match of segment.matchAll(codeSpan)) {
    out.push(formatProse(segment.slice(cursor, match.index)))
    out.push(`<code>${escapeHtml(match[2].trim())}</code>`)
    cursor = match.index + match[0].length
  }
  out.push(formatProse(segment.slice(cursor)))
  return out.join('')
}

function formatProse(text) {
  if (text === '') return ''
  let result = escapeHtml(text)
  result = result.replace(/^#{1,6}[ \t]+(.+)$/gm, '<b>$1</b>')
  result = result.replace(/^[ \t]*[-*+][ \t]+/gm, '• ')
  result = result.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_all, label, url) => `<a href="${escapeAttribute(url)}">${label}</a>`)
  result = result.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<b><i>$1</i></b>')
  result = result.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  result = result.replace(/__([^_\n]+)__/g, '<b>$1</b>')
  result = result.replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
  result = result.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>')
  result = result.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
  // `**bold *italic***` leaves its outer asterisks behind after the italic rule
  // consumed the inner pair; one more pass turns them into bold.
  result = result.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  return result
}

/**
 * Split Telegram HTML into chunks of at most `limit` characters.
 *
 * Tags opened in one chunk are closed at its end and reopened at the start of
 * the next one, so every chunk is independently valid HTML. Words are kept
 * intact unless a single line is longer than the limit, and a cut never lands
 * between the halves of a surrogate pair.
 *
 * Two pathological inputs are handled explicitly, because both can appear in a
 * model answer and neither may hang the bot:
 *   - an opening tag longer than the limit (a link with a huge URL) is dropped
 *     together with its closing tag, which keeps the chunk budget positive;
 *   - the reopen prefix is bounded, so a chunk always has room to make progress.
 *
 * @param {string} html - output of {@link markdownToTelegramHtml}.
 * @param {number} [limit] - maximum chunk length in UTF-16 code units.
 * @returns {string[]} one or more non-empty chunks.
 */
export function splitForTelegram(html, limit = TELEGRAM_MESSAGE_LIMIT) {
  if (html === '') return []
  if (html.length <= limit) return [html]
  const chunks = []
  const stack = []
  /** Closing tags whose opening tag was dropped; they must be skipped too. */
  const droppedCloses = new Map()
  let current = ''

  // The prefix that reopens tags must leave room for text, or `room()` stays
  // non-positive and the flush loop spins forever.
  const reopenBudget = Math.max(0, Math.floor(limit / 3))
  const maxTagLength = Math.max(32, limit - 32)

  const closeStack = () => stack.slice().reverse().map((entry) => entry.close).join('')
  const room = () => limit - current.length - closeStack().length

  /** Close the current chunk, then reopen as many tags as the budget allows. */
  const flush = () => {
    if (current !== '') chunks.push(current + closeStack())
    let prefix = ''
    let used = 0
    const kept = []
    for (const entry of stack) {
      const cost = entry.open.length + entry.close.length
      if (used + cost > reopenBudget) break
      prefix += entry.open
      used += cost
      kept.push(entry)
    }
    stack.length = 0
    stack.push(...kept)
    current = prefix
  }

  const dropOpening = (close) => droppedCloses.set(close, (droppedCloses.get(close) ?? 0) + 1)
  const skipDroppedClose = (close) => {
    const pending = droppedCloses.get(close) ?? 0
    if (pending === 0) return false
    droppedCloses.set(close, pending - 1)
    return true
  }

  let index = 0
  while (index < html.length) {
    if (html[index] === '<') {
      // `<pre><code …>` is one unit: the formatter emits it as a pair of tags,
      // and splitting them would leave a chunk with an unbalanced <pre>.
      if (html.startsWith('<pre><code', index)) {
        // The tag ends at the `>` of `<code …>`, not at the `>` that closes `<pre>`.
        const end = nextTag(html, index + '<pre>'.length)
        const tag = html.slice(index, end)
        // Same rule as the single-tag case: the pair must leave room for text.
        if (tag.length > maxTagLength || tag.length + '</code></pre>'.length + 1 > limit) dropOpening('</code></pre>')
        else {
          if (current.length + tag.length > room()) flush()
          stack.push({ open: tag, close: '</code></pre>' })
          current += tag
        }
        index = end
        continue
      }
      if (html.startsWith('</code></pre>', index)) {
        if (!skipDroppedClose('</code></pre>')) {
          const last = stack[stack.length - 1]
          if (last && last.close === '</code></pre>') stack.pop()
          current += '</code></pre>'
        }
        index += '</code></pre>'.length
        continue
      }
      const close = html.slice(index).match(CLOSE_PATTERN)
      if (close) {
        const tag = close[0]
        if (!skipDroppedClose(tag)) {
          const last = stack[stack.length - 1]
          if (last && last.close === tag) stack.pop()
          current += tag
        }
        index += tag.length
        continue
      }
      const end = nextTag(html, index)
      const tag = html.slice(index, end)
      const entry = openTag(tag)
      // A tag pair must leave room for at least one character; otherwise an
      // empty `<b></b>` chunk would be emitted above the limit, or the tag can
      // never be reopened and the loop would not advance.
      if (!entry) current += tag
      else if (tag.length > maxTagLength || tag.length + entry.close.length + 1 > limit) dropOpening(entry.close)
      else {
        if (current.length + tag.length > room()) flush()
        stack.push(entry)
        current += tag
      }
      index = end
      continue
    }

    const end = html.indexOf('<', index)
    const text = html.slice(index, end === -1 ? html.length : end)
    index = end === -1 ? html.length : end
    let offset = 0
    while (offset < text.length) {
      const available = room()
      if (available <= 0) { flush(); continue }
      if (text.length - offset <= available) {
        current += text.slice(offset)
        break
      }
      const slice = text.slice(offset, offset + available)
      const breakAt = longestBreak(slice)
      const take = breakAt > 0 ? breakAt : available
      const cut = avoidSurrogateSplit(text, offset + take, offset)
      current += text.slice(offset, cut)
      offset = cut
      flush()
    }
  }
  if (current !== '' || chunks.length === 0) chunks.push(current + closeStack())
  return chunks.filter((chunk) => chunk !== '')
}

/** End index of the tag that starts at `start`, or `start + 1` for a bare `<`. */
function nextTag(html, start) {
  const end = html.indexOf('>', start)
  return end === -1 ? start + 1 : end + 1
}

/** Prefer cutting after a newline, then after a space; 0 means "no good break". */
function longestBreak(slice) {
  const newline = slice.lastIndexOf('\n')
  if (newline > 0) return newline + 1
  const space = slice.lastIndexOf(' ')
  if (space > 0) return space + 1
  return 0
}

/**
 * Move a cut back by one unit when it would split a surrogate pair.
 *
 * `floor` is the smallest acceptable cut. When backing up would make no
 * progress (the pair starts exactly at the floor), the cut is allowed to spill
 * one unit past the target instead of stalling the loop.
 */
function avoidSurrogateSplit(text, cut, floor) {
  if (cut >= text.length || cut <= floor) return Math.min(Math.max(cut, floor + 1), text.length)
  const unit = text.charCodeAt(cut - 1)
  if (unit >= 0xd800 && unit <= 0xdbff) return Math.max(cut - 1, floor + 1)
  return cut
}

/** Plain text of a Telegram HTML string, used by tests and logging. */
export function htmlToPlainText(html) {
  return html.replace(/<[^>]+>/g, '')
}
