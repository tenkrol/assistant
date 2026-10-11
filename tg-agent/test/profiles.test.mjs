/**
 * Profiles: the durable per-user store (`ProfileStore`) and the `remember` tool.
 *
 * Every test runs against a fresh temporary file, so persistence is exercised
 * for real (flush writes, load reads) without touching the running bot's data.
 * The store has no injectable clock, so the one test that needs a defined order
 * of `updatedAt` writes those timestamps explicitly.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MAX_FACT_LENGTH, ProfileStore } from '../src/profiles.mjs'
import { createProfileTool } from '../src/profile-tool.mjs'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * A store backed by a fresh temporary file.
 *
 * @param {object} [options] - store options.
 * @param {number} [options.maxUsers] - profiles kept before the oldest is dropped.
 * @param {number} [options.maxFacts] - facts allowed per user.
 */
async function makeStore({ maxUsers, maxFacts } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-profiles-'))
  const file = path.join(dir, 'users.json')
  const store = new ProfileStore({ file, logger: silentLogger, maxUsers, maxFacts })
  await store.load()
  return {
    dir,
    file,
    store,
    /** Flush before removing so no pending write can land during `rm`. */
    cleanup: async () => {
      await store.flush()
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
  }
}

/** The `remember` tool over a fresh store. */
async function makeTool() {
  const ctx = await makeStore()
  const tool = createProfileTool({ store: ctx.store, logger: silentLogger })
  return { ...ctx, tool }
}

test('addFact collapses whitespace and numbers facts as strings from 1', async () => {
  const ctx = await makeStore()
  try {
    const first = ctx.store.addFact('42', '  его\t\nзовут   Андрей  ')
    assert.equal(first.duplicate, false)
    assert.equal(first.fact.id, '1')
    assert.equal(first.fact.text, 'его зовут Андрей')
    assert.ok(Number.isFinite(Date.parse(first.fact.createdAt)), `createdAt ${first.fact.createdAt}`)

    assert.equal(ctx.store.addFact('42', 'живёт в Казани').fact.id, '2')
    assert.deepEqual(ctx.store.facts('42').map((fact) => fact.id), ['1', '2'])
  } finally {
    await ctx.cleanup()
  }
})

test('addFact ignores a repeat in another case or with extra spaces', async () => {
  const ctx = await makeStore()
  try {
    const original = ctx.store.addFact('42', 'его зовут Андрей')
    const again = ctx.store.addFact('42', '  Его   ЗОВУТ  андрей ')
    assert.equal(again.duplicate, true)
    assert.equal(again.fact.id, original.fact.id)
    assert.equal(again.fact.text, 'его зовут Андрей', 'the stored wording must be kept')
    assert.equal(ctx.store.facts('42').length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('addFact refuses an empty fact', async () => {
  const ctx = await makeStore()
  try {
    assert.throws(() => ctx.store.addFact('42', ''), /fact text is required/)
    assert.throws(() => ctx.store.addFact('42', '   \n\t '), /fact text is required/)
    assert.throws(() => ctx.store.addFact('42'), /fact text is required/)
    assert.equal(ctx.store.size, 0, 'a refused fact must not create a profile')
  } finally {
    await ctx.cleanup()
  }
})

test('addFact refuses text longer than 200 characters', async () => {
  const ctx = await makeStore()
  try {
    assert.equal(MAX_FACT_LENGTH, 200)
    assert.throws(() => ctx.store.addFact('42', 'a'.repeat(201)), /too long/)
    // Exactly the limit is still accepted.
    assert.equal(ctx.store.addFact('42', 'a'.repeat(200)).fact.text.length, 200)
    assert.equal(ctx.store.facts('42').length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('addFact enforces maxFacts and never squeezes in the extra fact', async () => {
  const ctx = await makeStore({ maxFacts: 2 })
  try {
    ctx.store.addFact('42', 'первый')
    ctx.store.addFact('42', 'второй')
    assert.throws(() => ctx.store.addFact('42', 'третий'), /too many facts/)
    assert.deepEqual(ctx.store.facts('42').map((fact) => fact.text), ['первый', 'второй'])
    // The budget is per user: another profile has its own two slots.
    assert.equal(ctx.store.addFact('7', 'чужое').fact.id, '1')
  } finally {
    await ctx.cleanup()
  }
})

test('facts() hands out a copy that cannot change the store', async () => {
  const ctx = await makeStore()
  try {
    ctx.store.addFact('42', 'настоящий')
    const snapshot = ctx.store.facts('42')
    snapshot.push({ id: '99', text: 'подделка', createdAt: new Date().toISOString() })
    snapshot.length = 0
    assert.deepEqual(ctx.store.facts('42').map((fact) => fact.text), ['настоящий'])
    assert.notEqual(ctx.store.facts('42'), ctx.store.facts('42'), 'each call returns a fresh array')
  } finally {
    await ctx.cleanup()
  }
})

test('removeFact deletes only its own number, is idempotent and never reuses ids', async () => {
  const ctx = await makeStore()
  try {
    ctx.store.addFact('42', 'первый')
    ctx.store.addFact('42', 'второй')
    ctx.store.addFact('7', 'чужое')

    assert.equal(ctx.store.removeFact('42', '1')?.text, 'первый')
    assert.equal(ctx.store.removeFact('42', '1'), undefined, 'a second removal must miss')
    assert.equal(ctx.store.removeFact('42', '999'), undefined)
    assert.equal(ctx.store.removeFact('нет-такого', '1'), undefined)
    assert.deepEqual(ctx.store.facts('42').map((fact) => fact.id), ['2'])
    assert.deepEqual(ctx.store.facts('7').map((fact) => fact.id), ['1'], 'another user keeps its fact')

    const next = ctx.store.addFact('42', 'третий')
    assert.equal(next.fact.id, '3', 'a new fact must not reuse a deleted number')
  } finally {
    await ctx.cleanup()
  }
})

test('setCity trims the city and reports whether it changed', async () => {
  const ctx = await makeStore()
  try {
    assert.deepEqual(ctx.store.setCity('42', '  Казань  '), { city: 'Казань', changed: true })
    assert.equal(ctx.store.city('42'), 'Казань')
    assert.deepEqual(ctx.store.setCity('42', 'Казань'), { city: 'Казань', changed: false })
    assert.equal(ctx.store.city('42'), 'Казань')
  } finally {
    await ctx.cleanup()
  }
})

test('setCity refuses an empty or over-long city', async () => {
  const ctx = await makeStore()
  try {
    assert.throws(() => ctx.store.setCity('42', ''), /city is required/)
    assert.throws(() => ctx.store.setCity('42', '   '), /city is required/)
    assert.throws(() => ctx.store.setCity('42', 'a'.repeat(81)), /too long/)
    assert.equal(ctx.store.setCity('42', 'a'.repeat(80)).city.length, 80)
  } finally {
    await ctx.cleanup()
  }
})

test('clearCity reports whether there was a city to forget', async () => {
  const ctx = await makeStore()
  try {
    assert.equal(ctx.store.clearCity('42'), false, 'nothing to clear yet')
    ctx.store.setCity('42', 'Казань')
    assert.equal(ctx.store.clearCity('42'), true)
    assert.equal(ctx.store.city('42'), undefined)
    assert.equal(ctx.store.clearCity('42'), false, 'the second clear has nothing to do')
    assert.equal(ctx.store.clearCity('7'), false, 'an unknown user has no city')
  } finally {
    await ctx.cleanup()
  }
})

test('summary() is undefined while nothing is known', async () => {
  const ctx = await makeStore()
  try {
    assert.equal(ctx.store.summary('42'), undefined, 'an unknown user')
    ctx.store.get('42')
    assert.equal(ctx.store.summary('42'), undefined, 'a profile with neither city nor facts')
    ctx.store.setCity('42', 'Казань')
    assert.ok(ctx.store.summary('42'), 'a city alone is already worth reporting')
  } finally {
    await ctx.cleanup()
  }
})

test('summary() carries the city and numbered facts, keeping numbers stable', async () => {
  const ctx = await makeStore()
  try {
    ctx.store.setCity('42', 'Казань')
    ctx.store.addFact('42', 'его зовут Андрей')
    ctx.store.addFact('42', 'живёт в Казани')

    const summary = ctx.store.summary('42')
    assert.match(summary, /Казань/)
    assert.match(summary, /№1: его зовут Андрей/)
    assert.match(summary, /№2: живёт в Казани/)

    ctx.store.removeFact('42', '1')
    const after = ctx.store.summary('42')
    assert.doesNotMatch(after, /№1:/)
    assert.match(after, /№2: живёт в Казани/, 'the surviving fact must keep its number')
  } finally {
    await ctx.cleanup()
  }
})

test('flush + load round-trips city, facts and nextFactId without reusing numbers', async () => {
  const ctx = await makeStore()
  try {
    ctx.store.setCity('42', 'Казань')
    ctx.store.addFact('42', 'первый')
    ctx.store.addFact('42', 'второй')
    ctx.store.removeFact('42', '1')
    await ctx.store.flush()

    const reopened = new ProfileStore({ file: ctx.file, logger: silentLogger })
    await reopened.load()
    assert.equal(reopened.city('42'), 'Казань')
    assert.deepEqual(reopened.facts('42'), ctx.store.facts('42'))
    assert.deepEqual(reopened.facts('42').map((fact) => fact.text), ['второй'])
    assert.equal(reopened.get('42').nextFactId, 3)

    assert.equal(reopened.addFact('42', 'третий').fact.id, '3', 'a reopened store must not reuse an old number')
  } finally {
    await ctx.cleanup()
  }
})

test('a corrupt file is ignored and replaced by the next flush', async () => {
  const ctx = await makeStore()
  try {
    await fs.writeFile(ctx.file, '{ это не json', 'utf8')
    const store = new ProfileStore({ file: ctx.file, logger: silentLogger })
    await assert.doesNotReject(() => store.load())
    assert.equal(store.size, 0)
    assert.equal(store.summary('42'), undefined)

    store.addFact('42', 'после сбоя')
    await store.flush()
    const parsed = JSON.parse(await fs.readFile(ctx.file, 'utf8'))
    assert.equal(parsed.version, 1)
    assert.equal(parsed.users['42'].facts[0].text, 'после сбоя')
  } finally {
    await ctx.cleanup()
  }
})

test('a file with a foreign version is ignored and replaced by the next flush', async () => {
  const ctx = await makeStore()
  try {
    const foreign = {
      version: 99,
      users: { '42': { city: 'Казань', facts: [{ id: '1', text: 'чужое', createdAt: new Date().toISOString() }], nextFactId: 2 } },
    }
    await fs.writeFile(ctx.file, JSON.stringify(foreign), 'utf8')
    const store = new ProfileStore({ file: ctx.file, logger: silentLogger })
    await assert.doesNotReject(() => store.load())
    assert.equal(store.size, 0, 'a foreign version must not be trusted')
    assert.equal(store.city('42'), undefined)

    store.addFact('42', 'после сбоя')
    await store.flush()
    const parsed = JSON.parse(await fs.readFile(ctx.file, 'utf8'))
    assert.equal(parsed.version, 1)
    assert.equal(parsed.users['42'].facts.length, 1)
    assert.equal(parsed.users['42'].facts[0].text, 'после сбоя')
  } finally {
    await ctx.cleanup()
  }
})

// Regression: a chatty bot must not hold a profile for everyone forever.
test('maxUsers drops the oldest profile by updatedAt and keeps the fresh ones', async () => {
  const ctx = await makeStore({ maxUsers: 2 })
  try {
    ctx.store.addFact('1', 'самый старый')
    ctx.store.addFact('2', 'свежее')
    // Backdate both so the incoming third profile is unambiguously the newest.
    ctx.store.get('1').updatedAt = '1970-01-01T00:00:00.000Z'
    ctx.store.get('2').updatedAt = '1970-01-02T00:00:00.000Z'

    ctx.store.addFact('3', 'новый')
    assert.equal(ctx.store.size, 2)
    assert.equal(ctx.store.peek('1'), undefined, 'the oldest profile must be the one dropped')
    assert.ok(ctx.store.peek('2'), 'the fresher profile must survive')
    assert.ok(ctx.store.peek('3'), 'the new profile must survive')
    assert.equal(ctx.store.facts('2').length, 1)
    assert.equal(ctx.store.facts('3').length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('size counts profiles actually created, not peeks', async () => {
  const ctx = await makeStore()
  try {
    assert.equal(ctx.store.size, 0)
    assert.equal(ctx.store.peek('42'), undefined)
    assert.equal(ctx.store.size, 0, 'peek must not create a profile')

    ctx.store.addFact('42', 'факт')
    assert.equal(ctx.store.size, 1)
    ctx.store.setCity('7', 'Москва')
    assert.equal(ctx.store.size, 2)
    assert.equal(ctx.store.city('99'), undefined)
    assert.deepEqual(ctx.store.facts('99'), [])
    assert.equal(ctx.store.size, 2, 'read-only access must not create a profile')
  } finally {
    await ctx.cleanup()
  }
})

test('the remember tool stores the fact, numbers it and writes it to disk at once', async () => {
  const ctx = await makeTool()
  try {
    const output = await ctx.tool.execute({ text: 'его зовут Андрей' }, { userId: 42 })
    assert.match(output, /Запомнил \(№1\)/)
    assert.match(output, /«его зовут Андрей»/)
    assert.equal(ctx.store.facts(42).length, 1)

    // flush() is awaited inside execute: the fact is durable by the time it returns.
    const parsed = JSON.parse(await fs.readFile(ctx.file, 'utf8'))
    assert.equal(parsed.version, 1)
    assert.equal(parsed.users['42'].facts[0].text, 'его зовут Андрей')
    assert.equal(parsed.users['42'].nextFactId, 2)
  } finally {
    await ctx.cleanup()
  }
})

test('the remember tool recognises a repeat and adds no duplicate', async () => {
  const ctx = await makeTool()
  try {
    await ctx.tool.execute({ text: 'его зовут Андрей' }, { userId: 42 })
    const again = await ctx.tool.execute({ text: '  его   ЗОВУТ  андрей ' }, { userId: 42 })
    assert.match(again, /Уже помню \(№1\)/)
    assert.match(again, /«его зовут Андрей»/)
    assert.equal(ctx.store.facts(42).length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('the city argument sets the default city and its absence leaves it alone', async () => {
  const ctx = await makeTool()
  try {
    const withCity = await ctx.tool.execute({ text: 'живёт в Казани', city: '  Казань  ' }, { userId: 42 })
    assert.match(withCity, /Запомнил \(№1\)/)
    assert.match(withCity, /Город по умолчанию — Казань/)
    assert.equal(ctx.store.city(42), 'Казань')

    const withoutCity = await ctx.tool.execute({ text: 'любит кофе' }, { userId: 42 })
    assert.match(withoutCity, /Запомнил \(№2\)/)
    assert.doesNotMatch(withoutCity, /Город по умолчанию/)
    assert.equal(ctx.store.city(42), 'Казань', 'the stored city must survive a fact without one')
  } finally {
    await ctx.cleanup()
  }
})

test('the same city passed twice is reported as already known, not as a change', async () => {
  const ctx = await makeTool()
  try {
    await ctx.tool.execute({ text: 'живёт в Казани', city: 'Казань' }, { userId: 42 })
    const again = await ctx.tool.execute({ text: 'работает в Казани', city: 'Казань' }, { userId: 42 })
    assert.match(again, /Запомнил \(№2\)/)
    assert.match(again, /Город по умолчанию уже Казань/)
    assert.equal(ctx.store.city(42), 'Казань')
  } finally {
    await ctx.cleanup()
  }
})

test('an empty or too long text is refused and stores nothing', async () => {
  const ctx = await makeTool()
  try {
    const empty = await ctx.tool.execute({ text: '   ' }, { userId: 42 })
    assert.match(empty, /^Ошибка инструмента remember/)
    const long = await ctx.tool.execute({ text: 'a'.repeat(201) }, { userId: 42 })
    assert.match(long, /^Ошибка инструмента remember/)
    assert.deepEqual(ctx.store.facts(42), [])
    assert.equal(ctx.store.size, 0, 'a refused fact must not even create a profile')
  } finally {
    await ctx.cleanup()
  }
})

test('without a userId the tool reports an error instead of throwing', async () => {
  const ctx = await makeTool()
  try {
    const missing = await ctx.tool.execute({ text: 'что-нибудь' }, {})
    assert.match(missing, /не удалось определить пользователя/)
    const noContext = await ctx.tool.execute({ text: 'что-нибудь' })
    assert.match(noContext, /не удалось определить пользователя/)
    assert.equal(ctx.store.size, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('execute never throws, even when the store does', async () => {
  const ctx = await makeTool()
  const original = ctx.store.addFact
  try {
    ctx.store.addFact = () => { throw new Error('хранилище сломалось') }
    const output = await ctx.tool.execute({ text: 'что-нибудь' }, { userId: 42 })
    assert.equal(typeof output, 'string')
    assert.match(output, /^Ошибка инструмента remember: хранилище сломалось/)
  } finally {
    ctx.store.addFact = original
    await ctx.cleanup()
  }
})
