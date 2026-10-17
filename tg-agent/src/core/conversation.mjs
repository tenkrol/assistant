/**
 * Конвейер обработки сообщения.
 *
 * Один ход пользователя проходит явные шаги:
 *   1. разбор и доступ — кто пишет, можно ли ему отвечать, команда это или текст;
 *   2. контекст и память — история чата, факты о человеке, режим, характер, время;
 *   3. вложения — фото, голосовые и документы превращаются в части запроса;
 *   4. модель и инструменты — вызов модели и принудительный вызов инструмента,
 *      если бот пообещал напоминание, память или файл, а инструмент не сработал;
 *   5. ответ и действия — текст, кнопки напоминания, файл, озвучка и запись
 *      фактов, которые человек сообщил о себе.
 *
 * Здесь же обрабатываются нажатия кнопок: отмена и перенос напоминания, голос
 * в опросе. Ядро (`bot.mjs`) остаётся сборкой и доставкой, а эта часть знает
 * порядок шагов.
 */
import { formatTimeContext } from '../time-context.mjs'
import { prepareAttachments } from '../media-handler.mjs'
import { detectFacts } from '../auto-memory.mjs'
import { characterHint as personaCharacterHint } from '../personas.mjs'
import { parsePollAction, pollKeyboard, pollMessage } from '../polls.mjs'
import { MODES, parseCommand } from './commands.mjs'

const DENY_COOLDOWN_MS = 10 * 60 * 1000

/** Список напоминаний — это не просьба создать новое, и насильно звать remind нельзя. */
const REMINDER_LIST = /(покажи|какие|какой|список|что|все|мои)\s+[^.!?]{0,24}?напомин/iu
/** Пользователь просит напоминание — инструмент обязан действительно сработать. */
const REMINDER_INTENT = /(напомни(?![\p{L}])|напомни(?:шь|те|ть|те)?\b|напоминай|напоминалк|(?:поставь|создай|сделай|заведи|новое)\s+напомин|напоминан[\p{L}]*\s+(?:на|в|через|о|к|про)(?![\p{L}])|\bremind me\b)/iu
/** Ответ обещает напоминание с конкретным временем («напомню в 01:23»). */
const REMINDER_CLAIM = /(?:напомн[\p{L}]*\s+в\s+\d|напоминание\s+(?:создано|поставлено|№)|напомню\s+(?:вам|тебе|в|завтра|сегодня|через))/iu
/** Просьба о документе: таблица, письмо, выгрузка. */
const FILE_INTENT = /(таблиц|excel|эксель|xlsx|csv|документ|docx|ворд|\bword\b|презентац|отч[её]т|выгруз|файл|письм[оа]\s+в\s+docx)/i
/** Модель утверждает, что файл уже отправлен, хотя ничего не собрано. */
const FILE_CLAIM = /(файл\s+(?:отправлен|готов|приложен)|отправил\s+файл|во\s+вложении)/i
/** Пользователь прямо просит что-то запомнить. */
const MEMORY_INTENT = /(запомн|запиши|занеси|сохрани в память)/i
/** Пользователь сообщает о себе устойчивый факт. */
const PROFILE_ASSERTION = /(я\s+(?:живу|нахожусь|переехал|переехала|родился|родилась)|мой\s+город|меня\s+зовут|моё\s+имя|мое\s+имя|зови\s+меня|я\s+из\s+[А-ЯЁ])/i

/**
 * Просит ли сообщение сохранить что-то о человеке.
 *
 * Вопрос — не утверждение: «какой мой город?» не должен создавать факт.
 *
 * @param {string} text - текст сообщения.
 * @returns {boolean} true, если это просьба о памяти.
 */
function isMemoryRequest(text) {
  const value = String(text ?? '').trim()
  if (MEMORY_INTENT.test(value)) return true
  if (value.endsWith('?')) return false
  return PROFILE_ASSERTION.test(value)
}

/** Убрать упоминание бота из текста группового сообщения. */
const stripMention = (text, username) =>
  username ? text.replace(new RegExp(`@${username}\\b`, 'gi'), '').trim() : text

/**
 * Собрать конвейер для одного бота.
 *
 * @param {object} bot - экземпляр `Assistant`.
 * @returns {object} методы конвейера, которые фасад публикует под прежними именами.
 */
