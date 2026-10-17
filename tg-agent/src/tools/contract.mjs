/**
 * Единый контракт инструмента модели.
 *
 * Любой инструмент отдаёт три вещи:
 *   - `definition` — JSON-схема в формате OpenAI, её видит модель;
 *   - `executeDetailed(args, context)` — объект с полем `text` и данными
 *     результата (напоминание, файл, опрос, видео и т. п.);
 *   - `execute(args, context)` — строка с тем же текстом.
 *
 * `executeDetailed` никогда не бросает исключений наружу: ошибка аргументов или
 * внутреннего вызова становится понятным текстом для модели. Это осознанно:
 * один неудачный инструмент не должен ломать весь ход диалога.
 */

/**
 * Собрать инструмент по единому контракту.
 *
 * Можно передать только `execute` (старый стиль), только `executeDetailed` или
 * оба сразу. Если переданы оба, `execute` контракта всё равно берёт текст из
 * `executeDetailed`, чтобы у модели и у ядра не было двух разных ответов.
 *
 * @param {object} options - описание инструмента.
 * @param {object} options.definition - схема для модели.
 * @param {(args: object, context: object) => Promise<object|string>} [options.executeDetailed] - подробное выполнение.
 * @param {(args: object, context: object) => Promise<string>} [options.execute] - выполнение, возвращающее текст.
 * @param {string} [options.name] - имя для сообщений об ошибках; по умолчанию из схемы.
 * @returns {{definition: object, executeDetailed: Function, execute: Function}} инструмент.
 */
export function createTool({ definition, executeDetailed, execute, name } = {}) {
  if (!definition || typeof definition !== 'object') {
    throw new Error('инструмент: нужна definition')
  }
  const toolName = name ?? definition.function?.name
  if (!toolName) throw new Error('инструмент: у definition нет function.name')

  /**
   * Выполнить инструмент и привести результат к объекту с текстом.
   *
   * @param {object} [args] - аргументы от модели.
   * @param {object} [context] - чат, пользователь и служебные поля.
   * @returns {Promise<{text: string, [key: string]: unknown}>} результат.
   */
  const detailed = async (args = {}, context = {}) => {
    try {
      let result
      if (typeof executeDetailed === 'function') {
        result = await executeDetailed(args, context)
      } else if (typeof execute === 'function') {
        result = await execute(args, context)
      } else {
        result = undefined
      }
      if (typeof result === 'string') return { text: result }
      if (result && typeof result === 'object' && typeof result.text === 'string') return result
      return { text: `Ошибка инструмента ${toolName}: пустой результат.` }
    } catch (error) {
      return { text: `Ошибка инструмента ${toolName}: ${error?.message ?? error}` }
    }
  }

  return {
    definition,
    executeDetailed: detailed,
    execute: async (args = {}, context = {}) => (await detailed(args, context)).text,
  }
}

/**
 * Обернуть готовый объект инструмента единым контрактом.
 *
 * Нужен реестру: инструмент может прийти из старого модуля или из теста, где
 * есть только `{ definition, execute }`.
 *
 * @param {object} tool - `{ definition, execute?, executeDetailed? }`.
 * @returns {{definition: object, executeDetailed: Function, execute: Function}} инструмент.
 */
export function asTool(tool) {
  if (!tool || typeof tool !== 'object' || !tool.definition) {
    throw new Error('инструмент: нужна definition')
  }
  return createTool({
    definition: tool.definition,
    ...(typeof tool.executeDetailed === 'function' ? { executeDetailed: (args, context) => tool.executeDetailed(args, context) } : {}),
    ...(typeof tool.execute === 'function' ? { execute: (args, context) => tool.execute(args, context) } : {}),
  })
}
