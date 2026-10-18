import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyChangeRequest, looksLikeChangeRequest } from '../src/core/request-detect.mjs'

test('reminders and calendar operations are data, not product changes', () => {
  assert.equal(classifyChangeRequest('Добавь напоминание завтра в 10:00 позвонить маме'), 'data')
  assert.equal(classifyChangeRequest('Удали напоминание про встречу'), 'data')
  assert.equal(looksLikeChangeRequest('напомни завтра купить хлеб'), false)
})

test('explicit product change is product or clarification', () => {
  assert.equal(classifyChangeRequest('Добавь в бота возможность повторять напоминание до подтверждения'), 'product')
  assert.equal(classifyChangeRequest('Добавь в бота команду показа релиза'), 'product')
  assert.equal(classifyChangeRequest('Научи агента отчитываться по шагам'), 'product')
})

test('ordinary tasks and questions stay data', () => {
  assert.equal(classifyChangeRequest('сделай отчёт по продажам'), 'data')
  assert.equal(classifyChangeRequest('что ты обо мне помнишь?'), 'data')
})
