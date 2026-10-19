/**
 * PLB-026: обзор проактивности собирает пункты из всех чатов участника.
 *
 * Старое напоминание из беседы не имеет `scope_id`: раньше ACL считал его
 * личным пространством чата и не показывал никому. Теперь доступ решает
 * участие в чате, а чужие беседы в список участника не попадают.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ProactiveService,
  ProactiveStore,
  collectCandidates,
  dayKeyInZone,
} from '../src/proactive.mjs'
import { zonedTimeToUtc } from '../src/domain/reminders.mjs'
import { ScopeStore } from '../src/scopes.mjs'
import { createAccess } from '../src/core/access.mjs'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const ZONE = 'Europe/Moscow'
const NOW = zonedTimeToUtc(`${dayKeyInZone(new Date(), ZONE)}T10:00`, ZONE)
const GROUP = -5290894512
const OTHER_GROUP = -5000000000

/** Временный каталог состояния. */
async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-plb026-review-'))
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

/** Хранилище проактивности: обзор уже наступил. */
async function makeStore(file) {
  const store = new ProactiveStore({
    file,
    logger: silent,
    timeZone: ZONE,
    quiet: null,
    reviewAt: '00:05',
    dayLimit: 3,
    owner: { userId: 1 },
  })
  await store.load()
  return store
}

/** Напоминание, созданное в беседе до появления пространств. */
const groupReminder = {
  id: 'g1',
  chatId: GROUP,
  text: 'Погода на завтра',
  dueAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
  repeat: 'none',
}

test('пункт из беседы виден участнику и не виден чужому чату', () => {
  const access = createAccess({ store: new ScopeStore({ logger: silent }), logger: silent })

  const member = collectCandidates({
    now: NOW,
    reminders: [groupReminder],
    userId: 1,
    chatId: 1,
    chatIds: [1, GROUP],
    settings: { tz: ZONE },
    access,
  })
  assert.deepEqual(member.map((candidate) => candidate.key), ['reminder:g1'])
  assert.match(member[0].title, /Погода на завтра/)

  const stranger = collectCandidates({
    now: NOW,
    reminders: [groupReminder],
    userId: 2,
    chatId: 2,
    chatIds: [2, OTHER_GROUP],
    settings: { tz: ZONE },
    access,
  })
  assert.deepEqual(stranger, [], 'чужая беседа не попадает в обзор')
})

test('обзор уходит участнику с пунктом из беседы, а чужому — пустой и не отправляется', async () => {
  const ctx = await sandbox()
  try {
    const store = await makeStore(path.join(ctx.dir, 'proactive.json'))
    const deliveries = []
    const service = new ProactiveService({
      store,
      sources: {
        reminders: { list: () => [groupReminder] },
        events: { list: () => [] },
        tasks: async () => [],
      },
      targets: [
        { userId: 1, chatId: 1, chats: [1, GROUP] },
        { userId: 2, chatId: 2, chats: [2, OTHER_GROUP] },
      ],
      access: createAccess({ store: new ScopeStore({ logger: silent }), logger: silent }),
      logger: silent,
      enabled: true,
      intervalMs: 0,
      now: () => NOW,
      deliver: async (chatId, text) => deliveries.push({ chatId, text }),
    })

    await service.tick({ now: NOW, force: true })

    assert.equal(deliveries.length, 1, 'обзор только участнику беседы')
    assert.equal(deliveries[0].chatId, 1)
    assert.match(deliveries[0].text, /Погода на завтра/)
    assert.ok(!deliveries.some((delivery) => delivery.chatId === 2), 'чужой обзор пуст и не отправлен')
  } finally {
    await ctx.cleanup()
  }
})
