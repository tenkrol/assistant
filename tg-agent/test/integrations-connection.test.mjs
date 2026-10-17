import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ConnectionError,
  classifyError,
  connectionError,
  deadlineSignal,
  isAbortError,
  isTemporaryStatus,
  isTimeoutError,
} from '../src/integrations/connection.mjs'
import { TelegramError } from '../src/telegram.mjs'
import { TelegramError as MovedTelegramError } from '../src/integrations/telegram/index.mjs'
import { ModelError } from '../src/model.mjs'
import { ModelError as MovedModelError } from '../src/integrations/model/index.mjs'

test('временные и постоянные HTTP-статусы различаются', () => {
  for (const status of [408, 425, 429, 500, 502, 503]) assert.equal(isTemporaryStatus(status), true, String(status))
  for (const status of [200, 400, 401, 403, 404, 422]) assert.equal(isTemporaryStatus(status), false, String(status))
})

test('сетевой сбой и таймаут считаются временными, отказ ключа — постоянным', () => {
  const network = Object.assign(new Error('socket'), { code: 'ECONNRESET' })
  const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' })
  const rejected = Object.assign(new Error('unauthorized'), { status: 401 })
  assert.equal(classifyError(network), 'temporary')
  assert.equal(classifyError(timeout), 'temporary')
  assert.equal(classifyError(rejected), 'permanent')
  assert.equal(classifyError(new TypeError('bad request')), 'permanent')
})

test('ConnectionError сохраняет текст и выставляет вид ошибки', () => {
  const temporary = connectionError('провайдер не ответил', { provider: 'demo', status: 503 })
  assert.ok(temporary instanceof ConnectionError)
  assert.equal(temporary.message, 'провайдер не ответил')
  assert.equal(temporary.provider, 'demo')
  assert.equal(temporary.status, 503)
  assert.equal(temporary.temporary, true)
  assert.equal(temporary.kind, 'temporary')

  const permanent = new ConnectionError('нет доступа', { status: 403 })
  assert.equal(permanent.temporary, false)
  assert.equal(permanent.kind, 'permanent')
})

test('deadlineSignal срабатывает по таймауту и по внешней отмене', async () => {
  const timedOut = deadlineSignal(20)
  // Таймер внутри deadlineSignal не держит event loop: без своего таймера-страховки
  // процесс теста успевает завершиться до срабатывания, и Node отменяет тест.
  await new Promise((resolve) => {
    const guard = setTimeout(resolve, 1000)
    timedOut.addEventListener('abort', () => { clearTimeout(guard); resolve() }, { once: true })
  })
  assert.equal(timedOut.aborted, true)
  assert.equal(timedOut.reason?.name, 'TimeoutError')
  assert.equal(isTimeoutError(timedOut.reason), true)

  const controller = new AbortController()
  const cancelled = deadlineSignal(10_000, controller.signal)
  controller.abort()
  assert.equal(cancelled.aborted, true)
  assert.equal(cancelled.reason?.name, 'AbortError')
  assert.equal(isAbortError(cancelled.reason), true)
})

test('старые пути отдают те же классы ошибок, что и новые', () => {
  assert.equal(TelegramError, MovedTelegramError)
  assert.equal(ModelError, MovedModelError)
  assert.ok(new TelegramError('x', { status: 500 }) instanceof ConnectionError)
  assert.ok(new ModelError('x', { status: 429 }) instanceof ConnectionError)
})
