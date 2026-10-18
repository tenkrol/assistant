/**
 * Интерактивный макет мобильного пульта (PLB-026).
 *
 * Здесь нет сети и настоящих данных: все списки — демонстрационные, действия
 * показывают состояние и тосты. Задача файла — проверить навигацию, компоновку и
 * сценарии до написания production-кода.
 */

const $ = (id) => document.getElementById(id)

/** Короткий конструктор DOM: текст попадает только как текст, не как разметка. */
const h = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

const NS = 'http://www.w3.org/2000/svg'

/** Инлайн-иконка из спрайта в index.html. */
const icon = (name) => {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class', 'ic')
  const use = document.createElementNS(NS, 'use')
  use.setAttribute('href', '#i-' + name)
  svg.append(use)
  return svg
}

const plural = (n, forms) => {
  const tail = n % 100
  const last = n % 10
  if (last === 1 && tail !== 11) return forms[0]
  if (last >= 2 && last <= 4 && (tail < 10 || tail >= 20)) return forms[1]
  return forms[2]
}

/** Безопасное чтение localStorage: на file:// он может быть недоступен. */
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
      /* макет продолжает работать без сохранения */
    }
  }
}

const params = new URLSearchParams(window.location.search)
const TODAY = { year: 2026, month: 9, day: 18 }
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

/* ============================ Тема ============================ */

const THEME_KEY = 'plb025.theme'
const LARGE_TEXT_KEY = 'plb025.large-text'
let themeMode = params.get('theme') === 'light' || params.get('theme') === 'dark'
  ? params.get('theme')
  : (store.get(THEME_KEY) || 'dark')

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
  toast('Тема: ' + ({ auto: 'как в системе', dark: 'тёмная', light: 'светлая' })[mode])
}

/* ============================ Тост ============================ */

let toastTimer = null

function toast(message) {
  const node = $('toast')
  node.textContent = message
  node.classList.add('is-open')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => node.classList.remove('is-open'), 2600)
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

/** Один вариант выбора: строка с галочкой. */
function openPicker(title, options, activeIndex, onPick) {
  const wrap = h('div')
  options.forEach((label, index) => {
    const row = h('button', 'picker-row' + (index === activeIndex ? ' is-active' : ''))
    row.type = 'button'
    row.append(h('b', null, label))
    const check = icon('check')
    check.classList.add('check')
    row.append(check)
    row.addEventListener('click', () => {
      onPick(index, label)
      closeSheet()
    })
    wrap.append(row)
  })
  openSheet({ title, body: wrap })
}

/** Группа чипов-переключателей. */
function chipSelector(entries, selected, onChange) {
  const row = h('div', 'chip-row')
  const buttons = entries.map(([value, label]) => {
    const button = h('button', 'chip' + (value === selected ? ' is-active' : ''), label)
    button.type = 'button'
    button.dataset.value = value
    button.addEventListener('click', () => {
      buttons.forEach((item) => item.classList.toggle('is-active', item === button))
      onChange(value)
    })
    row.append(button)
    return button
  })
  return row
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
  auth: null,
  chat: 'chat',
  plans: 'plans',
  calendar: 'plans',
  memory: 'memory',
  agent: 'agent',
  files: 'more',
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
  const url = '#' + name
  if (options.push !== false) {
    try {
      history.pushState({ screen: name }, '', url)
    } catch {
      location.hash = name
    }
  }
  const active = screens.get(name)
  if (active) {
    const scroller = active.querySelector('.chat-scroll, .screen-scroll')
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
  if (backNode) {
    go(backNode.dataset.back)
  }
})

window.addEventListener('popstate', (event) => {
  const name = (event.state && event.state.screen) || (location.hash ? location.hash.slice(1) : 'chat')
  go(screens.has(name) ? name : 'chat', { push: false })
})

/* ============================ Планы ============================ */

let reminderSeq = 100
let reminders = [
  { id: 1, group: 'today', kind: 'reminder', title: 'Позвонить в клинику', time: '09:00', repeat: 'разово', done: false },
  { id: 2, group: 'today', kind: 'reminder', title: 'Купить продукты', time: '19:30', repeat: 'каждый день', done: false },
  { id: 3, group: 'tomorrow', kind: 'reminder', title: 'Зарядка', time: '09:00', repeat: 'по будням', done: false },
  { id: 4, group: 'tomorrow', kind: 'event', title: 'Ужин с Машей', time: '18:00', repeat: '', done: false },
  { id: 5, group: 'later', kind: 'reminder', title: 'Продлить подписку', time: '25 окт, 10:00', repeat: 'разово', done: false },
  { id: 6, group: 'later', kind: 'event', title: 'День рождения Маши', time: '24 окт', repeat: 'каждый год', done: false }
]

const PLAN_GROUPS = [
  { key: 'today', label: 'Сегодня · 18 октября' },
  { key: 'tomorrow', label: 'Завтра · 19 октября' },
  { key: 'later', label: 'Позже' }
]

let plansView = 'reminders'

function planCard(item, options = {}) {
  const card = h('article', 'plan-card' + (item.done ? ' is-done' : ''))
  const iconBox = h('span', 'plan-ic' + (item.kind === 'event' ? ' event' : '') + (item.done ? ' done' : ''))
  iconBox.append(icon(item.kind === 'event' ? 'calendar' : (item.repeat && item.repeat !== 'разово' ? 'repeat' : 'bell')))
  const body = h('div', 'plan-body')
  body.append(h('div', 'plan-title', item.title))
  const meta = h('div', 'plan-meta')
  if (options.dateLabel) {
    meta.append(h('span', null, options.dateLabel))
    if (item.time) {
      const sep = h('span', 'dot-sep')
      meta.append(sep, h('span', null, item.time))
    }
  } else {
    meta.append(h('span', null, item.time))
    if (item.repeat) {
      meta.append(h('span', 'dot-sep'), h('span', null, item.repeat))
    }
  }
  body.append(meta)
  card.append(iconBox, body)
  if (!options.noCheck) {
    const check = h('button', 'plan-check')
    check.type = 'button'
    check.setAttribute('aria-label', item.done ? 'Снять отметку' : 'Отметить выполненным')
    check.append(icon('check'))
    check.addEventListener('click', (event) => {
      event.stopPropagation()
      item.done = !item.done
      renderPlans()
    })
    card.append(check)
  }
  if (!options.noOpen) {
    card.addEventListener('click', () => openReminderSheet(item))
  }
  return card
}

