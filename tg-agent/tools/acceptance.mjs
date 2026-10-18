#!/usr/bin/env node
/**
 * Исполняемая приёмка: каталог сценариев, прогон автоматизируемых уровней и честный отчёт.
 *
 *   node tg-agent/tools/acceptance.mjs --list          сводка по статусам и уровням
 *   node tg-agent/tools/acceptance.mjs --check         валидация каталога (код 1 при ошибках)
 *   node tg-agent/tools/acceptance.mjs --show AC-07    подробности сценария
 *   node tg-agent/tools/acceptance.mjs --run           прогон unit/contract/integration + отчёт
 *   node tg-agent/tools/acceptance.mjs --report        итог последнего отчёта
 *
 * Для тестов самого инструмента есть служебный флаг --allow-partial (каталог меньше 30).
 *
 * Уровни unit/contract/integration запускаются настоящим `node --test` по полю `runner`
 * (файл или файл::группа). Уровень live не автоматизируется: он помечается blocked/not-run
 * с датой и SHA, пока сценарий не выполнен с реальным ботом.
 *
 * Статус passed ставится только после фактического прогона, в котором есть тесты и нет падений.
 * skipped и blocked успехом не считаются и всегда видны в итоге отдельной строкой.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tgDir = path.join(root, 'tg-agent')
const defaultCatalog = path.join(root, 'docs/acceptance/scenarios.json')
const defaultReport = path.join(root, 'docs/acceptance/report.json')

const LEVELS = ['unit', 'contract', 'integration', 'live']
const STATUSES = ['not-run', 'passed', 'failed', 'blocked', 'skipped']
const BP_IDS = ['BP-01', 'BP-02', 'BP-03', 'BP-04', 'BP-05', 'BP-06', 'BP-07']
// Связь области с BP только по существу: панель, голос, отправка, VK и файлы — не BP-пакет.
const BP_BY_AREA = {
  поручения: ['BP-01', 'BP-06'],
  память: ['BP-02'],
  проекты: ['BP-03'],
  проактивность: ['BP-04'],
  документы: ['BP-05'],
  приёмка: ['BP-07'],
}
const NON_BP_AREAS = new Set(['напоминания', 'календарь', 'панель', 'голос', 'отправка', 'VK', 'файлы', 'агент'])
const REQUIRED = [
  'id', 'bp', 'area', 'level', 'title', 'steps', 'expect', 'evidence',
  'runner', 'status', 'checkedAt', 'sha',
]

const options = {
  catalog: defaultCatalog,
  report: defaultReport,
  show: null,
  flags: new Set(),
}
const rawArgs = process.argv.slice(2)
for (let i = 0; i < rawArgs.length; i += 1) {
  const arg = rawArgs[i]
  if (arg === '--catalog') {
    options.catalog = path.resolve(root, rawArgs[i + 1] ?? '')
    i += 1
  } else if (arg === '--report') {
    const next = rawArgs[i + 1]
    if (next && !next.startsWith('--')) {
      options.report = path.resolve(root, next)
      i += 1
    }
    options.flags.add('--report')
  } else if (arg === '--show') {
    options.show = rawArgs[i + 1]
    i += 1
  } else {
    options.flags.add(arg)
  }
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function relativeToRoot(file) {
  const rel = path.relative(root, file)
  return rel.startsWith('..') ? file : rel
}

function readJson(file, what) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    console.error(`приёмка: нет ${what} ${file}`)
    process.exit(2)
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    console.error(`приёмка: ${what} не парсится (${error.message})`)
    process.exit(2)
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

function childEnv() {
  // Вложенный `node --test` не должен наследовать контекст внешнего тест-раннера.
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return env
}

function gitInfo() {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
  if (head.status !== 0 || !head.stdout.trim()) return { sha: null, shortSha: null, dirty: null }
  const sha = head.stdout.trim()
  return {
    sha,
    shortSha: sha.slice(0, 7),
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
  }
}

function parseRunner(runner) {
  const [file, ...rest] = String(runner).split('::')
  return { file: file.trim(), pattern: rest.join('::').trim() || null }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function validate(scenarios, { requireCount }) {
  const problems = []
  if (!Array.isArray(scenarios)) return ['каталог: scenarios не массив']
  if (scenarios.length === 0) problems.push('каталог пуст')
  if (requireCount && scenarios.length !== 30) {
    problems.push(`каталог: должно быть ровно 30 сценариев, сейчас ${scenarios.length}`)
  }
  const ids = new Set()
  for (const s of scenarios) {
    const name = s && typeof s.id === 'string' ? s.id : '?'
    if (!s || typeof s !== 'object') {
      problems.push(`${name}: сценарий не объект`)
      continue
    }
    for (const field of REQUIRED) {
      if (!Object.hasOwn(s, field)) problems.push(`${name}: нет поля ${field}`)
    }
    if (typeof s.id !== 'string' || !/^AC-\d{2}$/.test(s.id)) problems.push(`${name}: id должен быть AC-NN`)
    if (ids.has(s.id)) problems.push(`${name}: повторяется`)
    ids.add(s.id)
    if (typeof s.area !== 'string' || !s.area.trim()) problems.push(`${name}: нет области area`)
    if (!LEVELS.includes(s.level)) problems.push(`${name}: неизвестный уровень ${s.level}`)
    if (!STATUSES.includes(s.status)) problems.push(`${name}: неизвестный статус ${s.status}`)
    if (typeof s.title !== 'string' || !s.title.trim()) problems.push(`${name}: нет названия`)
    if (!Array.isArray(s.steps) || s.steps.length === 0 || s.steps.some((step) => typeof step !== 'string' || !step.trim())) {
      problems.push(`${name}: пустые шаги`)
    }
    if (typeof s.expect !== 'string' || !s.expect.trim()) problems.push(`${name}: пустое ожидание expect`)
    if (typeof s.evidence !== 'string' || !s.evidence.trim()) problems.push(`${name}: пустое доказательство evidence`)

    // Связь BP: у области есть разрешённый набор, у не-BP области связи быть не должно.
    const tokens = s.bp === null ? [] : String(s.bp).split('/').map((value) => value.trim()).filter(Boolean)
    if (s.bp !== null && tokens.length === 0) problems.push(`${name}: пустая связь bp`)
    if (new Set(tokens).size !== tokens.length) problems.push(`${name}: повторяется BP`)
    for (const token of tokens) {
      if (!BP_IDS.includes(token)) problems.push(`${name}: неизвестный BP ${token}`)
    }
    const allowed = BP_BY_AREA[s.area]
    if (allowed) {
      if (tokens.length === 0) problems.push(`${name}: для области ${s.area} нужна связь BP`)
      for (const token of tokens) {
        if (!allowed.includes(token)) problems.push(`${name}: область ${s.area} не относится к ${token}`)
      }
    } else if (!NON_BP_AREAS.has(s.area)) {
      problems.push(`${name}: неизвестная область ${s.area}`)
    } else if (s.bp !== null) {
      problems.push(`${name}: область ${s.area} не относится к BP, связь должна быть null`)
    }

    // Раннер: live — только manual, автоматизируемые уровни — существующий тест.
    if (s.level === 'live') {
      if (s.runner !== 'manual') problems.push(`${name}: live-сценарий должен иметь runner manual`)
    } else if (s.runner === 'manual') {
      problems.push(`${name}: уровню ${s.level} нужен автоматический runner`)
    } else {
      if (typeof s.runner !== 'string' || !s.runner.trim()) {
        problems.push(`${name}: нет runner`)
      } else {
        const { file, pattern } = parseRunner(s.runner)
        if (!/^test\/[^/]+\.test\.mjs$/.test(file) || file.includes('..')) {
          problems.push(`${name}: runner должен быть файлом test/*.test.mjs, а не ${file}`)
        } else if (!fs.existsSync(path.join(tgDir, file))) {
          problems.push(`${name}: файл раннера не найден ${file}`)
        }
        if (pattern !== null && !pattern) problems.push(`${name}: пустая группа после ::`)
      }
    }

    // Статус: любой результат, кроме not-run, обязан иметь дату и SHA фактического прогона.
    if (s.status !== 'not-run') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s.checkedAt ?? ''))) {
        problems.push(`${name}: статус ${s.status} без даты checkedAt`)
      }
      if (!/^[0-9a-f]{7,40}$/.test(String(s.sha ?? ''))) {
        problems.push(`${name}: статус ${s.status} без SHA`)
      }
    }
    if (s.status === 'passed') {
      if (s.level === 'live') problems.push(`${name}: live не может быть passed без живой проверки`)
      if (s.lastRun?.result !== 'passed') problems.push(`${name}: passed без фактического прогона`)
      if (!(s.lastRun?.tests?.total > 0)) problems.push(`${name}: passed без выполненных тестов`)
    }
    if (s.status === 'blocked' && !s.blockedReason && !s.lastRun?.reason) {
      problems.push(`${name}: blocked без причины`)
    }
    if (s.status === 'failed' && !s.lastRun?.reason) {
      problems.push(`${name}: failed без причины`)
    }
  }
  return problems
}

function printProblems(problems) {
  console.error('приёмка: найдены проблемы:')
  for (const problem of problems) console.error(`  ✗ ${problem}`)
}

const catalog = readJson(options.catalog, 'каталог')
const scenarios = Array.isArray(catalog.scenarios) ? catalog.scenarios : []

if (options.show) {
  const found = scenarios.find((s) => s.id === options.show)
  if (!found) {
    console.error(`приёмка: сценарий ${options.show} не найден`)
    process.exit(2)
  }
  console.log(`${found.id} [${found.bp ?? '—'}] ${found.title}`)
  console.log(`  область: ${found.area} · уровень: ${found.level} · статус: ${found.status}`)
  if (found.checkedAt || found.sha) console.log(`  проверен: ${found.checkedAt ?? '—'} · SHA: ${found.sha ?? '—'}`)
  console.log(`  раннер: ${found.runner}`)
  console.log('  шаги:')
  for (const step of found.steps) console.log(`    · ${step}`)
  console.log(`  ожидаем: ${found.expect}`)
  console.log(`  доказательство: ${found.evidence}`)
  if (found.blockedReason) console.log(`  почему blocked: ${found.blockedReason}`)
  if (found.lastRun?.reason) console.log(`  результат прогона: ${found.lastRun.reason}`)
  process.exit(0)
}

if (options.flags.has('--check')) {
  const problems = validate(scenarios, { requireCount: !options.flags.has('--allow-partial') })
  if (problems.length) {
    printProblems(problems)
    process.exit(1)
  }
  console.log(`приёмка: каталог в порядке, сценариев ${scenarios.length}`)
  process.exit(0)
}

function summarize(list) {
  const summary = { total: list.length, passed: 0, failed: 0, blocked: 0, skipped: 0, 'not-run': 0 }
  for (const s of list) {
    if (Object.hasOwn(summary, s.status)) summary[s.status] += 1
  }
  return summary
}

function printReport(report) {
  const summary = report.summary ?? summarize(report.scenarios ?? [])
  console.log(`Отчёт приёмки: ${report.generatedAt ?? '—'}`)
  console.log(`  SHA: ${report.shortSha ?? report.sha ?? '—'}${report.dirty ? ' (рабочее дерево изменено)' : ''}`)
  console.log(`  passed: ${summary.passed} · failed: ${summary.failed} · blocked: ${summary.blocked} · skipped: ${summary.skipped} · not-run: ${summary['not-run']}`)
  for (const s of report.scenarios ?? []) {
    if (s.status === 'failed') console.log(`  ✗ ${s.id} ${s.title ?? ''}: ${s.lastRun?.reason ?? 'провал'}`)
    if (s.status === 'blocked') console.log(`  ~ ${s.id} ${s.title ?? ''}: ${s.blockedReason ?? s.lastRun?.reason ?? 'ожидает прогона'}`)
  }
  if (summary.failed || summary.blocked || summary.skipped || summary['not-run']) {
    console.log('  failed/blocked/skipped/not-run успехом не считаются')
  }
}

if (options.flags.has('--report') && !options.flags.has('--run')) {
  const report = readJson(options.report, 'отчёт')
  const bad = (report.scenarios ?? []).filter((s) => s.status === 'passed'
    && (!s.checkedAt || !s.sha || s.lastRun?.result !== 'passed' || !(s.lastRun?.tests?.total > 0)))
  if (bad.length) {
    console.error('приёмка: в отчёте есть passed без фактического прогона:')
    for (const s of bad) console.error(`  ✗ ${s.id}`)
    process.exit(1)
  }
  printReport(report)
  process.exit(0)
}

if (options.flags.has('--run')) {
  const problems = validate(scenarios, { requireCount: !options.flags.has('--allow-partial') })
  if (problems.length) {
    printProblems(problems)
    process.exit(1)
  }
  const info = gitInfo()
  if (!info.sha) {
    console.error('приёмка: не удалось определить SHA репозитория — прогон без SHA запрещён')
    process.exit(2)
  }
  const generatedAt = new Date().toISOString()
  const checkedAt = today()
  const reportRel = relativeToRoot(options.report)

  for (const s of scenarios) {
    const startedAt = Date.now()
    if (s.level === 'live') {
      const reason = s.blockedReason || 'нужен живой прогон с реальным ботом; автотест не заменяет приёмку'
      s.status = 'blocked'
      s.checkedAt = checkedAt
      s.sha = info.sha
      s.lastRun = { at: generatedAt, sha: info.sha, report: reportRel, result: 'blocked', reason }
      console.log(`  ~ ${s.id} blocked: ${reason}`)
      continue
    }

    const { file, pattern } = parseRunner(s.runner)
    const args = ['--test', '--test-force-exit', '--test-reporter=tap']
    if (pattern) args.push(`--test-name-pattern=${escapeRegExp(pattern)}`)
    args.push(file)
    const child = spawnSync(process.execPath, args, {
      cwd: tgDir,
      encoding: 'utf8',
      env: childEnv(),
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    const output = `${child.stdout ?? ''}\n${child.stderr ?? ''}`
    const total = Number(output.match(/^# tests (\d+)$/m)?.[1] ?? 0)
    const pass = Number(output.match(/^# pass (\d+)$/m)?.[1] ?? 0)
    const fail = Number(output.match(/^# fail (\d+)$/m)?.[1] ?? 0)
    const skipped = Number(output.match(/^# skipped (\d+)$/m)?.[1] ?? 0)
    // Node считает сам файл одним «тестом», если --test-name-pattern не нашёл ни одного
    // подтеста. Отличаем это от настоящего прогона по именам подтестов.
    const subtestNames = [...output.matchAll(/^# Subtest: (.+)$/gm)].map((match) => match[1].trim())
    const matchedTests = pattern ? subtestNames.filter((name) => name !== file) : subtestNames
    const effectiveTotal = pattern && matchedTests.length === 0 ? 0 : total
    let reason = null
    if (child.error?.code === 'ETIMEDOUT') reason = 'прогон не уложился в 120 с'
    else if (child.error) reason = `раннер не запустился: ${child.error.message}`
    else if (effectiveTotal === 0) reason = 'раннер не нашёл ни одного теста (0 tests)'
    else if (fail > 0) reason = `тестов упало: ${fail}`
    else if (child.status !== 0) reason = `node --test завершился с кодом ${child.status}`
    else if (pass === 0) reason = 'не было ни одного пройденного теста'

    const result = reason ? 'failed' : 'passed'
    s.status = result
    s.checkedAt = checkedAt
    s.sha = info.sha
    s.lastRun = {
      at: generatedAt,
      sha: info.sha,
      report: reportRel,
      result,
      reason,
      command: `node ${args.join(' ')}`,
      tests: { total: effectiveTotal, pass, fail, skipped },
      durationMs: Date.now() - startedAt,
      outputTail: output.length <= 4000 ? output : `…${output.slice(-4000)}`,
    }
    const spent = Date.now() - startedAt
    const mark = result === 'passed' ? '✓' : '✗'
    console.log(`  ${mark} ${s.id} ${result}: тестов ${total}, упало ${fail}, ${spent} мс${reason ? ` — ${reason}` : ''}`)
  }

  const summary = summarize(scenarios)
  const report = {
    version: 1,
    generatedAt,
    sha: info.sha,
    shortSha: info.shortSha,
    dirty: info.dirty,
    catalog: relativeToRoot(options.catalog),
    report: reportRel,
    levels: LEVELS,
    statuses: STATUSES,
    summary,
    scenarios: scenarios.map((s) => ({
      id: s.id,
      bp: s.bp,
      area: s.area,
      level: s.level,
      title: s.title,
      runner: s.runner,
      status: s.status,
      checkedAt: s.checkedAt,
      sha: s.sha,
      evidence: s.evidence,
      blockedReason: s.blockedReason ?? null,
      lastRun: s.lastRun ?? null,
    })),
  }

  // Отчёт пишем до каталога: если запись каталога сорвётся, отчёт не соврёт о прогоне.
  writeJson(options.report, report)
  catalog.updatedAt = checkedAt
  catalog.lastRunAt = generatedAt
  // В каталоге храним только статус, дату, SHA и краткий результат — полный вывод живёт в отчёте.
  for (const s of scenarios) {
    if (s.lastRun) delete s.lastRun.outputTail
  }
  writeJson(options.catalog, catalog)

  console.log(`Итог: passed ${summary.passed} · failed ${summary.failed} · blocked ${summary.blocked} · skipped ${summary.skipped} · not-run ${summary['not-run']}`)
  console.log(`Отчёт: ${reportRel} (SHA ${info.shortSha}${info.dirty ? ', дерево изменено' : ''})`)
  if (options.flags.has('--report')) printReport(report)
  process.exit(summary.failed > 0 ? 1 : 0)
}

const counts = summarize(scenarios)
console.log(`Сценарии приёмки: всего ${scenarios.length}`)
console.log(`  passed: ${counts.passed} · failed: ${counts.failed} · blocked: ${counts.blocked} · skipped: ${counts.skipped} · not-run: ${counts['not-run']}`)
for (const level of LEVELS) {
  const list = scenarios.filter((s) => s.level === level)
  console.log(`  ${level}: ${list.length}`)
}
for (const s of scenarios) {
  const mark = s.status === 'passed' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'blocked' ? '~' : s.status === 'skipped' ? '-' : '·'
  console.log(`  ${mark} ${s.id} [${s.bp ?? '—'}] ${s.area} · ${s.title}`)
}
