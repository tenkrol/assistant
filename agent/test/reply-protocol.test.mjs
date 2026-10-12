import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildContinuation, parseReply, variantButtonLabel } from '../src/reply-protocol.mjs'

test('a plain answer stays a plain answer', () => {
  const reply = parseReply('Готово: отчёт в outbox/отчёт.docx')
  assert.equal(reply.kind, 'answer')
  assert.equal(reply.answer, 'Готово: отчёт в outbox/отчёт.docx')
  assert.deepEqual(reply.variants, [])
})

test('a question marker splits the answer from the question', () => {
  const reply = parseReply('Собрал данные из файла, осталось выбрать период.\n\nВОПРОС: за какой месяц считать — сентябрь или октябрь?')
  assert.equal(reply.kind, 'question')
  assert.match(reply.answer, /Собрал данные/)
  assert.match(reply.question, /за какой месяц/)
})

test('a question may continue on the following lines', () => {
  const reply = parseReply('ВОПРОС: нужен доступ к таблице.\nВторой вариант — пришлите выгрузку CSV.')
  assert.equal(reply.kind, 'question')
  assert.match(reply.question, /нужен доступ/)
  assert.match(reply.question, /выгрузку CSV/)
})

test('a bare question marker still produces a question', () => {
  const reply = parseReply('ВОПРОС:')
  assert.equal(reply.kind, 'question')
  assert.match(reply.question, /уточнение/)
})

test('bold and bulleted question markers are recognised', () => {
  for (const text of ['**ВОПРОС:** какой формат?', '- ВОПРОС: какой формат?', '> ВОПРОС: какой формат?']) {
    const reply = parseReply(`${text}`)
    assert.equal(reply.kind, 'question', text)
    assert.match(reply.question, /какой формат/)
  }
})

test('variants are split by their markers', () => {
  const reply = parseReply([
    'Есть два пути.',
    '',
    'ВАРИАНТ 1: краткий отчёт на одну страницу — быстро, без графиков.',
    'ВАРИАНТ 2: полный отчёт с графиками — дольше, но нагляднее.',
  ].join('\n'))
  assert.equal(reply.kind, 'variants')
  assert.equal(reply.answer, 'Есть два пути.')
  assert.equal(reply.variants.length, 2)
  assert.deepEqual(reply.variants.map((variant) => variant.n), [1, 2])
  assert.match(reply.variants[0].text, /краткий отчёт/)
  assert.match(reply.variants[1].text, /полный отчёт/)
})

test('a variant may be described on several lines', () => {
  const reply = parseReply([
    '**ВАРИАНТ 1:** краткий отчёт',
    'Цена: ~2 минуты.',
    '**ВАРИАНТ 2:** полный отчёт',
    'Цена: ~10 минут.',
  ].join('\n'))
  assert.equal(reply.variants.length, 2)
  assert.match(reply.variants[0].text, /Цена: ~2 минуты/)
  assert.match(reply.variants[1].text, /Цена: ~10 минут/)
  assert.equal(reply.answer, '')
})

test('a single variant marker is not a choice — it is just an answer', () => {
  const reply = parseReply('ВАРИАНТ 1: сделаю кратко')
  assert.equal(reply.kind, 'answer')
})

test('variants win over a question, which is kept as the intro', () => {
  const reply = parseReply('ВАРИАНТ 1: кратко\nВАРИАНТ 2: подробно\nВОПРОС: а для кого отчёт?')
  // A choice is an answer, so the variants stay buttons; the question travels
  // along as the intro. This is what the model actually sends in practice.
  assert.equal(reply.kind, 'variants')
  assert.equal(reply.variants.length, 2)
  assert.match(reply.question, /для кого/)
})

test('a question before the variants does not swallow them', () => {
  const reply = parseReply([
    'Уточню и сразу предложу пути.',
    'ВОПРОС: для какого документа?',
    'ВАРИАНТ 1: ГОСТ',
    'ВАРИАНТ 2: деловой минимализм',
  ].join('\n'))
  assert.equal(reply.kind, 'variants')
  assert.deepEqual(reply.variants.map((variant) => variant.n), [1, 2])
  assert.match(reply.question, /для какого документа/)
  assert.match(reply.answer, /Уточню и сразу предложу/)
  assert.equal(reply.variants[0].text, 'ГОСТ', 'the question body stops at the first variant')
})

test('more variants than allowed are cut', () => {
  const lines = []
  for (let n = 1; n <= 7; n += 1) lines.push(`ВАРИАНТ ${n}: путь ${n}`)
  const reply = parseReply(lines.join('\n'), { maxVariants: 3 })
  assert.equal(reply.variants.length, 3)
})

test('variant buttons stay short and numbered', () => {
  const label = variantButtonLabel({ n: 2, text: 'Полный отчёт с графиками и приложениями, включая сырые данные' })
  assert.match(label, /^2\. /)
  assert.ok(label.length <= 30, `label too long: ${label}`)
})

test('the continuation prompt carries the chosen variant', () => {
  const chosen = buildContinuation({ kind: 'variant', variant: 'ВАРИАНТ 2: полный отчёт' })
  assert.match(chosen, /выбрал вариант/)
  assert.match(chosen, /полный отчёт/)
  assert.match(chosen, /до конца/)
})

test('the continuation prompt carries the answer to a question', () => {
  const answer = buildContinuation({ kind: 'question', text: 'за октябрь' })
  assert.match(answer, /Ответ пользователя/)
  assert.match(answer, /за октябрь/)
  assert.match(answer, /Продолжи выполнение/)
})
