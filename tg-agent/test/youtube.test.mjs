import assert from 'node:assert/strict'
import test from 'node:test'
import { extractPlayerResponse, fetchVideo, MAX_TRANSCRIPT_CHARS, parseVideoId } from '../src/youtube.mjs'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

/** Minimal `Response`-like object: the module only touches ok/status/text/body. */
function response(body, { status = 200, contentType = 'application/json' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

/** Watch page carrying an embedded `ytInitialPlayerResponse`. */
function playerHtml(player) {
  return `<html><head><title>x</title></head><body><script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script></body></html>`
}

function playerResponse({ title = 'Заголовок', author = 'Автор', description = 'Описание', tracks } = {}) {
  const player = { videoDetails: { title, author, shortDescription: description } }
  if (tracks !== undefined) player.captions = { playerCaptionsTracklistRenderer: { captionTracks: tracks } }
  return player
}

function captionTrack(languageCode, kind, baseUrl) {
  const track = {
    languageCode,
    baseUrl: baseUrl ?? `https://www.youtube.com/api/timedtext?v=abc12345678&lang=${languageCode}`,
    name: { simpleText: languageCode },
  }
  if (kind !== undefined) track.kind = kind
  return track
}

const json3 = (events) => ({ events })

/**
 * Routing fetch stub: the watch page and the timedtext track, nothing else.
 * Records every call so tests can inspect the URL and headers.
 */
function stubFetch({ player, trackBody, trackStatus = 200, pageStatus = 200 } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const target = String(url)
    calls.push({ url: target, init })
    if (target.includes('/watch')) {
      return response(playerHtml(player ?? playerResponse()), { status: pageStatus, contentType: 'text/html' })
    }
    if (target.includes('/api/timedtext')) {
      return response(trackBody ?? json3([]), { status: trackStatus })
    }
    throw new Error(`unexpected url: ${target}`)
  }
  return { calls, fetchImpl }
}

test('parseVideoId understands every documented link shape', () => {
  const cases = [
    ['https://www.youtube.com/watch?v=abc12345678', 'abc12345678'],
    ['https://youtu.be/abc12345678', 'abc12345678'],
    ['https://www.youtube.com/shorts/abc12345678', 'abc12345678'],
    ['https://www.youtube.com/embed/abc12345678', 'abc12345678'],
    ['https://m.youtube.com/watch?v=abc12345678&t=30', 'abc12345678'],
    ['abc12345678', 'abc12345678'],
    ['dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['  https://youtu.be/abc12345678  ', 'abc12345678'],
    ['посмотри https://youtu.be/abc12345678 вот', 'abc12345678'],
    ['ссылка (https://youtu.be/abc12345678).', 'abc12345678'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1&index=2', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?list=PL1&v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(parseVideoId(input), expected, `input: ${input}`)
  }
})

test('parseVideoId rejects junk, wrong ids and non-YouTube links', () => {
  const bad = [
    '',
    '   ',
    'просто текст без ссылки',
    'https://youtu.be/',
    'https://youtu.be/ABC123',
    'https://youtu.be/abc123456789',
    'https://www.youtube.com/watch?v=short',
    'https://example.com/watch?v=abc12345678',
    'https://vimeo.com/abc12345678',
    undefined,
    null,
    42,
    {},
  ]
  for (const input of bad) {
    assert.equal(parseVideoId(input), undefined, `input: ${String(input)}`)
  }
})

test('extractPlayerResponse pulls the JSON object out of the assignment', () => {
  const value = {
    videoDetails: { title: 'Заголовок', shortDescription: 'строка с } и {' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://x/a?b=1' }] } },
  }
  const html = `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(value)};</script><script>other()</script></html>`
  assert.deepEqual(extractPlayerResponse(html), value)
})

test('extractPlayerResponse handles window["ytInitialPlayerResponse"] and escaped quotes', () => {
  const html = '<script>window["ytInitialPlayerResponse"] = {"a":{"b":"}"},"c":"{","d":[1,{"e":2}]};</script>'
  assert.deepEqual(extractPlayerResponse(html), { a: { b: '}' }, c: '{', d: [1, { e: 2 }] })

  const value = { s: 'он сказал "привет" }' }
  assert.deepEqual(extractPlayerResponse(`var ytInitialPlayerResponse = ${JSON.stringify(value)};`), value)
})

test('extractPlayerResponse skips an unrelated brace before the real assignment', () => {
  const html =
    '<script>if (ytInitialPlayerResponse) { init(); }</script>'
    + '<script>var ytInitialPlayerResponse = {"videoDetails":{"title":"T"}};</script>'
  assert.deepEqual(extractPlayerResponse(html), { videoDetails: { title: 'T' } })
})

test('extractPlayerResponse returns undefined for missing or truncated JSON without throwing', () => {
  assert.equal(extractPlayerResponse('<html><body>ничего нет</body></html>'), undefined)
  assert.equal(extractPlayerResponse('var ytInitialPlayerResponse = {"a":{"b":1'), undefined)
  assert.equal(extractPlayerResponse('var ytInitialPlayerResponse = null;'), undefined)
  assert.equal(extractPlayerResponse(''), undefined)
  assert.equal(extractPlayerResponse(undefined), undefined)
})

test('fetchVideo prefers manual Russian captions over ASR and keeps query params', async () => {
  const player = playerResponse({
    tracks: [captionTrack('en', 'asr'), captionTrack('ru'), captionTrack('en')],
  })
  const { calls, fetchImpl } = stubFetch({
    player,
    trackBody: json3([{ segs: [{ utf8: 'Привет' }, { utf8: 'мир' }] }]),
  })

  const result = await fetchVideo({ url: 'https://youtu.be/abc12345678', fetchImpl, logger: silentLogger })

  assert.equal(result.ok, true)
  assert.equal(result.source, 'captions')
  assert.equal(result.videoId, 'abc12345678')
  assert.equal(result.title, 'Заголовок')
  assert.equal(result.author, 'Автор')
  assert.equal(result.description, 'Описание')
  assert.equal(result.language, 'ru')
  assert.equal(result.transcript, 'Привет мир')
  assert.equal(result.reason, undefined)

  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'https://www.youtube.com/watch?v=abc12345678&hl=ru')
  assert.match(calls[0].init.headers['user-agent'], /Mozilla\/5\.0/)
  assert.equal(calls[0].init.headers['accept-language'], 'ru,en')
  // `fmt=json3` is added, the track's own parameters survive.
  assert.match(calls[1].url, /fmt=json3/)
  assert.match(calls[1].url, /lang=ru/)
  assert.match(calls[1].url, /v=abc12345678/)
})

test('fetchVideo uses the only ASR track when nothing manual exists', async () => {
  const player = playerResponse({ tracks: [captionTrack('ru', 'asr')] })
  const { fetchImpl } = stubFetch({ player, trackBody: json3([{ segs: [{ utf8: 'авто' }] }]) })

  const result = await fetchVideo({ url: 'https://www.youtube.com/watch?v=abc12345678', fetchImpl, logger: silentLogger })

  assert.equal(result.ok, true)
  assert.equal(result.source, 'captions')
  assert.equal(result.language, 'ru')
  assert.equal(result.transcript, 'авто')
})

test('fetchVideo returns the description when the video has no captions', async () => {
  const player = playerResponse({ description: 'Тут описание видео', tracks: [] })
  const { calls, fetchImpl } = stubFetch({ player })

  const result = await fetchVideo({ url: 'https://youtu.be/abc12345678', fetchImpl, logger: silentLogger })

  assert.equal(result.ok, true)
  assert.equal(result.source, 'description')
  assert.equal(result.transcript, 'Тут описание видео')
  assert.equal(result.description, 'Тут описание видео')
  assert.match(result.reason, /описание/)
  assert.equal(calls.length, 1, 'no caption track is requested')
})

test('fetchVideo reports a non-200 watch page as a failure', async () => {
  const { fetchImpl } = stubFetch({ pageStatus: 404 })
  const result = await fetchVideo({ url: 'https://youtu.be/abc12345678', fetchImpl, logger: silentLogger })

  assert.equal(result.ok, false)
  assert.equal(result.videoId, 'abc12345678')
  assert.match(result.reason, /HTTP 404/)
})

test('fetchVideo never throws when fetchImpl throws, and warns', async () => {
  const warnings = []
  const logger = { debug() {}, info() {}, warn: (...args) => warnings.push(args), error() {} }
  const fetchImpl = async () => {
    throw new Error('сеть легла')
  }

  const result = await fetchVideo({ url: 'https://youtu.be/abc12345678', fetchImpl, logger })

  assert.equal(result.ok, false)
  assert.equal(result.videoId, 'abc12345678')
  assert.match(result.reason, /сеть легла/)
  assert.ok(warnings.length >= 1, 'a warning was logged')
})

test('fetchVideo falls back to the description when the caption track JSON is broken', async () => {
  // Chosen behaviour: a broken track is "the track did not download", so the
  // description still wins (`ok: true`). Only when there is no description either
  // does the call fail (`ok: false`).
  const withDescription = stubFetch({
    player: playerResponse({ description: 'Описание на месте', tracks: [captionTrack('ru')] }),
    trackBody: '{это не json',
  })
  const fallback = await fetchVideo({ url: 'https://youtu.be/abc12345678', fetchImpl: withDescription.fetchImpl, logger: silentLogger })
  assert.equal(fallback.ok, true)
  assert.equal(fallback.source, 'description')
  assert.equal(fallback.transcript, 'Описание на месте')

  const withoutDescription = stubFetch({
    player: playerResponse({ description: '', tracks: [captionTrack('ru')] }),
    trackBody: '{это не json',
  })
  const failed = await fetchVideo({ url: 'https://youtu.be/abc12345678', fetchImpl: withoutDescription.fetchImpl, logger: silentLogger })
  assert.equal(failed.ok, false)
  assert.match(failed.reason, /субтитры недоступны/)
})

test('fetchVideo truncates a transcript longer than maxChars and marks the cut', async () => {
  const body = json3([{ segs: [{ utf8: 'a'.repeat(500) }] }])
  const { fetchImpl } = stubFetch({ player: playerResponse({ tracks: [captionTrack('ru')] }), trackBody: body })

  const result = await fetchVideo({ url: 'https://youtu.be/abc12345678', fetchImpl, maxChars: 100, logger: silentLogger })

  assert.equal(result.ok, true)
  assert.equal(result.transcript.length, 100 + '… (сокращено)'.length)
  assert.ok(result.transcript.startsWith('a'.repeat(100)))
  assert.ok(result.transcript.endsWith('… (сокращено)'))
  assert.ok(result.transcript.length < 500)
})

test('fetchVideo truly joins segments, drops empty ones and flattens newlines', async () => {
  const body = json3([
    { segs: [{ utf8: 'Привет' }, { utf8: 'мир\nвот' }, { utf8: '' }, { utf8: '   ' }] },
    { tStartMs: 100 },
    { segs: [{ utf8: ' Ещё' }, { utf8: 'раз  два' }] },
  ])
  const { fetchImpl } = stubFetch({ player: playerResponse({ tracks: [captionTrack('ru')] }), trackBody: body })

  const result = await fetchVideo({ url: 'https://youtu.be/abc12345678', fetchImpl, logger: silentLogger })

  assert.equal(result.transcript, 'Привет мир вот Ещё раз два')
  assert.ok(!result.transcript.includes('\n'))
})

test('fetchVideo reports a link without a usable id and does not call fetch', async () => {
  let called = false
  const fetchImpl = async () => {
    called = true
    throw new Error('must not be called')
  }

  const result = await fetchVideo({ url: 'посмотри это видео', fetchImpl, logger: silentLogger })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'не нашёл идентификатор видео в ссылке')
  assert.equal(result.videoId, undefined)
  assert.equal(called, false)

  assert.equal((await fetchVideo()).ok, false, 'a bare call is also a plain failure')
})

test('MAX_TRANSCRIPT_CHARS documents the default transcript budget', () => {
  assert.equal(MAX_TRANSCRIPT_CHARS, 12000)
})
