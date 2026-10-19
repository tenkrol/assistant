/**
 * Мобильный сайт ассистента: парольный вход, реальные данные бота и настройки.
 *
 * Дизайн — из макета PLB-026. Здесь нет демо-данных: всё читается и пишется через
 * `/api/*` мини-приложения. Cookie сессии HttpOnly, клиент её не видит; каждый
 * изменяющий запрос несёт `X-Mobile-Client: 1` — сервер отклоняет чужие Origin.
 */
/* Высота приложения: visualViewport точнее 100dvh в мобильных браузерах,
   где адресная строка и нижняя панель перекрывают низ экрана. */
let stableViewportHeight = 0

function syncAppHeight() {
  const viewport = window.visualViewport
  // Берём минимум: если браузер отдаёт завышенную высоту (или клавиатура
  // уменьшила visualViewport), нижняя панель не уедет за экран.
  const candidates = [
    viewport && viewport.height,
    document.documentElement.clientHeight,
    window.innerHeight
  ].filter((value) => Number.isFinite(value) && value > 0)
  if (candidates.length === 0) return
  const height = Math.round(Math.min(...candidates))
  if (height <= 0) return
  if (stableViewportHeight === 0) stableViewportHeight = height
  // Клавиатура уменьшает видимую высоту заметно сильнее, чем панель браузера.
  const keyboard = height < stableViewportHeight * 0.8
  const wasKeyboard = document.body.classList.contains('is-keyboard')
  const inset = keyboard ? Math.max(0, stableViewportHeight - height) : 0
  document.documentElement.style.setProperty('--keyboard-inset', inset + 'px')
  // При клавиатуре высоту приложения НЕ уменьшаем: иначе iOS Safari
  // прокручивает visual viewport и шапка уезжает, оставляя пустоту.
  document.documentElement.style.setProperty('--app-height', (keyboard ? stableViewportHeight : height) + 'px')
  document.body.classList.toggle('is-keyboard', keyboard)
  if (!keyboard) stableViewportHeight = height
  if (keyboard) {
    // Safari иногда панорамирует страницу под клавиатуру даже при overflow:hidden.
    window.scrollTo(0, 0)
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
  }
  if (keyboard && !wasKeyboard && document.body.dataset.screen === 'chat') {
    requestAnimationFrame(() => {
      if (typeof chatScrollToBottom === 'function') chatScrollToBottom()
    })
  }
}

syncAppHeight()
window.addEventListener('resize', syncAppHeight)
window.addEventListener('load', syncAppHeight)
window.addEventListener('orientationchange', () => {
  stableViewportHeight = 0
  setTimeout(syncAppHeight, 200)
})
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncAppHeight)
}

const $ = (id) => document.getElementById(id)

const h = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

const NS = 'http://www.w3.org/2000/svg'

const icon = (name) => {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class', 'ic')
  const use = document.createElementNS(NS, 'use')
  use.setAttribute('href', '#i-' + name)
  svg.append(use)
  return svg
}

const capitalize = (value) => (typeof value === 'string' && value !== ''
  ? value.charAt(0).toUpperCase() + value.slice(1)
  : value)

const plural = (n, forms) => {
  const tail = n % 100
  const last = n % 10
  if (last === 1 && tail !== 11) return forms[0]
  if (last >= 2 && last <= 4 && (tail < 10 || tail >= 20)) return forms[1]
  return forms[2]
}

const store = {
  get(key) {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, value)
    } catch {
      /* сайт работает и без сохранения настроек интерфейса */
    }
  }
}

const TELEGRAM = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null
const INIT_DATA = TELEGRAM && typeof TELEGRAM.initData === 'string' ? TELEGRAM.initData : ''
const THEME_KEY = 'plb026.mobile.theme'
const LARGE_TEXT_KEY = 'plb026.mobile.large-text'
const TODAY = new Date()
const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
]
const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
]
const WEEKDAYS_FULL = [
  'воскресенье', 'понедельник', 'вторник', 'среда',
  'четверг', 'пятница', 'суббота'
]
const WEEKDAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

const REPEAT_CHOICES = [
  ['none', 'Без повтора'],
  ['daily', 'Каждый день'],
  ['weekdays', 'По будням'],
  ['weekly', 'Каждую неделю'],
  ['weekly:1', 'Каждый понедельник'],
  ['weekly:2', 'Каждый вторник'],
  ['weekly:3', 'Каждую среду'],
  ['weekly:4', 'Каждый четверг'],
  ['weekly:5', 'Каждую пятницу'],
  ['weekly:6', 'Каждую субботу'],
  ['weekly:7', 'Каждое воскресенье'],
  ['monthly:1', '1-го числа'],
  ['monthly:15', '15-го числа'],
  ['monthly:31', '31-го числа'],
  ['every:15', 'Каждые 15 минут'],
  ['every:30', 'Каждые 30 минут'],
  ['every:60', 'Каждые 60 минут'],
  ['every:120', 'Каждые 2 часа']
]

const state = {
  session: null,
  settings: null,
  reminders: [],
  events: [],
  memory: { facts: [], city: null },
  stats: null,
  chat: null,
  files: null,
  agentFiles: null,
  diskMode: false,
  filesTab: 'documents',
  inbox: null,
  automations: null,
  gmail: null,
  mailMessages: null,
  system: null,
  proactive: null,
  chatReply: null,
  chatSending: false,
  pendingMedia: [],
  chats: [],
  chatTarget: null,
  factQuery: '',
  plansView: 'reminders',
  calendar: { year: TODAY.getFullYear(), month: TODAY.getMonth(), selected: TODAY.getDate(), view: 'month' },
  statsDays: 7,
  loaded: { plans: false, memory: false, settings: false, stats: false, chat: false, files: false, system: false, inbox: false },
  loading: { plans: false, memory: false, settings: false, stats: false, chat: false }
}

/* ============================ Тема ============================ */

let themeMode = store.get(THEME_KEY) || 'dark'

function applyTheme() {
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const effective = themeMode === 'auto' ? (systemDark ? 'dark' : 'light') : themeMode
  document.documentElement.setAttribute('data-theme', effective)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', effective === 'dark' ? '#101923' : '#f3f6fa')
  document.querySelectorAll('[data-theme-mode]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.themeMode === themeMode)
  })
}

function setThemeMode(mode) {
  themeMode = mode
  store.set(THEME_KEY, mode)
  applyTheme()
}

function applyLargeText(on) {
  document.documentElement.classList.toggle('large-text', on)
  $('set-large-text').classList.toggle('is-on', on)
}

/* ============================ Тост ============================ */

let toastTimer = null

function toast(message) {
  const node = $('toast')
  node.textContent = message
  node.classList.add('is-open')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => node.classList.remove('is-open'), 3000)
}

/* ============================ API ============================ */

class ApiError extends Error {
  constructor(message, status, code) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

async function api(method, path, body) {
  const headers = { 'X-Mobile-Client': '1' }
  if (INIT_DATA) headers['X-Telegram-Init-Data'] = INIT_DATA
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let response
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch {
    throw new ApiError('Нет связи с сервером. Проверьте интернет.', 0, 'network')
  }
  const text = await response.text()
  let data = null
  try {
    data = text === '' ? null : JSON.parse(text)
  } catch {
    data = null
  }
  if (!response.ok) {
    const message = data && typeof data.error === 'string'
      ? data.error
      : 'Ошибка ' + response.status
    throw new ApiError(message, response.status, data && data.code)
  }
  return data
}

function handleError(error, fallback = 'Не получилось. Попробуйте ещё раз.') {
  if (error instanceof ApiError && error.status === 401) {
    showLogin('Сессия истекла — войдите заново.')
    return
  }
  toast(error && error.message ? error.message : fallback)
}

/* ============================ Шторка ============================ */

const sheet = $('sheet')
const sheetBackdrop = $('sheet-backdrop')
const sheetTitle = $('sheet-title')
const sheetBody = $('sheet-body')
let sheetOpen = false
let sheetTimer = null

function openSheet({ title, body, mount }) {
  if (sheetTimer) clearTimeout(sheetTimer)
  sheetTitle.textContent = title
  sheetBody.replaceChildren()
  if (typeof body === 'string') sheetBody.innerHTML = body
  else if (body) sheetBody.append(body)
  sheet.hidden = false
  sheetBackdrop.hidden = false
  sheetOpen = true
  requestAnimationFrame(() => {
    sheet.classList.add('is-open')
    sheetBackdrop.classList.add('is-open')
  })
  if (typeof mount === 'function') mount(sheetBody)
}

function closeSheet() {
  if (!sheetOpen) return
  sheetOpen = false
  sheet.classList.remove('is-open')
  sheetBackdrop.classList.remove('is-open')
  sheetTimer = setTimeout(() => {
    if (sheetOpen) return
    sheet.hidden = true
    sheetBackdrop.hidden = true
    sheetBody.replaceChildren()
  }, 280)
}

sheetBackdrop.addEventListener('click', closeSheet)
$('sheet-close').addEventListener('click', closeSheet)
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSheet()
})

function openPicker(title, options, selectedValue, onPick) {
  const wrap = h('div')
  options.forEach((option) => {
    const row = h('button', 'picker-row' + (option.value === selectedValue ? ' is-active' : ''))
    row.type = 'button'
    row.append(h('b', null, option.label))
    const check = icon('check')
    check.classList.add('check')
    row.append(check)
    row.addEventListener('click', () => {
      onPick(option.value, option.label)
      closeSheet()
    })
    wrap.append(row)
  })
  openSheet({ title, body: wrap })
}

function confirmSheet(title, message, confirmLabel, onConfirm) {
  const wrap = h('div')
  wrap.append(h('p', 'sheet-note', message))
  const buttons = h('div')
  buttons.style.display = 'flex'
  buttons.style.gap = '8px'
  buttons.style.marginTop = '16px'
  const cancel = h('button', 'btn btn-ghost', 'Отмена')
  cancel.type = 'button'
  cancel.style.flex = '1'
  cancel.addEventListener('click', closeSheet)
  const confirm = h('button', 'btn btn-danger-ghost', confirmLabel)
  confirm.type = 'button'
  confirm.style.flex = '1'
  confirm.addEventListener('click', () => {
    closeSheet()
    onConfirm()
  })
  buttons.append(cancel, confirm)
  wrap.append(buttons)
  openSheet({ title, body: wrap })
}

function field(label, control) {
  const wrap = h('label', 'field')
  wrap.append(h('span', null, label), control)
  return wrap
}

/* ============================ Навигация ============================ */

const screens = new Map()
document.querySelectorAll('.screen').forEach((node) => screens.set(node.dataset.screen, node))

const TAB_OF = {
  chat: 'chat',
  plans: 'plans',
  memory: 'memory',
  agent: 'agent',
  more: 'more',
  settings: 'more',
  stats: 'more'
}

let currentScreen = 'chat'

function go(name, options = {}) {
  if (!screens.has(name)) return
  currentScreen = name
  screens.forEach((node, key) => {
    const active = key === name
    node.hidden = !active
    node.classList.toggle('is-active', active)
  })
  document.body.dataset.screen = name
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.go === TAB_OF[name])
  })
  closeSheet()
  if (options.push !== false) {
    try {
      history.pushState({ screen: name }, '', '#' + name)
    } catch {
      location.hash = name
    }
  }
  if (name === 'plans') ensurePlans()
  if (name === 'memory') ensureMemory()
  if (name === 'settings') ensureSettings()
  if (name === 'stats') ensureStats()
  if (name === 'files') ensureFiles()
  if (name === 'inbox') ensureInbox()
  if (name === 'automations') ensureAutomations()
  if (name === 'mail') ensureMail()
  if (name === 'system') ensureSystem()
  if (name === 'agent') ensureAgent()
  if (name === 'chat') ensureChat()
  const active = screens.get(name)
  if (active) {
    const scroller = active.querySelector('.screen-scroll, .chat-scroll')
    if (scroller) scroller.scrollTop = scroller.scrollTop
  }
}

document.addEventListener('click', (event) => {
  const goNode = event.target.closest('[data-go]')
  if (goNode) {
    go(goNode.dataset.go)
    return
  }
  const backNode = event.target.closest('[data-back]')
  if (backNode) go(backNode.dataset.back)
})

window.addEventListener('popstate', (event) => {
  const name = (event.state && event.state.screen) || (location.hash ? location.hash.slice(1) : 'chat')
  if (screens.has(name) && state.session) go(name, { push: false })
})

/* ============================ Форматирование ============================ */

const dateTimeFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
})
const timeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' })
const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' })

function formatDateTime(iso) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? String(iso ?? '') : dateTimeFormat.format(date)
}

function formatTime(iso) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : timeFormat.format(date)
}

function localInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function dayKey(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

function startOfDay(date) {
  const copy = new Date(date)
  copy.setHours(0, 0, 0, 0)
  return copy
}

function reminderGroup(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'later'
  const today = startOfDay(new Date())
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const afterTomorrow = new Date(tomorrow)
  afterTomorrow.setDate(afterTomorrow.getDate() + 1)
  if (date < tomorrow) return 'today'
  if (date < afterTomorrow) return 'tomorrow'
  return 'later'
}

/* ============================ Авторизация ============================ */

function showLogin(message) {
  state.session = null
  $('boot').hidden = true
  screens.forEach((node) => { node.hidden = node.dataset.screen !== 'auth' })
  document.body.dataset.screen = 'auth'
  $('login-error').hidden = !message
  $('login-error').textContent = message || ''
  $('login-password').value = ''
  $('login-submit').disabled = false
  $('login-label').textContent = 'Войти'
  setTimeout(() => $('login-password').focus(), 50)
}

function showApp(session) {
  state.session = session
  renderTotpRow()
  $('boot').hidden = true
  applyLargeText(store.get(LARGE_TEXT_KEY) === '1')
  go('chat', { push: false })
  const telegramUrl = session.telegramUrl || 'https://t.me/Tenkrol_bot'
  ;['open-telegram', 'agent-telegram'].forEach((id) => {
    const link = $(id)
    if (link) link.href = telegramUrl
  })
  void Promise.allSettled([
    loadChats(),
    loadChat(),
    loadPlans(),
    loadMemory(),
    loadSettings(),
    loadStats()
  ])
  refreshProfile()
  startChatPoll()
  void refreshPushToggle()
}

async function login(event) {
  if (event) event.preventDefault()
  const userInput = $('login-username')
  const input = $('login-password')
  const username = userInput.value.trim()
  const password = input.value
  if (username === '' || password === '') {
    $('login-error').hidden = false
    $('login-error').textContent = 'Введите логин и пароль'
    ;(username === '' ? userInput : input).focus()
    return
  }
  const button = $('login-submit')
  const codeInput = $('login-code')
  const codeField = $('login-code-field')
  button.disabled = true
  $('login-error').hidden = true
  $('login-label').textContent = 'Проверяю…'
  try {
    await api('POST', '/api/auth/login', { username, password, code: codeInput.value.trim() })
    const session = await api('GET', '/api/auth/session')
    showApp(session)
    toast('Вход выполнен')
  } catch (error) {
    if (error.code === 'totp_required' || (error.code === 'totp_invalid' && codeField.hidden)) {
      codeField.hidden = false
      codeInput.focus()
      $('login-error').hidden = false
      $('login-error').textContent = error.code === 'totp_invalid'
        ? 'Неверный код. Попробуйте ещё раз.'
        : 'Введите код из приложения-аутентификатора'
      button.disabled = false
      $('login-label').textContent = 'Войти с кодом'
      return
    }
    if (error.code === 'totp_invalid') {
      $('login-error').hidden = false
      $('login-error').textContent = 'Неверный код. Попробуйте ещё раз.'
      button.disabled = false
      $('login-label').textContent = 'Войти с кодом'
      codeInput.select()
      return
    }
    $('login-error').hidden = false
    $('login-error').textContent = error.message || 'Не удалось войти'
    button.disabled = false
    $('login-label').textContent = 'Войти'
    input.select()
  }
}

async function logout() {
  try {
    await api('POST', '/api/auth/logout')
  } catch {
    /* cookie всё равно будет удалена после ответа; показываем вход */
  }
  showLogin()
}

async function boot() {
  applyTheme()
  applyLargeText(store.get(LARGE_TEXT_KEY) === '1')

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themeMode === 'auto') applyTheme()
  })
  if (TELEGRAM) {
    try {
      TELEGRAM.ready && TELEGRAM.ready()
      TELEGRAM.expand && TELEGRAM.expand()
    } catch {
      /* окружение Telegram может не поддерживать вызов */
    }
  }
  try {
    const session = await api('GET', '/api/auth/session')
    showApp(session)
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      showLogin()
      return
    }
    $('boot').replaceChildren()
    $('boot').append(
      h('b', null, 'Не удалось подключиться'),
      h('span', null, error.message || 'Сервер не отвечает'),
    )
    const retry = h('button', 'btn btn-ghost btn-sm', 'Повторить')
    retry.type = 'button'
    retry.addEventListener('click', () => location.reload())
    $('boot').append(retry)
  }
}

/* ============================ Чат ============================ */

async function loadChats() {
  try {
    const data = await api('GET', '/api/chats')
    state.chats = Array.isArray(data.chats) ? data.chats : []
    if (!state.chatTarget) {
      state.chatTarget = state.chats[0] || { id: null, type: 'private', title: 'Личный чат' }
    }
    renderChatSwitch()
    updateChatHeader()
  } catch (error) {
    if (error.status !== 401) $('chat-switch').hidden = true
  }
}

function renderChatSwitch() {
  const box = $('chat-switch')
  if (state.chats.length <= 1) {
    box.hidden = true
    return
  }
  box.hidden = false
  box.replaceChildren()
  renderDesktopChats()
  state.chats.forEach((chat) => {
    const button = h('button', 'chip' + (String(chat.id) === String(state.chatTarget && state.chatTarget.id) ? ' is-active' : ''), chat.title)
    button.type = 'button'
    if (chatUnread(chat)) {
      const dot = h('span', 'chat-unread-dot')
      button.append(dot)
    }
    button.addEventListener('click', () => selectChat(chat))
    box.append(button)
  })
}

function readKey(chatId) {
  return 'chat-read:' + String(chatId)
}

function markChatRead(chatId, at) {
  if (chatId === null || chatId === undefined) return
  store.set(readKey(chatId), at || new Date().toISOString())
  renderDesktopChats()
}

function chatUnread(chat) {
  if (!chat || !chat.lastAt) return false
  const seen = store.get(readKey(chat.id))
  return !seen || String(chat.lastAt) > String(seen)
}

