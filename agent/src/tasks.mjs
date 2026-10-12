/**
 * The task journal: what was asked, how it ended, what it cost.
 *
 * Append-only JSONL on disk (each state change is one line, the last line for an
 * id wins) and a small in-memory index for the commands. That keeps a crash from
 * losing history — a half-written line is skipped on load — and keeps `/tasks`
 * instant without parsing the whole file every time.
 *
 * The journal is also what makes the dialogue possible: a task parked in
 * `awaiting_reply` keeps its id, its session and its question, so the answer
 * that arrives an hour later lands on the right job.
 */
import { randomInt } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const VERSION = 1

/** Statuses a task can be in. */
export const STATUS = {
  running: 'running',
  awaiting: 'awaiting_reply',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  timeout: 'timeout',
  expired: 'expired',
}

/** A one-line label for the status, for messages and lists. */
export const STATUS_LABEL = {
  running: '⏳ выполняется',
  awaiting_reply: '❓ ждёт ответа',
  done: '✅ выполнена',
  failed: '⚠️ с ошибкой',
  cancelled: '⛔ отменена',
  timeout: '⌛ по таймауту',
  expired: '🕓 ответа не дождалась',
}

export class TaskJournal {
  /**
   * @param {object} options - journal options.
   * @param {string} options.file - JSONL file.
   * @param {object} [options.logger] - logger.
   * @param {number} [options.maxEntries] - how many tasks stay in memory and on disk.
   */
  constructor({ file, logger, maxEntries = 2000 } = {}) {
    this.file = file
    this.logger = logger
    this.maxEntries = maxEntries
    /** @type {Map<string, object>} id → latest record. */
    this.records = new Map()
    this.writing = Promise.resolve()
    this.counter = 0
  }

  /** Read the file, last line per id wins; junk lines are skipped. */
  async load() {
    let raw = ''
    try {
      raw = await fs.readFile(this.file, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger?.warn('task journal unreadable', { file: this.file, error })
      return this
    }
    let skipped = 0
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line)
        if (parsed?.version !== VERSION || typeof parsed.id !== 'string') throw new Error('unexpected record')
        this.records.set(parsed.id, parsed)
      } catch {
        skipped += 1
      }
    }
    this.compactMemory()
    this.logger?.info('task journal loaded', { tasks: this.records.size, skipped })
    return this
  }

  /** Keep only the newest `maxEntries` tasks in memory. */
  compactMemory() {
    if (this.records.size <= this.maxEntries) return
    const ordered = [...this.records.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    for (const record of ordered.slice(0, this.records.size - this.maxEntries)) this.records.delete(record.id)
  }

  /**
   * A fresh id, readable in a chat and unique across restarts.
   *
   * The counter starts from a random seed, so two processes that hand out ids in
   * the same second of the day cannot collide — which matters because the id
   * also names the parked question and the task cgroup.
   */
  nextId(date = new Date()) {
    if (this.counter === 0) this.counter = randomInt(1, 46_656)
    this.counter += 1
    const stamp = date.toISOString().slice(11, 19).replace(/:/g, '')
    return `${stamp}-${this.counter.toString(36)}`
  }

  /** Open a task record and write it. */
  async open({ id, chatId, userId, brief = '', sessionId, scheduledFrom } = {}) {
    const record = {
      version: VERSION,
      id,
      chatId: chatId === undefined ? undefined : String(chatId),
      userId: userId === undefined ? undefined : String(userId),
      status: STATUS.running,
      brief: String(brief ?? '').slice(0, 300),
      sessionId,
      scheduledFrom,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    return this.save(record)
  }

  /** Merge a patch into one task and write the result. */
  async update(id, patch = {}) {
    const existing = this.records.get(id)
    if (!existing) return undefined
    const record = { ...existing, ...patch, updatedAt: Date.now() }
    return this.save(record)
  }

  /** Close a task with a final status. */
  async close(id, patch = {}) {
    return this.update(id, { ...patch, finishedAt: Date.now() })
  }

  /** One record, or undefined. */
  get(id) {
    return this.records.get(id)
  }

  /** Newest first. */
  recent(limit = 10) {
    return [...this.records.values()]
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, limit)
  }

  /** Every task waiting for the user's answer. */
  awaiting() {
    return [...this.records.values()].filter((record) => record.status === STATUS.awaiting)
  }

  /** Store in memory and append to disk. */
  save(record) {
    this.records.set(record.id, record)
    this.compactMemory()
    this.writing = this.writing.then(async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true })
        await fs.appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8')
      } catch (error) {
        this.logger?.error('task journal write failed', { error })
      }
    })
    return this.writing.then(() => record)
  }

  /** Wait for pending writes. */
  async flush() {
    return this.writing
  }

  /**
   * Rewrite the file with one line per retained task.
   *
   * Called at startup so the append log cannot grow without bound.
   */
  async compact() {
    await this.flush()
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const lines = [...this.records.values()]
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
        .map((record) => JSON.stringify(record))
      const temporary = `${this.file}.tmp`
      await fs.writeFile(temporary, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8')
      await fs.rename(temporary, this.file)
      this.logger?.info('task journal compacted', { tasks: lines.length })
    } catch (error) {
      this.logger?.error('task journal compaction failed', { error })
    }
  }
}

/** A short, human label for one task. */
export function describeTask(record, { files = true } = {}) {
  const when = new Date(record.createdAt ?? Date.now())
  const time = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
  const parts = [`${STATUS_LABEL[record.status] ?? record.status} · ${record.id} · ${time}`]
  if (record.brief) parts.push(`   ${record.brief}`)
  if (record.status === STATUS.done || record.status === STATUS.failed) {
    const seconds = record.durationMs ? `${Math.round(record.durationMs / 1000)} с` : '—'
    const usd = record.usd === undefined ? '' : ` · ${record.usd < 0.01 ? `$${record.usd.toFixed(4)}` : `$${record.usd.toFixed(3)}`}`
    parts.push(`   ${seconds}, шагов ${record.steps ?? 0}, токенов ${(record.tokens?.total ?? 0).toLocaleString('ru-RU')}${usd}`)
  }
  if (files && Array.isArray(record.files) && record.files.length > 0) parts.push(`   файлы: ${record.files.join(', ')}`)
  if (record.error) parts.push(`   ошибка: ${String(record.error).slice(0, 200)}`)
  return parts.join('\n')
}
