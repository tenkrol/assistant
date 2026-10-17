/**
 * Единый контракт инструмента: `definition`, `executeDetailed`, `execute`.
 *
 * Контракт важен не сам по себе, а обещанием: ошибка инструмента не вылетает в
 * ход диалога, а становится текстом, который увидит модель.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { asTool, createTool } from '../src/tools/contract.mjs'

const definition = {
  type: 'function',
  function: { name: 'demo', description: 'пример', parameters: { type: 'object', properties: {} } },
}

test('инструмент отдаёт одну и ту же строку через execute и executeDetailed', async () => {
  const tool = createTool({
    definition,
    executeDetailed: async () => ({ text: 'готово', data: 42 }),
  })
  assert.equal(await tool.execute({}), 'готово')
  assert.deepEqual(await tool.executeDetailed({}), { text: 'готово', data: 42 })
})

test('старый стиль с одним execute тоже работает', async () => {
  const tool = createTool({ definition, execute: async () => 'старый стиль' })
  const outcome = await tool.executeDetailed({})
  assert.equal(outcome.text, 'старый стиль')
  assert.equal(await tool.execute({}), 'старый стиль')
})

test('исключение инструмента не вылетает наружу', async () => {
  const tool = createTool({
    definition,
    executeDetailed: async () => { throw new Error('сломалось') },
  })
  const outcome = await tool.executeDetailed({})
  assert.match(outcome.text, /Ошибка инструмента demo/)
  assert.match(outcome.text, /сломалось/)
  await assert.doesNotReject(() => tool.execute({}))
})

test('пустой результат объясняется, а не превращается в пустую строку', async () => {
  const tool = createTool({ definition, executeDetailed: async () => undefined })
  const outcome = await tool.executeDetailed({})
  assert.match(outcome.text, /пустой результат/)
})

test('asTool оборачивает готовый объект, не теряя текст', async () => {
  const tool = asTool({ definition, execute: async () => 'из старого объекта' })
  assert.equal(await tool.execute({}), 'из старого объекта')
})
