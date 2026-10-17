/**
 * Домен опросов без платформы и сети.
 *
 * Проверяются инварианты: один голос на человека (повторный заменяет), закрытый
 * опрос голосов не принимает, а тексты и кнопки остаются прежними.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  castVote,
  parsePollAction,
  pollKeyboard,
  pollMessage,
  pollResultsLine,
  rulesOfPolls,
  voterCount,
} from '../src/domain/polls.mjs'

/** Хранилище опросов в памяти: та же форма записи, что у настоящего стора. */
function makePollStore() {
  const polls = []
  let nextId = 1
  let flushes = 0
  const store = {
    polls,
    get flushes() {
      return flushes
    },
    get(id) {
      return polls.find((poll) => poll.id === String(id))
    },
    add({ chatId, userId, question, options }) {
      const poll = {
        id: String(nextId++),
        chatId,
        ...(userId === undefined ? {} : { userId }),
        question: String(question).trim(),
        options: options.map((text) => ({ text, votes: [] })),
        createdAt: new Date().toISOString(),
      }
      polls.push(poll)
      return poll
    },
    vote(id, userId, optionIndex) {
      return castVote(this.get(id), userId, optionIndex)
    },
    async flush() {
      flushes++
    },
  }
  return store
}

/** Опрос-заготовка для чистых проверок. */
const makePoll = (options = ['Лес', 'Река']) => ({
  id: '1',
  chatId: 1,
  question: 'Куда едем?',
  options: options.map((text) => ({ text, votes: [] })),
  createdAt: '2026-10-06T09:00:00.000Z',
})

test('повторный голос заменяет прежний, а не добавляет второй', () => {
  const poll = makePoll()
  const first = castVote(poll, 7, 0)
  assert.equal(first.changed, true)
  assert.deepEqual(poll.options.map((option) => option.votes), [[7], []])

  const moved = castVote(poll, 7, 1)
  assert.equal(moved.changed, true)
  assert.equal(moved.previousIndex, 0)
  assert.deepEqual(poll.options.map((option) => option.votes), [[], [7]], 'голос перенесён')
  assert.equal(voterCount(poll), 1, 'счётчик остаётся целым')
})

test('число и строка с тем же id — один человек', () => {
  const poll = makePoll()
  castVote(poll, 7, 0)
  const same = castVote(poll, '7', 0)
  assert.equal(same.changed, false, 'повтор того же варианта ничего не меняет')
  assert.equal(voterCount(poll), 1)
})

test('закрытый опрос голосов не принимает и не меняется', () => {
  const poll = makePoll()
  poll.closedAt = '2026-10-06T10:00:00.000Z'
  const result = castVote(poll, 7, 0)
  assert.equal(result.changed, false)
  assert.deepEqual(poll.options.map((option) => option.votes), [[], []])
})

test('неизвестный вариант и пустой пользователь отклоняются без изменений', () => {
  const poll = makePoll()
  assert.equal(castVote(poll, 7, 5).changed, false)
  assert.equal(castVote(poll, 7, -1).changed, false)
  assert.equal(castVote(poll, undefined, 0).changed, false)
  assert.equal(castVote(poll, 7, 0).changed, true)
})

test('правила голосования возвращают прежние всплывающие тексты', async () => {
  const store = makePollStore()
  store.add({ chatId: 1, userId: 1, question: 'Куда едем?', options: ['Лес', 'Река'] })
  const rules = rulesOfPolls({ store })

  const voted = await rules.vote('1', 7, 0)
  assert.equal(voted.toast, 'Голос учтён')
  assert.equal(voted.changed, true)
  assert.equal(voted.poll.options[0].votes.length, 1)

  const again = await rules.vote('1', 7, 0)
  assert.equal(again.toast, 'Вы уже голосовали так')
  assert.equal(again.changed, false)

  store.get('1').closedAt = new Date().toISOString()
  const closed = await rules.vote('1', 8, 1)
  assert.equal(closed.toast, 'Опрос уже закрыт')
  assert.deepEqual(store.get('1').options.map((option) => option.votes), [[7], []])

  const missing = await rules.vote('99', 7, 0)
  assert.equal(missing.toast, 'Опрос уже закрыт')
  assert.equal(await store.flushes, 0, 'запись после голоса — забота ядра, порядок правки сохранён')
})

test('создание опроса проверяет вопрос и варианты прежними фразами', async () => {
  const store = makePollStore()
  const rules = rulesOfPolls({ store })

  const created = await rules.create({ question: '  Куда?  ', options: [' Лес ', 'Река', 'Лес'] }, { chatId: 1, userId: 1 })
  assert.match(created.text, /^Опрос №1 создан: «Куда\?»/)
  assert.match(created.text, /Варианты: 1\) Лес, 2\) Река/)
  assert.equal(created.poll.options.length, 2)
  assert.equal(store.polls.length, 1)
  assert.equal(await store.flushes, 1)

  const bad = await rules.create({ question: 'Куда?', options: ['Лес'] }, { chatId: 1 })
  assert.match(bad.text, /нужно от 2 до 10 разных непустых вариантов/)
  const long = await rules.create({ question: 'Куда?', options: ['Лес', 'я'.repeat(61)] }, { chatId: 1 })
  assert.match(long.text, /длиннее 60 символов/)
  assert.equal(store.polls.length, 1, 'неудачный ввод ничего не создаёт')
})

test('текст опроса считает проценты по числу людей и показывает закрытие', () => {
  const poll = makePoll(['Лес', 'Река'])
  poll.options[0].votes = [7, 8, 9]
  poll.options[1].votes = [10]
  const text = pollMessage(poll)
  assert.match(text, /1\. Лес — 3 \(75%\)/)
  assert.match(text, /2\. Река — 1 \(25%\)/)
  assert.match(text, /Всего проголосовало: 4\./)

  poll.closedAt = new Date().toISOString()
  assert.match(pollMessage(poll), /Опрос закрыт\./)
  assert.equal(pollKeyboard(poll), undefined, 'после закрытия кнопок нет')
  assert.equal(pollResultsLine(poll), 'опрос «Куда едем?»: Лес — 3, Река — 1')
})

test('кнопка опроса разбирается строго', () => {
  const poll = makePoll()
  assert.deepEqual(parsePollAction(`poll:${poll.id}:1`), { id: '1', optionIndex: 1 })
  assert.equal(parsePollAction('poll:1'), undefined)
  assert.equal(parsePollAction('poll:01:0'), undefined)
  assert.equal(parsePollAction('poll:1:-1'), undefined)
  assert.equal(parsePollAction('other:1:0'), undefined)
  assert.deepEqual(parsePollAction('vote:2:0', { prefix: 'vote' }), { id: '2', optionIndex: 0 })
})