function renderDesktopChats() {
  const box = $('desktop-chats')
  if (!box) return
  const chats = state.chats || []
  if (chats.length === 0) {
    box.replaceChildren()
    return
  }
  box.replaceChildren(h('div', 'desktop-chats-head', 'Чаты'))
  chats.forEach((chat) => {
    const button = h('button', 'desktop-chat' + (String(chat.id) === String(state.chatTarget && state.chatTarget.id) ? ' is-active' : ''))
    button.type = 'button'
    const avatar = h('span', 'desktop-chat-avatar', chat.type === 'private' ? 'Л' : 'М')
    const body = h('span', 'desktop-chat-body')
    body.append(h('b', null, chat.title))
    if (chat.lastMessage) body.append(h('span', null, chat.lastMessage))
    button.append(avatar, body)
    if (chatUnread(chat)) button.append(h('span', 'desktop-chat-dot'))
    button.addEventListener('click', () => {
      go('chat')
      selectChat(chat)
    })
    box.append(button)
  })
}

function updateChatHeader() {
  const group = state.chatTarget && state.chatTarget.type !== 'private'
  $('chat-input').placeholder = group ? 'В общий чат… (@бот или ответ)' : 'Написать ассистенту…'
}

function selectChat(chat) {
  if (String(chat.id) === String(state.chatTarget && state.chatTarget.id)) {
    go('chat')
    return
  }
  state.chatTarget = chat
  state.chat = null
  clearChatReply()
  clearPendingMedia()
  state.loaded.chat = false
  hideChatTyping()
  renderChatSwitch()
  updateChatHeader()
  $('chat-messages').replaceChildren()
  const loading = h('div', 'loading-inline')
  loading.append(h('span', 'spinner'), h('span', null, 'Загружаю историю…'))
  $('chat-messages').append(loading)
  void loadChat()
}

async function ensureChat() {
  if (!state.loaded.chat && !state.loading.chat) await loadChat()
}

let groupPollTimer = null
let groupPollInFlight = false

function sameMessages(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  return left.every((item, index) => item.role === right[index].role
    && item.text === right[index].text
    && item.author === right[index].author
    && (item.replyTo && item.replyTo.text ? item.replyTo.text : '') === (right[index].replyTo && right[index].replyTo.text ? right[index].replyTo.text : '')
    && (item.avatar || '') === (right[index].avatar || '')
    && JSON.stringify((item.attachments || []).map((a) => a.id)) === JSON.stringify((right[index].attachments || []).map((a) => a.id))
    && (item.at || '') === (right[index].at || '')
    && (item.reaction || '') === (right[index].reaction || ''))
}

async function refreshChatHistory() {
  if (groupPollInFlight || document.hidden || currentScreen !== 'chat') return
  const target = state.chatTarget
  if (!target || state.loading.chat) return
  if (state.chatSending) return
  groupPollInFlight = true
  try {
    const data = await api('GET', '/api/chat/history?limit=60&chatId=' + encodeURIComponent(target.id))
    if (!state.chatTarget || String(state.chatTarget.id) !== String(target.id)) return
    if (data.chat) state.chatTarget = { id: String(data.chat.chatId), type: data.chat.type, title: data.chat.title }
    const previous = state.chat && state.chat.messages
    state.chat = data
    if (!sameMessages(previous, data.messages)) {
      renderChat()
      chatScrollToBottom()
    }
  } catch {
    /* тихий опрос: сеть моргнула — попробуем в следующий раз */
  } finally {
    groupPollInFlight = false
  }
}

function startChatPoll() {
  if (groupPollTimer) return
  groupPollTimer = setInterval(() => { void refreshChatHistory() }, 5000)
}

let chatLoadSeq = 0

async function loadChat() {
  const seq = ++chatLoadSeq
  state.loading.chat = true
  try {
    const target = state.chatTarget
    const targetId = target && target.id !== null && target.id !== undefined ? String(target.id) : ''
    const chatQuery = targetId ? '&chatId=' + encodeURIComponent(targetId) : ''
    const data = await api('GET', '/api/chat/history?limit=60' + chatQuery)
    // Пока грузилась история, могли переключить личный/общий чат.
    if (seq !== chatLoadSeq) return
    state.chat = data
    if (data.chat) {
      state.chatTarget = {
        id: String(data.chat.chatId),
        type: data.chat.type,
        title: data.chat.title
      }
    }
    state.loaded.chat = true
    markChatRead(state.chatTarget && state.chatTarget.id, state.chat && state.chat.messages && state.chat.messages.at(-1)?.at)
    renderChat()
    const telegramUrl = data.telegramUrl || (state.session && state.session.telegramUrl)
    if (telegramUrl) {
      const link = $('agent-telegram')
      if (link) link.href = telegramUrl
    }
  } catch (error) {
    if (seq === chatLoadSeq && error.status !== 401) {
      $('chat-messages').replaceChildren(renderError('Не удалось загрузить историю', () => {
        state.loaded.chat = false
        void loadChat()
      }))
    }
  } finally {
    if (seq === chatLoadSeq) state.loading.chat = false
  }
}

function renderChat() {
  const box = $('chat-messages')
  box.replaceChildren()
  const messages = state.chat && Array.isArray(state.chat.messages) ? state.chat.messages : []
  if (messages.length === 0) {
    const empty = h('div', 'chat-empty')
    const iconBox = h('div', 'chat-empty-icon')
    iconBox.append(icon('chat'))
    const group = state.chatTarget && state.chatTarget.type !== 'private'
    empty.append(iconBox, h('b', null, group ? 'Напишите в общий чат' : 'Напишите ассистенту'), h('span', null, group ? 'Сообщение увидят участники. Бот ответит, если упомянуть @бота или ответить на его сообщение.' : 'Сообщение уйдёт в тот же диалог, что и в Telegram. Ответ появится здесь.'))
    box.append(empty)
    return
  }
  const day = h('div', 'day-chip', state.chatTarget && state.chatTarget.type !== 'private' ? state.chatTarget.title : 'Диалог с ассистентом')
  box.append(day)
  messages.forEach((message, index) => {
    let status
    if (message.role === 'user') {
      if (message.readAt) status = 'read'
      else if (message.deliveredAt) status = 'delivered'
      else if (messages.slice(index + 1).some((next) => next.role === 'assistant')) status = 'read'
      else status = 'sent'
    }
    box.append(chatMessageNode(message.role, message.text, message.author, message.replyTo, message.avatar, message.attachments, message.at, message.id, message.reaction, status))
  })
  chatScrollToBottom()
}

function setChatReply(message) {
  if (!message || typeof message.text !== 'string' || message.text.trim() === '') return
  state.chatReply = {
    text: message.text.slice(0, 1000),
    role: message.role === 'assistant' ? 'assistant' : 'user',
    author: message.author || (message.role === 'assistant' ? 'Ассистент' : 'Вы')
  }
  $('reply-author').textContent = state.chatReply.author
  $('reply-text').textContent = state.chatReply.text
  $('reply-bar').hidden = false
  const input = $('chat-input')
  if (input) input.focus()
}

function clearChatReply() {
  state.chatReply = null
  const bar = $('reply-bar')
  if (bar) bar.hidden = true
}

async function copyMessageText(text) {
  const value = String(text ?? '')
  if (value === '') return false
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = value
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.append(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }
}

function openEditMessage(message) {
  const wrap = h('div')
  const input = document.createElement('textarea')
  input.className = 'input'
  input.rows = 3
  input.value = message.text || ''
  const save = h('button', 'btn btn-primary btn-block', 'Сохранить')
  save.type = 'button'
  save.addEventListener('click', async () => {
    if (input.value.trim() === '') return
    save.disabled = true
    try {
      await api('PATCH', '/api/chat/message/' + encodeURIComponent(message.id), {
        chatId: state.chatTarget && state.chatTarget.id !== null ? state.chatTarget.id : undefined,
        text: input.value.trim(),
      })
      closeSheet()
      const target = state.chat?.messages?.find((item) => item.id === message.id)
      if (target) target.text = input.value.trim()
      renderChat()
      toast('Сообщение изменено')
    } catch (error) {
      save.disabled = false
      toast(error.message || 'Не удалось изменить сообщение')
    }
  })
  wrap.append(field('Текст', input), save)
  openSheet({ title: 'Изменить сообщение', body: wrap })
}

async function deleteChatMessage(message) {
  try {
    const chatId = state.chatTarget && state.chatTarget.id !== null ? state.chatTarget.id : ''
    await api('DELETE', '/api/chat/message/' + encodeURIComponent(message.id) + '?chatId=' + encodeURIComponent(chatId))
    if (state.chat?.messages) state.chat.messages = state.chat.messages.filter((item) => item.id !== message.id)
    renderChat()
    toast('Сообщение удалено')
  } catch (error) {
    toast(error.message || 'Не удалось удалить сообщение')
  }
}

async function setMessageReaction(message, reaction) {
  if (!message || !message.id) {
    toast('Реакции доступны для сообщений из истории — обновите чат')
    return
  }
  try {
    const data = await api('POST', '/api/chat/react', {
      chatId: state.chatTarget && state.chatTarget.id !== null ? state.chatTarget.id : undefined,
      messageId: message.id,
      reaction,
    })
    if (state.chat && Array.isArray(state.chat.messages)) {
      const target = state.chat.messages.find((item) => item.id === message.id)
      if (target) target.reaction = data.reaction || undefined
    }
    renderChat()
  } catch (error) {
    toast(error.message || 'Не удалось поставить реакцию')
  }
}

function openMessageMenu(message) {
  const wrap = h('div', 'message-menu')
  const quote = h('div', 'message-menu-quote', String(message.text ?? '').slice(0, 400))
  const reply = h('button', null)
  reply.type = 'button'
  reply.append(icon('repeat'), h('span', null, 'Ответить'))
  reply.addEventListener('click', () => {
    closeSheet()
    setChatReply(message)
  })
  const copy = h('button', null)
  copy.type = 'button'
  copy.append(icon('copy'), h('span', null, 'Копировать текст'))
  copy.addEventListener('click', async () => {
    const ok = await copyMessageText(message.text)
    closeSheet()
    toast(ok ? 'Скопировано' : 'Не удалось скопировать')
  })
  const reactions = h('div', 'msg-reactions')
  ;['👍', '❤️', '🔥', '😂', '😮'].forEach((emoji) => {
    const button = h('button', 'msg-reaction-btn' + (message.reaction === emoji ? ' is-active' : ''), emoji)
    button.type = 'button'
    button.addEventListener('click', async () => {
      closeSheet()
      await setMessageReaction(message, message.reaction === emoji ? '' : emoji)
    })
    reactions.append(button)
  })
  const forward = h('button', null)
  forward.type = 'button'
  forward.append(icon('send'), h('span', null, 'Сохранить в заметки'))
  forward.addEventListener('click', async () => {
    const text = String(message.text || '').trim()
    if (text === '') {
      toast('В сообщении нет текста для заметки')
      return
    }
    closeSheet()
    try {
      await api('POST', '/api/inbox', { text })
      state.loaded.inbox = false
      toast('Сохранено в инбокс')
    } catch (error) {
      toast(error.message || 'Не удалось сохранить в заметки')
    }
  })
  if (message.role === 'user' && message.id) {
    const edit = h('button', null)
    edit.type = 'button'
    edit.append(icon('pencil'), h('span', null, 'Изменить'))
    edit.addEventListener('click', () => { closeSheet(); openEditMessage(message) })
    const remove = h('button', null)
    remove.type = 'button'
    remove.append(icon('trash'), h('span', null, 'Удалить'))
    remove.addEventListener('click', () => {
      closeSheet()
      confirmSheet('Удалить сообщение?', 'Оно исчезнет из сайта и из Telegram.', 'Удалить', () => void deleteChatMessage(message))
    })
    wrap.append(edit, remove)
  }
  wrap.append(quote, reactions, reply, forward, copy)
  openSheet({ title: 'Сообщение', body: wrap })
}

function bindMessageGesture(bubble, message) {
  let startX = 0
  let startY = 0
  let dx = 0
  let moved = false
  let swiping = false
  let longPress = null
  const article = bubble.closest('.msg')

  const reset = () => {
    if (longPress) clearTimeout(longPress)
    longPress = null
    bubble.style.transform = ''
    if (article) article.classList.remove('is-swiping')
    swiping = false
    moved = false
    dx = 0
  }

  bubble.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) return
    startX = event.touches[0].clientX
    startY = event.touches[0].clientY
    dx = 0
    moved = false
    swiping = false
    longPress = setTimeout(() => {
      longPress = null
      if (!moved) openMessageMenu(message)
    }, 520)
  }, { passive: true })

  bubble.addEventListener('touchmove', (event) => {
    if (event.touches.length !== 1) return
    const moveX = event.touches[0].clientX - startX
    const moveY = event.touches[0].clientY - startY
    dx = moveX
    if (Math.abs(moveX) > 8 || Math.abs(moveY) > 8) {
      moved = true
      if (longPress) clearTimeout(longPress)
      longPress = null
    }
    if (moveX > 10 && moveX > Math.abs(moveY) * 1.4) {
      swiping = true
      if (article) article.classList.add('is-swiping')
      bubble.style.transform = 'translateX(' + Math.min(moveX, 72) * 0.7 + 'px)'
      if (event.cancelable) event.preventDefault()
    }
  }, { passive: false })

  bubble.addEventListener('touchend', () => {
    const shouldReply = swiping && dx > 45
    const captured = message
    reset()
    if (shouldReply) setChatReply(captured)
  }, { passive: true })

  bubble.addEventListener('touchcancel', reset)
  bubble.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    openMessageMenu(message)
  })
}

function openMediaViewer(attachment) {
  const viewer = h('div', 'media-viewer')
  if (attachment.kind === 'video') {
    const video = document.createElement('video')
    video.src = attachment.url
    video.controls = true
    video.autoplay = true
    video.playsInline = true
    viewer.append(video)
  } else {
    const image = document.createElement('img')
    image.src = attachment.url
    image.alt = attachment.name || ''
    viewer.append(image)
  }
  const close = () => viewer.remove()
  viewer.addEventListener('click', close)
  document.addEventListener('keydown', function onKey(event) {
    if (event.key === 'Escape') {
      close()
      document.removeEventListener('keydown', onKey)
    }
  })
  document.body.append(viewer)
}

function chatMediaNode(attachments) {
  const box = h('div', 'chat-media-box')
  attachments.forEach((attachment) => {
    if (!attachment || !attachment.url) return
    if (attachment.kind === 'voice') {
      const audio = document.createElement('audio')
      audio.className = 'chat-audio'
      audio.src = attachment.url
      audio.controls = true
      audio.preload = 'metadata'
      box.append(audio)
    } else if (attachment.kind === 'video') {
      const video = document.createElement('video')
      video.className = 'chat-media'
      video.src = attachment.url
      video.controls = true
      video.playsInline = true
      video.preload = 'metadata'
      box.append(video)
    } else {
      const image = document.createElement('img')
      image.className = 'chat-media'
      image.src = attachment.url
      image.alt = attachment.name || 'фото'
      image.loading = 'lazy'
      image.addEventListener('click', () => openMediaViewer(attachment))
      box.append(image)
    }
  })
  return box
}

function chatMessageNode(role, text, author, replyTo, avatar, attachments, at, messageId, reaction, status) {
  const ownName = state.session && state.session.user ? state.session.user.telegramName : ''
  const otherAuthor = role === 'user' && author && ownName && author !== ownName
  const article = h('article', 'msg ' + (role === 'assistant' || otherAuthor ? 'msg-bot' : 'msg-user'))
  let bubble
  if (role === 'assistant' || otherAuthor) {
    const avatarBox = h('div', 'msg-avatar')
    if (otherAuthor) {
      const fallback = h('span', 'msg-initial', String(author).slice(0, 1).toUpperCase())
      if (avatar) {
        const image = document.createElement('img')
        image.className = 'msg-avatar-img'
        image.src = avatar
        image.alt = ''
        image.loading = 'lazy'
        image.addEventListener('error', () => image.replaceWith(fallback), { once: true })
        avatarBox.append(image)
      } else {
        avatarBox.append(fallback)
      }
    } else {
      avatarBox.append(icon('spark'))
    }
    const stack = h('div', 'msg-stack')
    bubble = h('div', 'bubble bubble-bot')
    stack.append(bubble)
    article.append(avatarBox, stack)
  } else {
    bubble = h('div', 'bubble bubble-user')
    article.append(bubble)
  }
  if (replyTo && replyTo.text) {
    const quote = h('div', 'reply-quote')
    quote.append(h('b', null, replyTo.author || (replyTo.role === 'assistant' ? 'Ассистент' : 'Вы')))
    quote.append(h('span', null, String(replyTo.text).slice(0, 300)))
    bubble.append(quote)
  }
  const media = Array.isArray(attachments) ? attachments.filter((item) => item && item.url) : []
  if (media.length > 0) {
    bubble.classList.add('has-media')
    bubble.append(chatMediaNode(media))
  }
  const placeholder = /^\[(фото|видео|голосовое)(,\s*(фото|видео|голосовое))*\]$/i.test(String(text || '').trim())
  if (text && !(media.length > 0 && placeholder)) bubble.append(h('div', 'bubble-text', text))
  if (reaction) {
    bubble.append(h('div', 'msg-reaction', reaction))
    article.classList.add('has-reaction')
  }
  if (at) {
    const meta = h('div', 'msg-meta')
    const time = h('span', 'msg-time', formatTime(at))
    meta.append(time)
    if (status) {
      const tick = h('span', 'msg-status' + (status === 'read' ? ' is-read' : ''), status === 'sent' ? '✓' : '✓✓')
      tick.title = status === 'read' ? 'прочитано' : status === 'delivered' ? 'доставлено' : 'отправлено'
      meta.append(tick)
    }
    bubble.append(meta)
  }
  const replyText = text || (media.length > 0 ? (media[0].kind === 'video' ? '[видео]' : media[0].kind === 'voice' ? '[голосовое]' : '[фото]') : '')
  bindMessageGesture(bubble, { role, text: replyText, author, id: messageId, reaction })
  return article
}

function chatScrollToBottom() {
  const scroller = $('chat-scroll')
  if (scroller) scroller.scrollTop = scroller.scrollHeight
}

function appendChatMessage(role, text, author, replyTo, attachments, status) {
  const box = $('chat-messages')
  const empty = box.querySelector('.chat-empty')
  if (empty) empty.remove()
  box.append(chatMessageNode(role, text, author, replyTo, undefined, attachments, new Date().toISOString(), undefined, undefined, status))
  chatScrollToBottom()
}

function showChatTyping() {
  let node = $('chat-typing')
  if (node) return node
  node = h('article', 'msg msg-bot')
  node.id = 'chat-typing'
  const avatar = h('div', 'msg-avatar')
  avatar.append(icon('spark'))
  const stack = h('div', 'msg-stack')
  const typing = h('div', 'typing')
  typing.append(h('i'), h('i'), h('i'))
  stack.append(typing)
  node.append(avatar, stack)
  $('chat-messages').append(node)
  chatScrollToBottom()
  return node
}

