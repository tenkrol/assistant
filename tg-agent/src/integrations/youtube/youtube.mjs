/**
 * YouTube subtitles and description for the bot's "summarise this link" flow.
 *
 * There is no key-less public API for captions, so the module does what a browser
 * does: download the watch page, read the `ytInitialPlayerResponse` blob the page
 * embeds, and fetch the caption track it points at as JSON3. All HTTP goes through
 * an injectable `fetchImpl`, so tests never touch the network.
 *
 * `fetchVideo` never throws. The bot turns its result into a plain chat message,
 * and one bad link must not take the poll loop down. The known weak spots are
 * YouTube's unstable markup, videos without captions, and the consent/age-gate
 * page that datacenter IPs hit far more often than home connections; each of
 * those surfaces as a short Russian `reason` instead of an exception.
 */
import { deadlineSignal, isAbortError, isTimeoutError } from '../connection.mjs'

export const MAX_TRANSCRIPT_CHARS = 12000

const MAX_PAGE_CHARS = 2_000_000
const MAX_TRACK_CHARS = 4_000_000

/** A desktop Chrome UA: the mobile/embedded variants get a thinner page. */
const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'ru,en',
}

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/
const YOUTUBE_HOST_PATTERN = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i
// A YouTube-looking token anywhere in free text, with or without a scheme.
// Trailing sentence punctuation is excluded so "(https://youtu.be/ID)." still parses.
const LINK_PATTERN =
  /(?:https?:\/\/)?(?:[\w-]+\.)*(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\/[^\s<>"'«»()\[\],;]*/gi

/**
 * Pull a video id out of a link, a bare id, or text containing either.
 *
 * @param {unknown} input - URL or 11-character id.
 * @returns {string | undefined} a valid id, or `undefined`.
 */
export function parseVideoId(input) {
  if (typeof input !== 'string') return undefined
  const text = input.trim()
  if (text === '') return undefined
  if (VIDEO_ID_PATTERN.test(text)) return text
  for (const match of text.matchAll(LINK_PATTERN)) {
    const id = videoIdFromLink(match[0])
    if (id !== undefined) return id
  }
  return undefined
}

/** Read `watch?v=`, `youtu.be/`, `shorts/`, `embed/`, `live/` or `v/` from one link. */
function videoIdFromLink(value) {
  const raw = value.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  let parsed
  try {
    parsed = new URL(withScheme)
  } catch {
    return undefined
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (!YOUTUBE_HOST_PATTERN.test(host)) return undefined

  if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
    const id = parsed.pathname.split('/').filter(Boolean)[0]
    return typeof id === 'string' && VIDEO_ID_PATTERN.test(id) ? id : undefined
  }

  const fromPath = parsed.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/)
  if (fromPath && VIDEO_ID_PATTERN.test(fromPath[1])) return fromPath[1]

  const fromQuery = parsed.searchParams.get('v')
  if (typeof fromQuery === 'string' && VIDEO_ID_PATTERN.test(fromQuery)) return fromQuery
  return undefined
}

/**
 * Extract the `ytInitialPlayerResponse` object from a watch-page HTML.
 *
 * The blob is assigned to a variable, sometimes as
 * `window["ytInitialPlayerResponse"] = {...}`, so the JSON is located by balancing
 * braces after the first mention of the name, tracking string literals so `{`/`}`
 * inside strings do not confuse the scan. A truncated or non-JSON blob yields
 * `undefined` instead of throwing; if the first mention is not the assignment,
 * later mentions are tried in order.
 *
 * @param {unknown} html - page source.
 * @returns {object | undefined} the parsed player response.
 */
export function extractPlayerResponse(html) {
  if (typeof html !== 'string' || html === '') return undefined
  const marker = 'ytInitialPlayerResponse'
  let from = 0
  for (;;) {
    const at = html.indexOf(marker, from)
    if (at === -1) return undefined
    const parsed = readBalancedObject(html, at + marker.length)
    if (parsed !== undefined) return parsed
    from = at + 1
  }
}

/** Parse the first complete `{...}` after `from`; `undefined` on a missing/truncated/broken value. */
function readBalancedObject(text, from) {
  const start = text.indexOf('{', from)
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          const value = JSON.parse(text.slice(start, i + 1))
          return value !== null && typeof value === 'object' ? value : undefined
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/**
 * Fetch the title, description and subtitles of one YouTube video.
 *
 * Never throws: every failure mode comes back as `{ ok: false, reason }` (plus
 * `videoId` when one was recognised). Captions are preferred; when the video has
 * none, or the track cannot be read, the description is returned instead with
 * `ok: true`, `source: 'description'` and an explanatory `reason`, which the bot
 * passes on to the user. The description is capped by `maxChars` too, because it
 * becomes the transcript in that case.
 *
 * @param {object} [options] - call options.
 * @param {string} [options.url] - video link, or text containing one.
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
 * @param {number} [options.timeoutMs] - per-request timeout.
 * @param {number} [options.maxChars] - transcript budget before the "… (сокращено)" marker.
 * @param {object} [options.logger] - logger with `warn`/`debug`.
 * @returns {Promise<object>} result object; see above.
 */
export async function fetchVideo({
  url,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20000,
  maxChars = MAX_TRANSCRIPT_CHARS,
  logger,
} = {}) {
  const videoId = parseVideoId(url)
  if (videoId === undefined) return { ok: false, reason: 'не нашёл идентификатор видео в ссылке' }

  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20000
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : MAX_TRANSCRIPT_CHARS
  const fail = (reason) => {
    logger?.warn?.('youtube fetch failed', { videoId, reason })
    return { ok: false, videoId, reason }
  }

  try {
    const pageUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=ru`
    const page = await fetchImpl(pageUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: BROWSER_HEADERS,
      signal: deadlineSignal(timeout),
    })
    if (!page?.ok) return fail(`YouTube ответил HTTP ${page?.status ?? '—'}`)

    const html = await readText(page, MAX_PAGE_CHARS)
    const player = extractPlayerResponse(html)
    if (player === undefined) {
      return fail('не разобрал страницу YouTube (возможно, страница согласия или видео недоступно)')
    }

    const details = player.videoDetails ?? {}
    const title = typeof details.title === 'string' ? details.title : ''
    const author = typeof details.author === 'string' ? details.author : ''
    const description = typeof details.shortDescription === 'string' ? details.shortDescription : ''

    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks
    let captionsError = ''
    for (const track of captionCandidates(tracks)) {
      for (const url of [captionUrl(track.baseUrl), track.baseUrl]) {
        try {
          const response = await fetchImpl(url, {
            method: 'GET',
            redirect: 'follow',
            headers: { ...BROWSER_HEADERS, accept: 'application/json,text/plain;q=0.9,*/*;q=0.8' },
            signal: deadlineSignal(timeout),
          })
          if (!response?.ok) throw new Error(`HTTP ${response?.status ?? '—'}`)
          const body = await readText(response, MAX_TRACK_CHARS)
          // json3 first; the plain timedtext XML is what some tracks still return.
          const text = body.trimStart().startsWith('<') ? transcriptFromXml(body) : transcriptFromJson3(JSON.parse(body))
          if (text === '') throw new Error('дорожка субтитров пуста')
          logger?.debug?.('youtube captions done', { videoId, language: track.languageCode, chars: text.length })
          return {
            ok: true,
            videoId,
            title,
            author,
            description,
            transcript: finalizeTranscript(text, budget),
            language: typeof track.languageCode === 'string' ? track.languageCode : undefined,
            source: 'captions',
          }
        } catch (error) {
          // A missing or broken track is not fatal: another track or the description
          // may still work, and only the last failure is worth reporting.
          captionsError = error?.message ?? String(error)
          logger?.debug?.('youtube track unusable', { videoId, language: track.languageCode, error: captionsError })
        }
      }
    }

    const fallback = description.trim()
    if (fallback !== '') {
      logger?.debug?.('youtube description fallback', { videoId, chars: fallback.length })
      return {
        ok: true,
        videoId,
        title,
        author,
        description,
        transcript: finalizeTranscript(fallback, budget),
        language: undefined,
        source: 'description',
        reason: 'субтитров нет, отдаю описание',
      }
    }
    return fail(captionsError === '' ? 'субтитры и описание недоступны' : `субтитры недоступны (${captionsError}), описания нет`)
  } catch (error) {
    logger?.warn?.('youtube fetch threw', { videoId, error })
    return { ok: false, videoId, reason: describeError(error) }
  }
}

/**
 * Pick the best captions track: manual before ASR, then Russian, then English.
 *
 * `Array.prototype.sort` is stable, so equal-ranked tracks keep YouTube's order.
 *
 * @param {unknown} tracks - `captionTracks` from the player response.
 * @returns {object | undefined} the chosen track.
 */
/**
 * Every plausible captions track, best first.
 *
 * YouTube hands back dozens of tracks and some of them are empty (or need a token the
 * page did not give us), so one failed download must not end the attempt.
 */
function captionCandidates(tracks, limit = 6) {
  if (!Array.isArray(tracks)) return []
  const usable = tracks.filter((track) => track && typeof track.baseUrl === 'string' && track.baseUrl !== '')
  const rank = (track) => [track.kind === 'asr' ? 1 : 0, languageRank(track)]
  return [...usable].sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1]).slice(0, limit)
}

function pickCaptionTrack(tracks) {
  if (!Array.isArray(tracks)) return undefined
  const usable = tracks.filter((track) => track && typeof track.baseUrl === 'string' && track.baseUrl !== '')
  if (usable.length === 0) return undefined
  const rank = (track) => [track.kind === 'asr' ? 1 : 0, languageRank(track)]
  return [...usable].sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1])[0]
}

function languageRank(track) {
  const language = String(track.languageCode ?? track.language ?? '').toLowerCase()
  if (language === 'ru' || language.startsWith('ru-')) return 0
  if (language === 'en' || language.startsWith('en-')) return 1
  return 2
}

/** The five XML entities timedtext actually uses, plus numeric references. */
function decodeEntities(text) {
  return String(text)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/** Timedtext XML: the tags are simple, so a narrow regex is safe here. */
function transcriptFromXml(body) {
  const pieces = [...String(body).matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
    .map((match) => decodeEntities(match[1]))
    .join(' ')
  return pieces.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Add `fmt=json3` to a track URL, keeping the parameters YouTube put there. */
function captionUrl(baseUrl) {
  let raw = String(baseUrl).trim()
  if (raw.startsWith('//')) raw = `https:${raw}`
  else if (raw.startsWith('/')) raw = `https://www.youtube.com${raw}`
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`
  const parsed = new URL(raw)
  parsed.searchParams.set('fmt', 'json3')
  return parsed.toString()
}

/** Flatten a JSON3 captions payload into one line of text. */
function transcriptFromJson3(payload) {
  const events = Array.isArray(payload?.events) ? payload.events : []
  const parts = []
  for (const event of events) {
    const segs = Array.isArray(event?.segs) ? event.segs : []
    for (const seg of segs) {
      if (typeof seg?.utf8 !== 'string') continue
      const cleaned = seg.utf8.replace(/[\r\n]+/g, ' ').trim()
      if (cleaned !== '') parts.push(cleaned)
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/** Cap the transcript at `maxChars` and announce the cut. */
function finalizeTranscript(text, maxChars) {
  const clean = String(text ?? '').trim()
  if (clean.length <= maxChars) return clean
  return `${clean.slice(0, maxChars)}… (сокращено)`
}

/** Read at most `maxChars` of a response body, streamed when a stream is available. */
async function readText(response, maxChars) {
  if (typeof response?.body?.getReader !== 'function') {
    const text = typeof response?.text === 'function' ? await response.text() : ''
    return String(text).slice(0, maxChars)
  }
  const reader = response.body.getReader()
  const chunks = []
  let received = 0
  while (received < maxChars) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(Buffer.from(value))
    received += value.byteLength
  }
  try {
    await reader.cancel()
  } catch {
    // The stream may already be closed; that is fine.
  }
  const buffer = Buffer.concat(chunks).subarray(0, maxChars)
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer)
}

/** Turn a thrown error into a short Russian reason. */
function describeError(error) {
  if (isTimeoutError(error) || isAbortError(error)) return 'истёк таймаут запроса к YouTube'
  return `ошибка запроса к YouTube: ${error?.message ?? error}`
}
