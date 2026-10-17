/**
 * Инструмент `remember`: способ модели сохранить долгий факт о пользователе.
 *
 * Он намеренно узкий — одна короткая фраза и необязательный город, который
 * становится городом по умолчанию для погоды. Все проверки и тексты живут в
 * домене профилей; здесь остаётся описание инструмента и тонкая обвязка.
 */
import { rulesOfProfiles } from './domain/profiles.mjs'

/** Описание инструмента в формате OpenAI. */
export const REMEMBER_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'remember',
    description:
      'Запомнить факт о пользователе надолго: имя, город, профессию, предпочтения, важные обстоятельства. '
      + 'Вызывай, когда пользователь сообщает о себе что-то, что стоит помнить в будущих разговорах '
      + '(«меня зовут Андрей», «я живу в Казани», «я вегетарианец»). '
      + 'Не вызывай для разовых поручений и для того, что уже есть в известных фактах.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Факт одной короткой фразой от третьего лица, например «его зовут Андрей» или «живёт в Казани».',
        },
        city: {
          type: 'string',
          description: 'Заполни, только если пользователь назвал свой город: он станет городом по умолчанию для погоды.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
}

/**
 * Собрать инструмент памяти.
 *
 * @param {object} options - зависимости.
 * @param {import('./profiles.mjs').ProfileStore} options.store - хранилище профилей.
 * @param {object} [options.logger] - логгер.
 * @returns {{definition: object, execute: (args: object, context: {userId: number|string}) => Promise<string>}}
 */
export function createProfileTool({ store, logger }) {
  const rules = rulesOfProfiles({ store, logger })

  return {
    definition: REMEMBER_TOOL_DEFINITION,

    /**
     * Сохранить один факт для одного пользователя.
     *
     * @param {object} args - `text` и необязательный `city`.
     * @param {{userId: number|string}} context - чей это факт.
     * @returns {Promise<string>} текст для модели; не бросает исключений.
     */
    async execute(args = {}, context = {}) {
      return rules.remember(args, context)
    },
  }
}
