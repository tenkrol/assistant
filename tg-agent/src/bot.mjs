/**
 * Фасад ядра бота: опрос платформы, доступ, доставка и склейка слоёв.
 *
 * Решения, которые стоит знать при чтении:
 *   - обновления подтверждаются сразу после постановки в очередь, поэтому
 *     медленный вызов модели не блокирует цикл опроса и другие чаты;
 *   - работа одного чата сериализуется (разговор должен сохранять порядок), а
 *     глобальный семафор ограничивает число одновременных вызовов модели;
 *   - разметка, стриминг и разбиение длинного ответа живут в `src/delivery/`,
 *     обработка сообщения — в `src/core/conversation.mjs`, команды — в
 *     `src/core/commands.mjs`, возможности — в `src/core/capabilities.mjs`.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { dayKey } from './usage.mjs'
import { rulesOfProfiles } from './domain/profiles.mjs'
import { rulesOfReminders } from './domain/reminders.mjs'
import { rulesOfEvents } from './domain/events.mjs'
import { rulesOfPolls } from './domain/polls.mjs'
import { createToolRegistry } from './tools/registry.mjs'
import { createContactStore } from './contacts.mjs'
import { createStreamer } from './delivery/stream.mjs'
import { createCommandRouter } from './core/commands.mjs'
import { capabilityLines, capabilityHint } from './core/capabilities.mjs'
import { createConversation, truncate } from './core/conversation.mjs'

const TYPING_INTERVAL_MS = 4000
/** Алерты: N сбоев внутри окна дают одно сообщение за кулдаун. */
const ALERT_FAILURES = 3
const ALERT_WINDOW_MS = 10 * 60 * 1000
const ALERT_COOLDOWN_MS = 60 * 60 * 1000
/** Предупреждать, когда израсходована эта доля дневного бюджета токенов. */
const SPEND_ALERT_RATIO = 0.8

/** Простой считающий семафор для глобального предела вызовов модели. */
class Semaphore {
  constructor(limit) {
    this.limit = limit
    this.active = 0
    this.waiters = []
  }

  async acquire() {
    if (this.active >= this.limit) await new Promise((resolve) => this.waiters.push(resolve))
    this.active++
  }

  release() {
    this.active--
    const next = this.waiters.shift()
    if (next) next()
  }
}

