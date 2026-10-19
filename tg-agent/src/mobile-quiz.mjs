/**
 * Ежедневный опрос для памяти: 10 вопросов на день, ответы уходят в профиль.
 *
 * Вопросы генерирует модель; если модель недоступна — используется локальный
 * набор, чтобы раздел не ломался. День считается по московскому времени.
 */
import crypto from 'node:crypto'
import { createJsonStore } from './storage/json-store.mjs'

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000
const QUESTIONS_PER_DAY = 10
const MAX_ANSWER = 1000

const FALLBACK = [
  'Что тебе сейчас нравится делать в свободное время?',
  'Какая еда или напиток тебя радуют больше всего?',
  'Что помогает тебе отдохнуть после сложного дня?',
  'Какой фильм, сериал или книга запомнились за последнее время?',
  'Куда хочется поехать в следующем отпуске?',
  'Что для тебя важно в близких людях?',
  'Какая привычка помогает тебе в работе?',
  'Что ты недавно узнал нового и хочешь запомнить?',
  'Какая мелочь может улучшить твой обычный день?',
  'Что бы ты хотел попробовать в ближайший месяц?',
]

export const quizDate = (now = new Date()) => new Date(now.getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10)

export class QuizStore {
  constructor({ file, logger } = {}) {
    this.logger = logger
    this.storage = createJsonStore({ file, version: 1, defaults: { users: {} }, logger })
  }

  async load() {
    await this.storage.load()
    if (!this.storage.state.users || typeof this.storage.state.users !== 'object') this.storage.state.users = {}
    return this
  }

  get(userId, date = quizDate()) {
    return this.storage.state.users[String(userId)]?.[date]
  }

  previous(userId, limit = 30) {
    const days = this.storage.state.users[String(userId)] ?? {}
    return Object.values(days).flatMap((day) => day.questions.map((question) => question.text)).slice(-limit)
  }

  async ensure({ userId, date = quizDate(), generate } = {}) {
    const existing = this.get(userId, date)
    if (existing) return existing
    let texts = []
    try {
      const result = await generate?.({ previous: this.previous(userId) })
      if (Array.isArray(result)) texts = result
    } catch (error) {
      this.logger?.warn?.('quiz generation failed', { error: error?.message ?? error })
    }
    texts = texts.map((text) => String(text ?? '').trim()).filter((text) => text.length >= 5).slice(0, QUESTIONS_PER_DAY)
    for (const fallback of FALLBACK) {
      if (texts.length >= QUESTIONS_PER_DAY) break
      if (!texts.includes(fallback)) texts.push(fallback)
    }
    const day = {
      date,
      createdAt: new Date().toISOString(),
      questions: texts.slice(0, QUESTIONS_PER_DAY).map((text) => ({ id: crypto.randomUUID(), text })),
      answers: {},
    }
    this.storage.state.users[String(userId)] = { ...(this.storage.state.users[String(userId)] ?? {}), [date]: day }
    await this.storage.flush()
    return day
  }

  async answer({ userId, questionId, text, date = quizDate() } = {}) {
    const day = this.get(userId, date)
    if (!day) throw new Error('Опрос на сегодня ещё не создан')
    const value = String(text ?? '').trim()
    if (value === '' || value.length > MAX_ANSWER) throw new Error('Некорректный ответ')
    const question = day.questions.find((item) => String(item.id) === String(questionId))
    if (!question) throw new Error('Вопрос не найден')
    day.answers[questionId] = value
    day.updatedAt = new Date().toISOString()
    await this.storage.flush()
    return { question, answer: value }
  }
}

export { QUESTIONS_PER_DAY, MAX_ANSWER }
