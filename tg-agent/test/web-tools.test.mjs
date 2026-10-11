import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { assertPublicUrl, createWebTools, htmlToText, WebToolError } from '../src/web-tools.mjs'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

/** Stub for the Anthropic-compatible Messages endpoint DeepSeek exposes. */
async function createSearchStub({ body, status = 200 } = {}) {
  const state = { requests: [] }
  const server = http.createServer(async (request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    await new Promise((resolve) => request.on('end', resolve))
    state.requests.push({ headers: request.headers, body: JSON.parse(raw || '{}') })
    const payload = JSON.stringify(body ?? searchBody())
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    response.end(payload)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    state,
    baseUrl: `http://127.0.0.1:${server.address().port}/anthropic/v1`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}

/** Stub page server for `web_fetch`. */
async function createPageStub({ body = '<html><body>привет</body></html>', status = 200, contentType = 'text/html' } = {}) {
  const state = { requests: [] }
  const server = http.createServer((request, response) => {
    state.requests.push({ url: request.url, headers: request.headers })
    response.writeHead(status, { 'content-type': contentType })
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}/page`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}

/** The documented DeepSeek response shape: result blocks plus a cited summary. */
function searchBody() {
  return {
    content: [
      { type: 'thinking', thinking: 'ищу погоду' },
      { type: 'server_tool_use', name: 'web_search' },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://yandex.ru/pogoda/moscow', title: 'Погода в Москве', page_age: '2026-10-05' },
          { type: 'web_search_result', url: 'https://example.com/weather', title: 'Прогноз', page_age: '2026-10-05' },
          { type: 'web_search_result', url: 'https://example.com/weather', title: 'Дубликат' },
        ],
      },
      {
        type: 'text',
        text: 'Сейчас в Москве +19 °C.',
        citations: [{ url: 'https://yandex.ru/pogoda/moscow', cited_text: 'Москва, +19 °C, облачно' }],
      },
    ],
  }
}

test('web_search asks the provider correctly and flattens its results', async () => {
  const stub = await createSearchStub()
  const tools = createWebTools({ apiKey: 'sk-test', searchBaseUrl: stub.baseUrl, searchModel: 'deepseek-v4-flash', maxUses: 2, logger: silentLogger })
  try {
    const output = await tools.execute('web_search', { query: 'погода в Москве' })
    assert.match(output, /Сейчас в Москве \+19 °C\./)
    assert.match(output, /Источники \(2\): 3|Источники \(3\):/)
    assert.match(output, /https:\/\/yandex\.ru\/pogoda\/moscow/)
    assert.match(output, /Москва, \+19 °C, облачно/)
    assert.match(output, /2026-10-05/)
    // A duplicated URL is reported once.
    assert.equal(output.split('https://example.com/weather').length - 1, 1)

    const [request] = stub.state.requests
    assert.equal(request.headers['x-api-key'], 'sk-test')
    assert.equal(request.headers['anthropic-version'], '2023-06-01')
    assert.equal(request.body.model, 'deepseek-v4-flash')
    assert.deepEqual(request.body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }])
    assert.match(request.body.messages[0].content[0].text, /Perform a web search for the query: погода в Москве/)
  } finally {
    await stub.close()
  }
})

test('web_search reports a provider failure to the model instead of throwing', async () => {
  const stub = await createSearchStub({ status: 500, body: { error: 'boom' } })
  try {
    const tools = createWebTools({ apiKey: 'sk-test', searchBaseUrl: stub.baseUrl, logger: silentLogger })
    const output = await tools.execute('web_search', { query: 'x' })
    assert.match(output, /Ошибка инструмента web_search/)
    assert.match(output, /HTTP 500/)
  } finally {
    await stub.close()
  }
})

test('web_search asks for a query', async () => {
  const tools = createWebTools({ apiKey: 'sk-test', searchBaseUrl: 'http://127.0.0.1:1', logger: silentLogger })
  assert.match(await tools.execute('web_search', {}), /needs a query/)
})

test('unknown tools are reported to the model', async () => {
  const tools = createWebTools({ apiKey: 'sk-test', logger: silentLogger })
  assert.match(await tools.execute('shell', {}), /не поддерживается/)
})

test('web_fetch returns readable text without markup or scripts', async () => {
  const page = '<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><h1>Заголовок</h1><p>Текст &amp; ещё &lt;тег&gt;</p></body></html>'
  const stub = await createPageStub({ body: page })
  try {
    const tools = createWebTools({ apiKey: 'sk-test', allowedHosts: ['127.0.0.1'], logger: silentLogger })
    const output = await tools.execute('web_fetch', { url: stub.url })
    assert.match(output, /Заголовок/)
    assert.match(output, /Текст & ещё <тег>/)
    assert.ok(!output.includes('alert(1)'), 'script body must not survive')
    assert.ok(!output.includes('color:red'), 'style body must not survive')
    assert.match(stub.state.requests[0].headers['user-agent'], /tg-agent/)
  } finally {
    await stub.close()
  }
})

test('web_fetch caps the bytes it reads', async () => {
  const stub = await createPageStub({ body: `<html><body>${'a'.repeat(50_000)}</body></html>` })
  try {
    const tools = createWebTools({ apiKey: 'sk-test', maxFetchBytes: 1000, allowedHosts: ['127.0.0.1'], logger: silentLogger })
    const output = await tools.execute('web_fetch', { url: stub.url })
    assert.ok(output.length < 1200, `length ${output.length}`)
  } finally {
    await stub.close()
  }
})

test('web_fetch shortens a text longer than the model budget', async () => {
  const stub = await createPageStub({ body: `<html><body>${'a'.repeat(5000)}</body></html>` })
  try {
    const tools = createWebTools({ apiKey: 'sk-test', allowedHosts: ['127.0.0.1'], logger: silentLogger })
    const output = await tools.execute('web_fetch', { url: stub.url })
    assert.equal(output.length, 3001)
    assert.ok(output.endsWith('…'))
  } finally {
    await stub.close()
  }
})

test('web_fetch reports a non-200 response', async () => {
  const stub = await createPageStub({ status: 404, body: 'нет' })
  try {
    const tools = createWebTools({ apiKey: 'sk-test', allowedHosts: ['127.0.0.1'], logger: silentLogger })
    assert.match(await tools.execute('web_fetch', { url: stub.url }), /HTTP 404/)
  } finally {
    await stub.close()
  }
})

// The bot runs next to the DSH GUI on loopback; a model-supplied URL must never
// reach it, nor any other private address.
test('web_fetch refuses private addresses and non-http schemes', () => {
  for (const url of [
    'http://127.0.0.1:19387/',
    'http://localhost/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://router.local/',
    'file:///etc/passwd',
    'ftp://example.com/',
    'not a url',
  ]) {
    assert.throws(() => assertPublicUrl(url), WebToolError, `expected refusal for ${url}`)
  }
  assert.equal(assertPublicUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1')
})

test('htmlToText keeps paragraph breaks and decodes entities', () => {
  const text = htmlToText('<div>первый</div><div>второй</div><p>a &nbsp; b &quot;c&quot;</p>')
  assert.match(text, /первый/)
  assert.match(text, /второй/)
  assert.match(text, /a\s+b "c"/, text)
  assert.ok(text.includes('\n'), 'block elements become line breaks')
})
