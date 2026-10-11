/**
 * Back up the bot state directory into timestamped tar.gz archives.
 *
 * Runs on the server from the daily systemd timer (`tg-agent-backup.timer`) and
 * can also be used locally: the state directory, the archive directory and the
 * retention count come from the environment (`STATE_DIR`, `BACKUP_DIR`,
 * `BACKUP_KEEP`). Archives store plain file names, so restoring is a matter of
 * unpacking one into the state directory.
 *
 * Usage:
 *   node tools/backup-state.mjs                    # create an archive, rotate old ones
 *   node tools/backup-state.mjs --send             # ... and send the archive to the owner
 *   node tools/backup-state.mjs --list             # show existing archives
 *   node tools/backup-state.mjs --restore <file>   # show what a restore would do
 *   node tools/backup-state.mjs --restore <file> --yes   # actually restore
 *
 * Exit code 1 means the archive was not created. A failed Telegram delivery is
 * reported but does not fail the run: the local backup is what matters.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Project root; the `.env` file lives next to `package.json`. */
const projectDir = path.resolve(import.meta.dirname, '..')

const DEFAULT_STATE_DIR = '/var/lib/tg-agent'
const DEFAULT_BACKUP_DIR = '/var/backups/tg-agent'
const DEFAULT_KEEP = 7
// Kept below systemd's default 90s start timeout for a oneshot unit.
const SEND_TIMEOUT_MS = 60_000

/** Archive names created by this tool; only these are rotated. */
const ARCHIVE_RE = /^state-\d{4}-\d{2}-\d{2}-\d{4}\.tar\.gz$/