function hideChatTyping() {
  const node = $('chat-typing')
  if (node) node.remove()
}

function fileMime(name) {
  const ext = String(name).toLowerCase().split('.').pop()
  return ({
    pdf: 'application/pdf',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    csv: 'text/csv',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg'
  })[ext] || 'application/octet-stream'
}

function appendChatFile(file) {
  const card = h('div', 'result-card')
  const head = h('div', 'result-head')
  const ic = h('span', 'result-ic')
  ic.append(icon('file'))
  const text = h('div')
  text.append(h('b', null, file.fileName || 'Файл'), h('span', null, file.caption || (file.size ? Math.ceil(file.size / 1024) + ' КБ' : '')))
  head.append(ic, text)
  card.append(head)
  if (file.data) {
    const link = h('a', 'pill-btn', 'Скачать')
    link.href = 'data:' + fileMime(file.fileName) + ';base64,' + file.data
    link.download = file.fileName || 'file'
    link.style.display = 'inline-flex'
    link.style.alignItems = 'center'
    link.style.justifyContent = 'center'
    link.style.textDecoration = 'none'
    card.append(link)
  } else {
    card.append(h('p', 'hint', 'Файл больше 2 МБ — заберите его в Telegram.'))
  }
  $('chat-messages').append(card)
  chatScrollToBottom()
}

function resizeChatInput() {
  const input = $('chat-input')
  if (!input) return
  input.style.height = 'auto'
  input.style.height = Math.min(input.scrollHeight, 120) + 'px'
}

function updateChatSend() {
  const input = $('chat-input')
  const button = $('chat-send')
  if (!input || !button) return
  button.disabled = input.value.trim() === '' && state.pendingMedia.length === 0
  resizeChatInput()
}

function mediaKind(file) {
  const type = String(file.type || '')
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'voice'
  return 'photo'
}

function renderAttachPreview() {
  const box = $('attach-preview')
  box.replaceChildren()
  if (state.pendingMedia.length === 0) {
    box.hidden = true
    return
  }
  box.hidden = false
  state.pendingMedia.forEach((item, index) => {
    const thumb = h('div', 'attach-thumb')
    if (item.kind === 'voice') {
      const kind = h('span', 'attach-kind')
      kind.append(icon('mic'))
      thumb.append(kind)
    } else if (item.kind === 'video') {
      const video = document.createElement('video')
      video.src = item.url
      video.muted = true
      video.playsInline = true
      thumb.append(video)
      const kind = h('span', 'attach-kind')
      kind.append(icon('play'))
      thumb.append(kind)
    } else {
      const image = document.createElement('img')
      image.src = item.url
      image.alt = ''
      thumb.append(image)
    }
    const remove = h('button', 'attach-remove')
    remove.type = 'button'
    remove.setAttribute('aria-label', 'Убрать вложение')
    remove.append(icon('close'))
    remove.addEventListener('click', () => removePendingMedia(index))
    thumb.append(remove)
    box.append(thumb)
  })
}

function addPendingMedia(files) {
  const accepted = [...(files || [])]
  for (const file of accepted) {
    if (state.pendingMedia.length >= 4) {
      toast('Можно прикрепить до 4 файлов')
      break
    }
    if (!String(file.type || '').startsWith('image/') && !String(file.type || '').startsWith('video/') && !String(file.type || '').startsWith('audio/')) {
      toast('Можно прикрепить только фото, видео или голосовое')
      continue
    }
    if (file.size > 20 * 1024 * 1024) {
      toast('Файл больше 20 МБ')
      continue
    }
    state.pendingMedia.push({ file, kind: mediaKind(file), url: URL.createObjectURL(file) })
  }
  renderAttachPreview()
  updateChatSend()
}

function removePendingMedia(index) {
  const [removed] = state.pendingMedia.splice(index, 1)
  if (removed) URL.revokeObjectURL(removed.url)
  renderAttachPreview()
  updateChatSend()
}

function clearPendingMedia() {
  state.pendingMedia.forEach((item) => URL.revokeObjectURL(item.url))
  state.pendingMedia = []
  renderAttachPreview()
  updateChatSend()
}

async function uploadMediaFile(item) {
  const response = await fetch('/api/chat/upload', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'X-Mobile-Client': '1',
      'X-File-Name': encodeURIComponent(item.file.name || (item.kind === 'video' ? 'video.mp4' : 'photo.jpg')),
      'Content-Type': item.file.type || (item.kind === 'video' ? 'video/mp4' : 'image/jpeg'),
    },
    body: item.file,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (response.status === 401) throw new ApiError('Сессия истекла', 401)
    throw new Error(data.error || 'Не удалось загрузить файл')
  }
  return data
}

async function uploadPendingMedia() {
  const uploaded = []
  for (const item of state.pendingMedia) uploaded.push(await uploadMediaFile(item))
  return uploaded
}

let voiceRecording = null

function recorderTime(seconds) {
  const total = Math.max(0, Math.floor(seconds))
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0')
}

async function startVoiceRecording() {
  if (voiceRecording) return
  if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') {
    toast('Запись голоса не поддерживается этим браузером')
    return
  }
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    toast('Нет доступа к микрофону')
    return
  }
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  const mime = candidates.find((value) => MediaRecorder.isTypeSupported(value)) || ''
  const chunks = []
  const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
  const started = Date.now()
  let timer
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data)
  })
  recorder.addEventListener('stop', () => {
    stream.getTracks().forEach((track) => track.stop())
    if (timer) clearInterval(timer)
    const discarded = voiceRecording?.discard === true
    $('recorder-bar').hidden = true
    voiceRecording = null
    if (discarded || chunks.length === 0) return
    const type = recorder.mimeType || mime || 'audio/webm'
    const extension = type.includes('mp4') ? 'm4a' : 'webm'
    const file = new File([new Blob(chunks, { type })], 'voice.' + extension, { type })
    addPendingMedia([file])
  })
  recorder.start()
  voiceRecording = { recorder, stream, started }
  $('recorder-bar').hidden = false
  $('recorder-time').textContent = '0:00'
  timer = setInterval(() => {
    if (!voiceRecording) return
    $('recorder-time').textContent = recorderTime((Date.now() - voiceRecording.started) / 1000)
  }, 250)
}

function stopVoiceRecording() {
  if (!voiceRecording) return
  try { voiceRecording.recorder.stop() } catch { /* уже остановлен */ }
}

function cancelVoiceRecording() {
  if (!voiceRecording) return
  voiceRecording.discard = true
  try { voiceRecording.recorder.stop() } catch { /* уже остановлен */ }
  voiceRecording.stream.getTracks().forEach((track) => track.stop())
  voiceRecording = null
  $('recorder-bar').hidden = true
}

async function sendSiteMessage() {
  const input = $('chat-input')
  const button = $('chat-send')
  const text = input.value.trim()
  if ((text === '' && state.pendingMedia.length === 0) || button.disabled) return
  const group = state.chatTarget && state.chatTarget.type !== 'private'
  const reply = state.chatReply
  button.disabled = true
  state.chatSending = true
  showChatTyping()
  try {
    const uploaded = state.pendingMedia.length > 0 ? await uploadPendingMedia() : []
    appendChatMessage(
      'user',
      text,
      group ? ((state.session && state.session.user && state.session.user.telegramName) || 'Вы') : undefined,
      reply,
      uploaded,
      'sent',
    )
    clearChatReply()
    clearPendingMedia()
    input.value = ''
    input.style.height = 'auto'
    updateChatSend()
    const data = await api('POST', '/api/chat/message', {
      text,
      ...(uploaded.length > 0 ? { attachments: uploaded.map((item) => ({ id: item.id })) } : {}),
      ...(state.chatTarget && state.chatTarget.id !== null && state.chatTarget.id !== undefined
        ? { chatId: state.chatTarget.id }
        : {}),
      ...(reply ? { replyTo: reply } : {})
    })
    hideChatTyping()
    const messages = Array.isArray(data.messages) ? data.messages : []
    const silent = Boolean(data.silent)
    if (silent) {
      toast('Бот ответит, если упомянуть его или ответить на его сообщение')
    } else if (messages.length === 0) {
      appendChatMessage('assistant', 'Ассистент не вернул текст. Попробуйте ещё раз.')
    } else {
      messages.forEach((message) => appendChatMessage('assistant', message.text))
    }
    ;(Array.isArray(data.files) ? data.files : []).forEach(appendChatFile)
    if (state.chat && Array.isArray(state.chat.messages)) {
      const userMessage = { role: 'user', text, ...(reply ? { replyTo: reply } : {}), ...(uploaded.length > 0 ? { attachments: uploaded } : {}) }
      if (data.userMessage && data.userMessage.id) {
        userMessage.id = data.userMessage.id
        userMessage.deliveredAt = data.userMessage.status === 'read' || data.userMessage.status === 'delivered' ? new Date().toISOString() : undefined
        if (data.userMessage.status === 'read') userMessage.readAt = userMessage.deliveredAt
      }
      state.chat.messages.push(userMessage)
      if (userMessage.id) renderChat()
      if (!silent) messages.forEach((message) => state.chat.messages.push({ role: 'assistant', text: message.text }))
    }
  } catch (error) {
    hideChatTyping()
    if (error instanceof ApiError && error.status === 401) {
      showLogin('Сессия истекла — войдите заново.')
      return
    }
    appendChatMessage('assistant', '⚠️ ' + (error && error.message ? error.message : 'Не удалось получить ответ'))
  } finally {
    state.chatSending = false
    updateChatSend()
  }
}

/* ============================ Планы ============================ */

async function ensurePlans() {
  if (!state.loaded.plans && !state.loading.plans) await loadPlans()
}

async function loadPlans() {
  if (state.loading.plans) return
  state.loading.plans = true
  try {
    const [reminders, events] = await Promise.all([
      api('GET', '/api/reminders'),
      api('GET', '/api/events?days=365')
    ])
    state.reminders = Array.isArray(reminders) ? reminders : []
    state.events = Array.isArray(events) ? events : []
    state.loaded.plans = true
    renderPlans()
    renderCalendar()
  } catch (error) {
    if (error.status !== 401) {
      $('plans-reminders').replaceChildren(renderError('Не удалось загрузить планы', () => {
        state.loaded.plans = false
        void loadPlans()
      }))
    }
  } finally {
    state.loading.plans = false
  }
}

function planItemCard({ title, meta, kind, onDelete }) {
  const card = h('article', 'plan-card')
  const iconBox = h('span', 'plan-ic' + (kind === 'event' ? ' event' : ''))
  iconBox.append(icon(kind === 'event' ? 'calendar' : 'bell'))
  const body = h('div', 'plan-body')
  body.append(h('div', 'plan-title', title))
  const metaRow = h('div', 'plan-meta')
  meta.forEach((part, index) => {
    if (index > 0) metaRow.append(h('span', 'dot-sep'))
    metaRow.append(h('span', null, part))
  })
  body.append(metaRow)
  card.append(iconBox, body)
  if (onDelete) {
    const remove = h('button', 'icon-btn sm')
    remove.type = 'button'
    remove.setAttribute('aria-label', 'Удалить')
    remove.append(icon('trash'))
    remove.addEventListener('click', (event) => {
      event.stopPropagation()
      onDelete()
    })
    card.append(remove)
  }
  return card
}

function renderPlans() {
  const box = $('plans-reminders')
  box.replaceChildren()
  const groups = { today: [], tomorrow: [], later: [] }
  state.reminders.forEach((reminder) => groups[reminderGroup(reminder.dueAt)].push(reminder))

  const groupDefs = [
    ['today', 'Сегодня'],
    ['tomorrow', 'Завтра'],
    ['later', 'Позже']
  ]
  let visible = 0
  groupDefs.forEach(([key, label]) => {
    const items = groups[key]
    if (items.length === 0) return
    visible += items.length
    const head = h('div', 'group-head')
    head.append(h('span', null, label), h('span', 'group-count', String(items.length)))
    box.append(head)
    items.forEach((reminder) => {
      box.append(planItemCard({
        title: reminder.text,
        meta: [formatDateTime(reminder.dueAt), reminder.repeatText],
        kind: 'reminder',
        onDelete: () => {
          confirmSheet('Удалить напоминание?', '«' + reminder.text + '» больше не придёт.', 'Удалить', async () => {
            try {
              await api('DELETE', '/api/reminders/' + encodeURIComponent(reminder.id))
              toast('Напоминание удалено')
              state.loaded.plans = false
              await loadPlans()
            } catch (error) {
              handleError(error)
            }
          })
        }
      }))
    })
  })

  if (state.events.length > 0) {
    const head = h('div', 'group-head')
    head.append(h('span', null, 'События'), h('span', 'group-count', String(state.events.length)))
    box.append(head)
    state.events.forEach((event) => {
      box.append(planItemCard({
        title: event.title,
        meta: [formatDateTime(event.at), event.repeat === 'yearly' ? 'каждый год' : 'событие'],
        kind: 'event',
        onDelete: () => {
          confirmSheet('Удалить событие?', '«' + event.title + '» исчезнет из календаря.', 'Удалить', async () => {
            try {
              await api('DELETE', '/api/events/' + encodeURIComponent(event.id))
              toast('Событие удалено')
              state.loaded.plans = false
              await loadPlans()
            } catch (error) {
              handleError(error)
            }
          })
        }
      }))
    })
  }

  if (visible === 0 && state.events.length === 0) {
    box.append(renderEmpty('Пока нет планов', 'Добавьте первое напоминание — бот пришлёт его в срок.'))
  }

  const remindersCount = state.reminders.length
  const eventsCount = state.events.length
  $('plans-sub').textContent = remindersCount + ' ' + plural(remindersCount, ['напоминание', 'напоминания', 'напоминаний'])
    + ' · ' + eventsCount + ' ' + plural(eventsCount, ['событие', 'события', 'событий'])
}

function setPlansView(view) {
  state.plansView = view
  document.querySelectorAll('[data-plans-view]').forEach((button) => {
    const active = button.dataset.plansView === view
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-selected', active ? 'true' : 'false')
  })
  document.querySelectorAll('[data-plans-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.plansPanel !== view
  })
  $('fab-add').setAttribute('aria-label', view === 'calendar' ? 'Добавить событие' : 'Добавить напоминание')
  if (view === 'calendar') renderCalendar()
}

function openReminderSheet() {
  const wrap = h('div')
  const input = h('input', 'input')
  input.placeholder = 'Например, позвонить в клинику'
  wrap.append(field('Что напомнить', input))

  const defaultDate = new Date()
  defaultDate.setDate(defaultDate.getDate() + 1)
  defaultDate.setHours(9, 0, 0, 0)
  const when = h('input', 'input')
  when.type = 'datetime-local'
  when.value = localInputValue(defaultDate)
  wrap.append(field('Когда', when))

  const repeat = h('select', 'input')
  REPEAT_CHOICES.forEach(([value, label]) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    repeat.append(option)
  })
  wrap.append(field('Повтор', repeat))

  const submit = h('button', 'btn btn-primary btn-block', 'Добавить напоминание')
  submit.type = 'button'
  submit.addEventListener('click', async () => {
    const text = input.value.trim()
    if (!text) {
      toast('Введите текст напоминания')
      input.focus()
      return
    }
    const date = new Date(when.value)
    if (Number.isNaN(date.getTime())) {
      toast('Укажите дату и время')
      return
    }
    if (date.getTime() <= Date.now()) {
      toast('Дата должна быть в будущем')
      return
    }
    submit.disabled = true
    try {
      await api('POST', '/api/reminders', {
        text,
        dueAt: date.toISOString(),
        repeat: repeat.value
      })
      closeSheet()
      toast('Напоминание добавлено')
      state.loaded.plans = false
      await loadPlans()
    } catch (error) {
      handleError(error)
      submit.disabled = false
    }
  })
  wrap.append(submit)
  openSheet({ title: 'Новое напоминание', body: wrap })
}

function openEventSheet() {
  const wrap = h('div')
  const input = h('input', 'input')
  input.placeholder = 'Например, день рождения Маши'
  wrap.append(field('Название события', input))

  const defaultDate = new Date()
  defaultDate.setDate(defaultDate.getDate() + 1)
  defaultDate.setHours(12, 0, 0, 0)
  const when = h('input', 'input')
  when.type = 'datetime-local'
  when.value = localInputValue(defaultDate)
  wrap.append(field('Дата и время', when))

  const yearlyRow = h('label', 'switch-row')
  const yearlyText = h('div')
  yearlyText.append(h('b', null, 'Каждый год'), h('span', null, 'повторять ежегодно'))
  const yearly = h('button', 'switch')
  yearly.type = 'button'
  yearly.setAttribute('aria-label', 'Каждый год')
  let yearlyOn = false
  yearly.addEventListener('click', () => {
    yearlyOn = !yearlyOn
    yearly.classList.toggle('is-on', yearlyOn)
  })
  yearlyRow.append(yearlyText, yearly)
  wrap.append(yearlyRow)

  const submit = h('button', 'btn btn-primary btn-block', 'Добавить событие')
  submit.type = 'button'
  submit.addEventListener('click', async () => {
    const title = input.value.trim()
    if (!title) {
      toast('Введите название события')
      input.focus()
      return
    }
    const date = new Date(when.value)
    if (Number.isNaN(date.getTime())) {
      toast('Укажите дату и время')
      return
    }
    if (date.getTime() <= Date.now()) {
      toast('Дата должна быть в будущем')
      return
    }
    submit.disabled = true
    try {
      await api('POST', '/api/events', {
        title,
        at: date.toISOString(),
        repeat: yearlyOn ? 'yearly' : 'none'
      })
      closeSheet()
      toast('Событие добавлено в календарь')
      state.loaded.plans = false
      await loadPlans()
    } catch (error) {
      handleError(error)
      submit.disabled = false
    }
  })
  wrap.append(submit)
  openSheet({ title: 'Новое событие', body: wrap })
}

function addItemToCalendar(map, dateKeyValue, item) {
  if (!map.has(dateKeyValue)) map.set(dateKeyValue, [])
  map.get(dateKeyValue).push(item)
}

