/**
 * Bot orchestration: polling, access control, commands and reply delivery.
 *
 * Design decisions worth knowing while reading:
 *   - updates are acknowledged as soon as they are queued, so a slow model call
 *     never blocks the polling loop or other chats;
 *   - work for one chat is serialized (a conversation must stay ordered) while a
 *     global semaphore caps how many model calls run at once;
 *   - a reply is converted to Telegram HTML and split, with a plain-text retry
 *     when Telegram rejects the entities.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { formatTimeContext } from './time-context.mjs'
import { prepareAttachments } from './media-handler.mjs'
import { detectFacts } from './auto-memory.mjs'
import { MOODS, MOOD_NAMES, PERSONAS, PERSONA_NAMES, characterHint, moodOf } from './personas.mjs'
import { parsePollAction, pollKeyboard, pollMessage } from './polls.mjs'
import { SEARCH_HINT, formatSearchResults, searchMessages } from './history-search.mjs'
import { dayKey } from './usage.mjs'
import { zonedTimeToUtc } from './reminders.mjs'

/** Answer modes offered by `/mode`. */
const MODES = {
  'кратко': 'Отвечай очень коротко: 1–3 предложения, без вступлений и итогов.',
  'подробно': 'Отвечай подробно: структура, примеры, при необходимости список шагов.',
  'код': 'Отвечай как программист: только код и краткие пояснения к нему, без воды.',
  'письмо': 'Пиши в деловом стиле, готовым текстом письма, без разговорных выражений.',
  'просто': 'Объясняй простыми словами, без технического жаргона.',
}

const TYPING_INTERVAL_MS = 4000
const DENY_COOLDOWN_MS = 10 * 60 * 1000
/** Alerting: N failures inside the window trigger one message per cooldown. */
const ALERT_FAILURES = 3
const ALERT_WINDOW_MS = 10 * 60 * 1000
const ALERT_COOLDOWN_MS = 60 * 60 * 1000
/** Warn when this share of the daily token budget is spent. */
const SPEND_ALERT_RATIO = 0.8

/** The user is asking for a reminder; the tool must actually run. */
const REMINDER_INTENT = /(напомн|напомин|\bremind\b)/i
/** The answer claims a reminder with a concrete time ("напомню в 01:23"). */
const REMINDER_CLAIM = /(?:напомн\w*\s+в\s+\d|напоминание\s+(?:создано|поставлено|№))/i
/** A request for a document: a table, a letter, an export. */
const FILE_INTENT = /(таблиц|excel|эксель|xlsx|csv|документ|docx|ворд|\bword\b|презентац|отч[её]т|выгруз|файл|письм[оа]\s+в\s+docx)/i
/** The model claims a file is on its way without having built one. */
const FILE_CLAIM = /(файл\s+(?:отправлен|готов|приложен)|отправил\s+файл|во\s+вложении)/i
/** The user explicitly asks to remember something. */
const MEMORY_INTENT = /(запомн|запиши|занеси|сохрани в память)/i
/** The user states a durable fact about themselves. */
const PROFILE_ASSERTION = /(я\s+(?:живу|нахожусь|переехал|переехала|родился|родилась)|мой\s+город|меня\s+зовут|моё\s+имя|мое\s+имя|зови\s+меня|я\s+из\s+[А-ЯЁ])/i

/**
 * Whether this message asks the bot to keep something about the user.
 *
 * A question is never an assertion: "какой мой город?" must not create a fact.
 */
function isMemoryRequest(text) {
  const value = String(text ?? '').trim()
  if (MEMORY_INTENT.test(value)) return true
  if (value.endsWith('?')) return false
  return PROFILE_ASSERTION.test(value)
}

// Reply text is Markdown: `send()` converts it to Telegram HTML and escapes
// everything else, so raw HTML must never be passed in here.
const HELP = [
  "**Что я умею**",
  "",
  "• Отвечаю на вопросы, ищу в интернете и читаю страницы",
  "• Погода и прогноз, праздники, анекдот — словами, без команд",
  "• Напоминания: «напомни завтра в 9 купить хлеб» — с кнопками «отложить» и «отменить»",
  "• Календарь: «запиши стоматолога 15 октября в 11:30»; дни рождения — каждый год",
  "• Утренний дайджест в 8:00: погода, предупреждения, праздники (официальные, церковные, народные), совет для здоровья, события дня, напоминания",
  "• Помню факты о вас и ваш город; в группах личное не подмешиваю",
  "• Понимаю фото и документы: PDF, DOCX, XLSX, PPTX, CSV, JSON, TXT",
  "• Голосовые: расшифрую; по команде /voice отвечаю голосом",
  "• Пришлю файл сам: Excel, Word, CSV или текстом — «сделай таблицу в Excel по этим данным»",
  "• Конспект видео: пришлите ссылку на YouTube и спросите «о чём это»",
  "• Опрос для всех: «создай опрос: куда едем — лес, река, дача» — кнопки и подсчёт голосов",
  "• Найду в нашей переписке: «что мы решали про ремонт?»",
  "• Характер и настроение: /character, /mood",
  "• Тихие часы 23:00–08:00: ночью не разбужу — перенесу напоминание на утро",
  "",
  "**Команды**",
  "",
  "Диалог",
  "/new — начать заново (контекст очищается)",
  "/model — показать или сменить модель для этого чата",
  "/mode — стиль ответов: кратко, подробно, код, письмо",
  "/character — характер бота",
  "/mood — настроение дня",
  "/voice — озвучивать ответы в этом чате",
  "",
  "Напоминания и календарь",
  "/reminders — список напоминаний",
  "/cancel <номер> — отменить напоминание",
  "/calendar — ближайшие события",
  "",
  "Память и данные",
  "/memory — что я о вас помню",
  "/forget <номер|all> — забыть факт",
  "/city <город> — город по умолчанию для погоды",
  "/search <слова> — поиск по нашей переписке",
  "/export — выгрузить ваши данные файлом",
  "",
  "Прочее",
  "/digest — прислать утренний дайджест сейчас",
  "/stats — расход токенов за сегодня",
  "/server — состояние сервера, где я работаю",
  "/whoami — ваши ID",
  "/help — эта справка",
  "",
  "**Примеры**",
  "«напомни завтра в 9 купить хлеб»",
  "«запиши приём у врача 22 октября в 10:30»",
  "«какая завтра погода в Москве»",
  "«сделай таблицу в Excel по этим данным»",
  "«пришли ссылку разбери: https://youtu.be/…»",
  "«что мы решали про ремонт?»",
].join('\n')

/** Human name of the messenger this process serves. */
const PLATFORM_LABEL = { telegram: 'Telegram', vk: 'VK', 'vk-teams': 'VK Teams', max: 'MAX' }

/**
 * What this deployment can actually do.
 *
 * The list is built from the configuration, not from hope: a bot without a
 * transcriber must not promise voice input, and a bot without Home Assistant
 * credentials must not promise to switch the lights. The model gets it as a
 * system message, and `/help` prints it to the user.
 *
 * @param {object} options - configuration and wired capabilities.
 * @param {object} options.config - loaded configuration.
 * @param {object} [options.media] - `{ transcribe, extractText }`.
 * @param {string} options.platformName - `telegram`, `vk`, `vk-teams` or `max`.
 * @returns {Array<string>} one line per capability.
 */
function capabilityLines({ config, media, platformName }) {
  const messenger = PLATFORM_LABEL[platformName] ?? platformName
  // Every line says what the thing does *and* how to ask for it: this list is what
  // the model repeats when the user asks "что ты умеешь".
  const lines = [
    `Ты работаешь в мессенджере ${messenger} и помнишь контекст последних сообщений в чате.`,
    '— отвечать на вопросы обычными словами;',
    '— искать в интернете и читать страницы: «что нового по ИИ», «прочитай ссылку»;',
    '— погода, праздники, анекдот: «какая завтра погода в Москве»;',
    '— календарь: «запиши стоматолога 15 октября в 11:30»; список — /calendar;',
    '— напоминания: «напомни завтра в 9 купить хлеб»; список — /reminders, отмена — /cancel <номер>;',
    '— память: «запомни, меня зовут …»; показать — /memory, забыть — /forget, город — /city;',
    '— стиль ответов: /mode (кратко, подробно, код, письмо, просто);',
    '— характер и настроение дня: /character, /mood;',
    '— фотографии: пришлите фото и спросите «что тут» или «прочитай текст»;',
    '— прислать файл: «сделай таблицу в Excel по этим данным», «оформи письмо документом», «собери отчёт файлом» — придёт документ;',
    '— поиск по прошлой переписке: /search слово или вопрос «что мы решали про ремонт?»;',
    '— конспект видео: пришлите ссылку на YouTube и спросите «о чём это» — вытащу субтитры и перескажу;',
    '— опрос для всех: «создай опрос, куда едем в выходные: лес, река, дача» — с кнопками и подсчётом голосов;',
  ]
  if (media?.extractText) {
    lines.push('— документы (PDF, DOCX, XLSX, PPTX, CSV, JSON, TXT): пришлите файл и спросите «что в нём», «посчитай итоги»;')
  }
  if (media?.transcribe) {
    lines.push('— голосовые: запишите голосом — расшифрую и выполню; отвечать голосом — /voice вкл в этом чате;')
  }
  if (config?.smartHome?.baseUrl && config?.smartHome?.token) {
    lines.push('— умный дом через Home Assistant: «включи свет на кухне», «какая температура дома»;')
  }
  if (config?.digest?.enabled) {
    lines.push('— утренний дайджест в 8:00: погода, праздники (официальные, церковные, народные и профессиональные), совет для здоровья, напоминания на день, анекдот; прислать сейчас — /digest;')
  }
  lines.push('— выгрузка своих данных (память, напоминания, история) — /export; расход токенов — /stats; начать диалог заново — /new; ваш ID — /whoami; полная справка — /help.')
  return lines
}

