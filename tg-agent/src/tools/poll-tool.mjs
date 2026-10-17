/**
 * Инструмент `poll`: модель создаёт опрос, бот рисует кнопки и считает голоса.
 *
 * Правила опроса и тексты живут в домене `src/domain/polls.mjs`; здесь только
 * описание для модели и тонкая обвязка над `rulesOfPolls`.
 */
import { rulesOfPolls } from '../domain/polls.mjs'
import { createTool } from './contract.mjs'

/** Описание инструмента в формате OpenAI. */
export const POLL_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'poll',
    description:
      'Создать опрос (голосование) в этом чате с кнопками-вариантами. Вызывай, когда просят опрос или голосование '
      + '(«создай опрос», «спросим у всех», «проголосуем», «куда едем в выходные?»). '
      + 'Кнопки и подсчёт голосов бот берёт на себя: не описывай варианты текстом и не считай голоса сам.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Вопрос опроса, до 200 символов. Например: «Куда едем в выходные?».' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'От 2 до 10 разных вариантов ответа, каждый до 60 символов.',
        },
      },
      required: ['question', 'options'],
      additionalProperties: false,
    },
  },
}

/** Короткая подсказка для системной инструкции модели. */
export const POLL_HINT =
  'Опросы: когда просят «создай опрос», «спросим у всех» или «проголосуем», вызывай инструмент poll '
  + '(question — вопрос до 200 символов, options — от 2 до 10 разных вариантов до 60 символов). '
  + 'Кнопки и подсчёт голосов бот делает сам; повторное нажатие переносит голос, а не добавляет второй.'

/**
 * Собрать инструмент `poll`.
 *
 * @param {object} options - параметры инструмента.
 * @param {import('../polls.mjs').PollStore} options.store - хранилище опросов.
 * @returns {{definition: object, executeDetailed: Function, execute: Function}} инструмент.
 */
export function createPollTool({ store }) {
  const rules = rulesOfPolls({ store })

  // Боту нужен весь опрос, чтобы отправить сообщение и кнопки; модель видит
  // только текст подтверждения или ошибки.
  return createTool({
    definition: POLL_TOOL_DEFINITION,
    executeDetailed: (args, context) => rules.create(args, context),
  })
}
