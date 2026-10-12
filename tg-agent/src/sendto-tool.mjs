/**
 * sendto: написать другому человеку от имени владельца.
 *
 * Telegram не разрешает боту писать как пользователь и не даёт искать людей по
 * телефону, поэтому достижимых адресатов мало, и инструмент говорит прямо, какие
 * именно это случаи:
 *
 *   - `@ник` — каналы и группы всегда; человек — если он хоть раз писал боту;
 *   - человек из справочника бота (по имени или id) — те, с кем уже есть переписка;
 *   - телефон — только если человек сам поделился контактом, иначе Telegram
 *     не даёт связать номер с аккаунтом.
 *
 * Первым написать тому, кто не начинал диалог, нельзя ни одним из способов —
 * это ограничение платформы, а не бота. Текст подписывается, потому что сообщение
 * уходит от бота: «От Вячеслава: ...».
 *
 * Модуль ничего не знает о хранилищах: справочник приходит снаружи и обязан уметь
 * `byPhone(phone)`, `search(query)` и `list()`.
 */

const MAX_TEXT = 3500

/** Приводит номер к цифрам: «+7 (999) 123-45-67» и «89991234567» — одно и то же. */
function digits(value) {
  return String(value ?? '').replace(/\D/g, '')
}

/** Номер в вид, по которому сравниваем: последние 10 цифр (без кода страны). */
function phoneKey(value) {
  const all = digits(value)
  return all.length > 10 ? all.slice(-10) : all
}

/**
 * Собрать инструмент.
 *
 * @param {object} options - `send({chatId, text})`, `contacts`, `ownerName`, `logger`.
 * @returns {{definition: object, executeDetailed: Function, execute: Function}} инструмент.
 */
export function createSendToTool({ send, contacts, ownerName = 'владельца', logger } = {}) {
  if (typeof send !== 'function') throw new Error('sendto: нужна функция send')

  const definition = {
    type: 'function',
    function: {
      name: 'sendto',
      description:
        'Написать другому человеку от имени владельца. Работает для каналов и групп по @нику, '
        + 'для людей, с которыми уже есть переписка, и для тех, кто поделился своим контактом. '
        + 'Первым написать незнакомому человеку Telegram не разрешает — инструмент скажет об этом.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Кому: @ник, имя человека из справочника, id или номер телефона.',
          },
          text: { type: 'string', description: 'Текст сообщения без подписи — подпись добавится сама.' },
        },
        required: ['target', 'text'],
      },
    },
  }

  /** Разобрать адресата: ник, id, телефон или имя из справочника. */
  function resolve(target) {
    const value = String(target ?? '').trim()
    if (value === '') return { error: 'не понял, кому писать: укажите @ник, имя, id или телефон.' }

    if (value.startsWith('@')) {
      // Для человека Telegram не принимает @ник: нужен числовой id из справочника.
      // Для каналов и групп ник работает и так.
      const known = contacts?.byUsername?.(value)
      if (known) return { chatId: known.chatId, label: known.name ?? value, how: 'ник из справочника' }
      return { chatId: value, label: value, how: 'ник' }
    }

    const bare = digits(value)
    const looksLikePhone = /^[+()\d\s-]+$/.test(value) && bare.length >= 10 && !/^\d{5,12}$/.test(value)
    if (looksLikePhone) {
      const found = contacts?.byPhone?.(phoneKey(value))
      if (found) return { chatId: found.chatId, label: found.name ?? value, how: 'телефон' }
      return {
        error:
          `номер ${value} мне неизвестен: Telegram не даёт искать людей по телефону. `
          + 'Попросите человека один раз поделиться контактом — тогда я запомню связку '
          + 'и смогу писать ему дальше.',
      }
    }

    if (/^-?\d{4,}$/.test(value)) return { chatId: Number(value), label: value, how: 'id' }

    const matches = contacts?.search?.(value) ?? []
    if (matches.length === 1) return { chatId: matches[0].chatId, label: matches[0].name ?? value, how: 'имя' }
    if (matches.length > 1) {
      const names = matches.map((entry) => entry.name ?? entry.chatId).join(', ')
      return { error: `под «${value}» нашлось несколько человек (${names}). Уточните, кому именно.` }
    }

    const known = (contacts?.list?.() ?? []).map((entry) => entry.name ?? entry.chatId)
    return {
      error: known.length
        ? `не нашёл «${value}» в справочнике. Известные мне люди: ${known.join(', ')}. Можно ещё указать @ник канала или группы.`
        : `не нашёл «${value}». Мне известны только те, кто уже писал боту, и те, кто делился контактом.`,
    }
  }

  async function executeDetailed({ target, text } = {}) {
    const body = String(text ?? '').trim()
    if (body === '') return { text: 'Ошибка инструмента sendto: пустой текст сообщения.' }
    const resolved = resolve(target)
    if (resolved.error) return { text: `Ошибка инструмента sendto: ${resolved.error}` }

    const signed = `От ${ownerName}: ${body.slice(0, MAX_TEXT)}`
    try {
      const result = await send({ chatId: resolved.chatId, text: signed })
      logger?.info?.('sendto delivered', { how: resolved.how, chatId: resolved.chatId })
      return {
        text: `Отправил ${resolved.label} (${resolved.how}).`,
        sent: { chatId: resolved.chatId, messageId: result?.messageId },
      }
    } catch (error) {
      const message = String(error?.message ?? error)
      // Отдельно называем самую частую причину: Telegram не даёт писать первым.
      if (/chat not found|user not found|PEER_ID_INVALID|not enough rights/i.test(message)) {
        return {
          text:
            `Ошибка инструмента sendto: не удалось отправить ${resolved.label}. `
            + 'Скорее всего этот человек не начинал диалог с ботом — Telegram не разрешает написать первым.',
        }
      }
      logger?.warn?.('sendto failed', { how: resolved.how, error: message })
      return { text: `Ошибка инструмента sendto: не удалось отправить (${message}).` }
    }
  }

  return {
    definition,
    executeDetailed,
    execute: async (args) => (await executeDetailed(args)).text,
  }
}

export { digits, phoneKey, MAX_TEXT }
