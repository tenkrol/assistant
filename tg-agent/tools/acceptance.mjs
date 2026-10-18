#!/usr/bin/env node
/**
 * Каталог сценариев приёмки: список и проверка.
 *
 *   node tg-agent/tools/acceptance.mjs --list          сводка по статусам
 *   node tg-agent/tools/acceptance.mjs --check         валидация каталога (код 1 при ошибках)
 *   node tg-agent/tools/acceptance.mjs --show AC-07    подробности сценария
 *
 * Сценарий приёмки — доказательство того, что пользовательская задача действительно решается.
 * Статус «готово» ставится только после фактического прогона, а не после зелёных модульных тестов.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const catalogPath = path.join(root, 'docs/acceptance/scenarios.json')
const args = process.argv.slice(2)
const required = ['id', 'bp', 'title', 'steps', 'expect', 'evidence', 'status']
const statuses = ['done', 'partial', 'todo']

function load() {
  let raw
  try {
    raw = fs.readFileSync(catalogPath, 'utf8')
  } catch {
    console.error(`приёмка: нет каталога ${catalogPath}`)
    process.exit(2)
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    console.error(`приёмка: каталог не парсится (${error.message})`)
    process.exit(2)
  }
}

const catalog = load()
const scenarios = Array.isArray(catalog.scenarios) ? catalog.scenarios : []

if (args.includes('--check')) {
  const problems = []
  const ids = new Set()
  for (const s of scenarios) {
    for (const field of required) {
      if (s[field] === undefined || s[field] === null || s[field] === '') problems.push(`${s.id ?? '?'}: нет поля ${field}`)
    }
    if (Array.isArray(s.steps) && s.steps.length === 0) problems.push(`${s.id}: пустые шаги`)
    if (s.status && !statuses.includes(s.status)) problems.push(`${s.id}: неизвестный статус ${s.status}`)
    if (ids.has(s.id)) problems.push(`${s.id}: повторяется`)
    ids.add(s.id)
  }
  if (scenarios.length === 0) problems.push('каталог пуст')
  if (problems.length) {
    console.error('приёмка: найдены проблемы:')
    for (const p of problems) console.error(`  ✗ ${p}`)
    process.exit(1)
  }
  console.log(`приёмка: каталог в порядке, сценариев ${scenarios.length}`)
  process.exit(0)
}

if (args.includes('--show')) {
  const id = args[args.indexOf('--show') + 1]
  const found = scenarios.find((s) => s.id === id)
  if (!found) {
    console.error(`приёмка: сценарий ${id} не найден`)
    process.exit(2)
  }
  console.log(`${found.id} [${found.bp}] ${found.title}`)
  console.log(`  статус: ${found.status}${found.checkedAt ? ` (проверен ${found.checkedAt})` : ''}`)
  console.log('  шаги:')
  for (const step of found.steps) console.log(`    · ${step}`)
  console.log(`  ожидаем: ${found.expect}`)
  console.log(`  доказательство: ${found.evidence}`)
  process.exit(0)
}

const counts = { done: 0, partial: 0, todo: 0 }
for (const s of scenarios) counts[s.status] = (counts[s.status] ?? 0) + 1
console.log(`Сценарии приёмки: всего ${scenarios.length}`)
console.log(`  готово: ${counts.done} · частично: ${counts.partial} · не реализовано: ${counts.todo}`)
for (const s of scenarios) {
  const mark = s.status === 'done' ? '✓' : s.status === 'partial' ? '~' : '·'
  console.log(`  ${mark} ${s.id} [${s.bp}] ${s.title}`)
}