function renderPlans() {
  const list = $('plans-reminders')
  list.replaceChildren()
  PLAN_GROUPS.forEach((group) => {
    const items = reminders.filter((item) => item.group === group.key)
    if (items.length === 0) return
    const head = h('div', 'group-head')
    head.append(h('span', null, group.label), h('span', 'group-count', String(items.length)))
    list.append(head)
    items.forEach((item) => list.append(planCard(item)))
  })
  const countReminders = reminders.filter((item) => item.kind === 'reminder').length
  const countEvents = reminders.filter((item) => item.kind === 'event').length
  $('plans-sub').textContent =
    countReminders + ' ' + plural(countReminders, ['напоминание', 'напоминания', 'напоминаний']) +
    ' · ' + countEvents + ' ' + plural(countEvents, ['событие', 'события', 'событий'])
}

function setPlansView(view) {
  plansView = view
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

function repeatLabel(value) {
  return ({
    none: 'разово',
    daily: 'каждый день',
    weekdays: 'по будням',
    'weekly:1': 'каждый понедельник'
  })[value] || 'разово'
}

/** Время из выбранного варианта: группа и подпись для списка. */
function resolveWhen(value, custom) {
  if (value === 'hour') {
    const now = new Date()
    now.setMinutes(now.getMinutes() + 60)
    return {
      group: 'today',
      time: String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'),
      dateKey: TODAY.year + '-' + (TODAY.month + 1) + '-' + TODAY.day
    }
  }
  if (value === 'today20') {
    return { group: 'today', time: '20:00', dateKey: '2026-10-18' }
  }
  if (value === 'tomorrow9') {
    return { group: 'tomorrow', time: '09:00', dateKey: '2026-10-19' }
  }
  if (custom) {
    const date = new Date(custom)
    if (!Number.isNaN(date.getTime())) {
      const key = date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate()
      const isToday = key === '2026-10-18'
      const isTomorrow = key === '2026-10-19'
      return {
        group: isToday ? 'today' : isTomorrow ? 'tomorrow' : 'later',
        time: date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
        dateKey: key
      }
    }
  }
  return { group: 'tomorrow', time: '09:00', dateKey: '2026-10-19' }
}

function openReminderSheet(item) {
  const editing = Boolean(item)
  const wrap = h('div')
  const input = h('input', 'input')
  input.placeholder = 'Например, позвонить в клинику'
  input.value = editing ? item.title : ''
  wrap.append(field('Что напомнить', input))

  let whenValue = 'tomorrow9'
  let customWhen = ''
  const whenField = h('div', 'field')
  whenField.append(h('span', null, 'Когда'))
  whenField.append(chipSelector([
    ['hour', 'Через час'],
    ['today20', 'Сегодня 20:00'],
    ['tomorrow9', 'Завтра 9:00'],
    ['custom', 'Выбрать…']
  ], whenValue, (value) => { whenValue = value; customInput.hidden = value !== 'custom' }))
  const customInput = h('input', 'input')
  customInput.type = 'datetime-local'
  customInput.hidden = true
  customInput.style.marginTop = '10px'
  customInput.addEventListener('change', () => { customWhen = customInput.value })
  whenField.append(customInput)
  wrap.append(whenField)

  let repeatValue = 'none'
  const repeatField = h('div', 'field')
  repeatField.append(h('span', null, 'Повтор'))
  repeatField.append(chipSelector([
    ['none', 'Разово'],
    ['daily', 'Каждый день'],
    ['weekdays', 'По будням'],
    ['weekly:1', 'По понедельникам']
  ], repeatValue, (value) => { repeatValue = value }))
  wrap.append(repeatField)

  const quiet = h('div', 'switch-row')
  const quietText = h('div')
  quietText.append(h('b', null, 'Тихие часы'), h('span', null, 'Не будить с 23:00 до 08:00'))
  const quietSwitch = h('button', 'switch is-on')
  quietSwitch.type = 'button'
  quietSwitch.setAttribute('aria-label', 'Тихие часы')
  quietSwitch.addEventListener('click', () => quietSwitch.classList.toggle('is-on'))
  quiet.append(quietText, quietSwitch)
  wrap.append(quiet)

  const submit = h('button', 'btn btn-primary btn-block', editing ? 'Сохранить напоминание' : 'Добавить напоминание')
  submit.type = 'button'
  submit.addEventListener('click', () => {
    const text = input.value.trim()
    if (!text) {
      toast('Введите текст напоминания')
      input.focus()
      return
    }
    const when = resolveWhen(whenValue, customWhen)
    if (editing) {
      item.title = text
      item.group = when.group
      item.time = when.time
      item.repeat = repeatLabel(repeatValue)
      toast('Напоминание обновлено')
    } else {
      reminders.unshift({
        id: ++reminderSeq,
        group: when.group,
        kind: 'reminder',
        title: text,
        time: when.time,
        repeat: repeatLabel(repeatValue),
        done: false
      })
      addCalendarItem(when.dateKey, { kind: 'reminder', time: when.time, title: text })
      toast('Напоминание добавлено — бот пришлёт его в срок')
    }
    renderPlans()
    renderCalendar()
    closeSheet()
  })
  wrap.append(submit)

  if (editing) {
    const remove = h('button', 'btn btn-danger-ghost btn-block', 'Удалить напоминание')
    remove.type = 'button'
    remove.style.marginTop = '8px'
    remove.addEventListener('click', () => {
      reminders = reminders.filter((entry) => entry !== item)
      renderPlans()
      closeSheet()
      toast('Напоминание удалено')
    })
    wrap.append(remove)
  }
  wrap.append(h('p', 'sheet-note', 'Время — по Москве. В тихие часы бот перенесёт напоминание на утро.'))

  openSheet({ title: editing ? 'Напоминание' : 'Новое напоминание', body: wrap })
}

function openEventSheet() {
  const wrap = h('div')
  const input = h('input', 'input')
  input.placeholder = 'Например, день рождения Маши'
  wrap.append(field('Название события', input))

  let whenValue = 'tomorrow'
  let customWhen = ''
  const whenField = h('div', 'field')
  whenField.append(h('span', null, 'Дата'))
  const whenRow = chipSelector([
    ['today', 'Сегодня'],
    ['tomorrow', 'Завтра'],
    ['oct24', '24 октября'],
    ['custom', 'Выбрать…']
  ], whenValue, (value) => { whenValue = value; customInput.hidden = value !== 'custom' })
  whenField.append(whenRow)
  const customInput = h('input', 'input')
  customInput.type = 'date'
  customInput.hidden = true
  customInput.style.marginTop = '10px'
  customInput.addEventListener('change', () => { customWhen = customInput.value })
  whenField.append(customInput)
  wrap.append(whenField)

  let yearly = false
  const yearlyRow = h('label', 'switch-row')
  const yearlyText = h('div')
  yearlyText.append(h('b', null, 'Каждый год'), h('span', null, 'повторять событие ежегодно'))
  const yearlySwitch = h('button', 'switch')
  yearlySwitch.type = 'button'
  yearlySwitch.setAttribute('aria-label', 'Каждый год')
  yearlySwitch.addEventListener('click', () => {
    yearly = !yearly
    yearlySwitch.classList.toggle('is-on', yearly)
  })
  yearlyRow.append(yearlyText, yearlySwitch)
  wrap.append(yearlyRow)

  const submit = h('button', 'btn btn-primary btn-block', 'Добавить событие')
  submit.type = 'button'
  submit.addEventListener('click', () => {
    const text = input.value.trim()
    if (!text) {
      toast('Введите название события')
      input.focus()
      return
    }
    let group = 'tomorrow'
    let time = ''
    let dateKey = '2026-10-19'
    if (whenValue === 'today') {
      group = 'today'
      dateKey = '2026-10-18'
    } else if (whenValue === 'oct24') {
      group = 'later'
      time = '24 окт'
      dateKey = '2026-10-24'
    } else if (whenValue === 'custom' && customWhen) {
      const date = new Date(customWhen)
      if (!Number.isNaN(date.getTime())) {
        group = 'later'
        time = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
        dateKey = date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate()
      }
    }
    reminders.push({
      id: ++reminderSeq,
      group,
      kind: 'event',
      title: text,
      time,
      repeat: yearly ? 'каждый год' : '',
      done: false
    })
    addCalendarItem(dateKey, { kind: 'event', time, title: text })
    renderPlans()
    renderCalendar()
    closeSheet()
    toast('Событие добавлено в календарь')
  })
  wrap.append(submit)
  wrap.append(h('p', 'sheet-note', 'Событие появится в календаре и в утреннем дайджесте в этот день.'))
  openSheet({ title: 'Новое событие', body: wrap })
}

/* ============================ Календарь ============================ */

const calState = { year: TODAY.year, month: TODAY.month, selected: TODAY.day }

const calendarItems = {
  '2026-10-18': [
    { kind: 'reminder', time: '09:00', title: 'Позвонить в клинику' },
    { kind: 'reminder', time: '19:30', title: 'Купить продукты' }
  ],
  '2026-10-19': [
    { kind: 'event', time: '18:00', title: 'Ужин с Машей' }
  ],
  '2026-10-24': [
    { kind: 'event', time: '', title: 'День рождения Маши' }
  ],
  '2026-10-25': [
    { kind: 'reminder', time: '10:00', title: 'Продлить подписку' }
  ]
}

function addCalendarItem(dateKey, item) {
  if (!dateKey) return
  if (!calendarItems[dateKey]) calendarItems[dateKey] = []
  calendarItems[dateKey].push(item)
}

function dayKey(year, month, day) {
  return year + '-' + (month + 1) + '-' + day
}

function renderCalendar() {
  const grid = $('cal-grid')
  if (!grid) return
  grid.replaceChildren()
  const first = new Date(calState.year, calState.month, 1)
  const startOffset = (first.getDay() + 6) % 7
  const daysInMonth = new Date(calState.year, calState.month + 1, 0).getDate()
  const prevDays = new Date(calState.year, calState.month, 0).getDate()
  const cells = 42

  for (let index = 0; index < cells; index += 1) {
    const dayNumber = index - startOffset + 1
    let year = calState.year
    let month = calState.month
    let day = dayNumber
    let out = false
    if (dayNumber < 1) {
      out = true
      month -= 1
      if (month < 0) {
        month = 11
        year -= 1
      }
      day = prevDays + dayNumber
    } else if (dayNumber > daysInMonth) {
      out = true
      month += 1
      if (month > 11) {
        month = 0
        year += 1
      }
      day = dayNumber - daysInMonth
    }

    const cell = h('button', 'cal-day' + (out ? ' out' : ''))
    cell.type = 'button'
    cell.textContent = String(day)
    cell.setAttribute('aria-label', day + ' ' + MONTHS_GEN[month])
    const key = dayKey(year, month, day)
    const items = calendarItems[key] || []
    if (items.length) {
      const dots = h('span', 'cal-dots')
      const kinds = new Set(items.map((entry) => entry.kind))
      kinds.forEach((kind) => dots.append(h('i', kind === 'event' ? 'event' : '')))
      cell.append(dots)
    }
    const isToday = year === TODAY.year && month === TODAY.month && day === TODAY.day
    if (isToday) cell.classList.add('today')
    if (!out && year === calState.year && month === calState.month && day === calState.selected) {
      cell.classList.add('is-selected')
    }
    if (out) cell.classList.add('out')
    cell.addEventListener('click', () => {
      calState.year = year
      calState.month = month
      calState.selected = day
      renderCalendar()
    })
    grid.append(cell)
  }

  $('cal-month').textContent = MONTHS[calState.month] + ' ' + calState.year
  const selectedDate = new Date(calState.year, calState.month, calState.selected)
  $('cal-selected-label').textContent =
    calState.selected + ' ' + MONTHS_GEN[calState.month] + ', ' + WEEKDAYS_FULL[selectedDate.getDay()]

  const key = dayKey(calState.year, calState.month, calState.selected)
  const items = calendarItems[key] || []
  const title = calState.selected + ' ' + MONTHS_GEN[calState.month]
  $('cal-day-title').textContent = title
  $('cal-day-count').textContent = String(items.length)
  const dayList = $('cal-day-list')
  dayList.replaceChildren()
  if (items.length === 0) {
    dayList.append(h('p', 'empty-day', 'На этот день ничего нет. Самое время добавить событие.'))
  } else {
    items.forEach((item) => dayList.append(planCard({
      title: item.title,
      time: item.time,
      repeat: '',
      kind: item.kind,
      done: false
    }, { noCheck: true, noOpen: true, dateLabel: title })))
  }

  const upcoming = []
  Object.keys(calendarItems).sort().forEach((dateKey) => {
    calendarItems[dateKey].forEach((item) => {
      if (item.kind !== 'event') return
      if (dateKey < dayKey(TODAY.year, TODAY.month, TODAY.day)) return
      const [year, month, day] = dateKey.split('-').map(Number)
      upcoming.push({
        ...item,
        label: day + ' ' + MONTHS_GEN[month - 1] + (year !== TODAY.year ? ' ' + year : '')
      })
    })
  })
  const upcomingBox = $('cal-upcoming')
  upcomingBox.replaceChildren()
  upcoming.slice(0, 3).forEach((item) => {
    upcomingBox.append(planCard({
      title: item.title,
      time: item.time,
      repeat: '',
      kind: 'event',
      done: false
    }, { noCheck: true, noOpen: true, dateLabel: item.label }))
  })
}

/* ============================ Память ============================ */

let city = 'Москва'
let factSeq = 100
let facts = [
  { id: 1, text: 'Зовут Вячеслав', source: 'из чата · 12 окт' },
  { id: 2, text: 'Любит крепкий кофе без сахара', source: 'из чата · 10 окт' },
  { id: 3, text: 'Работает над домашним ассистентом', source: 'из чата · 8 окт' },
  { id: 4, text: 'Не любит звонки раньше 10:00', source: 'из чата · 6 окт' },
  { id: 5, text: 'Предпочитает краткие ответы', source: 'из чата · 4 окт' },
  { id: 6, text: 'День рождения — 12 апреля', source: 'добавлено вручную · 1 окт' },
  { id: 7, text: 'Готовит отчёт по дому в конце месяца', source: 'из чата · 28 сен' }
]

let factQuery = ''

function renderFacts() {
  const list = $('facts-list')
  list.replaceChildren()
  const query = factQuery.trim().toLowerCase()
  const visible = facts.filter((item) => !query || item.text.toLowerCase().includes(query))
  if (visible.length === 0) {
    list.append(h('p', 'empty-day', query ? 'Ничего не нашлось.' : 'Пока пусто. Добавьте первый факт.'))
  }
  visible.forEach((item) => {
    const card = h('article', 'fact-card')
    const body = h('div', 'fact-body')
    body.append(h('div', 'fact-text', item.text))
    const meta = h('div', 'fact-meta')
    meta.append(icon('chat'), h('span', null, item.source))
    body.append(meta)
    const menu = h('button', 'icon-btn sm')
    menu.type = 'button'
    menu.setAttribute('aria-label', 'Действия с фактом')
    menu.append(icon('more'))
    menu.addEventListener('click', () => {
      openPicker('Факт', ['Изменить', 'Удалить'], -1, (index) => {
        if (index === 1) {
          facts = facts.filter((entry) => entry !== item)
          renderFacts()
          toast('Факт удалён — бот больше не будет его использовать')
        } else {
          openFactSheet(item)
        }
      })
    })
    card.append(body, menu)
    list.append(card)
  })
  $('facts-count').textContent = String(facts.length)
  $('memory-sub').textContent = facts.length + ' ' + plural(facts.length, ['факт', 'факта', 'фактов']) + ' · город ' + city
}

function openFactSheet(item) {
  const editing = Boolean(item)
  const wrap = h('div')
  const input = h('input', 'input')
  input.placeholder = 'Например, любит крепкий кофе'
  input.value = editing ? item.text : ''
  wrap.append(field('Что запомнить', input))
  const submit = h('button', 'btn btn-primary btn-block', editing ? 'Сохранить факт' : 'Запомнить')
  submit.type = 'button'
  submit.addEventListener('click', () => {
    const text = input.value.trim()
    if (!text) {
      toast('Введите текст факта')
      input.focus()
      return
    }
    if (editing) {
      item.text = text
      toast('Факт обновлён')
    } else {
      facts.unshift({ id: ++factSeq, text, source: 'добавлено вручную · только что' })
      toast('Запомнил — бот учтёт это в личных ответах')
    }
    renderFacts()
    closeSheet()
  })
  wrap.append(submit)
  wrap.append(h('p', 'sheet-note', 'Факт виден только вам. В группах личные факты не используются.'))
  openSheet({ title: editing ? 'Факт' : 'Новый факт', body: wrap })
}

function openCitySheet() {
  const cities = ['Москва', 'Санкт-Петербург', 'Казань', 'Сочи', 'Другой город…']
  openPicker('Город', cities, cities.indexOf(city), (index, value) => {
    if (value === 'Другой город…') {
      toast('В боте: /city <город>')
      return
    }
    city = value
    const card = document.querySelector('.city-card')
    if (card) {
      const title = card.querySelector('b')
      if (title) title.textContent = city
    }
    renderFacts()
    toast('Город для погоды и дайджеста: ' + city)
  })
}

/* ============================ Агент ============================ */

let taskSeq = 100
let activeTasks = [
  {
    id: 1,
    title: 'Собрать отчёт по расходам за сентябрь',
    meta: 'запущена 12:40 · ~2 мин',
    progress: 62
  }
]
let doneTasks = [
  { id: 11, title: 'Перевести статью про память', meta: 'готово сегодня, 11:20 · 8 мин' },
  { id: 12, title: 'Проверить сайт tenkrol.ru', meta: 'готово вчера, 18:05 · 2 мин' },
  { id: 13, title: 'Собрать список покупок', meta: 'готово 16 окт · 4 мин' }
]

function taskIconState(progress) {
  const steps = [
    { label: 'Принял задачу и проверил доступ', done: true, current: false },
    { label: 'Работает в песочнице', done: progress > 70, current: progress <= 70 },
    { label: 'Соберёт результат и пришлёт в чат', done: progress >= 100, current: progress > 70 && progress < 100 }
  ]
  return steps
}

function renderAgent() {
  const activeBox = $('tasks-active')
  activeBox.replaceChildren()
  if (activeTasks.length === 0) {
    const empty = h('div', 'card')
    empty.style.padding = '16px'
    empty.style.textAlign = 'center'
    empty.style.color = 'var(--muted)'
    empty.style.fontSize = '13px'
    empty.textContent = 'Сейчас в работе ничего нет. Поставьте задачу выше.'
    activeBox.append(empty)
  }
  activeTasks.forEach((task) => {
    const card = h('article', 'task-card is-active')
    const head = h('div', 'task-head')
    const ic = h('span', 'task-ic')
    ic.append(icon('spark'))
    const text = h('div')
    text.append(h('b', null, task.title), h('span', null, task.meta))
    const menu = h('button', 'icon-btn sm')
    menu.type = 'button'
    menu.setAttribute('aria-label', 'Задача агента')
    menu.append(icon('more'))
    menu.addEventListener('click', () => {
      openPicker('Задача', ['Открыть в чате', 'Остановить'], -1, (index) => {
        if (index === 0) go('chat')
        else {
          activeTasks = activeTasks.filter((entry) => entry !== task)
          renderAgent()
          toast('Задача остановлена')
        }
      })
    })
    head.append(ic, text, menu)
    card.append(head)
    const progress = h('div', 'progress')
    const bar = h('span')
    bar.style.width = task.progress + '%'
    bar.dataset.taskProgress = String(task.id)
    progress.append(bar)
    card.append(progress)
    const steps = h('ol', 'steps')
    taskIconState(task.progress).forEach((step) => {
      const item = h('li', step.done ? 'done' : step.current ? 'current' : '')
      item.append(h('i'), h('span', null, step.label))
      steps.append(item)
    })
    card.append(steps)
    const foot = h('div', 'task-foot')
    foot.append(h('span', null, 'осталось ~2 мин'))
    const cancel = h('button', 'link', 'Отменить')
    cancel.type = 'button'
    cancel.addEventListener('click', () => {
      activeTasks = activeTasks.filter((entry) => entry !== task)
      renderAgent()
      toast('Задача отменена')
    })
    foot.append(cancel)
    card.append(foot)
    activeBox.append(card)
  })

  const doneBox = $('tasks-done')
  doneBox.replaceChildren()
  doneTasks.forEach((task) => {
    const card = h('article', 'task-card')
    const head = h('div', 'task-head')
    const ic = h('span', 'task-ic done')
    ic.append(icon('check'))
    const text = h('div')
    text.append(h('b', null, task.title), h('span', null, task.meta))
    head.append(ic, text)
    card.append(head)
    const actions = h('div', 'done-actions')
    const open = h('button', 'pill-btn', 'Открыть в чате')
    open.type = 'button'
    open.addEventListener('click', () => go('chat'))
    const download = h('button', 'pill-btn', 'Скачать')
    download.type = 'button'
    download.addEventListener('click', () => go('files'))
    actions.append(open, download)
    card.append(actions)
    doneBox.append(card)
  })

  $('tasks-active-count').textContent = String(activeTasks.length)
  $('tasks-done-count').textContent = String(doneTasks.length)
}

function startTask(title) {
  const task = {
    id: ++taskSeq,
    title,
    meta: 'запущена только что · ~3 мин',
    progress: 0
  }
  activeTasks.unshift(task)
  renderAgent()
  toast('Задача отправлена агенту')
  const timer = setInterval(() => {
    const current = activeTasks.find((entry) => entry.id === task.id)
    if (!current) {
      clearInterval(timer)
      return
    }
    current.progress = Math.min(100, current.progress + 8)
    const bar = document.querySelector('[data-task-progress="' + task.id + '"]')
    if (bar) bar.style.width = current.progress + '%'
    if (current.progress >= 100) {
      clearInterval(timer)
      activeTasks = activeTasks.filter((entry) => entry.id !== task.id)
      doneTasks.unshift({ id: task.id, title, meta: 'готово только что · 1 мин' })
      renderAgent()
      toast('Агент закончил — результат в чате и в файлах')
      appendBotMessage([
        h('div', 'bubble bubble-bot', 'Агент закончил задачу «' + title + '». Результат прикрепил в «Файлы».')
      ])
    }
  }, 400)
}

/* ============================ Файлы ============================ */

const files = [
  { type: 'xlsx', name: 'Расходы за сентябрь.xlsx', meta: '24 КБ · сегодня, 11:20' },
  { type: 'docx', name: 'Письмо клинике.docx', meta: '12 КБ · вчера, 16:40' },
  { type: 'pdf', name: 'Отчёт по дому.pdf', meta: '366 КБ · 15 октября' },
  { type: 'csv', name: 'Напоминания.csv', meta: '4 КБ · 12 октября' }
]

let fileFilter = 'all'
let fileQuery = ''

function renderFiles() {
  const list = $('files-list')
  list.replaceChildren()
  const query = fileQuery.trim().toLowerCase()
  const visible = files.filter((file) => {
    if (fileFilter !== 'all' && file.type !== fileFilter) return false
    if (query && !file.name.toLowerCase().includes(query)) return false
    return true
  })
  if (visible.length === 0) {
    list.append(h('p', 'empty-day', 'Файлов с такими условиями нет.'))
    return
  }
  visible.forEach((file) => {
    const card = h('button', 'file-card')
    card.type = 'button'
    const badge = h('span', 'file-badge ' + file.type, file.type.toUpperCase())
    const body = h('span', 'file-body')
    body.append(h('b', null, file.name), h('span', null, file.meta))
    const download = h('span', 'icon-btn sm')
    download.append(icon('download'))
    card.append(badge, body, download)
    card.addEventListener('click', () => toast('Демо: «' + file.name + '» скачивается на телефоне'))
    list.append(card)
  })
}

/* ============================ Чат ============================ */

const chatScroll = $('chat-scroll')
const chatInput = $('chat-input')
const sendButton = $('send-btn')
const micButton = $('mic-btn')
const quickRow = $('quick-row')
const typing = $('typing')
const composer = $('composer')
const recorder = $('recorder')

function scrollChat() {
  chatScroll.scrollTop = chatScroll.scrollHeight
}

function updateComposer() {
  const hasText = chatInput.value.trim().length > 0
  sendButton.hidden = !hasText
  micButton.hidden = hasText
}

function addMessage(node) {
  chatScroll.insertBefore(node, quickRow)
  scrollChat()
}

function userMessage(text) {
  const article = h('article', 'msg msg-user')
  article.append(h('div', 'bubble bubble-user', text))
  addMessage(article)
}

function appendBotMessage(nodes, options = {}) {
  const article = h('article', 'msg msg-bot')
  const avatar = h('div', 'msg-avatar')
  avatar.append(icon('spark'))
  const stack = h('div', 'msg-stack')
  nodes.forEach((node) => stack.append(node))
  article.append(avatar, stack)
  if (options.beforeTyping) chatScroll.insertBefore(article, typing)
  else addMessage(article)
}

function reminderChatCard(title, meta) {
  const card = h('div', 'result-card')
  const head = h('div', 'result-head')
  const ic = h('span', 'result-ic')
  ic.append(icon('bell'))
  const text = h('div')
  text.append(h('b', null, title), h('span', null, meta))
  head.append(ic, text)
  card.append(head)
  const actions = h('div', 'result-actions')
  const snooze = h('button', 'pill-btn', 'Отложить')
  snooze.type = 'button'
  snooze.addEventListener('click', () => toast('Отложил на 10 минут — напомню в 9:10'))
  const cancel = h('button', 'pill-btn danger', 'Отменить')
  cancel.type = 'button'
  cancel.addEventListener('click', () => {
    toast('Напоминание отменено')
    snooze.disabled = true
    cancel.disabled = true
    cancel.textContent = 'Отменено'
  })
  actions.append(snooze, cancel)
  card.append(actions)
  return card
}

function showTyping() {
  typing.hidden = false
  scrollChat()
}

function hideTyping() {
  typing.hidden = true
}

function answer(text) {
  const lower = text.toLowerCase()
  if (lower.includes('погод')) {
    appendBotMessage([
      h('div', 'bubble bubble-bot', 'В Москве сейчас +12°, днём до +16°. После 15:00 — дождь, лучше взять зонт.'),
      reminderChatCard('Погодное предупреждение', 'дождь после 15:00 · включено в дайджест')
    ])
    return
  }
  if (lower.includes('дайджест') || lower.includes('сводк')) {
    appendBotMessage([
      h('div', 'bubble bubble-bot', 'Утренний дайджест: +12°, дождь после 15:00; 24 октября — день рождения Маши; сегодня два напоминания — клиника в 9:00 и продукты в 19:30.')
    ])
    return
  }
  if (lower.includes('напомн')) {
    const extra = {
      id: ++reminderSeq,
      group: 'tomorrow',
      kind: 'reminder',
      title: 'Позвонить в клинику',
      time: '09:00',
      repeat: 'разово',
      done: false
    }
    reminders.unshift(extra)
    renderPlans()
    appendBotMessage([
      h('div', 'bubble bubble-bot', 'Готово — напомню завтра в 9:00.'),
      reminderChatCard('Позвонить в клинику', 'завтра, 9:00 · разово')
    ])
    return
  }
  if (lower.includes('файл')) {
    appendBotMessage([
      h('div', 'bubble bubble-bot', 'Могу разобрать PDF, DOCX, XLSX, PPTX, CSV, JSON, TXT и MD. Пришлите файл — прочитаю и отвечу по содержимому.')
    ])
    return
  }
  appendBotMessage([
    h('div', 'bubble bubble-bot', 'Записал. Могу помочь с планами, памятью, файлами и задачами агента — просто скажите словами.')
  ])
}

function sendChat() {
  const text = chatInput.value.trim()
  if (!text) return
  userMessage(text)
  chatInput.value = ''
  updateComposer()
  showTyping()
  setTimeout(() => {
    hideTyping()
    answer(text)
  }, 850)
}

let recordingTimer = null
let recordingSeconds = 0

function startRecording() {
  recorder.hidden = false
  composer.hidden = true
  recordingSeconds = 0
  $('rec-time').textContent = '0:00'
  const wave = $('rec-wave')
  wave.replaceChildren()
  for (let index = 0; index < 22; index += 1) {
    const bar = h('i')
    bar.style.animationDelay = (index % 7) * 0.08 + 's'
    wave.append(bar)
  }
  if (recordingTimer) clearInterval(recordingTimer)
  recordingTimer = setInterval(() => {
    recordingSeconds += 1
    const minutes = Math.floor(recordingSeconds / 60)
    const seconds = recordingSeconds % 60
    $('rec-time').textContent = minutes + ':' + String(seconds).padStart(2, '0')
  }, 1000)
}

function stopRecording(send) {
  if (recordingTimer) clearInterval(recordingTimer)
  recordingTimer = null
  composer.hidden = false
  recorder.hidden = true
  if (!send) return
  const minutes = Math.floor(recordingSeconds / 60)
  const seconds = recordingSeconds % 60
  const duration = minutes + ':' + String(seconds).padStart(2, '0')
  const article = h('article', 'msg msg-user')
  const bubble = h('div', 'bubble bubble-user')
  bubble.style.display = 'flex'
  bubble.style.alignItems = 'center'
  bubble.style.gap = '8px'
  bubble.append(icon('mic'), h('span', null, 'Голосовое · ' + duration))
  article.append(bubble)
  addMessage(article)
  showTyping()
  setTimeout(() => {
    hideTyping()
    appendBotMessage([
      h('div', 'bubble bubble-bot', 'Расшифровал голосовое. Записал как обычную просьбу — отвечу в чате.')
    ])
  }, 900)
}

/* ============================ Настройки ============================ */

const settingsState = {
  character: 'Дружелюбный',
  mode: 'Кратко',
  model: 'deepseek-flash',
  language: 'Русский'
}

const PICKER_DEFS = {
  character: {
    title: 'Характер',
    options: ['Обычный', 'Дружелюбный', 'С юмором', 'Деловой', 'Заботливый', 'Наставник', 'Военный'],
    target: 'set-character'
  },
  mode: {
    title: 'Режим ответов',
    options: ['Кратко', 'Подробно', 'Код', 'Письмо', 'Просто', 'Сброс'],
    target: 'set-mode'
  },
  model: {
    title: 'Модель',
    options: ['deepseek-flash', 'deepseek-v4-pro'],
    target: 'set-model'
  },
  language: {
    title: 'Язык',
    options: ['Русский', 'English'],
    target: 'set-language'
  }
}

function openSettingPicker(key) {
  const def = PICKER_DEFS[key]
  const options = def.options
  const active = options.indexOf(settingsState[key])
  openPicker(def.title, options, active, (index, value) => {
    settingsState[key] = value
    const target = $(def.target)
    if (target) target.textContent = value
    if (key === 'language' && value === 'English') {
      toast('English появится после переноса словарей — сейчас макет русский')
      return
    }
    toast(def.title + ': ' + value + ' — применено к боту')
  })
}

/* ============================ Информационные шторки ============================ */

function openHelpSheet() {
  const wrap = h('div')
  const rows = [
    ['chat', 'Просто спросить', 'Погода, перевод, поиск, файлы — обычными словами.'],
    ['bell', 'Напоминания', '«Напомни завтра в 9:00 позвонить в клинику». Повторы и тихие часы.'],
    ['book', 'Память', '«Запомни, что…», город, предпочтения. Только личные чаты.'],
    ['cpu', 'Долгие задачи', 'Агент работает в песочнице и присылает результат в чат.'],
    ['file', 'Файлы', 'Excel, Word, PDF, CSV — бот соберёт и пришлёт документ.']
  ]
  rows.forEach(([iconName, title, text]) => {
    const row = h('div', 'list-row')
    const ic = h('span', 'row-ic')
    ic.append(icon(iconName))
    const body = h('span')
    body.append(h('b', null, title), h('span', null, text))
    body.style.display = 'flex'
    body.style.flexDirection = 'column'
    body.style.margin = '0'
    body.style.textAlign = 'left'
    row.append(ic, body)
    wrap.append(row)
  })
  wrap.append(h('p', 'sheet-note', 'Все команды доступны и в чате Telegram. Пульт просто делает их наглядными.'))
  openSheet({ title: 'Помощь', body: wrap })
}

function openAboutSheet() {
  const wrap = h('div')
  const rows = [
    ['⚡', 'Ассистент TenKrol', 'Пульт для домашнего бота: чат, планы, память, агент и файлы.'],
    ['🧩', 'Макет PLB-026', 'Статический прототип без сервера и зависимостей.'],
    ['🔒', 'Доступ', 'Только подтверждённый Telegram-аккаунт; данные на tenkrol.ru.'],
    ['🌍', 'Версия', '1.0 · русский и английский (после перевода)']
  ]
  rows.forEach(([emoji, title, text]) => {
    const row = h('div', 'list-row')
    const badge = h('span', 'row-ic', emoji)
    const body = h('span')
    body.append(h('b', null, title), h('span', null, text))
    body.style.display = 'flex'
    body.style.flexDirection = 'column'
    body.style.margin = '0'
    body.style.textAlign = 'left'
    row.append(badge, body)
    wrap.append(row)
  })
  openSheet({ title: 'О приложении', body: wrap })
}

function openInviteSheet() {
  const wrap = h('div')
  wrap.append(h('p', 'sheet-note', 'Маша получит доступ к проекту «Дом» после того, как примет приглашение в Telegram. Код действует 7 дней.'))
  const code = h('div', 'stat-hero')
  code.style.marginTop = '10px'
  code.style.textAlign = 'center'
  const label = h('span', 'stat-label', 'Код приглашения')
  const value = h('div', 'stat-value', 'K7M-42Q')
  value.style.fontSize = '32px'
  value.style.letterSpacing = '0.08em'
  code.append(label, value)
  wrap.append(code)
  const copy = h('button', 'btn btn-primary btn-block', 'Скопировать код')
  copy.type = 'button'
  copy.addEventListener('click', () => toast('Код K7M-42Q скопирован'))
  wrap.append(copy)
  wrap.append(h('p', 'sheet-note', 'Приглашение привязано к аккаунту получателя: пересылка кода не даёт доступа.'))
  openSheet({ title: 'Приглашение', body: wrap })
}

function openProjectsSheet() {
  const wrap = h('div')
  const rows = [
    ['Дом', 'владелец · доступ у Маши'],
    ['Работа', 'владелец · только вы']
  ]
  rows.forEach(([title, meta]) => {
    const row = h('button', 'list-row')
    row.type = 'button'
    const ic = h('span', 'row-ic')
    ic.append(icon('folder'))
    const body = h('span')
    body.append(h('b', null, title), h('span', null, meta))
    body.style.display = 'flex'
    body.style.flexDirection = 'column'
    body.style.margin = '0'
    body.style.textAlign = 'left'
    row.append(ic, body)
    row.addEventListener('click', () => toast('Проект «' + title + '» — управление откроется в боте'))
    wrap.append(row)
  })
  const invite = h('button', 'btn btn-ghost btn-block', 'Пригласить в проект')
  invite.type = 'button'
  invite.style.marginTop = '8px'
  invite.addEventListener('click', openInviteSheet)
  wrap.append(invite)
  openSheet({ title: 'Проекты', body: wrap })
}

function openSessionsSheet() {
  const wrap = h('div')
  const rows = [
    ['Этот телефон', 'активен сейчас · Москва'],
    ['MacBook', 'последний вход вчера · Москва']
  ]
  rows.forEach(([title, meta]) => {
    const row = h('div', 'list-row')
    const ic = h('span', 'row-ic')
    ic.append(icon('device'))
    const body = h('span')
    body.append(h('b', null, title), h('span', null, meta))
    body.style.display = 'flex'
    body.style.flexDirection = 'column'
    body.style.margin = '0'
    body.style.textAlign = 'left'
    row.append(ic, body)
    wrap.append(row)
  })
  const close = h('button', 'btn btn-danger-ghost btn-block', 'Завершить другие сеансы')
  close.type = 'button'
  close.style.marginTop = '8px'
  close.addEventListener('click', () => toast('Другие сеансы завершены'))
  wrap.append(close)
  openSheet({ title: 'Устройства и сеансы', body: wrap })
}

function openLogoutSheet() {
  const wrap = h('div')
  wrap.append(h('p', 'sheet-note', 'Выйти из аккаунта на этом устройстве? Данные бота останутся на tenkrol.ru, для входа снова понадобится Telegram.'))
  const buttons = h('div')
  buttons.style.display = 'flex'
  buttons.style.gap = '8px'
  buttons.style.marginTop = '14px'
  const stay = h('button', 'btn btn-ghost', 'Остаться')
  stay.type = 'button'
  stay.style.flex = '1'
  stay.addEventListener('click', closeSheet)
  const leave = h('button', 'btn btn-danger-ghost', 'Выйти')
  leave.type = 'button'
  leave.style.flex = '1'
  leave.addEventListener('click', () => {
    closeSheet()
    go('auth')
    toast('Вы вышли из аккаунта')
  })
  buttons.append(stay, leave)
  wrap.append(buttons)
  openSheet({ title: 'Выход', body: wrap })
}

/* ============================ Действия ============================ */

function handleAction(action) {
  switch (action) {
    case 'login':
      go('chat')
      toast('Демо: вход выполнен — это прототип')
      break
    case 'attach':
      openPicker('Прикрепить', ['Фото или скриншот', 'Документ', 'Голосовое сообщение', 'Экспорт данных'], -1, (index, value) => {
        if (value === 'Голосовое сообщение') startRecording()
        else if (value === 'Экспорт данных') go('files')
        else toast('В макете: ' + value.toLowerCase() + ' — демо-заглушка')
      })
      break
    case 'chat-menu':
      openPicker('Чат', ['Настройки ассистента', 'Позвать агента', 'Экспорт истории'], -1, (index) => {
        if (index === 0) go('settings')
        else if (index === 1) go('agent')
        else toast('В макете: экспорт истории появится вместе с API')
      })
      break
    case 'city':
      openCitySheet()
      break
    case 'snooze':
      toast('Отложил на 10 минут — напомню в 9:10')
      break
    case 'cancel-reminder':
      toast('Напоминание отменено')
      break
    case 'help':
      openHelpSheet()
      break
    case 'about':
      openAboutSheet()
      break
    case 'invite':
      openInviteSheet()
      break
    case 'projects':
      openProjectsSheet()
      break
    case 'sessions':
      openSessionsSheet()
      break
    case 'export':
      toast('Демо: архив со всеми данными скачивается на телефон')
      break
    case 'logout':
      openLogoutSheet()
      break
    default:
      break
  }
}

document.addEventListener('click', (event) => {
  const actionNode = event.target.closest('[data-action]')
  if (actionNode) handleAction(actionNode.dataset.action)
})

/* ============================ Связывание ============================ */

function bindChat() {
  chatInput.addEventListener('input', updateComposer)
  chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      sendChat()
    }
  })
  sendButton.addEventListener('click', sendChat)
  micButton.addEventListener('click', startRecording)
  $('rec-cancel').addEventListener('click', () => stopRecording(false))
  $('rec-send').addEventListener('click', () => stopRecording(true))
  quickRow.querySelectorAll('[data-quick]').forEach((button) => {
    button.addEventListener('click', () => {
      chatInput.value = button.dataset.quick
      updateComposer()
      chatInput.focus()
    })
  })
}

