/**
 * Tests for src/server-status.mjs.
 *
 * No real command ever runs: `collectServerStatus` takes its `exec` through
 * injection, so the suite works on a Mac without systemd, journalctl or `nproc`.
 * The outputs below are copied from real `uptime`, `free -m`, `df -h`, `du -h`
 * and `find` runs, spacing and all.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { SERVER_STATUS_HINT, collectServerStatus, formatServerStatus } from '../src/server-status.mjs'

/** A plausible Linux `free -m` with wide columns. */
const FREE_OUTPUT = [
  '               total        used        free      shared  buff/cache   available',
  'Mem:             707         436         271         100         200         271',
  'Swap:           2047           0        2047',
  '',
].join('\n')

/** The same numbers with the columns pushed apart by extra spaces. */
const FREE_SPACED = [
  '                 total          used          free        shared    buff/cache     available',
  'Mem:               707           436           271           100           200           271',
  'Swap:             2047             0          2047',
  '',
].join('\n')

/** An older procps without the `available` column: the `free` column is used. */
const FREE_OLD = [
  '             total       used       free     shared    buffers     cached',
  'Mem:           707        436        271        100          0        200',
  'Swap:         2047          0       2047',
  '',
].join('\n')

/** `df -h /` on the VPS. */
const DF_OUTPUT = [
  'Filesystem      Size  Used Avail Use% Mounted on',
  '/dev/vda1        40G   29G  1.2G  74% /',
  '',
].join('\n')

const UPTIME_RAW = ' 01:20:01 up 5 days,  3:04,  2 users,  load average: 0.45, 0.21, 0.08\n'
const UPTIME_PRETTY = 'up 5 days, 3 hours\n'
const RELEASE_TARGET = '/opt/tg-agent-releases/release-20261008-195804\n'

/** Ten state files, the number the report renders as "10 файлов". */
const FIND_OUTPUT = `${Array.from({ length: 10 }, (_, i) => `/var/lib/tg-agent/${i}.json`).join('\n')}\n`

/** Happy-path command table, overridable per test. */
function normalHandlers(overrides = {}) {
  return {
    systemctl: () => ({ stdout: 'active\n' }),
    uptime: (args) => ({ stdout: args.includes('-p') ? UPTIME_PRETTY : UPTIME_RAW }),
    nproc: () => ({ stdout: '1\n' }),
    free: () => ({ stdout: FREE_OUTPUT }),
    df: () => ({ stdout: DF_OUTPUT }),
    readlink: () => ({ stdout: RELEASE_TARGET }),
    journalctl: () => ({ stdout: 'Oct 09 01:12:00 vps tg-agent[1]: polling ok\n' }),
    du: () => ({ stdout: '96K\t/var/lib/tg-agent\n' }),
    find: () => ({ stdout: FIND_OUTPUT }),
    ...overrides,
  }
}

/**
 * Build a fake `exec`.
 *
 * A command with no handler rejects the way a missing binary would; a handler
 * may throw to simulate a failure, and every call is recorded in `exec.calls`.
 */
function makeExec(handlers) {
  const calls = []
  const exec = async (command, args = []) => {
    calls.push({ command, args: [...args] })
    const handler = handlers[command]
    if (handler === undefined) {
      throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' })
    }
    const result = typeof handler === 'function' ? handler(args, calls) : handler
    if (result instanceof Error) throw result
    return { stdout: '', stderr: '', code: 0, ...result }
  }
  exec.calls = calls
  return exec
}

const collect = (exec, options = {}) => collectServerStatus({
  exec,
  now: () => new Date('2026-10-09T01:20:00+03:00'),
  ...options,
})

test('collects every fact from a healthy server', async () => {
  const status = await collect(makeExec(normalHandlers()), { label: 'Испания' })

  assert.equal(status.label, 'Испания')
  assert.equal(status.at, '2026-10-08T22:20:00.000Z')
  assert.deepEqual(status.services, [
    { name: 'tg-agent', active: true },
    { name: 'vk-agent', active: true },
  ])
  assert.deepEqual(status.load, { one: 0.45, five: 0.21, fifteen: 0.08 })
  assert.equal(status.cores, 1)
  assert.deepEqual(status.memory, { totalMb: 707, availableMb: 271 })
  assert.deepEqual(status.disk, { path: '/', usedPercent: 74, freeHuman: '1.2G' })
  assert.equal(status.uptime, '5 дней 3 часа')
  assert.equal(status.release, 'release-20261008-195804')
  assert.equal(status.errors, 0)
  assert.deepEqual(status.state, { files: 10, bytes: 96 * 1024 })
  assert.deepEqual(status.problems, [])
  assert.deepEqual(status.failures, [])
})

