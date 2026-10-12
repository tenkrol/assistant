import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildTaskPrompt, describeAttachmentIssues } from '../src/prompt.mjs'

test('a bare text task becomes the prompt unchanged', () => {
  const prompt = buildTaskPrompt({ text: 'сделай отчёт по продажам' })
  assert.equal(prompt, 'сделай отчёт по продажам')
})

test('attachments without text still produce a task', () => {
  const prompt = buildTaskPrompt({ text: '', files: [{ relPath: 'inbox/смета.xlsx', size: 2048, kind: 'document' }] })
  assert.match(prompt, /Разбери вложения/)
  assert.match(prompt, /inbox\/смета\.xlsx/)
})

test('extracted document text is quoted for the model', () => {
  const prompt = buildTaskPrompt({
    text: 'перескажи',
    files: [{ relPath: 'inbox/договор.docx', name: 'договор.docx', size: 1024, kind: 'document', text: 'Пункт 1. Оплата до 10 числа.' }],
  })
  assert.match(prompt, /перескажи/)
  assert.match(prompt, /Приложенные файлы/)
  assert.match(prompt, /Содержимое файла «договор\.docx»/)
  assert.match(prompt, /Оплата до 10 числа/)
})

test('the prompt respects its size budget and says when text was cut', () => {
  const long = 'я'.repeat(50_000)
  const prompt = buildTaskPrompt({
    text: 'посмотри файл',
    files: [{ relPath: 'inbox/большой.txt', name: 'большой.txt', size: long.length, kind: 'document', text: long }],
    maxChars: 4000,
  })
  assert.ok(prompt.length < 6000, `prompt stayed near the budget, got ${prompt.length}`)
  assert.match(prompt, /приведено частично/)
})

test('attachment problems are listed with the files', () => {
  const prompt = buildTaskPrompt({
    text: 'разбери',
    files: [{ relPath: 'inbox/photo.jpg', name: 'photo.jpg', size: 100, kind: 'photo' }],
    notes: ['проблема: голосовое не расшифровано'],
  })
  assert.match(prompt, /фото|изображение/)
  assert.match(prompt, /голосовое не расшифровано/)
})

test('describeAttachmentIssues is empty when everything was usable', () => {
  const files = [{ name: 'договор.docx', kind: 'document', text: 'текст' }]
  assert.equal(describeAttachmentIssues(files, []), '')
})

test('describeAttachmentIssues explains unreadable files', () => {
  const files = [
    { name: 'photo.jpg', kind: 'photo', visionError: 'модель недоступна', ocrError: 'текста нет' },
    { name: 'скан.pdf', kind: 'document', extractError: 'формат не поддерживается' },
    { name: 'voice.ogg', kind: 'voice' },
  ]
  const text = describeAttachmentIssues(files, ['аудио: не удалось скачать'])
  assert.match(text, /не удалось прочитать изображение/)
  assert.match(text, /модель недоступна/)
  assert.match(text, /формат не поддерживается/)
  assert.match(text, /не расшифровывает/)
  assert.match(text, /не удалось скачать/)
})

test('a recognised image is not reported as a problem', () => {
  const files = [{ name: 'скан.png', kind: 'photo', text: 'СЧЁТ 12345', source: 'vision' }]
  assert.equal(describeAttachmentIssues(files, []), '')
})

test('the prompt says how an image was understood', () => {
  const recognised = buildTaskPrompt({
    text: 'проверь счёт',
    files: [{ relPath: 'inbox/счёт.png', name: 'счёт.png', size: 2048, kind: 'photo', text: 'СЧЁТ 12345' }],
  })
  assert.match(recognised, /изображение распознано ниже/)
  assert.match(recognised, /СЧЁТ 12345/)

  const unreadable = buildTaskPrompt({
    text: 'проверь',
    files: [{ relPath: 'inbox/блур.png', name: 'блур.png', size: 2048, kind: 'photo' }],
  })
  assert.match(unreadable, /изображение не прочитано/)
})