function bindPlans() {
  document.querySelectorAll('[data-plans-view]').forEach((button) => {
    button.addEventListener('click', () => setPlansView(button.dataset.plansView))
  })
  $('plans-add').addEventListener('click', () => {
    if (plansView === 'calendar') openEventSheet()
    else openReminderSheet(null)
  })
  $('fab-add').addEventListener('click', () => {
    if (plansView === 'calendar') openEventSheet()
    else openReminderSheet(null)
  })
  $('cal-prev').addEventListener('click', () => {
    calState.month -= 1
    if (calState.month < 0) {
      calState.month = 11
      calState.year -= 1
    }
    calState.selected = 1
    renderCalendar()
  })
  $('cal-next').addEventListener('click', () => {
    calState.month += 1
    if (calState.month > 11) {
      calState.month = 0
      calState.year += 1
    }
    calState.selected = 1
    renderCalendar()
  })
}

function bindMemory() {
  $('memory-search-toggle').addEventListener('click', () => {
    const row = $('memory-search')
    row.hidden = !row.hidden
    if (!row.hidden) $('memory-search-input').focus()
  })
  $('memory-search-input').addEventListener('input', (event) => {
    factQuery = event.target.value
    renderFacts()
  })
  const sendFact = () => {
    const input = $('fact-input')
    const text = input.value.trim()
    if (!text) {
      toast('Введите факт')
      input.focus()
      return
    }
    facts.unshift({ id: ++factSeq, text, source: 'добавлено вручную · только что' })
    input.value = ''
    renderFacts()
    toast('Запомнил — бот учтёт это в личных ответах')
    $('memory-scroll').scrollTop = 0
  }
  $('fact-add').addEventListener('click', sendFact)
  $('fact-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      sendFact()
    }
  })
}

