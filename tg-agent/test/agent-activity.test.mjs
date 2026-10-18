/**
 * PLB-015: клиент активности агента и команды /agents, /activity.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAgentBridge } from '../src/integrations/agent-bridge/index.mjs'

const bridge = (payloads) => createAgentBridge({
  url: 'http://agent.test',
  token: 'token',
  contract: 'v2',
  logger: { info() {}, warn() {}, error() {} },
  fetchImpl: async (url) => {
    if (url.includes('/v1/review')) return { ok: true, status: 200, json: async () => ({ ok: true, suggestions: payloads.review ?? [] }) }
    if (url.includes('/v1/requests')) return { ok: true, status: 202, json: async () => ({ ok: true, ...payloads.request }) }
    if (url.includes('/v1/agents')) return { ok: true, status: 200, json: async () => ({ ok: true, agents: payloads.agents }) }
    if (url.includes('/v1/usage')) return { ok: true, status: 200, json: async () => ({ ok: true, usage: payloads.usage }) }
    return { ok: true, status: 200, json: async () => ({ ok: true, events: payloads.activity }) }
  },
})

test('agents() and activity() use the v2 API', async () => {
  const client = bridge({ review: [{ id: 'r1', title: 'Review' }], request: { requestId: 'REQ-0009', compareUrl: 'https://example/c' }, agents: [{ id: 'dsh', modelProfile: 'm' }], activity: [{ taskId: 't1', type: 'completed' }], usage: { today: { prompt: 3, completion: 4, requests: 1 } } })
  assert.deepEqual(await client.agents(), [{ id: 'dsh', modelProfile: 'm' }])
  assert.deepEqual(await client.activity({ limit: 5 }), [{ taskId: 't1', type: 'completed' }])
  assert.equal((await client.usage()).today.prompt, 3)
  assert.equal((await client.createRequest({ text: 'доработка' })).requestId, 'REQ-0009')
  assert.equal((await client.review()).suggestions[0].id, 'r1')
})