function renderCalendar() {
  const grid = $('cal-grid')
  if (!grid) return
  grid.replaceChildren()
  const { year, month, selected } = state.calendar
  const first = new Date(year, month, 1)
  const startOffset = (first.getDay() + 6) % 7
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const prevDays = new Date(year, month, 0).getDate()

  const itemsByDay = new Map()
  state.reminders.forEach((reminder) => {
    const date = new Date(reminder.dueAt)
    if (Number.isNaN(date.getTime())) return
    addItemToCalendar(itemsByDay, dayKey(date), { kind: 'reminder', title: reminder.text, time: formatTime(reminder.dueAt) })
  })
  state.events.forEach((event) => {
    const date = new Date(event.at)
    if (Number.isNaN(date.getTime())) return
    addItemToCalendar(itemsByDay, dayKey(date), { kind: 'event', title: event.title, time: formatTime(event.at) })
  })

  if (state.calendar.view === 'week') {
    renderWeekCalendar(itemsByDay)
    return
  }
  $('cal-grid').hidden = false
  document.querySelector('.weekdays')?.removeAttribute('hidden')
  $('cal-week').hidden = true

  for (let index = 0; index < 42; index += 1) {
    const dayNumber = index - startOffset + 1
    let cellYear = year
    let cellMonth = month
    let day = dayNumber
    let out = false
    if (dayNumber < 1) {
      out = true
      cellMonth -= 1
      if (cellMonth < 0) {
        cellMonth = 11
        cellYear -= 1
      }
      day = prevDays + dayNumber
    } else if (dayNumber > daysInMonth) {
      out = true
      cellMonth += 1
      if (cellMonth > 11) {
        cellMonth = 0
        cellYear += 1
      }
      day = dayNumber - daysInMonth
    }

    const cell = h('button', 'cal-day' + (out ? ' out' : ''))
    cell.type = 'button'
    cell.textContent = String(day)
    cell.setAttribute('aria-label', day + ' ' + MONTHS_GEN[cellMonth])
    const key = dayKey(new Date(cellYear, cellMonth, day))
    const items = itemsByDay.get(key) || []
    if (items.length > 0) {
      const dots = h('span', 'cal-dots')
      const kinds = new Set(items.map((item) => item.kind))
      kinds.forEach((kind) => dots.append(h('i', kind === 'event' ? 'event' : '')))
      cell.append(dots)
    }
    const today = new Date()
    if (!out && cellYear === today.getFullYear() && cellMonth === today.getMonth() && day === today.getDate()) {
      cell.classList.add('today')
    }
    if (!out && cellYear === year && cellMonth === month && day === selected) {
      cell.classList.add('is-selected')
    }
    cell.addEventListener('click', () => {
      state.calendar.year = cellYear
      state.calendar.month = cellMonth
      state.calendar.selected = day
      renderCalendar()
    })
    grid.append(cell)
  }

  $('cal-month').textContent = MONTHS[month] + ' ' + year
  const selectedDate = new Date(year, month, selected)
  $('cal-selected-label').textContent = selected + ' ' + MONTHS_GEN[month] + ', ' + WEEKDAYS_FULL[selectedDate.getDay()]
  renderCalendarDay(itemsByDay, selectedDate)
}

function renderCalendarDay(itemsByDay, selectedDate) {
  $('cal-day-title').textContent = selectedDate.getDate() + ' ' + MONTHS_GEN[selectedDate.getMonth()]
  const selectedItems = itemsByDay.get(dayKey(selectedDate)) || []
  $('cal-day-count').textContent = String(selectedItems.length)
  const dayList = $('cal-day-list')
  dayList.replaceChildren()
  if (selectedItems.length === 0) {
    dayList.append(h('p', 'empty-day', 'На этот день ничего нет.'))
    return
  }
  selectedItems.forEach((item) => {
    dayList.append(planItemCard({
      title: item.title,
      meta: [item.time || 'весь день'],
      kind: item.kind
    }))
  })
}

function renderWeekCalendar(itemsByDay) {
  $('cal-grid').hidden = true
  document.querySelector('.weekdays')?.setAttribute('hidden', '')
  const week = $('cal-week')
  week.hidden = false
  week.replaceChildren()
  const base = new Date(state.calendar.year, state.calendar.month, state.calendar.selected)
  const monday = new Date(base)
  monday.setDate(base.getDate() - ((base.getDay() + 6) % 7))
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  $('cal-month').textContent = 'Неделя ' + monday.getDate() + ' — ' + sunday.getDate() + ' ' + MONTHS_GEN[sunday.getMonth()]
  $('cal-selected-label').textContent = 'неделя начинается с понедельника'
  for (let index = 0; index < 7; index += 1) {
    const date = new Date(monday)
    date.setDate(monday.getDate() + index)
    const key = dayKey(date)
    const items = itemsByDay.get(key) || []
    const card = h('button', 'cal-week-day' + (date.toDateString() === base.toDateString() ? ' is-selected' : ''))
    card.type = 'button'
    const head = h('div', 'cal-week-head')
    head.append(h('b', null, WEEKDAYS_FULL[date.getDay()]), h('span', null, date.getDate() + ' ' + MONTHS_GEN[date.getMonth()]))
    card.append(head)
    if (items.length === 0) {
      const row = h('div', 'cal-week-item')
      row.append(h('span', null, '—'), h('span', null, 'ничего нет'))
      card.append(row)
    } else {
      items.forEach((item) => {
        const row = h('div', 'cal-week-item')
        row.append(h('span', null, item.time || 'день'), h('span', null, item.title))
        card.append(row)
      })
    }
    card.addEventListener('click', () => {
      state.calendar.year = date.getFullYear()
      state.calendar.month = date.getMonth()
      state.calendar.selected = date.getDate()
      renderCalendar()
    })
    week.append(card)
  }
  renderCalendarDay(itemsByDay, base)
}

/* ============================ Память ============================ */

async function ensureMemory() {
  if (!state.loaded.memory && !state.loading.memory) await loadMemory()
}

async function loadMemory() {
  if (state.loading.memory) return
  state.loading.memory = true
  try {
    const data = await api('GET', '/api/memory')
    state.memory = {
      facts: data && Array.isArray(data.facts) ? data.facts : [],
      city: data ? data.city : null
    }
    state.loaded.memory = true
    renderMemory()
  } catch (error) {
    if (error.status !== 401) {
      $('facts-list').replaceChildren(renderError('Не удалось загрузить память', () => {
        state.loaded.memory = false
        void loadMemory()
      }))
    }
  } finally {
    state.loading.memory = false
  }
}

function renderMemory() {
  const box = $('facts-list')
  box.replaceChildren()
  const query = state.factQuery.trim().toLowerCase()
  const facts = state.memory.facts.filter((fact) => !query || String(fact.text).toLowerCase().includes(query))
  if (!query) {
    const groups = new Map()
    state.memory.facts.forEach((fact) => {
      const key = String(fact.text || '').trim().toLowerCase()
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(fact)
    })
    const duplicateGroups = [...groups.values()].filter((group) => group.length > 1)
    if (duplicateGroups.length > 0) {
      const card = h('div', 'card duplicate-card')
      card.append(h('b', null, 'Найдены дубликаты: ' + duplicateGroups.reduce((sum, group) => sum + group.length - 1, 0)))
      card.append(h('p', 'hint', 'Оставить по одному факту из каждой группы?'))
      const merge = h('button', 'btn btn-ghost btn-sm', 'Объединить')
      merge.type = 'button'
      merge.addEventListener('click', () => {
        confirmSheet('Объединить дубликаты?', 'Лишние копии будут удалены.', 'Объединить', () => void mergeDuplicateFacts(duplicateGroups))
      })
      card.append(merge)
      box.append(card)
    }
  }
  if (facts.length === 0) {
    box.append(renderEmpty(query ? 'Ничего не нашлось' : 'Пока пусто', query ? 'Попробуйте другой запрос.' : 'Добавьте первый факт — бот учтёт его в личных ответах.'))
  }
  facts.forEach((fact) => {
    const card = h('article', 'fact-card')
    const body = h('div', 'fact-body')
    body.append(h('div', 'fact-text', fact.text))
    const meta = h('div', 'fact-meta')
    meta.append(icon('book'), h('span', null, fact.confirmationStatus === 'assumption' ? 'предположение' : 'личный факт'))
    if (fact.confirmationStatus === 'assumption') {
      const confirm = h('button', 'pill-btn', 'Подтвердить')
      confirm.type = 'button'
      confirm.addEventListener('click', () => void confirmFact(fact))
      meta.append(confirm)
    }
    body.append(meta)
    const edit = h('button', 'icon-btn sm')
    edit.type = 'button'
    edit.setAttribute('aria-label', 'Изменить факт')
    edit.append(icon('pencil'))
    edit.addEventListener('click', () => openEditFact(fact))
    const remove = h('button', 'icon-btn sm')
    remove.type = 'button'
    remove.setAttribute('aria-label', 'Удалить факт')
    remove.append(icon('trash'))
    remove.addEventListener('click', () => {
      confirmSheet('Удалить факт?', '«' + fact.text + '» больше не будет использоваться.', 'Удалить', async () => {
        try {
          await api('DELETE', '/api/memory/' + encodeURIComponent(fact.id))
          toast('Факт удалён')
          state.loaded.memory = false
          await loadMemory()
        } catch (error) {
          handleError(error)
        }
      })
    })
    card.append(body, edit, remove)
    box.append(card)
  })
  $('facts-count').textContent = String(state.memory.facts.length)
  $('memory-city').textContent = state.memory.city || 'Город не задан'
  const count = state.memory.facts.length
  $('memory-sub').textContent = count + ' ' + plural(count, ['факт', 'факта', 'фактов'])
    + (state.memory.city ? ' · ' + state.memory.city : '')
}

async function confirmFact(fact) {
  try {
    await api('PATCH', '/api/memory/' + encodeURIComponent(fact.id), { confirmationStatus: 'confirmed' })
    state.loaded.memory = false
    await loadMemory()
    toast('Факт подтверждён')
  } catch (error) {
    toast(error.message || 'Не удалось подтвердить факт')
  }
}

async function mergeDuplicateFacts(groups) {
  try {
    let removed = 0
    for (const group of groups) {
      for (const fact of group.slice(1)) {
        await api('DELETE', '/api/memory/' + encodeURIComponent(fact.id))
        removed += 1
      }
    }
    state.loaded.memory = false
    await loadMemory()
    toast('Удалено дублей: ' + removed)
  } catch (error) {
    toast(error.message || 'Не удалось объединить дубликаты')
  }
}

function openEditFact(fact) {
  const wrap = h('div')
  const input = document.createElement('textarea')
  input.className = 'input'
  input.rows = 3
  input.value = fact.text
  const save = h('button', 'btn btn-primary btn-block', 'Сохранить')
  save.type = 'button'
  save.addEventListener('click', async () => {
    if (input.value.trim() === '') return
    save.disabled = true
    try {
      await api('PATCH', '/api/memory/' + encodeURIComponent(fact.id), { text: input.value.trim() })
      closeSheet()
      state.loaded.memory = false
      await loadMemory()
      toast('Факт изменён')
    } catch (error) {
      save.disabled = false
      toast(error.message || 'Не удалось изменить факт')
    }
  })
  wrap.append(field('Факт', input), save)
  openSheet({ title: 'Изменить факт', body: wrap })
}

async function addFact() {
  const input = $('fact-input')
  const text = input.value.trim()
  if (!text) {
    input.focus()
    return
  }
  try {
    await api('POST', '/api/memory', { text })
    input.value = ''
    toast('Запомнил')
    state.loaded.memory = false
    state.factQuery = ''
    await loadMemory()
    $('memory-scroll').scrollTop = 0
  } catch (error) {
    handleError(error)
  }
}

function openCitySheet() {
  const wrap = h('div')
  const input = h('input', 'input')
  input.placeholder = 'Например, Москва'
  input.value = state.memory.city || ''
  wrap.append(field('Город', input))
  const submit = h('button', 'btn btn-primary btn-block', 'Сохранить город')
  submit.type = 'button'
  submit.addEventListener('click', async () => {
    const city = input.value.trim()
    if (!city) {
      toast('Введите город')
      input.focus()
      return
    }
    submit.disabled = true
    try {
      await api('PATCH', '/api/settings', { city })
      closeSheet()
      toast('Город сохранён')
      state.loaded.memory = false
      state.settings = null
      state.loaded.settings = false
      await loadMemory()
      await loadSettings()
      refreshProfile()
    } catch (error) {
      handleError(error)
      submit.disabled = false
    }
  })
  wrap.append(submit)
  openSheet({ title: 'Город', body: wrap })
}

/* ============================ Настройки ============================ */

async function ensureSettings() {
  if (!state.loaded.settings && !state.loading.settings) await loadSettings()
}

async function loadSettings() {
  if (state.loading.settings) return
  state.loading.settings = true
  try {
    const settings = await api('GET', '/api/settings')
    state.settings = settings
    state.loaded.settings = true
    renderSettings()
    void loadProactive()
    refreshProfile()
  } catch (error) {
    if (error.status !== 401) {
      toast(error.message || 'Не удалось загрузить настройки')
    }
  } finally {
    state.loading.settings = false
  }
}

function renderSettings() {
  const settings = state.settings
  if (!settings) return
  $('set-persona').textContent = settings.persona ? capitalize(settings.persona) : 'Обычный'
  $('set-mood').textContent = settings.mood ? capitalize(settings.mood) : 'Авто'
  $('set-mode').textContent = settings.mode ? capitalize(settings.mode) : 'Обычный'
  $('set-model').textContent = settings.model || (settings.defaults && settings.defaults.model) || '—'
  $('set-city').textContent = settings.city || 'Не задан'
  $('set-voice').classList.toggle('is-on', settings.voice === true)
}

function minutesToClock(minutes) {
  const value = Number(minutes)
  if (!Number.isFinite(value)) return '—'
  return String(Math.floor(value / 60) % 24).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0')
}

function clockToMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''))
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined
}

function renderProactive() {
  const settings = state.proactive
  const toggle = $('proactive-toggle')
  if (!toggle) return
  if (!settings) {
    toggle.classList.remove('is-on')
    $('proactive-review').textContent = '—'
    $('proactive-quiet').textContent = '—'
    $('proactive-limit').textContent = '—'
    $('proactive-hint').textContent = 'Настройки проактивности недоступны.'
    return
  }
  toggle.classList.toggle('is-on', settings.enabled === true)
  $('proactive-review').textContent = settings.reviewAt || '—'
  $('proactive-quiet').textContent = settings.quiet
    ? minutesToClock(settings.quiet.start) + '–' + minutesToClock(settings.quiet.end)
    : '—'
  $('proactive-limit').textContent = String(settings.dayLimit ?? '—')
  $('proactive-hint').textContent = settings.globalEnabled === false
    ? 'Глобально проактивность выключена на сервере — личный переключатель пока ничего не отправит.'
    : 'Обзор дня и важные события. В тихие часы сообщения не приходят.'
}

async function loadProactive() {
  try {
    state.proactive = await api('GET', '/api/proactive')
  } catch {
    state.proactive = null
  }
  renderProactive()
}

async function patchProactive(patch, message) {
  try {
    state.proactive = await api('PATCH', '/api/proactive', patch)
    renderProactive()
    if (message) toast(message)
  } catch (error) {
    handleError(error)
  }
}

function openProactivePicker(kind) {
  const settings = state.proactive
  if (!settings) return
  const wrap = h('div')
  const save = h('button', 'btn btn-primary btn-block', 'Сохранить')
  save.type = 'button'
  if (kind === 'review') {
    const input = h('input', 'input')
    input.type = 'time'
    input.value = settings.reviewAt || '09:00'
    wrap.append(field('Время обзора', input))
    save.addEventListener('click', () => { closeSheet(); void patchProactive({ reviewAt: input.value }, 'Время обзора сохранено') })
  } else if (kind === 'quiet') {
    const start = h('input', 'input')
    start.type = 'time'
    start.value = settings.quiet ? minutesToClock(settings.quiet.start) : '23:00'
    const end = h('input', 'input')
    end.type = 'time'
    end.value = settings.quiet ? minutesToClock(settings.quiet.end) : '08:00'
    wrap.append(field('Начало', start), field('Конец', end))
    save.addEventListener('click', () => {
      if (clockToMinutes(start.value) === undefined || clockToMinutes(end.value) === undefined) {
        toast('Укажите время в формате ЧЧ:ММ')
        return
      }
      closeSheet()
      void patchProactive({ quietStart: start.value, quietEnd: end.value }, 'Тихие часы сохранены')
    })
  } else {
    const select = h('select', 'input')
    for (let limit = 1; limit <= 10; limit += 1) {
      const option = document.createElement('option')
      option.value = String(limit)
      option.textContent = String(limit)
      if (Number(settings.dayLimit) === limit) option.selected = true
      select.append(option)
    }
    wrap.append(field('Сообщений в день', select))
    save.addEventListener('click', () => { closeSheet(); void patchProactive({ dayLimit: Number(select.value) }, 'Лимит сохранён') })
  }
  wrap.append(save)
  openSheet({ title: kind === 'review' ? 'Время обзора' : kind === 'quiet' ? 'Тихие часы' : 'Лимит в день', body: wrap })
}

function formatFileSize(size) {
  const value = Number(size) || 0
  if (value < 1024) return value + ' Б'
  if (value < 1024 * 1024) return Math.round(value / 1024) + ' КБ'
  return (value / (1024 * 1024)).toFixed(1) + ' МБ'
}

let mailSearchTimer

async function ensureMail() {
  if (state.gmail === null) await loadGmail()
}

async function loadGmail() {
  try {
    state.gmail = await api('GET', '/api/gmail/status')
    if (state.gmail.connected) await loadMailMessages()
    else renderMail()
  } catch (error) {
    $('mail-list').replaceChildren(h('p', 'hint', error.message || 'Почта недоступна'))
  }
}

async function loadMailMessages(query = '') {
  $('mail-list').replaceChildren(h('p', 'hint', 'Загружаю письма…'))
  try {
    const data = await api('GET', '/api/gmail/messages' + (query ? '?q=' + encodeURIComponent(query) : ''))
    state.mailMessages = Array.isArray(data.messages) ? data.messages : []
    renderMail()
  } catch (error) {
    if (error.code === 'gmail_reauth') {
      state.gmail = { ...(state.gmail || {}), connected: false }
      renderMail()
      toast('Подключите Gmail заново')
      return
    }
    $('mail-list').replaceChildren(h('p', 'hint', error.message || 'Не удалось загрузить письма'))
  }
}

