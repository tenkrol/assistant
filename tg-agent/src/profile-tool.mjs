/**
 * The `remember` tool: the model's way to keep a durable fact about the user.
 *
 * It is deliberately narrow — one short statement, plus an optional city that
 * becomes the default for weather. Everything the model may forget between two
 * conversations has to pass through here.
 */

/** OpenAI-compatible tool definition. */
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
 * Build the tool.
 *
 * @param {object} options - dependencies.
 * @param {import('./profiles.mjs').ProfileStore} options.store - profile storage.
 * @param {object} [options.logger] - logger.
 * @returns {{definition: object, execute: (args: object, context: {userId: number|string}) => Promise<string>}}
 */
export function createProfileTool({ store, logger }) {
  return {
    definition: REMEMBER_TOOL_DEFINITION,
    /**
     * Store one fact for one user.
     *
     * @param {object} args - `text` and optional `city`.
     * @param {{userId: number|string}} context - who the fact belongs to.
     * @returns {Promise<string>} text for the model; never throws.
     */
    async execute({ text, city } = {}, { userId } = {}) {
      try {
        if (userId === undefined || userId === null) return 'Ошибка инструмента remember: не удалось определить пользователя.'
        // The city is validated first: storing the fact and only then failing on
        // the city would leave a fact in memory that never reaches the file.
        const cityValue = city == null ? '' : String(city).trim()
        if (cityValue.length > 80) return 'Ошибка инструмента remember: слишком длинное название города.'
        const { fact, duplicate } = store.addFact(userId, text)
        const lines = [duplicate ? `Уже помню (№${fact.id}): «${fact.text}».` : `Запомнил (№${fact.id}): «${fact.text}».`]
        if (cityValue !== '') {
          const { city: saved, changed } = store.setCity(userId, cityValue)
          lines.push(changed ? `Город по умолчанию — ${saved}.` : `Город по умолчанию уже ${saved}.`)
        }
        await store.flush()
        logger?.info('profile updated', { userId, duplicate, hasCity: cityValue !== '' })
        return lines.join(' ')
      } catch (error) {
        return `Ошибка инструмента remember: ${error.message}`
      }
    },
  }
}
