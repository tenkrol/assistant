/**
 * Хранилище дел: атомарный JSON, история переходов, доступ по owner/scope.
 */
import { createJsonStore } from './storage/json-store.mjs'
import { canTransitionWorkItem, isStale, validateWorkItemInput, WORK_ITEM_STATUSES } from './domain/work-items.mjs'

const VERSION = 1

export class WorkItemStore {
  constructor({ file, logger, now = () => Date.now(), maxItems = 2000 }) {
    this.file = file
    this.logger = logger
    this.now = now
    this.maxItems = maxItems
    this.storage = createJsonStore({ file, version: VERSION, defaults: { items: [] }, logger })
    this.items = []
  }

  async load() {
    const data = await this.storage.load()
    this.items = Array.isArray(data.items) ? data.items.filter((item) => WORK_ITEM_STATUSES.includes(item.status)) : []
    return this
  }

  async #save() {
    this.items = this.items.slice(-this.maxItems)
    await this.storage.transaction((draft) => { draft.items = this.items })
  }

  async create(input = {}) {
    const errors = validateWorkItemInput(input)
    if (errors.length) throw new Error(`некорректное дело: ${errors.join(', ')}`)
    const at = new Date(this.now()).toISOString()
    const item = {
      id: input.id ?? `wi-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      kind: input.kind,
      title: String(input.title).trim(),
      detail: input.detail === undefined ? undefined : String(input.detail),
      ownerId: input.ownerId,
      scopeId: input.scopeId,
      source: input.source ?? { type: 'owner', at },
      epistemic: input.epistemic ?? 'fact',
      status: input.status ?? 'open',
      parentId: input.parentId,
      dueAt: input.dueAt,
      staleAfter: input.staleAfter,
      createdAt: at,
      updatedAt: at,
      history: [{ at, from: undefined, to: input.status ?? 'open', reason: 'создано' }],
    }
    this.items.push(item)
    await this.#save()
    return item
  }

  get(id) {
    return this.items.find((item) => item.id === id)
  }

  list({ ownerId, scopeId, kind, status, includeStale = true } = {}) {
    return this.items.filter((item) => {
      if (ownerId !== undefined && String(item.ownerId) !== String(ownerId)) return false
      if (scopeId !== undefined && String(item.scopeId) !== String(scopeId)) return false
      if (kind !== undefined && item.kind !== kind) return false
      if (status !== undefined && item.status !== status) return false
      if (!includeStale && isStale(item, this.now())) return false
      return true
    })
  }

  async update(id, patch = {}, { reason = 'обновлено', actor } = {}) {
    const item = this.get(id)
    if (!item) throw new Error('дело не найдено')
    if (patch.status && !canTransitionWorkItem(item.status, patch.status)) throw new Error(`переход ${item.status}→${patch.status} запрещён`)
    const at = new Date(this.now()).toISOString()
    const from = item.status
    Object.assign(item, {
      ...(patch.title === undefined ? {} : { title: String(patch.title).trim() }),
      ...(patch.detail === undefined ? {} : { detail: String(patch.detail) }),
      ...(patch.epistemic === undefined ? {} : { epistemic: patch.epistemic }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.dueAt === undefined ? {} : { dueAt: patch.dueAt }),
      ...(patch.staleAfter === undefined ? {} : { staleAfter: patch.staleAfter }),
      updatedAt: at,
    })
    item.history.push({ at, from, to: item.status, reason, ...(actor === undefined ? {} : { actor }) })
    await this.#save()
    return item
  }

  async flush() { await this.storage.flush() }
}
