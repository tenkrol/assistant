/**
 * Digest: the morning message (`DigestService`) — schedule, text and delivery.
 *
 * Every collaborator (weather, search, reminders, profiles, delivery) is faked
 * and the clock is injected, so nothing here touches the network or waits for a
 * real timer. Timers that are armed are always cleared again by `stop()`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { DigestService } from '../src/digest.mjs'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }
const MSK = 'Europe/Moscow'
/** 03:00 UTC is 06:00 in Moscow: before the 08:00 run. */
const BEFORE_RUN = '2026-10-06T03:00:00Z'
/** 06:00 UTC is 09:00 in Moscow: after the 08:00 run. */
const AFTER_RUN = '2026-10-06T06:00:00Z'
/** 08:00 in Moscow (UTC+3) is 05:00 UTC. */
const TODAY_RUN = '2026-10-06T05:00:00.000Z'
const TOMORROW_RUN = '2026-10-07T05:00:00.000Z'

/** One stored reminder, in the shape `ReminderStore` writes. */
const reminder = (overrides = {}) => ({
  id: '1',
  chatId: 1,
  text: 'дело',
  dueAt: '2026-10-06T06:00:00.000Z',
  repeat: 'none',
  createdAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
})

/**
 * A service with faked collaborators and a frozen clock.
 *
 * @param {object} [options] - overrides for the fakes.
 * @param {string} [options.now] - ISO instant the service sees.
 * @param {string} [options.time] - local `HH:MM` of the run.
 * @param {string[]} [options.chatIds] - chats to schedule for.
 * @param {object} [options.reminders] - fake reminder store (`list`).
 * @param {object} [options.profiles] - fake profile store (`facts`, `city`).
 * @param {object} [options.weather] - fake weather tool (`execute`).
 * @param {(query: string) => Promise<string>} [options.search] - fake search call.
 * @param {string[]} [options.topics] - search queries for the "в мире" section.
 * @param {(chatId: string, text: string) => Promise<void>} [options.deliver] - fake delivery.
 */
function makeService({
  now = BEFORE_RUN,
  time = '08:00',
  chatIds = [],
  reminders = { list: () => [] },
  profiles = { facts: () => [], city: () => undefined },
  weather,
  alerts,
  holidays,
  search,
  topics = [],
  deliver = async () => {},
} = {}) {
  return new DigestService({
    deliver,
    weather,
    alerts,
    holidays,
    reminders,
    profiles,
    search,
    logger: silentLogger,
    timeZone: MSK,
    time,
    chatIds,
    topics,
    now: () => new Date(now),
  })
}

test('nextRunAt picks today when the local run time has not arrived yet', () => {
  const service = makeService({ now: BEFORE_RUN, time: '08:00' })
  assert.equal(service.nextRunAt().toISOString(), TODAY_RUN, '08:00 in Moscow (UTC+3) is 05:00Z')
})

test('nextRunAt moves to tomorrow once the local run time has passed', () => {
  const after = makeService({ now: AFTER_RUN, time: '08:00' })
  assert.equal(after.nextRunAt().toISOString(), TOMORROW_RUN)

  // Exactly at the run time counts as passed: a missed run is never replayed.
  const exactly = makeService({ now: TODAY_RUN, time: '08:00' })
  assert.equal(exactly.nextRunAt().toISOString(), TOMORROW_RUN)
})

test('an invalid time falls back to 08:00', () => {
  // Out-of-range values are rejected too: '25:99' used to reach the scheduler
  // and throw there, which would take the whole bot down at startup.
  for (const time of ['', '8:00', 'утро', '25', '25:99', '99:99', '24:00', '08:60']) {
    const service = makeService({ now: BEFORE_RUN, time })
    assert.equal(service.time, '08:00', `time ${JSON.stringify(time)} must fall back`)
    assert.equal(service.nextRunAt().toISOString(), TODAY_RUN)
  }
  const valid = makeService({ now: BEFORE_RUN, time: '07:30' })
  assert.equal(valid.time, '07:30')
  assert.equal(valid.nextRunAt().toISOString(), '2026-10-06T04:30:00.000Z')
})

test('build greets the user by the name found in a profile fact', async () => {
  const profiles = {
    facts: (userId) => (String(userId) === '1' ? [{ id: '1', text: 'его зовут Андрей' }, { id: '2', text: 'живёт в Казани' }] : []),
    city: () => undefined,
  }
  const service = makeService({ profiles })

  const known = await service.build(1)
  assert.match(known, /☀️ \*\*Доброе утро, Андрей!\*\*/)

  const stranger = await service.build(2)
  assert.match(stranger, /☀️ \*\*Доброе утро!\*\*/)
  assert.doesNotMatch(stranger, /Доброе утро,/, 'without a name there must be no comma')
})

