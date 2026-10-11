/**
 * Polls: the durable store, the `poll` tool and the text helpers.
 *
 * Every test works in its own temporary directory, so this file neither shares
 * state with the other test files nor depends on the order tests run in.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MAX_OPTION_LENGTH,
  MAX_QUESTION_LENGTH,
  POLL_HINT,
  PollStore,
  createPollTool,
  parsePollAction,
  pollKeyboard,
  pollMessage,
  pollResultsLine,
} from '../src/polls.mjs'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }
const CREATED_AT = '2026-10-06T09:00:00.000Z'

/** A store backed by a fresh temporary file. */
async function makeStore({ maxPolls = 100 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-polls-'))
  const file = path.join(dir, 'polls.json')
  const store = new PollStore({ file, logger: silentLogger, maxPolls })
  await store.load()
  return {
    dir,
    file,
    store,
    /** Flush before removing so no in-flight write can land during `rm`. */
    cleanup: async () => {
      await store.flush()
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
  }
}

/** A stored poll literal: strings become empty-vote options, objects pass through. */
function makePoll({ id = '1', chatId = 1, question = 'Куда едем?', options = [], userId, closedAt, ...rest } = {}) {
  return {
    id,
    chatId,
    ...(userId === undefined ? {} : { userId }),
    question,
    options: options.map((option) => (typeof option === 'string' ? { text: option, votes: [] } : option)),
    createdAt: CREATED_AT,
    ...(closedAt === undefined ? {} : { closedAt }),
    ...rest,
  }
}

// ---------------------------------------------------------------------------
// Store: creation and shape
// ---------------------------------------------------------------------------

test('add stores the documented record shape', async () => {
  const ctx = await makeStore()
  try {
    const poll = ctx.store.add({
      chatId: 7,
      userId: 42,
      question: '  Куда едем в выходные?  ',
      options: ['  Дача ', 'Море'],
    })
    assert.equal(poll.id, '1')
    assert.equal(poll.chatId, 7)
    assert.equal(poll.userId, 42)
    assert.equal(poll.question, 'Куда едем в выходные?')
    assert.deepEqual(poll.options, [{ text: 'Дача', votes: [] }, { text: 'Море', votes: [] }])
    assert.equal(poll.closedAt, undefined)
    assert.ok(Number.isFinite(Date.parse(poll.createdAt)), `createdAt ${poll.createdAt}`)
    assert.deepEqual(ctx.store.list(7), [poll])
    assert.deepEqual(ctx.store.list(), [poll])
    assert.deepEqual(ctx.store.list(8), [])
    assert.equal(ctx.store.get('1'), poll)
    assert.equal(ctx.store.get(1), poll, 'a numeric id must find the string id')
    assert.equal(ctx.store.get('999'), undefined)
  } finally {
    await ctx.cleanup()
  }
})

test('add drops blank and duplicate options before counting', async () => {
  const ctx = await makeStore()
  try {
    const poll = ctx.store.add({ chatId: 1, question: 'Куда?', options: [' Дача ', '', 'Дача', 'Море', '   '] })
    assert.deepEqual(poll.options.map((option) => option.text), ['Дача', 'Море'])
    // Junk is dropped rather than rejected, but it still does not count towards
    // the limit: 11 raw options with one duplicate are 10 real ones.
    const ten = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'a']
    assert.deepEqual(ctx.store.add({ chatId: 1, question: 'Много', options: ten }).options.map((o) => o.text), ten.slice(0, 10))
  } finally {
    await ctx.cleanup()
  }
})

test('add refuses a blank question and creates nothing', async () => {
  const ctx = await makeStore()
  try {
    assert.equal(ctx.store.add({ chatId: 1, question: '', options: ['a', 'b'] }), undefined)
    assert.equal(ctx.store.add({ chatId: 1, question: '   \n ', options: ['a', 'b'] }), undefined)
    assert.equal(ctx.store.add({ chatId: 1, options: ['a', 'b'] }), undefined)
    assert.deepEqual(ctx.store.list(), [])
  } finally {
    await ctx.cleanup()
  }
})

test('add refuses one option and eleven options', async () => {
  const ctx = await makeStore()
  try {
    assert.equal(ctx.store.add({ chatId: 1, question: 'x', options: ['один'] }), undefined)
    assert.equal(ctx.store.add({ chatId: 1, question: 'x', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'] }), undefined)
    assert.equal(ctx.store.add({ chatId: 1, question: 'x', options: [] }), undefined)
    assert.equal(ctx.store.add({ chatId: 1, question: 'x', options: 'не массив' }), undefined)
    assert.deepEqual(ctx.store.list(), [])
  } finally {
    await ctx.cleanup()
  }
})

test('add refuses a question longer than 200 and an option longer than 60', async () => {
  const ctx = await makeStore()
  try {
    assert.equal(ctx.store.add({ chatId: 1, question: 'a'.repeat(MAX_QUESTION_LENGTH + 1), options: ['a', 'b'] }), undefined)
    // The boundary itself is still accepted.
    assert.equal(ctx.store.add({ chatId: 1, question: 'a'.repeat(MAX_QUESTION_LENGTH), options: ['a', 'b'] }).question.length, MAX_QUESTION_LENGTH)
    assert.equal(ctx.store.add({ chatId: 1, question: 'x', options: ['a'.repeat(MAX_OPTION_LENGTH + 1), 'b'] }), undefined)
    assert.equal(ctx.store.add({ chatId: 1, question: 'x', options: ['a'.repeat(MAX_OPTION_LENGTH), 'b'] }).options[0].text.length, MAX_OPTION_LENGTH)
    assert.equal(ctx.store.list().length, 2)
  } finally {
    await ctx.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Store: persistence
// ---------------------------------------------------------------------------

test('flush writes the file atomically and leaves no temporary behind', async () => {
  const ctx = await makeStore()
  try {
    ctx.store.add({ chatId: 1, question: 'Куда?', options: ['Дача', 'Море'] })
    await ctx.store.flush()
    const parsed = JSON.parse(await fs.readFile(ctx.file, 'utf8'))
    assert.equal(parsed.version, 1)
    assert.equal(parsed.nextId, 2)
    assert.equal(parsed.polls.length, 1)
    assert.equal(parsed.polls[0].question, 'Куда?')
    assert.deepEqual(parsed.polls[0].options, [{ text: 'Дача', votes: [] }, { text: 'Море', votes: [] }])
    await assert.rejects(fs.access(`${ctx.file}.tmp`), 'the temporary file must be renamed away')
  } finally {
    await ctx.cleanup()
  }
})

test('flush + load round-trips polls, votes, a close mark and the id counter', async () => {
  const ctx = await makeStore()
  try {
    const created = ctx.store.add({ chatId: 5, userId: 1, question: 'Куда?', options: ['Дача', 'Море'] })
    ctx.store.vote(created.id, 11, 1)
    ctx.store.close(created.id)
    await ctx.store.flush()

    const reopened = new PollStore({ file: ctx.file, logger: silentLogger })
    await reopened.load()
    assert.deepEqual(reopened.list(), ctx.store.list())
    assert.deepEqual(reopened.get('1').options[1].votes, [11])
    assert.ok(reopened.get('1').closedAt, 'the close mark must survive a restart')
    assert.equal(reopened.nextId, 2)

    const next = reopened.add({ chatId: 5, question: 'Ещё?', options: ['a', 'b'] })
    assert.equal(next.id, '2', 'a new poll must not reuse an old id')
    assert.equal(reopened.nextId, 3)
  } finally {
    await ctx.cleanup()
  }
})

test('a corrupt file is ignored and replaced by the next flush', async () => {
  const ctx = await makeStore()
  try {
    await fs.writeFile(ctx.file, '{ это не json', 'utf8')
    const store = new PollStore({ file: ctx.file, logger: silentLogger })
    await store.load()
    assert.deepEqual(store.list(), [])
    assert.equal(store.nextId, 1)

    store.add({ chatId: 1, question: 'после сбоя', options: ['a', 'b'] })
    await store.flush()
    const parsed = JSON.parse(await fs.readFile(ctx.file, 'utf8'))
    assert.equal(parsed.version, 1)
    assert.equal(parsed.polls.length, 1)
    assert.equal(parsed.polls[0].question, 'после сбоя')
  } finally {
    await ctx.cleanup()
  }
})

test('load keeps only records that match the stored shape', async () => {
  const ctx = await makeStore()
  try {
    const good = makePoll({ id: '1', options: [{ text: 'a', votes: [7] }, { text: 'b', votes: [] }] })
    await fs.writeFile(ctx.file, JSON.stringify({
      version: 1,
      nextId: 5,
      polls: [
        good,
        { id: 2, chatId: 1, question: 'x', options: [], createdAt: CREATED_AT },
        { ...good, id: '3', options: [{ text: 'только один', votes: [] }] },
        null,
        { ...good, id: '4', options: [{ text: 'a', votes: 'нет' }, { text: 'b', votes: [] }] },
      ],
    }), 'utf8')

    const store = new PollStore({ file: ctx.file, logger: silentLogger })
    await store.load()
    assert.deepEqual(store.list().map((poll) => poll.id), ['1'])
    assert.equal(store.nextId, 5, 'the stored nextId wins')
  } finally {
    await ctx.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Store: voting
// ---------------------------------------------------------------------------

test('the first vote is recorded and reported as changed', async () => {
  const ctx = await makeStore()
  try {
    const poll = ctx.store.add({ chatId: 1, question: 'x', options: ['Дача', 'Море'] })
    const outcome = ctx.store.vote(poll.id, 7, 0)
    assert.equal(outcome.poll, poll)
    assert.equal(outcome.changed, true)
    assert.equal(outcome.previousIndex, -1, 'no previous vote is -1')
    assert.deepEqual(poll.options[0].votes, [7])
    assert.deepEqual(poll.options[1].votes, [])
    assert.equal(ctx.store.voteIndexOf(poll, 7), 0)
  } finally {
    await ctx.cleanup()
  }
})

test('a tap on another option moves the vote instead of adding a second one', async () => {
  const ctx = await makeStore()
  try {
    const poll = ctx.store.add({ chatId: 1, question: 'x', options: ['Дача', 'Море'] })
    ctx.store.vote(poll.id, 7, 0)
    const outcome = ctx.store.vote(poll.id, 7, 1)
    assert.equal(outcome.changed, true)
    assert.equal(outcome.previousIndex, 0)
    assert.deepEqual(poll.options[0].votes, [], 'the old vote must be gone')
    assert.deepEqual(poll.options[1].votes, [7])
    assert.equal(poll.options[0].votes.length + poll.options[1].votes.length, 1, 'one person, one vote')
  } finally {
    await ctx.cleanup()
  }
})

test('a repeated tap on the same option changes nothing', async () => {
  const ctx = await makeStore()
  try {
    const poll = ctx.store.add({ chatId: 1, question: 'x', options: ['Дача', 'Море'] })
    ctx.store.vote(poll.id, 7, 1)
    const outcome = ctx.store.vote(poll.id, 7, 1)
    assert.equal(outcome.changed, false)
    assert.equal(outcome.previousIndex, 1)
    assert.deepEqual(poll.options[1].votes, [7], 'the vote must not be duplicated')
  } finally {
    await ctx.cleanup()
  }
})

test('a vote in a closed poll is refused and changes nothing', async () => {
  const ctx = await makeStore()
  try {
    const poll = ctx.store.add({ chatId: 1, question: 'x', options: ['Дача', 'Море'] })
    ctx.store.vote(poll.id, 7, 0)
    ctx.store.close(poll.id)

    const moved = ctx.store.vote(poll.id, 7, 1)
    assert.equal(moved.changed, false, 'a closed poll comes back as changed: false')
    assert.equal(moved.previousIndex, 0)
    const fresh = ctx.store.vote(poll.id, 8, 0)
    assert.equal(fresh.changed, false, 'a newcomer cannot vote after the close')
    assert.deepEqual(poll.options[0].votes, [7])
    assert.deepEqual(poll.options[1].votes, [])
    assert.equal(ctx.store.vote(poll.id, 8, 0).poll, poll)
  } finally {
    await ctx.cleanup()
  }
})

test('vote returns undefined for an unknown poll and refuses a bad index', async () => {
  const ctx = await makeStore()
  try {
    const poll = ctx.store.add({ chatId: 1, question: 'x', options: ['Дача', 'Море'] })
    assert.equal(ctx.store.vote('999', 7, 0), undefined)

    for (const index of [-1, 2, 1.5, undefined, '1', NaN]) {
      const outcome = ctx.store.vote(poll.id, 7, index)
      assert.equal(outcome.changed, false, `index ${String(index)} must not count`)
      assert.equal(outcome.previousIndex, -1)
    }
    assert.deepEqual(poll.options.flatMap((option) => option.votes), [])

    // A vote without a user is meaningless and must not be stored either.
    assert.equal(ctx.store.vote(poll.id, undefined, 0).changed, false)
    assert.deepEqual(poll.options[0].votes, [])
  } finally {
    await ctx.cleanup()
  }
})

test('numeric and string forms of a user id are one voter', async () => {
  const ctx = await makeStore()
  try {
    const poll = ctx.store.add({ chatId: 1, question: 'x', options: ['Дача', 'Море'] })
    ctx.store.vote(poll.id, 42, 0)
    const outcome = ctx.store.vote(poll.id, '42', 1)
    assert.equal(outcome.changed, true)
    assert.equal(outcome.previousIndex, 0)
    assert.deepEqual(poll.options[0].votes, [])
    assert.deepEqual(poll.options[1].votes, ['42'])
  } finally {
    await ctx.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Store: close, remove, maxPolls
// ---------------------------------------------------------------------------

test('close marks the poll once, keeps the results and reports a miss', async () => {
  const ctx = await makeStore()
  try {
    const poll = ctx.store.add({ chatId: 1, question: 'x', options: ['Дача', 'Море'] })
    ctx.store.vote(poll.id, 7, 0)
    const closed = ctx.store.close(poll.id)
    assert.equal(closed, poll)
    assert.ok(Number.isFinite(Date.parse(closed.closedAt)), `closedAt ${closed.closedAt}`)
    const stamp = closed.closedAt
    ctx.store.close(poll.id)
    assert.equal(closed.closedAt, stamp, 'closing twice keeps the first moment')
    assert.deepEqual(closed.options[0].votes, [7], 'closing keeps the votes')
    assert.equal(ctx.store.close('999'), undefined)
  } finally {
    await ctx.cleanup()
  }
})

test('remove drops the poll and reports a miss', async () => {
  const ctx = await makeStore()
  try {
    const poll = ctx.store.add({ chatId: 1, question: 'x', options: ['Дача', 'Море'] })
    assert.equal(ctx.store.remove(poll.id), poll)
    assert.equal(ctx.store.get(poll.id), undefined)
    assert.deepEqual(ctx.store.list(), [])
    assert.equal(ctx.store.remove(poll.id), undefined)
  } finally {
    await ctx.cleanup()
  }
})

test('maxPolls evicts the oldest closed polls but keeps the active ones', async () => {
  const ctx = await makeStore({ maxPolls: 3 })
  try {
    const first = ctx.store.add({ chatId: 1, question: 'первый', options: ['a', 'b'] })
    const second = ctx.store.add({ chatId: 1, question: 'второй', options: ['a', 'b'] })
    ctx.store.add({ chatId: 1, question: 'третий', options: ['a', 'b'] })
    ctx.store.close(first.id)
    ctx.store.close(second.id)
    assert.equal(ctx.store.list().length, 3)

    const fourth = ctx.store.add({ chatId: 1, question: 'четвёртый', options: ['a', 'b'] })
    assert.deepEqual(ctx.store.list().map((poll) => poll.id), ['2', '3', '4'], 'the oldest closed poll goes first')
    assert.equal(ctx.store.get(first.id), undefined)
    assert.ok(ctx.store.get(fourth.id), 'the new poll must be there')

    const fifth = ctx.store.add({ chatId: 1, question: 'пятый', options: ['a', 'b'] })
    assert.deepEqual(ctx.store.list().map((poll) => poll.id), ['3', '4', '5'])
    assert.equal(ctx.store.get(second.id), undefined, 'the second closed poll is evicted next')
  } finally {
    await ctx.cleanup()
  }
})

test('active polls are never evicted, even above the cap', async () => {
  const ctx = await makeStore({ maxPolls: 2 })
  try {
    for (const question of ['опрос 0', 'опрос 1', 'опрос 2', 'опрос 3']) {
      ctx.store.add({ chatId: 1, question, options: ['a', 'b'] })
    }
    assert.deepEqual(ctx.store.list().map((poll) => poll.question), ['опрос 0', 'опрос 1', 'опрос 2', 'опрос 3'])
  } finally {
    await ctx.cleanup()
  }
})

test('closing a poll brings an over-cap store back to the cap', async () => {
  const ctx = await makeStore({ maxPolls: 2 })
  try {
    const first = ctx.store.add({ chatId: 1, question: 'первый', options: ['a', 'b'] })
    const second = ctx.store.add({ chatId: 1, question: 'второй', options: ['a', 'b'] })
    ctx.store.close(first.id)
    const third = ctx.store.add({ chatId: 1, question: 'третий', options: ['a', 'b'] })
    assert.deepEqual(ctx.store.list().map((poll) => poll.id), [second.id, third.id])
  } finally {
    await ctx.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

test('the tool creates a poll, returns it and flushes to disk', async () => {
  const ctx = await makeStore()
  const tool = createPollTool({ store: ctx.store })
  try {
    const outcome = await tool.executeDetailed(
      { question: 'Куда едем в выходные?', options: ['Дача', 'Море'] },
      { chatId: 42, userId: 7 },
    )
    assert.match(outcome.text, /Опрос №1 создан/)
    assert.match(outcome.text, /«Куда едем в выходные\?»/)
    assert.match(outcome.text, /Дача/)
    assert.equal(outcome.poll.id, '1')
    assert.equal(outcome.poll.chatId, 42)
    assert.equal(ctx.store.get('1'), outcome.poll)

    const parsed = JSON.parse(await fs.readFile(ctx.file, 'utf8'))
    assert.equal(parsed.polls.length, 1, 'the tool must flush the poll itself')
    assert.equal(parsed.polls[0].question, 'Куда едем в выходные?')
  } finally {
    await ctx.cleanup()
  }
})

test('execute returns the text only', async () => {
  const ctx = await makeStore()
  const tool = createPollTool({ store: ctx.store })
  try {
    const output = await tool.execute({ question: 'Куда?', options: ['Дача', 'Море'] }, { chatId: 1 })
    assert.equal(typeof output, 'string')
    assert.match(output, /Опрос №1 создан/)
  } finally {
    await ctx.cleanup()
  }
})

test('the tool refuses invalid input without creating anything', async () => {
  const ctx = await makeStore()
  const tool = createPollTool({ store: ctx.store })
  try {
    const cases = [
      [{ question: '', options: ['a', 'b'] }, /нужен вопрос/],
      [{ question: '   ', options: ['a', 'b'] }, /нужен вопрос/],
      [{ question: 'a'.repeat(MAX_QUESTION_LENGTH + 1), options: ['a', 'b'] }, /длиннее 200/],
      [{ question: 'x', options: ['только один'] }, /от 2 до 10/],
      [{ question: 'x', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'] }, /от 2 до 10/],
      [{ question: 'x', options: ['a'.repeat(MAX_OPTION_LENGTH + 1), 'b'] }, /длиннее 60/],
      [{ question: 'x' }, /от 2 до 10/],
    ]
    for (const [args, pattern] of cases) {
      const output = await tool.execute(args, { chatId: 1 })
      assert.match(output, /Ошибка инструмента poll/, JSON.stringify(args))
      assert.match(output, pattern, JSON.stringify(args))
    }
    assert.deepEqual(ctx.store.list(), [], 'a refused poll must not be stored')
  } finally {
    await ctx.cleanup()
  }
})

test('the tool reports a missing chat instead of creating a poll', async () => {
  const ctx = await makeStore()
  const tool = createPollTool({ store: ctx.store })
  try {
    assert.match(await tool.execute({ question: 'x', options: ['a', 'b'] }, {}), /не удалось определить чат/)
    assert.match(await tool.execute({ question: 'x', options: ['a', 'b'] }), /не удалось определить чат/)
    assert.deepEqual(ctx.store.list(), [])
  } finally {
    await ctx.cleanup()
  }
})

test('the tool definition is valid', async () => {
  const { definition } = createPollTool({ store: null })
  assert.equal(definition.type, 'function')
  assert.equal(definition.function.name, 'poll')
  assert.match(definition.function.description, /опрос/i)
  assert.match(definition.function.description, /голосован/i)
  assert.equal(definition.function.parameters.type, 'object')
  assert.deepEqual(definition.function.parameters.required, ['question', 'options'])
  assert.equal(definition.function.parameters.properties.question.type, 'string')
  assert.equal(definition.function.parameters.properties.options.type, 'array')
  assert.equal(definition.function.parameters.properties.options.items.type, 'string')
  assert.equal(definition.function.parameters.additionalProperties, false)
})

test('the tool dedupes and trims options through the store', async () => {
  const ctx = await makeStore()
  const tool = createPollTool({ store: ctx.store })
  try {
    const outcome = await tool.executeDetailed(
      { question: '  Куда?  ', options: [' Дача ', '', 'Дача', 'Море'] },
      { chatId: 1, userId: 7 },
    )
    assert.equal(outcome.poll.question, 'Куда?')
    assert.deepEqual(outcome.poll.options.map((option) => option.text), ['Дача', 'Море'])
  } finally {
    await ctx.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

test('pollMessage shows counts, percentages and the names of the voters', async () => {
  const poll = makePoll({
    question: 'Куда едем в выходные?',
    options: [
      { text: 'Дача', votes: [1, 2, 3] },
      { text: 'Море', votes: [4] },
    ],
  })
  const text = pollMessage(poll, { names: { 1: 'Аня', 2: 'Борис', 3: 'Вера', 4: 'Гриша' } })
  assert.match(text, /Куда едем в выходные\?/)
  assert.match(text, /1\. Дача — 3 \(75%\): Аня, Борис, Вера/)
  assert.match(text, /2\. Море — 1 \(25%\): Гриша/)
  assert.match(text, /Всего проголосовало: 4/)
})

test('pollMessage says nobody voted instead of dividing by zero', async () => {
  const text = pollMessage(makePoll({ options: ['Дача', 'Море'] }))
  assert.match(text, /Пока никто не голосовал\./)
  assert.match(text, /1\. Дача — 0/)
  assert.doesNotMatch(text, /%/, 'no percentage without voters')
  assert.doesNotMatch(text, /Всего проголосовало/)
})

test('pollMessage rounds a tie to 50% and keeps a lone vote at 100%', async () => {
  const tie = pollMessage(makePoll({ options: [{ text: 'A', votes: [1] }, { text: 'B', votes: [2] }] }))
  assert.equal((tie.match(/50%/g) ?? []).length, 2)
  const lone = pollMessage(makePoll({ options: [{ text: 'A', votes: [1, 2] }, { text: 'B', votes: [] }] }))
  assert.match(lone, /A — 2 \(100%\)/)
  assert.match(lone, /B — 0 \(0%\)/)
})

test('pollMessage counts people, not stored votes', async () => {
  // An adversarial record with the same person in both lists must still add up
  // to 100%: the denominator is the number of distinct voters.
  const poll = makePoll({ options: [{ text: 'A', votes: [7] }, { text: 'B', votes: [7] }] })
  const text = pollMessage(poll, { names: { 7: 'Аня' } })
  assert.match(text, /Всего проголосовало: 1/)
  assert.equal((text.match(/100%/g) ?? []).length, 2)
})

test('pollMessage marks a closed poll and falls back to the id without a name', async () => {
  const text = pollMessage(makePoll({
    options: [{ text: 'A', votes: [7] }, { text: 'B', votes: [] }],
    closedAt: CREATED_AT,
  }))
  assert.match(text, /Опрос закрыт\./)
  assert.match(text, /A — 1 \(100%\): 7/)
})

test('pollMessage returns an empty string without a poll', () => {
  assert.equal(pollMessage(undefined), '')
  assert.equal(pollMessage(null), '')
  assert.equal(pollMessage({ question: 'x' }), '')
})

test('pollKeyboard maps every option to a neutral button', () => {
  const poll = makePoll({ id: '3', options: ['Дача', 'Море'] })
  assert.deepEqual(pollKeyboard(poll), {
    rows: [
      [{ text: 'Дача', data: 'poll:3:0' }],
      [{ text: 'Море', data: 'poll:3:1' }],
    ],
  })
  assert.equal(pollKeyboard(poll, { prefix: 'vote' }).rows[0][0].data, 'vote:3:0')
})

test('pollKeyboard is undefined for a closed or a missing poll', () => {
  assert.equal(pollKeyboard(makePoll({ options: ['a', 'b'], closedAt: CREATED_AT })), undefined)
  assert.equal(pollKeyboard(undefined), undefined)
  assert.equal(pollKeyboard(null), undefined)
})

test('pollKeyboard and parsePollAction round-trip', () => {
  const keyboard = pollKeyboard(makePoll({ id: '12', options: ['a', 'b', 'c'] }))
  assert.equal(keyboard.rows.length, 3)
  keyboard.rows.forEach((row, index) => {
    assert.deepEqual(parsePollAction(row[0].data), { id: '12', optionIndex: index })
  })
})

test('pollResultsLine is one line of counts', () => {
  const line = pollResultsLine(makePoll({
    question: 'Куда едем?',
    options: [{ text: 'Дача', votes: [1, 2, 3] }, { text: 'Море', votes: [4] }],
  }))
  assert.equal(line, 'опрос «Куда едем?»: Дача — 3, Море — 1')
  assert.equal(pollResultsLine(undefined), undefined)
})

test('POLL_HINT points the model at the tool and its limits', () => {
  assert.match(POLL_HINT, /poll/)
  assert.match(POLL_HINT, /опрос/i)
  assert.match(POLL_HINT, /от 2 до 10/)
})

// ---------------------------------------------------------------------------
// parsePollAction
// ---------------------------------------------------------------------------

test('parsePollAction parses a well-formed payload', () => {
  assert.deepEqual(parsePollAction('poll:12:3'), { id: '12', optionIndex: 3 })
  assert.deepEqual(parsePollAction('poll:1:0'), { id: '1', optionIndex: 0 })
  assert.deepEqual(parsePollAction('vote:2:1', { prefix: 'vote' }), { id: '2', optionIndex: 1 })
})

test('parsePollAction rejects garbage', () => {
  const garbage = [
    '', 'poll', 'poll:', 'poll:1', 'poll:1:', 'poll::1', 'poll:abc:1', 'poll:1:abc',
    'cancel:1:0', 'poll:1:2:3', 'poll:1:-1', 'poll:-1:0', 'poll:0:1', 'poll:01:1',
    'poll:1:01', 'poll:1:1.5', 'poll:1: 1', 'poll:1:1 ', 'vote:1:1', 'poll:1:99999999999999999999',
    null, undefined, 42, {}, ['poll', '1', '1'],
  ]
  for (const data of garbage) {
    assert.equal(parsePollAction(data), undefined, `data ${JSON.stringify(data)}`)
  }
})

test('parsePollAction accepts a custom prefix only when asked for it', () => {
  assert.equal(parsePollAction('vote:2:1'), undefined)
  assert.deepEqual(parsePollAction('vote:2:1', { prefix: 'vote' }), { id: '2', optionIndex: 1 })
})