function renderMail() {
  const gmail = state.gmail || {}
  $('mail-search-row').hidden = !gmail.connected
  if (!gmail.configured) {
    $('mail-sub').textContent = 'не настроена'
    const wrap = h('div', 'card info-card')
    wrap.append(h('b', null, 'Gmail ещё не настроен'))
    wrap.append(h('p', null, 'В Google Cloud создайте OAuth-клиент, включите Gmail API и добавьте redirect URI:'))
    wrap.append(h('code', 'totp-secret', 'https://tenkrol.ru/api/gmail/callback'))
    wrap.append(h('p', null, 'Затем добавьте GMAIL_CLIENT_ID и GMAIL_CLIENT_SECRET в .env на сервере.'))
    $('mail-list').replaceChildren(wrap)
    return
  }
  if (!gmail.connected) {
    $('mail-sub').textContent = 'не подключена'
    const wrap = h('div', 'card info-card')
    wrap.append(h('b', null, 'Подключите Gmail'))
    wrap.append(h('p', null, 'Доступ только на чтение писем. Пароль Google сайту не передаётся.'))
    const button = h('button', 'btn btn-primary', 'Подключить Gmail')
    button.type = 'button'
    button.addEventListener('click', async () => {
      try {
        const data = await api('GET', '/api/gmail/auth')
        window.location.href = data.url
      } catch (error) {
        toast(error.message || 'Gmail OAuth не настроен')
      }
    })
    wrap.append(button)
    $('mail-list').replaceChildren(wrap)
    return
  }
  $('mail-sub').textContent = gmail.email || 'подключена'
  const messages = state.mailMessages || []
  const box = $('mail-list')
  box.replaceChildren()
  if (messages.length === 0) {
    box.append(h('p', 'hint', 'Писем нет.'))
    return
  }
  messages.forEach((message) => {
    const card = h('button', 'plan-card')
    card.type = 'button'
    const ic = h('span', 'plan-ic')
    ic.append(icon('mail'))
    const body = h('div', 'plan-body')
    body.append(h('b', null, message.subject), h('span', 'plan-meta', (message.from || '') + (message.unread ? ' · новое' : '')))
    body.append(h('span', 'plan-meta', message.snippet || ''))
    card.append(ic, body)
    card.addEventListener('click', () => void openMailMessage(message))
    box.append(card)
  })
}

async function openMailMessage(message) {
  const wrap = h('div')
  wrap.append(h('p', 'hint', 'Загружаю письмо…'))
  openSheet({ title: message.subject || 'Письмо', body: wrap })
  try {
    const data = await api('GET', '/api/gmail/messages/' + encodeURIComponent(message.id))
    const mail = data.message
    wrap.replaceChildren()
    wrap.append(h('p', 'plan-meta', mail.from + '\n' + mail.date))
    const pre = h('pre', 'mail-text', mail.text || '(текст не найден)')
    wrap.append(pre)
  } catch (error) {
    wrap.replaceChildren(h('p', 'hint', error.message || 'Не удалось открыть письмо'))
  }
}

const AUTOMATION_TEMPLATES = [
  {
    title: 'Утренний дайджест',
    prompt: 'Собери короткий утренний дайджест: погода в Москве, мои напоминания на сегодня и 2–3 важные новости. Пиши кратко.',
    time: '08:00',
  },
  {
    title: 'Проверка сервера',
    prompt: 'Проверь состояние сервера: диск, память, сервисы и свежие ошибки. Если всё в порядке — одна строка, если нет — подробности.',
    time: '09:00',
  },
  {
    title: 'Итоги дня',
    prompt: 'Собери итоги дня: что было в планах, что выполнено, что перенести на завтра. Коротко, списком.',
    time: '21:00',
  },
]

const WEEKDAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

function formatAutomationSchedule(item) {
  const days = Array.isArray(item.weekdays) && item.weekdays.length > 0
    ? item.weekdays.map((day) => WEEKDAY_LABELS[day - 1]).join(', ')
    : 'каждый день'
  return days + ' в ' + item.time
}

async function ensureAutomations() {
  if (state.automations !== null) return
  await loadAutomations()
}

async function loadAutomations() {
  try {
    const data = await api('GET', '/api/automations')
    state.automations = Array.isArray(data.items) ? data.items : []
    renderAutomations()
  } catch (error) {
    $('automations-list').replaceChildren(h('p', 'hint', error.message || 'Не удалось загрузить автоматизации'))
  }
}

function renderAutomationTemplates() {
  const box = $('automation-templates')
  if (!box) return
  box.replaceChildren()
  AUTOMATION_TEMPLATES.forEach((template) => {
    const card = h('button', 'plan-card')
    card.type = 'button'
    const ic = h('span', 'plan-ic')
    ic.append(icon('bolt'))
    const body = h('div', 'plan-body')
    body.append(h('b', null, template.title), h('span', 'plan-meta', template.time + ' · нажмите, чтобы настроить'))
    card.append(ic, body)
    card.addEventListener('click', () => openAutomationSheet(template))
    box.append(card)
  })
}

function renderAutomations() {
  renderAutomationTemplates()
  const box = $('automations-list')
  const items = state.automations || []
  $('automations-count').textContent = String(items.length)
  box.replaceChildren()
  if (items.length === 0) {
    box.append(h('p', 'hint', 'Пока нет автоматизаций. Выберите шаблон выше или нажмите +.'))
    return
  }
  items.forEach((item) => {
    const card = h('div', 'plan-card')
    const ic = h('span', 'plan-ic')
    ic.append(icon('bolt'))
    const body = h('div', 'plan-body')
    body.append(h('b', null, item.title), h('span', 'plan-meta', formatAutomationSchedule(item)))
    const meta = [item.nextRunAt ? 'следующий: ' + formatDateTime(item.nextRunAt) : '', item.lastStatus === 'failed' ? 'последний запуск: ошибка' : item.lastRunAt ? 'последний: ' + formatDateTime(item.lastRunAt) : ''].filter(Boolean).join(' · ')
    if (meta) body.append(h('span', 'plan-meta', meta))
    const actions = h('div', 'file-actions')
    const toggle = h('button', 'pill-btn', item.enabled ? 'Выключить' : 'Включить')
    toggle.type = 'button'
    toggle.addEventListener('click', () => void toggleAutomation(item))
    const edit = h('button', 'pill-btn', 'Изменить')
    edit.type = 'button'
    edit.addEventListener('click', () => openAutomationSheet({}, item))
    const run = h('button', 'pill-btn', 'Проверить')
    run.type = 'button'
    run.addEventListener('click', () => void runAutomation(item))
    const remove = h('button', 'pill-btn danger', 'Удалить')
    remove.type = 'button'
    remove.addEventListener('click', () => { confirmSheet('Удалить автоматизацию?', item.title, 'Удалить', () => void deleteAutomation(item)) })
    actions.append(toggle, edit, run, remove)
    body.append(actions)
    card.append(ic, body)
    box.append(card)
  })
}

function openAutomationSheet(template = {}, editItem = null) {
  const wrap = h('div')
  const title = document.createElement('input')
  title.className = 'input'
  title.placeholder = 'Название'
  title.value = editItem ? editItem.title : template.title || ''
  const prompt = document.createElement('textarea')
  prompt.className = 'input'
  prompt.rows = 5
  prompt.placeholder = 'Что должен сделать ассистент'
  prompt.value = editItem ? editItem.prompt : template.prompt || ''
  const time = document.createElement('input')
  time.className = 'input'
  time.type = 'time'
  time.value = editItem ? editItem.time : template.time || '09:00'
  const daysBox = h('div', 'automation-days')
  const dayInputs = []
  WEEKDAY_LABELS.forEach((label, index) => {
    const day = h('label', 'automation-day')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.value = String(index + 1)
    if (editItem && Array.isArray(editItem.weekdays) && editItem.weekdays.includes(index + 1)) input.checked = true
    day.append(input, h('span', null, label))
    daysBox.append(day)
    dayInputs.push(input)
  })
  const save = h('button', 'btn btn-primary btn-block', 'Сохранить')
  save.type = 'button'
  save.addEventListener('click', async () => {
    if (title.value.trim() === '' || prompt.value.trim() === '') {
      toast('Заполните название и промпт')
      return
    }
    save.disabled = true
    try {
      const payload = {
        title: title.value.trim(),
        prompt: prompt.value.trim(),
        time: time.value,
        weekdays: dayInputs.filter((input) => input.checked).map((input) => Number(input.value)),
      }
      if (editItem) await api('PATCH', '/api/automations/' + encodeURIComponent(editItem.id), payload)
      else await api('POST', '/api/automations', payload)
      closeSheet()
      state.automations = null
      await loadAutomations()
      toast(editItem ? 'Автоматизация изменена' : 'Автоматизация создана')
    } catch (error) {
      save.disabled = false
      toast(error.message || 'Не удалось создать автоматизацию')
    }
  })
  wrap.append(field('Название', title), field('Промпт', prompt), field('Время (МСК)', time), h('p', 'hint', 'Дни недели: если не выбрано — каждый день'), daysBox, save)
  openSheet({ title: editItem ? 'Изменить автоматизацию' : 'Новая автоматизация', body: wrap })
}

async function toggleAutomation(item) {
  try {
    await api('PATCH', '/api/automations/' + encodeURIComponent(item.id), { enabled: !item.enabled })
    state.automations = null
    await loadAutomations()
  } catch (error) {
    toast(error.message || 'Не удалось изменить автоматизацию')
  }
}

async function runAutomation(item) {
  try {
    await api('POST', '/api/automations/' + encodeURIComponent(item.id) + '/run')
    state.automations = null
    await loadAutomations()
    toast('Запущено — ответ придёт в чат')
  } catch (error) {
    toast(error.message || 'Не удалось запустить')
  }
}

async function deleteAutomation(item) {
  try {
    await api('DELETE', '/api/automations/' + encodeURIComponent(item.id))
    state.automations = null
    await loadAutomations()
    toast('Автоматизация удалена')
  } catch (error) {
    toast(error.message || 'Не удалось удалить')
  }
}

async function ensureInbox() {
  if (!state.loaded.inbox && !state.loading.inbox) await loadInbox()
}

async function loadInbox() {
  if (state.loading.inbox) return
  state.loading.inbox = true
  try {
    const data = await api('GET', '/api/inbox')
    state.inbox = Array.isArray(data.items) ? data.items : []
    state.loaded.inbox = true
    renderInbox()
  } catch (error) {
    $('inbox-list').replaceChildren(h('p', 'hint', error.message || 'Не удалось загрузить инбокс'))
  } finally {
    state.loading.inbox = false
  }
}

function renderInbox() {
  const box = $('inbox-list')
  box.replaceChildren()
  const items = state.inbox || []
  if (items.length === 0) {
    box.append(h('p', 'hint', 'Пока пусто. Запишите мысль или задачу — она сохранится.'))
    return
  }
  items.forEach((item) => {
    const card = h('div', 'plan-card' + (item.done ? ' is-done' : ''))
    const check = h('button', 'inbox-check' + (item.done ? ' is-done' : ''), item.done ? '✓' : '')
    check.type = 'button'
    check.setAttribute('aria-label', item.done ? 'Вернуть в работу' : 'Отметить выполненным')
    check.addEventListener('click', () => void toggleInbox(item))
    const body = h('div', 'plan-body')
    const text = h('b', null, item.text)
    body.append(text, h('span', 'plan-meta', formatDateTime(item.createdAt)))
    const remove = h('button', 'inbox-remove', '×')
    remove.type = 'button'
    remove.setAttribute('aria-label', 'Удалить заметку')
    remove.addEventListener('click', () => void removeInbox(item))
    card.append(check, body, remove)
    box.append(card)
  })
}

async function addInbox() {
  const input = $('inbox-input')
  const text = input.value.trim()
  if (text === '') return
  input.disabled = true
  try {
    await api('POST', '/api/inbox', { text })
    input.value = ''
    state.loaded.inbox = false
    await loadInbox()
  } catch (error) {
    toast(error.message || 'Не удалось добавить заметку')
  } finally {
    input.disabled = false
    input.focus()
  }
}

async function toggleInbox(item) {
  try {
    await api('PATCH', '/api/inbox', { itemId: item.id, done: !item.done })
    state.loaded.inbox = false
    await loadInbox()
  } catch (error) {
    toast(error.message || 'Не удалось обновить заметку')
  }
}

async function removeInbox(item) {
  try {
    await api('DELETE', '/api/inbox?id=' + encodeURIComponent(item.id))
    state.loaded.inbox = false
    await loadInbox()
  } catch (error) {
    toast(error.message || 'Не удалось удалить заметку')
  }
}

async function ensureSystem() {
  if (state.loaded.system) return
  try {
    state.system = await api('GET', '/api/system')
    state.loaded.system = true
    renderSystem()
  } catch (error) {
    if (error.status !== 401) {
      $('system-server').textContent = 'Не удалось получить состояние: ' + (error.message || 'ошибка')
      $('system-backups').replaceChildren(h('p', 'hint', 'Список бэкапов недоступен.'))
    }
  }
}

function renderSystem() {
  const data = state.system
  if (!data) return
  $('system-server').textContent = data.server || 'Нет данных.'
  const box = $('system-backups')
  box.replaceChildren()
  const backups = Array.isArray(data.backups) ? data.backups : []
  if (backups.length === 0) {
    box.append(h('p', 'hint', 'Файлов бэкапов пока нет.'))
  } else {
    backups.forEach((backup) => {
      const row = h('div', 'plan-card')
      const ic = h('span', 'plan-ic')
      ic.append(icon('download'))
      const body = h('div', 'plan-body')
      body.append(h('b', null, backup.name))
      body.append(h('span', 'plan-meta', [formatFileSize(backup.size), formatDateTime(backup.at)].filter(Boolean).join(' · ')))
      row.append(ic, body)
      box.append(row)
    })
  }
  $('system-generated').textContent = data.generatedAt ? 'Обновлено: ' + formatDateTime(data.generatedAt) : ''
}

async function ensureFiles() {
  if (state.filesTab === 'agent') {
    await loadAgentFiles()
    return
  }
  if (!state.loaded.files && !state.loading.files) await loadFiles()
}

async function loadFiles() {
  state.loading.files = true
  try {
    const data = await api('GET', '/api/files')
    state.files = Array.isArray(data.files) ? data.files : []
    state.loaded.files = true
    renderFiles()
  } catch (error) {
    if (error.status !== 401) {
      $('files-list').replaceChildren(renderError('Не удалось загрузить файлы', () => {
        state.loaded.files = false
        void loadFiles()
      }))
    }
  } finally {
    state.loading.files = false
  }
}

let filesSearchTimer

async function searchFiles(query) {
  const box = $('files-list')
  if (!box) return
  const text = String(query || '').trim()
  if (text.length < 2) {
    renderFiles()
    return
  }
  box.replaceChildren(h('p', 'hint', 'Ищу по документам…'))
  try {
    const data = await api('GET', '/api/files/search?q=' + encodeURIComponent(text))
    const results = Array.isArray(data.results) ? data.results : []
    box.replaceChildren()
    if (results.length === 0) {
      box.append(h('p', 'hint', 'Ничего не найдено. Попробуйте другие слова.'))
      return
    }
    results.forEach((result) => {
      const card = h('div', 'plan-card')
      const ic = h('span', 'plan-ic')
      ic.append(icon('file'))
      const body = h('div', 'plan-body')
      body.append(h('b', null, result.name))
      if (result.snippet) body.append(h('span', 'plan-meta', result.snippet))
      const meta = [result.page ? 'стр. ' + result.page : '', result.version ? 'версия ' + result.version : ''].filter(Boolean).join(' · ')
      if (meta) body.append(h('span', 'plan-meta', meta))
      const link = document.createElement('a')
      link.className = 'pill-btn'
      link.href = '/api/files/' + encodeURIComponent(result.documentId) + '/download'
      link.textContent = 'Скачать'
      body.append(link)
      card.append(ic, body)
      box.append(card)
    })
  } catch (error) {
    box.replaceChildren(h('p', 'hint', error.message || 'Поиск не удался'))
  }
}

async function loadAgentFiles() {
  if (state.loading.agentFiles) return
  state.loading.agentFiles = true
  try {
    const disk = await api('GET', '/api/disk').catch(() => null)
    if (disk && disk.configured) {
      state.diskMode = true
      state.agentFiles = (Array.isArray(disk.files) ? disk.files : []).map((file) => ({
        id: file.path,
        name: file.name,
        size: file.size,
        at: file.modified,
        task: file.task,
        path: file.path,
      }))
      renderAgentFiles()
      return
    }
    state.diskMode = false
    const data = await api('GET', '/api/files/agent')
    state.agentFiles = Array.isArray(data.files) ? data.files : []
    renderAgentFiles()
  } catch (error) {
    $('files-list').replaceChildren(h('p', 'hint', error.message || 'Не удалось загрузить файлы агента'))
  } finally {
    state.loading.agentFiles = false
  }
}

function renderAgentFiles() {
  const box = $('files-list')
  box.replaceChildren()
  const files = state.agentFiles || []
  if (files.length === 0) {
    box.append(h('p', 'hint', 'Пока пусто. Файлы, которые агент пришлёт в чат, появятся здесь.'))
    return
  }
  let currentTask = null
  files.forEach((file) => {
    if (state.diskMode && file.task && file.task !== currentTask) {
      currentTask = file.task
      const head = h('div', 'group-head')
      head.append(h('span', null, 'Задача ' + file.task))
      box.append(head)
    }
    const card = h('div', 'plan-card')
    const ic = h('span', 'plan-ic')
    ic.append(icon('file'))
    const body = h('div', 'plan-body')
    body.append(h('b', null, file.name))
    const meta = [formatFileSize(file.size), formatDateTime(file.at), file.eventTitle].filter(Boolean).join(' · ')
    body.append(h('span', 'plan-meta', meta))
    if (file.caption) body.append(h('span', 'plan-meta', file.caption))
    const actions = h('div', 'file-actions')
    const open = h('button', 'pill-btn', 'Открыть')
    open.type = 'button'
    open.addEventListener('click', () => void openArtifact({
      name: file.name,
      url: state.diskMode
        ? '/api/disk/download?path=' + encodeURIComponent(file.path)
        : '/api/files/agent/' + encodeURIComponent(file.id) + '/download',
      mime: file.mime || '',
    }))
    const link = document.createElement('a')
    link.className = 'pill-btn'
    link.href = state.diskMode
      ? '/api/disk/download?path=' + encodeURIComponent(file.path)
      : '/api/files/agent/' + encodeURIComponent(file.id) + '/download'
    link.textContent = 'Скачать'
    const remove = h('button', 'pill-btn danger', 'Удалить')
    remove.type = 'button'
    remove.addEventListener('click', () => {
      confirmSheet('Удалить файл?', file.name, 'Удалить', async () => {
        try {
          if (state.diskMode) await api('DELETE', '/api/disk?path=' + encodeURIComponent(file.path))
          else await api('DELETE', '/api/files/agent/' + encodeURIComponent(file.id))
          state.agentFiles = (state.agentFiles || []).filter((item) => item.id !== file.id)
          renderAgentFiles()
          toast('Файл удалён')
        } catch (error) {
          toast(error.message || 'Не удалось удалить файл')
        }
      })
    })
    actions.append(open, link, remove)
    body.append(actions)
    card.append(ic, body)
    box.append(card)
  })
}

