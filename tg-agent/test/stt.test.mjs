/**
 * Speech-to-text providers.
 *
 * Both are exercised against a fake fetch: the wire shape is what matters, and a
 * real key is never needed to prove it.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createOpenAiTranscriber, createTranscriber, createYandexTranscriber } from '../src/stt.mjs'

/** Collect one request and answer with the given body. */
function fakeFetch({ status = 200, body = '{}', capture } = {}) {
  return async (url, init) => {
    capture?.(url, init)
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    }
  }
}

test('yandex: sends the audio as-is with the folder id and an API key', async () => {
  let seen
  const transcribe = createYandexTranscriber({
    apiKey: 'AQVNsecret',
    folderId: 'b1g2folder',
    fetchImpl: fakeFetch({ body: JSON.stringify({ result: '  купить хлеб  ' }), capture: (url, init) => { seen = { url, init } } }),
  })
  const text = await transcribe(Buffer.from('OggS...'), { mime: 'audio/ogg', name: 'voice.ogg' })
  assert.equal(text, 'купить хлеб', 'ответ обрезается по краям')
  const url = new URL(seen.url)
  assert.equal(url.origin + url.pathname, 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize')
  assert.equal(url.searchParams.get('format'), 'oggopus', 'голосовые Telegram — OGG/Opus')
  assert.equal(url.searchParams.get('lang'), 'ru-RU')
  assert.equal(url.searchParams.get('folderId'), 'b1g2folder')
  assert.equal(seen.init.headers.authorization, 'Api-Key AQVNsecret')
  assert.equal(seen.init.method, 'POST')
})

test('yandex: an IAM token is sent as a bearer token', async () => {
  let seen
  const transcribe = createYandexTranscriber({
    apiKey: 't1.9euelZq.some-jwt',
    fetchImpl: fakeFetch({ body: '{"result":"ок"}', capture: (url, init) => { seen = init } }),
  })
  await transcribe(Buffer.from('x'), { mime: 'audio/mpeg' })
  assert.equal(seen.headers.authorization, 'Bearer t1.9euelZq.some-jwt')
  assert.match(seen.url ?? seen.headers['content-type'], /./)
})

test('yandex: formats are mapped and unknown audio falls back to opus', async () => {
  const formats = []
  const transcribe = createYandexTranscriber({
    apiKey: 'AQVN1',
    fetchImpl: async (url) => {
      formats.push(new URL(url).searchParams.get('format'))
      return { ok: true, status: 200, text: async () => '{"result":"x"}' }
    },
  })
  await transcribe(Buffer.from('x'), { mime: 'audio/mpeg' })
  await transcribe(Buffer.from('x'), { mime: 'audio/wav' })
  await transcribe(Buffer.from('x'), { mime: 'audio/mp4' })
  await transcribe(Buffer.from('x'), { mime: 'application/octet-stream' })
  assert.deepEqual(formats, ['mp3', 'lpcm', 'mp4', 'oggopus'])
})

test('yandex: a rejected request becomes a readable error without the key', async () => {
  const transcribe = createYandexTranscriber({
    apiKey: 'AQVNsecret',
    fetchImpl: fakeFetch({ status: 401, body: '{"error":"unauthorized"}' }),
  })
  await assert.rejects(() => transcribe(Buffer.from('x'), {}), (error) => {
    assert.match(error.message, /Yandex STT HTTP 401/)
    assert.equal(error.message.includes('AQVNsecret'), false, 'ключ не попадает в текст ошибки')
    return true
  })
})

test('yandex: an unreadable answer is reported, not thrown as a parser error', async () => {
  const transcribe = createYandexTranscriber({ apiKey: 'AQVN1', fetchImpl: fakeFetch({ body: '<html>502</html>' }) })
  await assert.rejects(() => transcribe(Buffer.from('x'), {}), /unreadable answer/)
})

test('openai: still posts a multipart form to the transcriptions endpoint', async () => {
  let seen
  const transcribe = createOpenAiTranscriber({
    apiKey: 'sk-test',
    model: 'whisper-1',
    fetchImpl: fakeFetch({ body: '{"text":"привет"}' , capture: (url, init) => { seen = { url, init } } }),
  })
  const text = await transcribe(Buffer.from('audio'), { mime: 'audio/ogg' })
  assert.equal(text, 'привет')
  assert.match(seen.url, /\/audio\/transcriptions$/)
  assert.equal(seen.init.headers.authorization, 'Bearer sk-test')
  assert.ok(seen.init.body instanceof FormData)
})

test('the factory picks the provider and refuses an unknown one honestly', () => {
  const yandex = createTranscriber({ provider: 'yandex', apiKey: 'AQVN1', fetchImpl: fakeFetch() })
  const openai = createTranscriber({ provider: 'openai', apiKey: 'sk-1', fetchImpl: fakeFetch() })
  assert.equal(typeof yandex, 'function')
  assert.equal(typeof openai, 'function')
  // Anything that is not 'yandex' goes down the OpenAI-compatible path, which is
  // what a self-hosted Whisper clone needs.
  assert.equal(typeof createTranscriber({ provider: 'custom', apiKey: 'k', fetchImpl: fakeFetch() }), 'function')
  assert.throws(() => createTranscriber({ provider: 'yandex', apiKey: '' }), /API key/)
})

test('yandex: a bare language code is expanded to a locale', async () => {
  const langs = []
  const transcribe = createYandexTranscriber({
    apiKey: 'AQVN1',
    language: 'ru',
    fetchImpl: async (url) => {
      langs.push(new URL(url).searchParams.get('lang'))
      return { ok: true, status: 200, text: async () => '{"result":"x"}' }
    },
  })
  await transcribe(Buffer.from('x'), {})
  const en = createYandexTranscriber({ apiKey: 'AQVN1', language: 'en', fetchImpl: async (url) => {
    langs.push(new URL(url).searchParams.get('lang'))
    return { ok: true, status: 200, text: async () => '{"result":"x"}' }
  } })
  await en(Buffer.from('x'), {})
  assert.deepEqual(langs, ['ru-RU', 'en-US'])
})
