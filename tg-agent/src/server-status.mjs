/**
 * Server status: the facts behind `/server` and "как там Испания?".
 *
 * The bot runs on a remote VPS, so "the server" always means the machine this
 * process lives on. Every fact is read with a local command through one
 * injectable `exec`, exactly like `tools/deploy-safe.mjs` does with its
 * `runner`: the module never opens a network connection and never runs SSH, and
 * the tests can drive it on a Mac where systemd and journalctl do not exist.
 *
 * Nothing here throws. A command that is missing, times out or returns garbage
 * becomes a line in `failures`, so the report can say honestly what could not
 * be found instead of pretending a fact is unknown.
 *
 * Thresholds and wording follow `tools/watchdog.mjs` on purpose: the same disk
 * percentage (90), the same journal window (`ERROR_WINDOW_MINUTES`), the same
 * harmless line (`offset save failed`) and the same "no entries" handling. The
 * bot and the watchdog must not contradict each other about the same server.
 */
import { execFile } from 'node:child_process'

/** Every local command gets the same budget, like the watchdog's SSH timeout. */
const COMMAND_TIMEOUT_MS = 10_000

/** Journal lines are small, but a busy unit can pour out a lot of them. */
const MAX_BUFFER = 4 * 1024 * 1024

/** Same harmless line the watchdog and deploy-safe ignore. */
const IGNORED_ERRORS = [/offset save failed/i]

/** Recognise "journalctl found nothing" as an empty window, not as a failure. */
const NO_ENTRIES_RE = /no entries|no journal files/i

/** Short zone names for the report header; anything else falls back to Intl. */
const ZONE_LABELS = { 'Europe/Moscow': 'МСК', 'Europe/Kaliningrad': 'КАЛИНИНГРАД', UTC: 'UTC' }

/**
 * Default command runner: `execFile` wrapped in a promise.
 *
 * Resolves for a non-zero exit too, because the exit code is itself a fact
 * (`journalctl` uses it to say "nothing matched"). Only a missing binary, a
 * timeout or a killed process rejects, and the caller turns that into a
 * `failures` entry.
 *
 * @param {string} command - binary name.
 * @param {string[]} args - arguments.
 * @param {object} [options] - `execFile` options.
 * @returns {Promise<{stdout: string, stderr: string, code: number}>} the result.
 */
function defaultExec(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_BUFFER, ...options }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: 0 })
        return
      }
      const code = Number(error.code)
      if (!Number.isFinite(code)) {
        reject(error)
        return
      }
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code })
    })
  })
}

/** A short, safe reason for one failed command. */
function describeError(error) {
  if (error?.code === 'ENOENT') return 'команда недоступна'
  if (error?.killed || error?.signal) return 'тайм-аут команды'
  const message = String(error?.message ?? error ?? 'неизвестная ошибка').replace(/\s+/g, ' ').trim()
  return message === '' ? 'неизвестная ошибка' : message.slice(0, 140)
}

/**
 * Russian plural form: `plural(5, 'файл', 'файла', 'файлов')`.
 *
 * @param {number} count - the quantity.
 * @param {string} one - form for 1, 21, 31…
 * @param {string} few - form for 2–4, 22–24…
 * @param {string} many - form for 0, 5–20, 25–30…
 * @returns {string} the number with its unit.
 */
function plural(count, one, few, many) {
  const value = Math.abs(count) % 100
  const last = value % 10
  if (value > 10 && value < 20) return `${count} ${many}`
  if (last === 1) return `${count} ${one}`
  if (last >= 2 && last <= 4) return `${count} ${few}`
  return `${count} ${many}`
}

/** `load average: 0.45, 0.21, 0.08` (Linux) or `load averages: 1.2 1.1 0.9` (macOS). */
function parseLoadAverage(text) {
  const match = /load averages?:\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(String(text ?? ''))
  if (!match) return undefined
  const [one, five, fifteen] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (![one, five, fifteen].every(Number.isFinite)) return undefined
  return { one, five, fifteen }
}

/**
 * `free -m`: total from the `Mem:` row, available from the column the header
 * names (column 6 in modern procps, column 5 `buff/cache` in older output —
 * hence the header lookup with the plain `free` column as a fallback).
 */
