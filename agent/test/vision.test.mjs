import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sniffImageMime, VisionClient } from '../src/vision.mjs'
import { createTestLogger } from './helpers.mjs'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])

/** A fetch stub that records the request and answers with `body`. */
function stubFetch({ ok = true, status = 200, body = {}, text } = {}) {
  const calls = []
  const impl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) })
    return {
      ok,
      status,
      text: async () => (text !== undefined ? text : JSON.stringify(body)),
    }
  }
  impl.calls = calls
  return impl
}

test('a disabled client reports why instead of calling out', async () => {
  const client = new VisionClient({ apiKey: '' })
  assert.equal(client.enabled, false)
  const result = await client.describe({ bytes: PNG })
  assert.equal(result.text, '')
  assert.match(result.error, /отключён/)
})

test('a successful call returns the description and its tokens', async () => {
  const fetchImpl = stubFetch({
    body: {
      choices: [{ message: { role: 'assistant', content: 'KOD-42' } }],
      usage: { prompt_tokens: 197, completion_tokens: 4, prompt_cache_hit_tokens: 0 },
    },
  })
  const client = new VisionClient({ apiKey: 'sk-test', fetchImpl, logger: createTestLogger() })
  const result = await client.describe({ bytes: PNG, mime: 'image/png' })

  assert.equal(result.text, 'KOD-42')
  assert.equal(result.usage.prompt_tokens, 197)
  assert.equal(result.usage.completion_tokens, 4)

  const [call] = fetchImpl.calls
  assert.equal(call.url, 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(call.options.headers.authorization, 'Bearer sk-test')
  assert.equal(call.body.model, 'deepseek-chat')
  const content = call.body.messages[0].content
  assert.equal(content[0].type, 'text')
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/)
})

test('the image mime is sniffed when the caller does not know it', async () => {
  const fetchImpl = stubFetch({ body: { choices: [{ message: { content: 'ок' } }] } })
  await new VisionClient({ apiKey: 'sk-test', fetchImpl }).describe({ bytes: PNG })
  assert.match(fetchImpl.calls[0].body.messages[0].content[1].image_url.url, /^data:image\/png;/)
})

test('a provider error comes back as an error, not an exception', async () => {
  const fetchImpl = stubFetch({ ok: false, status: 401, body: { error: { message: 'Invalid API key' } } })
  const result = await new VisionClient({ apiKey: 'sk-bad', fetchImpl }).describe({ bytes: PNG })
  assert.equal(result.text, '')
  assert.match(result.error, /Invalid API key/)
})

test('a network failure is reported, not thrown', async () => {
  const client = new VisionClient({
    apiKey: 'sk-test',
    fetchImpl: async () => {
      throw new Error('fetch failed')
    },
  })
  const result = await client.describe({ bytes: PNG })
  assert.equal(result.text, '')
  assert.match(result.error, /не удалось обратиться к модели/)
})

test('a non-JSON answer is reported with its status', async () => {
  const result = await new VisionClient({ apiKey: 'sk-test', fetchImpl: stubFetch({ text: '<html>502</html>', ok: false, status: 502 }) })
    .describe({ bytes: PNG })
  assert.match(result.error, /не-JSON/)
})

test('an empty description is a failure, so OCR can take over', async () => {
  const fetchImpl = stubFetch({ body: { choices: [{ message: { content: '' } }], usage: { prompt_tokens: 10, completion_tokens: 0 } } })
  const result = await new VisionClient({ apiKey: 'sk-test', fetchImpl }).describe({ bytes: PNG })
  assert.equal(result.text, '')
  assert.match(result.error, /не дала описания/)
  assert.equal(result.usage.prompt_tokens, 10)
})

test('an empty file is refused before any request', async () => {
  const fetchImpl = stubFetch()
  const result = await new VisionClient({ apiKey: 'sk-test', fetchImpl }).describe({ bytes: Buffer.alloc(0) })
  assert.match(result.error, /пустой файл/)
  assert.equal(fetchImpl.calls.length, 0)
})

test('image types are sniffed from magic bytes', () => {
  assert.equal(sniffImageMime(PNG), 'image/png')
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniffImageMime(Buffer.from('GIF89a')), 'image/gif')
  assert.equal(sniffImageMime(Buffer.from('RIFF____WEBPVP8 ')), 'image/webp')
  assert.equal(sniffImageMime(Buffer.from([1, 2, 3])), 'image/jpeg')
})
