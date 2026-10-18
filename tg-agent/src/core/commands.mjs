/**
 * Маршрутизатор команд `/...`.
 *
 * Разбор команды и её исполнение отделены от обработки обычного сообщения:
 * конвейер разговора только спрашивает маршрутизатор, является ли текст
 * командой, и передаёт её сюда. Тексты ответов и порядок веток перенесены из
 * ядра дословно.
 */
import { MOODS, MOOD_NAMES, PERSONAS, PERSONA_NAMES, moodOf } from '../personas.mjs'
import { capabilityHelp } from './capabilities.mjs'
import { buildExportDocument, buildExportPdf, exportToMarkdown } from './export.mjs'
import { MODES } from './modes.mjs'

// Режимы живут в общем модуле; реэкспорт оставлен для прежних импортов.
export { MODES }

// Текст ответа — Markdown: `send()` превращает его в HTML и экранирует всё
// остальное, поэтому сырой HTML сюда передавать нельзя.
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

/**
 * Собрать маршрутизатор для одного бота.
 *
 * Маршрутизатор получает сам бот: ему нужны история, профили, домены,
 * доставка и настройки. Это оставляет ядро тонким, а команды — в одном месте.
 *
 * @param {object} bot - экземпляр `Assistant`.
 * @returns {{runCommand: (command: {name: string, args: string}, message: object) => Promise<void>}}
 */