function switchFilesTab(tab) {
  state.filesTab = tab
  document.querySelectorAll('[data-files-tab]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.filesTab === tab)
  })
  $('files-search-row').hidden = tab !== 'documents'
  if (tab === 'agent') {
    $('files-list').replaceChildren(h('p', 'hint', 'Загружаю…'))
    void loadAgentFiles()
  } else {
    renderFiles()
  }
}

function closeArtifact() {
  $('artifact').hidden = true
  $('artifact-body').replaceChildren()
}

async function openArtifact({ name, url, mime = '' } = {}) {
  if (!url) return
  $('artifact').hidden = false
  $('artifact-name').textContent = name || 'Файл'
  $('artifact-meta').textContent = mime || ''
  $('artifact-download').href = url
  $('artifact-download').setAttribute('download', name || 'file')
  const body = $('artifact-body')
  body.replaceChildren(h('p', 'artifact-note', 'Загружаю…'))
  const type = String(mime).toLowerCase()
  const lower = String(name || '').toLowerCase()
  try {
    if (type.startsWith('image/') || /\.(png|jpe?g|webp|gif|heic)$/.test(lower)) {
      const img = document.createElement('img')
      img.src = url
      img.alt = name || 'Изображение'
      body.replaceChildren(img)
      return
    }
    if (type.startsWith('video/') || /\.(mp4|mov|webm)$/.test(lower)) {
      const video = document.createElement('video')
      video.src = url
      video.controls = true
      body.replaceChildren(video)
      return
    }
    if (type.startsWith('audio/') || /\.(mp3|m4a|ogg|webm|wav)$/.test(lower)) {
      const audio = document.createElement('audio')
      audio.src = url
      audio.controls = true
      body.replaceChildren(audio)
      return
    }
    if (type === 'application/pdf' || lower.endsWith('.pdf')) {
      const frame = document.createElement('iframe')
      frame.src = url
      frame.title = name || 'PDF'
      body.replaceChildren(frame)
      return
    }
    const response = await fetch(url, { credentials: 'same-origin' })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    const textType = type.startsWith('text/') || /\.(txt|md|json|js|mjs|cjs|py|csv|log|html|css|xml|yml|yaml|sh)$/.test(lower)
    const text = await response.text()
    if (textType || (!/\u0000/.test(text) && text.length > 0)) {
      body.replaceChildren(h('pre', null, text.slice(0, 200_000)))
    } else {
      body.replaceChildren(h('p', 'artifact-note', 'Предпросмотр недоступен. Скачайте файл кнопкой сверху.'))
    }
  } catch (error) {
    body.replaceChildren(h('p', 'artifact-note', 'Не удалось открыть предпросмотр. Скачайте файл кнопкой сверху.'))
  }
}

function renderFiles() {
  const box = $('files-list')
  box.replaceChildren()
  const files = state.files || []
  if (files.length === 0) {
    box.append(h('p', 'hint', 'Файлов пока нет. Попросите бота в чате собрать отчёт, таблицу или документ.'))
    return
  }
  files.forEach((file) => {
    const row = h('div', 'plan-card')
    const iconBox = h('span', 'plan-ic')
    iconBox.append(icon('file'))
    const body = h('div', 'plan-body')
    body.append(h('b', null, file.name || 'Документ'))
    body.append(h('span', 'plan-meta', [formatFileSize(file.size), file.status === 'ready' ? 'готов' : file.status].filter(Boolean).join(' · ')))
    const actions = h('div', 'file-actions')
    const open = h('button', 'pill-btn', 'Открыть')
    open.type = 'button'
    open.addEventListener('click', () => void openArtifact({
      name: file.name || 'Документ',
      url: '/api/files/' + encodeURIComponent(file.id) + '/download',
      mime: file.mime,
    }))
    const download = document.createElement('a')
    download.className = 'pill-btn'
    download.href = '/api/files/' + encodeURIComponent(file.id) + '/download'
    download.download = file.name || 'file'
    download.textContent = 'Скачать'
    actions.append(open, download)
    body.append(actions)
    row.append(iconBox, body)
    box.append(row)
  })
}

async function patchSettings(patch, successMessage) {
  try {
    const settings = await api('PATCH', '/api/settings', patch)
    state.settings = settings
    state.loaded.settings = true
    renderSettings()
    void loadProactive()
    refreshProfile()
    if (state.loaded.memory) {
      state.loaded.memory = false
      void loadMemory()
    }
    if (successMessage) toast(successMessage)
  } catch (error) {
    handleError(error)
  }
}

function openSettingsPicker(kind) {
  const settings = state.settings
  if (!settings) return
  const options = (settings.options && settings.options[kind === 'persona' ? 'personas' : kind === 'mood' ? 'moods' : kind === 'mode' ? 'modes' : 'models']) || []
  const current = kind === 'persona' ? settings.persona
    : kind === 'mood' ? settings.mood
      : kind === 'mode' ? settings.mode
        : settings.model
  const labels = {
    persona: 'Характер',
    mood: 'Настроение',
    mode: 'Режим ответов',
    model: 'Модель'
  }
  const values = options.map((value) => ({ value, label: capitalize(value) }))
  if (kind !== 'model') values.unshift({ value: '', label: 'Сбросить' })
  else values.unshift({ value: '', label: 'Как в конфигурации' })
  const selected = current || ''
  openPicker(labels[kind], values, selected, (value) => {
    void patchSettings({ [kind]: value }, labels[kind] + ' сохранён')
  })
}

/* ============================ Уведомления (PWA) ============================ */

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
let pushConfigCache = null

const isStandalone = () => window.navigator.standalone === true
  || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)

const pushSupported = () => 'serviceWorker' in navigator
  && 'PushManager' in window
  && 'Notification' in window

function urlBase64ToUint8Array(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const output = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index)
  return output
}

async function getPushConfig() {
  if (pushConfigCache) return pushConfigCache
  pushConfigCache = await api('GET', '/api/push/config')
  return pushConfigCache
}

async function pushRegistration() {
  if (!('serviceWorker' in navigator)) return null
  const registrations = await navigator.serviceWorker.getRegistrations()
  return registrations.find((item) => String(item.scope).includes('/mobile/')) || null
}

async function refreshPushToggle() {
  const toggle = $('push-toggle')
  if (!toggle) return
  if (!pushSupported()) {
    toggle.classList.remove('is-on')
    return
  }
  try {
    const registration = await pushRegistration()
    const subscription = registration ? await registration.pushManager.getSubscription() : null
    toggle.classList.toggle('is-on', Boolean(subscription))
    // Подписка принадлежит браузеру, а не аккаунту. Если на этом устройстве
    // раньше входил другой человек, переназначаем её текущему аккаунту.
    if (subscription) {
      const config = await getPushConfig()
      if (config.enabled) {
        await api('POST', '/api/push/subscribe', subscription.toJSON()).catch(() => {})
      }
    }
  } catch {
    toggle.classList.remove('is-on')
  }
}

function showPushInstallSheet() {
  const wrap = h('div')
  const steps = IS_IOS
    ? [
        'Откройте сайт в Safari (не в Яндекс.Браузере и не во встроенном браузере Telegram).',
        'Нажмите «Поделиться» → «На экран Домой».',
        'Запустите приложение с иконки на рабочем столе.',
        'Вернитесь в «Настройки → Уведомления» и включите переключатель.'
      ]
    : [
        'Откройте сайт в Chrome.',
        'Меню браузера → «Установить приложение» или «Добавить на главный экран».',
        'Запустите приложение с иконки.',
        'Вернитесь в «Настройки → Уведомления» и включите переключатель.'
      ]
  steps.forEach((step, index) => {
    wrap.append(h('p', 'sheet-note', (index + 1) + '. ' + step))
  })
  wrap.append(h('p', 'sheet-note', 'На iPhone push-уведомления работают только в приложении, добавленном на экран «Домой» (iOS 16.4+).'))
  openSheet({ title: 'Установка на телефон', body: wrap })
}

async function enablePush() {
  if (!pushSupported()) {
    showPushInstallSheet()
    return
  }
  if (IS_IOS && !isStandalone()) {
    showPushInstallSheet()
    return
  }
  try {
    const config = await getPushConfig()
    if (!config.enabled || !config.publicKey) {
      toast('Уведомления не настроены на сервере')
      return
    }
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      toast('Разрешение на уведомления не выдано')
      return
    }
    const registration = await navigator.serviceWorker.register('/mobile/sw.js', { scope: '/mobile/' })
    await navigator.serviceWorker.ready
    let subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey)
      })
    }
    await api('POST', '/api/push/subscribe', subscription.toJSON())
    $('push-toggle').classList.add('is-on')
    toast('Уведомления включены')
  } catch (error) {
    $('push-toggle').classList.remove('is-on')
    toast(error && error.message ? error.message : 'Не удалось включить уведомления')
  }
}

async function testPushNotification() {
  const button = $('push-test')
  if (button) button.disabled = true
  try {
    const result = await api('POST', '/api/push/test', {})
    const sent = Number(result.sent ?? 0)
    const subscribed = Number(result.subscribed ?? 0)
    if (subscribed === 0) {
      toast('Нет подписки на этом аккаунте — включите уведомления')
    } else if (sent > 0) {
      toast('Тестовый push отправлен на ' + sent + ' устр. Сверните приложение')
    } else {
      toast('Push не принят: ' + (result.error || 'неизвестная ошибка'))
    }
  } catch (error) {
    toast(error && error.message ? error.message : 'Не удалось отправить тестовый push')
  } finally {
    if (button) button.disabled = false
  }
}

async function disablePush() {
  try {
    const registration = await pushRegistration()
    const subscription = registration ? await registration.pushManager.getSubscription() : null
    if (subscription) {
      await api('POST', '/api/push/unsubscribe', { endpoint: subscription.endpoint }).catch(() => {})
      await subscription.unsubscribe().catch(() => {})
    }
    $('push-toggle').classList.remove('is-on')
    toast('Уведомления выключены')
  } catch (error) {
    toast(error && error.message ? error.message : 'Не удалось выключить уведомления')
  }
}

function refreshProfile() {
  const settings = state.settings
  const name = (settings && settings.user && settings.user.name)
    || (state.session && state.session.user && state.session.user.name)
    || 'Владелец'
  $('profile-name').textContent = name
  $('profile-letter').textContent = name.trim().charAt(0).toUpperCase() || 'В'
  const via = (settings && settings.user && settings.user.via) || (state.session && state.session.user && state.session.user.via)
  const login = (settings && settings.user && settings.user.login) || (state.session && state.session.user && state.session.user.login)
  $('profile-via').textContent = via === 'password'
    ? 'Вход: ' + (login || 'по паролю')
    : 'Telegram'
  const desktopName = $('desktop-profile-name')
  const desktopLetter = $('desktop-profile-letter')
  const desktopVia = $('desktop-profile-via')
  if (desktopName) desktopName.textContent = name
  if (desktopLetter) desktopLetter.textContent = name.trim().charAt(0).toUpperCase() || 'В'
  if (desktopVia) desktopVia.textContent = via === 'password' ? 'tenkrol.ru' : 'Telegram'
}

/* ============================ Аккаунты ============================ */

function accountRoleLabel(role) {
  return role === 'owner' ? 'владелец' : 'участник'
}

function accountRow(account, currentLogin) {
  const row = h('div', 'info-row')
  const name = h('b', null, account.name + (account.login === currentLogin ? ' · это вы' : ''))
  name.style.marginLeft = '0'
  row.append(name, h('span', null, account.login + ' · ' + accountRoleLabel(account.role)))
  return row
}

function renderTotpRow() {
  const hint = $('totp-hint')
  if (!hint) return
  const enabled = Boolean(state.session && state.session.totpEnabled)
  hint.textContent = enabled ? 'включена · код при входе' : 'код из приложения при входе'
}

function openTotpSheet() {
  const enabled = Boolean(state.session && state.session.totpEnabled)
  const wrap = h('div')
  const password = document.createElement('input')
  password.className = 'input'
  password.type = 'password'
  password.placeholder = 'Текущий пароль'
  const error = h('div', 'login-error')
  error.hidden = true
  const code = document.createElement('input')
  code.className = 'input'
  code.inputMode = 'numeric'
  code.autocomplete = 'one-time-code'
  code.placeholder = '6 цифр из приложения'
  code.maxLength = 7
  const codeField = field('Код из приложения', code)
  const submit = h('button', 'btn btn-primary btn-block', enabled ? 'Отключить 2FA' : 'Получить секрет')
  submit.type = 'button'
  const secretBox = h('div')
  secretBox.hidden = true
  let step = enabled ? 'disable' : 'setup'
  submit.addEventListener('click', async () => {
    if (password.value === '') {
      error.hidden = false
      error.textContent = 'Введите текущий пароль'
      return
    }
    submit.disabled = true
    error.hidden = true
    try {
      if (step === 'setup') {
        const data = await api('POST', '/api/2fa/setup', { currentPassword: password.value })
        secretBox.hidden = false
        secretBox.replaceChildren()
        secretBox.append(h('p', 'hint', 'Добавьте в приложение-аутентификатор (Google Authenticator, 1Password, Keychain):'))
        secretBox.append(h('code', 'totp-secret', data.secret))
        const link = document.createElement('a')
        link.className = 'pill-btn'
        link.href = data.uri
        link.textContent = 'Открыть в приложении'
        secretBox.append(link)
        codeField.hidden = false
        step = 'enable'
        submit.textContent = 'Включить 2FA'
        submit.disabled = false
        code.focus()
        return
      }
      if (step === 'enable') {
        await api('POST', '/api/2fa/enable', { currentPassword: password.value, code: code.value.trim() })
        state.session.totpEnabled = true
        renderTotpRow()
        closeSheet()
        toast('Двухфакторная защита включена')
        return
      }
      await api('POST', '/api/2fa/disable', { currentPassword: password.value, code: code.value.trim() })
      state.session.totpEnabled = false
      renderTotpRow()
      closeSheet()
      toast('Двухфакторная защита отключена')
    } catch (err) {
      error.hidden = false
      error.textContent = err.message || 'Не удалось изменить 2FA'
      submit.disabled = false
    }
  })
  codeField.hidden = !enabled
  wrap.append(field('Текущий пароль', password), codeField, secretBox, error, submit)
  wrap.append(h('p', 'sheet-note', enabled
    ? 'Для отключения нужен текущий код из приложения.'
    : 'Секрет показывается один раз. Без кода войти не получится — сохраните его в надёжном месте.'))
  openSheet({ title: enabled ? 'Двухфакторная защита' : 'Включить 2FA', body: wrap })
}

async function openAuthLog() {
  const wrap = h('div')
  wrap.append(h('p', 'hint', 'Загружаю…'))
  openSheet({ title: 'Журнал входов', body: wrap })
  try {
    const data = await api('GET', '/api/security/log')
    const entries = Array.isArray(data.entries) ? data.entries : []
    wrap.replaceChildren()
    if (entries.length === 0) {
      wrap.append(h('p', 'hint', 'Записей пока нет.'))
      return
    }
    entries.forEach((entry) => {
      const row = h('div', 'plan-card')
      const body = h('div', 'plan-body')
      body.append(h('b', null, (entry.ok ? '✓ ' : '✕ ') + (entry.at ? formatDateTime(entry.at) : '')))
      body.append(h('span', 'plan-meta', [entry.ip, entry.via, entry.userAgent].filter(Boolean).join(' · ')))
      if (entry.reason) body.append(h('span', 'plan-meta', 'причина: ' + entry.reason))
      row.append(body)
      wrap.append(row)
    })
  } catch (error) {
    wrap.replaceChildren(h('p', 'hint', error.message || 'Не удалось загрузить журнал'))
  }
}

function openRevokeAllSheet() {
  const wrap = h('div')
  const password = document.createElement('input')
  password.className = 'input'
  password.type = 'password'
  password.autocomplete = 'current-password'
  password.placeholder = 'Текущий пароль'
  const error = h('div', 'login-error')
  error.hidden = true
  const confirm = h('button', 'btn btn-danger-ghost btn-block', 'Выйти везде')
  confirm.type = 'button'
  confirm.addEventListener('click', async () => {
    if (password.value === '') {
      error.hidden = false
      error.textContent = 'Введите текущий пароль'
      return
    }
    confirm.disabled = true
    try {
      await api('POST', '/api/session/revoke-all', { currentPassword: password.value })
      closeSheet()
      showLogin('Все сессии сброшены — войдите заново.')
    } catch (err) {
      confirm.disabled = false
      error.hidden = false
      error.textContent = err.message || 'Не удалось сбросить сессии'
    }
  })
  wrap.append(field('Текущий пароль', password), error, confirm)
  wrap.append(h('p', 'sheet-note', 'Все браузеры и PWA выйдут из аккаунта. Новый вход потребует пароль.'))
  openSheet({ title: 'Выйти на всех устройствах', body: wrap })
}

function openCredentialsSheet() {
  const user = (state.settings && state.settings.user) || (state.session && state.session.user) || {}
  const wrap = h('div')
  const current = h('input', 'input')
  current.type = 'password'
  current.autocomplete = 'current-password'
  current.placeholder = 'Текущий пароль'
  wrap.append(field('Текущий пароль', current))

  const login = h('input', 'input')
  login.autocomplete = 'username'
  login.autocapitalize = 'off'
  login.spellcheck = false
  login.value = user.login || ''
  wrap.append(field('Новый логин', login))

  const password = h('input', 'input')
  password.type = 'password'
  password.autocomplete = 'new-password'
  password.placeholder = 'Оставьте пустым, чтобы не менять'
  wrap.append(field('Новый пароль', password))

  const confirm = h('input', 'input')
  confirm.type = 'password'
  confirm.autocomplete = 'new-password'
  confirm.placeholder = 'Повторите новый пароль'
  wrap.append(field('Повтор пароля', confirm))

  const error = h('div', 'login-error')
  error.hidden = true
  wrap.append(error)

  const submit = h('button', 'btn btn-primary btn-block', 'Сохранить вход')
  submit.type = 'button'
  submit.addEventListener('click', async () => {
    error.hidden = true
    const nextLogin = login.value.trim().toLowerCase()
    const nextPassword = password.value
    const currentPassword = current.value
    if (currentPassword === '') {
      error.hidden = false
      error.textContent = 'Введите текущий пароль'
      current.focus()
      return
    }
    if (nextLogin === '' && nextPassword === '') {
      error.hidden = false
      error.textContent = 'Ничего не меняется'
      return
    }
    if (nextPassword !== '' && nextPassword !== confirm.value) {
      error.hidden = false
      error.textContent = 'Новые пароли не совпадают'
      confirm.focus()
      return
    }
    const patch = { currentPassword }
    if (nextLogin !== '' && nextLogin !== user.login) patch.login = nextLogin
    if (nextPassword !== '') patch.password = nextPassword
    submit.disabled = true
    try {
      const result = await api('PATCH', '/api/account', patch)
      if (state.session && state.session.user) {
        state.session.user.login = result.user.login
        state.session.user.name = result.user.name
        state.session.user.role = result.user.role
      }
      if (state.settings && state.settings.user) {
        state.settings.user.login = result.user.login
        state.settings.user.name = result.user.name
        state.settings.user.role = result.user.role
      }
      refreshProfile()
      closeSheet()
      toast(result.sessionUpdated ? 'Логин и пароль обновлены' : 'Имя обновлено')
    } catch (err) {
      submit.disabled = false
      error.hidden = false
      error.textContent = err && err.message ? err.message : 'Не удалось сохранить'
    }
  })
  wrap.append(submit)
  wrap.append(h('p', 'sheet-note', 'После смены пароля старые сессии на других устройствах перестанут работать. Логин и пароль хранятся только на сервере.'))
  openSheet({ title: 'Логин и пароль', body: wrap })
}

