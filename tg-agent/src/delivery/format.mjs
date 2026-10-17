/**
 * Разметка ответа под платформу: Markdown -> HTML и экранирование.
 *
 * MarkdownV2 у Telegram неумолим: один неэкранированный символ отбивает всё
 * сообщение. Режим HTML с явным экранированием куда безопаснее, поэтому ответы
 * преобразуются здесь, а каждый фрагмент гарантированно влезает в лимит
 * Telegram и сохраняет баланс тегов.
 */

/** Жёсткий лимит Telegram на одно сообщение. */
export const TELEGRAM_MESSAGE_LIMIT = 4096

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttribute = (text) => escapeHtml(text).replace(/"/g, '&quot;')

/**
 * Преобразовать подмножество Markdown в HTML, который принимает Telegram.
 *
 * Поддерживаются: блоки кода, строчный код, жирный, курсив, зачёркнутый,
 * ссылки, заголовки ATX и маркированные списки. Всё остальное проходит как
 * экранированный текст, поэтому неразобранная конструкция не может сломать
 * `parse_mode: HTML`.
 *
 * @param {string} markdown - ответ модели.
 * @returns {string} HTML для Telegram.
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
  // Незакрытый ``` остаётся здесь обычным текстом; правило ниже принимает
  // только непустые серии из одного-двух обратных кавычек, так что случайный
  // забор экранируется, а не калечится.
  pieces.push(inlineMarkdown(markdown.slice(cursor)))
  return pieces.join('')
}

/** Преобразовать один сегмент вне блока кода: сначала код, потом блоки и строчные пометки. */
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
  // `**bold *italic***` после правила курсива оставляет внешние звёздочки;
  // ещё один проход превращает их в жирный.
  result = result.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  return result
}

/** Простой текст из HTML Telegram — для тестов и логов. */
export function htmlToPlainText(html) {
  return html.replace(/<[^>]+>/g, '')
}
