/**
 * Calendar helpers for the digest: church and folk holidays, and a daily health tip.
 *
 * The official (нерабочие) holidays come from Nager.Date; everything here fills the
 * gaps it does not cover. Church dates are computed rather than listed: Orthodox
 * Easter moves every year, and most great feasts hang off it. The fixed dates are
 * given in the Gregorian calendar as they are printed in ordinary calendars
 * (7 January for Christmas, and so on).
 *
 * The health tips are general, everyday advice — no diagnosis, no treatment.
 */

/** One day in milliseconds. */
const DAY = 24 * 60 * 60 * 1000

/**
 * Orthodox Easter for a year, in the Gregorian calendar.
 *
 * Meeus's Julian algorithm: the result is a Julian date, and for 1900–2099 the
 * Gregorian equivalent is 13 days later.
 *
 * @param {number} year - calendar year.
 * @returns {{year: number, month: number, day: number}} Easter date.
 */
export function orthodoxEaster(year) {
  const a = year % 4
  const b = year % 7
  const c = year % 19
  const d = (19 * c + 15) % 30
  const e = (2 * a + 4 * b - d + 34) % 7
  const month = Math.floor((d + e + 114) / 31)
  const day = ((d + e + 114) % 31) + 1
  // 13 days is the Julian–Gregorian difference for the 20th and 21st centuries.
  const julian = new Date(Date.UTC(year, month - 1, day))
  const gregorian = new Date(julian.getTime() + 13 * DAY)
  return { year, month: gregorian.getUTCMonth() + 1, day: gregorian.getUTCDate() }
}

/** Great feasts and widely kept church days with a fixed date (month, day). */
const FIXED_CHURCH = {
  '1-7': 'Рождество Христово',
  '1-14': 'Обрезание Господне',
  '1-19': 'Крещение Господне',
  '2-15': 'Сретение Господне',
  '4-7': 'Благовещение Пресвятой Богородицы',
  '5-22': 'Перенесение мощей святителя Николая',
  '7-7': 'Рождество Иоанна Предтечи',
  '7-12': 'Святых первоверховных апостолов Петра и Павла',
  '8-19': 'Преображение Господне',
  '8-28': 'Успение Пресвятой Богородицы',
  '9-11': 'Усекновение главы Иоанна Предтечи',
  '9-21': 'Рождество Пресвятой Богородицы',
  '9-27': 'Воздвижение Креста Господня',
  '10-14': 'Покров Пресвятой Богородицы',
  '12-4': 'Введение во храм Пресвятой Богородицы',
  '12-19': 'Святителя Николая Чудотворца',
}

/** Folk and professional days with a fixed date (month, day). */
const FIXED_FOLK = {
  '1-25': 'Татьянин день, День студента',
  '2-14': 'День всех влюблённых',
  '4-1': 'День смеха',
  '4-12': 'День космонавтики',
  '5-24': 'День славянской письменности и культуры',
  '6-6': 'День русского языка (Пушкинский день)',
  '7-8': 'День семьи, любви и верности',
  '8-2': 'День Воздушно-десантных войск',
  '8-22': 'День Государственного флага России',
  '8-27': 'День российского кино',
  '9-1': 'День знаний',
  '10-5': 'День учителя',
  '11-10': 'День сотрудника органов внутренних дел',
  '12-3': 'День юриста',
  '12-12': 'День Конституции России',
  '12-31': 'Канун Нового года',
}

