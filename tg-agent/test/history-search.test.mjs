import assert from 'node:assert/strict'
import test from 'node:test'
import { SEARCH_HINT, formatSearchResults, searchMessages } from '../src/history-search.mjs'

/** Compact history builder: `['user', 'текст']` pairs, oldest first. */
const history = (...entries) => entries.map(([role, content]) => ({ role, content }))

test('rejects empty, blank and single-character queries', () => {
  const messages = history(['user', 'надо ремонт'], ['assistant', 'а'])
  assert.deepEqual(searchMessages(messages, ''), [])
  assert.deepEqual(searchMessages(messages, '   '), [])
  assert.deepEqual(searchMessages(messages, 'a'), [])
  assert.deepEqual(searchMessages(messages, ' я '), [])
  assert.deepEqual(searchMessages(messages, '!!!'), [])
  assert.deepEqual(searchMessages(messages, undefined), [])
  assert.deepEqual(searchMessages(messages, 42), [])
})

test('survives missing or broken input without throwing', () => {
  assert.deepEqual(searchMessages(undefined, 'ремонт'), [])
  assert.deepEqual(searchMessages(null, 'ремонт'), [])
  assert.deepEqual(searchMessages([], 'ремонт'), [])
  assert.deepEqual(searchMessages('not an array', 'ремонт'), [])
  assert.deepEqual(searchMessages({ 0: { role: 'user', content: 'ремонт' } }, 'ремонт'), [])
  assert.deepEqual(searchMessages([{ role: 'user', content: null }], 'ремонт'), [])
  assert.deepEqual(searchMessages([{ role: 'user', content: 42 }], 'ремонт'), [])
  assert.deepEqual(searchMessages([null, 42, 'строка'], 'ремонт'), [])
  const evil = {
    role: 'user',
    get content() {
      throw new Error('boom')
    },
  }
  assert.deepEqual(searchMessages([evil], 'ремонт'), [])
  // A broken entry must not hide a healthy one.
  const found = searchMessages([evil, { role: 'user', content: 'про ремонт' }], 'ремонт')
  assert.equal(found.length, 1)
  assert.equal(found[0].index, 1)
})

test('non-string content (attachments) is never found', () => {
  const messages = [
    { role: 'user', content: { type: 'photo', caption: 'ремонт' } },
    { role: 'user', content: ['ремонт'] },
    { role: 'user', content: null },
    { role: 'assistant', content: 'тут про ремонт' },
  ]
  const found = searchMessages(messages, 'ремонт')
  assert.equal(found.length, 1)
  assert.equal(found[0].index, 3)
})

test('orders exact phrase above all words above one word', () => {
  const messages = history(
    ['user', 'Только ремонт без второй темы'],
    ['assistant', 'Кухни обсудили, ремонт тоже'],
    ['user', 'Смета на ремонт кухни согласована'],
  )
  const found = searchMessages(messages, 'ремонт кухни')
  assert.deepEqual(found.map((entry) => entry.index), [2, 1, 0])
  assert.ok(found[0].score > found[1].score, 'phrase must beat scattered words')
  assert.ok(found[1].score > found[2].score, 'all words must beat one word')
})

test('word order does not matter for matching, but the phrase bonus needs order', () => {
  const messages = history(
    ['user', 'кухни ремонт'],
    ['user', 'ремонт кухни'],
  )
  const found = searchMessages(messages, 'ремонт кухни')
  assert.equal(found.length, 2)
  // Both contain both words; the ordered one gets the phrase bonus, so it is
  // first even though it is older (index 0 vs 1).
  assert.equal(found[0].index, 1)
  assert.ok(found[0].score > found[1].score)
})

test('matches Russian morphology by prefix', () => {
  const messages = history(
    ['user', 'говорили о ремонте'],
    ['assistant', 'занимались ремонтом'],
    ['user', 'ремонтный завод рядом'],
    ['assistant', 'совсем о другом'],
  )
  const found = searchMessages(messages, 'ремонт')
  assert.deepEqual(found.map((entry) => entry.index).sort(), [0, 1, 2])
})

test('a query is not matched if it is not a prefix: купить does not find купил', () => {
  const messages = history(
    ['user', 'решили купить стол'],
    ['assistant', 'он уже купил стол'],
  )
  const found = searchMessages(messages, 'купить')
  assert.deepEqual(found.map((entry) => entry.index), [0])
})

test('окно finds окна but not около (final-vowel rule, no false stem)', () => {
  const messages = history(
    ['user', 'поставили новое окна в зале'],
    ['assistant', 'магазин около дома'],
    ['user', 'окно открыто'],
  )
  const found = searchMessages(messages, 'окно')
  assert.deepEqual(found.map((entry) => entry.index).sort(), [0, 2])
  assert.ok(!found.some((entry) => entry.index === 1), 'около must not match окно')
})

test('short query words match exactly, not by prefix', () => {
  const messages = history(
    ['user', 'мы пошли'],
    ['assistant', 'мысль интересная'],
    ['user', 'около дома'],
  )
  assert.deepEqual(searchMessages(messages, 'мы').map((entry) => entry.index), [0])
  assert.deepEqual(searchMessages(messages, 'ок').map((entry) => entry.index), [])
})

