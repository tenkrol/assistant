/**
 * Каталог сценариев приёмки: структурная проверка, чтобы он не разваливался.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'docs/acceptance/scenarios.json'), 'utf8'))
const scenarios = catalog.scenarios ?? []

test('каталог сценариев приёмки не пуст и у каждого есть доказательство', () => {
  assert.ok(scenarios.length >= 10, 'должно быть не меньше десяти сценариев')
  for (const s of scenarios) {
    for (const field of ['id', 'bp', 'title', 'expect', 'evidence', 'status']) {
      assert.ok(s[field], `${s.id}: нет поля ${field}`)
    }
    assert.ok(Array.isArray(s.steps) && s.steps.length > 0, `${s.id}: нет шагов`)
    assert.ok(['done', 'partial', 'todo'].includes(s.status), `${s.id}: неизвестный статус`)
  }
})

test('"готово" не ставится без даты фактической проверки', () => {
  for (const s of scenarios.filter((x) => x.status === 'done')) {
    assert.match(String(s.checkedAt), /^\d{4}-\d{2}-\d{2}$/, `${s.id}: статус done без checkedAt`)
  }
})

test('каталог покрывает все реализованные продуктовые темы', () => {
  const bp = new Set(scenarios.map((s) => String(s.bp)))
  for (const topic of ['BP-01', 'BP-04', 'BP-05', 'BP-06']) {
    assert.ok([...bp].some((value) => value.includes(topic)), `нет ни одного сценария по ${topic}`)
  }
})
