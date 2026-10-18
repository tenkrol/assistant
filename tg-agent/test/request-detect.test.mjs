import assert from 'node:assert/strict'
import { test } from 'node:test'
import { looksLikeChangeRequest } from '../src/core/request-detect.mjs'

test('detects explicit product change requests', () => {
  assert.equal(looksLikeChangeRequest('добавь в бота команду показа релиза'), true)
  assert.equal(looksLikeChangeRequest('нужно чтобы агент умел отчитываться'), true)
})

test('leaves ordinary tasks and questions alone', () => {
  assert.equal(looksLikeChangeRequest('сделай отчёт по продажам'), false)
  assert.equal(looksLikeChangeRequest('напомни завтра купить хлеб'), false)
  assert.equal(looksLikeChangeRequest('что ты обо мне помнишь?'), false)
})