/** Short, safe, everyday health advice. One per day, rotating by date and user. */
const HEALTH_TIPS = [
  { tip: 'пройдите 10 минут пешком после еды', why: 'это заметно сглаживает скачок сахара в крови' },
  { tip: 'выпейте стакан воды сразу после пробуждения', why: 'за ночь организм теряет влагу, а жажду мы часто путаем с голодом' },
  { tip: 'каждые 20 минут смотрите 20 секунд вдаль', why: 'глазные мышцы устают от постоянной фокусировки на близком экране' },
  { tip: 'перед сном подышите по схеме 4–7–8', why: 'долгий выдох включает торможение нервной системы и помогает уснуть' },
  { tip: 'уберите экран за час до сна', why: 'яркий свет вечером сдвигает выработку мелатонина' },
  { tip: 'сделайте 15 приседаний между делами', why: 'короткие нагрузки в течение дня полезнее одной длинной' },
  { tip: 'проведите 15 минут на солнце в обед', why: 'зимой это основной способ получить витамин D' },
  { tip: 'добавьте овощи в каждый приём пищи', why: 'клетчатка и объём дают сытость при меньшем числе калорий' },
  { tip: 'дышите носом на улице и в зале', why: 'нос согревает и фильтрует воздух, это легче для лёгких' },
  { tip: 'проверьте осанку: уши над плечами, плечи опущены', why: 'частая причина головной боли — зажатая шея' },
  { tip: 'поднимайтесь по лестнице вместо лифта', why: 'это самая доступная кардиотренировка в городе' },
  { tip: 'разомните шею и плечи раз в час', why: 'статичная поза у компьютера напрягает мышцы сильнее движения' },
  { tip: 'ложитесь спать в одно и то же время', why: 'режим важнее общей длительности сна' },
  { tip: 'замените сладкое горстью орехов', why: 'жиры и белок дают сытость без резкого скачка сахара' },
  { tip: 'не ешьте за 2–3 часа до сна', why: 'так сон будет глубже, а изжога — реже' },
  { tip: 'сделайте 5 минут спокойного дыхания: вдох 4, выдох 6', why: 'это снижает пульс и уровень тревоги' },
  { tip: 'проверьте, не сидите ли нога на ногу', why: 'пережатые сосуды дают тяжесть в ногах к вечеру' },
  { tip: 'обнимите близкого человека на 20 секунд', why: 'объятия снижают уровень кортизола' },
  { tip: 'съешьте фрукт вместо сока', why: 'в целом фрукте есть клетчатка, в соке — только сахар' },
  { tip: 'постойте в планке одну минуту', why: 'это укрепляет корпус и защищает поясницу' },
  { tip: 'пройдите 15 минут пешком вместо транспорта', why: 'норма ВОЗ — 30 минут движения в день, её удобно набирать частями' },
  { tip: 'держите телефон на расстоянии вытянутой руки', why: 'так меньше нагрузки на шею и зрение' },
  { tip: 'не пейте кофе после 15:00', why: 'кофеин действует 6–8 часов и мешает засыпанию' },
  { tip: 'съешьте порцию кисломолочного продукта', why: 'это поддержка микрофлоры кишечника' },
  { tip: 'проветрите спальню перед сном', why: 'прохладный свежий воздух улучшает качество сна' },
  { tip: 'выйдите на воздух хотя бы на 10 минут', why: 'даже короткая прогулка снижает уровень стресса' },
  { tip: 'делайте перерыв 10 минут каждый час', why: 'внимание восстанавливается, а ошибок становится меньше' },
  { tip: 'потянитесь всем телом перед сном', why: 'мягкое растяжение снимает дневное напряжение' },
  { tip: 'запишите три хорошие вещи за день', why: 'это простая практика, которая улучшает настроение' },
  { tip: 'проверьте, хватает ли вам 7–8 часов сна', why: 'недосып бьёт по памяти и аппетиту сильнее, чем кажется' },
  { tip: 'съешьте что-нибудь с цельными злаками', why: 'медленные углеводы дают ровную энергию до обеда' },
  { tip: 'посмотрите в окно, а не в монитор, пять минут', why: 'смена фокуса разгружает глаза' },
  { tip: 'выпейте воды перед едой', why: 'часто жажду принимают за голод и переедают' },
  { tip: 'пройдите сегодня 6000 шагов', why: 'это уже связано со снижением риска сердечных болезней' },
  { tip: 'сядьте ровно и поставьте обе ноги на пол', why: 'устойчивая поза снижает нагрузку на поясницу' },
  { tip: 'устройте 20 минут без телефона', why: 'постоянные уведомления держат нервную систему в напряжении' },
  { tip: 'съешьте порцию бобовых', why: 'это белок и клетчатка, которые долго держат сытость' },
  { tip: 'сделайте лёгкую зарядку для глаз: вверх-вниз-вправо-влево', why: 'это снимает усталость от чтения' },
  { tip: 'проверьте освещение на рабочем месте', why: 'работа в полутьме заставляет напрягать зрение' },
  { tip: 'посмейтесь: посмотрите что-нибудь смешное', why: 'смех снижает напряжение и улучшает настроение' },
]