async function openUsersSheet() {
  try {
    const data = await api('GET', '/api/accounts')
    const wrap = h('div')
    const currentLogin = data.current ? data.current.login : null
    if (Array.isArray(data.accounts) && data.accounts.length > 0) {
      data.accounts.forEach((account) => wrap.append(accountRow(account, currentLogin)))
    } else {
      wrap.append(h('p', 'sheet-note', 'Пользователи пока не настроены.'))
    }
    if (data.canManage) {
      wrap.append(h('div', 'group-head', 'Добавить пользователя'))
      const name = h('input', 'input')
      name.placeholder = 'Имя, например Маша'
      wrap.append(field('Имя', name))
      const login = h('input', 'input')
      login.placeholder = 'masha'
      login.autocomplete = 'off'
      login.autocapitalize = 'off'
      login.spellcheck = false
      wrap.append(field('Логин', login))
      const password = h('input', 'input')
      password.type = 'password'
      password.autocomplete = 'new-password'
      password.placeholder = 'Пароль для входа'
      wrap.append(field('Пароль', password))
      const error = h('div', 'login-error')
      error.hidden = true
      wrap.append(error)
      const submit = h('button', 'btn btn-primary btn-block', 'Добавить пользователя')
      submit.type = 'button'
      submit.addEventListener('click', async () => {
        error.hidden = true
        const payload = {
          name: name.value.trim(),
          login: login.value.trim().toLowerCase(),
          password: password.value
        }
        if (payload.name === '' || payload.login === '' || payload.password === '') {
          error.hidden = false
          error.textContent = 'Заполните имя, логин и пароль'
          return
        }
        submit.disabled = true
        try {
          await api('POST', '/api/accounts', payload)
          closeSheet()
          toast('Пользователь добавлен — он входит своим логином')
          await openUsersSheet()
        } catch (err) {
          submit.disabled = false
          error.hidden = false
          error.textContent = err && err.message ? err.message : 'Не удалось добавить пользователя'
        }
      })
      wrap.append(submit)
      wrap.append(h('p', 'sheet-note', 'Telegram id подставится автоматически: следующий свободный из ALLOWED_USER_IDS. У нового человека будут свои напоминания, память и история.'))
    } else {
      wrap.append(h('p', 'sheet-note', 'Добавлять пользователей может только владелец.'))
    }
    openSheet({ title: 'Пользователи', body: wrap })
  } catch (error) {
    handleError(error)
  }
}

/* ============================ Агент ============================ */

const AGENT_TEMPLATES = {
  document: {
    title: 'Документ',
    fields: [
      { key: 'title', label: 'Название документа', placeholder: 'Письмо клинике' },
      { key: 'details', label: 'Что должно быть внутри', type: 'textarea', placeholder: 'Кому, о чём, какие реквизиты и сроки указать' },
      { key: 'format', label: 'Формат файла', type: 'select', options: ['DOCX', 'PDF'] }
    ],
    build: (v) => `Подготовь документ «${v.title}» в формате ${v.format}.\nЧто должно быть внутри: ${v.details}\nОформи аккуратно, с заголовками и подписями; пришли готовый файл.`
  },
  table: {
    title: 'Таблица',
    fields: [
      { key: 'topic', label: 'Тема таблицы', placeholder: 'Расходы за сентябрь' },
      { key: 'columns', label: 'Столбцы и данные', type: 'textarea', placeholder: 'Категория, сумма, дата; итоги по категориям' },
      { key: 'source', label: 'Источник данных', placeholder: 'Файл в чате, ссылка или «собери сам»' }
    ],
    build: (v) => `Собери таблицу в формате XLSX по теме «${v.topic}».\nСтолбцы и данные: ${v.columns}\nИсточник данных: ${v.source}\nДобавь итоги и пришли готовый файл.`
  },
  report: {
    title: 'Отчёт',
    fields: [
      { key: 'topic', label: 'Тема отчёта', placeholder: 'Отчёт по дому за октябрь' },
      { key: 'period', label: 'Период', placeholder: 'Октябрь 2026' },
      { key: 'details', label: 'Что включить', type: 'textarea', placeholder: 'Расходы, ремонт, важные события' },
      { key: 'format', label: 'Формат файла', type: 'select', options: ['DOCX', 'PDF', 'XLSX'] }
    ],
    build: (v) => `Собери отчёт «${v.topic}» за период ${v.period} в формате ${v.format}.\nЧто включить: ${v.details}\nСтруктура: краткое резюме, факты и цифры, выводы. Пришли готовый файл.`
  },
  research: {
    title: 'Исследование',
    fields: [
      { key: 'topic', label: 'Тема', placeholder: 'Проверить рынок аренды в Казани' },
      { key: 'questions', label: 'Какие вопросы закрыть', type: 'textarea', placeholder: 'Цены, спрос, риски, источники' },
      { key: 'format', label: 'Формат ответа', type: 'select', options: ['Текст в чат', 'PDF'] }
    ],
    build: (v) => `Проведи исследование по теме: ${v.topic}.\nВопросы, на которые нужно ответить: ${v.questions}\nНайди подтверждения в источниках, дай ссылки и отдели факты от предположений. Формат: ${v.format}.`
  },
  translate: {
    title: 'Перевод',
    fields: [
      { key: 'language', label: 'На какой язык', placeholder: 'английский' },
      { key: 'source', label: 'Текст или ссылка', type: 'textarea', placeholder: 'Вставьте текст или ссылку на страницу' },
      { key: 'style', label: 'Стиль', type: 'select', options: ['Обычный', 'Деловой', 'Художественный'] }
    ],
    build: (v) => `Переведи на ${v.language} следующий материал:\n${v.source}\nСтиль: ${v.style}. Сохрани смысл, пришли результат текстом.`
  },
  site: {
    title: 'Проверка',
    fields: [
      { key: 'target', label: 'Что проверить', placeholder: 'https://tenkrol.ru или репозиторий' },
      { key: 'checks', label: 'Что именно проверить', type: 'textarea', placeholder: 'Ошибки, доступность, ссылки, безопасность' },
      { key: 'format', label: 'Формат ответа', type: 'select', options: ['Список проблем', 'PDF'] }
    ],
    build: (v) => `Проверь ${v.target}.\nЧто проверить: ${v.checks}\nДай список найденного с приоритетом и конкретными шагами. Формат: ${v.format}.`
  },
  code: {
    title: 'Код',
    fields: [
      { key: 'project', label: 'Проект или репозиторий', placeholder: 'tenkrol/assistant или путь на сервере' },
      { key: 'task', label: 'Что сделать', type: 'textarea', placeholder: 'Исправить ошибку, добавить функцию, обновить тесты' },
      { key: 'criteria', label: 'Критерии готовности', type: 'textarea', placeholder: 'Что должно работать и какие тесты должны пройти' },
      { key: 'checks', label: 'Проверка', type: 'select', options: ['Тесты и линтер', 'Только тесты', 'Без запуска тестов'] }
    ],
    build: (v) => `Работай с кодом проекта: ${v.project}.\nЗадача: ${v.task}\nКритерии готовности: ${v.criteria}\nПроверка: ${v.checks}. Сделай изменения, прогони проверку и пришли отчёт с результатом.`
  },
  monitor: {
    title: 'Сервер',
    fields: [
      { key: 'target', label: 'Что проверить', type: 'select', options: ['Сайт tenkrol.ru', 'Сервер Испания', 'Сервер Финляндия', 'Все сервисы'] },
      { key: 'checks', label: 'Что именно', type: 'textarea', placeholder: 'Диск, память, systemd, nginx, ошибки в логах, сертификаты' },
      { key: 'format', label: 'Формат отчёта', type: 'select', options: ['Кратко в чат', 'Подробный отчёт', 'PDF'] }
    ],
    build: (v) => `Проверь: ${v.target}.\nЧто проверить: ${v.checks}\nДай статус сервисов, диск и память, свежие ошибки, риски и рекомендации. Формат: ${v.format}.`
  },
  personal: {
    title: 'Память',
    fields: [
      { key: 'action', label: 'Что сделать', type: 'select', options: ['Запомнить факт', 'Напомнить', 'Изменить настройку'] },
      { key: 'details', label: 'Детали', type: 'textarea', placeholder: 'Что запомнить, о чём напомнить или какую настройку поменять' },
      { key: 'when', label: 'Когда', placeholder: 'например, завтра в 9:00 или «без срока»' }
    ],
    build: (v) => `Личная задача: ${v.action}.\nДетали: ${v.details}\nКогда: ${v.when}. Учти контекст владельца и подтверди, что сделано.`
  },
  complex: {
    title: 'Сложная задача',
    fields: [
      { key: 'goal', label: 'Цель', type: 'textarea', placeholder: 'Что нужно получить в итоге' },
      { key: 'constraints', label: 'Ограничения', type: 'textarea', placeholder: 'Сроки, бюджет, что нельзя трогать' },
      { key: 'format', label: 'Формат результата', type: 'select', options: ['Отчёт в чат', 'Документ DOCX', 'Таблица XLSX'] }
    ],
    build: (v) => `Сложная задача: ${v.goal}\nОграничения: ${v.constraints}\nРазбей на шаги, выполни и пришли результат в формате: ${v.format}. Покажи прогресс и итог.`
  },
  quick: {
    title: 'Быстро',
    fields: [
      { key: 'task', label: 'Что нужно', type: 'textarea', placeholder: 'Короткий вопрос, перевод, справка или одно действие' }
    ],
    build: (v) => `Быстрая задача: ${v.task}`
  },
  custom: {
    title: 'Своя задача',
    fields: [
      { key: 'task', label: 'Задание', type: 'textarea', placeholder: 'Опишите, что должен сделать агент и какой результат нужен' }
    ],
    build: (v) => v.task
  }
}

function agentFieldInput(def) {
  let input
  if (def.type === 'textarea') {
    input = h('textarea', 'input agent-preview')
    input.rows = 4
  } else if (def.type === 'select') {
    input = h('select', 'input')
    ;(def.options ?? []).forEach((option) => {
      const node = document.createElement('option')
      node.value = option
      node.textContent = option
      input.append(node)
    })
  } else {
    input = h('input', 'input')
  }
  if (def.placeholder) input.placeholder = def.placeholder
  return input
}

function openAgentTemplate(key) {
  const template = AGENT_TEMPLATES[key]
  if (!template) return
  const wrap = h('div')
  const inputs = {}
  template.fields.forEach((def) => {
    const input = agentFieldInput(def)
    inputs[def.key] = input
    wrap.append(field(def.label, input))
  })

  const preview = h('textarea', 'input agent-preview')
  preview.rows = 6
  preview.setAttribute('aria-label', 'Задание агенту')
  wrap.append(field('Задание, которое уйдёт агенту', preview))

  const error = h('div', 'login-error')
  error.hidden = true
  wrap.append(error)

  const refresh = () => {
    const values = {}
    template.fields.forEach((def) => {
      values[def.key] = inputs[def.key].value.trim()
    })
    preview.value = template.build(values)
  }
  Object.values(inputs).forEach((input) => {
    input.addEventListener('input', refresh)
    input.addEventListener('change', refresh)
  })
  refresh()
  if (key === 'custom') {
    const custom = inputs.task
    custom.addEventListener('input', () => { preview.value = custom.value })
  }

  const submit = h('button', 'btn btn-primary btn-block', 'Отправить агенту')
  submit.type = 'button'
  submit.addEventListener('click', async () => {
    error.hidden = true
    const task = preview.value.trim()
    if (task === '') {
      error.hidden = false
      error.textContent = 'Заполните задание'
      return
    }
    const missing = template.fields.some((def) => inputs[def.key].value.trim() === '')
    if (missing && key !== 'custom') {
      error.hidden = false
      error.textContent = 'Заполните все поля шаблона'
      return
    }
    submit.disabled = true
    try {
      const result = await api('POST', '/api/agent/task', { task })
      closeSheet()
      toast('Задание передано агенту')
      const card = h('div', 'agent-result', result.text || 'Задание передано агенту. Результат придёт в чат.')
      const old = document.querySelector('.agent-result')
      if (old) old.remove()
      $('agent-scroll').prepend(card)
      state.loaded.chat = false
      void loadAgentStatus()
    } catch (err) {
      submit.disabled = false
      error.hidden = false
      error.textContent = err && err.message ? err.message : 'Не удалось передать задание'
    }
  })
  wrap.append(submit)
  wrap.append(h('p', 'sheet-note', 'Агент работает в песочнице. Задание и подтверждение появятся в истории чата; файлы придут в Telegram.'))
  openSheet({ title: template.title, body: wrap })
}

const AGENT_CAPABILITY_GROUPS = [
  { label: 'Код', caps: ['code'] },
  { label: 'Файлы и офис', caps: ['files', 'documents', 'office'] },
  { label: 'Долгие задачи', caps: ['long-task', 'verification-repair'] },
  { label: 'Мониторинг', caps: ['monitor', 'host', 'alerts'] },
  { label: 'Память и напоминания', caps: ['personal', 'memory', 'reminders', 'preferences'] },
  { label: 'Планирование', caps: ['tasks', 'lifecycle', 'budget'] },
  { label: 'Быстро', caps: ['quick'] }
]

async function cancelAgentTask(taskId) {
  try {
    await api('POST', '/api/agent/cancel', { taskId })
    toast('Задача отменена')
    await loadAgentStatus()
  } catch (error) {
    toast(error.message || 'Не удалось отменить задачу')
  }
}

function renderAgentCapabilities(data) {
  const box = $('agent-capabilities')
  if (!box) return
  const capabilities = new Set()
  ;(data && Array.isArray(data.agents) ? data.agents : []).forEach((agent) => {
    ;(agent.capabilities ?? []).forEach((capability) => capabilities.add(capability))
  })
  const groups = AGENT_CAPABILITY_GROUPS.filter((group) => group.caps.some((cap) => capabilities.has(cap)))
  box.replaceChildren()
  if (groups.length === 0) {
    box.hidden = true
    return
  }
  box.hidden = false
  groups.forEach((group) => {
    const chip = h('span', 'agent-cap')
    chip.title = group.caps.join(', ')
    chip.append(icon('check'), h('span', null, group.label))
    box.append(chip)
  })
}

function renderAgentStatus(data) {
  const pill = $('agent-status-pill')
  if (data && data.enabled) {
    pill.classList.remove('is-off')
    pill.replaceChildren(h('span', 'dot'), h('span', null, 'на связи'))
  } else {
    pill.classList.add('is-off')
    pill.replaceChildren(h('span', 'dot'), h('span', null, 'недоступен'))
  }
  renderAgentCapabilities(data)
  const box = $('agent-events')
  const events = data && Array.isArray(data.events) ? data.events : []
  $('agent-events-count').textContent = String(events.length)
  box.replaceChildren()
  if (events.length === 0) {
    box.append(h('p', 'hint', data && data.enabled ? 'Пока нет задач. Выберите блок выше.' : 'Агент не отвечает: мост выключен или недоступен.'))
    return
  }
  events.slice(0, 8).forEach((event) => {
    const card = h('div', 'agent-event')
    const ic = h('span', 'plan-ic' + (event.status === 'failed' ? ' event' : ''))
    ic.append(icon(event.type === 'question' ? 'help' : 'cpu'))
    const body = h('div', 'agent-event-body')
    const title = event.title || event.taskId || 'Задача агента'
    body.append(h('div', 'agent-event-title', String(title)))
    const meta = [event.agent, event.type, event.status, event.tokens ? event.tokens + ' ток.' : ''].filter(Boolean).join(' · ')
    body.append(h('div', 'agent-event-meta', meta || 'событие агента'))
    if (event.taskId && !['done', 'failed', 'cancelled', 'expired'].includes(String(event.status))) {
      const cancel = h('button', 'agent-cancel', 'Отменить')
      cancel.type = 'button'
      cancel.addEventListener('click', () => void cancelAgentTask(event.taskId))
      body.append(cancel)
    }
    card.append(ic, body)
    box.append(card)
  })
}

async function loadAgentStatus() {
  try {
    const data = await api('GET', '/api/agent/status')
    renderAgentStatus(data)
  } catch (error) {
    if (error.status !== 401) renderAgentStatus({ enabled: false, events: [] })
  }
}

async function ensureAgent() {
  await loadAgentStatus()
}

/* ============================ Статистика ============================ */

async function ensureStats() {
  if (!state.loaded.stats && !state.loading.stats) await loadStats()
}

async function loadStats() {
  if (state.loading.stats) return
  state.loading.stats = true
  try {
    const data = await api('GET', '/api/stats?days=' + state.statsDays)
    state.stats = data
    state.loaded.stats = true
    renderStats()
  } catch (error) {
    if (error.status !== 401) {
      $('stats-scroll').replaceChildren(renderError('Не удалось загрузить статистику', () => {
        state.loaded.stats = false
        void loadStats()
      }))
    }
  } finally {
    state.loading.stats = false
  }
}

