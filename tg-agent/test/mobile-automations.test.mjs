import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AutomationStore, nextRunAt } from '../src/mobile-automations.mjs'

test('автоматизации: расписание, включение и запуск', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automations-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new AutomationStore({ file: path.join(dir, 'automations.json'), logger: { warn() {}, info() {} } })
  await store.load()
  assert.ok(nextRunAt({ time: '09:00', weekdays: [], now: new Date('2026-10-19T05:00:00Z') }))
  const item = await store.add({ userId: 1, title: 'Тест', prompt: 'Проверь', time: '09:00' })
  assert.equal(store.list(1).length, 1)
  assert.equal(item.enabled, true)
  assert.ok(item.nextRunAt)
  await store.update({ userId: 1, id: item.id, enabled: false })
  assert.equal(store.list(1)[0].enabled, false)
  await store.markRun(item, { ok: true })
  assert.equal(store.list(1)[0].lastStatus, 'ok')
  await store.remove({ userId: 1, id: item.id })
  assert.equal(store.list(1).length, 0)
})
