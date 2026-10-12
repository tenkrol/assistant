/**
 * The agent's workspace: what the run may write, and what comes back out.
 *
 * DSH documents its deliverables nowhere — the headless bundle mounts no
 * `present` tool, so there is no manifest to read. The contract is therefore
 * physical: the workspace is snapshotted before and after a task, and every file
 * that appeared or changed is a candidate result.
 *
 * Two directories are reserved:
 *   - `inbox/`  — files the user sent; never echoed back as results;
 *   - `outbox/` — where the agent is asked to put final deliverables.
 *
 * Files in `outbox/` always travel to the user; other new files do too, unless
 * the run produced more than the configured limit, in which case the newest ones
 * win and the rest stay in the workspace.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** Directory names that never count as deliverables. */
export const INBOX_DIR = 'inbox'
export const OUTBOX_DIR = 'outbox'
const SKIP_NAMES = new Set(['AGENTS.md', '.DS_Store', '.gitignore'])

const PHOTO_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
])

/** Mime type for a path, by extension; documents default to a generic type. */
export function mimeOf(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  if (PHOTO_MIME.has(extension)) return PHOTO_MIME.get(extension)
  const table = {
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.odt': 'application/vnd.oasis.opendocument.text',
    '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
    '.odp': 'application/vnd.oasis.opendocument.presentation',
    '.py': 'text/x-python',
    '.mjs': 'text/javascript',
    '.js': 'text/javascript',
  }
  return table[extension] ?? 'application/octet-stream'
}

/** True when Telegram should render the file inline as a photo. */
export const isPhoto = (filePath) => PHOTO_MIME.has(path.extname(filePath).toLowerCase())

/** Create the workspace and its reserved directories. */
export async function ensureWorkspace(dir) {
  await fs.mkdir(dir, { recursive: true })
  await fs.mkdir(path.join(dir, INBOX_DIR), { recursive: true })
  await fs.mkdir(path.join(dir, OUTBOX_DIR), { recursive: true })
  return dir
}

/**
 * Install the workspace instruction file from a template, without ever
 * overwriting an existing one: the owner may have edited it.
 *
 * @param {string} dir - workspace root.
 * @param {string} templatePath - `AGENTS.md` shipped with the project.
 * @returns {Promise<boolean>} whether the file was created.
 */
export async function ensureInstructions(dir, templatePath) {
  const target = path.join(dir, 'AGENTS.md')
  try {
    await fs.access(target)
    return false
  } catch {
    const template = await fs.readFile(templatePath, 'utf8').catch(() => undefined)
    if (template === undefined) return false
    await fs.writeFile(target, template, { mode: 0o644 })
    return true
  }
}

/**
 * Snapshot one workspace tree: relative path → size and mtime.
 *
 * The reserved directories are included — `collectOutputs` needs to see what
 * landed in `outbox/` — but hidden files, VCS metadata and the instruction file
 * are not, because none of them is ever a deliverable.
 *
 * @param {string} dir - workspace root.
 * @returns {Promise<Map<string, {size: number, mtimeMs: number}>>} the snapshot.
 */
export async function snapshot(dir) {
  const files = new Map()
  const walk = async (current) => {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      const relative = path.relative(dir, full)
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue
        await walk(full)
        continue
      }
      if (!entry.isFile() || SKIP_NAMES.has(entry.name) || entry.name.startsWith('.')) continue
      try {
        const stat = await fs.stat(full)
        files.set(relative, { size: stat.size, mtimeMs: stat.mtimeMs })
      } catch {
        // A file that vanished between readdir and stat is simply not there.
      }
    }
  }
  await walk(dir)
  return files
}

/**
 * Compare two snapshots and return the files worth sending.
 *
 * `outbox/` wins over everything: a deliverable the agent explicitly parked
 * there is never dropped by the file limit. The rest are ranked by modification
 * time, newest first.
 *
 * @param {object} request - `before`, `after` snapshots and `dir`.
 * @returns {Promise<{selected: Array<object>, skipped: string[]}>} deliverables
 *   (`{path, relPath, size, mtimeMs, outbox, photo, tooLarge?}`) and the names
 *   dropped by the file limit.
 */