/** The date parts of a moment in one zone. */
function partsOf(now, timeZone) {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  })
  const parts = Object.fromEntries(format.formatToParts(now).map((part) => [part.type, part.value]))
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // 0 = Sunday, as Date#getUTCDay uses.
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
  }
}

/** Difference in whole days between two calendar dates. */
const daysBetween = (from, to) => Math.round((Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) / DAY)

/** The nth weekday of a month, e.g. the last Sunday of November. */
function nthWeekday(year, month, weekday, { last = false, nth = 1 } = {}) {
  if (last) {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const weekdayOfLast = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay()
    const offset = (weekdayOfLast - weekday + 7) % 7
    return lastDay - offset
  }
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const offset = (weekday - firstWeekday + 7) % 7
  return 1 + offset + (nth - 1) * 7
}

/**
 * Church holidays that fall on one day.
 *
 * @param {Date} now - moment to look at.
 * @param {string} [timeZone] - zone the day is counted in.
 * @returns {Array<string>} names, possibly empty.
 */
export function churchHolidays(now = new Date(), timeZone = '') {
  const { year, month, day } = partsOf(now, timeZone)
  const names = []
  const fixed = FIXED_CHURCH[`${month}-${day}`]
  if (fixed) names.push(fixed)
  const easter = orthodoxEaster(year)
  const shift = daysBetween(easter, { year, month, day })
  if (shift === 0) names.push('Пасха (Светлое Христово Воскресение)')
  if (shift === -7) names.push('Вход Господень в Иерусалим (Вербное воскресенье)')
  if (shift === -49) names.push('Прощёное воскресенье')
  if (shift === 39) names.push('Вознесение Господне')
  if (shift === 49) names.push('День Святой Троицы (Пятидесятница)')
  if (shift === -56) names.push('Начало Масленицы')
  return names
}

/**
 * Folk and professional days that fall on one day.
 *
 * @param {Date} now - moment to look at.
 * @param {string} [timeZone] - zone the day is counted in.
 * @returns {Array<string>} names, possibly empty.
 */
export function folkHolidays(now = new Date(), timeZone = '') {
  const { year, month, day } = partsOf(now, timeZone)
  const names = []
  const fixed = FIXED_FOLK[`${month}-${day}`]
  if (fixed) names.push(fixed)
  const dayOfYear = Math.floor((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / DAY) + 1
  if (dayOfYear === 256) names.push('День программиста')
  if (month === 11 && day === nthWeekday(year, 11, 0, { last: true })) names.push('День матери')
  if (month === 10 && day === nthWeekday(year, 10, 0, { nth: 3 })) names.push('День отца')
  return names
}

/**
 * The health tip of the day for one user.
 *
 * The choice is stable for the day and personal, so two people in one chat do not
 * get the same line every morning.
 *
 * @param {Date} [now] - moment to look at.
 * @param {string|number} [userId] - profile owner.
 * @param {string} [timeZone] - zone the day is counted in.
 * @returns {{tip: string, why: string}} the tip.
 */
export function healthTip(now = new Date(), userId, timeZone = '') {
  const { year, month, day } = partsOf(now, timeZone)
  const seed = `${userId ?? 'anon'}|${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return HEALTH_TIPS[hash % HEALTH_TIPS.length]
}

/** How many tips the rotation offers. */
export const HEALTH_TIP_COUNT = HEALTH_TIPS.length