/**
 * Load `KEY=VALUE` lines from a file into `process.env`.
 *
 * Uses `process.loadEnvFile` when the Node version provides it (20.12+) and a
 * small parser otherwise. Variables already present in the environment win, and
 * a missing file is not an error: the process may be configured entirely
 * through the real environment.
 *
 * @param {string} file - path to the env file.
 * @returns {boolean} whether a file was read.
 */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return false
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(file)
      return true
    } catch {
      // Fall through to the parser below so a stray line cannot abort a backup.
    }
  }
  const text = fs.readFileSync(file, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const [, key, rawValue] = match
    if (process.env[key] !== undefined) continue
    process.env[key] = rawValue.trim().replace(/^(['"])([\s\S]*)\1$/, '$2')
  }
  return true
}

const pad = (value) => String(value).padStart(2, '0')

/** `YYYY-MM-DD-HHMM`, the archive name suffix. */
function stamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

/** `YYYY-MM-DD-HHMMSS`, precise enough for several pre-restore copies. */
function preciseStamp(date) {
  return `${stamp(date)}${pad(date.getSeconds())}`
}

/** Human-readable local time for listings. */
function formatDate(ms) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Bytes as KiB/MiB, so a listing stays readable. */
function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МиБ`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} КиБ`
  return `${bytes} Б`
}

/** Top-level `*.json` files of the state directory, sorted by name. */
function listStateFiles(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .filter((name) => name.endsWith('.json'))
    .filter((name) => {
      try {
        return fs.statSync(path.join(dir, name)).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

/** Existing `state-*.tar.gz` archives, newest first. */
function listArchives(backupDir) {
  let entries
  try {
    entries = fs.readdirSync(backupDir)
  } catch {
    return []
  }
  return entries
    .filter((name) => ARCHIVE_RE.test(name))
    .map((name) => {
      const full = path.join(backupDir, name)
      const stat = fs.statSync(full)
      return { name, path: full, size: stat.size, mtimeMs: stat.mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * Files outside the state directory worth keeping in every archive.
 *
 * The state alone is not enough to rebuild a server: the nginx site configs and the
 * certbot renewal settings took a while to get right, and both are tiny. Private keys
 * are deliberately excluded — certificates are re-issued in a minute.
 *
 * @returns {string[]} absolute paths that exist.
 */
function extraPaths() {
  return String(process.env.BACKUP_EXTRA ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => {
      try { fs.accessSync(entry); return true } catch { return false }
    })
}

/** Run tar; a non-zero exit is returned, not thrown. */
function runTar(args) {
  const result = spawnSync('tar', args, { encoding: 'utf8' })
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: (result.stderr ?? '').trim() }
}

/**
 * Write `files` (plain names, no directories) from `stateDir` into one archive.
 *
 * @returns {{path: string, size: number}|null} the archive, or null on failure.
 */
function writeArchive({ backupDir, name, stateDir, files }) {
  fs.mkdirSync(backupDir, { recursive: true })
  const archive = path.join(backupDir, name)
  const extra = extraPaths()
  const tar = runTar(['-czf', archive, '-C', stateDir, ...files, ...extra])
  if (!tar.ok) {
    fs.rmSync(archive, { force: true })
    console.error(`не удалось создать архив: ${tar.stderr || 'tar завершился с ошибкой'}`)
    return null
  }
  const size = fs.statSync(archive).size
  if (size === 0) {
    fs.rmSync(archive, { force: true })
    console.error('архив создан пустым — удаляю его')
    return null
  }
  const listing = runTar(['-tzf', archive])
  // The state files must all be inside. Extra paths (nginx configs, certbot renewal)
  // are directories, and tar lists their contents, so the check is a lower bound.
  const entries = listing.stdout.split('\n').filter(Boolean).length
  if (!listing.ok || entries < files.length) {
    fs.rmSync(archive, { force: true })
    console.error('архив не читается (tar -tzf) — удаляю его')
    return null
  }
  return { path: archive, size }
}

/** Keep the newest `keep` archives and delete the rest; report what was removed. */
function rotate(backupDir, keep) {
  const archives = listArchives(backupDir)
  for (const archive of archives.slice(keep)) {
    try {
      fs.rmSync(archive.path)
      console.log(`удалён старый архив: ${archive.name} (${formatSize(archive.size)}, ${formatDate(archive.mtimeMs)})`)
    } catch (error) {
      console.error(`не удалось удалить ${archive.name}: ${error.message}`)
    }
  }
}

/** Build the default archive and rotate, then optionally send it. */
async function backup({ stateDir, backupDir, keep, send }) {
  const files = listStateFiles(stateDir)
  if (files.length === 0) {
    console.log(`в каталоге состояния ${stateDir} нет файлов *.json — бэкапить нечего`)
    return 0
  }
  const name = `state-${stamp(new Date())}.tar.gz`
  const created = writeArchive({ backupDir, name, stateDir, files })
  if (!created) return 1
  console.log(`создан архив: ${created.path} (${formatSize(created.size)}, файлов: ${files.length}: ${files.join(', ')})`)
  rotate(backupDir, keep)
  if (send) await sendArchive(created.path)
  return 0
}

/** Print existing archives with their date and size. */
function showArchives(backupDir) {
  const archives = listArchives(backupDir)
  if (archives.length === 0) {
    console.log(`архивов нет в ${backupDir}`)
    return 0
  }
  const total = archives.reduce((sum, archive) => sum + archive.size, 0)
  console.log(`архивы в ${backupDir} (${archives.length}, всего ${formatSize(total)}):`)
  for (const archive of archives) {
    console.log(`  ${archive.name}  ${formatDate(archive.mtimeMs)}  ${formatSize(archive.size)}`)
  }
  return 0
}

/** The owner: an explicit BACKUP_CHAT_ID or the first allowed user id. */
function resolveChatId(env) {
  if (env.BACKUP_CHAT_ID) return env.BACKUP_CHAT_ID
  const first = String(env.ALLOWED_USER_IDS ?? '')
    .split(/[,\s]+/)
    .filter(Boolean)[0]
  return first
}

/**
 * Send the archive to the owner with sendDocument (multipart/form-data).
 *
 * Never prints the token; a failure is reported and swallowed on purpose.
 */
async function sendArchive(archive) {
  const env = process.env
  const chatId = resolveChatId(env)
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error('отправка пропущена: не задан TELEGRAM_BOT_TOKEN')
    return
  }
  if (!chatId) {
    console.error('отправка пропущена: задайте BACKUP_CHAT_ID или ALLOWED_USER_IDS')
    return
  }
  const apiBase = (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '')
  console.log(`отправляю архив в Telegram (chat_id ${chatId})`)
  try {
    const data = await fs.promises.readFile(archive)
    const form = new FormData()
    form.append('chat_id', String(chatId))
    form.append('caption', `Бэкап состояния tg-agent: ${path.basename(archive)}`)
    form.append('document', new Blob([data], { type: 'application/gzip' }), path.basename(archive))
    const response = await fetch(`${apiBase}/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || body?.ok !== true) {
      throw new Error(body?.description ? `Telegram: ${body.description}` : `HTTP ${response.status}`)
    }
    console.log(`архив отправлен (message_id ${body.result?.message_id ?? '—'})`)
  } catch (error) {
    // The local backup is still valid; only report the failed delivery.
    console.error(`не удалось отправить архив в Telegram: ${error.message}`)
  }
}

/** List the members of an archive, or null when it is not a readable tar.gz. */
function archiveMembers(archive) {
  const listing = runTar(['-tzf', archive])
  if (!listing.ok) return null
  return listing.stdout.split('\n').filter(Boolean)
}

/** Restore one archive into the state directory, confirming first unless --yes. */
function restore({ stateDir, backupDir, target, yes }) {
  const archive = path.resolve(target)
  if (!fs.existsSync(archive)) {
    console.error(`архив не найден: ${archive}`)
    return 1
  }
  const members = archiveMembers(archive)
  if (!members) {
    console.error(`архив повреждён или это не tar.gz: ${archive}`)
    return 1
  }
  const current = listStateFiles(stateDir)
  console.log(`восстановление из: ${archive}`)
  console.log(`каталог состояния: ${stateDir}`)
  console.log(`файлы в архиве (${members.length}): ${members.join(', ')}`)
  console.log(current.length > 0
    ? `текущие файлы (${current.length}) будут сохранены как pre-restore-<дата>.tar.gz`
    : 'текущих файлов состояния нет — копия перед восстановлением не нужна')
  if (!yes) {
    console.log('ничего не изменено: повторите с --yes, чтобы подтвердить восстановление')
    return 1
  }

  // A restore overwrites live state, so keep a copy of what is there right now.
  if (current.length > 0) {
    const name = `pre-restore-${preciseStamp(new Date())}.tar.gz`
    const copy = writeArchive({ backupDir, name, stateDir, files: current })
    if (!copy) return 1
    console.log(`копия текущего состояния: ${copy.path} (${formatSize(copy.size)})`)
  }

  fs.mkdirSync(stateDir, { recursive: true })
  const unpacked = runTar(['-xzf', archive, '-C', stateDir])
  if (!unpacked.ok) {
    console.error(`не удалось распаковать архив: ${unpacked.stderr || 'tar завершился с ошибкой'}`)
    return 1
  }
  console.log(`восстановлено файлов: ${members.length}`)
  return 0
}

/** Positive integer from BACKUP_KEEP; an invalid value falls back to the default. */
function readKeep(raw) {
  if (raw === undefined || raw === '') return DEFAULT_KEEP
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    console.error(`BACKUP_KEEP должен быть целым числом >= 1, беру ${DEFAULT_KEEP}`)
    return DEFAULT_KEEP
  }
  return value
}

function printUsage() {
  console.log('Использование: node tools/backup-state.mjs [--send | --list | --restore <файл> [--yes]]')
}

/** Parse flags and dispatch; returns the process exit code. */
async function main() {
  const argv = process.argv.slice(2)
  loadEnvFile(path.join(projectDir, '.env'))

  const config = {
    stateDir: process.env.STATE_DIR || DEFAULT_STATE_DIR,
    backupDir: process.env.BACKUP_DIR || DEFAULT_BACKUP_DIR,
    keep: readKeep(process.env.BACKUP_KEEP),
  }

  if (argv.includes('--help')) {
    printUsage()
    return 0
  }
  if (argv.includes('--list')) return showArchives(config.backupDir)

  const restoreIndex = argv.indexOf('--restore')
  if (restoreIndex !== -1) {
    const target = argv[restoreIndex + 1]
    if (!target || target.startsWith('--')) {
      console.error('после --restore нужен путь к архиву')
      printUsage()
      return 2
    }
    return restore({ ...config, target, yes: argv.includes('--yes') })
  }

  return backup({ ...config, send: argv.includes('--send') })
}

process.exitCode = await main()
