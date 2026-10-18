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
  chatReply: null,
  chatSending: false,
  chats: [],
  chatTarget: null,
  factQuery: '',
  plansView: 'reminders',
  calendar: { year: TODAY.getFullYear(), month: TODAY.getMonth(), selected: TODAY.getDate() },
  loaded: { plans: false, memory: false, settings: false, stats: false, chat: false },
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
  button.disabled = true
  $('login-error').hidden = true
  $('login-label').textContent = 'Проверяю…'
  try {
    await api('POST', '/api/auth/login', { username, password })
    const session = await api('GET', '/api/auth/session')
    showApp(session)
    toast('Вход выполнен')
  } catch (error) {
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
  state.chats.forEach((chat) => {
    const button = h('button', 'chip' + (String(chat.id) === String(state.chatTarget && state.chatTarget.id) ? ' is-active' : ''), chat.title)
    button.type = 'button'
    button.addEventListener('click', () => selectChat(chat))
    box.append(button)
  })
}

function updateChatHeader() {
  const group = state.chatTarget && state.chatTarget.type !== 'private'
  $('chat-input').placeholder = group ? 'В общий чат… (@бот или ответ)' : 'Написать ассистенту…'
}

function selectChat(chat) {
  if (String(chat.id) === String(state.chatTarget && state.chatTarget.id)) return
  state.chatTarget = chat
  state.chat = null
  clearChatReply()
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
    && (item.avatar || '') === (right[index].avatar || ''))
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
  messages.forEach((message) => box.append(chatMessageNode(message.role, message.text, message.author, message.replyTo, message.avatar)))
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
  wrap.append(quote, reply, copy)
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

function chatMessageNode(role, text, author, replyTo, avatar) {
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
    bubble = h('div', 'bubble bubble-bot', text)
    if (otherAuthor) bubble.prepend(h('div', 'row-meta', author))
    stack.append(bubble)
    article.append(avatarBox, stack)
  } else {
    bubble = h('div', 'bubble bubble-user', text)
    article.append(bubble)
  }
  if (replyTo && replyTo.text) {
    const quote = h('div', 'reply-quote')
    quote.append(h('b', null, replyTo.author || (replyTo.role === 'assistant' ? 'Ассистент' : 'Вы')))
    quote.append(h('span', null, String(replyTo.text).slice(0, 300)))
    bubble.prepend(quote)
  }
  bindMessageGesture(bubble, { role, text, author })
  return article
}

function chatScrollToBottom() {
  const scroller = $('chat-scroll')
  if (scroller) scroller.scrollTop = scroller.scrollHeight
}

function appendChatMessage(role, text, author, replyTo) {
  const box = $('chat-messages')
  const empty = box.querySelector('.chat-empty')
  if (empty) empty.remove()
  box.append(chatMessageNode(role, text, author, replyTo))
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
  button.disabled = input.value.trim() === ''
  resizeChatInput()
}

async function sendSiteMessage() {
  const input = $('chat-input')
  const button = $('chat-send')
  const text = input.value.trim()
  if (text === '' || button.disabled) return
  const group = state.chatTarget && state.chatTarget.type !== 'private'
  const reply = state.chatReply
  appendChatMessage('user', text, group ? ((state.session && state.session.user && state.session.user.telegramName) || 'Вы') : undefined, reply)
  clearChatReply()
  input.value = ''
  input.style.height = 'auto'
  updateChatSend()
  button.disabled = true
  state.chatSending = true
  showChatTyping()
  try {
    const data = await api('POST', '/api/chat/message', {
      text,
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
      state.chat.messages.push({ role: 'user', text, ...(reply ? { replyTo: reply } : {}) })
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
  $('cal-day-title').textContent = selected + ' ' + MONTHS_GEN[month]
  const selectedItems = itemsByDay.get(dayKey(selectedDate)) || []
  $('cal-day-count').textContent = String(selectedItems.length)
  const dayList = $('cal-day-list')
  dayList.replaceChildren()
  if (selectedItems.length === 0) {
    dayList.append(h('p', 'empty-day', 'На этот день ничего нет.'))
  } else {
    selectedItems.forEach((item) => {
      dayList.append(planItemCard({
        title: item.title,
        meta: [item.time || 'весь день'],
        kind: item.kind
      }))
    })
  }
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
  if (facts.length === 0) {
    box.append(renderEmpty(query ? 'Ничего не нашлось' : 'Пока пусто', query ? 'Попробуйте другой запрос.' : 'Добавьте первый факт — бот учтёт его в личных ответах.'))
  }
  facts.forEach((fact) => {
    const card = h('article', 'fact-card')
    const body = h('div', 'fact-body')
    body.append(h('div', 'fact-text', fact.text))
    const meta = h('div', 'fact-meta')
    meta.append(icon('book'), h('span', null, 'личный факт'))
    body.append(meta)
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
    card.append(body, remove)
    box.append(card)
  })
  $('facts-count').textContent = String(state.memory.facts.length)
  $('memory-city').textContent = state.memory.city || 'Город не задан'
  const count = state.memory.facts.length
  $('memory-sub').textContent = count + ' ' + plural(count, ['факт', 'факта', 'фактов'])
    + (state.memory.city ? ' · ' + state.memory.city : '')
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

async function patchSettings(patch, successMessage) {
  try {
    const settings = await api('PATCH', '/api/settings', patch)
    state.settings = settings
    state.loaded.settings = true
    renderSettings()
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
    const data = await api('GET', '/api/stats?days=7')
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

  const chartCard = h('div', 'card chart-card')
  const chartHead = h('div', 'card-head')
  chartHead.append(h('b', null, 'За 7 дней'), h('span', null, 'токены'))
  chartCard.append(chartHead)
  const chart = h('div', 'chart')
  const labels = h('div', 'chart-labels')
  const days = Array.isArray(stats.days) ? stats.days : []
  const max = Math.max(1, ...days.map((day) => day.total || 0))
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
  $('cal-prev').addEventListener('click', () => {
    state.calendar.month -= 1
    if (state.calendar.month < 0) {
      state.calendar.month = 11
      state.calendar.year -= 1
    }
    state.calendar.selected = 1
    renderCalendar()
  })
  $('cal-next').addEventListener('click', () => {
    state.calendar.month += 1
    if (state.calendar.month > 11) {
      state.calendar.month = 0
      state.calendar.year += 1
    }
    state.calendar.selected = 1
    renderCalendar()
  })

  $('chat-refresh').addEventListener('click', () => {
    state.loaded.chat = false
    void loadChat()
  })
  const chatInput = $('chat-input')
  chatInput.addEventListener('input', updateChatSend)
  chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void sendSiteMessage()
    }
  })
  $('chat-send').addEventListener('click', () => void sendSiteMessage())
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

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themeMode === 'auto') applyTheme()
  })
}

/* ============================ Старт ============================ */

applyTheme()
bind()
void boot()
