import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentFileStore } from '../src/agent-files.mjs'

test('файлы агента: сохранить, список, путь и удалить', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-files-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new AgentFileStore({ file: path.join(dir, 'agent-files.json'), directory: path.join(dir, 'files'), logger: { warn() {}, info() {} } })
  await store.load()
  const item = await store.add({ chatId: '42', name: 'отчёт.pdf', bytes: Buffer.from('agent'), mime: 'application/pdf' })
  assert.equal(store.list('42').length, 1)
  assert.ok(fs.existsSync(store.getPath(item)))
  assert.equal(fs.readFileSync(store.getPath(item), 'utf8'), 'agent')
  assert.equal(await store.remove({ chatId: '42', id: item.id }), true)
  assert.equal(store.list('42').length, 0)
})