function bindAgent() {
  document.querySelectorAll('[data-task-template]').forEach((button) => {
    button.addEventListener('click', () => {
      $('task-input').value = button.dataset.taskTemplate
      $('task-input').focus()
    })
  })
  $('task-send').addEventListener('click', () => {
    const input = $('task-input')
    const title = input.value.trim()
    if (!title) {
      toast('Опишите задачу для агента')
      input.focus()
      return
    }
    input.value = ''
    startTask(title)
  })
}

function bindFiles() {
  document.querySelectorAll('#files-filters [data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      fileFilter = button.dataset.filter
      document.querySelectorAll('#files-filters .chip').forEach((chip) => {
        chip.classList.toggle('is-active', chip === button)
      })
      renderFiles()
    })
  })
  $('files-search-toggle').addEventListener('click', () => {
    const row = $('files-search')
    row.hidden = !row.hidden
    if (!row.hidden) $('files-search-input').focus()
  })
  $('files-search-input').addEventListener('input', (event) => {
    fileQuery = event.target.value
    renderFiles()
  })
}

function bindSettings() {
  document.querySelectorAll('[data-picker]').forEach((button) => {
    button.addEventListener('click', () => openSettingPicker(button.dataset.picker))
  })
  document.querySelectorAll('[data-theme-mode]').forEach((button) => {
    button.addEventListener('click', () => setThemeMode(button.dataset.themeMode))
  })
  document.querySelectorAll('[data-toggle]').forEach((button) => {
    const key = button.dataset.toggle
    if (key === 'large-text' && store.get(LARGE_TEXT_KEY) === '1') {
      button.classList.add('is-on')
      document.documentElement.classList.add('large-text')
    }
    button.addEventListener('click', () => {
      const on = !button.classList.contains('is-on')
      button.classList.toggle('is-on', on)
      if (key === 'large-text') {
        document.documentElement.classList.toggle('large-text', on)
        store.set(LARGE_TEXT_KEY, on ? '1' : '0')
        toast(on ? 'Крупный текст включён' : 'Крупный текст выключен')
        return
      }
      toast(({
        voice: 'Голосовые ответы',
        digest: 'Дайджест',
        quiet: 'Тихие часы',
        weather: 'Погодные предупреждения'
      })[key] + (on ? ' включены' : ' выключены'))
    })
  })
}