export function createConversation(bot) {
  /** Есть ли у пользователя доступ. */
  function isAllowed(userId) {
    return bot.config.access.allowAllUsers || bot.config.access.allowedUserIds.has(userId)
  }

  /** Сообщить незнакомцу его id, но не чаще раза за окно кулдауна. */
  async function deny(userId, chatId) {
    const now = Date.now()
    // Держим карту кулдауна ограниченной: записи старше окна уже не могут
    // подавить ответ, поэтому их удаляют до того, как они накопятся.
    if (bot.deniedAt.size >= 256) {
      for (const [id, timestamp] of bot.deniedAt) {
        if (now - timestamp >= DENY_COOLDOWN_MS) bot.deniedAt.delete(id)
      }
      if (bot.deniedAt.size >= 4096) bot.deniedAt.clear()
    }
    const last = bot.deniedAt.get(userId) ?? 0
    if (now - last < DENY_COOLDOWN_MS) {
      bot.logger.debug('denial suppressed', { userId })
      return
    }
    bot.deniedAt.set(userId, now)
    bot.logger.warn('access denied', { userId, chatId })
    const text = bot.config.access.denyMessage.replace('{id}', String(userId))
    // Отправляем через `send`, чтобы `<`, `&` и `>` в своём DENY_MESSAGE
    // экранировались, а не приходили в Telegram сломанными сущностями.
    await bot.send(chatId, text).catch((error) => bot.logger.warn('deny reply failed', { error }))
  }

  /** Шаги 1–2: разбор сообщения, доступ, команда или текст. */
  async function handleMessage(message) {
    const from = message.from
    // Контакт, которым поделились, — единственный способ узнать телефон:
    // Telegram не даёт искать людей по номеру. Сохраняем и подтверждаем.
    const sharedContacts = (message.attachments ?? message.files ?? []).filter((item) => item?.kind === 'contact')
    for (const item of sharedContacts) {
      if (item.userId) {
        bot.contacts?.remember?.({ chatId: item.userId, name: item.name, username: item.username, phone: item.phone })?.catch?.(() => {})
      }
      const who = item.name || (item.username ? '@' + item.username : 'контакт')
      bot.logger?.info?.('contact remembered', { hasPhone: Boolean(item.phone), hasUser: Boolean(item.userId) })
      await bot.send?.(
        message.chat?.id,
        item.userId
          ? `Запомнил ${who}${item.phone ? ', телефон ' + item.phone : ''}. Теперь могу написать ему: «напиши ${item.name || 'ему'} …»`
          : `Запомнил ${who}, но без id в Telegram: написать ему первым не получится — Telegram запрещает.`,
      ).catch?.(() => {})
    }
    if (!from || from.isBot) return
    const chatType = message.chat?.type
    if (!bot.config.access.allowedChatTypes.has(chatType)) {
      bot.logger.debug('chat type ignored', { chatType })
      return
    }
    const text = String(message.text ?? '').trim()
    const attachments = message.attachments ?? []
    // Фото, голосовое или документ без текста — тоже полноценный ход.
    if (text === '' && attachments.length === 0) return
    // Доступ и обращение проверяются вместе: ответ незнакомцу в группе
    // опубликовал бы его id всему чату, поэтому там бот только пишет в лог.
    // Адаптер уже решил, обращены ли к боту.
    const addressed = message.addressed
    if (!bot.isAllowed(from.id)) {
      if (addressed) await bot.deny(from.id, message.chat.id)
      else bot.logger.debug('denied user ignored outside a private chat', { userId: from.id, chatId: message.chat.id })
      return
    }
    if (!addressed) return

    // Публичное имя платформы — то, что позволяет боту различать людей в группе.
    if (bot.profiles?.store.touch(from.id, { firstName: from.name, username: from.username })) void bot.profiles.store.flush()
    const command = parseCommand(text, bot.username)
    if (command) {
      await bot.runCommand(command, message)
      return
    }
    const prompt = chatType === 'private' ? text : stripMention(text, bot.username)
    if (prompt.trim() === '' && attachments.length === 0) return
    // Квитанция — статус: человек видит, что бот принял сообщение, ещё до ответа модели.
    void bot.react(message, '👀')
    await bot.reply(message, prompt)
  }

  /** Ответ на нажатие кнопки: отмена и перенос напоминания, голос в опросе. */
  async function handleCallback(update) {
    const from = update.from
    const data = String(update.callback?.data ?? '')
    const messageId = update.callback?.messageId
    if (!from || messageId === undefined) return
    if (!bot.isAllowed(from.id)) {
      bot.logger.info('callback from a stranger ignored', { userId: from.id })
      await bot.platform.answerCallback({ callbackId: update.callback.id, text: 'Нет доступа.', alert: true }).catch(() => {})
      return
    }
    const chatId = update.chat.id
    const [action, ...rest] = data.split(':')
    let toast = 'Не понял действие'
    let outcome
    try {
      if (action === 'poll') {
        const parsed = parsePollAction(data)
        if (!parsed || !bot.polls) {
          toast = 'Опрос недоступен'
        } else {
          // Голос, повтор и закрытие опроса — правила домена.
          const result = await bot.domain.polls.vote(parsed.id, from.id, parsed.optionIndex)
          if (!result?.poll) {
            toast = result?.toast ?? 'Опрос уже закрыт'
          } else {
            // Сообщение опроса перерисовывается на месте: счётчики меняются с каждым голосом.
            await bot.platform.editText({
              chatId,
              messageId,
              markdown: pollMessage(result.poll, { names: bot.namesOf(result.poll) }),
              keyboard: pollKeyboard(result.poll),
            }).catch((error) => bot.logger.debug('poll edit failed', { error, chatId }))
            // Прежний порядок: сообщение уже перерисовано — теперь фиксируем голос.
            await bot.polls.store.flush()
            toast = result.toast
          }
        }
      } else if (action === 'cancel') {
        const [id] = rest
        // `message` здесь — собственное сообщение бота, поэтому его `from.id` —
        // это бот: владелец — тот, кто нажал кнопку.
        const result = await bot.domain.reminders.cancelByButton({ chatId, userId: from.id, id })
        toast = result.toast
        outcome = result.outcome
      } else if (action === 'snooze') {
        const [minutesRaw, id] = rest
        const result = await bot.domain.reminders.snooze({ chatId, userId: from.id, id, minutes: minutesRaw })
        toast = result.toast
        outcome = result.outcome
      }
    } catch (error) {
      bot.logger.error('callback action failed', { error, action, chatId })
      toast = 'Не получилось, попробуйте ещё раз'
    }
    bot.logger.info('callback handled', { action, chatId, userId: from.id })
    await bot.platform.answerCallback({ callbackId: update.callback.id, text: toast }).catch(() => {})
    if (outcome) {
      // Исходный текст нам неизвестен, поэтому адаптер перепишет сообщение без разметки.
      await bot.platform.editText({ chatId, messageId, markdown: `${update.callback.text ?? ''}\n\n${outcome}` }).catch((error) => {
        bot.logger.debug('message edit failed', { error, chatId })
      })
    }
  }

  /** Один ход модели для чата и доставка ответа. */
  async function reply(message, prompt) {
    const chatId = message.chat.id
    await bot.semaphore.acquire()
    const typing = bot.startTyping(chatId)
    try {
      const chatKey = String(chatId)
      const userId = message.from?.id
      // Шаг 1. Бюджет проверяется до вызова: когда он исчерпан, дальнейшие
      // запросы только добавляют стоимость, не принося нужного ответа.
      if (bot.usage?.limitReached()) {
        const spent = bot.usage.tokens()
        const limit = bot.usage.dailyLimit
        bot.logger.warn('daily token limit reached, refusing the turn', { chatId, spent, limit })
        await bot.send(chatId, `Дневной лимит токенов исчерпан: ${new Intl.NumberFormat('ru-RU').format(spent)} из ${new Intl.NumberFormat('ru-RU').format(limit)}. До полуночи новые запросы отвечать не буду — сводка в /stats, лимит задаётся переменной \`DAILY_TOKEN_LIMIT\`.`)
        return
      }
      // Шаг 2. Личный чат может видеть всё, что бот знает о владельце. Группа —
      // нет: там модель получает только имена, чтобы личные факты не утекли в
      // разговор с другими людьми.
      const isGroup = (message.chat?.type ?? 'private') !== 'private'
      const authorName = isGroup ? bot.profiles?.store.displayName(userId) : undefined
      const knownFacts = userId === undefined
        ? undefined
        : isGroup ? bot.groupContext(chatKey, authorName) : bot.profiles?.store.summary(userId)
      // Личный тон и длина ответа, заданные `/mode`, дописываются в системный
      // промпт, поэтому действуют на каждый ответ в этом чате.
      const modeHint = bot.modeHint(userId)
      // Характер и настроение берутся из профиля, поэтому переживают перезапуск.
      const character = bot.characterHint(userId)
      // Шаг 3. Фото, голосовые и документы становятся частями контента (или
      // заметками, когда что-то недоступно).
      const prepared = message.attachments?.length > 0
        ? await prepareAttachments({
          platform: bot.platform,
          attachments: message.attachments,
          caption: prompt,
          media: bot.media,
          limits: { maxBytes: bot.config.media?.maxBytes },
          logger: bot.logger,
        })
        : { parts: [], notes: [], summary: '' }
      // Из вложений ничего не вышло (сканированный PDF, голосовое без
      // распознавателя), а подписи нет: спрашивать модель с пустым сообщением
      // значило бы получить «модель ничего не вернула», то есть тишину. Говорим,
      // что произошло.
      if (prepared.parts.length === 0 && prompt.trim() === '' && message.attachments?.length > 0) {
        const reason = prepared.notes.length > 0
          ? prepared.notes.map((note) => `⚠️ ${note}`).join('\n')
          : '⚠️ Не удалось разобрать вложение.'
        await bot.send(chatId, `${reason}\n\nПришлите текст сообщением или файл в другом формате — отвечу по содержимому.`, message.message_id)
        void bot.react(message, '🤔')
        return
      }
      // В группе говорящий подписан в истории, иначе модель не отличит, кто что
      // сказал, и «меня зовут X» припишет не тому человеку.
      const history = bot.history.messages(chatKey).map((entry) => (
        isGroup && entry.role === 'user' && entry.author
          ? { role: 'user', content: `${entry.author}: ${entry.content}` }
          : entry
      ))
      const withAuthor = (content) => (isGroup && authorName ? `${authorName}: ${content}` : content)
      const messages = [
        { role: 'system', content: bot.config.model.systemPrompt },
        // У модели нет часов; без этого она выдумывает даты и потом называет
        // закешированные результаты поиска «сегодняшними».
        { role: 'system', content: formatTimeContext({ timeZone: bot.config.time?.timeZone ?? '' }) },
        ...(knownFacts ? [{ role: 'system', content: knownFacts }] : []),
        ...(modeHint ? [{ role: 'system', content: modeHint }] : []),
        ...(character ? [{ role: 'system', content: character }] : []),
        // Модель не знает, с чем её собрали: это и есть это знание.
        { role: 'system', content: bot.capabilitiesHint() },
        ...history,
        ...(prepared.parts.length > 0
          // Составной контент: подпись/текст документа плюс само изображение.
          ? [{ role: 'user', content: prepared.parts.map((part) => (part.type === 'text' ? { ...part, text: withAuthor(part.text) } : part)) }]
          : [{ role: 'user', content: withAuthor(prompt) }]),
      ]
      const model = bot.history.model(chatKey) ?? bot.model.name
      const started = Date.now()
      // Стриминг включён по умолчанию: человек видит, как ответ растёт, вместо
      // долгой тишины. Он требует платформы и чата, где правки сообщений
      // надёжны: в беседах VK это не так, и адаптер отвечает на этот вопрос.
      const streamable = bot.config.stream?.enabled && (typeof bot.platform.canStream !== 'function' || bot.platform.canStream({ chatId }))
      const streamer = streamable ? bot.createStreamer(chatId) : undefined
      // Шаг 4. Список схем и диспетчер приходят из реестра: ядро не знает, какие
      // инструменты бывают и что с ними делать. Дальше нужны только результаты
      // этого хода — напоминание для кнопок и файл для отправки.
      const tools = bot.tools.definitions
      /** Результаты инструментов этого хода по имени. */
      const toolResults = new Map()
      /** Напоминание, созданное в этом ходе: под ответом будут кнопки. */
      let createdReminder
      /** Файл, собранный в этом ходе: отправится сразу после текста. */
      let createdFile
      const executeTool = async (name, args, options = {}) => bot.tools.executeTool(name, args, {
        chatId,
        userId,
        isGroup,
        replyTo: message.message_id,
        signal: options?.signal,
        onResult: (outcome) => {
          toolResults.set(outcome.name, outcome)
          if (outcome.reminder) createdReminder = outcome.reminder
          if (outcome.file) createdFile = outcome.file
        },
      })
      const toolOptions = tools.length > 0
        ? { tools, executeTool, maxToolRounds: bot.config.web.maxToolRounds }
        : {}
      /** Текст, который вернул инструмент в этом ходе. */
      const toolResultText = (name) => toolResults.get(name)?.text
      let answer = await bot.model.complete({
        messages,
        model,
        signal: bot.shutdown?.signal,
        ...(streamer ? { onDelta: (chunk) => streamer.onDelta(chunk) } : {}),
        ...toolOptions,
      })
      bot.recordUsage(userId, chatId, answer.usage)

      /**
       * Провести один дополнительный раунд модели, который обязан вызвать ровно
       * один инструмент.
       *
       * Иногда модель отвечает на просьбу об действии словами («Записал!») и не
       * вызывает инструмент, поэтому ничего не сохраняется. Для такого
       * обязательства инструмент должен сработать, а человек — увидеть его
       * собственное подтверждение.
       */
      const forceTool = async (name, nudge) => {
        const payload = {
          messages: [...messages, { role: 'system', content: nudge }],
          model,
          signal: bot.shutdown?.signal,
          ...toolOptions,
          maxToolRounds: 1,
        }
        try {
          const forced = await bot.model.complete({ ...payload, toolChoice: { type: 'function', function: { name } } })
          bot.recordUsage(userId, chatId, forced.usage)
          return forced
        } catch (error) {
          // Thinking-модели отвечают 400 «Thinking mode does not support this
          // tool_choice». Повторяем без принуждения: подсказка всё равно просит
          // инструмент, а вызывающий код проверяет, что он действительно сработал.
          bot.logger.warn('forced tool_choice rejected, retrying without it', { name, error: error?.message ?? error })
          const relaxed = await bot.model.complete(payload)
          bot.recordUsage(userId, chatId, relaxed.usage)
          return relaxed
        }
      }

      // Обещание напоминания — обязательство: если модель ответила только
      // словами, инструмент вызывается принудительно, чтобы что-то действительно
      // было запланировано. Это не опция: раньше ответ говорил «напомню в
      // 01:23», а нигде ничего не сохранялось.
      const reminderRequested = bot.reminders && answer.toolCalls === 0
        && !REMINDER_LIST.test(prompt)
        && (REMINDER_INTENT.test(prompt) || REMINDER_CLAIM.test(answer.text ?? ''))
      if (reminderRequested) {
        bot.logger.warn('reminder requested without a tool call, forcing remind', { chatId })
        const forced = await forceTool('remind', 'Пользователь просит напоминание. Немедленно вызови инструмент remind и передай время, посчитанное от текущего момента из системного сообщения о времени.')
        if (forced.toolCalls > 0 && toolResultText('remind')) {
          // Текст инструмента точно говорит, что запланировано; он лучше
          // пересказа, поэтому человек не увидит время, которого нет в хранилище.
          answer = { ...forced, text: toolResultText('remind'), toolCalls: forced.toolCalls }
        } else {
          bot.logger.warn('forced remind produced no tool call', { chatId, toolCalls: forced.toolCalls })
          // Затираем ответ только если бот успел пообещать напоминание. Иначе
          // его слова были верными (например, он перечислил список), и подменять
          // их сообщением об ошибке нельзя.
          if (REMINDER_CLAIM.test(answer.text ?? '')) {
            answer = { ...answer, text: 'Не удалось поставить напоминание — инструмент не сработал. Попробуйте сформулировать иначе, например: «напомни через 15 минут проверить духовку».' }
          }
        }
      }

      // Та же гарантия для памяти: «мой город — Казань» раньше получало ответ
      // «Записал!», а профиль оставался нетронутым, и город не запоминался.
      const memoryRequested = bot.profiles && !toolResultText('remember') && isMemoryRequest(prompt)
      if (memoryRequested) {
        bot.logger.warn('memory request without a tool call, forcing remember', { chatId })
        const forced = await forceTool('remember', 'Пользователь сообщает о себе факт. Немедленно вызови инструмент remember: factual text в параметре text, а если он назвал свой город — обязательно заполни параметр city.')
        if (forced.toolCalls > 0 && toolResultText('remember')) {
          answer = { ...forced, text: toolResultText('remember'), toolCalls: forced.toolCalls }
        } else {
          bot.logger.error('forced remember produced no tool call', { chatId, toolCalls: forced.toolCalls })
          answer = { ...answer, text: 'Не удалось сохранить — инструмент памяти не сработал. Попробуйте ещё раз или задайте город командой `/city Москва`.' }
        }
      }

      // Та же гарантия для документов: «сделай таблицу в Excel» раньше
      // получало красивую таблицу в чате, хотя файла вообще не было.
      const fileRequested = bot.files && !createdFile && answer.toolCalls === 0
        && (FILE_INTENT.test(prompt) || FILE_CLAIM.test(answer.text ?? ''))
      if (fileRequested) {
        bot.logger.warn('file requested without a tool call, forcing file', { chatId })
        const forced = await forceTool('file', 'Пользователь просит файл. Немедленно вызови инструмент file: выбери формат (xlsx для таблицы, docx для документа, csv для данных), придумай короткое имя и передай содержимое в параметрах text или table.')
        if (forced.toolCalls > 0 && createdFile) {
          answer = { ...forced, text: toolResultText('file') ?? forced.text, toolCalls: forced.toolCalls }
        } else {
          bot.logger.error('forced file produced no file', { chatId, toolCalls: forced.toolCalls })
          answer = { ...answer, text: 'Не удалось собрать файл — инструмент не сработал. Попробуйте иначе, например: «сделай таблицу в Excel со столбцами Название и Год».' }
        }
      }

      // Шаг 5. Ответ и действия.
      const text = answer.text.trim()
      bot.logger.info('model answered', {
        chatId,
        model: answer.model ?? model,
        toolCalls: answer.toolCalls ?? 0,
        ms: Date.now() - started,
        promptChars: prompt.length,
        answerChars: text.length,
        usage: answer.usage,
      })
      // Автор сохраняется только для групп: в личном чате он ровно один.
      // Вложение становится короткой заглушкой: файл истории не должен расти
      // от base64-картинок или целых документов.
      const historyLine = prepared.summary || prompt
      await bot.history.append(chatKey, { role: 'user', content: historyLine, ...(authorName ? { author: authorName } : {}) })
      // Кого бот видел — для sendto: Telegram не даёт писать человеку по @нику,
      // нужен числовой id, а он есть только у тех, кто уже писал боту.
      bot.contacts?.remember?.({ chatId: message?.chat?.id, name: message?.from?.name, username: message?.from?.username })?.catch?.(() => {})
      if (text === '') {
        // Пустое завершение — валидный ответ API. Человеку всё равно нужен
        // ответ, а пустой ход ассистента не должен попадать в историю.
        await bot.send(chatId, 'Модель вернула пустой ответ. Попробуйте переформулировать запрос.')
        return
      }
      await bot.history.append(chatKey, { role: 'assistant', content: text })
      // Напоминание, созданное в этом ходе, получает кнопки под подтверждением:
      // отменить или отложить его можно одним нажатием вместо команды.
      const keyboard = createdReminder ? bot.reminderKeyboard(createdReminder.id) : undefined
      // Если ответ уже стримился в сообщение, финальный текст (с кнопками)
      // заменяет его; иначе он отправляется как обычно.
      const delivered = streamer ? await streamer.finish(text, keyboard) : false
      if (!delivered) await bot.send(chatId, text, message.message_id, keyboard)
      // Сгенерированный документ идёт после текста: ответ объясняет, файл несёт данные.
      if (createdFile) await bot.sendFile(chatId, createdFile, message.message_id)
      // Голосовые ответы включаются отдельно для чата (`/voice вкл`): текст
      // приходит всегда, озвучка добавляется поверх него.
      await bot.speakAnswer(chatId, text, message)
      // Всё, что не удалось использовать (нераспознанное голосовое, сканированный
      // PDF), сообщается один раз, после ответа.
      if (prepared.notes.length > 0) {
        await bot.send(chatId, prepared.notes.map((note) => `⚠️ ${note}`).join('\n')).catch(() => {})
      }
      void bot.react(message, '👍')
      // Факты, которые человек сообщил о себе, сохраняются без вопроса модели:
      // «меня зовут …» раньше получало слова вместо записи.
      await bot.rememberStatedFacts(userId, prompt)
    } catch (error) {
      if (bot.shutdown?.signal.aborted) {
        // Остановка прервала вызов намеренно: процесс завершается, и сообщение об
        // ошибке сейчас было бы шумом (и могло бы даже не дойти).
        bot.logger.warn('model turn aborted by shutdown', { chatId })
        return
      }
      void bot.react(message, '🤔')
      bot.logger.error('model turn failed', { error, chatId })
      bot.noteModelFailure(error)
      const detail = error?.message ?? 'неизвестная ошибка'
      // Намеренно простой текст: преобразователь его экранирует, поэтому
      // сообщение провайдера не может внедрить разметку в ответ.
      await bot.send(chatId, `Не удалось получить ответ.\n\n${truncate(detail, 300)}`).catch(() => {})
    } finally {
      typing.stop()
      bot.semaphore.release()
    }
  }

  /**
   * Что модель получает в группе: кто говорит, и ничего личного.
   *
   * Передаются только имена. Город и факты остаются в личном чате, чтобы бот
   * случайно не раскрыл их другим участникам.
   *
   * @param {string} chatKey - ключ истории чата.
   * @param {string} [authorName] - имя текущего говорящего.
   * @returns {string|undefined} системная строка или `undefined`, если имён нет.
   */
  function groupContext(chatKey, authorName) {
    const participants = [...new Set(bot.history.messages(chatKey).filter((entry) => entry.author).map((entry) => entry.author))]
    if (authorName && !participants.includes(authorName)) participants.push(authorName)
    if (participants.length === 0) return undefined
    const who = authorName ? `Сейчас пишет ${authorName}. ` : ''
    return `${who}Участники этого чата: ${participants.join(', ')}. Личные факты и город участников здесь не показываются — личный контекст остаётся в личных чатах.`
  }

  /**
   * Системное сообщение о характере и настроении ассистента.
   *
   * @param {string|number} [userId] - владелец профиля.
   * @returns {string|undefined} подсказка или undefined, когда профили выключены.
   */
  function characterHint(userId) {
    if (!bot.profiles || userId === undefined) return undefined
    return personaCharacterHint({
      profile: {
        persona: bot.profiles.store.persona(userId),
        mood: bot.profiles.store.mood(userId),
      },
      userId,
      now: new Date(),
      timeZone: bot.config.time?.timeZone ?? '',
    })
  }

  /** Системная подсказка о выбранном режиме ответа, когда он задан. */
  function modeHint(userId) {
    const mode = userId === undefined ? undefined : bot.profiles?.store.mode(userId)
    const hint = mode ? MODES[mode] : undefined
    return hint ? `Режим ответа, выбранный пользователем: ${hint}` : undefined
  }

  /**
   * Сохранить факты, которые человек сообщил о себе, не спрашивая модель.
   *
   * У модели есть инструмент `remember`, но иногда она отвечает «запомнил»
   * словами; такие утверждения однозначны, поэтому сохраняются напрямую и не
   * стоят токенов.
   *
   * @param {string|number} [userId] - владелец профиля.
   * @param {string} prompt - текст сообщения.
   */
  async function rememberStatedFacts(userId, prompt) {
    if (!bot.profiles || userId === undefined) return
    const facts = detectFacts(prompt)
    if (facts.length === 0) return
    // Предел фактов, дубли и город — правила домена профилей.
    const { changed } = await bot.domain.profiles.rememberDetected(userId, facts)
    if (changed) {
      bot.logger.info('facts remembered automatically', { userId, facts: facts.length })
    }
  }

  return {
    isAllowed,
    deny,
    handleMessage,
    handleCallback,
    reply,
    groupContext,
    characterHint,
    modeHint,
    rememberStatedFacts,
  }
}

/** Обрезать текст, добавив многоточие, — для логов и сообщений об ошибке. */
export const truncate = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text)
