/**
 * Реестр инструментов: единый список схем и диспетчер.
 *
 * Здесь проверяется главное обещание изменения: модели видны те же инструменты,
 * что и раньше, а неизвестное имя или сбой инструмента дают понятный текст, а не
 * исключение. Конкретные инструменты проверяются в своих тестах.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createToolRegistry } from '../src/tools/registry.mjs'

/** Имена, которые ядро собирало вручную до переезда в реестр. */
const BUILTIN = ['remind', 'remember', 'file', 'event', 'poll', 'youtube', 'server', 'sendto', 'find_history']

/** Схема инструмента в формате OpenAI. */
const definition = (name) => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
})

/** Простой инструмент с заранее заданным результатом. */
const fakeTool = (name, extra = {}) => ({
  definition: definition(name),
  async executeDetailed() {
    return { text: `${name} сработал`, ...extra }
  },
})

/** Зависимости, повторяющие полный набор инструментов бота. */
function build({ webTools, agentBridge, domains, sendText } = {}) {
  const sends = []
  const registry = createToolRegistry({
    config: { time: { timeZone: 'Europe/Moscow' } },
    domains: domains ?? { profiles: { namesOf: () => ({ 1: 'Аня' }), cityOf: () => 'Москва' } },
    reminders: { tool: fakeTool('remind', { reminder: { id: '1' } }) },
    profiles: { tool: fakeTool('remember') },
    files: fakeTool('file', { file: { fileName: 'файл.txt' } }),
    events: { tool: fakeTool('event') },
    polls: { tool: fakeTool('poll', { poll: { id: '1', chatId: 555, question: 'Куда?', options: [{ text: 'Лес', votes: [1] }] } }) },
    youtube: fakeTool('youtube'),
    server: fakeTool('server'),
    history: { messages: () => [] },
    contacts: { search: () => [], list: () => [] },
    sendText: sendText ?? (async (...args) => { sends.push(args); return { messageId: 1 } }),
    ...(webTools ? { webTools } : {}),
    ...(agentBridge ? { agentBridge } : {}),
  })
  return { registry, sends }
}

test('реестр отдаёт модели весь прежний набор инструментов', () => {
  const { registry } = build()
  const names = registry.definitions.map((entry) => entry.function.name)
  // 785 тестов и ручной список в bot.mjs знали ровно эти девять имён.
  assert.equal(registry.definitions.length, BUILTIN.length)
  assert.deepEqual(names, BUILTIN)
  for (const name of BUILTIN) assert.ok(registry.has(name), `${name} должен быть в реестре`)
})

test('web- и agent-инструменты добавляются к набору, не теряя встроенные', () => {
  const webTools = {
    definitions: [definition('web_search'), definition('web_fetch'), definition('weather')],
    async execute(name) { return `${name} web` },
  }
  const agentBridge = { enabled: true, definitions: [definition('ask_agent')], async execute() { return 'агенту передано' } }
  const { registry } = build({ webTools, agentBridge })
  const names = registry.definitions.map((entry) => entry.function.name)
  assert.deepEqual(names, ['web_search', 'web_fetch', 'weather', 'ask_agent', ...BUILTIN])
  assert.equal(registry.definitions.length, BUILTIN.length + 4)
})

test('неизвестное имя инструмента возвращает текст, а не исключение', async () => {
  const { registry } = build()
  const text = await registry.executeTool('нет_такого', {}, { chatId: 555 })
  assert.equal(typeof text, 'string')
  assert.match(text, /не поддерживается/)
  assert.match(text, /нет_такого/)
})

test('сбой инструмента становится понятным текстом', async () => {
  const registry = createToolRegistry({
    config: { time: { timeZone: 'Europe/Moscow' } },
    files: {
      definition: definition('file'),
      async executeDetailed() { throw new Error('нет места на диске') },
    },
    sendText: async () => ({ messageId: 1 }),
  })
  const text = await registry.executeTool('file', { format: 'xlsx' }, { chatId: 555 })
  assert.match(text, /Ошибка инструмента file/)
  assert.match(text, /нет места на диске/)
})

test('результат инструмента доходит до ядра через onResult', async () => {
  const { registry } = build()
  const outcomes = []
  const context = { chatId: 555, userId: 777, onResult: (outcome) => outcomes.push(outcome) }
  assert.equal(await registry.executeTool('remind', { text: 'чай' }, context), 'remind сработал')
  assert.equal(await registry.executeTool('file', { format: 'txt' }, context), 'file сработал')
  assert.equal(outcomes.find((entry) => entry.name === 'remind').reminder.id, '1')
  assert.equal(outcomes.find((entry) => entry.name === 'file').file.fileName, 'файл.txt')
})

test('опрос отправляется в чат с кнопками и именами голосующих', async () => {
  const sends = []
  const { registry } = build({
    sendText: async (...args) => { sends.push(args); return { messageId: 1 } },
  })
  await registry.executeTool('poll', { question: 'Куда?', options: ['Лес', 'Река'] }, { chatId: 555, replyTo: 7 })
  assert.equal(sends.length, 1)
  const [chatId, markdown, replyTo, keyboard] = sends[0]
  assert.equal(chatId, 555)
  assert.equal(replyTo, 7)
  assert.match(markdown, /Аня/)
  assert.equal(keyboard.rows.length, 1)
})

test('поиск по истории получает ключ чата и возвращает текст', async () => {
  const registry = createToolRegistry({
    config: { time: { timeZone: 'Europe/Moscow' } },
    history: {
      messages: (chatKey) => (chatKey === '555'
        ? [{ role: 'user', content: 'обсуждали ремонт кухни' }, { role: 'assistant', content: 'записал' }]
        : []),
    },
  })
  const text = await registry.executeTool('find_history', { query: 'ремонт' }, { chatId: 555 })
  assert.equal(typeof text, 'string')
  assert.match(text, /ремонт/)
})

test('город по умолчанию подставляется только в личном чате', async () => {
  const calls = []
  const webTools = {
    definitions: [definition('weather')],
    async execute(name, args) { calls.push(args); return 'Москва: +9' },
  }
  const { registry } = build({ webTools })
  await registry.executeTool('weather', {}, { chatId: 555, userId: 777 })
  await registry.executeTool('weather', {}, { chatId: -100, userId: 777, isGroup: true })
  assert.equal(calls[0].city, 'Москва')
  assert.equal(calls[1].city, undefined)
})
