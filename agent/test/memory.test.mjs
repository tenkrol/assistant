import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { MemoryStore } from '../src/memory.mjs'
import { buildTaskPrompt } from '../src/prompt.mjs'
import { createBotHarness, createTestLogger, tempDir, cleanup } from './helpers.mjs'

const makeStore = async (dir) => new MemoryStore({ file: path.join(dir, 'memory.json'), logger: createTestLogger() }).load()

test('facts are parsed out of the file the agent writes', () => {
  const content = [
    '# Заметки',
    'просто текст, не факт',
    '- живёт в Москве',
    '* предпочитает короткие ответы',
    '• проект называется «Кедр»',
    '-   лишние   пробелы   внутри  ',
  ].join('\n')
  assert.deepEqual(MemoryStore.parse(content), [
    'живёт в Москве',
    'предпочитает короткие ответы',
    'проект называется «Кедр»',
    'лишние   пробелы   внутри',
  ])
})

test('a fact is stored once, however it is repeated', async () => {
  const dir = await tempDir()
  try {
    const store = await makeStore(dir)
    assert.ok(await store.add('живёт в Москве'))
    assert.equal(await store.add('Живёт   в   Москве'), undefined, 'дубль не добавляется')
    assert.equal(await store.add('  '), undefined, 'пустое не добавляется')
    assert.equal(await store.add('да'), undefined, 'слишком короткое не добавляется')
    assert.equal(store.size, 1)
  } finally {
    await cleanup(dir)
  }
})

test('memory survives a restart', async () => {
  const dir = await tempDir()
  try {
    const first = await makeStore(dir)
    await first.add('отчёты делает в xlsx', { source: 'owner' })
    const second = await makeStore(dir)
    assert.equal(second.size, 1)
    assert.equal(second.list()[0].text, 'отчёты делает в xlsx')
    assert.equal(second.list()[0].source, 'owner')
  } finally {
    await cleanup(dir)
  }
})

test('the list is capped, oldest facts fall out', async () => {
  const dir = await tempDir()
  try {
    const store = await makeStore(dir)
    for (let index = 0; index < 130; index += 1) await store.add(`факт номер ${index}`)
    assert.equal(store.size, 120)
    assert.equal(store.list()[0].text, 'факт номер 10')
  } finally {
    await cleanup(dir)
  }
})

test('a fact can be forgotten by number, by id and by text', async () => {
  const dir = await tempDir()
  try {
    const store = await makeStore(dir)
    await store.add('первый факт про Москву')
    await store.add('второй факт про отчёты')
    const id = store.list()[1].id

    assert.equal((await store.forget('1')).text, 'первый факт про Москву')
    assert.equal((await store.forget(id)).text, 'второй факт про отчёты')
    assert.equal(store.size, 0)

    await store.add('третий факт про кедры')
    assert.equal((await store.forget('кедр')).text, 'третий факт про кедры')
    assert.equal(await store.forget('нет такого'), undefined)
  } finally {
    await cleanup(dir)
  }
})

test('rendering respects the character budget', async () => {
  const dir = await tempDir()
  try {
    const store = await makeStore(dir)
    for (let index = 0; index < 50; index += 1) await store.add(`довольно длинный факт номер ${index} про дела владельца`)
    const rendered = store.render(200)
    assert.ok(rendered.length <= 200, `получилось ${rendered.length}`)
    assert.match(rendered, /^- /)
    assert.equal((await makeStore(dir)).render(0), '', 'нулевой бюджет — пусто')
  } finally {
    await cleanup(dir)
  }
})

test('ingesting the agent file adds only what is new', async () => {
  const dir = await tempDir()
  try {
    const store = await makeStore(dir)
    await store.add('живёт в Москве')
    const added = await store.ingest('- живёт в Москве\n- работает над отчётами\n', { source: 'task-1' })
    assert.deepEqual(added, ['работает над отчётами'])
    assert.equal(store.size, 2)
    assert.equal(store.list()[1].source, 'task-1')
  } finally {
    await cleanup(dir)
  }
})

test('facts reach the task prompt, and an empty memory changes nothing', () => {
  const withFacts = buildTaskPrompt({ text: 'сделай отчёт', memory: '- живёт в Москве' })
  assert.match(withFacts, /Что уже известно о пользователе/)
  assert.match(withFacts, /живёт в Москве/)
  assert.equal(buildTaskPrompt({ text: 'сделай отчёт', memory: '' }).includes('Что уже известно'), false)
})

test('a run leaves its facts in the store and no memory.md behind', async () => {
  const env = await createBotHarness({
    runner: {
      async run({ task }) {
        // The agent does its work and appends a durable fact.
        assert.match(task, /Что уже известно о пользователе/)
        assert.match(task, /живёт в Москве/)
        const workspace = env.config?.workspace?.dir
        await fs.writeFile(path.join(workspace, 'memory.md'), '- предпочитает отчёты в xlsx\n', 'utf8')
        return { ok: true, exitCode: 0, timedOut: false, aborted: false, text: 'готово', sessionId: 's', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, steps: 1 }, tools: [], errors: [], stderr: '', durationMs: 10 }
      },
    },
  })
  try {
    await env.memory.add('живёт в Москве', { source: 'owner' })
    await env.bot.handleUpdate({ kind: 'message', id: 1, chat: { id: 42, type: 'private' }, from: { id: 42, name: 'В', isBot: false }, text: 'сделай отчёт в xlsx', attachments: [], addressed: true, messageId: 9 })
    await env.bot.worker

    const texts = env.memory.list().map((fact) => fact.text)
    assert.ok(texts.includes('предпочитает отчёты в xlsx'), 'факт агента запомнен')
    assert.equal(texts.includes('живёт в Москве'), true, 'прежний факт сохранён')
    await assert.rejects(() => fs.readFile(path.join(env.config.workspace.dir, 'memory.md'), 'utf8'), /ENOENT/)
  } finally {
    await env.close()
  }
})

test('the owner can add, list and drop facts by command', async () => {
  const env = await createBotHarness()
  try {
    const say = async (text) => {
      await env.bot.handleUpdate({ kind: 'message', id: 2, chat: { id: 42, type: 'private' }, from: { id: 42, name: 'В', isBot: false }, text, attachments: [], addressed: true, messageId: 10 })
      await env.bot.worker
      return env.platform.sent.at(-1)?.markdown ?? ''
    }
    assert.match(await say('/remember живёт в Москве'), /Запомнил/)
    assert.match(await say('/remember живёт в Москве'), /Уже помню/)
    assert.match(await say('/memory'), /1\. живёт в Москве/)
    assert.match(await say('/forget 1'), /Забыл/)
    assert.match(await say('/memory'), /Память пуста/)
  } finally {
    await env.close()
  }
})
