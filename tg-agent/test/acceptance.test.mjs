/**
 * Исполняемая приёмка: каталог из 30 сценариев, схема полей, честный прогон и отчёт.
 *
 * Тесты не верят каталогу на слово: сценарий не может быть passed без фактического
 * прогона, live не может быть passed, а отчёт обязан отдельно считать blocked/skipped.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tool = path.join(root, 'tg-agent/tools/acceptance.mjs')
const catalogPath = path.join(root, 'docs/acceptance/scenarios.json')
const reportPath = path.join(root, 'docs/acceptance/report.json')
const matrixPath = path.join(root, 'docs/ACCEPTANCE-MATRIX.md')
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
const scenarios = catalog.scenarios

const LEVELS = ['unit', 'contract', 'integration', 'live']
const STATUSES = ['not-run', 'passed', 'failed', 'blocked', 'skipped']
const BP_BY_AREA = {
  поручения: ['BP-01', 'BP-06'],
  память: ['BP-02'],
  проекты: ['BP-03'],
  проактивность: ['BP-04'],
  документы: ['BP-05'],
  приёмка: ['BP-07'],
}
const NON_BP_AREAS = new Set(['напоминания', 'календарь', 'панель', 'голос', 'отправка', 'VK', 'файлы', 'агент'])

function runTool(args) {
  return spawnSync(process.execPath, [tool, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  })
}

function temporary() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plb025-acceptance-'))
}

function baseScenario(overrides = {}) {
  return {
    id: 'AC-01',
    bp: null,
    area: 'голос',
    level: 'unit',
    title: 'Проверочный сценарий',
    steps: ['выполнить шаг'],
    expect: 'ожидаемый результат',
    evidence: 'доказательство',
    runner: 'test/tools-contract.test.mjs::исключение инструмента не вылетает наружу',
    status: 'not-run',
    checkedAt: null,
    sha: null,
    ...overrides,
  }
}

function writeFixture(dir, list) {
  const file = path.join(dir, 'scenarios.json')
  fs.writeFileSync(file, `${JSON.stringify({ version: 2, scenarios: list }, null, 2)}\n`)
  return file
}

test('каталог сценариев приёмки: 30 сценариев, уровни и связи BP', () => {
  assert.equal(scenarios.length, 30, 'должно быть ровно 30 сценариев')
  assert.deepEqual(scenarios.map((s) => s.id).sort(), Array.from({ length: 30 }, (_, i) => `AC-${String(i + 1).padStart(2, '0')}`))
  for (const s of scenarios) {
    for (const field of ['id', 'bp', 'area', 'level', 'title', 'steps', 'expect', 'evidence', 'runner', 'status', 'checkedAt', 'sha']) {
      assert.ok(Object.hasOwn(s, field), `${s.id}: нет поля ${field}`)
    }
    assert.ok(LEVELS.includes(s.level), `${s.id}: неизвестный уровень ${s.level}`)
    assert.ok(STATUSES.includes(s.status), `${s.id}: неизвестный статус ${s.status}`)
    assert.ok(Array.isArray(s.steps) && s.steps.length > 0, `${s.id}: нет шагов`)
    assert.ok(typeof s.evidence === 'string' && s.evidence.trim(), `${s.id}: нет доказательства`)

    if (s.level === 'live') {
      assert.equal(s.runner, 'manual', `${s.id}: live обязан быть manual`)
      assert.notEqual(s.status, 'passed', `${s.id}: live не может быть passed без живой проверки`)
    } else {
      assert.notEqual(s.runner, 'manual', `${s.id}: уровню ${s.level} нужен автоматический раннер`)
      const [file] = s.runner.split('::')
      assert.match(file, /^test\/[^/]+\.test\.mjs$/, `${s.id}: раннер вне test/`)
      assert.ok(fs.existsSync(path.join(root, 'tg-agent', file)), `${s.id}: файла раннера нет`)
    }

    if (s.status !== 'not-run') {
      assert.match(String(s.checkedAt), /^\d{4}-\d{2}-\d{2}$/, `${s.id}: результат без даты`)
      assert.match(String(s.sha), /^[0-9a-f]{7,40}$/, `${s.id}: результат без SHA`)
    }
    if (s.status === 'passed') {
      assert.equal(s.lastRun?.result, 'passed', `${s.id}: passed без фактического прогона`)
      assert.ok(s.lastRun?.tests?.total > 0, `${s.id}: passed без выполненных тестов`)
    }

    // Связь BP только по существу: панель, голос и отправка не притворяются BP-04/BP-05.
    const tokens = s.bp === null ? [] : String(s.bp).split('/').map((value) => value.trim())
    if (BP_BY_AREA[s.area]) {
      assert.ok(tokens.length > 0, `${s.id}: у области ${s.area} нет BP`)
      for (const token of tokens) assert.ok(BP_BY_AREA[s.area].includes(token), `${s.id}: ${s.area} не относится к ${token}`)
    } else {
      assert.ok(NON_BP_AREAS.has(s.area), `${s.id}: неизвестная область ${s.area}`)
      assert.equal(s.bp, null, `${s.id}: область ${s.area} не относится к BP`)
    }
  }

  const byArea = (area) => scenarios.filter((s) => s.area === area)
  assert.ok(byArea('панель').every((s) => s.bp === null), 'язык панели — не BP-04')
  assert.ok(byArea('голос').every((s) => s.bp === null), 'голос — не BP-04')
  assert.ok(byArea('отправка').every((s) => s.bp === null), 'отправка — не BP-05')
  assert.deepEqual([...new Set(byArea('память').flatMap((s) => s.bp.split('/')))], ['BP-02'])
  assert.deepEqual([...new Set(byArea('проекты').flatMap((s) => s.bp.split('/')))], ['BP-03'])
  assert.deepEqual([...new Set(byArea('проактивность').flatMap((s) => s.bp.split('/')))], ['BP-04'])
  assert.deepEqual([...new Set(byArea('документы').flatMap((s) => s.bp.split('/')))], ['BP-05'])
  assert.ok(byArea('поручения').every((s) => /BP-0[16]/.test(s.bp)), 'поручения относятся только к BP-01/BP-06')
})

test('acceptance.mjs --check проходит на реальном каталоге', () => {
  const result = runTool(['--check'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /каталог в порядке, сценариев 30/)
})

test('--check падает на сценарии без уровня, статуса и раннера', () => {
  const dir = temporary()
  try {
    const file = writeFixture(dir, [
      baseScenario({ id: 'AC-01', level: undefined, runner: undefined, status: 'not-run' }),
      baseScenario({ id: 'AC-02', status: 'готово', level: 'unit', runner: 'manual' }),
      baseScenario({ id: 'AC-03', area: 'панель', bp: 'BP-04', level: 'contract', runner: 'test/tools-contract.test.mjs' }),
      baseScenario({ id: 'AC-04', status: 'passed', checkedAt: '2026-10-18', sha: 'a'.repeat(40) }),
    ])
    const result = runTool(['--check', '--catalog', file, '--allow-partial'])
    const strict = runTool(['--check', '--catalog', file])
    assert.equal(strict.status, 1)
    assert.match(strict.stderr, /ровно 30 сценариев/)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /нет поля level/)
    assert.match(result.stderr, /нет поля runner/)
    assert.match(result.stderr, /неизвестный статус готово/)
    assert.match(result.stderr, /область панель не относится к BP/)
    assert.match(result.stderr, /passed без фактического прогона/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('--run не ставит passed без прогона и честно считает failed/blocked', () => {
  const dir = temporary()
  try {
    const file = writeFixture(dir, [
      baseScenario({ id: 'AC-01' }),
      baseScenario({ id: 'AC-02', area: 'файлы', level: 'integration', runner: 'test/tools-contract.test.mjs::такого теста нет' }),
      baseScenario({ id: 'AC-03', area: 'голос', level: 'live', runner: 'manual', title: 'Живой сценарий' }),
    ])
    const reportFile = path.join(dir, 'report.json')
    const result = runTool(['--run', '--catalog', file, '--report', reportFile, '--allow-partial'])
    assert.equal(result.status, 1, 'падение автоматического сценария обязано ронять прогон')

    const updated = JSON.parse(fs.readFileSync(file, 'utf8'))
    const passed = updated.scenarios.find((s) => s.id === 'AC-01')
    const failed = updated.scenarios.find((s) => s.id === 'AC-02')
    const live = updated.scenarios.find((s) => s.id === 'AC-03')

    assert.equal(passed.status, 'passed')
    assert.match(passed.checkedAt, /^\d{4}-\d{2}-\d{2}$/)
    assert.match(passed.sha, /^[0-9a-f]{40}$/)
    assert.equal(passed.lastRun.result, 'passed')
    assert.ok(passed.lastRun.tests.total > 0)

    assert.equal(failed.status, 'failed', 'раннер без тестов не может дать passed')
    assert.match(failed.lastRun.reason, /не нашёл ни одного теста/)
    assert.equal(failed.lastRun.tests.total, 0)

    assert.equal(live.status, 'blocked', 'live не становится passed')
    assert.notEqual(live.status, 'passed')
    assert.match(live.checkedAt, /^\d{4}-\d{2}-\d{2}$/)
    assert.match(live.sha, /^[0-9a-f]{40}$/)
    assert.equal(live.lastRun.result, 'blocked')

    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
    assert.equal(report.summary.total, 3)
    assert.equal(report.summary.passed, 1)
    assert.equal(report.summary.failed, 1)
    assert.equal(report.summary.blocked, 1)
    assert.equal(report.summary.skipped, 0)
    assert.equal(report.summary['not-run'], 0)
    assert.equal(report.scenarios.length, 3)
    assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.match(report.sha, /^[0-9a-f]{40}$/)
    assert.equal(typeof report.dirty, 'boolean')
    assert.ok(report.scenarios.every((s) => s.status !== 'passed' || s.lastRun?.tests?.total > 0))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('--report показывает blocked отдельно и не выдаёт его за успех', () => {
  const dir = temporary()
  try {
    const file = writeFixture(dir, [
      baseScenario({ id: 'AC-01' }),
      baseScenario({ id: 'AC-02', level: 'live', area: 'агент', runner: 'manual' }),
    ])
    const reportFile = path.join(dir, 'report.json')
    const run = runTool(['--run', '--catalog', file, '--report', reportFile, '--allow-partial'])
    assert.equal(run.status, 0, 'blocked не должен ронять прогон, но и не считается успехом')
    assert.match(run.stdout, /passed 1 · failed 0 · blocked 1/)

    const shown = runTool(['--report', reportFile])
    assert.equal(shown.status, 0, shown.stderr)
    assert.match(shown.stdout, /passed: 1 · failed: 0 · blocked: 1 · skipped: 0 · not-run: 0/)
    assert.match(shown.stdout, /failed\/blocked\/skipped\/not-run успехом не считаются/)

    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
    assert.equal(report.summary.passed, 1)
    assert.equal(report.summary.blocked, 1)
    assert.equal(report.summary.total, report.summary.passed + report.summary.blocked)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('матрица приёмки: BP-01…BP-07 и четыре раздельных статуса', () => {
  assert.ok(fs.existsSync(matrixPath), 'нет docs/ACCEPTANCE-MATRIX.md')
  const matrix = fs.readFileSync(matrixPath, 'utf8')
  for (let i = 1; i <= 7; i += 1) assert.match(matrix, new RegExp(`BP-0${i}`), `в матрице нет BP-0${i}`)
  for (const column of ['Код готов', 'Проверено тестами', 'Установлено в проде', 'Принято живым сценарием']) {
    assert.ok(matrix.includes(column), `в матрице нет столбца «${column}»`)
  }
  assert.ok(matrix.includes('acceptance/report.json'), 'матрица не ссылается на отчёт')
  assert.match(matrix, /[0-9a-f]{7,40}/, 'матрица не ссылается на SHA')
})

// Отчёт появится после `--run`; до первого прогона проверять нечего.
const reportSkip = fs.existsSync(reportPath) ? false : 'отчёт ещё не создан: выполните acceptance.mjs --run'
test('отчёт приёмки: passed только после прогона, live не passed', { skip: reportSkip }, () => {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  assert.equal(report.summary.total, 30)
  assert.equal(report.summary['not-run'], 0, 'после прогона not-run должен быть посчитан явно')
  for (const s of report.scenarios) {
    if (s.level === 'live') assert.notEqual(s.status, 'passed', `${s.id}: live не может быть passed`)
    if (s.status === 'passed') {
      assert.match(String(s.checkedAt), /^\d{4}-\d{2}-\d{2}$/)
      assert.match(String(s.sha), /^[0-9a-f]{7,40}$/)
      assert.equal(s.lastRun?.result, 'passed')
      assert.ok(s.lastRun?.tests?.total > 0)
    }
  }
})