function parseFree(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const rowIndex = lines.findIndex((line) => /^\s*Mem:/i.test(line))
  if (rowIndex < 0) return undefined
  const header = lines.slice(0, rowIndex).reverse().find((line) => /\btotal\b/i.test(line) && /\bavailable\b/i.test(line))
  const cells = lines[rowIndex].trim().split(/\s+/)
  const totalMb = Number(cells[1])
  let availableMb
  if (header) {
    // `Mem:` occupies cell 0, so header name N sits at cell N + 1.
    const index = header.trim().split(/\s+/).findIndex((name) => /^available$/i.test(name)) + 1
    if (index > 0) availableMb = Number(cells[index])
  }
  if (!Number.isFinite(availableMb)) availableMb = Number(cells[3])
  if (!Number.isFinite(totalMb) || !Number.isFinite(availableMb)) return undefined
  return { totalMb, availableMb }
}

/** `df -h`: the first data row, `Use%` and the free-space field before it. */
function parseDf(text) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .find((row) => /%/.test(row) && !/^\s*Filesystem/i.test(row))
  if (!line) return undefined
  const cells = line.trim().split(/\s+/)
  const percentIndex = cells.findIndex((cell) => /^\d+%$/.test(cell))
  if (percentIndex < 1) return undefined
  const usedPercent = Number(cells[percentIndex].replace('%', ''))
  const freeHuman = cells[percentIndex - 1]
  if (!Number.isFinite(usedPercent) || !freeHuman) return undefined
  return { usedPercent, freeHuman }
}

/**
 * `uptime -p` ("up 5 days, 3 hours, 12 minutes"): translate the units.
 *
 * English units are what a `LANG=C` server prints; a few Russian spellings are
 * accepted too, because `uptime -p` is localised by gettext.
 */
function parsePrettyUptime(text) {
  const body = String(text ?? '').replace(/^\s*up\s+/i, '').trim()
  if (body === '') return undefined
  const parts = []
  const re = /(\d+)\s*(weeks?|days?|hours?|hrs?|minutes?|mins?|недел\w*|дн\w*|день|сут\w*|час\w*|мин\w*)/gi
  let match
  while ((match = re.exec(body)) !== null) {
    const value = Number(match[1])
    const unit = match[2].toLowerCase()
    if (unit.startsWith('week') || unit.startsWith('недел')) parts.push(plural(value, 'неделя', 'недели', 'недель'))
    else if (unit.startsWith('day') || unit.startsWith('дн') || unit === 'день' || unit.startsWith('сут')) parts.push(plural(value, 'день', 'дня', 'дней'))
    else if (unit.startsWith('hour') || unit.startsWith('hr') || unit.startsWith('час')) parts.push(plural(value, 'час', 'часа', 'часов'))
    else if (unit.startsWith('min') || unit.startsWith('мин')) parts.push(plural(value, 'минута', 'минуты', 'минут'))
  }
  return parts.length > 0 ? parts.join(' ') : undefined
}

/**
 * Raw `uptime` fallback, when `uptime -p` is not supported.
 *
 * The segment between `up` and the user/load part is "5 days,  3:04" or "42
 * min" on Linux; macOS prints the same. Anything that cannot be understood is
 * left out, so the report degrades honestly instead of guessing.
 */
function parseRawUptime(text) {
  const match = /\bup\s+(.+?)(?=,\s*\d+\s*users?\b|\s+load averages?:|$)/i.exec(String(text ?? ''))
  if (!match) return undefined
  const parts = []
  for (const chunk of match[1].split(',').map((value) => value.trim()).filter(Boolean)) {
    const days = /^(\d+)\s+days?$/i.exec(chunk)
    if (days) {
      parts.push(plural(Number(days[1]), 'день', 'дня', 'дней'))
      continue
    }
    const clock = /^(\d+):(\d{2})$/.exec(chunk)
    if (clock) {
      const hours = Number(clock[1])
      const minutes = Number(clock[2])
      if (hours > 0) parts.push(plural(hours, 'час', 'часа', 'часов'))
      if (minutes > 0) parts.push(plural(minutes, 'минута', 'минуты', 'минут'))
      continue
    }
    const mins = /^(\d+)\s+mins?$/i.exec(chunk)
    if (mins) parts.push(plural(Number(mins[1]), 'минута', 'минуты', 'минут'))
  }
  return parts.length > 0 ? parts.join(' ') : undefined
}