test('matching is case-insensitive', () => {
  const messages = history(['user', 'Начали Ремонт в зале'])
  const lower = searchMessages(messages, 'ремонт')
  const upper = searchMessages(messages, 'Ремонт')
  assert.equal(lower.length, 1)
  assert.deepEqual(lower.map((entry) => entry.score), upper.map((entry) => entry.score))
})

test('ё and е are the same letter in both directions', () => {
  const messages = history(['user', 'нарядили ёлка дома'], ['assistant', 'елка в углу'])
  assert.deepEqual(searchMessages(messages, 'елка').map((entry) => entry.index).sort(), [0, 1])
  assert.deepEqual(searchMessages(messages, 'Ёлка').map((entry) => entry.index).sort(), [0, 1])
  assert.deepEqual(searchMessages(messages, 'ёлка').map((entry) => entry.index).sort(), [0, 1])
})

test('a message with all query words is found; minScore can drop partial matches', () => {
  const messages = history(
    ['user', 'про ремонт ничего больше'],
    ['assistant', 'ремонт кухни закончен'],
  )
  const all = searchMessages(messages, 'ремонт кухни')
  assert.equal(all.length, 2)
  assert.equal(all[0].index, 1)
  const strict = searchMessages(messages, 'ремонт кухни', { minScore: 150 })
  assert.deepEqual(strict.map((entry) => entry.index), [1])
})

test('sorts equal scores newest first and respects limit', () => {
  const messages = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `ремонт номер ${i}` }))
  const found = searchMessages(messages, 'ремонт')
  assert.equal(found.length, 5)
  assert.deepEqual(found.map((entry) => entry.index), [5, 4, 3, 2, 1])
  assert.deepEqual(searchMessages(messages, 'ремонт', { limit: 2 }).map((entry) => entry.index), [5, 4])
  assert.deepEqual(searchMessages(messages, 'ремонт', { limit: 0 }), [])
  assert.equal(searchMessages(messages, 'ремонт', { limit: Number.NaN }).length, 5)
})

test('context gives neighbours, and edges have empty sides', () => {
  const messages = history(
    ['user', 'ремонт обсуждали'],
    ['assistant', 'да, вчера'],
    ['user', 'а что с окнами'],
  )
  const first = searchMessages(messages, 'ремонт')[0]
  assert.equal(first.index, 0)
  assert.deepEqual(first.before, [])
  assert.deepEqual(first.after, ['да, вчера'])

  const last = searchMessages(messages, 'окнами')[0]
  assert.equal(last.index, 2)
  assert.deepEqual(last.before, ['да, вчера'])
  assert.deepEqual(last.after, [])

  const middle = searchMessages(messages, 'вчера')[0]
  assert.deepEqual(middle.before, ['ремонт обсуждали'])
  assert.deepEqual(middle.after, ['а что с окнами'])
})

test('context can span several neighbours and skips non-text ones', () => {
  const messages = [
    { role: 'user', content: 'первое' },
    { role: 'user', content: { type: 'photo' } },
    { role: 'user', content: 'третье' },
    { role: 'assistant', content: 'ищем ремонт' },
    { role: 'user', content: 'четвёртое' },
  ]
  const [found] = searchMessages(messages, 'ремонт', { context: 3 })
  assert.deepEqual(found.before, ['первое', 'третье'])
  assert.deepEqual(found.after, ['четвёртое'])
  const [noContext] = searchMessages(messages, 'ремонт', { context: 0 })
  assert.deepEqual(noContext.before, [])
  assert.deepEqual(noContext.after, [])
})

test('long messages are truncated around the match', () => {
  const long = `${'подготовка к работам '.repeat(60)}финальный ремонт`
  const [found] = searchMessages([{ role: 'user', content: long }], 'ремонт')
  assert.equal(found.truncated, true)
  assert.ok(found.text.length <= 600, `length ${found.text.length}`)
  assert.match(found.text, /ремонт/)
  assert.ok(found.text.startsWith('…'))

  const [short] = searchMessages([{ role: 'user', content: 'короткий ремонт' }], 'ремонт')
  assert.equal(short.truncated, false)
  assert.equal(short.text, 'короткий ремонт')

  const [custom] = searchMessages([{ role: 'user', content: long }], 'ремонт', { maxTextChars: 50 })
  assert.ok(custom.text.length <= 50, `length ${custom.text.length}`)
  assert.match(custom.text, /ремонт/)
})

test('context neighbours are capped by maxContextChars', () => {
  const neighbor = 'н'.repeat(500)
  const messages = [
    { role: 'user', content: neighbor },
    { role: 'assistant', content: 'ремонт' },
  ]
  const [found] = searchMessages(messages, 'ремонт', { maxContextChars: 20 })
  assert.equal(found.before.length, 1)
  assert.ok(found.before[0].length <= 20, `length ${found.before[0].length}`)
  assert.ok(found.before[0].endsWith('…'))
})

