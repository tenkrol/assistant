/**
 * Домен профилей без платформы и сети.
 *
 * Хранилище — маленькое, в памяти: проверяются правила памяти (предел фактов,
 * город как одно значение, отображаемое имя), а не запись на диск.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_CITY_LENGTH,
  displayNameOf,
  isCityRemoval,
  memoryText,
  rulesOfProfiles,
} from '../src/domain/profiles.mjs'

/** Хранилище профилей в памяти с тем же поведением, что нужно домену. */
function makeProfileStore({ maxFacts = 50 } = {}) {
  const users = new Map()
  let flushes = 0
  const profile = (userId) => {
    const key = String(userId)
    if (!users.has(key)) users.set(key, { city: undefined, facts: [], nextFactId: 1, firstName: undefined, username: undefined })
    return users.get(key)
  }
  return {
    get flushes() {
      return flushes
    },
    facts(userId) {
      return (users.get(String(userId))?.facts ?? []).map((fact) => ({ ...fact }))
    },
    city(userId) {
      return users.get(String(userId))?.city
    },
    setCity(userId, city) {
      const target = profile(userId)
      const clean = String(city ?? '').trim()
      const changed = target.city !== clean
      target.city = clean
      return { city: clean, changed }
    },
    clearCity(userId) {
      const target = users.get(String(userId))
      if (!target?.city) return false
      target.city = undefined
      return true
    },
    addFact(userId, text) {
      const target = profile(userId)
      const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
      const existing = target.facts.find((fact) => fact.text.toLowerCase() === clean.toLowerCase())
      if (existing) return { fact: { ...existing }, duplicate: true }
      if (target.facts.length >= maxFacts) throw new Error(`too many facts (max ${maxFacts}); remove one first`)
      const fact = { id: String(target.nextFactId++), text: clean }
      target.facts.push(fact)
      return { fact: { ...fact }, duplicate: false }
    },
    removeFact(userId, id) {
      const target = users.get(String(userId))
      if (!target) return undefined
      const index = target.facts.findIndex((fact) => fact.id === String(id))
      if (index === -1) return undefined
      return target.facts.splice(index, 1)[0]
    },
    clearFacts(userId) {
      const target = users.get(String(userId))
      if (!target) return 0
      const count = target.facts.length
      target.facts = []
      return count
    },
    displayName(userId) {
      const target = users.get(String(userId))
      return target?.firstName || target?.username
    },
    summary(userId) {
      const target = users.get(String(userId))
      if (!target) return undefined
      return target.city ? `город по умолчанию — ${target.city}` : undefined
    },
    async flush() {
      flushes++
    },
  }
}

test('город хранится одним значением и перезаписывается, а не копится', async () => {
  const store = makeProfileStore()
  const rules = rulesOfProfiles({ store })

  const first = await rules.cityCommand('1', 'Москва')
  assert.match(first.text, /Москва/)
  const second = await rules.cityCommand('1', 'Казань')
  assert.match(second.text, /Казань/)
  assert.equal(store.city('1'), 'Казань', 'город — одно значение')
  assert.ok(!Array.isArray(store.city('1')), 'город не список')

  const shown = await rules.cityCommand('1', '')
  assert.match(shown.text, /Казань/)
  assert.equal(await store.flushes, 2, 'каждое изменение записано')
})

test('слишком длинный город отклоняется прежней фразой', async () => {
  const store = makeProfileStore()
  const rules = rulesOfProfiles({ store })
  const result = await rules.cityCommand('1', 'я'.repeat(MAX_CITY_LENGTH + 1))
  assert.equal(result.text, 'Слишком длинное название города.')
  assert.equal(store.city('1'), undefined)
})

test('город убирается теми же словами и с прежними текстами', async () => {
  const store = makeProfileStore()
  const rules = rulesOfProfiles({ store })
  await rules.cityCommand('1', 'Москва')

  for (const word of ['нет', 'убрать', 'сброс', 'удали']) assert.equal(isCityRemoval(word), true)
  assert.equal(isCityRemoval('Москва'), false)

  const removed = await rules.cityCommand('1', 'нет')
  assert.equal(removed.text, 'Город по умолчанию убран.')
  const again = await rules.cityCommand('1', 'нет')
  assert.equal(again.text, 'Города по умолчанию и не было.')
})