/** `du -h` prints `96K`, `1.2M`, `2,5G`; return bytes. */
function parseHumanBytes(text) {
  const match = /^([\d.,]+)\s*([KMGTPE]?)(i?B)?$/i.exec(String(text ?? '').trim())
  if (!match) return undefined
  const value = Number(match[1].replace(',', '.'))
  if (!Number.isFinite(value)) return undefined
  const power = { '': 0, K: 1, M: 2, G: 3, T: 4, P: 5, E: 6 }[match[2].toUpperCase()] ?? 0
  return Math.round(value * 1024 ** power)
}

/** Bytes back into the compact form the report shows: `96 КБ`. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return undefined
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  const rounded = value >= 10 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${units[index]}`
}

/** Count journal lines the watchdog would also call suspicious. */
function countErrors(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !IGNORED_ERRORS.some((re) => re.test(line)))
    .filter((line) => /\bERROR\b/.test(line))
    .length
}

/** The last path segment, without importing `node:path` for one call. */
function baseName(target) {
  const trimmed = String(target ?? '').replace(/\/+$/, '')
  if (trimmed === '') return undefined
  return trimmed.split('/').pop() || undefined
}

/** A `Date` from whatever the caller injected, never `Invalid Date`. */
function toDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : new Date()
}

/** `dd.MM HH:mm` in the requested zone, assembled part by part. */
function formatStamp(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone,
    }).formatToParts(date)
    const pick = (type) => parts.find((part) => part.type === type)?.value ?? '--'
    return `${pick('day')}.${pick('month')} ${pick('hour')}:${pick('minute')}`
  } catch {
    // An invalid zone must not cost the user the whole report: use local time.
    const pad = (value) => String(value).padStart(2, '0')
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
}

/** `МСК` for Moscow, the zone's short name otherwise, the city as a last resort. */
function zoneLabel(timeZone, date) {
  if (ZONE_LABELS[timeZone]) return ZONE_LABELS[timeZone]
  try {
    const name = new Intl.DateTimeFormat('ru-RU', { timeZone, timeZoneName: 'short' })
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')?.value
    if (name && !/^GMT/i.test(name)) return name
  } catch {
    // An unknown zone is not worth a crash: the city name below still says something.
  }
  return String(timeZone).split('/').pop().replace(/_/g, ' ') || 'UTC'
}

/** "ошибок за час" for the default window, "за 20 мин" otherwise. */
function windowLabel(minutes) {
  const value = Number(minutes)
  if (!Number.isFinite(value) || value === 60) return 'час'
  if (value === 1) return 'минуту'
  return `${value} мин`
}

/**
 * Collect what can be learned about this server. Never rejects.
 *
 * Each fact is fetched on its own and wrapped in try/catch: a missing `nproc`
 * on a Mac, a `journalctl` that needs root and a timeout all end up in
 * `failures`, while the remaining facts still make it into the report.
 *
 * @param {object} [options] - collection options.
 * @param {Function} [options.exec] - `(command, args, options) => Promise<{stdout, stderr, code}>`.
 * @param {string} [options.label] - how the server is called in the report.
 * @param {string[]} [options.services] - systemd units to check.
 * @param {string} [options.releasePath] - symlink that points at the running release.
 * @param {string} [options.dataDir] - state directory (size and `*.json` count).
 * @param {string} [options.diskPath] - mount point to measure.
 * @param {number} [options.diskWarnPercent] - disk alarm threshold, percent.
 * @param {number} [options.errorWindowMinutes] - journal window for `ERROR`.
 * @param {Function} [options.now] - clock, for deterministic tests.
 * @param {string} [options.timeZone] - IANA zone for the report header.
 * @returns {Promise<object>} the status object described in the module docs.
 */
