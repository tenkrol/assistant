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
import { AsyncLocalStorage } from 'node:async_hooks'
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

/**
 * Паузы перед повтором `getUpdates` после подряд идущих ошибок.
 *
 * Последовательность 1→2→5→15→30 секунд: короткие обрывы проходят почти
 * незаметно, а затяжная сетевая авария не превращается в поток запросов.
 * После пятой ошибки пауза остаётся максимальной.
 */
const POLL_PAUSES_MS = [1000, 2000, 5000, 15000, 30000]
/** После стольких ошибок подряд владелец один раз узнаёт об обрыве. */
const POLL_ALERT_AFTER = 3

/** Пауза перед следующим опросом после `failures` ошибок подряд. */
const pollPauseMs = (failures) => POLL_PAUSES_MS[Math.min(Math.max(failures, 1), POLL_PAUSES_MS.length) - 1]

/** Человеческое имя платформы для служебного сообщения владельцу. */
const platformTitle = (name) => ({ telegram: 'Telegram', vk: 'VK', max: 'MAX' })[name] ?? String(name ?? 'платформой')

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
   * @param {object} [options.access] - единая проверка доступа к пространствам.
   * @param {object} [options.scopes] - `{ store }` пространств.
   * @param {object} options.logger - логгер.
   * @param {(ms: number) => Promise<void>} [options.sleep] - пауза между повторами; подменяется в тестах.
   */
  constructor({ config, platform, model, history, webTools, agentBridge, agentLink, reminders, profiles, usage, digest, media, tts, files, documents, events, polls, youtube, server, access, scopes, logger, sleep = defaultSleep }) {
    this.config = config
    // Пространства и доступ: единственная точка проверки для всех хранилищ.
    this.access = access
    this.scopes = scopes
    // Кого бот знает: имена и @ники приходят с сообщениями, телефоны — только
    // когда человек сам делится контактом. Нужно для sendto.
    this.contacts = createContactStore({ file: this.config.dataDir ? `${this.config.dataDir}/contacts.json` : undefined, logger, access })
    // Ядро общается только с одним адаптером; см. src/platforms/port.mjs.
    this.platform = platform
    /** Необязательный web push: { notify({chatId, text}) }. */
    this.webPush = null
    // Контекст веб-запроса: ответы, файлы и стриминг складываются сюда, а не
    // уходят в Telegram. AsyncLocalStorage не смешивает параллельные запросы.
    this.delivery = new AsyncLocalStorage()
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
    // Документы как источник ответов: приём, поиск с ACL и цитаты.
    this.documents = documents
    // Локальный календарь: события, которые бот записывает и показывает.
    this.events = events
    // Опросы, конспекты видео и самодиагностика.
    this.polls = polls
    this.youtube = youtube
    this.server = server
    // Правила предметной области: ядро только зовёт их и доставляет ответ.
    // Домены не знают ни про платформу, ни про сеть — им передаются данные и store.
    this.domain = {
      profiles: rulesOfProfiles({ store: profiles?.store, access, history, logger }),
      reminders: rulesOfReminders({ store: reminders?.store, timeZone: config.time?.timeZone ?? '', quiet: config.quiet, logger, access }),
      events: rulesOfEvents({ store: events?.store, reminders: reminders?.store, timeZone: config.time?.timeZone ?? '', logger, access }),
      polls: rulesOfPolls({ store: polls?.store, access }),
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
      documents: documents?.tool,
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
    // Пауза вынесена в поле: тесты поллинга проверяют последовательность
    // 1→2→5→15→30 секунд, не дожидаясь её на самом деле.
    this.sleep = sleep
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
        await this.sleep(waitMs)
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
      this.sleep(this.config.limits.shutdownGraceMs),
    ])
    await this.reminders?.scheduler?.stop()
    this.digest?.stop()
    await this.usage?.flush()
    await this.flushOffset()
    await this.history.flush()
    this.logger.info('bot stopped', { chats: this.history.size })
  }

  /**
   * Опрашивать платформу до остановки.
   *
   * Ошибки считаются подряд: пауза растёт по `POLL_PAUSES_MS`, на третьей
   * ошибке владелец получает одно сообщение об обрыве, а первый успех после
   * такой серии — одно сообщение о восстановлении. Короткий сбой из одной-двух
   * ошибок не беспокоит владельца вовсе; счётчик сбрасывает только успех.
   */
  async pollLoop() {
    let failures = 0
    // Был ли уже отправлен алерт: сообщение о восстановлении нужно ровно
    // после той серии, о которой владелец узнал.
    let alerted = false
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
        if (failures > 0) {
          this.logger.info('polling restored', { failures })
          if (alerted) {
            // Один успех закрывает серию: сообщаем один раз, дальше не спамим.
            await this.notifyOwner(`✅ Связь восстановлена: ${platformTitle(this.platform?.name)} снова отвечает.`)
            alerted = false
          }
          failures = 0
        }
        if (cursor !== undefined && cursor !== this.offset) {
          this.offset = cursor
          this.scheduleOffsetSave()
        }
        for (const update of updates) this.enqueueUpdate(update)
      } catch (error) {
        if (!this.running) break
        failures += 1
        const retryInMs = pollPauseMs(failures)
        this.logger.warn('polling failed', { error, failures, retryInMs })
        if (failures === POLL_ALERT_AFTER) {
          alerted = true
          await this.notifyOwner(`⚠️ Нет связи с ${platformTitle(this.platform?.name)}: ${failures} ошибки getUpdates подряд. Повторяю с паузой, часть сообщений может не дойти.`)
        }
        await this.sleep(retryInMs)
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
    return tracked
  }

  /** Шаги 1–2: разбор, доступ, команда или текст — в `core/conversation.mjs`. */
  async handleMessage(message) {
    // В общем чате второму участнику нужно уведомление, даже если он не на сайте.
    if (!message?.web && (message?.chat?.type ?? 'private') !== 'private' && message?.from && !message.from.isBot) {
      const text = String(message.text ?? '').trim()
      if (text !== '') void this.webPush?.notify?.({ chatId: message.chat.id, text })?.catch?.(() => {})
    }
    return this.conversation.handleMessage(message)
  }

  /**
   * Сообщение с сайта: прогнать через тот же конвейер, но ответы не отправлять
   * в Telegram, а вернуть вызывающему.
   *
   * Ответы, файлы и стриминг складываются в контекст `AsyncLocalStorage`, поэтому
   * параллельные Telegram-обновления не перепутаются с веб-запросом. Работа чата
   * сериализуется тем же `enqueueUpdate`, что и обычные сообщения.
   *
   * @param {object} input - `userId`, `chatId`, `text`, `name`.
   * @returns {Promise<{sends: object[], files: object[]}>} ответы для сайта.
   */
  async handleWebMessage({ userId, chatId, text, name, chatType = 'private', chatTitle, replyTo, attachments = [], onDelta, webOnly = false, projectInstructions = '' } = {}) {
    const delivery = {
      sends: [],
      files: [],
      chatId: String(chatId ?? userId),
      ...(typeof onDelta === 'function' ? { onDelta } : {}),
    }
    const normalizedAttachments = (Array.isArray(attachments) ? attachments : [])
      .filter((item) => item && Buffer.isBuffer(item.bytes) && item.bytes.length > 0)
      .slice(0, 4)
      .map((item) => ({
        kind: ['photo', 'video', 'voice'].includes(item.kind) ? item.kind : 'photo',
        bytes: item.bytes,
        name: String(item.name || (item.kind === 'video' ? 'video.mp4' : 'photo.jpg')).slice(0, 120),
        mime: String(item.mime || (item.kind === 'video' ? 'video/mp4' : 'image/jpeg')).slice(0, 100),
        id: item.id,
        url: item.url,
        size: item.size ?? item.bytes.length,
      }))
    const message = {
      kind: 'message',
      id: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      from: { id: Number(userId), name: String(name || 'Пользователь'), isBot: false },
      chat: {
        id: typeof chatId === 'string' && chatId.startsWith('project:') ? chatId : Number(chatId ?? userId),
        type: chatType === 'supergroup' ? 'supergroup' : chatType === 'group' ? 'group' : 'private',
        ...(chatTitle ? { title: String(chatTitle) } : {}),
      },
      text: String(text ?? ''),
      attachments: normalizedAttachments,
      addressed: true,
      web: true,
      ...(replyTo && typeof replyTo.text === 'string' && replyTo.text.trim() !== ''
        ? { replyTo: { text: replyTo.text.trim().slice(0, 1000), ...(replyTo.role ? { role: replyTo.role === 'assistant' ? 'assistant' : 'user' } : {}), ...(replyTo.author ? { author: String(replyTo.author).slice(0, 80) } : {}) } }
        : {}),
    }
    const isGroup = message.chat.type !== 'private'
    const projectNote = String(projectInstructions ?? '').trim()
    if (projectNote !== '') message.projectInstructions = projectNote.slice(0, 2000)
    let relayedMessageId
    // Синхронизация с Telegram: сообщение с сайта и в личном, и в общем чате
    // пересылается ботом в тот же Telegram-чат с подписью автора.
    if (!webOnly) {
      const quoted = message.replyTo
        ? `↪ ${message.replyTo.author ? message.replyTo.author + ': ' : ''}${message.replyTo.text.slice(0, 300)}\n`
        : ''
      const caption = [`💬 ${message.from.name} (с сайта):`, quoted.trim(), message.text.trim()].filter(Boolean).join('\n')
      if (message.attachments.length > 0) {
        for (const [index, attachment] of message.attachments.entries()) {
          const method = attachment.kind === 'video' ? 'sendVideo' : attachment.kind === 'voice' ? 'sendVoice' : 'sendPhoto'
          const captionText = index === 0 ? caption.slice(0, 1024) : undefined
          let relay
          try {
            relay = typeof this.platform[method] === 'function'
              ? await this.platform[method]({
                chatId: message.chat.id,
                bytes: attachment.bytes,
                fileName: attachment.name,
                mime: attachment.mime,
                caption: captionText,
                ...(attachment.kind === 'voice' ? { durationSec: attachment.durationSec } : {}),
              })
              : await this.platform.sendDocument({
                chatId: message.chat.id,
                bytes: attachment.bytes,
                fileName: attachment.name,
                caption: captionText,
              })
          } catch (error) {
            // Telegram может не принять конкретный файл (например, битое фото).
            // Это не повод терять ответ на сайте: пробуем документом, иначе логируем.
            this.logger.warn('web media relay failed, trying document', { error, kind: attachment.kind })
            try {
              relay = await this.platform.sendDocument({
                chatId: message.chat.id,
                bytes: attachment.bytes,
                fileName: attachment.name,
                caption: captionText,
              })
            } catch (fallbackError) {
              this.logger.warn('web media document relay failed', { error: fallbackError })
            }
          }
          if (index === 0 && relay?.messageId) relayedMessageId = relay.messageId
        }
      } else if (caption.trim() !== '') {
        const relayed = await this.platform.sendText({
          chatId: message.chat.id,
          markdown: caption,
        }).catch((error) => this.logger.warn('web message relay failed', { error }))
        relayedMessageId = relayed?.messageId
      }
    }
    // В группе бот отвечает только на упоминание или ответ на своё сообщение,
    // как и в Telegram. Иначе сообщение просто уходит в общий чат.
    const aliases = [...new Set([
      this.username,
      this.platform?.identity?.username,
      this.platform?.identity?.title,
      'Tenkrol',
    ].map((value) => String(value ?? '').replace(/^@/, '').trim()).filter(Boolean))]
    const mentioned = aliases.some((alias) => new RegExp('@' + alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9_])', 'i').test(message.text))
    const replyToBot = Boolean(message.replyTo && message.replyTo.role === 'assistant')
    if (isGroup && !mentioned && !replyToBot) {
      await this.history?.append?.(
        String(message.chat.id),
        {
          role: 'user',
          content: message.text,
          ...(message.from.name ? { author: message.from.name } : {}),
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          ...(Array.isArray(message.attachments) && message.attachments.length > 0
            ? { attachments: message.attachments.filter((item) => item && item.url).map((item) => ({ id: item.id, kind: item.kind, name: item.name, mime: item.mime, size: item.size, url: item.url })) }
            : {}),
        },
        {},
      )
      return { sends: [], files: [], silent: true }
    }
    if (relayedMessageId) message.telegramMessageId = relayedMessageId
    const task = this.delivery.run(delivery, () => this.enqueueUpdate(message))
    await task
    if (delivery.sends.length === 0 && delivery.files.length === 0) {
      delivery.sends.push({ text: 'Не удалось получить ответ. Попробуйте ещё раз.' })
    }
    if (!webOnly) {
      for (const send of delivery.sends) {
        if (String(send.text ?? '').trim() === '') continue
        await this.platform.sendText({
          chatId: message.chat.id,
          markdown: send.text,
          ...(send.keyboard ? { keyboard: send.keyboard } : {}),
          ...(relayedMessageId ? { replyToMessageId: relayedMessageId } : {}),
        }).catch((error) => this.logger.warn('web reply relay failed', { error }))
      }
      for (const file of delivery.files) {
        await this.platform.sendDocument({
          chatId: message.chat.id,
          bytes: file.bytes,
          fileName: file.fileName,
          caption: file.caption,
          ...(relayedMessageId ? { replyToMessageId: relayedMessageId } : {}),
        }).catch((error) => this.logger.warn('web file relay failed', { error }))
      }
    }
    return delivery
  }

  /** Чат владельца: явный ALERTS_CHAT_ID или первый разрешённый пользователь. */
  ownerChatId() {
    return this.config.alerts?.chatId ?? [...(this.config.access?.allowedUserIds ?? [])][0]
  }

  /**
   * Служебное сообщение владельцу без часового кулдауна алертов.
   *
   * Поллингу нужно ровно одно сообщение об обрыве и одно о восстановлении:
   * кулдаун, защищающий от потока ошибок модели, не должен проглотить второе.
   *
   * @param {string} text - короткое человекочитаемое сообщение.
   */
  async notifyOwner(text) {
    const chatId = this.ownerChatId()
    if (chatId === undefined) return
    this.logger.info('owner notified', { chatId, text: truncate(text, 120) })
    try {
      await this.send(chatId, text)
    } catch (error) {
      this.logger.error('owner notification failed', { error })
    }
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
    if (this.delivery.getStore()) return
    const chatId = this.ownerChatId()
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
    const delivery = this.delivery.getStore()
    if (delivery) {
      return {
        onDelta(chunk) {
          delivery.onDelta?.(String(chunk ?? ''))
        },
        async finish(text, keyboard) {
          delivery.sends.push({ text: String(text ?? ''), ...(keyboard ? { keyboard } : {}) })
          return true
        },
      }
    }
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
    if (this.delivery.getStore()) return
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
    if (this.delivery.getStore()) return
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
    const delivery = this.delivery.getStore()
    if (delivery && String(chatId) === String(delivery.chatId)) {
      delivery.files.push({ fileName, caption, bytes: Buffer.from(bytes) })
      return true
    }
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
    // Отозванный доступ действует и на ожидающие доставки уведомления: если
    // автора больше нет в пространстве, напоминание молча снимается.
    if (this.access && reminder.userId !== undefined && !this.access.canRead(reminder.userId, reminder)) {
      this.logger.warn('reminder skipped: access revoked', { id: reminder.id, userId: reminder.userId })
      return
    }
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
    const text = this.domain.reminders.deliveryText(reminder, {
      lateNotice,
      owner,
      // Пояс нужен для «было на DD.MM HH:MM» в пометке догона.
      timeZone: this.config.time?.timeZone ?? '',
    })
    await this.send(reminder.chatId, text)
    void this.webPush?.notify?.({ chatId: reminder.chatId, text })?.catch?.(() => {})
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
    void this.webPush?.notify?.({ chatId: owner, text: body })?.catch?.(() => {})
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
    void this.webPush?.notify?.({ chatId, text })?.catch?.(() => {})
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
    const delivery = this.delivery.getStore()
    if (delivery && String(chatId) === String(delivery.chatId)) {
      delivery.sends.push({ text: String(markdown ?? ''), ...(keyboard ? { keyboard } : {}) })
      return { messageId: undefined }
    }
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

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Прежний публичный экспорт разбора команд. */
export { parseCommand } from './core/commands.mjs'

/**
 * Совместимый псевдоним: раньше класс умел только Telegram.
 *
 * @deprecated используйте `Assistant`.
 */
export const TelegramAgentBot = Assistant
