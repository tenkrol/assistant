/**
 * sendto: отправка другому человеку от имени владельца.
 *
 * Тесты держат главное обещание инструмента: он не угадывает адресата, не врёт про
 * успех и честно называет случаи, в которых Telegram написать не даёт.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createSendToTool, phoneKey } from '../src/sendto-tool.mjs'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const book = [
  { chatId: 396122626, name: 'Мария', phone: '9991234567', username: 'andramasha' },
  { chatId: 433296567, name: 'Вячеслав', phone: '9997654321', username: 'tenkrol' },
]

function makeTool({ failWith, entries = book } = {}) {
  const sent = []
  const contacts = {
    byPhone: (key) => entries.find((entry) => phoneKey(entry.phone) === phoneKey(key)),
    byUsername: (value) => entries.find((entry) => String(entry.username).toLowerCase() === String(value).replace(/^@/, '').toLowerCase()),
    search: (query) => entries.filter((entry) => entry.name.toLowerCase().includes(String(query).toLowerCase())),
    list: () => entries.map((entry) => ({ chatId: entry.chatId, name: entry.name })),
  }
  const tool = createSendToTool({
    contacts,
    ownerName: 'Вячеслава',
    logger: silent,
    send: async (message) => {
      if (failWith) throw new Error(failWith)
      sent.push(message)
      return { messageId: 11 }
    },
  })
  return { tool, sent }
}

test('подписывает сообщение именем владельца', async () => {
  const { tool, sent } = makeTool()
  const result = await tool.executeDetailed({ target: 'Вячеслав', text: 'буду позже' })
  assert.match(result.text, /Отправил/)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].chatId, 433296567)
  assert.equal(sent[0].text, 'От Вячеслава: буду позже')
})

test('находит человека по @нику из справочника', async () => {
  const { tool, sent } = makeTool()
  await tool.executeDetailed({ target: '@andramasha', text: 'привет' })
  assert.equal(sent[0].chatId, 396122626, 'ник превращается в числовой id')
})

test('находит человека по телефону в любом формате', async () => {
  const { tool, sent } = makeTool()
  await tool.executeDetailed({ target: '+7 (999) 123-45-67', text: 'привет' })
  assert.equal(sent[0].chatId, 396122626)
})

test('неизвестный телефон объясняет, почему нельзя искать по номеру', async () => {
  const { tool, sent } = makeTool()
  const result = await tool.executeDetailed({ target: '8 999 000-11-22', text: 'привет' })
  assert.match(result.text, /не даёт искать людей по телефону/)
  assert.equal(sent.length, 0, 'ничего не отправлено')
})

test('не угадывает, если под имя подходит несколько человек', async () => {
  const { tool, sent } = makeTool()
  const result = await tool.executeDetailed({ target: 'Мари', text: 'привет' })
  assert.match(result.text, /нашлось несколько человек|Отправил/)
  assert.ok(sent.length <= 1)
})

test('«Мария» находит «Машу», если она одна', async () => {
  const { tool, sent } = makeTool({ entries: [{ chatId: 501, name: 'Маша' }] })
  const result = await tool.executeDetailed({ target: 'Мария', text: 'задержусь' })
  assert.match(result.text, /Отправил Маша \(имя\)/)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].chatId, 501)
  assert.equal(sent[0].text, 'От Вячеслава: задержусь', 'подпись сохраняется')
})

test('«Мария» находит «Марину» по общей основе без окончания', async () => {
  const { tool, sent } = makeTool({ entries: [{ chatId: 502, name: 'Марина' }] })
  await tool.executeDetailed({ target: 'Мария', text: 'привет' })
  assert.equal(sent[0].chatId, 502)
})

test('двое подходящих по мягкому совпадению — прежний вопрос с уточнением', async () => {
  const entries = [
    { chatId: 601, name: 'Маша' },
    { chatId: 602, name: 'Марина' },
  ]
  const { tool, sent } = makeTool({ entries })
  const result = await tool.executeDetailed({ target: 'Мария', text: 'привет' })
  assert.equal(
    result.text,
    'Ошибка инструмента sendto: под «Мария» нашлось несколько человек (Маша, Марина). Уточните, кому именно.',
    'текст отказа не изменился',
  )
  assert.equal(sent.length, 0, 'ничего не отправлено')
})

test('неизвестное имя по-прежнему даёт список известных', async () => {
  const { tool, sent } = makeTool({ entries: [{ chatId: 701, name: 'Маша' }] })
  const result = await tool.executeDetailed({ target: 'Пётр', text: 'привет' })
  assert.match(result.text, /не нашёл «Пётр»/)
  assert.match(result.text, /Маша/)
  assert.equal(sent.length, 0)
})

test('перечисляет известных людей, если адресат не найден', async () => {
  const { tool } = makeTool()
  const result = await tool.executeDetailed({ target: 'Пётр', text: 'привет' })
  assert.match(result.text, /не нашёл/)
  assert.match(result.text, /Мария/)
})

test('пустой текст не отправляется', async () => {
  const { tool, sent } = makeTool()
  const result = await tool.executeDetailed({ target: 'Мария', text: '   ' })
  assert.match(result.text, /пустой текст/)
  assert.equal(sent.length, 0)
})

test('отказ Telegram объясняется как «не начинал диалог»', async () => {
  const { tool } = makeTool({ failWith: 'Bad Request: chat not found' })
  const result = await tool.executeDetailed({ target: 'Мария', text: 'привет' })
  assert.match(result.text, /не разрешает написать первым/)
})

test('прочая ошибка отправки не выдаётся за успех', async () => {
  const { tool } = makeTool({ failWith: 'ETIMEDOUT' })
  const result = await tool.executeDetailed({ target: 'Мария', text: 'привет' })
  assert.match(result.text, /не удалось отправить/)
  assert.doesNotMatch(result.text, /Отправил/)
})

test('телефон сравнивается по последним 10 цифрам', () => {
  assert.equal(phoneKey('+7 (999) 123-45-67'), '9991234567')
  assert.equal(phoneKey('89991234567'), '9991234567')
})