export class Assistant {
  /**
   * @param {object} options - параметры бота.
   * @param {object} options.config - результат `loadConfig`.
   * @param {object} options.platform - адаптер платформы.
   * @param {object} options.model - клиент модели.
   * @param {object} options.history - хранилище истории.
   * @param {object} [options.webTools] - исполнитель веб-инструментов.
   * @param {object} [options.reminders] - `{ store, tool, scheduler }`.
   * @param {object} [options.profiles] - `{ store, tool }` профилей.
   * @param {object} [options.usage] - учёт токенов.
   * @param {object} [options.digest] - утренний дайджест.
   * @param {object} options.logger - логгер.
   */
  constructor({ config, platform, model, history, webTools, agentBridge, agentLink, reminders, profiles, usage, digest, media, tts, files, events, polls, youtube, server, logger }) {
    this.config = config
    // Кого бот знает: имена и @ники приходят с сообщениями, телефоны — только
    // когда человек сам делится контактом. Нужно для sendto.
    this.contacts = createContactStore({ file: this.config.dataDir ? `${this.config.dataDir}/contacts.json` : undefined, logger: this.logger })
    // Ядро общается только с одним адаптером; см. src/platforms/port.mjs.
    this.platform = platform
    this.model = model
    this.history = history

    this.webTools = webTools
    this.agentBridge = agentBridge
    this.agentLink = agentLink
    this.reminders = reminders
    this.profiles = profiles
    this.usage = usage
    this.digest = digest
    /** `{ transcribe, extractText }` — фото, голосовые и документы. */
    this.media = media
    /** Необязательный синтезатор речи `(text) => Promise<Buffer>`. */
    this.tts = tts
    // Собирает документы для пользователя; отправляет их адаптер платформы.
    this.files = files
    // Локальный календарь: события, которые бот записывает и показывает.
    this.events = events
    // Опросы, конспекты видео и самодиагностика.
    this.polls = polls
    this.youtube = youtube
    this.server = server
    // Правила предметной области: ядро только зовёт их и доставляет ответ.
    // Домены не знают ни про платформу, ни про сеть — им передаются данные и store.
    this.domain = {
      profiles: rulesOfProfiles({ store: profiles?.store, logger }),
      reminders: rulesOfReminders({ store: reminders?.store, timeZone: config.time?.timeZone ?? '', quiet: config.quiet, logger }),
      events: rulesOfEvents({ store: events?.store, reminders: reminders?.store, timeZone: config.time?.timeZone ?? '', logger }),
      polls: rulesOfPolls({ store: polls?.store }),
    }
    // Единый реестр инструментов: ядро получает готовый список схем и один
    // диспетчер, а не собирает их вручную. Доставка текста в чат — зависимость
    // самого бота, поэтому передаётся сюда.
    this.tools = createToolRegistry({
      config,
      domains: this.domain,
      logger,
      history,
      webTools,
      agentBridge,
      reminders,
      profiles,
      events,
      polls,
      files,
      youtube,
      server,
      contacts: this.contacts,
      ownerName: config.owner?.name ?? 'владельца',
      sendText: (chatId, markdown, replyToMessageId, keyboard) => this.send(chatId, markdown, replyToMessageId, keyboard),
    })
    // Собирается один раз из конфигурации: модель и /help описывают ровно то,
    // что умеет эта сборка, и ничего сверх.
    this.capabilities = capabilityLines({ config, media, platformName: platform?.name })
    // Команды живут в отдельном маршрутизаторе; ядро только передаёт ему текст.
    this.commands = createCommandRouter(this)
    // Конвейер сообщения: доступ, контекст и память, модель и инструменты, ответ и действия.
    this.conversation = createConversation(this)
    this.logger = logger
    this.running = false
    this.offset = undefined
    this.botId = undefined
    this.username = undefined
    this.controller = undefined
    this.chains = new Map()
    this.inFlight = new Set()
    this.deniedAt = new Map()
    this.semaphore = new Semaphore(config.limits.maxConcurrentRequests)
    // Telegram сохраняет прежнее имя файла, поэтому существующий курсор
    // переживает переход на адаптеры; другим платформам достаётся свой файл.
    const offsetName = platform.name === 'telegram' ? 'offset.json' : `offset-${platform.name}.json`
    this.offsetFile = path.join(config.dataDir, offsetName)
    this.offsetTimer = null
    /** Отметки недавних сбоев модели — для порога предупреждения. */
    this.failures = []
    this.lastAlertAt = 0
    this.spendAlertDay = undefined
  }

  /**
   * Определить личность, снять вебхук и начать опрос.
   *
   * Сетевая ошибка при старте повторяется; отвергнутый токен падает сразу:
   * повтор только отложил бы понятную ошибку.
   */
  async start({ attempts = this.config.limits.startupAttempts } = {}) {
    // Справочник контактов читаем сразу, а не при первом изменении: иначе после
    // рестарта `sendto` не видел бы людей, сохранённых прошлым запуском.
    await this.contacts?.load?.()
    await this.resolveIdentity(attempts)
    this.shutdown = new AbortController()
    this.logger.info('bot identity resolved', { platform: this.platform.name, id: this.botId, username: this.username })
    await this.loadOffset()
    this.running = true
    this.startedAt = Date.now()
    this.loopPromise = this.pollLoop()
    // Запускается после того, как личность известна: планировщик может сразу
    // доставить просроченное напоминание, а для этого нужен рабочий клиент.
    this.reminders?.scheduler?.start()
    this.digest?.start()
    this.startHeartbeat()
    return this
  }