function renderStats() {
  const box = $('stats-scroll')
  const stats = state.stats
  if (!stats) return
  box.replaceChildren()
  const today = stats.today || { prompt: 0, completion: 0, total: 0, requests: 0 }
  const hero = h('div', 'stat-hero')
  hero.append(h('span', 'stat-label', 'Токенов за сегодня'))
  hero.append(h('div', 'stat-value', String(today.total || 0)))
  const delta = h('div', 'stat-delta')
  delta.append(icon('chart'), h('span', null, 'запросов: ' + (today.requests || 0)))
  hero.append(delta)
  const split = h('div', 'stat-split')
  split.append(
    statCell(today.prompt, 'токенов запроса'),
    statCell(today.completion, 'токенов ответа'),
    statCell(today.requests, 'запросов')
  )
  hero.append(split)
  box.append(hero)

  const days = Array.isArray(stats.days) ? stats.days : []
  const periodTotal = days.reduce((sum, day) => sum + (day.total || 0), 0)
  const periodRequests = days.reduce((sum, day) => sum + (day.requests || 0), 0)
  const average = days.length > 0 ? Math.round(periodTotal / days.length) : 0
  const best = days.slice().sort((a, b) => (b.total || 0) - (a.total || 0))[0]
  const max = Math.max(1, ...days.map((day) => day.total || 0))
  const chartCard = h('div', 'card chart-card')
  const chartHead = h('div', 'card-head')
  chartHead.append(h('b', null, 'За ' + days.length + ' дней'), h('span', null, 'токены'))
  chartCard.append(chartHead)
  const chart = h('div', 'chart')
  const labels = h('div', 'chart-labels')
  days.forEach((day, index) => {
    const wrap = h('div', 'bar-wrap')
    const bar = h('div', 'bar' + (index === days.length - 1 ? ' today' : ''))
    bar.style.height = Math.max(4, Math.round(((day.total || 0) / max) * 100)) + '%'
    bar.title = day.total + ' токенов'
    wrap.append(bar)
    chart.append(wrap)
    const date = new Date(day.date + 'T12:00:00')
    const label = Number.isNaN(date.getTime()) ? '' : WEEKDAYS_SHORT[(date.getDay() + 6) % 7]
    labels.append(h('span', index === days.length - 1 ? 'today' : '', label))
  })
  chartCard.append(chart, labels)
  box.append(chartCard)

  const periodCard = h('div', 'card')
  const periodHead = h('div', 'card-head')
  periodHead.append(h('b', null, 'За период'), h('span', null, periodTotal + ' токенов'))
  const periodSplit = h('div', 'stat-split')
  periodSplit.append(
    statCell(Math.round(periodTotal / Math.max(1, days.length)), 'в среднем в день'),
    statCell(periodRequests, 'запросов'),
    statCell(best ? best.total : 0, best ? 'лучший день' : 'нет данных')
  )
  periodCard.append(periodHead, periodSplit)
  box.append(periodCard)

  const limit = Number(stats.limit) || 0
  if (limit > 0) {
    const limitCard = h('div', 'card limit-card')
    const head = h('div', 'card-head')
    head.append(h('b', null, 'Дневной лимит'))
    head.append(h('span', null, today.total + ' из ' + limit))
    const progress = h('div', 'progress')
    const bar = h('span')
    bar.style.width = Math.min(100, Math.round((today.total / limit) * 100)) + '%'
    progress.append(bar)
    limitCard.append(head, progress)
    box.append(limitCard)
  } else {
    const note = h('p', 'hint', 'Дневной лимит не задан — бот не ограничивает расход.')
    note.style.paddingTop = '14px'
    box.append(note)
  }
  const updated = h('p', 'hint center', 'Данные обновляются при открытии раздела.')
  box.append(updated)
}

function statCell(value, label) {
  const cell = h('div')
  cell.append(h('b', null, String(value || 0)), h('span', null, label))
  return cell
}

/* ============================ Общие состояния ============================ */

function renderEmpty(title, text) {
  const wrap = h('div', 'empty-day')
  wrap.append(h('b', null, title), h('div', null, text))
  return wrap
}

function renderError(text, retry) {
  const wrap = h('div', 'empty-day')
  wrap.append(h('div', null, text))
  const button = h('button', 'btn btn-ghost btn-sm', 'Повторить')
  button.type = 'button'
  button.style.marginTop = '12px'
  button.addEventListener('click', retry)
  wrap.append(button)
  return wrap
}

/* ============================ Связывание ============================ */

const CMDK_ACTIONS = [
  { label: 'Чат', icon: 'chat', run: () => go('chat') },
  { label: 'Планы и напоминания', icon: 'calendar', run: () => go('plans') },
  { label: 'Память', icon: 'book', run: () => go('memory') },
  { label: 'Агент', icon: 'cpu', run: () => go('agent') },
  { label: 'Настройки', icon: 'settings', run: () => go('settings') },
  { label: 'Файлы', icon: 'folder', run: () => go('files') },
  { label: 'Помощь и команды', icon: 'help', run: () => go('help') },
  { label: 'Состояние серверов', icon: 'server', run: () => go('system') },
  { label: 'Статистика', icon: 'chart', run: () => go('stats') },
  { label: 'Написать ассистенту', icon: 'send', run: () => { go('chat'); setTimeout(() => $('chat-input').focus(), 60) } },
]

let cmdkActive = 0
let cmdkItems = []

function renderCmdk() {
  const query = ($('cmdk-input').value || '').trim().toLowerCase()
  const list = $('cmdk-list')
  cmdkItems = CMDK_ACTIONS.filter((action) => action.label.toLowerCase().includes(query))
  cmdkActive = Math.min(cmdkActive, Math.max(0, cmdkItems.length - 1))
  list.replaceChildren()
  cmdkItems.forEach((action, index) => {
    const button = h('button', 'cmdk-item' + (index === cmdkActive ? ' is-active' : ''))
    button.type = 'button'
    button.append(icon(action.icon), h('span', null, action.label))
    button.addEventListener('click', () => runCmdk(index))
    list.append(button)
  })
  if (cmdkItems.length === 0) list.append(h('p', 'hint', 'Ничего не найдено'))
}

function openCmdk() {
  $('cmdk').hidden = false
  $('cmdk-input').value = ''
  cmdkActive = 0
  renderCmdk()
  $('cmdk-input').focus()
}

function closeCmdk() {
  $('cmdk').hidden = true
}

function runCmdk(index = cmdkActive) {
  const action = cmdkItems[index]
  if (!action) return
  closeCmdk()
  action.run()
}

function mentionName() {
  return String(state.session?.botUsername || 'Tenkrol_bot').replace(/^@/, '')
}

function updateMentionSuggestions() {
  const box = $('mention-list')
  const input = $('chat-input')
  if (!box || !input) return
  if (!state.chatTarget || state.chatTarget.type === 'private') {
    box.hidden = true
    return
  }
  const match = /(?:^|\s)@([A-Za-z0-9_]*)$/.exec(input.value.slice(0, input.selectionStart ?? input.value.length))
  const name = mentionName()
  if (!match || !name.toLowerCase().startsWith(match[1].toLowerCase())) {
    box.hidden = true
    return
  }
  box.replaceChildren()
  const button = h('button', 'mention-item')
  button.type = 'button'
  button.append(h('b', null, '@' + name), h('span', null, 'ассистент'))
  button.addEventListener('click', () => {
    const before = input.value.slice(0, input.selectionStart ?? input.value.length)
    const after = input.value.slice(input.selectionStart ?? input.value.length)
    const replaced = before.replace(/(^|\s)@[A-Za-z0-9_]*$/, '$1@' + name + ' ')
    input.value = replaced + after
    box.hidden = true
    input.focus()
    input.setSelectionRange(replaced.length, replaced.length)
    updateChatSend()
  })
  box.append(button)
  box.hidden = false
}

function bindDesktopShortcuts() {
  let dragDepth = 0
  const chat = $('chat-scroll')
  const clearDrag = () => { dragDepth = 0; chat?.classList.remove('is-drag') }
  if (chat) {
    chat.addEventListener('dragenter', (event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return
      event.preventDefault()
      dragDepth += 1
      chat.classList.add('is-drag')
    })
    chat.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types?.includes('Files')) event.preventDefault()
    })
    chat.addEventListener('dragleave', () => {
      dragDepth -= 1
      if (dragDepth <= 0) clearDrag()
    })
    chat.addEventListener('drop', (event) => {
      if (!event.dataTransfer?.files?.length) return
      event.preventDefault()
      addPendingMedia(event.dataTransfer.files)
      clearDrag()
    })
  }
  document.addEventListener('keydown', (event) => {
    const tag = String(document.activeElement?.tagName ?? '').toLowerCase()
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select'
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && document.body.dataset.screen === 'chat') {
      event.preventDefault()
      void sendSiteMessage()
      return
    }
    if (event.key === '?' && !typing && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      go('help')
    }
  })
}

function bindCmdk() {
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      if ($('cmdk').hidden) openCmdk()
      else closeCmdk()
      return
    }
    if ($('cmdk').hidden) return
    if (event.key === 'Escape') {
      event.preventDefault()
      closeCmdk()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      cmdkActive = Math.min(cmdkActive + 1, cmdkItems.length - 1)
      renderCmdk()
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      cmdkActive = Math.max(cmdkActive - 1, 0)
      renderCmdk()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      runCmdk()
    }
  })
  $('cmdk-input').addEventListener('input', () => { cmdkActive = 0; renderCmdk() })
  $('cmdk').addEventListener('click', (event) => { if (event.target === $('cmdk')) closeCmdk() })
}

function openChatSearch() {
  const wrap = h('div')
  const input = h('input', 'input')
  input.placeholder = 'Найти в этом чате…'
  input.autocomplete = 'off'
  const results = h('div', 'search-results')
  results.append(h('p', 'hint', 'Введите минимум 2 символа.'))
  wrap.append(field('Поиск', input), results)
  let timer
  let seq = 0
  const run = async () => {
    const query = input.value.trim()
    if (query.length < 2) {
      results.replaceChildren(h('p', 'hint', 'Введите минимум 2 символа.'))
      return
    }
    const current = ++seq
    const chatId = state.chatTarget && state.chatTarget.id !== null && state.chatTarget.id !== undefined
      ? '&chatId=' + encodeURIComponent(state.chatTarget.id)
      : ''
    try {
      const data = await api('GET', '/api/chat/search?q=' + encodeURIComponent(query) + chatId)
      if (current !== seq) return
      const rows = Array.isArray(data.results) ? data.results : []
      results.replaceChildren()
      if (rows.length === 0) {
        results.append(h('p', 'hint', 'Ничего не найдено.'))
        return
      }
      rows.forEach((row) => {
        const item = h('div', 'plan-card')
        const body = h('div', 'plan-body')
        body.append(h('b', null, (row.author || (row.role === 'assistant' ? 'Ассистент' : 'Вы')) + (row.at ? ' · ' + formatDateTime(row.at) : '')))
        body.append(h('span', 'plan-meta', row.text))
        item.append(body)
        results.append(item)
      })
    } catch (error) {
      if (current === seq) results.replaceChildren(h('p', 'hint', error.message || 'Ошибка поиска'))
    }
  }
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 300) })
  openSheet({ title: 'Поиск в чате', body: wrap })
  setTimeout(() => input.focus(), 80)
}

function bind() {
  $('login-form').addEventListener('submit', login)

  document.querySelectorAll('[data-plans-view]').forEach((button) => {
    button.addEventListener('click', () => setPlansView(button.dataset.plansView))
  })
  $('plans-add').addEventListener('click', () => {
    if (state.plansView === 'calendar') openEventSheet()
    else openReminderSheet()
  })
  $('fab-add').addEventListener('click', () => {
    if (state.plansView === 'calendar') openEventSheet()
    else openReminderSheet()
  })
  document.querySelectorAll('[data-cal-view]').forEach((button) => {
    button.addEventListener('click', () => {
      state.calendar.view = button.dataset.calView
      document.querySelectorAll('[data-cal-view]').forEach((item) => item.classList.toggle('is-active', item === button))
      renderCalendar()
    })
  })
  $('cal-prev').addEventListener('click', () => {
    if (state.calendar.view === 'week') {
      const date = new Date(state.calendar.year, state.calendar.month, state.calendar.selected)
      date.setDate(date.getDate() - 7)
      state.calendar.year = date.getFullYear()
      state.calendar.month = date.getMonth()
      state.calendar.selected = date.getDate()
      renderCalendar()
      return
    }
    state.calendar.month -= 1
    if (state.calendar.month < 0) {
      state.calendar.month = 11
      state.calendar.year -= 1
    }
    state.calendar.selected = 1
    renderCalendar()
  })
  $('cal-next').addEventListener('click', () => {
    if (state.calendar.view === 'week') {
      const date = new Date(state.calendar.year, state.calendar.month, state.calendar.selected)
      date.setDate(date.getDate() + 7)
      state.calendar.year = date.getFullYear()
      state.calendar.month = date.getMonth()
      state.calendar.selected = date.getDate()
      renderCalendar()
      return
    }
    state.calendar.month += 1
    if (state.calendar.month > 11) {
      state.calendar.month = 0
      state.calendar.year += 1
    }
    state.calendar.selected = 1
    renderCalendar()
  })

  $('chat-search').addEventListener('click', openChatSearch)
  $('chat-refresh').addEventListener('click', () => {
    state.loaded.chat = false
    void loadChat()
  })
  const chatInput = $('chat-input')
  chatInput.addEventListener('input', () => { updateChatSend(); updateMentionSuggestions() })
  chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void sendSiteMessage()
    }
  })
  $('chat-send').addEventListener('click', () => { $('mention-list').hidden = true; void sendSiteMessage() })
  $('chat-attach').addEventListener('click', () => $('chat-files').click())
  $('chat-mic').addEventListener('click', () => { if (voiceRecording) stopVoiceRecording(); else void startVoiceRecording() })
  $('recorder-send').addEventListener('click', stopVoiceRecording)
  $('recorder-cancel').addEventListener('click', cancelVoiceRecording)
  document.querySelectorAll('[data-files-tab]').forEach((button) => {
    button.addEventListener('click', () => switchFilesTab(button.dataset.filesTab))
  })
  document.querySelectorAll('[data-stats-days]').forEach((button) => {
    button.addEventListener('click', () => {
      state.statsDays = Number(button.dataset.statsDays) || 7
      document.querySelectorAll('[data-stats-days]').forEach((item) => item.classList.toggle('is-active', item === button))
      state.loaded.stats = false
      void loadStats()
    })
  })
  $('cal-subscribe').addEventListener('click', async () => {
    try {
      const data = await api('GET', '/api/calendar/link')
      await navigator.clipboard.writeText(data.url)
      toast('Ссылка скопирована — добавьте её в календарь как подписку')
    } catch (error) {
      toast(error.message || 'Не удалось получить ссылку')
    }
  })
  $('mail-refresh').addEventListener('click', () => { state.gmail = null; void loadGmail() })
  $('mail-search').addEventListener('input', (event) => {
    clearTimeout(mailSearchTimer)
    const value = event.target.value
    mailSearchTimer = setTimeout(() => void loadMailMessages(value), 350)
  })
  $('automation-add').addEventListener('click', () => openAutomationSheet())
  $('inbox-add').addEventListener('click', () => void addInbox())
  $('inbox-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void addInbox() } })
  $('files-search').addEventListener('input', (event) => {
    clearTimeout(filesSearchTimer)
    const value = event.target.value
    filesSearchTimer = setTimeout(() => void searchFiles(value), 300)
  })
  $('chat-files').addEventListener('change', (event) => {
    addPendingMedia(event.target.files)
    event.target.value = ''
  })
  updateChatSend()

  document.querySelectorAll('[data-agent-template]').forEach((button) => {
    button.addEventListener('click', () => openAgentTemplate(button.dataset.agentTemplate))
  })

  $('memory-search-toggle').addEventListener('click', () => {
    const row = $('memory-search')
    row.hidden = !row.hidden
    if (!row.hidden) $('memory-search-input').focus()
  })
  $('memory-search-input').addEventListener('input', (event) => {
    state.factQuery = event.target.value
    renderMemory()
  })
  $('fact-add').addEventListener('click', () => void addFact())
  $('fact-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void addFact()
    }
  })
  $('city-card').addEventListener('click', openCitySheet)

  document.querySelectorAll('[data-picker]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.picker === 'city') openCitySheet()
      else openSettingsPicker(button.dataset.picker)
    })
  })
  $('account-credentials').addEventListener('click', openCredentialsSheet)
  $('account-users').addEventListener('click', () => { void openUsersSheet() })
  $('revoke-sessions').addEventListener('click', openRevokeAllSheet)
  $('totp-row').addEventListener('click', openTotpSheet)
  $('auth-log-row').addEventListener('click', openAuthLog)
  $('artifact-close').addEventListener('click', closeArtifact)
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('artifact').hidden) closeArtifact() })
  $('set-voice').addEventListener('click', () => {
    const next = !$('set-voice').classList.contains('is-on')
    $('set-voice').classList.toggle('is-on', next)
    void patchSettings({ voice: next }, next ? 'Голосовые ответы включены' : 'Голосовые ответы выключены')
  })

  document.querySelectorAll('[data-theme-mode]').forEach((button) => {
    button.addEventListener('click', () => setThemeMode(button.dataset.themeMode))
  })
  const largeTextSwitch = $('set-large-text')
  const largeTextOn = store.get(LARGE_TEXT_KEY) === '1'
  largeTextSwitch.classList.toggle('is-on', largeTextOn)
  largeTextSwitch.addEventListener('click', () => {
    const next = !largeTextSwitch.classList.contains('is-on')
    store.set(LARGE_TEXT_KEY, next ? '1' : '0')
    applyLargeText(next)
  })

  $('proactive-toggle').addEventListener('click', () => {
    if (!state.proactive) return
    void patchProactive({ enabled: state.proactive.enabled !== true }, state.proactive.enabled ? 'Проактивность выключена' : 'Проактивность включена')
  })
  document.querySelectorAll('[data-proactive]').forEach((row) => {
    row.addEventListener('click', () => openProactivePicker(row.dataset.proactive))
  })
  document.querySelectorAll('[data-help-command]').forEach((row) => {
    row.addEventListener('click', () => {
      go('chat')
      const input = $('chat-input')
      input.value = row.dataset.helpCommand
      input.style.height = 'auto'
      updateChatSend()
      input.focus()
    })
  })

  $('push-toggle').addEventListener('click', () => {
    if ($('push-toggle').classList.contains('is-on')) void disablePush()
    else void enablePush()
  })
  $('push-install').addEventListener('click', showPushInstallSheet)
  $('push-test').addEventListener('click', () => void testPushNotification())
  $('reply-cancel').addEventListener('click', clearChatReply)

  $('logout-button').addEventListener('click', () => {
    confirmSheet('Выйти из аккаунта?', 'На этом устройстве придётся ввести пароль заново.', 'Выйти', () => void logout())
  })
  $('logout-row').addEventListener('click', () => {
    confirmSheet('Выйти из аккаунта?', 'На этом устройстве придётся ввести пароль заново.', 'Выйти', () => void logout())
  })

  bindCmdk()
  bindDesktopShortcuts()

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themeMode === 'auto') applyTheme()
  })
}

/* ============================ Старт ============================ */

applyTheme()
bind()
void boot()