test('память показывает город и пронумерованные факты', async () => {
  const store = makeProfileStore()
  store.setCity('1', 'Казань')
  store.addFact('1', 'его зовут Андрей')
  const rules = rulesOfProfiles({ store })
  const result = rules.memoryCommand('1')

  assert.match(result.text, /Казань/)
  assert.match(result.text, /№1: его зовут Андрей/)
  assert.match(result.text, /\/forget/)
})

test('пустая память объясняет, как начать', async () => {
  const store = makeProfileStore()
  const rules = rulesOfProfiles({ store })
  assert.equal(rules.memoryCommand('1').text, 'Я пока ничего о вас не помню. Скажите, например: «запомни, меня зовут Андрей».')
})

test('предел фактов не выкидывает старые молча и говорит об этом', async () => {
  const store = makeProfileStore({ maxFacts: 2 })
  store.addFact('1', 'первый')
  store.addFact('1', 'второй')
  const rules = rulesOfProfiles({ store })

  const result = await rules.remember({ text: 'третий' }, { userId: '1' })
  assert.match(result, /Ошибка инструмента remember/)
  assert.match(result, /too many facts \(max 2\); remove one first/)
  assert.deepEqual(store.facts('1').map((fact) => fact.text), ['первый', 'второй'], 'старые факты целы')
})

test('повторный факт не добавляется вторым', async () => {
  const store = makeProfileStore()
  store.addFact('1', 'его зовут Андрей')
  const rules = rulesOfProfiles({ store })
  const result = await rules.remember({ text: '  Его   ЗОВУТ  андрей ' }, { userId: '1' })
  assert.match(result, /^Уже помню \(№1\)/)
  assert.equal(store.facts('1').length, 1)
})

test('remember сохраняет факт и город вместе', async () => {
  const store = makeProfileStore()
  const rules = rulesOfProfiles({ store })
  const result = await rules.remember({ text: 'живёт в Казани', city: 'Казань' }, { userId: '1' })

  assert.match(result, /^Запомнил \(№1\): «живёт в Казани»/)
  assert.match(result, /Город по умолчанию — Казань/)
  assert.equal(store.city('1'), 'Казань')
  assert.equal(await store.flushes, 1)
})

test('forget удаляет один факт или все, не трогая город', async () => {
  const store = makeProfileStore()
  store.setCity('1', 'Казань')
  store.addFact('1', 'первый')
  store.addFact('1', 'второй')
  const rules = rulesOfProfiles({ store })

  const one = await rules.forgetCommand('1', '1')
  assert.match(one.text, /Забыл №1: «первый»/)
  assert.deepEqual(store.facts('1').map((fact) => fact.text), ['второй'])
  assert.equal(store.city('1'), 'Казань', 'город — не факт')

  const all = await rules.forgetCommand('1', 'all')
  assert.equal(all.text, 'Забыл все факты (1).')
  assert.equal(store.facts('1').length, 0)
  const none = await rules.forgetCommand('1', 'all')
  assert.equal(none.text, 'Фактов и не было.')
})

test('отображаемое имя: запомненное важнее имени из мессенджера', () => {
  assert.equal(displayNameOf({ facts: [{ text: 'его зовут Андрей' }], firstName: 'Андрюша' }), 'Андрей')
  assert.equal(displayNameOf({ facts: [], firstName: 'Иван' }), 'Иван')
  assert.equal(displayNameOf({ facts: [], username: 'ivan' }), 'ivan')
  assert.equal(displayNameOf(undefined), undefined)
})

test('отображаемое имя берётся из профиля, а неизвестный голосующий — по id', () => {
  const store = makeProfileStore()
  store.displayName = () => 'Вячеслав'
  const rules = rulesOfProfiles({ store })
  const names = rules.namesOf({ options: [{ text: 'A', votes: [7, 8] }] })
  assert.equal(names[7], 'Вячеслав')
  assert.equal(names[8], 'Вячеслав')
})

test('memoryText склеивает пустые данные в понятную подсказку', () => {
  assert.match(memoryText({ facts: [], city: undefined }), /ничего о вас не помню/)
  assert.match(memoryText({ facts: [{ id: '2', text: 'факт' }], city: 'Москва' }), /№2: факт/)
})
