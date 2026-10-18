import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { WorkItemStore } from '../src/work-items.mjs'
import { canTransitionWorkItem, isStale } from '../src/domain/work-items.mjs'

test('work items keep provenance, epistemic type and history', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-items-'))
  try {
    const store = new WorkItemStore({ file: path.join(dir, 'items.json'), now: () => 1000 })
    await store.load()
    const item = await store.create({ kind: 'decision', title: 'Выбрать БД', ownerId: '42', scopeId: 's1', epistemic: 'assumption', source: { type: 'chat', ref: 'm1', at: '2026-10-18T20:00:00Z' } })
    assert.equal(item.epistemic, 'assumption')
    assert.equal(item.source.type, 'chat')
    await store.update(item.id, { status: 'active' }, { reason: 'взяли в работу', actor: 'owner' })
    await store.update(item.id, { status: 'done' }, { reason: 'решено' })
    assert.equal(store.get(item.id).history.at(-1).from, 'active')
    assert.equal(store.get(item.id).history.at(-1).to, 'done')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('invalid transitions and scopes are enforced', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-items-'))
  try {
    const store = new WorkItemStore({ file: path.join(dir, 'items.json'), now: () => 1000 })
    await store.load()
    const item = await store.create({ kind: 'goal', title: 'Цель', ownerId: '42', scopeId: 's1' })
    await store.update(item.id, { status: 'active' })
    await assert.rejects(() => store.update(item.id, { status: 'open' }), /запрещён/)
    await assert.rejects(() => store.create({ kind: 'goal', title: '' , ownerId: '42' }), /некорректное/)
    assert.equal(store.list({ scopeId: 's2' }).length, 0)
    assert.equal(canTransitionWorkItem('open', 'active'), true)
    assert.equal(canTransitionWorkItem('done', 'open'), false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('staleAfter marks a record stale without deleting it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-items-'))
  try {
    const store = new WorkItemStore({ file: path.join(dir, 'items.json'), now: () => Date.parse('2026-10-20T00:00:00Z') })
    await store.load()
    const item = await store.create({ kind: 'obligation', title: 'Оплатить', ownerId: '42', staleAfter: '2026-10-19T00:00:00Z' })
    assert.equal(isStale(store.get(item.id), Date.parse('2026-10-20T00:00:00Z')), true)
    assert.equal(store.list({ includeStale: false }).length, 0)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
