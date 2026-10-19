/**
 * PLB-026: активность агента несёт владельца и область задачи.
 *
 * Проверяем мост без сети: `fetchImpl` подставной, дальше — настоящие
 * `normalizeActivityEvent`, `collectCandidates` и ACL пространств. Задача без
 * проверенного владельца по-прежнему не становится общедоступной.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentBridge, normalizeActivityEvent } from '../src/integrations/agent-bridge/index.mjs'
import {
  TASK_OWNER_UNKNOWN_REASON,
  collectCandidates,
} from '../src/proactive.mjs'
import { createAccess } from '../src/core/access.mjs'
import { ScopeStore } from '../src/scopes.mjs'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const OWNER = 433296567

/** Ответ v2-моста на GET /v1/activity. */
function activityFetch(events) {
  const calls = []
  const impl = async (url, options = {}) => {
    calls.push({ url, options })
    return { ok: true, status: 200, json: async () => ({ ok: true, events }) }
  }
  impl.calls = calls
  return impl
}

test('owner and scope from the agent are normalized into taskPrincipal fields', async () => {
  const fetchImpl = activityFetch([
    { type: 'completed', taskId: 't1', status: 'done', userId: OWNER, scopeId: 'chat:42' },
  ])
  const bridge = createAgentBridge({
    url: 'http://127.0.0.1:8787/bridge',
    token: 'secret',
    contract: 'v2',
    fetchImpl,
    logger: silent,
  })

  const [event] = await bridge.activity({ limit: 5 })
  assert.equal(event.userId, OWNER)
  assert.equal(event.scopeId, `personal-${OWNER}`, 'область агента переводится в пространство бота')
  assert.equal(fetchImpl.calls[0].url, 'http://127.0.0.1:8787/v1/activity?limit=5')
  assert.equal(fetchImpl.calls[0].options.headers.authorization, 'Bearer secret')
})

test('an already bot-shaped scope is kept, and an event without userId is not made public', () => {
  const shaped = normalizeActivityEvent({ type: 'completed', taskId: 't1', userId: OWNER, scopeId: 'personal-1' })
  assert.equal(shaped.scopeId, 'personal-1')

  const anonymous = normalizeActivityEvent({ type: 'completed', taskId: 't2', scopeId: 'chat:1' })
  assert.equal(anonymous.userId, undefined)
  assert.equal(anonymous.scopeId, 'chat:1', 'без владельца мост не придумывает область')
})

test('a task with an owner reaches only that owner; a task without one is filtered', () => {
  const access = createAccess({ store: new ScopeStore({ logger: silent }), logger: silent })
  const now = new Date()
  const tasks = [
    normalizeActivityEvent({ type: 'completed', taskId: 'mine', status: 'done', userId: OWNER, scopeId: 'chat:42' }),
    normalizeActivityEvent({ type: 'completed', taskId: 'anon', status: 'done' }),
  ]

  const denied = []
  const mine = collectCandidates({
    now,
    tasks,
    userId: OWNER,
    chatId: OWNER,
    settings: { tz: 'Europe/Moscow' },
    access,
    onDenied: (decision) => denied.push(decision),
  })
  assert.deepEqual(mine.map((candidate) => candidate.key), ['task:mine'])
  assert.match(mine[0].title, /Поручение выполнено/)
  assert.equal(mine[0].subjectUserId, OWNER)
  assert.ok(denied.some((decision) => decision.key === 'task:anon' && decision.reason === TASK_OWNER_UNKNOWN_REASON))

  // Другой человек не получает чужую задачу, даже зная её id.
  const foreign = collectCandidates({
    now,
    tasks,
    userId: 1,
    chatId: 1,
    settings: { tz: 'Europe/Moscow' },
    access,
  })
  assert.deepEqual(foreign, [])
})