test('build adds the weather section and passes the profile city to the tool', async () => {
  const calls = []
  const weather = { execute: async (args) => { calls.push(args); return 'Погода: Москва, ясно, +7 °C' } }
  const profiles = { facts: () => [], city: () => 'Москва' }
  const service = makeService({ weather, profiles })

  const text = await service.build(1)
  assert.deepEqual(calls, [{ city: 'Москва' }])
  assert.match(text, /\*\*Погода\*\*/)
  assert.ok(text.includes('Погода: Москва, ясно, +7 °C'), text)
})

test('an empty weather answer becomes a readable line, not a blank section', async () => {
  const weather = { execute: async () => '   ' }
  const profiles = { facts: () => [], city: () => 'Москва' }
  const service = makeService({ weather, profiles })

  const text = await service.build(1)
  assert.ok(text.includes('**Погода**\nНе удалось получить погоду для «Москва».'), text)
})

test('a throwing weather tool does not break the digest', async () => {
  const weather = { execute: async () => { throw new Error('сеть недоступна') } }
  const service = makeService({ weather })

  const text = await service.build(1)
  assert.doesNotMatch(text, /\*\*Погода\*\*/, 'a failed weather lookup leaves no weather section')
  assert.match(text, /\*\*Напоминания на сегодня\*\*/)
  assert.match(text, /на сегодня ничего не запланировано/)
})

test('without a weather tool there is no weather section', async () => {
  const text = await makeService().build(1)
  assert.doesNotMatch(text, /\*\*Погода\*\*/)
})

test('build lists only today reminders, sorted, with local time and repeat marks', async () => {
  const reminders = {
    list: (chatId) => {
      assert.equal(String(chatId), '1', 'the digest must ask for the chat own reminders')
      return [
        reminder({ id: '2', text: 'отчёт', dueAt: '2026-10-06T15:00:00.000Z', repeat: 'weekly' }),
        reminder({ id: '1', text: 'зарядка', dueAt: '2026-10-06T06:00:00.000Z', repeat: 'daily' }),
        reminder({ id: '3', text: 'завтра', dueAt: '2026-10-07T06:00:00.000Z', repeat: 'none' }),
        reminder({ id: '4', text: 'разово', dueAt: '2026-10-06T09:00:00.000Z', repeat: 'none' }),
      ]
    },
  }
  const text = await makeService({ reminders }).build(1)

  assert.ok(text.includes('— 09:00 зарядка (каждый день)'), text)
  assert.ok(text.includes('— 12:00 разово\n'), text)
  assert.ok(text.includes('— 18:00 отчёт (каждую неделю)'), text)
  assert.doesNotMatch(text, /завтра/, 'a reminder due tomorrow must not appear today')
  assert.ok(text.indexOf('— 09:00 зарядка') < text.indexOf('— 12:00 разово'), 'earlier reminders come first')
  assert.ok(text.indexOf('— 12:00 разово') < text.indexOf('— 18:00 отчёт'), 'earlier reminders come first')
})

test('build says nothing is planned for today when there are no reminders', async () => {
  const text = await makeService().build(1)
  assert.ok(text.includes('**Напоминания на сегодня**\n— на сегодня ничего не запланировано'), text)
})

test('a long search result is cut to a short excerpt', async () => {
  const long = `${'н'.repeat(450)}ХВОСТ`
  const search = async (query) => {
    assert.equal(query, 'новости')
    return long
  }
  const text = await makeService({ topics: ['новости'], search }).build(1)

  assert.match(text, /\*\*новости\*\*/)
  assert.ok(text.includes('н'.repeat(400)), 'the first 400 characters must be kept')
  assert.ok(!text.includes('н'.repeat(401)), 'the excerpt must be exactly 400 characters')
  assert.ok(!text.includes('ХВОСТ'), 'everything past the excerpt must be dropped')
})

test('a throwing search does not break the digest', async () => {
  const search = async () => { throw new Error('сеть недоступна') }
  const reminders = { list: () => [reminder({ text: 'чай' })] }
  const text = await makeService({ topics: ['новости'], search, reminders }).build(1)

  assert.doesNotMatch(text, /\*\*новости\*\*/)
  assert.match(text, /— 09:00 чай/)
  assert.match(text, /Хорошего дня/)
})

test('start with no chats arms nothing and stop is safe', () => {
  const service = makeService({ chatIds: [], now: AFTER_RUN })
  assert.equal(service.timer, undefined)
  assert.equal(service.start(), service)
  assert.equal(service.timer, undefined, 'an empty chat list must not arm a timer')
  service.stop()
  assert.equal(service.timer, undefined)
})

