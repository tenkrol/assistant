/**
 * Доставка длинного ответа: разбиение на части и пошаговый стриминг.
 *
 * Платформа накладывает жёсткий лимит на сообщение, а стриминг правит уже
 * отправленное сообщение. Обе задачи живут здесь, чтобы разговорная часть не
 * знала ни про лимиты, ни про правки сообщений.
 */
import { TELEGRAM_MESSAGE_LIMIT } from './format.mjs'

/** Теги, которые умеет выдавать преобразователь разметки; каждый знает, как себя открыть и закрыть. */
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
 * Разбить HTML Telegram на куски не длиннее `limit` символов.
 *
 * Теги, открытые в одном куске, закрываются в его конце и открываются заново в
 * начале следующего, поэтому каждый кусок — самостоятельный валидный HTML.
 * Слова не разрезаются, если только одна строка не длиннее лимита; граница
 * никогда не попадает между половинами суррогатной пары.
 *
 * Два патологических входа обрабатываются явно, потому что оба встречаются в
 * ответе модели и ни один не должен вешать бота:
 *   - открывающий тег длиннее лимита (ссылка с огромным URL) отбрасывается
 *     вместе со своим закрывающим тегом, чтобы бюджет куска остался
 *     положительным;
 *   - префикс для переоткрытия ограничен, поэтому в куске всегда есть место для
 *     продвижения.
 *
 * @param {string} html - результат {@link markdownToTelegramHtml}.
 * @param {number} [limit] - максимальная длина куска в кодовых единицах UTF-16.
 * @returns {string[]} один или несколько непустых кусков.
 */
export function splitForTelegram(html, limit = TELEGRAM_MESSAGE_LIMIT) {
  if (html === '') return []
  if (html.length <= limit) return [html]
  const chunks = []
  const stack = []
  /** Закрывающие теги, чей открывающий тег был отброшен; их тоже надо пропустить. */
  const droppedCloses = new Map()
  let current = ''

  // Префикс для переоткрытия тегов должен оставлять место для текста, иначе
  // `room()` останется неположительным и цикл сброса зациклится.
  const reopenBudget = Math.max(0, Math.floor(limit / 3))
  const maxTagLength = Math.max(32, limit - 32)

  const closeStack = () => stack.slice().reverse().map((entry) => entry.close).join('')
  const room = () => limit - current.length - closeStack().length

  /** Закрыть текущий кусок, затем переоткрыть столько тегов, сколько позволит бюджет. */
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
      // `<pre><code …>` — единое целое: форматтер выдаёт его парой тегов, а
      // разрезание между ними оставило бы кусок с несбалансированным <pre>.
      if (html.startsWith('<pre><code', index)) {
        // Тег заканчивается на `>` от `<code …>`, а не на `>` от `<pre>`.
        const end = nextTag(html, index + '<pre>'.length)
        const tag = html.slice(index, end)
        // То же правило, что и для одиночного тега: пара должна оставить место тексту.
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
      // Пара тегов должна оставить место хотя бы одному символу; иначе пустой
      // кусок `<b></b>` выйдет за лимит, или тег нельзя будет переоткрыть и
      // цикл не сдвинется.
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

/** Индекс конца тега, начинающегося с `start`, или `start + 1` для голого `<`. */
function nextTag(html, start) {
  const end = html.indexOf('>', start)
  return end === -1 ? start + 1 : end + 1
}

/** Предпочесть рез после перевода строки, затем после пробела; 0 означает «нет хорошего места». */
function longestBreak(slice) {
  const newline = slice.lastIndexOf('\n')
  if (newline > 0) return newline + 1
  const space = slice.lastIndexOf(' ')
  if (space > 0) return space + 1
  return 0
}

/**
 * Сдвинуть рез на единицу назад, если он разрезает суррогатную пару.
 *
 * `floor` — наименьший допустимый рез. Когда сдвиг не даёт продвижения (пара
 * начинается ровно на `floor`), резу разрешено выйти на единицу за цель, но не
 * застопорить цикл.
 */
function avoidSurrogateSplit(text, cut, floor) {
  if (cut >= text.length || cut <= floor) return Math.min(Math.max(cut, floor + 1), text.length)
  const unit = text.charCodeAt(cut - 1)
  if (unit >= 0xd800 && unit <= 0xdbff) return Math.max(cut - 1, floor + 1)
  return cut
}

/**
 * Писать ответ в сообщение, пока модель ещё его генерирует.
 *
 * Первый фрагмент создаёт сообщение, последующие правят его — не чаще одного
 * раза за окно троттлинга, потому что Telegram считает правки по тому же
 * лимиту, что и отправки. `finish()` ставит финальный текст (с кнопками) на
 * место и сообщает, доставлен ли ответ, чтобы вызывающий не отправил вторую
 * копию.
 *
 * @param {object} options - зависимости доставки.
 * @param {object} options.platform - адаптер платформы (`sendText`, `editText`).
 * @param {object} options.logger - логгер.
 * @param {number} [options.throttleMs] - окно троттлинга правок.
 * @param {number|string} chatId - целевой чат.
 * @returns {{onDelta: (chunk: string) => void, finish: (text: string, keyboard?: object) => Promise<boolean>}}
 */
export function createStreamer({ platform, logger, throttleMs = 900 }, chatId) {
  let buffer = ''
  let messageId
  // Истина, пока идёт самая первая отправка.
  let creating = false
  let lastEditAt = 0
  let queue = Promise.resolve()
  // Устанавливается при сорвавшейся правке: тогда вызывающий отправит весь ответ.
  let lastEditOk = true

  const flush = (final = false) => {
    // Правки сериализованы: две одновременно пришли бы не по порядку и показали
    // старый текст последним.
    queue = queue.then(async () => {
      if (messageId === undefined) {
        const sent = await platform.sendText({ chatId, markdown: buffer })
        messageId = sent?.messageId
        return
      }
      await platform.editText({ chatId, messageId, markdown: buffer })
    }).catch((error) => {
      lastEditOk = false
      logger.debug('stream edit failed', { error: error?.description ?? error?.message })
    })
    if (final) return queue
    return undefined
  }

  return {
    onDelta: (chunk) => {
      buffer += chunk
      const now = Date.now()
      if (messageId === undefined) {
        // Первая отправка асинхронна: без этой защиты каждый фрагмент, пришедший
        // до её завершения, начинал бы своё сообщение.
        if (!creating) {
          creating = true
          lastEditAt = now
          flush()
        }
        return
      }
      if (now - lastEditAt >= throttleMs) {
        lastEditAt = now
        flush()
      }
    },
    finish: async (text, keyboard) => {
      // Ни один фрагмент не пришёл (ход из одних инструментов): вызывающий отправит как обычно.
      if (messageId === undefined && !creating) return false
      buffer = text
      lastEditOk = true
      await flush(true)
      creating = false
      if (messageId === undefined) return false
      if (!lastEditOk) {
        // Частичное сообщение остаётся, но ответ должен прийти целиком: вызывающий
        // отправит его новым сообщением, когда здесь вернётся false.
        logger.warn('stream edits failed, sending the answer in full', { chatId })
        return false
      }
      if (keyboard) {
        await platform.editText({ chatId, messageId, markdown: text, keyboard }).catch(() => {})
      }
      return true
    },
  }
}
