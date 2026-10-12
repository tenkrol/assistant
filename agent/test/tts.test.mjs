/**
 * Speech synthesis for voice answers.
 *
 * The wire shape is what matters: SpeechKit takes the text as a form body, the
 * key in an `Api-Key` header and returns OGG/Opus, which Telegram plays as is.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createSynthesizer, speechText } from '../src/tts.mjs'

/** Capture one request and answer with fake audio. */
function fakeFetch({ status = 200, capture } = {}) {
  return async (url, init) => {
    capture?.(url, init)
    return {
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: async () => new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]).buffer,
      text: async () => 'synthesis failed',
    }
  }
}

test('the answer is posted as a form body with the SpeechKit key', async () => {
  let seen
  const speak = createSynthesizer({
    apiKey: 'AQVNsecret',
    voice: 'filipp',
    speed: 1.2,
    fetchImpl: fakeFetch({ capture: (url, init) => { seen = { url, init } } }),
  })
  const bytes = await speak('Привет, это ответ.')
  assert.ok(Buffer.isBuffer(bytes))
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'OggS', 'на выходе OGG/Opus')
  const url = new URL(seen.url)
  assert.equal(url.origin + url.pathname, 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize')
  assert.equal(url.searchParams.get('voice'), 'filipp')
  assert.equal(url.searchParams.get('format'), 'oggopus')
  assert.equal(url.searchParams.get('lang'), 'ru-RU')
  assert.equal(url.searchParams.get('speed'), '1.2')
  assert.equal(seen.init.headers.authorization, 'Api-Key AQVNsecret')
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.body.get('text'), 'Привет, это ответ.')
})

test('markdown, links and code are turned into speakable text', () => {
  assert.equal(speechText('**Готово** ✅ Напоминание №11'), 'Готово ✅ Напоминание №11')
  assert.equal(speechText('Смотри [документацию](https://example.com)'), 'Смотри документацию')
  assert.equal(speechText('Вот ссылка https://ya.ru/page тут'), 'Вот ссылка ссылка тут')
  assert.match(speechText('Код:\n```js\nconst a = 1\n```\nдальше текст'), /код пропущен/)
  assert.equal(speechText('', 100), '')
  const long = speechText('слово '.repeat(200), 60)
  assert.ok(long.length < 120, `обрезано: ${long.length}`)
  assert.match(long, /Дальше — текстом\.$/)
})

test('a failed synthesis is a readable error without the key', async () => {
  const speak = createSynthesizer({ apiKey: 'AQVNsecret', fetchImpl: fakeFetch({ status: 401 }) })
  await assert.rejects(() => speak('привет'), (error) => {
    assert.match(error.message, /TTS HTTP 401/)
    assert.equal(error.message.includes('AQVNsecret'), false)
    return true
  })
})

test('empty text is refused before any request', async () => {
  let called = false
  const speak = createSynthesizer({ apiKey: 'AQVN1', fetchImpl: async () => { called = true; return fakeFetch()() } })
  // Only whitespace is nothing to say; a code-only answer becomes the honest
  // skip marker instead of reading the code aloud.
  await assert.rejects(() => speak('   \n  '), /nothing to say/)
  assert.equal(called, false)
  assert.equal(speechText('```js\nconst a = 1\n```'), '(код пропущен)')
})

test('a key is required', () => {
  assert.throws(() => createSynthesizer({ apiKey: '' }), /API key/)
})