export async function collectServerStatus(options = {}) {
  const settings = options && typeof options === 'object' ? options : {}
  const exec = typeof settings.exec === 'function' ? settings.exec : defaultExec
  const label = settings.label === undefined ? 'сервер' : String(settings.label)
  const rawServices = settings.services === undefined ? ['tg-agent', 'vk-agent'] : settings.services
  const services = (Array.isArray(rawServices) ? rawServices : [rawServices])
    .flat()
    .map((name) => String(name))
    .filter(Boolean)
  const releasePath = settings.releasePath === undefined ? '/opt/tg-agent' : String(settings.releasePath)
  const dataDir = settings.dataDir === undefined ? '/var/lib/tg-agent' : String(settings.dataDir)
  const diskPath = settings.diskPath === undefined ? '/' : String(settings.diskPath)
  const diskWarnPercent = Number.isFinite(Number(settings.diskWarnPercent)) ? Number(settings.diskWarnPercent) : 90
  const errorWindowMinutes = Number.isFinite(Number(settings.errorWindowMinutes)) && Number(settings.errorWindowMinutes) > 0
    ? Number(settings.errorWindowMinutes)
    : 60
  const now = typeof settings.now === 'function' ? settings.now : () => new Date()
  const timeZone = settings.timeZone === undefined ? 'Europe/Moscow' : String(settings.timeZone)

  const failures = []
  const problems = []
  let at
  try {
    at = toDate(now()).toISOString()
  } catch {
    // A broken clock is still not a reason to throw: fall back to the real one.
    at = new Date().toISOString()
  }
  const status = {
    label,
    at,
    services: [],
    problems,
    failures,
    timeZone,
    errorWindowMinutes,
  }

  /** Run one command and normalise whatever the injected runner returned. */
  const run = async (command, args) => {
    // `free`, `df` and `uptime` are localised by gettext: pin the C locale so the
    // parsers below see the same words the tests and the watchdog assume.
    const result = await exec(command, args, {
      timeout: COMMAND_TIMEOUT_MS,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    })
    const code = Number(result?.code)
    return {
      stdout: String(result?.stdout ?? ''),
      stderr: String(result?.stderr ?? ''),
      code: Number.isFinite(code) ? code : 0,
    }
  }

  /** One fact: on any throw record it under `key` and return undefined. */
  const attempt = async (key, fn) => {
    try {
      return await fn()
    } catch (error) {
      failures.push(`${key}: ${describeError(error)}`)
      return undefined
    }
  }

  /** `systemctl is-active` per unit; a thrown call means "unknown", not "down". */
  const collectServices = () => Promise.all(services.map(async (name) => {
    try {
      const { stdout, code } = await run('systemctl', ['is-active', name])
      const state = stdout.trim().split(/\r?\n/)[0]?.trim() ?? ''
      if (state === '') throw new Error(code === 0 ? 'пустой ответ systemctl' : `systemctl вернул код ${code}`)
      return { name, active: state === 'active' }
    } catch (error) {
      failures.push(`сервис ${name}: ${describeError(error)}`)
      return undefined
    }
  })).then((list) => list.filter(Boolean))

  const collectLoad = () => attempt('load', async () => {
    const { stdout, code } = await run('uptime', [])
    if (stdout.trim() === '') throw new Error(`uptime вернул код ${code}`)
    const parsed = parseLoadAverage(stdout)
    if (!parsed) throw new Error('не удалось разобрать load average')
    return parsed
  })

  const collectCores = () => attempt('cores', async () => {
    const { stdout, code } = await run('nproc', [])
    const cores = Number.parseInt(stdout.trim(), 10)
    if (!Number.isInteger(cores) || cores <= 0) {
      throw new Error(code === 0 ? 'nproc вернул неожиданное значение' : `nproc вернул код ${code}`)
    }
    return cores
  })

  const collectMemory = () => attempt('memory', async () => {
    const { stdout, code } = await run('free', ['-m'])
    const parsed = parseFree(stdout)
    if (!parsed) throw new Error(code === 0 ? 'не удалось разобрать вывод free -m' : `free вернул код ${code}`)
    return parsed
  })

  const collectDisk = () => attempt('disk', async () => {
    const { stdout, code } = await run('df', ['-h', diskPath])
    const parsed = parseDf(stdout)
    if (!parsed) throw new Error(code === 0 ? 'не удалось разобрать вывод df -h' : `df вернул код ${code}`)
    return { path: diskPath, ...parsed }
  })

  const collectUptime = () => attempt('uptime', async () => {
    const pretty = await run('uptime', ['-p'])
    if (pretty.code === 0 && pretty.stdout.trim() !== '') {
      const parsed = parsePrettyUptime(pretty.stdout)
      if (parsed) return parsed
    }
    // Older coreutils have no `-p`: fall back to the raw line and say less.
    const raw = await run('uptime', [])
    const parsed = parseRawUptime(raw.stdout)
    if (parsed) return parsed
    throw new Error('uptime не поддерживает -p, а разобрать вывод не удалось')
  })

  const collectRelease = () => attempt('release', async () => {
    const { stdout } = await run('readlink', ['-f', releasePath])
    const resolved = stdout.trim().split(/\r?\n/)[0]?.trim() ?? ''
    // A path that does not exist is simply no fact — not a failure.
    return resolved === '' ? undefined : baseName(resolved)
  })

  const collectErrors = () => attempt('errors', async () => {
    const window = ['--since', `-${errorWindowMinutes}min`, '--no-pager']
    const withUnits = [...services.flatMap((name) => ['-u', name]), ...window]
    const first = await run('journalctl', withUnits)
    if (first.code === 0) return countErrors(first.stdout)
    // The units may be unknown to this journal; the machine-wide window still is not.
    if (services.length > 0) {
      const second = await run('journalctl', window)
      if (second.code === 0) return countErrors(second.stdout)
      if (NO_ENTRIES_RE.test(second.stderr)) return 0
      throw new Error(`journalctl вернул код ${second.code}`)
    }
    if (NO_ENTRIES_RE.test(first.stderr)) return 0
    throw new Error(`journalctl вернул код ${first.code}`)
  })

  const collectState = () => attempt('state', async () => {
    const size = await run('du', ['-sh', dataDir])
    const bytes = size.code === 0 ? parseHumanBytes(size.stdout.trim().split(/\s+/)[0]) : undefined
    const listed = await run('find', [dataDir, '-maxdepth', '1', '-type', 'f', '-name', '*.json'])
    const files = listed.code === 0
      ? String(listed.stdout).split(/\r?\n/).filter((line) => line.trim() !== '').length
      : undefined
    if (bytes === undefined || files === undefined) {
      const missing = bytes === undefined && files === undefined ? 'du и find' : bytes === undefined ? 'du' : 'find'
      throw new Error(`${missing} не дали результата (du код ${size.code}, find код ${listed.code})`)
    }
    return { files, bytes }
  })

  try {
    const [serviceFacts, load, cores, memory, disk, uptime, release, errors, state] = await Promise.all([
      collectServices(),
      collectLoad(),
      collectCores(),
      collectMemory(),
      collectDisk(),
      collectUptime(),
      collectRelease(),
      collectErrors(),
      collectState(),
    ])

    status.services = serviceFacts
    if (load) status.load = load
    if (cores !== undefined) status.cores = cores
    if (memory) status.memory = memory
    if (disk) status.disk = disk
    if (uptime) status.uptime = uptime
    if (release) status.release = release
    if (errors !== undefined) status.errors = errors
    if (state) status.state = state

    // Alarms first, then what could not be found: the same order the report prints.
    const broken = status.services.filter((service) => !service.active).map((service) => service.name)
    if (status.disk && status.disk.usedPercent >= diskWarnPercent) {
      problems.push(`диск: занято ${status.disk.usedPercent}% (порог ${diskWarnPercent}%)`)
    }
    if (broken.length === 1) problems.push(`сервис ${broken[0]} неактивен`)
    else if (broken.length > 1) problems.push(`сервисы неактивны: ${broken.join(', ')}`)
    if (Number.isFinite(status.errors) && status.errors > 0) {
      problems.push(`за ${errorWindowMinutes} мин в журнале найдено ${status.errors} строк ERROR`)
    }
  } catch (error) {
    failures.push(`сбор: ${describeError(error)}`)
  }

  return status
}

