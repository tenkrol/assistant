/**
 * Tests for tools/deploy-safe.mjs.
 *
 * These run on a Mac without systemd or root: systemctl/journalctl/chown come
 * from an injected `runner`, the clock and `sleep` are injected as well, while
 * `node --check` and `node --test` are the real commands, run against small
 * throwaway projects in a temporary directory.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { deploySafe } from '../tools/deploy-safe.mjs'

const SERVICE = 'tg-agent'
const SECRET = '123456:SUPERSECRETTOKENVALUE'

const PASSING_TEST = [
  "import test from 'node:test'",
  "import assert from 'node:assert/strict'",
  "test('поддельный тест проходит', () => { assert.equal(1, 1) })",
  '',
].join('\n')

const FAILING_TEST = [
  "import test from 'node:test'",
  "import assert from 'node:assert/strict'",
  "test('поддельный тест падает', () => { assert.equal(1, 2) })",
  '',
].join('\n')

/** Write a file, creating parent directories. */
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

/** A small stand-in for the project: sources, one test, and state to exclude. */
function makeSource({ broken = false, failingTest = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-safe-src-'))
  write(path.join(root, 'src', 'index.mjs'), broken ? 'const = ;\n' : "console.log('ok')\n")
  write(path.join(root, 'tools', 'helper.mjs'), 'export const value = 1\n')
  write(path.join(root, 'test', 'sample.test.mjs'), failingTest ? FAILING_TEST : PASSING_TEST)
  write(path.join(root, 'data', 'state.json'), '{}\n')
  write(path.join(root, '.git', 'config'), '[core]\n')
  write(path.join(root, 'backups', 'state.tar.gz'), 'x')
  write(path.join(root, '.ssh', 'id_deploy'), 'x')
  return root
}

/**
 * A fake server layout: a releases directory, some old releases, and the
 * `current` symlink pointing at the newest of them.
 */
function createInstall({ releaseNames: names = ['release-20200101-000000', 'release-20200102-000000'], broken = false, failingTest = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-safe-srv-'))
  const releasesDir = path.join(root, 'releases')
  const currentLink = path.join(root, 'current')
  fs.mkdirSync(releasesDir, { recursive: true })
  for (const name of names) {
    const dir = path.join(releasesDir, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'RELEASE'), `${name}\n`)
    fs.writeFileSync(path.join(dir, '.env'), `TELEGRAM_BOT_TOKEN=${SECRET}\nALLOWED_USER_IDS=1\n`)
  }
  const previous = path.join(releasesDir, names[names.length - 1])
  fs.symlinkSync(previous, currentLink)
  return {
    root,
    releasesDir,
    currentLink,
    previous,
    envFile: path.join(previous, '.env'),
    source: makeSource({ broken, failingTest }),
  }
}

/** Release directory names, oldest first. */
const releaseNames = (releasesDir) =>
  fs.readdirSync(releasesDir).filter((name) => name.startsWith('release-')).sort()

/** A clock that advances on every reading, so health polling needs no waiting. */
function createClock(start = Date.now(), stepMs = 1000) {
  let value = start
  return () => {
    value += stepMs
    return value
  }
}

/**
 * The fake systemd: `is-active`, `restart`, `journalctl` and `chown`.
 *
 * `activeQueue` is consumed by the restarts, so a test can make the first
 * restart (the new release) fail and the second (the rollback) succeed.
 * `journalErrors` are returned in the error window until the second restart.
 */
function createFakeSystem({ clock, activeQueue = null, journalErrors = [] }) {
  const state = { active: 'active', restarts: [] }
  const queue = activeQueue ? [...activeQueue] : null
  const runner = (command, args) => {
    if (command === 'systemctl' && args[0] === 'is-active') {
      return { status: 0, stdout: `${state.active}\n`, stderr: '' }
    }
    if (command === 'systemctl' && args[0] === 'restart') {
      state.restarts.push(args[1])
      if (queue && queue.length > 0) state.active = queue.shift()
      return { status: 0, stdout: '', stderr: '' }
    }
    if (command === 'journalctl') {
      const isJson = args.includes('-o') && args[args.indexOf('-o') + 1] === 'json'
      if (isJson) {
        const line = JSON.stringify({ __REALTIME_TIMESTAMP: String(clock() * 1000), MESSAGE: 'started' })
        return { status: 0, stdout: `${line}\n`, stderr: '' }
      }
      const errors = journalErrors.length > 0 && state.restarts.length <= 1
      return { status: 0, stdout: errors ? `${journalErrors.join('\n')}\n` : '', stderr: '' }
    }
    if (command === 'chown') return { status: 0, stdout: '', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { runner, state }
}

/** Run deploySafe against a fixture, capturing everything it logs. */
async function invoke(install, { clock, system, ...overrides } = {}) {
  const lines = []
  const code = await deploySafe({
    from: install.source,
    releasesDir: install.releasesDir,
    currentLink: install.currentLink,
    envFile: install.envFile,
    service: SERVICE,
    keep: 3,
    runner: system.runner,
    now: clock,
    sleep: async () => {},
    env: {},
    log: (line) => lines.push(line),
    error: (line) => lines.push(line),
    testTimeoutSec: 60,
    healthTimeoutSec: 2,
    ...overrides,
  })
  return { code, lines, output: lines.join('\n') }
}

test('отказывается переключаться при синтаксической ошибке в новой версии', async () => {
  const install = createInstall({ broken: true })
  const clock = createClock()
  const system = createFakeSystem({ clock })
  const before = releaseNames(install.releasesDir)

  const { code, output } = await invoke(install, { clock, system })

  assert.equal(code, 1)
  assert.equal(fs.readlinkSync(install.currentLink), install.previous, 'CURRENT не должен меняться')
  assert.equal(system.state.restarts.length, 0)
  assert.deepEqual(releaseNames(install.releasesDir), before)
  assert.match(output, /node --check не прошёл/)
  assert.match(output, /код выхода: 1/)
})

test('отказывается переключаться, когда тесты падают', async () => {
  const install = createInstall({ failingTest: true })
  const clock = createClock()
  const system = createFakeSystem({ clock })
  const before = releaseNames(install.releasesDir)

  const { code, output } = await invoke(install, { clock, system })

  assert.equal(code, 1)
  assert.equal(fs.readlinkSync(install.currentLink), install.previous)
  assert.equal(system.state.restarts.length, 0)
  assert.deepEqual(releaseNames(install.releasesDir), before)
  assert.match(output, /тесты не прошли/)
  assert.match(output, /код выхода: 1/)
})

test('успешный деплой: релиз, симлинк, перезапуск и очистка по KEEP', async () => {
  const names = [
    'release-20200101-000000',
    'release-20200102-000000',
    'release-20200103-000000',
    'release-20200104-000000',
  ]
  const install = createInstall({ releaseNames: names })
  const clock = createClock()
  const system = createFakeSystem({ clock })

  const { code, output } = await invoke(install, { clock, system })

  assert.equal(code, 0)
  const after = releaseNames(install.releasesDir)
  assert.equal(after.length, 3, 'должно остаться ровно KEEP релизов')
  assert.deepEqual(after, ['release-20200103-000000', 'release-20200104-000000', after[2]])
  assert.ok(!after.includes('release-20200101-000000'))
  assert.ok(!after.includes('release-20200102-000000'))
  assert.ok(after.includes('release-20200104-000000'), 'предыдущий релиз неприкосновенен')

  const active = fs.readlinkSync(install.currentLink)
  assert.equal(path.basename(active), after[2])
  assert.deepEqual(system.state.restarts, [SERVICE])

  // The release holds the project, minus the state directories.
  assert.ok(fs.existsSync(path.join(active, 'src', 'index.mjs')))
  assert.ok(fs.existsSync(path.join(active, 'tools', 'helper.mjs')))
  assert.ok(fs.existsSync(path.join(active, 'test', 'sample.test.mjs')))
  for (const excluded of ['data', '.git', 'backups', '.ssh']) {
    assert.equal(fs.existsSync(path.join(active, excluded)), false, `${excluded} не должен копироваться`)
  }

  // The working .env is moved over, locked down, and never printed.
  const envPath = path.join(active, '.env')
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600)
  assert.match(fs.readFileSync(envPath, 'utf8'), /SUPERSECRETTOKENVALUE/)
  assert.equal(output.includes('SUPERSECRETTOKENVALUE'), false, 'токен не должен попадать в вывод')
  assert.match(output, /тесты пройдены: 1/)
})

test('откат при неактивном сервисе после переключения', async () => {
  const install = createInstall({ releaseNames: ['release-20200101-000000', 'release-20200102-000000'] })
  const clock = createClock()
  const system = createFakeSystem({ clock, activeQueue: ['inactive', 'active'] })

  const { code, output } = await invoke(install, { clock, system })

  assert.equal(code, 1)
  assert.equal(fs.readlinkSync(install.currentLink), install.previous, 'симлинк должен вернуться')
  assert.deepEqual(system.state.restarts, [SERVICE, SERVICE], 'нужна попытка второго restart')
  assert.match(output, /ОТКАТ/)
  assert.match(output, /systemctl is-active/)
  assert.match(output, /откат выполнен/)
  assert.match(output, /код выхода: 1/)
})

test('откат при ERROR в журнале после переключения', async () => {
  const install = createInstall({ releaseNames: ['release-20200101-000000', 'release-20200102-000000'] })
  const clock = createClock()
  const system = createFakeSystem({ clock, journalErrors: ['2026-10-07T01:00:00+0300 host node[1]: ERROR boom'] })

  const { code, output } = await invoke(install, { clock, system })

  assert.equal(code, 1)
  assert.equal(fs.readlinkSync(install.currentLink), install.previous)
  assert.deepEqual(system.state.restarts, [SERVICE, SERVICE])
  assert.match(output, /ERROR за последнюю минуту/)
  assert.match(output, /откат выполнен/)
  assert.match(output, /код выхода: 1/)
})

test('--dry-run прогоняет проверки, но ничего не переключает', async () => {
  const install = createInstall()
  const clock = createClock()
  const system = createFakeSystem({ clock })
  const before = releaseNames(install.releasesDir)

  const { code, output } = await invoke(install, { clock, system, dryRun: true })

  assert.equal(code, 0)
  assert.equal(fs.readlinkSync(install.currentLink), install.previous)
  assert.deepEqual(releaseNames(install.releasesDir), before, 'новый релиз не создаётся')
  assert.equal(system.state.restarts.length, 0)
  assert.match(output, /dry-run/)
  assert.match(output, /тесты пройдены: 1/)
})

test('--status печатает активный релиз и список релизов', async () => {
  const names = ['release-20200101-000000', 'release-20200102-000000']
  const install = createInstall({ releaseNames: names })
  const clock = createClock()
  const system = createFakeSystem({ clock })

  const { code, output } = await invoke(install, { clock, system, status: true })

  assert.equal(code, 0)
  assert.match(output, /активный релиз:/)
  assert.ok(output.includes(install.previous), 'активный релиз должен быть указан')
  for (const name of names) assert.ok(output.includes(name), name)
  assert.match(output, /<-- активен/)
  assert.equal(system.state.restarts.length, 0)
})

test('код выхода 1 и при отказе без источника, и при откате', async () => {
  // Refusal: there is nothing to deploy.
  const missing = createInstall()
  missing.source = path.join(missing.root, 'nope')
  const clock = createClock()
  const system = createFakeSystem({ clock })
  const refused = await invoke(missing, { clock, system })
  assert.equal(refused.code, 1)
  assert.match(refused.output, /нет src\/index\.mjs/)

  // Rollback (tests skipped for speed, but the flag is announced loudly).
  const rollbackInstall = createInstall()
  const rollbackClock = createClock()
  const rollbackSystem = createFakeSystem({ clock: rollbackClock, activeQueue: ['inactive', 'active'] })
  const rolledBack = await invoke(rollbackInstall, { clock: rollbackClock, system: rollbackSystem, noTests: true })
  assert.equal(rolledBack.code, 1)
  assert.match(rolledBack.output, /--no-tests/)
  assert.equal(fs.readlinkSync(rollbackInstall.currentLink), rollbackInstall.previous)
})

test('macOS sidecar files are ignored and never block a deploy', async () => {
  const { isJunkFile } = await import('../tools/deploy-safe.mjs')
  assert.equal(isJunkFile('._index.mjs'), true)
  assert.equal(isJunkFile('.DS_Store'), true)
  assert.equal(isJunkFile('._port.mjs'), true)
  assert.equal(isJunkFile('index.mjs'), false)

  // A project copied from a Mac carries AppleDouble copies that end in .mjs.
  // They must not fail the syntax check, and must not reach the release.
  const clock = () => 1_700_000_000_000
  const system = createFakeSystem({ clock })
  const install = createInstall({})
  write(path.join(install.source, 'src', '._index.mjs'), '<<< not javascript <<<\n')
  write(path.join(install.source, 'tools', '._watchdog.mjs'), '<<< not javascript <<<\n')
  const { code, lines } = await invoke(install, { clock, system })
  assert.equal(code, 0, lines.join('\n'))
  const released = fs.readdirSync(install.releasesDir)
    .flatMap((name) => [path.join(install.releasesDir, name, 'src'), path.join(install.releasesDir, name, 'tools')])
    .filter((dir) => fs.existsSync(dir))
    .flatMap((dir) => fs.readdirSync(dir))
  assert.ok(released.includes('index.mjs'))
  assert.ok(!released.some((name) => name.startsWith('._')), 'сайдкар-файлы не попадают в релиз')
})