test('system role participates and does not change the score', () => {
  const asUser = [{ role: 'user', content: 'напоминание про ремонт' }]
  const asSystem = [{ role: 'system', content: 'напоминание про ремонт' }]
  const user = searchMessages(asUser, 'ремонт')
  const system = searchMessages(asSystem, 'ремонт')
  assert.equal(user.length, 1)
  assert.equal(system.length, 1)
  assert.equal(system[0].role, 'system')
  assert.equal(system[0].score, user[0].score)
})

test('results carry index, role, text, timestamp, score and truncated', () => {
  const at = '2026-10-09T14:20:00+03:00'
  const [found] = searchMessages([{ role: 'assistant', content: 'про ремонт', at }], 'ремонт')
  assert.deepEqual(
    Object.keys(found).sort(),
    ['after', 'at', 'before', 'index', 'role', 'score', 'text', 'truncated'].sort(),
  )
  assert.equal(found.index, 0)
  assert.equal(found.role, 'assistant')
  assert.equal(found.text, 'про ремонт')
  assert.equal(found.at, at)
  assert.equal(found.truncated, false)
  assert.ok(found.score > 0)
})

test('SEARCH_HINT tells the model when to search the history', () => {
  assert.equal(typeof SEARCH_HINT, 'string')
  assert.ok(SEARCH_HINT.length > 40)
  assert.match(SEARCH_HINT, /раньше|прошл/i)
  assert.match(SEARCH_HINT, /истори/i)
})

test('formatSearchResults reports an empty search', () => {
  assert.equal(
    formatSearchResults([], { query: 'ремонт' }),
    'По запросу «ремонт» ничего не нашлось в нашей переписке.',
  )
  assert.equal(
    formatSearchResults(undefined, { query: '  ремонт  ' }),
    'По запросу «ремонт» ничего не нашлось в нашей переписке.',
  )
  assert.match(formatSearchResults([], {}), /По запросу «» ничего не нашлось/)
})

test('formatSearchResults renders one result with a timestamp and bold match', () => {
  const messages = [{ role: 'user', content: 'Начали Ремонт', at: '2026-10-09T14:20:00+03:00' }]
  const found = searchMessages(messages, 'ремонт')
  const text = formatSearchResults(found, { query: 'ремонт' })
  assert.equal(text, '1. [Вы, 09.10 14:20] Начали **Ремонт**')
})

test('formatSearchResults labels the assistant, handles missing time and zones', () => {
  const assistant = searchMessages([{ role: 'assistant', content: 'про ремонт' }], 'ремонт')
  assert.equal(formatSearchResults(assistant, { query: 'ремонт' }), '1. [Бот] про **ремонт**')

  const badTime = searchMessages([{ role: 'user', content: 'про ремонт', at: 'не дата' }], 'ремонт')
  assert.equal(formatSearchResults(badTime, { query: 'ремонт' }), '1. [Вы] про **ремонт**')

  const midnight = searchMessages([{ role: 'user', content: 'ремонт', at: '2026-10-09T00:30:00Z' }], 'ремонт')
  assert.match(formatSearchResults(midnight, { query: 'ремонт', timeZone: 'UTC' }), /09\.10 00:30/)
  assert.match(formatSearchResults(midnight, { query: 'ремонт', timeZone: 'Europe/Moscow' }), /09\.10 03:30/)
  // An unknown zone falls back instead of throwing.
  assert.match(formatSearchResults(midnight, { query: 'ремонт', timeZone: 'Nowhere/Zone' }), /09\.10/)
})

test('formatSearchResults accepts epoch seconds and milliseconds', () => {
  const ms = Date.parse('2026-10-09T14:20:00+03:00')
  const asMs = searchMessages([{ role: 'user', content: 'ремонт', at: ms }], 'ремонт')
  const asSeconds = searchMessages([{ role: 'user', content: 'ремонт', at: Math.floor(ms / 1000) }], 'ремонт')
  assert.equal(
    formatSearchResults(asMs, { query: 'ремонт' }),
    formatSearchResults(asSeconds, { query: 'ремонт' }),
  )
})

test('formatSearchResults keeps the reply bounded and counts the rest', () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `ремонт этап ${i} ${'подробности '.repeat(10)}`,
  }))
  const found = searchMessages(messages, 'ремонт', { limit: 40 })
  const text = formatSearchResults(found, { query: 'ремонт' })
  assert.ok(text.length <= 3000, `length ${text.length}`)
  assert.match(text, /… \(ещё \d+ совпадени/)
  assert.match(text, /^1\. \[/)
  assert.ok(found.length > text.split('\n').length, 'some results must have been dropped')
})

test('formatSearchResults marks several results and numbers them', () => {
  const messages = history(
    ['user', 'ремонт начали'],
    ['assistant', 'ремонт закончили'],
  )
  const found = searchMessages(messages, 'ремонт')
  const text = formatSearchResults(found, { query: 'ремонт' })
  const lines = text.split('\n')
  assert.equal(lines.length, 2)
  // Equal scores, so the newer message (the assistant's) is listed first.
  assert.match(lines[0], /^1\. \[Бот\] \*\*ремонт\*\*/)
  assert.match(lines[1], /^2\. \[Вы\] \*\*ремонт\*\*/)
})
