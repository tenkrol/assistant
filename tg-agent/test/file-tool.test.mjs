/**
 * The `file` tool: what the model produces becomes a document the user can open.
 *
 * The formats themselves are checked in office-write.test.mjs; here the contract of
 * the tool matters — names, guards and the bytes handed to the core.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { extractText } from '../src/extract.mjs'
import { FORMATS, createFileTool } from '../src/file-tool.mjs'

const tool = createFileTool()

test('an xlsx report comes back as a real workbook', async () => {
  const result = await tool.executeDetailed({
    format: 'xlsx',
    name: 'отчёт за октябрь',
    table: { header: ['Товар', 'Цена'], rows: [['Хлеб', '50'], ['Молоко', '80']] },
    caption: 'Отчёт',
  })
  assert.ok(result.file, result.text)
  assert.equal(result.file.fileName, 'отчёт за октябрь.xlsx')
  assert.equal(result.file.caption, 'Отчёт')
  assert.match(result.text, /готов/i)
  const extracted = extractText({ fileName: result.file.fileName, bytes: result.file.bytes })
  assert.equal(extracted.kind, 'xlsx')
  assert.match(extracted.text, /Хлеб/)
  assert.match(extracted.text, /Молоко/)
})

test('a docx letter keeps its title and paragraphs', async () => {
  const result = await tool.executeDetailed({
    format: 'docx',
    name: 'письмо клиенту',
    title: 'Уважаемый клиент',
    text: 'Пишем вам по поводу заказа.\n\nС уважением, команда.',
  })
  assert.ok(result.file)
  const extracted = extractText({ fileName: result.file.fileName, bytes: result.file.bytes })
  assert.match(extracted.text, /Уважаемый клиент/)
  assert.match(extracted.text, /С уважением/)
})

test('text formats and csv work, and the name is sanitised', async () => {
  const csv = await tool.executeDetailed({ format: 'csv', name: 'данные', table: { header: ['a', 'b'], rows: [['1', '2']] } })
  assert.match(String(csv.file.bytes.toString('utf8')), /a,b/)
  const markdown = await tool.executeDetailed({ format: 'md', name: 'сводка', title: 'Итоги', text: '- раз\n- два' })
  assert.match(String(markdown.file.bytes.toString('utf8')), /Итоги/)
  const slashes = await tool.executeDetailed({ format: 'txt', name: '../../etc/passwd', text: 'данные' })
  assert.equal(slashes.file.fileName.includes('/'), false, 'путь не должен просачиваться в имя файла')
})

test('bad requests are refused with a readable reason and no file', async () => {
  const wrongFormat = await tool.executeDetailed({ format: 'rtf', name: 'x' })
  assert.equal(wrongFormat.file, undefined)
  assert.match(wrongFormat.text, /формат должен быть одним из/)
  // pdf теперь настоящий формат: без содержимого он обязан объяснить, чего не хватает.
  const emptyPdf = await tool.executeDetailed({ format: 'pdf', name: 'x' })
  assert.equal(emptyPdf.file, undefined)
  assert.match(emptyPdf.text, /нужен text или table/)
  const noTable = await tool.executeDetailed({ format: 'xlsx', name: 'x' })
  assert.equal(noTable.file, undefined)
  assert.match(noTable.text, /нужна таблица/)
  const emptyText = await tool.executeDetailed({ format: 'md', name: 'x' })
  assert.equal(emptyText.file, undefined)
  assert.match(emptyText.text, /нужно поле text/)
  const huge = await tool.executeDetailed({ format: 'csv', name: 'x', table: { header: ['a'], rows: Array.from({ length: 5001 }, () => ['1']) } })
  assert.equal(huge.file, undefined)
  assert.match(huge.text, /слишком много строк/)
})

test('every advertised format is accepted', async () => {
  for (const format of FORMATS) {
    const args = format === 'xlsx' || format === 'csv'
      ? { format, name: 'файл', table: { header: ['a'], rows: [['1']] } }
      : { format, name: 'файл', text: 'текст' }
    const result = await tool.executeDetailed(args)
    assert.ok(result.file, `${format}: ${result.text}`)
  }
})