test('asks systemd about each service by name', async () => {
  const exec = makeExec(normalHandlers())
  await collect(exec)
  const serviceCalls = exec.calls.filter((call) => call.command === 'systemctl')
  assert.deepEqual(serviceCalls.map((call) => call.args), [
    ['is-active', 'tg-agent'],
    ['is-active', 'vk-agent'],
  ])
})

test('the report shows every fact and no placeholder lines', async () => {
  const status = await collect(makeExec(normalHandlers()), { label: 'Испания' })
  const report = formatServerStatus(status)

  assert.match(report, /^🖥 Испания · 09\.10 01:20 МСК$/m)
  assert.match(report, /^сервисы: tg-agent ✓, vk-agent ✓$/m)
  assert.match(report, /^нагрузка: 0\.45 \/ 0\.21 \/ 0\.08 · 1 ядро$/m)
  assert.match(report, /^память: 271 МБ свободно из 707 МБ$/m)
  assert.match(report, /^диск: 74% занято, 1\.2G свободно$/m)
  assert.match(report, /^аптайм: 5 дней 3 часа$/m)
  assert.match(report, /^релиз: release-20261008-195804$/m)
  assert.match(report, /^ошибок за час: 0$/m)
  assert.match(report, /^состояние: 10 файлов, 96 КБ$/m)
  assert.ok(!report.includes('⚠️'))
  assert.ok(!report.includes('не удалось узнать'))
  assert.ok(!/unknown|undefined|null|NaN/i.test(report))
  for (const line of report.split('\n')) assert.notEqual(line.trim(), '')
})

test('the report stays within ~15 lines', async () => {
  const status = await collect(makeExec(normalHandlers()), { label: 'Испания' })
  assert.ok(formatServerStatus(status).split('\n').length <= 15)
})

test('a failed service becomes an alarm and a cross in the report', async () => {
  const exec = makeExec(normalHandlers({
    systemctl: (args) => ({ stdout: args[1] === 'vk-agent' ? 'inactive\n' : 'active\n', code: args[1] === 'vk-agent' ? 3 : 0 }),
  }))
  const status = await collect(exec)
  const report = formatServerStatus(status)

  assert.deepEqual(status.services, [
    { name: 'tg-agent', active: true },
    { name: 'vk-agent', active: false },
  ])
  assert.ok(status.problems.some((problem) => problem.includes('vk-agent')), 'alarm mentions the unit')
  assert.match(report, /^сервисы: tg-agent ✓, vk-agent ✗$/m)
  assert.match(report, /⚠️ сервис vk-agent неактивен/)
})