function bindAuth() {
  const form = document.querySelector('[data-form="code"]')
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const input = form.querySelector('input')
    if (input.value.trim().length < 4) {
      toast('Введите код из бота — в демо подойдёт любой')
      input.focus()
      return
    }
    go('chat')
    toast('Демо: вход по коду выполнен')
  })
}

function bindStats() {
  const values = [42, 68, 55, 80, 62, 38, 88]
  const labels = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
  const chart = $('chart')
  const chartLabels = $('chart-labels')
  chart.replaceChildren()
  chartLabels.replaceChildren()
  values.forEach((value, index) => {
    const wrap = h('div', 'bar-wrap')
    const bar = h('div', 'bar' + (index === values.length - 1 ? ' today' : ''))
    bar.style.height = value + '%'
    wrap.append(bar)
    chart.append(wrap)
    chartLabels.append(h('span', index === values.length - 1 ? 'today' : '', labels[index]))
  })
}

/* ============================ Старт ============================ */

function init() {
  applyTheme()
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themeMode === 'auto') applyTheme()
  })

  renderPlans()
  renderFacts()
  renderAgent()
  renderFiles()
  renderCalendar()
  bindChat()
  bindPlans()
  bindMemory()
  bindAgent()
  bindFiles()
  bindSettings()
  bindAuth()
  bindStats()
  updateComposer()

  const requestedView = params.get('view')
  if (requestedView === 'calendar') setPlansView('calendar')

  let initial = params.get('screen')
  if (!initial && location.hash) initial = location.hash.slice(1)
  if (!initial || !screens.has(initial)) initial = 'chat'
  go(initial, { push: false })
  try {
    history.replaceState({ screen: initial }, '', '#' + initial)
  } catch {
    /* на file:// история может быть недоступна — макету это не мешает */
  }

  // Для дизайн-борда: открыть шторку поверх нужного экрана.
  const requestedSheet = params.get('sheet')
  if (requestedSheet === 'reminder') openReminderSheet(null)
  else if (requestedSheet === 'event') openEventSheet()
  else if (requestedSheet === 'fact') openFactSheet(null)
  else if (requestedSheet === 'invite') openInviteSheet()
  else if (requestedSheet === 'help') openHelpSheet()
  else if (requestedSheet === 'logout') openLogoutSheet()
}

init()