export async function collectOutputs({ before = new Map(), after = new Map(), dir, maxFiles = 8, maxBytes = 45_000_000 } = {}) {
  const changed = []
  const explicit = []
  for (const [relative, meta] of after) {
    const top = relative.split(path.sep)[0]
    // The user's own uploads are never results of the task.
    if (top === INBOX_DIR) continue
    const previous = before.get(relative)
    if (previous && previous.size === meta.size && previous.mtimeMs === meta.mtimeMs) continue
    if (meta.size === 0) continue
    const entry = {
      path: path.join(dir, relative),
      relPath: relative,
      size: meta.size,
      mtimeMs: meta.mtimeMs,
      outbox: top === OUTBOX_DIR,
      photo: isPhoto(relative),
    }
    if (entry.outbox) explicit.push(entry)
    else changed.push(entry)
  }
  explicit.sort((a, b) => b.mtimeMs - a.mtimeMs)
  changed.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const ordered = [...explicit, ...changed]
  const selected = []
  for (const entry of ordered) {
    if (selected.length >= maxFiles) break
    if (entry.size > maxBytes) {
      entry.tooLarge = true
      selected.push(entry)
      continue
    }
    selected.push(entry)
  }
  const skipped = ordered.slice(selected.length).map((entry) => entry.relPath)
  return { selected, skipped }
}

/** Read one deliverable, reporting an unreadable file instead of throwing. */
export async function readDeliverable(entry, { maxBytes = 45_000_000 } = {}) {
  if (entry.size > maxBytes) return { ...entry, error: 'файл больше лимита Telegram' }
  try {
    const bytes = await fs.readFile(entry.path)
    return { ...entry, bytes, mime: mimeOf(entry.path) }
  } catch (error) {
    return { ...entry, error: error?.message ?? 'не удалось прочитать файл' }
  }
}

/**
 * Remove old files from the reserved directories only.
 *
 * Scratch files the agent left in the workspace root are deliberately kept: a
 * person debugging a task needs them, and the disk is not the constraint here.
 *
 * @param {string} dir - workspace root.
 * @param {object} options - `retentionDays` 0 disables pruning.
 * @returns {Promise<number>} how many files were removed.
 */
export async function pruneReservedDirs(dir, { retentionDays = 14 } = {}) {
  if (!retentionDays) return 0
  const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000
  let removed = 0
  for (const reserved of [INBOX_DIR, OUTBOX_DIR]) {
    const base = path.join(dir, reserved)
    let entries
    try {
      entries = await fs.readdir(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(base, entry.name)
      try {
        const stat = await fs.stat(full)
        if (entry.isDirectory()) {
          if (stat.mtimeMs < cutoff && (await isEmpty(full))) {
            await fs.rm(full, { recursive: true, force: true })
            removed += 1
          }
          continue
        }
        if (stat.mtimeMs < cutoff) {
          await fs.rm(full, { force: true })
          removed += 1
        }
      } catch {
        // Racing with a running task is fine; the next prune gets it.
      }
    }
  }
  return removed
}

/** True when a directory holds nothing at all. */
async function isEmpty(dir) {
  try {
    return (await fs.readdir(dir)).length === 0
  } catch {
    return false
  }
}

/**
 * Total size and file count of a tree.
 *
 * Symlinks are not followed: a link out of the workspace must not turn into a
 * multi-gigabyte walk of the host.
 *
 * @param {string} dir - directory to measure.
 * @returns {Promise<{bytes: number, files: number}>} the totals.
 */
export async function directorySize(dir) {
  let bytes = 0
  let files = 0
  const walk = async (current) => {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const stat = await fs.stat(full)
        bytes += stat.size
        files += 1
      } catch {
        // Gone between readdir and stat.
      }
    }
  }
  await walk(dir)
  return { bytes, files }
}

/** Human-readable size for messages and logs. */
export function formatSize(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} Б`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} КБ`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} МБ`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} ГБ`
}
