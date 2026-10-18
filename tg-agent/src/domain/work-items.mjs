/**
 * Модель дел: цели, проекты, обязательства, решения, вопросы, результаты.
 * Факт, предположение и предложение различаются явно.
 */
export const WORK_ITEM_KINDS = Object.freeze(['goal', 'project', 'obligation', 'decision', 'question', 'result'])
export const WORK_ITEM_EPISTEMIC = Object.freeze(['fact', 'assumption', 'proposal'])
export const WORK_ITEM_STATUSES = Object.freeze(['open', 'active', 'blocked', 'done', 'cancelled'])

const TRANSITIONS = {
  open: ['active', 'blocked', 'done', 'cancelled'],
  active: ['blocked', 'done', 'cancelled'],
  blocked: ['active', 'cancelled'],
  done: ['active'],
  cancelled: ['active'],
}

export function canTransitionWorkItem(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to))
}

export function validateWorkItemInput(input = {}) {
  const errors = []
  if (!WORK_ITEM_KINDS.includes(input.kind)) errors.push('kind')
  if (!WORK_ITEM_EPISTEMIC.includes(input.epistemic ?? 'fact')) errors.push('epistemic')
  if (!String(input.title ?? '').trim()) errors.push('title')
  if (input.ownerId === undefined || input.ownerId === null) errors.push('ownerId')
  if (input.source && !String(input.source.type ?? '').trim()) errors.push('source.type')
  if (input.dueAt && Number.isNaN(Date.parse(input.dueAt))) errors.push('dueAt')
  if (input.staleAfter && Number.isNaN(Date.parse(input.staleAfter))) errors.push('staleAfter')
  return errors
}

export function isStale(item, now = Date.now()) {
  if (!item?.staleAfter) return false
  return Date.parse(item.staleAfter) <= Number(now)
}