/**
 * Short Russian report for Telegram.
 *
 * Unknown facts are skipped entirely: there is no "нагрузка: unknown" line. A
 * disk above `warnPercent` becomes an alarm even when the status object was
 * collected with another threshold, so the two never disagree.
 *
 * @param {object} status - result of `collectServerStatus`.
 * @param {object} [options] - `{ warnPercent, timeZone }`.
 * @param {number} [options.warnPercent] - disk alarm threshold, defaults to 90.
 * @param {string} [options.timeZone] - override the zone stored in the status.
 * @returns {string} up to ~15 lines, no markdown tables.
 */
export function formatServerStatus(status, { warnPercent = 90, timeZone } = {}) {
  const source = status && typeof status === 'object' ? status : {}
  const zone = timeZone || source.timeZone || 'Europe/Moscow'
  const at = toDate(source.at)
  const lines = [`🖥 ${source.label || 'сервер'} · ${formatStamp(at, zone)} ${zoneLabel(zone, at)}`]

  const services = Array.isArray(source.services) ? source.services : []
  if (services.length > 0) {
    lines.push(`сервисы: ${services.map((service) => `${service.name} ${service.active ? '✓' : '✗'}`).join(', ')}`)
  }

  const load = source.load
  if (load && [load.one, load.five, load.fifteen].every(Number.isFinite)) {
    const cores = Number.isInteger(source.cores) && source.cores > 0
      ? ` · ${plural(source.cores, 'ядро', 'ядра', 'ядер')}`
      : ''
    lines.push(`нагрузка: ${load.one.toFixed(2)} / ${load.five.toFixed(2)} / ${load.fifteen.toFixed(2)}${cores}`)
  }

  const memory = source.memory
  if (memory && Number.isFinite(memory.totalMb) && Number.isFinite(memory.availableMb)) {
    lines.push(`память: ${memory.availableMb} МБ свободно из ${memory.totalMb} МБ`)
  }

  const disk = source.disk
  if (disk && Number.isFinite(disk.usedPercent)) {
    lines.push(`диск: ${disk.usedPercent}% занято${disk.freeHuman ? `, ${disk.freeHuman} свободно` : ''}`)
  }

  if (source.uptime) lines.push(`аптайм: ${source.uptime}`)
  if (source.release) lines.push(`релиз: ${source.release}`)
  if (Number.isFinite(source.errors)) lines.push(`ошибок за ${windowLabel(source.errorWindowMinutes)}: ${source.errors}`)

  const state = source.state
  if (state && Number.isFinite(state.files) && Number.isFinite(state.bytes)) {
    lines.push(`состояние: ${plural(state.files, 'файл', 'файла', 'файлов')}, ${formatBytes(state.bytes)}`)
  }

  const limit = Number.isFinite(Number(warnPercent)) ? Number(warnPercent) : 90
  const problems = Array.isArray(source.problems) ? source.problems.filter(Boolean) : []
  if (disk && Number.isFinite(disk.usedPercent) && disk.usedPercent >= limit && !problems.some((problem) => /диск/i.test(problem))) {
    problems.push(`диск: занято ${disk.usedPercent}% (порог ${limit}%)`)
  }
  for (const problem of problems) lines.push(`⚠️ ${problem}`)

  const failures = Array.isArray(source.failures) ? source.failures.filter(Boolean) : []
  if (failures.length > 0) lines.push(`не удалось узнать: ${failures.join('; ')}`)

  return lines.join('\n')
}

/**
 * One-line hint for the model's system prompt.
 *
 * Mirrors the `description` of the other tools: it says when to reach for the
 * tool and that the answer comes from the machine the bot itself runs on.
 */
export const SERVER_STATUS_HINT =
  'Состояние сервера: инструмент server_status отвечает на «как там Испания?», «бот работает?», «сколько места на диске», '
  + '«какая версия бота», «что с нагрузкой и памятью». Он собирает факты о сервере, где запущен бот, локальными командами '
  + '(сервисы, нагрузка, память, диск, аптайм, релиз, ошибки журнала, состояние) и отдаёт короткий отчёт по-русски.'
