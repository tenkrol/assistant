import assert from 'node:assert/strict'
import test from 'node:test'
import { htmlToPlainText, markdownToTelegramHtml } from '../src/delivery/format.mjs'
import { splitForTelegram } from '../src/delivery/stream.mjs'

test('escapes markup that Telegram would otherwise parse', () => {
  const html = markdownToTelegramHtml('a < b & c > d <script>alert(1)</script>')
  assert.equal(html, 'a &lt; b &amp; c &gt; d &lt;script&gt;alert(1)&lt;/script&gt;')
})

test('converts fenced code with a language and keeps it escaped', () => {
  const html = markdownToTelegramHtml('до\n```js\nconst a = 1 < 2 && "x"\n```\nпосле')
  assert.match(html, /<pre><code class="language-js">const a = 1 &lt; 2 &amp;&amp; "x"<\/code><\/pre>/)
  assert.ok(html.startsWith('до\n'))
  assert.ok(html.endsWith('\nпосле'))
})

test('converts a fence without a language', () => {
  assert.equal(markdownToTelegramHtml('```\nplain\n```'), '<pre><code>plain</code></pre>')
})

test('converts inline code, bold, italic, strike, links, headings and bullets', () => {
  const html = markdownToTelegramHtml(['# Заголовок', '- пункт', '**жирный** и *курсив* и ~~зачёркнутый~~', '`код` и [ссылка](https://example.com/a?b=1)'].join('\n'))
  assert.match(html, /<b>Заголовок<\/b>/)
  assert.match(html, /• пункт/)
  assert.match(html, /<b>жирный<\/b>/)
  assert.match(html, /<i>курсив<\/i>/)
  assert.match(html, /<s>зачёркнутый<\/s>/)
  assert.match(html, /<code>код<\/code>/)
  assert.match(html, /<a href="https:\/\/example.com\/a\?b=1">ссылка<\/a>/)
})

test('does not italicise snake_case identifiers', () => {
  assert.equal(markdownToTelegramHtml('some_long_name and file_name.md'), 'some_long_name and file_name.md')
})

test('splits long text into chunks that respect the limit', () => {
  const markdown = Array.from({ length: 400 }, (_, i) => `Строка номер ${i} с довольно длинным содержимым для проверки разбиения.`).join('\n')
  const html = markdownToTelegramHtml(markdown)
  const chunks = splitForTelegram(html, 500)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(chunk.length <= 500, `chunk length ${chunk.length}`)
  assert.equal(htmlToPlainText(chunks.join('')).replace(/\s+/g, ' ').trim(), htmlToPlainText(html).replace(/\s+/g, ' ').trim())
})

test('reopens a code block that spans a chunk boundary', () => {
  const body = Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n')
  const chunks = splitForTelegram(markdownToTelegramHtml('```\n' + body + '\n```'), 300)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 300)
    assert.equal(count(chunk, '<pre>'), count(chunk, '</pre>'), chunk)
    assert.equal(count(chunk, '<code'), count(chunk, '</code>'), chunk)
  }
  assert.match(chunks[0], /^<pre><code>/)
  assert.match(chunks[chunks.length - 1], /<\/code><\/pre>$/)
})

test('returns no chunks for empty input and one chunk for a short message', () => {
  assert.deepEqual(splitForTelegram(''), [])
  assert.deepEqual(splitForTelegram('<b>привет</b>'), ['<b>привет</b>'])
})

test('hard-splits a single line longer than the limit', () => {
  const chunks = splitForTelegram('x'.repeat(250), 100)
  assert.equal(chunks.length, 3)
  for (const chunk of chunks) assert.ok(chunk.length <= 100)
  assert.equal(chunks.join(''), 'x'.repeat(250))
})

const count = (text, needle) => text.split(needle).length - 1

// Regression: a single tag longer than the limit used to make `room()` stay
// non-positive forever, so the flush loop never consumed input and the process
// died with an out-of-memory error.
test('survives an opening tag longer than the limit', { timeout: 10000 }, () => {
  const url = `https://e.co/${'a'.repeat(5000)}`
  const chunks = splitForTelegram(markdownToTelegramHtml(`[x](${url})`))
  assert.ok(chunks.length >= 1)
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 4096, `chunk length ${chunk.length}`)
    // The dropped opening tag must not leave its closing tag behind.
    assert.equal(count(chunk, '</a>'), count(chunk, '<a '), chunk.slice(0, 80))
  }
})

test('survives a tag longer than a tiny limit', { timeout: 10000 }, () => {
  const chunks = splitForTelegram(`<b>${'x'.repeat(100)}</b>`, 5)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 6, `chunk length ${chunk.length}`)
    assert.equal(count(chunk, '<b>'), count(chunk, '</b>'), chunk)
  }
})

test('never splits a surrogate pair', { timeout: 10000 }, () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/
  for (const limit of [3, 4, 5, 7, 10]) {
    for (const chunk of splitForTelegram('😀'.repeat(50), limit)) {
      assert.ok(!lone.test(chunk), `lone surrogate in ${JSON.stringify(chunk)}`)
    }
  }
})

test('escapes an unterminated code fence instead of mangling it', () => {
  assert.equal(markdownToTelegramHtml('```js\nconst a = 1 < 2'), '```js\nconst a = 1 &lt; 2')
})

test('renders bold around nested italic', () => {
  assert.equal(markdownToTelegramHtml('**bold *italic***'), '<b>bold <i>italic</i></b>')
  assert.equal(markdownToTelegramHtml('***важно***'), '<b><i>важно</i></b>')
})

test('keeps every chunk within the limit for a long code block', () => {
  const body = Array.from({ length: 400 }, (_, i) => `строка ${i} с текстом`).join('\n')
  const chunks = splitForTelegram(markdownToTelegramHtml('```\n' + body + '\n```'), 400)
  for (const chunk of chunks) assert.ok(chunk.length <= 400, `chunk length ${chunk.length}`)
})