export function createCommandRouter(bot) {
  /**
   * Исполнить одну команду.
   *
   * @param {{name: string, args: string}} command - результат {@link parseCommand}.
   * @param {object} message - входящее сообщение.
   */
  async function runCommand({ name, args }, message) {
    const chatId = message.chat.id
    switch (name) {
      case 'export': {
        // Необязательный аргумент — формат файла. Пустой аргумент оставляет
        // прежнюю текстовую выгрузку без изменений.
        const format = String(args ?? '').trim().toLowerCase()
        const now = new Date()
        // Всё, что бот знает об этом человеке, — в одном файле, который принадлежит ему.
        const fileName = `vygruzka-${now.toISOString().slice(0, 10)}`
        if (format === 'pdf') {
          try {
            const document = buildExportDocument({ bot, chatId, userId: message.from.id, now })
            const bytes = buildExportPdf(document)
            await bot.sendFile(
              chatId,
              { bytes, fileName: `${fileName}.pdf`, caption: 'Ваши данные из бота' },
              message.message_id,
            )
          } catch (error) {
            // Причина уже сформулирована для человека; бот продолжает работать.
            await bot.send(chatId, error?.message ?? 'Не удалось собрать PDF. Попробуйте `/export` текстом.')
          }
          return
        }
        // Любой другой аргумент (и его отсутствие) — прежняя текстовая выгрузка.
        // Разделы строятся один раз: текст и PDF видят одни и те же данные.
        const document = buildExportDocument({ bot, chatId, userId: message.from.id, now })
        await bot.sendFile(
          chatId,
          { bytes: Buffer.from(exportToMarkdown(document), 'utf8'), fileName: `${fileName}.md`, caption: 'Ваши данные из бота' },
          message.message_id,
        )
        return
      }
      case 'app': {
        const appUrl = bot.config.miniapp?.url
        if (!appUrl) {
          await bot.send(chatId, 'Приложение ещё не настроено: нужен публичный HTTPS-адрес.')
          return
        }
        await bot.send(chatId, '**Панель управления**\nНапоминания, календарь, память и расход — в удобном виде, прямо внутри Telegram.', undefined, { rows: [[{ text: 'Открыть приложение', webApp: appUrl }]] })
        return
      }
      case 'search': {
        const query = String(args ?? '').trim()
        if (query === '') {
          await bot.send(chatId, 'Что искать? Например: `/search ремонт`.')
          return
        }
        await bot.send(chatId, await bot.searchHistory(String(chatId), query))
        return
      }
      case 'agents': {
        if (!bot.agentBridge?.enabled || typeof bot.agentBridge.agents !== 'function') {
          await bot.send(chatId, 'Агенты недоступны: мост к агенту выключен или старый контракт.')
          return
        }
        try {
          const agents = await bot.agentBridge.agents()
          if (agents.length === 0) {
            await bot.send(chatId, 'Агенты не зарегистрированы.')
            return
          }
          const lines = agents.map((agent) => [
            `• ${agent.id}${agent.modelProfile ? ` · ${agent.modelProfile}` : ''} — ${agent.status ?? 'ready'}`,
            agent.capabilities?.length ? `  ${agent.capabilities.join(', ')}` : '',
          ].filter(Boolean).join('\n'))
          await bot.send(chatId, ['**Агенты**', ...lines].join('\n'))
        } catch (error) {
          await bot.send(chatId, `Не удалось получить агентов: ${String(error?.message ?? error).slice(0, 160)}`)
        }
        return
      }
      case 'activity': {
        if (!bot.agentBridge?.enabled || typeof bot.agentBridge.activity !== 'function') {
          await bot.send(chatId, 'Активность недоступна: мост к агенту выключен или старый контракт.')
          return
        }
        const parts = String(args ?? '').trim().split(/\s+/).filter(Boolean)
        const agent = parts.find((part) => !/^\d+$/.test(part))
        const limitPart = parts.find((part) => /^\d+$/.test(part))
        try {
          const events = await bot.agentBridge.activity({ limit: limitPart ? Number(limitPart) : 15, agent })
          if (events.length === 0) {
            await bot.send(chatId, 'Событий активности пока нет.')
            return
          }
          const lines = events.map((event) => `• ${event.taskId ?? '—'} · ${event.agent ?? '—'} · ${event.type ?? '—'}${event.status ? ` · ${event.status}` : ''}${event.tokens ? ` · ${event.tokens} ток.` : ''}`)
          await bot.send(chatId, ['**Активность**', ...lines].join('\n'))
        } catch (error) {
          await bot.send(chatId, `Не удалось получить активность: ${String(error?.message ?? error).slice(0, 160)}`)
        }
        return
      }
      case 'agentversion': {
        if (!bot.agentBridge?.enabled || typeof bot.agentBridge.health !== 'function') {
          await bot.send(chatId, 'Версия агента недоступна: мост выключен или старый контракт.')
          return
        }
        try {
          const health = await bot.agentBridge.health()
          await bot.send(chatId, ['**Агент**', `Сервис: ${health.service ?? '—'}`, `Контракт: ${health.contract ?? '—'}`, `Релиз: ${health.release ?? 'неизвестен'}`].join('\n'))
        } catch (error) {
          await bot.send(chatId, `Агент недоступен: ${String(error?.message ?? error).slice(0, 160)}`)
        }
        return
      }
      case 'agentusage': {
        if (!bot.agentBridge?.enabled || typeof bot.agentBridge.usage !== 'function') {
          await bot.send(chatId, 'Расходы агента недоступны: мост выключен или старый контракт.')
          return
        }
        try {
          const usage = await bot.agentBridge.usage()
          const today = usage.today
          const total = usage.total ?? {}
          const todayTokens = typeof today === 'number' ? today : Number(today?.prompt ?? 0) + Number(today?.completion ?? 0)
          const todayRequests = typeof today === 'object' ? (today?.requests ?? 0) : (total.requests ?? 0)
          const lines = [
            '**Расходы агента**',
            `Сегодня: ${todayTokens} ток. (${todayRequests} зап.)`,
            `Всего: ${Number(total.prompt ?? 0) + Number(total.completion ?? 0)} ток. (${total.requests ?? 0} зап.)`,
          ]
          await bot.send(chatId, lines.join('\n'))
        } catch (error) {
          await bot.send(chatId, `Не удалось получить расходы: ${String(error?.message ?? error).slice(0, 160)}`)
        }
        return
      }
      case 'server': {
        if (!bot.server) {
          await bot.send(chatId, 'Состояние сервера недоступно в этой сборке.')
          return
        }
        await bot.send(chatId, await bot.server.execute())
        return
      }
      case 'calendar': {
        if (!bot.events) {
          await bot.send(chatId, 'Календарь выключен в настройках.')
          return
        }
        const result = bot.domain.events.calendar(chatId, { days: 14 })
        await bot.send(chatId, result.text)
        return
      }
      case 'start':
      case 'help':
        // В VK нет меню «/» как в Telegram, поэтому тот же список уходит
        // кнопками: нажатие отправляет подпись, а подпись — это и есть команда.
        await bot.send(chatId, [HELP, '', capabilityHelp(bot.capabilities)].join('\n'), undefined, bot.menuKeyboard())
        return
      case 'whoami':
        await bot.send(chatId, [
          `**user id:** \`${message.from.id}\``,
          `**chat id:** \`${chatId}\``,
          `**chat type:** \`${message.chat.type}\``,
        ].join('\n'))
        return
      case 'new':
        await bot.history.reset(chatId)
        await bot.send(chatId, 'Контекст диалога очищен. Начнём заново.')
        return
      case 'reminders': {
        // Сортировка, подписи повторов и кнопки отмены — правила домена.
        const result = bot.domain.reminders.list({ chatId, userId: message.from.id })
        await bot.send(chatId, result.text, undefined, result.keyboard)
        return
      }
      case 'voice': {
        if (!bot.tts || typeof bot.platform.sendVoice !== 'function') {
          await bot.send(chatId, 'Озвучка недоступна: нужен ключ синтеза речи и поддержка платформы.')
          return
        }
        const value = args.trim().toLowerCase()
        if (value === 'вкл' || value === 'on' || value === 'да') {
          await bot.history.setVoice(chatId, true)
          await bot.send(chatId, 'Озвучка включена: каждый ответ в этом чате будет приходить ещё и голосовым.')
          return
        }
        if (value === 'выкл' || value === 'off' || value === 'нет') {
          await bot.history.setVoice(chatId, false)
          await bot.send(chatId, 'Озвучка выключена — отвечаю только текстом.')
          return
        }
        if (value !== '') {
          await bot.send(chatId, 'Не понял. Напишите `/voice вкл` или `/voice выкл`.')
          return
        }
        const state = bot.history.voice(chatId) ? 'включена' : 'выключена'
        await bot.send(chatId, `Озвучка ответов: **${state}**.\nПереключить: \`/voice вкл\` или \`/voice выкл\`.`)
        return
      }
      case 'character': {
        if (!bot.profiles) {
          await bot.send(chatId, 'Профиль выключен — характер негде хранить.')
          return
        }
        const value = args.trim().toLowerCase()
        if (value === '') {
          const current = bot.profiles.store.persona(message.from.id) ?? 'обычный'
          await bot.send(chatId, [
            `Сейчас мой характер: **${current}**.`,
            `Доступные: ${PERSONA_NAMES.map((name) => '`' + name + '`').join(', ')}.`,
            'Сменить: `/character дружелюбный`. Вернуть обычный: `/character сброс`.',
          ].join('\n'))
          return
        }
        if (value === 'сброс' || value === 'обычный' || value === 'нет') {
          bot.profiles.store.setPersona(message.from.id, '')
          await bot.profiles.store.flush()
          await bot.send(chatId, 'Характер вернулся к обычному.')
          return
        }
        if (!PERSONAS[value]) {
          await bot.send(chatId, `Такого характера нет. Доступные: ${PERSONA_NAMES.join(', ')}.`)
          return
        }
        bot.profiles.store.setPersona(message.from.id, value)
        await bot.profiles.store.flush()
        await bot.send(chatId, `Характер «${value}» включён. ${PERSONAS[value].hint}`)
        return
      }
      case 'mood': {
        if (!bot.profiles) {
          await bot.send(chatId, 'Профиль выключен — настроение негде хранить.')
          return
        }
        const value = args.trim().toLowerCase()
        if (value === '') {
          const pinned = bot.profiles.store.mood(message.from.id)
          const today = moodOf({ mood: pinned }, { userId: message.from.id, now: new Date(), timeZone: bot.config.time?.timeZone })
          await bot.send(chatId, [
            `Сегодня я **${today}**${pinned ? ' (закреплено)' : ' — настроение меняется само каждый день'}.`,
            `Можно закрепить: ${MOOD_NAMES.map((name) => '`' + name + '`').join(', ')}.`,
            'Вернуть автоматическое: `/mood авто`.',
          ].join('\n'))
          return
        }
        if (value === 'авто' || value === 'сброс') {
          bot.profiles.store.setMood(message.from.id, '')
          await bot.profiles.store.flush()
          await bot.send(chatId, 'Настроение снова меняется само — каждый день разное.')
          return
        }
        if (!MOODS[value]) {
          await bot.send(chatId, `Такого настроения нет. Доступные: ${MOOD_NAMES.join(', ')}.`)
          return
        }
        bot.profiles.store.setMood(message.from.id, value)
        await bot.profiles.store.flush()
        await bot.send(chatId, `Настроение закреплено: **${value}**. ${MOODS[value]}`)
        return
      }
      case 'mode': {
        if (!bot.profiles) {
          await bot.send(chatId, 'Профиль выключен.')
          return
        }
        const value = args.trim().toLowerCase()
        const names = Object.keys(MODES)
        if (value === '') {
          const current = bot.profiles.store.mode(message.from.id)
          await bot.send(chatId, [
            current ? `Текущий режим: **${current}**.` : 'Режим не выбран — отвечаю как обычно.',
            `Доступные: ${names.map((name) => '\`' + name + '\`').join(', ')}.`,
            'Сбросить: `/mode сброс`.',
          ].join('\n'))
          return
        }
        if (value === 'сброс' || value === 'нет' || value === 'обычно') {
          bot.profiles.store.setMode(message.from.id, '')
          await bot.profiles.store.flush()
          await bot.send(chatId, 'Режим сброшен — отвечаю как обычно.')
          return
        }
        if (!MODES[value]) {
          await bot.send(chatId, `Не знаю такой режим. Доступные: ${names.join(', ')}.`)
          return
        }
        bot.profiles.store.setMode(message.from.id, value)
        await bot.profiles.store.flush()
        await bot.send(chatId, `Режим «${value}» включён: ${MODES[value]}`)
        return
      }
      case 'city': {
        if (!bot.profiles) {
          await bot.send(chatId, 'Память профиля выключена.')
          return
        }
        // Показ, установка и удаление города — правила домена профилей.
        const result = await bot.domain.profiles.cityCommand(message.from.id, args)
        await bot.send(chatId, result.text)
        return
      }
      case 'memory': {
        if (!bot.profiles) {
          await bot.send(chatId, 'Память профиля выключена.')
          return
        }
        const result = bot.domain.profiles.memoryCommand(message.from.id)
        await bot.send(chatId, result.text)
        return
      }
      case 'forget': {
        if (!bot.profiles) {
          await bot.send(chatId, 'Память профиля выключена.')
          return
        }
        const result = await bot.domain.profiles.forgetCommand(message.from.id, args)
        await bot.send(chatId, result.text)
        return
      }
      case 'stats': {
        if (!bot.usage) {
          await bot.send(chatId, 'Учёт расхода выключен.')
          return
        }
        const zone = bot.config.time?.timeZone ?? ''
        const today = bot.usage.total(new Date(), zone)
        const yesterday = bot.usage.total(new Date(Date.now() - 86_400_000), zone)
        const mine = today.users[String(message.from.id)] ?? { prompt: 0, completion: 0, requests: 0 }
        const fmt = (value) => new Intl.NumberFormat('ru-RU').format(value)
        const lines = [
          `**Расход за сегодня** (${bot.formatReminderTime(new Date())})`,
          `Запросов: ${today.requests}, токенов: ${fmt(today.prompt + today.completion)}`,
          `— запрос: ${fmt(today.prompt)}, ответ: ${fmt(today.completion)}, из них из кеша: ${fmt(today.cached)}`,
          `Ваша доля: ${mine.requests} запрос(ов), ${fmt(mine.prompt + mine.completion)} токенов`,
          `Вчера: ${fmt(yesterday.prompt + yesterday.completion)} токенов за ${yesterday.requests} запрос(ов)`,
        ]
        const limit = bot.config.usage?.dailyLimit ?? 0
        if (limit > 0) {
          const used = today.prompt + today.completion
          lines.push(`Лимит: ${fmt(limit)} токенов в день, израсходовано ${Math.round((used / limit) * 100)}%`)
        } else {
          lines.push('Дневной лимит не задан (`DAILY_TOKEN_LIMIT=0`).')
        }
        await bot.send(chatId, lines.join('\n'))
        return
      }
      case 'digest': {
        if (!bot.digest) {
          const enabled = bot.config.digest?.enabled
          await bot.send(chatId, enabled
            ? 'Дайджест включён, но отправлять некому: задайте `DIGEST_CHAT_IDS` или `ALLOWED_USER_IDS`.'
            : 'Дайджест выключен (`DIGEST=false`).')
          return
        }
        await bot.deliverDigest(chatId, message.from?.id)
        return
      }
      case 'cancel': {
        // Проверка номера и текст ответа — правила домена напоминаний.
        const result = await bot.domain.reminders.cancel({ chatId, userId: message.from.id, id: args })
        await bot.send(chatId, result.text)
        return
      }
      case 'model': {
        const overrides = args.trim()
        if (overrides === '') {
          const current = bot.history.model(chatId) ?? bot.model.name
          await bot.send(chatId, `Текущая модель: \`${current}\`\nСменить: \`/model имя-модели\``)
          return
        }
        if (overrides.length > 120) {
          await bot.send(chatId, 'Слишком длинное имя модели.')
          return
        }
        await bot.history.setModel(chatId, overrides)
        await bot.send(chatId, `Модель для этого чата: \`${overrides}\``)
        return
      }
      default:
        if (message.chat.type === 'private') await bot.send(chatId, 'Неизвестная команда. Список: /help')
    }
  }

  return { runCommand }
}

/**
 * Разобрать `/name@bot args`, вернув undefined для обычного текста.
 *
 * @param {string} text - текст сообщения.
 * @param {string} [username] - имя бота без `@`.
 * @returns {{name: string, args: string}|undefined} команда или undefined.
 */
export function parseCommand(text, username) {
  if (!text.startsWith('/')) return undefined
  const [head, ...rest] = text.split(/\s+/)
  const [rawName, target] = head.slice(1).split('@')
  if (target && username && target.toLowerCase() !== username.toLowerCase()) return undefined
  return { name: rawName.toLowerCase(), args: rest.join(' ') }
}