/**
 * The system message that teaches the model its own abilities.
 *
 * @param {Array<string>} lines - capability lines.
 * @returns {string} the hint, including the rule about honest answers.
 */
function capabilityHint(lines) {
  return [
    'Твои возможности в этой сборке (это факт, а не предположение):',
    ...lines,
    'Изображения и файлы, присланные вложением, уже переданы тебе в этом сообщении: опиши то, что видишь, '
    + 'и никогда не утверждай, что картинка не пришла, если вложение было. '
    + 'Если пользователь спрашивает, что ты умеешь — перечисли это коротко и по-русски. '
    + 'Чего нет в списке, того у тебя нет: не обещай этого и не выдумывай новые умения.',
  ].join('\n')
}

/**
 * The user-facing version of the same list, for `/help`.
 *
 * @param {Array<string>} lines - capability lines.
 * @returns {string} markdown bullet list.
 */
function capabilityHelp(lines) {
  return ['**Что умеет этот бот**', ...lines.map((line) => (line.startsWith('—') ? line : `— ${line}`))].join('\n')
}

/** Simple counting semaphore for the global model-call cap. */
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
   * @param {object} options - bot options.
   * @param {object} options.config - output of `loadConfig`.
   * @param {object} options.telegram - {@link TelegramClient}.
   * @param {object} options.model - {@link ChatModel}.
   * @param {object} options.history - {@link HistoryStore}.
   * @param {object} [options.webTools] - web tool executor from `createWebTools`.
   * @param {object} [options.reminders] - `{ store, tool, scheduler }` from the reminders modules.
   * @param {object} [options.profiles] - `{ store, tool }` from the profile modules.
   * @param {object} [options.usage] - token accounting store.
   * @param {object} [options.digest] - morning digest service.
   * @param {object} options.logger - logger.
   */
  constructor({ config, platform, model, history, webTools, agentBridge, reminders, profiles, usage, digest, media, tts, files, events, polls, youtube, server, logger }) {
    this.config = config
    // The core talks to one adapter only; see src/platforms/port.mjs.
    this.platform = platform
    this.model = model
    this.history = history
    this.webTools = webTools
    this.agentBridge = agentBridge
    this.reminders = reminders
    this.profiles = profiles
    this.usage = usage
    this.digest = digest
    /** `{ transcribe, extractText }` — photos, voice notes and documents. */
    this.media = media
    /** Optional `(text) => Promise<Buffer>` speech synthesiser. */
    this.tts = tts
    // Builds documents the user can open; the platform adapter sends them.
    this.files = files
    // Local calendar: events the bot books and lists.
    this.events = events
    // Polls, video summaries and self-diagnostics.
    this.polls = polls
    this.youtube = youtube
    this.server = server
    // Built once from the configuration: the model and /help describe exactly what
    // this deployment can do, never more.
    this.capabilities = capabilityLines({ config, media, platformName: platform?.name })
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
    // Telegram keeps the original file name, so an existing offset survives the
    // move to adapters; other platforms get their own file.
    const offsetName = platform.name === 'telegram' ? 'offset.json' : `offset-${platform.name}.json`
    this.offsetFile = path.join(config.dataDir, offsetName)
    this.offsetTimer = null
    /** Timestamps of recent model failures, for the alert threshold. */
    this.failures = []
    this.lastAlertAt = 0
    this.spendAlertDay = undefined
  }

  /**
   * Resolve the identity, drop any webhook, and start polling.
   *
   * A transient network failure at boot is retried; a rejected token fails
   * immediately, because retrying it can only delay a readable error.
   */
  async start({ attempts = this.config.limits.startupAttempts } = {}) {
    await this.resolveIdentity(attempts)
    this.shutdown = new AbortController()
    this.logger.info('bot identity resolved', { platform: this.platform.name, id: this.botId, username: this.username })
    await this.loadOffset()
    this.running = true
    this.startedAt = Date.now()
    this.loopPromise = this.pollLoop()
    // Started after the identity is known: the scheduler may deliver an overdue
    // reminder immediately, and it needs a working client for that.
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
   * Stop polling, drain queued work, and flush persisted state.
   *
   * In-flight model calls are aborted and the drain is bounded by
   * `shutdownGraceMs`: a supervisor sends SIGKILL after ~10 s, and state must
   * reach the disk before that happens.
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
          // Long polling must end when the process is asked to stop, otherwise a
          // restart waits for the whole poll timeout and systemd kills us.
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

  /** Queue one update for its chat, keeping per-chat order. */
  enqueueUpdate(update) {
    // Updates arrive normalised from the adapter: a message or a button tap, both
    // carrying the chat they belong to. Taps queue with their chat, so ordering
    // inside a conversation is preserved.
    const key = String(update.chat?.id ?? 'unknown')
    const previous = this.chains.get(key) ?? Promise.resolve()
    const task = previous.then(
      () => (update.kind === 'callback' ? this.handleCallback(update) : this.handleMessage(update)),
      () => (update.kind === 'callback' ? this.handleCallback(update) : this.handleMessage(update)),
    ).catch((error) => this.logger.error('update handling failed', { error, updateId: update.id }))
    // Drop the settled chain and its map entry: without this, `chains` grows
    // with every chat the bot has ever seen.
    const tracked = task.finally(() => {
      this.inFlight.delete(tracked)
      if (this.chains.get(key) === tracked) this.chains.delete(key)
    })
    this.inFlight.add(tracked)
    this.chains.set(key, tracked)
  }

  async handleMessage(message) {
    const from = message.from
    if (!from || from.isBot) return
    const chatType = message.chat?.type
    if (!this.config.access.allowedChatTypes.has(chatType)) {
      this.logger.debug('chat type ignored', { chatType })
      return
    }
    const text = String(message.text ?? '').trim()
    const attachments = message.attachments ?? []
    // A photo, a voice note or a document without any text is a valid turn too.
    if (text === '' && attachments.length === 0) return
    // Access and addressing are checked together: answering a stranger in a
    // group would publish their id to the whole chat, so there the bot only logs.
    // The adapter already decided whether the bot was addressed.
    const addressed = message.addressed
    if (!this.isAllowed(from.id)) {
      if (addressed) await this.deny(from.id, message.chat.id)
      else this.logger.debug('denied user ignored outside a private chat', { userId: from.id, chatId: message.chat.id })
      return
    }
    if (!addressed) return

    // The public platform name is what lets the bot tell people apart in a group.
    if (this.profiles?.store.touch(from.id, { firstName: from.name, username: from.username })) void this.profiles.store.flush()
    const command = parseCommand(text, this.username)
    if (command) {
      await this.runCommand(command, message)
      return
    }
    const prompt = chatType === 'private' ? text : stripMention(text, this.username)
    if (prompt.trim() === '' && attachments.length === 0) return
    // A receipt is a status: the user sees that the bot picked the message up
    // before the model has answered.
    void this.react(message, '👀')
    await this.reply(message, prompt)
  }

  /**
   * Tell the owner that something is wrong.
   *
   * Sent through the platform adapter, not through the model: the most common
   * failure is the model itself, and an alert must survive that. Rate limited to
   * one alert per hour so a broken provider cannot flood the chat.
   *
   * @param {string} text - short human-readable description.
   * @param {object} [options] - `urgent` skips the cooldown.
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

  /** Count a model failure and alert when they pile up. */
  noteModelFailure(error) {
    const now = Date.now()
    this.failures.push(now)
    // Keep only the recent window: an old failure must not count towards a new alert.
    this.failures = this.failures.filter((at) => now - at < ALERT_WINDOW_MS)
    if (this.failures.length < ALERT_FAILURES) return
    this.failures = []
    const detail = String(error?.message ?? error ?? 'неизвестная ошибка').slice(0, 200)
    void this.alertOwner(`Модель не отвечает (${ALERT_FAILURES} ошибки подряд): ${detail}`)
  }
  /**
   * Write the answer into a message while the model is still generating it.
   *
   * The first fragment creates the message, later ones edit it — no more than
   * once per throttle window, because Telegram counts edits against the same
   * rate limit as sends. \`finish()\` puts the final text (with buttons) in place
   * and reports whether the message was already delivered, so the caller does not
   * send a second copy.
   *
   * @param {number|string} chatId - target chat.
   * @returns {{onDelta: (chunk: string) => void, finish: (text: string, keyboard?: object) => Promise<boolean>}}
   */
  createStreamer(chatId) {
    const throttleMs = this.config.stream?.throttleMs ?? 900
    let buffer = ''
    let messageId
    // True while the very first send is in flight.
    let creating = false
    let lastEditAt = 0
    let queue = Promise.resolve()
    // Set when an edit fails: the caller then sends the whole answer instead.
    let lastEditOk = true

    const flush = (final = false) => {
      // Edits are serialised: two in flight would arrive out of order and show
      // an older text last.
      queue = queue.then(async () => {
        if (messageId === undefined) {
          const sent = await this.platform.sendText({ chatId, markdown: buffer })
          messageId = sent?.messageId
          return
        }
        await this.platform.editText({ chatId, messageId, markdown: buffer })
      }).catch((error) => {
        lastEditOk = false
        this.logger.debug('stream edit failed', { error: error?.description ?? error?.message })
      })
      if (final) return queue
      return undefined
    }

    return {
      onDelta: (chunk) => {
        buffer += chunk
        const now = Date.now()
        if (messageId === undefined) {
          // The first send is asynchronous: without this guard every fragment
          // arriving before it resolves would start its own message.
          if (!creating) {
            creating = true
            lastEditAt = now
            flush()
          }
          return
        }
        if (now - lastEditAt >= throttleMs) {
          lastEditAt = now
          flush()
        }
      },
      finish: async (text, keyboard) => {
        // No fragment arrived (a tool-only turn): the caller sends as usual.
        if (messageId === undefined && !creating) return false
        buffer = text
        lastEditOk = true
        await flush(true)
        creating = false
        if (messageId === undefined) return false
        if (!lastEditOk) {
          // The partial message stays, but the answer must arrive whole: the
          // caller sends it as a new message when this returns false.
          this.logger.warn('stream edits failed, sending the answer in full', { chatId })
          return false
        }
        if (keyboard) {
          await this.platform.editText({ chatId, messageId, markdown: text, keyboard }).catch(() => {})
        }
        return true
      },
    }
  }

  /**
   * Send the answer as a voice message, when this chat asked for it.
   *
   * Failures are logged and never break the turn: a missing voice is a smaller
   * problem than a missing answer.
   *
   * @param {number|string} chatId - the chat.
   * @param {string} text - the answer that was just sent.
   * @param {object} message - the incoming message, for the reply link.
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
   * Put an emoji reaction on a message, when the platform supports reactions.
   *
   * Failures are ignored on purpose: reactions are decoration, and Telegram
   * refuses them in some chats and for some emoji.
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

  /**
   * Handle an inline-button tap.
   *
   * Supported payloads: `cancel:<id>` drops a reminder, `snooze:<minutes>:<id>`
   * postpones it. Every tap is acknowledged even when nothing changed, otherwise
   * Telegram keeps the button in a loading state.
   */
  async handleCallback(update) {
    const from = update.from
    const data = String(update.callback?.data ?? '')
    const messageId = update.callback?.messageId
    if (!from || messageId === undefined) return
    if (!this.isAllowed(from.id)) {
      this.logger.info('callback from a stranger ignored', { userId: from.id })
      await this.platform.answerCallback({ callbackId: update.callback.id, text: 'Нет доступа.', alert: true }).catch(() => {})
      return
    }
    const chatId = update.chat.id
    const [action, ...rest] = data.split(':')
    let toast = 'Не понял действие'
    let outcome
    try {
      if (action === 'poll') {
        const parsed = parsePollAction(data)
        if (!parsed || !this.polls) {
          toast = 'Опрос недоступен'
        } else {
          const result = this.polls.store.vote(parsed.id, from.id, parsed.optionIndex)
          if (!result?.poll) {
            toast = 'Опрос уже закрыт'
          } else {
            // The poll message is rewritten in place: counts change with every vote.
            await this.platform.editText({
              chatId,
              messageId,
              markdown: pollMessage(result.poll, { names: this.namesOf(result.poll) }),
              keyboard: pollKeyboard(result.poll),
            }).catch((error) => this.logger.debug('poll edit failed', { error, chatId }))
            await this.polls.store.flush()
            toast = result.poll.closedAt !== undefined
              ? 'Опрос уже закрыт'
              : result.changed
                ? 'Голос учтён'
                : 'Вы уже голосовали так'
          }
        }
      } else if (action === 'cancel') {
        const [id] = rest
        // `message` here is the bot's own message, so its `from.id` is the bot:
        // the owner is the user who tapped the button.
        const removed = this.reminders?.store.cancel(chatId, id, from.id)
        await this.reminders?.store.flush()
        toast = removed ? `Напоминание №${id} отменено` : `Напоминания №${id} уже нет`
        outcome = removed ? `✖️ Отменено: «${removed.text}»` : '✖️ Напоминание уже отменено'
      } else if (action === 'snooze') {
        const [minutesRaw, id] = rest
        const minutes = Number(minutesRaw)
        const existing = this.reminders?.store.list(chatId, from.id).find((reminder) => reminder.id === String(id))
        if (!existing) {
          toast = 'Напоминание уже неактивно'
          outcome = '✖️ Это напоминание уже сработало или отменено'
        } else if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) {
          toast = 'Неверная задержка'
        } else {
          // The repeat is carried over: postponing a daily reminder must not
          // silently turn it into a one-off.
          const moved = this.reminders.store.add({
            chatId,
            userId: existing.userId,
            text: existing.text,
            dueAt: new Date(Date.now() + minutes * 60_000),
            repeat: existing.repeat ?? 'none',
          })
          this.reminders.store.cancel(chatId, existing.id, from.id)
          await this.reminders.store.flush()
          const when = this.formatReminderTime(moved.dueAt)
          const repeatNote = moved.repeat === 'none' ? '' : moved.repeat === 'daily' ? ' (дальше — каждый день)' : ' (дальше — каждую неделю)'
          toast = `Отложено на ${minutes} мин`
          outcome = `⏰ Отложено до ${when}${repeatNote}`
        }
      }
    } catch (error) {
      this.logger.error('callback action failed', { error, action, chatId })
      toast = 'Не получилось, попробуйте ещё раз'
    }
    this.logger.info('callback handled', { action, chatId, userId: from.id })
    await this.platform.answerCallback({ callbackId: update.callback.id, text: toast }).catch(() => {})
    if (outcome) {
      // The original text is unknown to us, so the adapter rewrites the message
      // without any markup.
      await this.platform.editText({ chatId, messageId, markdown: `${update.callback.text ?? ''}\n\n${outcome}` }).catch((error) => {
        this.logger.debug('message edit failed', { error, chatId })
      })
    }
  }

  /** Definition of the history search tool, built from the shared hint. */
  historyToolDefinition() {
    return {
      type: 'function',
      function: {
        name: 'find_history',
        description: SEARCH_HINT,
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Что искать в прошлой переписке: 1–3 ключевых слова.' } },
          required: ['query'],
        },
      },
    }
  }

  /**
   * Search this chat history and format the answer.
   *
   * A multi-word question needs one solid word match, not just any incidental one:
   * with the default floor a question like «что мы решали» matches half the chat.
   *
   * @param {string} chatKey - chat whose history is searched.
   * @param {string} query - what to look for.
   * @returns {Promise<string>} the ready-to-send answer.
   */
  async searchHistory(chatKey, query) {
    const messages = this.history?.messages?.(chatKey) ?? []
    const words = String(query).split(/\s+/).filter((word) => word.length > 1)
    const found = searchMessages(messages, query, { minScore: words.length >= 2 ? 120 : 1 })
    return formatSearchResults(found, { query, timeZone: this.config.time?.timeZone ?? '' })
  }

  /** Who voted in a poll, by their display name where we know it. */
  namesOf(poll) {
    const names = {}
    for (const option of poll.options ?? []) {
      for (const voter of option.votes ?? []) {
        names[voter] = this.profiles?.store?.displayName?.(voter) ?? String(voter)
      }
    }
    return names
  }

  /**
   * A tappable command menu, for platforms without Telegram's «/» list.
   *
   * VK shows no command hints, so the frequently used commands go out as buttons:
   * tapping one sends its label, and the label *is* the command.
   *
   * @returns {object|undefined} the neutral keyboard, or undefined on other platforms.
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

  /** Neutral keyboard for a freshly created reminder; the adapter renders it. */
  reminderKeyboard(reminderId) {
    return {
      rows: [
        [{ text: '⏰ Отложить на 10 минут', data: `snooze:10:${reminderId}` }],
        [{ text: '✖️ Отменить', data: `cancel:${reminderId}` }],
      ],
    }
  }

  isAllowed(userId) {
    return this.config.access.allowAllUsers || this.config.access.allowedUserIds.has(userId)
  }

  /** Tell an unknown user their id once per cooldown window. */
  async deny(userId, chatId) {
    const now = Date.now()
    // Keep the cooldown map bounded: entries older than the window can never
    // suppress a reply, so they are dropped before they accumulate.
    if (this.deniedAt.size >= 256) {
      for (const [id, timestamp] of this.deniedAt) {
        if (now - timestamp >= DENY_COOLDOWN_MS) this.deniedAt.delete(id)
      }
      if (this.deniedAt.size >= 4096) this.deniedAt.clear()
    }
    const last = this.deniedAt.get(userId) ?? 0
    if (now - last < DENY_COOLDOWN_MS) {
      this.logger.debug('denial suppressed', { userId })
      return
    }
    this.deniedAt.set(userId, now)
    this.logger.warn('access denied', { userId, chatId })
    const text = this.config.access.denyMessage.replace('{id}', String(userId))
    // Sent through `send` so `<`, `&` and `>` in a custom DENY_MESSAGE are
    // escaped instead of reaching Telegram as broken entities.
    await this.send(chatId, text).catch((error) => this.logger.warn('deny reply failed', { error }))
  }

  async runCommand({ name, args }, message) {
    const chatId = message.chat.id
    switch (name) {
      case 'export': {
        // The history key is the chat id as text — same key the dialog uses.
        const chatKey = String(chatId)
        const profile = this.profiles?.store
        const facts = profile?.facts?.(message.from.id) ?? []
        const lines = [
          '# Выгрузка из бота',
          '',
          `Дата: ${new Date().toISOString()}`,
          '',
          '## Настройки',
          '',
          `- город: ${profile?.city?.(message.from.id) ?? 'не задан'}`,
          `- характер: ${profile?.persona?.(message.from.id) ?? 'обычный'}`,
          `- настроение: ${profile?.mood?.(message.from.id) ?? 'меняется само'}`,
          `- модель: ${this.history?.model?.(chatKey) ?? this.config.model?.name ?? 'по умолчанию'}`,
          `- озвучка ответов: ${this.history?.voice?.(chatKey) ? 'включена' : 'выключена'}`,
          '',
          '## Что бот помнит',
          '',
          ...(facts.length === 0 ? ['— пока ничего'] : facts.map((fact) => `- №${fact.id}: ${fact.text}`)),
          '',
          '## Напоминания',
          '',
        ]
        const activeReminders = this.reminders?.store.list(chatId, message.from.id) ?? []
        if (activeReminders.length === 0) lines.push('— нет')
        for (const reminder of activeReminders) {
          lines.push(`- №${reminder.id} ${reminder.dueAt} (${reminder.repeat ?? 'none'}): ${reminder.text}`)
        }
        lines.push('', '## История диалога (последние сообщения)', '')
        for (const entry of this.history?.messages?.(chatKey) ?? []) {
          const who = entry.role === 'user' ? 'Вы' : entry.role === 'assistant' ? 'Бот' : entry.role
          const content = typeof entry.content === 'string' ? entry.content : '(вложение)'
          lines.push(`**${who}:** ${content}`)
        }
        // Everything the bot knows about this person, in one file they own.
        const fileName = `vygruzka-${new Date().toISOString().slice(0, 10)}.md`
        await this.sendFile(
          chatId,
          { bytes: Buffer.from(`${lines.join('\n')}\n`, 'utf8'), fileName, caption: 'Ваши данные из бота' },
          message.message_id,
        )
        return
      }
      case 'app': {
        const appUrl = this.config.miniapp?.url
        if (!appUrl) {
          await this.send(chatId, 'Приложение ещё не настроено: нужен публичный HTTPS-адрес.')
          return
        }
        await this.send(chatId, '**Панель управления**\nНапоминания, календарь, память и расход — в удобном виде, прямо внутри Telegram.', undefined, { rows: [[{ text: 'Открыть приложение', webApp: appUrl }]] })
        return
      }
      case 'search': {
        const query = String(args ?? '').trim()
        if (query === '') {
          await this.send(chatId, 'Что искать? Например: `/search ремонт`.')
          return
        }
        await this.send(chatId, await this.searchHistory(String(chatId), query))
        return
      }
      case 'server': {
        if (!this.server) {
          await this.send(chatId, 'Состояние сервера недоступно в этой сборке.')
          return
        }
        await this.send(chatId, await this.server.execute())
        return
      }
      case 'calendar': {
        if (!this.events) {
          await this.send(chatId, 'Календарь выключен в настройках.')
          return
        }
        const events = this.events.store.upcoming(chatId, { days: 14 })
        if (events.length === 0) {
          await this.send(chatId, 'В ближайшие две недели событий нет.\n\nДобавить: «запиши стоматолога 15 октября в 11:30».')
          return
        }
        const zone = this.config.time?.timeZone ?? ''
        const lines = events.map((event, index) => {
          const day = new Intl.DateTimeFormat('ru-RU', { timeZone: zone || undefined, day: 'numeric', month: 'long', weekday: 'short' }).format(new Date(event.nextAt))
          const time = new Intl.DateTimeFormat('ru-RU', { timeZone: zone || undefined, hour: '2-digit', minute: '2-digit' }).format(new Date(event.nextAt))
          const repeat = event.repeat === 'yearly' ? ' (каждый год)' : ''
          const place = event.place ? `, ${event.place}` : ''
          return `${index + 1}. ${day}, ${time} — ${event.title}${place}${repeat}`
        })
        await this.send(chatId, ['**Ближайшие события**', ...lines, '', 'Удалить: «удали событие 2» или напишите мне об этом.'].join('\n'))
        return
      }
      case 'start':
      case 'help':
        // VK has no «/» command menu like Telegram, so the same list goes out as
        // buttons: tapping one sends its label, which is the command itself.
        await this.send(chatId, [HELP, '', capabilityHelp(this.capabilities)].join('\n'), undefined, this.menuKeyboard())
        return
      case 'whoami':
        await this.send(chatId, [
          `**user id:** \`${message.from.id}\``,
          `**chat id:** \`${chatId}\``,
          `**chat type:** \`${message.chat.type}\``,
        ].join('\n'))
        return
      case 'new':
        await this.history.reset(chatId)
        await this.send(chatId, 'Контекст диалога очищен. Начнём заново.')
        return
      case 'reminders': {
        const list = (this.reminders?.store.list(chatId, message.from.id) ?? []).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
        if (list.length === 0) {
          await this.send(chatId, 'Напоминаний нет. Скажите, например: «напомни завтра в 9 позвонить маме».')
          return
        }
        const lines = list.map((reminder) => {
          const repeat = reminder.repeat === 'none' ? '' : reminder.repeat === 'daily' ? ', каждый день' : ', каждую неделю'
          return `№${reminder.id} — ${this.formatReminderTime(reminder.dueAt)}${repeat}: ${reminder.text}`
        })
        await this.send(
          chatId,
          ['**Напоминания:**', ...lines, '', 'Отменить: `/cancel <номер>` или кнопкой ниже'].join('\n'),
          // Up to eight one-tap cancellations; a longer list stays command-driven.
          undefined,
          list.slice(0, 8).length > 0
            ? { rows: list.slice(0, 8).map((reminder) => [{ text: `✖️ Отменить №${reminder.id}`, data: `cancel:${reminder.id}` }]) }
            : undefined,
        )
        return
      }
      case 'voice': {
        if (!this.tts || typeof this.platform.sendVoice !== 'function') {
          await this.send(chatId, 'Озвучка недоступна: нужен ключ синтеза речи и поддержка платформы.')
          return
        }
        const value = args.trim().toLowerCase()
        if (value === 'вкл' || value === 'on' || value === 'да') {
          await this.history.setVoice(chatId, true)
          await this.send(chatId, 'Озвучка включена: каждый ответ в этом чате будет приходить ещё и голосовым.')
          return
        }
        if (value === 'выкл' || value === 'off' || value === 'нет') {
          await this.history.setVoice(chatId, false)
          await this.send(chatId, 'Озвучка выключена — отвечаю только текстом.')
          return
        }
        if (value !== '') {
          await this.send(chatId, 'Не понял. Напишите `/voice вкл` или `/voice выкл`.')
          return
        }
        const state = this.history.voice(chatId) ? 'включена' : 'выключена'
        await this.send(chatId, `Озвучка ответов: **${state}**.\nПереключить: \`/voice вкл\` или \`/voice выкл\`.`)
        return
      }
      case 'character': {
        if (!this.profiles) {
          await this.send(chatId, 'Профиль выключен — характер негде хранить.')
          return
        }
        const value = args.trim().toLowerCase()
        if (value === '') {
          const current = this.profiles.store.persona(message.from.id) ?? 'обычный'
          await this.send(chatId, [
            `Сейчас мой характер: **${current}**.`,
            `Доступные: ${PERSONA_NAMES.map((name) => '`' + name + '`').join(', ')}.`,
            'Сменить: `/character дружелюбный`. Вернуть обычный: `/character сброс`.',
          ].join('\n'))
          return
        }
        if (value === 'сброс' || value === 'обычный' || value === 'нет') {
          this.profiles.store.setPersona(message.from.id, '')
          await this.profiles.store.flush()
          await this.send(chatId, 'Характер вернулся к обычному.')
          return
        }
        if (!PERSONAS[value]) {
          await this.send(chatId, `Такого характера нет. Доступные: ${PERSONA_NAMES.join(', ')}.`)
          return
        }
        this.profiles.store.setPersona(message.from.id, value)
        await this.profiles.store.flush()
        await this.send(chatId, `Характер «${value}» включён. ${PERSONAS[value].hint}`)
        return
      }
      case 'mood': {
        if (!this.profiles) {
          await this.send(chatId, 'Профиль выключен — настроение негде хранить.')
          return
        }
        const value = args.trim().toLowerCase()
        if (value === '') {
          const pinned = this.profiles.store.mood(message.from.id)
          const today = moodOf({ mood: pinned }, { userId: message.from.id, now: new Date(), timeZone: this.config.time?.timeZone })
          await this.send(chatId, [
            `Сегодня я **${today}**${pinned ? ' (закреплено)' : ' — настроение меняется само каждый день'}.`,
            `Можно закрепить: ${MOOD_NAMES.map((name) => '`' + name + '`').join(', ')}.`,
            'Вернуть автоматическое: `/mood авто`.',
          ].join('\n'))
          return
        }
        if (value === 'авто' || value === 'сброс') {
          this.profiles.store.setMood(message.from.id, '')
          await this.profiles.store.flush()
          await this.send(chatId, 'Настроение снова меняется само — каждый день разное.')
          return
        }
        if (!MOODS[value]) {
          await this.send(chatId, `Такого настроения нет. Доступные: ${MOOD_NAMES.join(', ')}.`)
          return
        }
        this.profiles.store.setMood(message.from.id, value)
        await this.profiles.store.flush()
        await this.send(chatId, `Настроение закреплено: **${value}**. ${MOODS[value]}`)
        return
      }
      case 'mode': {
        if (!this.profiles) {
          await this.send(chatId, 'Профиль выключен.')
          return
        }
        const value = args.trim().toLowerCase()
        const names = Object.keys(MODES)
        if (value === '') {
          const current = this.profiles.store.mode(message.from.id)
          await this.send(chatId, [
            current ? `Текущий режим: **${current}**.` : 'Режим не выбран — отвечаю как обычно.',
            `Доступные: ${names.map((name) => '\`' + name + '\`').join(', ')}.`,
            'Сбросить: `/mode сброс`.',
          ].join('\n'))
          return
        }
        if (value === 'сброс' || value === 'нет' || value === 'обычно') {
          this.profiles.store.setMode(message.from.id, '')
          await this.profiles.store.flush()
          await this.send(chatId, 'Режим сброшен — отвечаю как обычно.')
          return
        }
        if (!MODES[value]) {
          await this.send(chatId, `Не знаю такой режим. Доступные: ${names.join(', ')}.`)
          return
        }
        this.profiles.store.setMode(message.from.id, value)
        await this.profiles.store.flush()
        await this.send(chatId, `Режим «${value}» включён: ${MODES[value]}`)
        return
      }
      case 'city': {
        if (!this.profiles) {
          await this.send(chatId, 'Память профиля выключена.')
          return
        }
        const value = args.trim()
        if (value === '') {
          const saved = this.profiles.store.city(message.from.id)
          await this.send(chatId, saved
            ? `Ваш город по умолчанию — **${saved}**. Поменять: \`/city Казань\`. Убрать: \`/city нет\`.`
            : 'Город по умолчанию не задан. Задайте: `/city Москва` — тогда погоду можно спрашивать без города.')
          return
        }
        if (/^(нет|убрать|сброс|удали)$/i.test(value)) {
          const removed = this.profiles.store.clearCity(message.from.id)
          await this.profiles.store.flush()
          await this.send(chatId, removed ? 'Город по умолчанию убран.' : 'Города по умолчанию и не было.')
          return
        }
        if (value.length > 80) {
          await this.send(chatId, 'Слишком длинное название города.')
          return
        }
        this.profiles.store.setCity(message.from.id, value)
        await this.profiles.store.flush()
        await this.send(chatId, `Город по умолчанию — **${value}**. Теперь погоду можно спрашивать без города.`)
        return
      }
      case 'memory': {
        if (!this.profiles) {
          await this.send(chatId, 'Память профиля выключена.')
          return
        }
        const facts = this.profiles.store.facts(message.from.id)
        const city = this.profiles.store.city(message.from.id)
        if (facts.length === 0 && !city) {
          await this.send(chatId, 'Я пока ничего о вас не помню. Скажите, например: «запомни, меня зовут Андрей».')
          return
        }
        const lines = []
        if (city) lines.push(`Город по умолчанию: **${city}** (сменить — \`/city\`)`)
        if (facts.length > 0) {
          lines.push('**Что помню:**')
          for (const fact of facts) lines.push(`№${fact.id}: ${fact.text}`)
          lines.push('', 'Удалить один факт: `/forget <номер>`. Удалить всё: `/forget all`.')
        }
        await this.send(chatId, lines.join('\n'))
        return
      }
      case 'forget': {
        if (!this.profiles) {
          await this.send(chatId, 'Память профиля выключена.')
          return
        }
        const value = args.trim()
        if (value === '') {
          await this.send(chatId, 'Укажите номер: `/forget 2`, или всё сразу: `/forget all`. Список — `/memory`.')
          return
        }
        if (/^(all|всё|все)$/i.test(value)) {
          const count = this.profiles.store.clearFacts(message.from.id)
          await this.profiles.store.flush()
          await this.send(chatId, count > 0 ? `Забыл все факты (${count}).` : 'Фактов и не было.')
          return
        }
        if (!/^\d+$/.test(value)) {
          await this.send(chatId, 'Номер должен быть числом: `/forget 2`. Список — `/memory`.')
          return
        }
        const removed = this.profiles.store.removeFact(message.from.id, value)
        await this.profiles.store.flush()
        await this.send(chatId, removed ? `Забыл №${value}: «${removed.text}».` : `Факта №${value} нет. Список — /memory.`)
        return
      }
      case 'stats': {
        if (!this.usage) {
          await this.send(chatId, 'Учёт расхода выключен.')
          return
        }
        const zone = this.config.time?.timeZone ?? ''
        const today = this.usage.total(new Date(), zone)
        const yesterday = this.usage.total(new Date(Date.now() - 86_400_000), zone)
        const mine = today.users[String(message.from.id)] ?? { prompt: 0, completion: 0, requests: 0 }
        const fmt = (value) => new Intl.NumberFormat('ru-RU').format(value)
        const lines = [
          `**Расход за сегодня** (${this.formatReminderTime(new Date())})`,
          `Запросов: ${today.requests}, токенов: ${fmt(today.prompt + today.completion)}`,
          `— запрос: ${fmt(today.prompt)}, ответ: ${fmt(today.completion)}, из них из кеша: ${fmt(today.cached)}`,
          `Ваша доля: ${mine.requests} запрос(ов), ${fmt(mine.prompt + mine.completion)} токенов`,
          `Вчера: ${fmt(yesterday.prompt + yesterday.completion)} токенов за ${yesterday.requests} запрос(ов)`,
        ]
        const limit = this.config.usage?.dailyLimit ?? 0
        if (limit > 0) {
          const used = today.prompt + today.completion
          lines.push(`Лимит: ${fmt(limit)} токенов в день, израсходовано ${Math.round((used / limit) * 100)}%`)
        } else {
          lines.push('Дневной лимит не задан (`DAILY_TOKEN_LIMIT=0`).')
        }
        await this.send(chatId, lines.join('\n'))
        return
      }
      case 'digest': {
        if (!this.digest) {
          const enabled = this.config.digest?.enabled
          await this.send(chatId, enabled
            ? 'Дайджест включён, но отправлять некому: задайте `DIGEST_CHAT_IDS` или `ALLOWED_USER_IDS`.'
            : 'Дайджест выключен (`DIGEST=false`).')
          return
        }
        await this.deliverDigest(chatId, message.from?.id)
        return
      }
      case 'cancel': {
        const id = args.trim()
        if (!/^\d+$/.test(id)) {
          await this.send(chatId, 'Укажите номер: `/cancel 3`. Список — `/reminders`.')
          return
        }
        const removed = this.reminders?.store.cancel(chatId, id, message.from.id)
        await this.reminders?.store.flush()
        await this.send(chatId, removed ? `Напоминание №${id} отменено.` : `Напоминания №${id} нет. Список — /reminders.`)
        return
      }
      case 'model': {
        const overrides = args.trim()
        if (overrides === '') {
          const current = this.history.model(chatId) ?? this.model.name
          await this.send(chatId, `Текущая модель: \`${current}\`\nСменить: \`/model имя-модели\``)
          return
        }
        if (overrides.length > 120) {
          await this.send(chatId, 'Слишком длинное имя модели.')
          return
        }
        await this.history.setModel(chatId, overrides)
        await this.send(chatId, `Модель для этого чата: \`${overrides}\``)
        return
      }
      default:
        if (message.chat.type === 'private') await this.send(chatId, 'Неизвестная команда. Список: /help')
    }
  }

  /** Run one model turn for a chat and deliver the answer. */
  async reply(message, prompt) {
    const chatId = message.chat.id
    await this.semaphore.acquire()
    const typing = this.startTyping(chatId)
    try {
      const chatKey = String(chatId)
      const userId = message.from?.id
      // The daily budget is checked before the call: once it is spent, further
      // requests would only add cost without producing an answer the user wants.
      if (this.usage?.limitReached()) {
        const spent = this.usage.tokens()
        const limit = this.usage.dailyLimit
        this.logger.warn('daily token limit reached, refusing the turn', { chatId, spent, limit })
        await this.send(chatId, `Дневной лимит токенов исчерпан: ${new Intl.NumberFormat('ru-RU').format(spent)} из ${new Intl.NumberFormat('ru-RU').format(limit)}. До полуночи новые запросы отвечать не буду — сводка в /stats, лимит задаётся переменной \`DAILY_TOKEN_LIMIT\`.`)
        return
      }
      // A private chat may see everything the bot knows about its owner. A group
      // may not: there the model gets names only, so personal facts cannot leak
      // into a conversation with other people.
      const isGroup = (message.chat?.type ?? 'private') !== 'private'
      const authorName = isGroup ? this.profiles?.store.displayName(userId) : undefined
      const knownFacts = userId === undefined
        ? undefined
        : isGroup ? this.groupContext(chatKey, authorName) : this.profiles?.store.summary(userId)
      // A personal tone/length profile, set with `/mode`, is appended to the
      // system prompt so it applies to every answer in this chat.
      const modeHint = this.modeHint(userId)
      // Character and mood come from the user's profile, so they survive a restart.
      const character = this.characterHint(userId)
      // Photos, voice notes and documents become content parts (or notes when
      // something is unavailable).
      const prepared = message.attachments?.length > 0
        ? await prepareAttachments({
          platform: this.platform,
          attachments: message.attachments,
          caption: prompt,
          media: this.media,
          limits: { maxBytes: this.config.media?.maxBytes },
          logger: this.logger,
        })
        : { parts: [], notes: [], summary: '' }
      // Nothing usable came out of the attachments (a scanned PDF, a voice note
      // without a transcriber) and the user wrote no caption: asking the model
      // with an empty message would produce "the model returned nothing", which
      // looks like silence. Say what happened instead.
      if (prepared.parts.length === 0 && prompt.trim() === '' && message.attachments?.length > 0) {
        const reason = prepared.notes.length > 0
          ? prepared.notes.map((note) => `⚠️ ${note}`).join('\n')
          : '⚠️ Не удалось разобрать вложение.'
        await this.send(chatId, `${reason}\n\nПришлите текст сообщением или файл в другом формате — отвечу по содержимому.`, message.message_id)
        void this.react(message, '🤔')
        return
      }
      // In a group the speaker is named in the history, otherwise the model cannot
      // tell who said what — and "меня зовут X" would be attributed to the wrong
      // person.
      const history = this.history.messages(chatKey).map((entry) => (
        isGroup && entry.role === 'user' && entry.author
          ? { role: 'user', content: `${entry.author}: ${entry.content}` }
          : entry
      ))
      const withAuthor = (content) => (isGroup && authorName ? `${authorName}: ${content}` : content)
      const messages = [
        { role: 'system', content: this.config.model.systemPrompt },
        // A model has no clock; without this it invents dates and then mislabels
        // cached search results as "today".
        { role: 'system', content: formatTimeContext({ timeZone: this.config.time?.timeZone ?? '' }) },
        ...(knownFacts ? [{ role: 'system', content: knownFacts }] : []),
        ...(modeHint ? [{ role: 'system', content: modeHint }] : []),
        ...(character ? [{ role: 'system', content: character }] : []),
        // The model has no idea what it was built with: this is that knowledge.
        { role: 'system', content: this.capabilitiesHint() },
        ...history,
        ...(prepared.parts.length > 0
          // Multi-part content: caption/document text plus the image itself.
          ? [{ role: 'user', content: prepared.parts.map((part) => (part.type === 'text' ? { ...part, text: withAuthor(part.text) } : part)) }]
          : [{ role: 'user', content: withAuthor(prompt) }]),
      ]
      const model = this.history.model(chatKey) ?? this.model.name
      const started = Date.now()
      // Streaming is on by default: the user sees the answer grow instead of
      // waiting for a long silence.
      // Streaming needs a platform and chat where editing messages is reliable:
      // in VK conversations it is not, so the adapter answers that question.
      const streamable = this.config.stream?.enabled && (typeof this.platform.canStream !== 'function' || this.platform.canStream({ chatId }))
      const streamer = streamable ? this.createStreamer(chatId) : undefined
      // Web tools are optional: without them the model answers from its own
      // knowledge and says so, with them it can search and read pages.
      const tools = [
        ...(this.webTools?.definitions ?? []),
        ...(this.agentBridge?.enabled ? this.agentBridge.definitions : []),
        ...(this.reminders ? [this.reminders.tool.definition] : []),
        ...(this.profiles ? [this.profiles.tool.definition] : []),
        ...(this.files ? [this.files.definition] : []),
        ...(this.events ? [this.events.tool.definition] : []),
        ...(this.polls ? [this.polls.tool.definition] : []),
        ...(this.youtube ? [this.youtube.definition] : []),
        ...(this.server ? [this.server.definition] : []),
        ...(this.history ? [this.historyToolDefinition()] : []),
      ]
      /** Text the `remind` tool returned in this turn, if it ran. */
      let remindResult
      /** Text the `remember` tool returned in this turn, if it ran. */
      let rememberResult
      /** Reminder created in this turn; drives the inline buttons. */
      let createdReminder
      /** File built by the `file` tool in this turn; sent right after the answer. */
      let createdFile
      /** Text the `file` tool returned in this turn, if it ran. */
      let fileResult
      const executeTool = async (name, args, options) => {
        if (name === 'remind' && this.reminders) {
          const result = await this.reminders.tool.executeDetailed(args, { chatId, userId })
          remindResult = result.text
          if (result.reminder) createdReminder = result.reminder
          return remindResult
        }
        if (name === 'poll' && this.polls) {
          const result = await this.polls.tool.executeDetailed(args, { chatId, userId })
          if (result.poll) {
            await this.send(chatId, pollMessage(result.poll, { names: this.namesOf(result.poll) }), message.message_id, pollKeyboard(result.poll))
          }
          return result.text
        }
        if (name === 'youtube' && this.youtube) {
          const result = await this.youtube.executeDetailed(args)
          return result.text
        }
        if (name === 'find_history' && this.history) {
          return await this.searchHistory(String(chatId), String(args.query ?? ''))
        }
        if (name === 'server' && this.server) {
          return (await this.server.executeDetailed()).text
        }
        if (name === 'event' && this.events) {
          const result = await this.events.tool.executeDetailed(args, { chatId, userId })
          return result.text
        }
        if (name === 'file' && this.files) {
          const result = await this.files.executeDetailed(args, { chatId, userId })
          fileResult = result.text
          if (result.file) createdFile = result.file
          return result.text
        }
        if (name === 'remember' && this.profiles) {
          rememberResult = await this.profiles.tool.execute(args, { userId })
          return rememberResult
        }
        // Weather without a city means "my city": the profile supplies it, so the
        // user does not have to repeat where they live. Never in a group — that
        // would tell everybody in the chat where the speaker lives.
        if (name === 'weather' && this.webTools) {
          const city = typeof args?.city === 'string' ? args.city.trim() : ''
          if (city === '' && !isGroup) {
            const saved = userId === undefined ? undefined : this.profiles?.store.city(userId)
            if (saved) return this.webTools.execute(name, { ...args, city: saved }, options)
          }
          return this.webTools.execute(name, args, options)
        }
        if (name === 'ask_agent' && this.agentBridge?.enabled) return this.agentBridge.execute(name, args, options)
        if (this.webTools) return this.webTools.execute(name, args, options)
        return `Инструмент ${name} не поддерживается.`
      }
      const toolOptions = tools.length > 0
        ? { tools, executeTool, maxToolRounds: this.config.web.maxToolRounds }
        : {}
      let answer = await this.model.complete({
        messages,
        model,
        signal: this.shutdown?.signal,
        ...(streamer ? { onDelta: (chunk) => streamer.onDelta(chunk) } : {}),
        ...toolOptions,
      })
      this.recordUsage(userId, chatId, answer.usage)

      /**
       * Run one extra model round that must call exactly one tool.
       *
       * The model sometimes answers an action request in words ("Записал!") and
       * never calls the tool, so nothing is stored. For a commitment like that
       * the tool has to run, and the user must see its own confirmation.
       */
      const forceTool = async (name, nudge) => {
        const forced = await this.model.complete({
          messages: [...messages, { role: 'system', content: nudge }],
          model,
          signal: this.shutdown?.signal,
          ...toolOptions,
          toolChoice: { type: 'function', function: { name } },
          maxToolRounds: 1,
        })
        this.recordUsage(userId, chatId, forced.usage)
        return forced
      }

      // A reminder promise is a commitment: if the model merely answered in words,
      // force the tool so something is actually scheduled. This is not optional —
      // a text-only answer used to tell the user "напомню в 01:23" while nothing
      // was stored anywhere.
      const reminderRequested = this.reminders && answer.toolCalls === 0
        && (REMINDER_INTENT.test(prompt) || REMINDER_CLAIM.test(answer.text ?? ''))
      if (reminderRequested) {
        this.logger.warn('reminder requested without a tool call, forcing remind', { chatId })
        const forced = await forceTool('remind', 'Пользователь просит напоминание. Немедленно вызови инструмент remind и передай время, посчитанное от текущего момента из системного сообщения о времени.')
        if (forced.toolCalls > 0 && remindResult) {
          // The tool's own text states exactly what is scheduled; prefer it over
          // a paraphrase, so the user never sees a time that was not stored.
          answer = { ...forced, text: remindResult, toolCalls: forced.toolCalls }
        } else {
          this.logger.error('forced remind produced no tool call', { chatId, toolCalls: forced.toolCalls })
          answer = { ...answer, text: 'Не удалось поставить напоминание — инструмент не сработал. Попробуйте сформулировать иначе, например: «напомни через 15 минут проверить духовку».' }
        }
      }

      // Same guarantee for memory: "мой город — Казань" used to get the answer
      // "Записал!" with the profile left untouched, so the city never stuck.
      const memoryRequested = this.profiles && !rememberResult && isMemoryRequest(prompt)
      if (memoryRequested) {
        this.logger.warn('memory request without a tool call, forcing remember', { chatId })
        const forced = await forceTool('remember', 'Пользователь сообщает о себе факт. Немедленно вызови инструмент remember: factual text в параметре text, а если он назвал свой город — обязательно заполни параметр city.')
        if (forced.toolCalls > 0 && rememberResult) {
          answer = { ...forced, text: rememberResult, toolCalls: forced.toolCalls }
        } else {
          this.logger.error('forced remember produced no tool call', { chatId, toolCalls: forced.toolCalls })
          answer = { ...answer, text: 'Не удалось сохранить — инструмент памяти не сработал. Попробуйте ещё раз или задайте город командой `/city Москва`.' }
        }
      }

      // Same guarantee for documents: "сделай таблицу в Excel" used to be answered
      // with a pretty table in the chat while no file existed at all.
      const fileRequested = this.files && !createdFile && answer.toolCalls === 0
        && (FILE_INTENT.test(prompt) || FILE_CLAIM.test(answer.text ?? ''))
      if (fileRequested) {
        this.logger.warn('file requested without a tool call, forcing file', { chatId })
        const forced = await forceTool('file', 'Пользователь просит файл. Немедленно вызови инструмент file: выбери формат (xlsx для таблицы, docx для документа, csv для данных), придумай короткое имя и передай содержимое в параметрах text или table.')
        if (forced.toolCalls > 0 && createdFile) {
          answer = { ...forced, text: fileResult ?? forced.text, toolCalls: forced.toolCalls }
        } else {
          this.logger.error('forced file produced no file', { chatId, toolCalls: forced.toolCalls })
          answer = { ...answer, text: 'Не удалось собрать файл — инструмент не сработал. Попробуйте иначе, например: «сделай таблицу в Excel со столбцами Название и Год».' }
        }
      }

      const text = answer.text.trim()
      this.logger.info('model answered', {
        chatId,
        model: answer.model ?? model,
        toolCalls: answer.toolCalls ?? 0,
        ms: Date.now() - started,
        promptChars: prompt.length,
        answerChars: text.length,
        usage: answer.usage,
      })
      // The author is stored for groups only: a private chat has exactly one.
      // Media becomes a short placeholder: the history file must not grow with
      // base64 images or whole documents.
      const historyLine = prepared.summary || prompt
      await this.history.append(chatKey, { role: 'user', content: historyLine, ...(authorName ? { author: authorName } : {}) })
      if (text === '') {
        // An empty completion is a valid API response. The user still needs an
        // answer, and an empty assistant turn must not enter the history.
        await this.send(chatId, 'Модель вернула пустой ответ. Попробуйте переформулировать запрос.')
        return
      }
      await this.history.append(chatKey, { role: 'assistant', content: text })
      // A reminder created in this turn gets buttons under the confirmation, so
      // cancelling or postponing it is one tap instead of a command.
      const keyboard = createdReminder ? this.reminderKeyboard(createdReminder.id) : undefined
      // When the answer was already streamed into a message, the final text (with
      // buttons) replaces it; otherwise it is sent as usual.
      const delivered = streamer ? await streamer.finish(text, keyboard) : false
      if (!delivered) await this.send(chatId, text, message.message_id, keyboard)
      // A generated document follows the text: the answer explains, the file carries
      // the data.
      if (createdFile) await this.sendFile(chatId, createdFile, message.message_id)
      // Voice answers are opt-in per chat (`/voice вкл`): the text always arrives,
      // the spoken version is added on top of it.
      await this.speakAnswer(chatId, text, message)
      // Anything that could not be used (an untranscribed voice note, a scanned
      // PDF) is reported once, after the answer.
      if (prepared.notes.length > 0) {
        await this.send(chatId, prepared.notes.map((note) => `⚠️ ${note}`).join('\n')).catch(() => {})
      }
      void this.react(message, '👍')
      // Facts the user stated about themselves are kept without asking the model:
      // "меня зовут …" used to be answered with words instead of being stored.
      await this.rememberStatedFacts(userId, prompt)
    } catch (error) {
      if (this.shutdown?.signal.aborted) {
        // Shutdown aborted the call on purpose: the process is going down and
        // an error message now would be noise (and may not even be delivered).
        this.logger.warn('model turn aborted by shutdown', { chatId })
        return
      }
      void this.react(message, '🤔')
      this.logger.error('model turn failed', { error, chatId })
      this.noteModelFailure(error)
      const detail = error?.message ?? 'неизвестная ошибка'
      // Plain text on purpose: the converter escapes it, so a provider message
      // cannot inject markup into the reply.
      await this.send(chatId, `Не удалось получить ответ.\n\n${truncate(detail, 300)}`).catch(() => {})
    } finally {
      typing.stop()
      this.semaphore.release()
    }
  }

  /**
   * What the model gets in a group: who is speaking, and nothing personal.
   *
   * Only names are shared. City and facts stay in the private chat, so the bot
   * cannot reveal them to other participants by accident.
   *
   * @param {string} chatKey - history key of the chat.
   * @param {string} [authorName] - name of the current speaker.
   * @returns {string|undefined} the system line, or `undefined` when nobody is named.
   */
  groupContext(chatKey, authorName) {
    const participants = [...new Set(this.history.messages(chatKey).filter((entry) => entry.author).map((entry) => entry.author))]
    if (authorName && !participants.includes(authorName)) participants.push(authorName)
    if (participants.length === 0) return undefined
    const who = authorName ? `Сейчас пишет ${authorName}. ` : ''
    return `${who}Участники этого чата: ${participants.join(', ')}. Личные факты и город участников здесь не показываются — личный контекст остаётся в личных чатах.`
  }

  /** The system message that tells the model what this build can do. */
  capabilitiesHint() {
    return capabilityHint(this.capabilities)
  }

  /**
   * The system message that gives the assistant its character and mood.
   *
   * @param {string|number} [userId] - profile owner.
   * @returns {string|undefined} the hint, or undefined when profiles are off.
   */
  characterHint(userId) {
    if (!this.profiles || userId === undefined) return undefined
    return characterHint({
      profile: {
        persona: this.profiles.store.persona(userId),
        mood: this.profiles.store.mood(userId),
      },
      userId,
      now: new Date(),
      timeZone: this.config.time?.timeZone ?? '',
    })
  }

  /** The system hint for the user's answer mode, when one is set. */
  modeHint(userId) {
    const mode = userId === undefined ? undefined : this.profiles?.store.mode(userId)
    const hint = mode ? MODES[mode] : undefined
    return hint ? `Режим ответа, выбранный пользователем: ${hint}` : undefined
  }

  /**
   * Keep facts the user stated about themselves, without asking the model.
   *
   * The model has the `remember` tool, but it sometimes answers запомнил in
   * words; these statements are unambiguous, so they are stored directly and cost
   * no tokens.
   */
  async rememberStatedFacts(userId, prompt) {
    if (!this.profiles || userId === undefined) return
    const facts = detectFacts(prompt)
    if (facts.length === 0) return
    let changed = false
    for (const item of facts) {
      try {
        const { duplicate } = this.profiles.store.addFact(userId, item.fact)
        if (!duplicate) changed = true
        if (item.city) {
          this.profiles.store.setCity(userId, item.city)
          changed = true
        }
      } catch (error) {
        this.logger.debug('auto-memory skipped', { error })
      }
    }
    if (changed) {
      await this.profiles.store.flush()
      this.logger.info('facts remembered automatically', { userId, facts: facts.length })
    }
  }

  /** Local time of a reminder, in the configured zone. */
  formatReminderTime(dueAt) {
    const zone = this.config.time?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone
    return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short', timeZone: zone }).format(new Date(dueAt))
  }

  /**
   * Deliver one fired reminder.
   *
   * @param {object} reminder - stored reminder.
   * @param {object} [info] - `lateNotice` marks reminders that were overdue at startup.
   */
  /**
   * Send a generated file to the chat.
   *
   * Platforms without file support get an explanation instead of silence, and a
   * failed upload never breaks the turn: the text answer is already delivered.
   *
   * @param {number|string} chatId - target chat.
   * @param {object} file - `{ bytes, fileName, caption }`.
   * @param {number|string} [replyToMessageId] - message to reply to.
   * @returns {Promise<boolean>} whether the file was sent.
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

  async deliverReminder(reminder, { lateNotice = false } = {}) {
    // Quiet hours first: a reminder that would fire at 03:00 is moved to the end of
    // the window instead of waking anyone up.
    const quietEnd = this.quietHoursEnd(new Date())
    if (quietEnd) {
      try {
        const moved = this.reminders?.store.add({
          chatId: reminder.chatId,
          userId: reminder.userId,
          text: reminder.text,
          dueAt: quietEnd,
          repeat: reminder.repeat ?? 'none',
        })
        this.reminders?.store.cancel(reminder.chatId, reminder.id, reminder.userId)
        await this.reminders?.store.flush()
        this.logger.info('reminder postponed by quiet hours', { id: reminder.id, to: moved?.dueAt })
      } catch (error) {
        this.logger.warn('quiet hours postponement failed', { error, id: reminder.id })
      }
      return
    }
    const prefix = lateNotice ? '⏰ (пропущено, пока бот не работал) Напоминание' : '⏰ Напоминание'
    // In a group the reminder must name its owner: the chat may have several
    // people with reminders of their own.
    const isGroup = reminder.userId !== undefined && reminder.chatId !== reminder.userId
    const owner = isGroup ? this.profiles?.store.displayName(reminder.userId) : undefined
    await this.send(reminder.chatId, `${prefix}${owner ? ` для ${owner}` : ''}: ${reminder.text}`)
  }

  /**
   * When the quiet window ends, if the current moment is inside it.
   *
   * @param {Date} now - moment to test.
   * @returns {Date|undefined} the end of the window, or undefined when it is not quiet.
   */
  quietHoursEnd(now) {
    const quiet = this.config.quiet
    if (!quiet) return undefined
    const zone = this.config.time?.timeZone ?? ''
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now).map((part) => [part.type, part.value]))
    const minutes = Number(parts.hour) * 60 + Number(parts.minute)
    const crossesMidnight = quiet.start > quiet.end
    const inside = crossesMidnight
      ? (minutes >= quiet.start || minutes < quiet.end)
      : (minutes >= quiet.start && minutes < quiet.end)
    if (!inside) return undefined
    const endHour = String(Math.floor(quiet.end / 60)).padStart(2, '0')
    const endMinute = String(quiet.end % 60).padStart(2, '0')
    let day = { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) }
    // An evening window ends tomorrow; a morning one ends today.
    if (crossesMidnight && minutes >= quiet.start) {
      const next = new Date(Date.UTC(day.year, day.month - 1, day.day) + 24 * 60 * 60 * 1000)
      day = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }
    }
    const stamp = `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}T${endHour}:${endMinute}:00`
    try {
      return zonedTimeToUtc(stamp, zone)
    } catch (error) {
      this.logger.warn('quiet hours calculation failed', { error })
      return undefined
    }
  }

  /** Build and send the morning digest to one chat. */
  async deliverDigest(chatId, userId) {
    if (!this.digest) return
    const text = await this.digest.build(chatId, userId)
    await this.send(chatId, text)
  }

  /**
   * Add one model call to the day's counters.
   *
   * Accounting must never break an answer: a failure here is logged and dropped.
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
   * Warn once a day when the token budget is almost spent.
   *
   * Runs on the accounting path rather than on a timer, so the warning arrives
   * with the very first answer that crosses the line.
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
   * Send a reply.
   *
   * Splitting, formatting and the plain-text retry belong to the adapter, so the
   * core only hands over markdown and an optional neutral keyboard.
   */
  async send(chatId, markdown, replyToMessageId, keyboard) {
    return this.platform.sendText({ chatId, markdown, replyToMessageId, keyboard })
  }

  /** Repeat the typing action while a model call is in flight. */
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
      // A cursor is not always a number: VK uses a string long-poll ts, and
      // dropping it made the bot replay from scratch and lose events.
      const saved = parsed?.offset
      if (Number.isInteger(saved) || (typeof saved === 'string' && saved !== '')) this.offset = saved
      this.logger.info('offset loaded', { offset: this.offset ?? null })
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger.warn('offset file ignored', { error })
    }
  }

  /**
   * Log a periodic liveness line.
   *
   * A 24/7 process is otherwise silent, and "is it alive?" should be answerable
   * from the log alone, without attaching a debugger or checking the socket.
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
   * Warn the owner before the disk is full.
   *
   * The bot survived a full filesystem silently while the remote watchdog was
   * unreachable, and it lost its polling cursor to a truncated write. The process
   * that suffers is the best witness, so it speaks up — at most once an hour.
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
      // Atomic and length-checked: writing straight into the file truncates it
      // first, so a full disk once left the cursor as a 0-byte file and the bot
      // would have replayed its whole backlog after a restart.
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

/** Parse `/name@bot args`, returning undefined for ordinary text. */
export function parseCommand(text, username) {
  if (!text.startsWith('/')) return undefined
  const [head, ...rest] = text.split(/\s+/)
  const [rawName, target] = head.slice(1).split('@')
  if (target && username && target.toLowerCase() !== username.toLowerCase()) return undefined
  return { name: rawName.toLowerCase(), args: rest.join(' ') }
}

const stripMention = (text, username) =>
  username ? text.replace(new RegExp(`@${username}\\b`, 'gi'), '').trim() : text

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Backwards-compatible alias: the class used to be Telegram-only.
 *
 * @deprecated use `Assistant`.
 */
export const TelegramAgentBot = Assistant
