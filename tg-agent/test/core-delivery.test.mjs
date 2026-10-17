/**
 * Границы новых слоёв: доставка, возможности и маршрутизатор команд.
 *
 * Поведение бота целиком проверяет `bot.test.mjs`; здесь — что вынесенные
 * модули можно использовать сами по себе и что они не зависят от фасада.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { htmlToPlainText, markdownToTelegramHtml } from '../src/delivery/format.mjs'
import { createStreamer, splitForTelegram } from '../src/delivery/stream.mjs'
import { capabilityHelp, capabilityLines } from '../src/core/capabilities.mjs'
import { MODES, parseCommand } from '../src/core/commands.mjs'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

test('delivery/format экранирует HTML и превращает ссылки', () => {
  const html = markdownToTelegramHtml('**жирный** <script> и [ссылка](https://example.com/a?b=1)')
  assert.match(html, /<b>жирный<\/b>/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1">ссылка<\/a>/)
})

test('delivery/stream режет длинный ответ и сохраняет порядок', () => {
  const html = markdownToTelegramHtml('слово **важное** '.repeat(80))
  const chunks = splitForTelegram(html, 120)
  assert.ok(chunks.length > 1, 'ответ разбит на части')
  assert.ok(chunks.every((chunk) => chunk.length <= 120), 'каждая часть в лимите')
  assert.equal(
    htmlToPlainText(chunks.join('')).replace(/\s+/g, ' ').trim(),
    htmlToPlainText(html).replace(/\s+/g, ' ').trim(),
    'порядок и текст частей сохранены',
  )
})

test('delivery/stream пишет delta в одно сообщение и правит его финалом', async () => {
  const sent = []
  const edits = []
  const platform = {
    async sendText({ markdown }) {
      sent.push(markdown)
      return { messageId: 7 }
    },
    async editText({ messageId, markdown, keyboard }) {
      edits.push({ messageId, markdown, keyboard })
    },
  }
  const streamer = createStreamer({ platform, logger: silentLogger, throttleMs: 0 }, 42)
  streamer.onDelta('привет ')
  streamer.onDelta('мир')
  const delivered = await streamer.finish('привет мир', { rows: [[{ text: 'ok' }]] })
  assert.equal(delivered, true, 'финальный текст доставлен правкой')
  assert.equal(sent.length, 1, 'создано ровно одно сообщение')
  assert.equal(edits.at(-1).markdown, 'привет мир')
  assert.deepEqual(edits.at(-1).keyboard, { rows: [[{ text: 'ok' }]] })
  assert.ok(edits.every((edit) => edit.messageId === 7), 'правится то же сообщение')
})

test('core/capabilities учитывает только подключённые возможности', () => {
  const base = capabilityLines({ config: {}, media: {}, platformName: 'telegram' })
  assert.match(base[0], /Telegram/)
  assert.equal(base.some((line) => line.includes('Home Assistant')), false, 'без ключей умного дома нет')
  assert.equal(base.some((line) => line.includes('голосовые')), false, 'без распознавателя голосовых нет')

  const full = capabilityLines({
    config: { smartHome: { baseUrl: 'http://ha.local', token: 't' }, digest: { enabled: true } },
    media: { transcribe: async () => '', extractText: async () => ({ text: '' }) },
    platformName: 'vk',
  })
  assert.equal(full.some((line) => line.includes('Home Assistant')), true)
  assert.equal(full.some((line) => line.includes('голосовые')), true)
  assert.match(capabilityHelp(full), /^\*\*Что умеет этот бот\*\*/)
})

test('core/commands разбирает /name@bot и не трогает чужого бота', () => {
  assert.deepEqual(parseCommand('/help@test_bot аргумент', 'test_bot'), { name: 'help', args: 'аргумент' })
  assert.equal(parseCommand('/help@other_bot', 'test_bot'), undefined)
  assert.equal(parseCommand('просто текст', 'test_bot'), undefined)
  assert.ok(MODES['кратко'], 'режим ответа на месте')
})