test('a disk above the threshold alarms, one below does not', async () => {
  const high = makeExec(normalHandlers({
    df: () => ({ stdout: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda1        40G   38G  2.0G  95% /\n' }),
  }))
  const highStatus = await collect(high, { diskWarnPercent: 90 })
  assert.ok(highStatus.problems.some((problem) => problem.includes('диск')))
  assert.match(formatServerStatus(highStatus), /⚠️ диск: занято 95% \(порог 90%\)/)

  const low = makeExec(normalHandlers())
  const lowStatus = await collect(low, { diskWarnPercent: 90 })
  assert.ok(!lowStatus.problems.some((problem) => problem.includes('диск')))
  assert.ok(!formatServerStatus(lowStatus).includes('⚠️'))

  // The formatter has its own threshold and must not double the alarm.
  assert.match(formatServerStatus(lowStatus, { warnPercent: 70 }), /⚠️ диск: занято 74% \(порог 70%\)/)
  assert.equal(formatServerStatus(highStatus).split('⚠️ диск').length - 1, 1)
})

test('a rejected command never throws and lands in failures', async () => {
  const status = await collect(makeExec({}), { label: 'сервер' })

  assert.ok(status.failures.length >= 8, `failures: ${status.failures.join(' | ')}`)
  assert.ok(status.failures.some((failure) => failure === 'load: команда недоступна'))
  assert.ok(status.failures.some((failure) => failure.startsWith('сервис tg-agent:')))
  assert.equal(status.load, undefined)
  assert.equal(status.memory, undefined)
  assert.equal(status.disk, undefined)
  assert.equal(status.uptime, undefined)
  assert.equal(status.release, undefined)
  assert.equal(status.errors, undefined)
  assert.equal(status.state, undefined)
  assert.deepEqual(status.services, [])

  const report = formatServerStatus(status)
  assert.match(report, /^🖥 сервер · /)
  assert.match(report, /^не удалось узнать: .*load: команда недоступна/m)
})

test('a runner that throws synchronously is caught too', async () => {
  const exec = () => { throw new Error('boom') }
  const status = await collectServerStatus({ exec, now: () => new Date('2026-10-09T01:20:00+03:00') })
  assert.ok(status.failures.length > 0)
  assert.equal(status.at, '2026-10-08T22:20:00.000Z')
})

test('journalctl exit code 1 leaves the errors fact unknown but keeps the rest', async () => {
  const exec = makeExec(normalHandlers({
    journalctl: () => ({ code: 1, stderr: 'Failed to open journal: Permission denied' }),
  }))
  const status = await collect(exec)

  assert.equal(status.errors, undefined)
  assert.ok(status.failures.some((failure) => failure.startsWith('errors:')))
  assert.deepEqual(status.load, { one: 0.45, five: 0.21, fifteen: 0.08 })
  assert.ok(status.memory)
  assert.ok(status.disk)
  assert.ok(status.uptime)

  // Both attempts were made: with `-u` first, then the machine-wide window.
  const journalCalls = exec.calls.filter((call) => call.command === 'journalctl')
  assert.equal(journalCalls.length, 2)
  assert.ok(journalCalls[0].args.includes('-u'))
  assert.ok(!journalCalls[1].args.includes('-u'))
})

test('journalctl retries without -u and counts ERROR lines', async () => {
  const exec = makeExec(normalHandlers({
    journalctl: (args) => (args.includes('-u')
      ? { code: 1, stderr: 'no match' }
      : { stdout: 'Oct 09 01:10:00 vps tg-agent[1]: ERROR polling failed\nOct 09 01:11:00 vps tg-agent[1]: ok\n' }),
  }))
  const status = await collect(exec)
  assert.equal(status.errors, 1)
  assert.deepEqual(status.problems, ['за 60 мин в журнале найдено 1 строк ERROR'])
  assert.match(formatServerStatus(status), /⚠️ за 60 мин в журнале найдено 1 строк ERROR/)
})

test('journalctl "no entries" means zero errors, not a failure', async () => {
  const exec = makeExec(normalHandlers({
    journalctl: () => ({ code: 1, stderr: '-- No entries --' }),
  }))
  const status = await collect(exec)
  assert.equal(status.errors, 0)
  assert.ok(!status.failures.some((failure) => failure.startsWith('errors:')))
})

test('the release name comes from the resolved symlink target', async () => {
  const status = await collect(makeExec(normalHandlers()))
  assert.equal(status.release, 'release-20261008-195804')
  assert.match(formatServerStatus(status), /^релиз: release-20261008-195804$/m)
})

test('a plain release path yields its base name', async () => {
  const exec = makeExec(normalHandlers({ readlink: () => ({ stdout: '/opt/tg-agent\n' }) }))
  const status = await collect(exec)
  assert.equal(status.release, 'tg-agent')
  assert.match(formatServerStatus(status), /^релиз: tg-agent$/m)
})

test('a missing release path is simply no fact', async () => {
  const exec = makeExec(normalHandlers({ readlink: () => ({ code: 1, stdout: '', stderr: '' }) }))
  const status = await collect(exec)
  assert.equal(status.release, undefined)
  assert.ok(!status.failures.some((failure) => failure.startsWith('release:')))
  assert.ok(!formatServerStatus(status).includes('релиз:'))
})

test('parses load average with extra spaces and the macOS wording', async () => {
  const variants = [
    [' 01:20:01 up 5 days,  3:04,  2 users,  load average:  0.45,  0.21,  0.08\n', { one: 0.45, five: 0.21, fifteen: 0.08 }],
    [' 1:20  up 5 days,  3:04, 2 users, load averages: 1.24 1.10 0.98\n', { one: 1.24, five: 1.10, fifteen: 0.98 }],
    [' 01:20:01 up 42 min,  1 user,  load average: 2.00   1.50   1.00\n', { one: 2, five: 1.5, fifteen: 1 }],
  ]
  for (const [raw, expected] of variants) {
    const exec = makeExec(normalHandlers({
      uptime: (args) => ({ stdout: args.includes('-p') ? 'up 1 hour\n' : raw }),
    }))
    const status = await collect(exec)
    assert.deepEqual(status.load, expected, raw)
    assert.ok(!status.failures.some((failure) => failure.startsWith('load:')))
  }
})

test('parses free -m on wide, spaced and older layouts', async () => {
  const variants = [
    [FREE_OUTPUT, 707, 271],
    [FREE_SPACED, 707, 271],
    [FREE_OLD, 707, 271],
  ]
  for (const [output, totalMb, availableMb] of variants) {
    const exec = makeExec(normalHandlers({ free: () => ({ stdout: output }) }))
    const status = await collect(exec)
    assert.deepEqual(status.memory, { totalMb, availableMb })
  }
})

test('falls back to raw uptime when -p is not supported', async () => {
  const exec = makeExec(normalHandlers({
    uptime: (args) => (args.includes('-p')
      ? { code: 1, stdout: '', stderr: 'uptime: invalid option -- p' }
      : { stdout: UPTIME_RAW }),
  }))
  const status = await collect(exec)
  assert.equal(status.uptime, '5 дней 3 часа 4 минуты')
  assert.match(formatServerStatus(status), /^аптайм: 5 дней 3 часа 4 минуты$/m)
})

test('renders the hours:minutes form of raw uptime', async () => {
  const exec = makeExec(normalHandlers({
    uptime: (args) => (args.includes('-p')
      ? { code: 1, stdout: '', stderr: 'unsupported' }
      : { stdout: ' 01:20:01 up  3:04,  1 user,  load average: 0.10, 0.20, 0.30\n' }),
  }))
  const status = await collect(exec)
  assert.equal(status.uptime, '3 часа 4 минуты')
})

test('honours a custom window, threshold and server label', async () => {
  const exec = makeExec(normalHandlers({
    journalctl: () => ({ stdout: 'x ERROR y\nz ERROR w\n' }),
    df: () => ({ stdout: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda1        40G   38G  2.0G  91% /\n' }),
  }))
  const status = await collect(exec, {
    label: 'Испания',
    errorWindowMinutes: 20,
    diskWarnPercent: 95,
    services: ['tg-agent'],
    releasePath: '/opt/other',
    dataDir: '/srv/state',
    diskPath: '/srv',
  })

  assert.deepEqual(status.services, [{ name: 'tg-agent', active: true }])
  assert.equal(status.disk.path, '/srv')
  assert.equal(status.errors, 2)
  assert.ok(!status.problems.some((problem) => problem.includes('диск')), '91% is below the 95% threshold')
  assert.deepEqual(status.problems, ['за 20 мин в журнале найдено 2 строк ERROR'])

  const dfCall = exec.calls.find((call) => call.command === 'df')
  assert.deepEqual(dfCall.args, ['-h', '/srv'])
  const findCall = exec.calls.find((call) => call.command === 'find')
  assert.equal(findCall.args[0], '/srv/state')
  const readlinkCall = exec.calls.find((call) => call.command === 'readlink')
  assert.deepEqual(readlinkCall.args, ['-f', '/opt/other'])

  // The formatter's own default is 90, so the shared default would alarm here.
  assert.match(formatServerStatus(status, { warnPercent: 90 }), /⚠️ диск: занято 91% \(порог 90%\)/)
  assert.match(formatServerStatus(status), /^ошибок за 20 мин: 2$/m)
})

test('an empty status formats to a bare header with no stub lines', () => {
  const report = formatServerStatus({ at: '2026-10-08T22:20:00.000Z', label: 'сервер' })
  assert.equal(report, '🖥 сервер · 09.10 01:20 МСК')
  assert.ok(!/unknown|undefined|null|NaN/i.test(report))
})

test('an invalid clock still produces a usable report', async () => {
  const status = await collect(makeExec(normalHandlers()), { label: 'Испания', now: () => new Date('not a date') })
  assert.match(status.at, /^\d{4}-\d{2}-\d{2}T/)
  assert.ok(formatServerStatus(status).startsWith('🖥 Испания'))
})

test('a clock that throws does not escape collectServerStatus', async () => {
  const status = await collectServerStatus({ exec: makeExec(normalHandlers()), now: () => { throw new Error('clock broke') } })
  assert.match(status.at, /^\d{4}-\d{2}-\d{2}T/)
  assert.ok(status.load, 'facts are still collected')
})

test('an unknown time zone degrades to local time instead of throwing', async () => {
  const status = await collect(makeExec(normalHandlers()), { label: 'Испания', timeZone: 'Nowhere/Atlantis' })
  const report = formatServerStatus(status)
  assert.match(report, /^🖥 Испания · \d{2}\.\d{2} \d{2}:\d{2} Atlantis$/m)
})

test('the hint tells the model when to call the tool', () => {
  assert.equal(typeof SERVER_STATUS_HINT, 'string')
  assert.ok(SERVER_STATUS_HINT.length > 40)
  assert.match(SERVER_STATUS_HINT, /server_status/)
  assert.match(SERVER_STATUS_HINT, /нагрузк|диск/)
})