  async resolveIdentity(attempts) {
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.platform.start()
        this.identity = this.platform.identity
        this.botId = this.platform.identity?.id
        this.username = this.platform.identity?.username
        return this.platform.identity
      } catch (error) {
        lastError = error
        const fatal = this.platform.isFatalError ? this.platform.isFatalError(error) : false
        if (fatal || attempt >= attempts) break
        const waitMs = Math.min(2000 * 2 ** (attempt - 1), 15000)
        this.logger.warn('platform unreachable at startup, retrying', { attempt, attempts, waitMs, error })
        await sleep(waitMs)
      }
    }
    throw lastError
  }

  /**
   * Остановить опрос, дождаться очереди и сохранить состояние.
   *
   * Вызовы модели прерываются, а ожидание ограничено `shutdownGraceMs`:
   * супервизор присылает SIGKILL примерно через 10 с, и состояние должно
   * успеть на диск.
   */
  async stop() {
    if (!this.running) return
    this.running = false
    this.controller?.abort()
    this.shutdown?.abort()
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    await this.loopPromise?.catch(() => {})
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      sleep(this.config.limits.shutdownGraceMs),
    ])
    await this.reminders?.scheduler?.stop()
    this.digest?.stop()
    await this.usage?.flush()
    await this.flushOffset()
    await this.history.flush()
    this.logger.info('bot stopped', { chats: this.history.size })
  }

  async pollLoop() {
    let backoffMs = 1000
    while (this.running) {
      this.controller = new AbortController()
      try {
        const { updates, cursor } = await this.platform.getUpdates({
          cursor: this.offset,
          timeoutSec: this.config.platform.pollTimeoutSec,
          // Долгий опрос должен завершаться по просьбе остановить процесс,
          // иначе рестарт ждёт весь таймаут, а systemd убивает бота.
          signal: this.shutdown?.signal,
        })
        backoffMs = 1000
        if (cursor !== undefined && cursor !== this.offset) {
          this.offset = cursor
          this.scheduleOffsetSave()
        }
        for (const update of updates) this.enqueueUpdate(update)
      } catch (error) {
        if (!this.running) break
        this.logger.warn('polling failed', { error, retryInMs: backoffMs })
        await sleep(backoffMs)
        backoffMs = Math.min(backoffMs * 2, 30000)
      }
    }
  }

  /** Поставить обновление в очередь его чата, сохраняя порядок внутри чата. */
  enqueueUpdate(update) {
    // Обновления приходят нормализованными от адаптера: сообщение или нажатие
    // кнопки, и у обоих есть свой чат. Нажатия встают в очередь вместе с чатом,
    // поэтому порядок внутри разговора сохраняется.
    const key = String(update.chat?.id ?? 'unknown')
    const previous = this.chains.get(key) ?? Promise.resolve()
    const task = previous.then(
      () => (update.kind === 'callback' ? this.handleCallback(update) : this.handleMessage(update)),
      () => (update.kind === 'callback' ? this.handleCallback(update) : this.handleMessage(update)),
    ).catch((error) => this.logger.error('update handling failed', { error, updateId: update.id }))
    // Удаляем завершённую цепочку и её запись в карте: иначе `chains` растёт с
    // каждым чатом, который бот когда-либо видел.
    const tracked = task.finally(() => {
      this.inFlight.delete(tracked)
      if (this.chains.get(key) === tracked) this.chains.delete(key)
    })
    this.inFlight.add(tracked)
    this.chains.set(key, tracked)
  }

  /** Шаги 1–2: разбор, доступ, команда или текст — в `core/conversation.mjs`. */
  async handleMessage(message) {
    return this.conversation.handleMessage(message)
  }

  /**
   * Сообщить владельцу, что что-то сломалось.
   *
   * Отправляется через адаптер платформы, а не через модель: самая частая
   * поломка — сама модель, и предупреждение должно её пережить. Не чаще одного
   * раза в час, чтобы сломанный провайдер не завалил чат.
   *
   * @param {string} text - короткое человекочитаемое описание.
   * @param {object} [options] - `urgent` обходит кулдаун.
   */
  async alertOwner(text, { urgent = false } = {}) {
    const chatId = this.config.alerts?.chatId ?? [...(this.config.access?.allowedUserIds ?? [])][0]
    if (chatId === undefined) return
    const now = Date.now()
    if (!urgent && now - this.lastAlertAt < ALERT_COOLDOWN_MS) return
    this.lastAlertAt = now
    this.logger.warn('alert sent to the owner', { chatId, text: truncate(text, 120) })
    await this.platform.sendText({ chatId, markdown: `🚨 ${text}` }).catch((error) => {
      this.logger.error('alert delivery failed', { error })
    })
  }

  /** Учесть сбой модели и предупредить, когда их накопилось достаточно. */
  noteModelFailure(error) {
    const now = Date.now()
    this.failures.push(now)
    // Оставляем только недавнее окно: старый сбой не должен идти в счёт новому
    // предупреждению.
    this.failures = this.failures.filter((at) => now - at < ALERT_WINDOW_MS)
    if (this.failures.length < ALERT_FAILURES) return
    this.failures = []
    const detail = String(error?.message ?? error ?? 'неизвестная ошибка').slice(0, 200)
    void this.alertOwner(`Модель не отвечает (${ALERT_FAILURES} ошибки подряд): ${detail}`)
  }
  /**
   * Писать ответ в сообщение, пока модель ещё его генерирует.
   *
   * Логика стриминга, троттлинга и правок живёт в `src/delivery/stream.mjs`:
   * здесь остаётся только передать платформу, логгер и настройку троттлинга.
   *
   * @param {number|string} chatId - целевой чат.
   * @returns {object} стример из модуля доставки.
   */
  createStreamer(chatId) {
    return createStreamer({
      platform: this.platform,
      logger: this.logger,
      throttleMs: this.config.stream?.throttleMs ?? 900,
    }, chatId)
  }

  /**
   * Отправить ответ голосовым сообщением, если чат об этом попросил.
   *
   * Ошибки логируются и никогда не ломают ход: пропавший голос — меньшая
   * проблема, чем пропавший ответ.
   *
   * @param {number|string} chatId - чат.
   * @param {string} text - только что отправленный ответ.
   * @param {object} message - входящее сообщение, для ссылки на ответ.
   */
  async speakAnswer(chatId, text, message) {
    if (!this.tts || typeof this.platform.sendVoice !== 'function') return
    if (!this.history.voice(chatId)) return
    try {
      const bytes = await this.tts(text)
      await this.platform.sendVoice({
        chatId,
        bytes,
        ...(message?.messageId === undefined ? {} : { replyToMessageId: message.messageId }),
      })
      this.logger.info('voice answer sent', { chatId, bytes: bytes.length })
    } catch (error) {
      this.logger.warn('voice answer failed', { chatId, error: error?.message })
    }
  }

  /**
   * Поставить эмодзи-реакцию на сообщение, если платформа её поддерживает.
   *
   * Ошибки намеренно игнорируются: реакции — украшение, а Telegram отказывает
   * в них для некоторых чатов и эмодзи.
   */
  async react(message, emoji) {
    if (!this.config.reactions?.enabled) return
    if (typeof this.platform.setReaction !== 'function' || message.messageId === undefined) return
    try {
      await this.platform.setReaction({ chatId: message.chat.id, messageId: message.messageId, emoji })
    } catch (error) {
      this.logger.debug('reaction failed', { error: error?.description ?? error?.message })
    }
  }

  /** Нажатие кнопки: отмена и перенос напоминания, голос в опросе — в конвейере. */
  async handleCallback(update) {
    return this.conversation.handleCallback(update)
  }

  /** Схема инструмента поиска по истории (совместимость со старым API). */
  historyToolDefinition() {
    return this.tools.definitionOf('find_history')
  }

  /**
   * Найти в истории этого чата и собрать готовый ответ.
   *
   * Сам поиск и форматирование живут в инструменте `find_history`; ядро только
   * передаёт ключ чата и текст запроса.
   *
   * @param {string} chatKey - ключ чата для истории.
   * @param {string} query - что искать.
   * @returns {Promise<string>} готовый текст ответа.
   */
  async searchHistory(chatKey, query) {
    return this.tools.executeTool('find_history', { query }, { chatId: chatKey })
  }

  /** Кто голосовал в опросе — по отображаемому имени, где оно известно. */
  namesOf(poll) {
    // Отображаемое имя — правило домена профилей.
    return this.domain.profiles.namesOf(poll)
  }

  /**
   * Кликабельное меню команд для платформ без списка «/» как в Telegram.
   *
   * VK не показывает подсказки команд, поэтому частые команды уходят кнопками:
   * нажатие отправляет подпись, а подпись *и есть* команда.
   *
   * @returns {object|undefined} нейтральная клавиатура или undefined на других платформах.
   */
  menuKeyboard() {
    if (this.platform.name !== 'vk') return undefined
    return {
      rows: [
        [{ text: '/reminders' }, { text: '/calendar' }],
        [{ text: '/digest' }, { text: '/help' }],
      ],
    }
  }

  /** Нейтральная клавиатура для созданного напоминания; её рисует адаптер. */
  reminderKeyboard(reminderId) {
    return {
      rows: [
        [{ text: '⏰ Отложить на 10 минут', data: `snooze:10:${reminderId}` }],
        [{ text: '✖️ Отменить', data: `cancel:${reminderId}` }],
      ],
    }
  }

  /** Есть ли у пользователя доступ — проверка живёт в конвейере. */
  isAllowed(userId) {
    return this.conversation.isAllowed(userId)
  }

  /** Сообщить незнакомцу его id — логика и кулдаун в конвейере. */
  async deny(userId, chatId) {
    return this.conversation.deny(userId, chatId)
  }

  /** Исполнить команду через маршрутизатор `src/core/commands.mjs`. */
  async runCommand({ name, args }, message) {
    return this.commands.runCommand({ name, args }, message)
  }

  /** Один ход модели для чата и доставка ответа — в `core/conversation.mjs`. */
  async reply(message, prompt) {
    return this.conversation.reply(message, prompt)
  }

  /** Контекст группы — в `core/conversation.mjs`. */
  groupContext(chatKey, authorName) {
    return this.conversation.groupContext(chatKey, authorName)
  }

  /** Системное сообщение о том, что умеет эта сборка. */
  capabilitiesHint() {
    return capabilityHint(this.capabilities)
  }

  /** Подсказка о характере и настроении — в `core/conversation.mjs`. */
  characterHint(userId) {
    return this.conversation.characterHint(userId)
  }

  /** Подсказка о режиме ответа — в `core/conversation.mjs`. */
  modeHint(userId) {
    return this.conversation.modeHint(userId)
  }

  /** Автоматическая память о фактах — в `core/conversation.mjs`. */
  async rememberStatedFacts(userId, prompt) {
    return this.conversation.rememberStatedFacts(userId, prompt)
  }

  /** Местное время напоминания в настроенном часовом поясе. */
  formatReminderTime(dueAt) {
    return this.domain.reminders.formatTime(dueAt)
  }

  /**
   * Отправить сгенерированный файл в чат.
   *
   * Платформы без поддержки файлов получают объяснение вместо тишины, а
   * сорвавшаяся отправка не ломает ход: текстовый ответ уже доставлен.
   *
   * @param {number|string} chatId - целевой чат.
   * @param {object} file - `{ bytes, fileName, caption }`.
   * @param {number|string} [replyToMessageId] - сообщение, на которое отвечаем.
   * @returns {Promise<boolean>} отправлен ли файл.
   */
  async sendFile(chatId, { bytes, fileName, caption }, replyToMessageId) {
    if (!bytes || !bytes.length) return false
    if (typeof this.platform.sendDocument !== 'function') {
      this.logger.warn('platform cannot send files', { platform: this.platform.name, fileName })
      await this.send(chatId, `Файл «${fileName}» готов, но эта платформа не умеет отправлять файлы.`).catch(() => {})
      return false
    }
    try {
      await this.platform.sendDocument({ chatId, bytes, fileName, caption, replyToMessageId })
      this.logger.info('file sent', { chatId, fileName, bytes: bytes.length })
      return true
    } catch (error) {
      this.logger.warn('file send failed', { error: error?.description ?? error?.message, chatId, fileName })
      await this.send(chatId, `Не удалось отправить файл «${fileName}». Попробуйте ещё раз.`).catch(() => {})
      return false
    }
  }

  /**
   * Доставить сработавшее напоминание.
   *
   * @param {object} reminder - сохранённое напоминание.
   * @param {object} [info] - `lateNotice` помечает напоминания, просроченные к старту.
   */
  async deliverReminder(reminder, { lateNotice = false } = {}) {
    // Сначала тихие часы: напоминание, которое сработало бы в 03:00,
    // переносится на конец окна, а не будит никого.
    const quietEnd = this.quietHoursEnd(new Date())
    if (quietEnd) {
      try {
        // Перенос на утро — правило домена напоминаний.
        const moved = await this.domain.reminders.postponeForQuietHours(reminder, quietEnd)
        this.logger.info('reminder postponed by quiet hours', { id: reminder.id, to: moved?.dueAt })
      } catch (error) {
        this.logger.warn('quiet hours postponement failed', { error, id: reminder.id })
      }
      return
    }
    // В группе напоминание должно называть своего владельца: в чате может быть
    // несколько человек со своими напоминаниями.
    const isGroup = reminder.userId !== undefined && reminder.chatId !== reminder.userId
    const owner = isGroup ? this.domain.profiles.displayName(reminder.userId) : undefined
    await this.send(reminder.chatId, this.domain.reminders.deliveryText(reminder, { lateNotice, owner }))
  }

  /**
   * Сообщение от агента о готовой задаче.
   *
   * Доставляется в чат владельца и записывается в историю: иначе ответ пользователя
   * уйдёт в пустоту, ведь бот не знает, что агент ему писал.
   *
   * @param {object} message - текст сообщения и необязательный chatId.
   * @returns {Promise<{chatId: number, messageId: number|undefined}>} куда доставлено.
   */
  async deliverAgentMessage({ text, chatId } = {}) {
    const body = String(text ?? '').trim()
    if (body === '') throw new Error('пустое сообщение агента')
    const owner = chatId ?? [...(this.config.access?.allowedUserIds ?? [])][0]
    if (!owner) throw new Error('некому доставить сообщение агента')
    const result = await this.send(owner, body)
    await this.history?.append?.(String(owner), { role: 'assistant', content: body })
    return { chatId: owner, messageId: result?.messageId }
  }

  /**
   * Когда заканчивается тихое окно, если текущий момент внутри него.
   *
   * @param {Date} now - момент для проверки.
   * @returns {Date|undefined} конец окна или undefined, если сейчас не тихо.
   */
  quietHoursEnd(now) {
    // Расчёт тихого часа и обработка ошибок — правило домена напоминаний.
    return this.domain.reminders.quietHoursEnd(now)
  }

  /** Собрать и отправить утренний дайджест в один чат. */
  async deliverDigest(chatId, userId) {
    if (!this.digest) return
    const text = await this.digest.build(chatId, userId)
    await this.send(chatId, text)
  }

  /**
   * Добавить один вызов модели к счётчикам дня.
   *
   * Учёт не должен ломать ответ: сбой здесь логируется и отбрасывается.
   */
  recordUsage(userId, chatId, usage) {
    if (!this.usage || !usage) return
    try {
      this.usage.record({ usage, userId, chatId, timeZone: this.config.time?.timeZone ?? '' })
      this.checkSpend()
    } catch (error) {
      this.logger.warn('usage accounting failed', { error, chatId })
    }
  }

  /**
   * Один раз в день предупредить, что бюджет токенов почти израсходован.
   *
   * Работает на пути учёта, а не по таймеру, поэтому предупреждение приходит
   * вместе с первым ответом, который перешёл черту.
   */
  checkSpend() {
    const limit = this.usage?.dailyLimit ?? 0
    if (limit <= 0) return
    const zone = this.config.time?.timeZone ?? ''
    const day = dayKey(new Date(), zone)
    if (this.spendAlertDay === day) return
    const spent = this.usage.tokens(new Date(), zone)
    if (spent < limit * SPEND_ALERT_RATIO) return
    this.spendAlertDay = day
    const percent = Math.round((spent / limit) * 100)
    this.logger.warn('token budget almost spent', { spent, limit, percent })
    void this.alertOwner(`Израсходовано ${percent}% дневного лимита токенов (${spent} из ${limit}). Сводка — /stats.`)
  }

  /**
   * Отправить ответ.
   *
   * Разбиение, разметка и повтор простым текстом принадлежат адаптеру
   * платформы, поэтому ядро только передаёт markdown и необязательную
   * нейтральную клавиатуру.
   */
  async send(chatId, markdown, replyToMessageId, keyboard) {
    return this.platform.sendText({ chatId, markdown, replyToMessageId, keyboard })
  }

  /** Повторять действие «печатает», пока идёт вызов модели. */
  startTyping(chatId) {
    const tick = () => {
      this.platform.sendTyping({ chatId }).catch((error) => this.logger.debug('typing failed', { error }))
    }
    tick()
    const timer = setInterval(tick, TYPING_INTERVAL_MS)
    timer.unref?.()
    return { stop: () => clearInterval(timer) }
  }

  async loadOffset() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.offsetFile, 'utf8'))
      // Курсор не всегда число: VK использует строковый ts долгого опроса, и
      // его потеря заставляла бота перечитывать всё сначала и терять события.
      const saved = parsed?.offset
      if (Number.isInteger(saved) || (typeof saved === 'string' && saved !== '')) this.offset = saved
      this.logger.info('offset loaded', { offset: this.offset ?? null })
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger.warn('offset file ignored', { error })
    }
  }

  /**
   * Писать периодическую строку о живости.
   *
   * Процесс, работающий круглосуточно, иначе молчит, а на вопрос «он жив?»
   * должно быть можно ответить по одному логу, не подключая отладчик и не
   * проверяя сокет.
   */
  startHeartbeat() {
    const periodMs = this.config.limits.heartbeatMs
    if (!periodMs) return
    this.heartbeat = setInterval(() => {
      this.logger.info('heartbeat', {
        uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
        chats: this.history.size,
        reminders: this.reminders ? this.reminders.store.list().length : 0,
        inFlight: this.inFlight.size,
      })
    }, periodMs)
    this.heartbeat.unref?.()
  }

  scheduleOffsetSave() {
    if (this.offsetTimer) return
    this.offsetTimer = setTimeout(() => {
      this.offsetTimer = null
      void this.flushOffset()
    }, 500)
    this.offsetTimer.unref?.()
  }

  /**
   * Предупредить владельца до того, как диск заполнится.
   *
   * Бот однажды молча пережил заполненный диск, пока удалённый сторож был
   * недоступен, и потерял курсор опроса из-за оборванной записи. Страдающий
   * процесс — лучший свидетель, поэтому он говорит сам — не чаще раза в час.
   */
  async freeDiskMb() {
    const target = this.offsetFile ? path.dirname(this.offsetFile) : this.config.dataDir
    const stats = await fs.statfs(target)
    return Math.round((stats.bavail * stats.bsize) / (1024 * 1024))
  }

  async checkDiskSpace() {
    if (this.diskWarnedAt && Date.now() - this.diskWarnedAt < 3_600_000) return
    try {
      const freeMb = await this.freeDiskMb()
      if (freeMb >= 200) return
      this.diskWarnedAt = Date.now()
      this.logger.warn('low disk space', { freeMb })
      await this.alertOwner(`💾 Мало места на диске: ${freeMb} МБ. Скоро бот не сможет сохранять состояние.`).catch(() => {})
    } catch (error) {
      this.logger.debug('disk check failed', { error: error?.message ?? error })
    }
  }

  async flushOffset() {
    if (this.offsetTimer) {
      clearTimeout(this.offsetTimer)
      this.offsetTimer = null
    }
    if (this.offset === undefined) return
    try {
      await fs.mkdir(path.dirname(this.offsetFile), { recursive: true })
      // Атомарно и с проверкой длины: запись прямо в файл сначала обрезает его,
      // и однажды полный диск оставил курсор в 0 байт, а после рестарта бот
      // перечитал бы всю очередь.
      const payload = `${JSON.stringify({ offset: this.offset })}\n`
      const temporary = `${this.offsetFile}.tmp`
      await fs.writeFile(temporary, payload, 'utf8')
      const written = await fs.stat(temporary)
      if (written.size !== Buffer.byteLength(payload)) throw new Error(`короткая запись: ${written.size} из ${Buffer.byteLength(payload)}`)
      await fs.rename(temporary, this.offsetFile)
    } catch (error) {
      this.logger.warn('offset save failed', { error: error?.message ?? error })
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Прежний публичный экспорт разбора команд. */
export { parseCommand } from './core/commands.mjs'

/**
 * Совместимый псевдоним: раньше класс умел только Telegram.
 *
 * @deprecated используйте `Assistant`.
 */
export const TelegramAgentBot = Assistant
