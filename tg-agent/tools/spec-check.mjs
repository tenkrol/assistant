#!/usr/bin/env node
/**
 * Валидация структуры OpenSpec без внешних зависимостей.
 *
 * Проверяет папки активных изменений, дельты-спеки и обязательные файлы процесса.
 * Это замена `openspec validate`: CLI мы не используем, структура держится вручную.
 *
 *   node tg-agent/tools/spec-check.mjs [корень репозитория]
 */
import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2] ?? process.cwd()
const changesDir = path.join(root, 'openspec/changes')
const specsDir = path.join(root, 'openspec/specs')
const DELTA = ['ADDED Requirements', 'MODIFIED Requirements', 'REMOVED Requirements']
const problems = []
const notes = []

/** Список каталогов, молча пустой, если каталога ещё нет. */
function dirs(at) {
  try {
    return fs.readdirSync(at, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch {
    return []
  }
}

// 1. Активные изменения (архив и шаблон не проверяем).
for (const entry of dirs(changesDir)) {
  if (entry.name === '_template' || entry.name === 'archive') continue
  const dir = path.join(changesDir, entry.name)
  if (!/^\d{4}-\d{2}-\d{2}-[\p{L}0-9-]+$/u.test(entry.name)) {
    problems.push(`change «${entry.name}»: имя должно быть ГГГГ-ММ-ДД-слаг`)
  }
  for (const required of ['proposal.md', 'design.md', 'tasks.md']) {
    if (!fs.existsSync(path.join(dir, required))) problems.push(`change «${entry.name}»: нет ${required}`)
  }
  const deltas = dirs(path.join(dir, 'specs'))
  if (deltas.length === 0) problems.push(`change «${entry.name}»: нет дельты specs/<домен>/spec.md`)
  for (const domain of deltas) {
    const file = path.join(dir, 'specs', domain.name, 'spec.md')
    if (!fs.existsSync(file)) {
      problems.push(`change «${entry.name}»: нет specs/${domain.name}/spec.md`)
      continue
    }
    const text = fs.readFileSync(file, 'utf8')
    if (!DELTA.some((d) => text.includes(d))) problems.push(`change «${entry.name}»/specs/${domain.name}: нет секций ADDED/MODIFIED/REMOVED`)
    if (!/^### Requirement:/m.test(text)) problems.push(`change «${entry.name}»/specs/${domain.name}: нет требований`)
    if (!fs.existsSync(path.join(specsDir, domain.name))) notes.push(`домен «${domain.name}» новый: спека появится после архивации`)
  }
}

// 2. Спеки доменов — источник правды.
for (const domain of dirs(specsDir)) {
  const file = path.join(specsDir, domain.name, 'spec.md')
  if (!fs.existsSync(file)) {
    problems.push(`specs/${domain.name}: нет spec.md`)
    continue
  }
  const text = fs.readFileSync(file, 'utf8')
  if (!/^### Requirement:/m.test(text)) problems.push(`specs/${domain.name}: нет требований`)
  if (!/^#### Scenario:/m.test(text)) notes.push(`specs/${domain.name}: нет сценариев GIVEN/WHEN/THEN`)
}

// 3. Обязательные файлы процесса.
for (const required of ['openspec/project.md', 'openspec/conventions.md', 'openspec/README.md', 'AGENTS.md']) {
  if (!fs.existsSync(path.join(root, required))) problems.push(`нет ${required}`)
}

for (const note of notes) console.log(`  замечание: ${note}`)
if (problems.length === 0) {
  console.log('OpenSpec: структура в порядке')
  process.exit(0)
}
console.error('OpenSpec: найдены проблемы:')
for (const problem of problems) console.error(`  ✗ ${problem}`)
process.exit(1)
