/**
 * Long-term memory: durable facts about the owner and their work.
 *
 * The DSH session is the only place the agent remembers anything, and it is
 * deliberately reset for unattended runs — so "отчёты делаю в формате X" or
 * "проект называется Y" had to be repeated every time.
 *
 * Facts are collected from the agent itself: the workspace instructions tell it
 * to append one line per durable fact to `memory.md`, and the bot ingests those
 * lines after every run. The owner can also add and drop facts directly
 * (`/remember`, `/forget`).
 *
 * What is stored is deliberately small and inspectable: a bounded list of short
 * lines, all of them visible to the owner with `/memory`.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** Hard caps: memory must never become a second unbounded context. */
export const MAX_FACTS = 120
export const MAX_FACT_CHARS = 300
export const MAX_RENDER_CHARS = 3000

/** A line in `memory.md` that carries a fact. */
const FACT_LINE = /^\s*[-*•]\s+(?<text>.+?)\s*$/

/** Normalised form used for de-duplication. */
const normalise = (text) => String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

/** Trim a fact to something that belongs in a prompt. */
const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_CHARS)

export class MemoryStore {
  /**
   * @param {object} options - store options.
   * @param {string} options.file - JSON file to keep facts in.
   * @param {object} [options.logger] - logger.
   */
  constructor({ file, logger } = {}) {
    this.file = file
    this.logger = logger
    this.facts = []
  }

  /** Read facts from disk; a broken file is reported and starts empty. */
  async load() {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const payload = JSON.parse(raw)
      const facts = Array.isArray(payload?.facts) ? payload.facts : []
      this.facts = facts
        .filter((fact) => fact && typeof fact.text === 'string' && fact.text.trim() !== '')
        .slice(-MAX_FACTS)
        .map((fact, index) => ({
          id: String(fact.id ?? `f${index + 1}`),
          text: clean(fact.text),
          createdAt: Number(fact.createdAt) || 0,
          source: fact.source ? String(fact.source).slice(0, 60) : undefined,
        }))
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn('memory file unreadable, starting empty', { error })
      this.facts = []
    }
    return this
  }

  /** Persist the current list. */
  async save() {
    const payload = { version: 1, facts: this.facts }
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, `${JSON.stringify(payload, null, 1)}\n`, 'utf8')
  }

  /** How many facts are kept. */
  get size() {
    return this.facts.length
  }

  /** Every fact, oldest first. */
  list() {
    return [...this.facts]
  }

  /**
   * Add one fact.
   *
   * @param {string} text - the fact.
   * @param {object} [options] - `source` label, `now`.
   * @returns {Promise<object|undefined>} the stored fact, or undefined for a duplicate or an empty line.
   */
  async add(text, { source, now = () => new Date() } = {}) {
    const value = clean(text)
    if (value === '' || normalise(value).length < 3) return undefined
    const key = normalise(value)
    // The same fact written twice, or once with a different tail, stays single.
    const existing = this.facts.find((fact) => normalise(fact.text) === key)
    if (existing) return undefined

    const fact = {
      id: `f${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
      text: value,
      createdAt: now().getTime(),
      source,
    }
    this.facts.push(fact)
    if (this.facts.length > MAX_FACTS) this.facts = this.facts.slice(-MAX_FACTS)
    await this.save()
    return fact
  }

  /**
   * Forget one fact by number (1-based, as `/memory` prints it), id or substring.
   *
   * @param {string} reference - number, id or text fragment.
   * @returns {Promise<object|undefined>} the removed fact.
   */
  async forget(reference) {
    const value = String(reference ?? '').trim()
    if (value === '') return undefined
    let index = -1
    if (/^\d+$/.test(value)) {
      index = Number(value) - 1
    } else {
      index = this.facts.findIndex((fact) => fact.id === value)
      if (index === -1) {
        const key = normalise(value)
        index = this.facts.findIndex((fact) => normalise(fact.text).includes(key))
      }
    }
    if (index < 0 || index >= this.facts.length) return undefined
    const [removed] = this.facts.splice(index, 1)
    await this.save()
    return removed
  }

  /** Forget everything. */
  async clear() {
    const count = this.facts.length
    this.facts = []
    await this.save()
    return count
  }

  /**
   * The block injected into prompts: newest facts last, bounded in size.
   *
   * @param {number} [maxChars] - cap.
   * @returns {string} the facts, or an empty string when there are none.
   */
  render(maxChars = MAX_RENDER_CHARS) {
    if (this.facts.length === 0) return ''
    const lines = []
    let used = 0
    for (const fact of this.facts) {
      const line = `- ${fact.text}`
      if (used + line.length + 1 > maxChars) break
      lines.push(line)
      used += line.length + 1
    }
    return lines.join('\n')
  }

  /**
   * Read facts out of a `memory.md` written by the agent.
   *
   * @param {string} content - file contents.
   * @returns {string[]} candidate facts, in file order.
   */
  static parse(content) {
    const facts = []
    for (const line of String(content ?? '').split('\n')) {
      const match = line.match(FACT_LINE)
      if (match?.groups?.text) facts.push(match.groups.text)
    }
    return facts
  }

  /**
   * Ingest the facts the agent wrote during a run.
   *
   * @param {string} content - contents of `memory.md`.
   * @param {object} [options] - `source`, `now`, `limit`.
   * @returns {Promise<string[]>} the facts actually added.
   */
  async ingest(content, { source = 'agent', now, limit = 20 } = {}) {
    const added = []
    for (const candidate of MemoryStore.parse(content).slice(0, limit)) {
      const fact = await this.add(candidate, { source, now })
      if (fact) added.push(fact.text)
    }
    return added
  }
}

/** The file the agent may write durable facts to, inside the workspace. */
export const MEMORY_FILE = 'memory.md'

export const createMemoryStore = (options) => new MemoryStore(options)