test('start arms the next timer and stop clears it', () => {
  // 09:00 local with an 08:00 run means the next fire is tomorrow: no real wait.
  const service = makeService({ chatIds: ['1'], now: AFTER_RUN, time: '08:00' })
  assert.equal(service.nextRunAt().toISOString(), TOMORROW_RUN)

  service.start()
  assert.notEqual(service.timer, undefined, 'start must arm the timer')
  const armed = service.timer
  service.start()
  assert.equal(service.timer, armed, 'a second start must reuse the same timer')
  service.stop()
  assert.equal(service.timer, undefined, 'stop must clear the timer')
})

test('run delivers the digest to every configured chat', async () => {
  const delivered = []
  const service = makeService({
    chatIds: ['1', '2'],
    deliver: async (chatId, text) => { delivered.push([String(chatId), text]) },
  })

  await service.run()
  assert.deepEqual(delivered.map(([chatId]) => chatId), ['1', '2'])
  for (const [, text] of delivered) assert.match(text, /Доброе утро/)
})

test('run keeps going when delivery fails for one chat', async () => {
  const delivered = []
  const service = makeService({
    chatIds: ['1', '2'],
    deliver: async (chatId, text) => {
      if (String(chatId) === '1') throw new Error('telegram недоступен')
      delivered.push([String(chatId), text])
    },
  })

  await service.run()
  assert.deepEqual(delivered.map(([chatId]) => chatId), ['2'], 'the second chat still gets its digest')
  assert.match(delivered[0][1], /Доброе утро/)
})

test('run keeps going when building fails for one chat', async () => {
  const delivered = []
  const reminders = {
    list: (chatId) => {
      if (String(chatId) === '3') throw new Error('store broken')
      return []
    },
  }
  const service = makeService({
    chatIds: ['3', '4'],
    reminders,
    deliver: async (chatId) => { delivered.push(String(chatId)) },
  })

  await service.run()
  assert.deepEqual(delivered, ['4'], 'a build failure in one chat must not stop the others')
})

test('a weather tool error becomes a hint, never a raw failure line', async () => {
  // A user without a default city got "Ошибка инструмента weather: укажите город."
  // pasted straight into the morning digest.
  const weather = { execute: async () => 'Ошибка инструмента weather: укажите город.' }
  const profiles = { facts: () => [], city: () => undefined }
  const service = makeService({ weather, profiles })
  const text = await service.build(1)
  assert.equal(/Ошибка инструмента/.test(text), false, 'сырой текст сбоя не показываем')
  assert.match(text, /\/city/, 'вместо ошибки — подсказка про /city')
})

test('the digest carries church, folk and health sections', async () => {
  // Christmas Day: an official holiday, a church feast and a health tip.
  const service = makeService({
    now: '2026-01-07T05:00:00Z',
    weather: { execute: async () => 'Погода: Москва, ясно, −8 °C' },
    holidays: { holidaysOn: async () => [{ localName: 'Рождество Христово' }], nextHoliday: async () => undefined },
    profiles: { facts: () => [], city: () => 'Москва' },
  })
  const text = await service.build(1)
  assert.match(text, /\*\*Погода\*\*/)
  assert.match(text, /\*\*Праздники\*\*/)
  assert.match(text, /\*\*Церковные праздники\*\*/)
  assert.match(text, /Рождество Христово/)
  assert.match(text, /\*\*Совет для здоровья\*\*/)
  assert.match(text, /\*\*Напоминания на сегодня\*\*/)
})

test('the digest stays readable on an ordinary day without church or folk feasts', async () => {
  const service = makeService({
    now: '2026-03-11T05:00:00Z',
    weather: { execute: async () => 'Погода: Москва, облачно, +2 °C' },
    profiles: { facts: () => [], city: () => 'Москва' },
  })
  const text = await service.build(1)
  assert.equal(/\*\*Церковные праздники\*\*/.test(text), false, 'пустые секции не печатаем')
  assert.equal(/\*\*Народные и профессиональные\*\*/.test(text), false)
  assert.match(text, /\*\*Совет для здоровья\*\*/, 'совет есть каждый день')
})

test('the digest shows weather warnings when they exist', async () => {
  const service = makeService({
    weather: { execute: async () => 'Погода: Москва, дождь, +9 °C' },
    alerts: async () => ['сегодня дождь — вероятность 90%, возьмите зонт'],
    profiles: { facts: () => [], city: () => 'Москва' },
  })
  const text = await service.build(1)
  assert.match(text, /На что обратить внимание/)
  assert.match(text, /возьмите зонт/)
})

test('the digest survives a failing alerts call', async () => {
  const service = makeService({
    weather: { execute: async () => 'Погода: Москва, ясно, +9 °C' },
    alerts: async () => { throw new Error('сеть легла') },
    profiles: { facts: () => [], city: () => 'Москва' },
  })
  const text = await service.build(1)
  assert.match(text, /Погода/)
  assert.match(text, /Совет для здоровья/)
})
