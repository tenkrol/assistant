/**
 * Локализация мини-приложения.
 *
 * Здесь только чистые функции: выбор языка, подстановка значений в шаблон и
 * тег локали для дат. Сами строки лежат в `locales/ru.json` и
 * `locales/en.json`; в разметке и скриптах остаются ключи, поэтому наборы
 * ключей можно сравнивать тестом без запуска браузера.
 */

/** Язык по умолчанию: всё, что не распознано, показывается по-русски. */
export const DEFAULT_LANGUAGE = 'ru'

/** Языки, для которых есть словарь. */
export const SUPPORTED_LANGUAGES = ['ru', 'en']

/** Тег для `toLocaleString`; язык панели не обязан совпадать с локалью ОС. */
const LOCALE_TAGS = {
  ru: 'ru-RU',
  en: 'en-US',
}

/**
 * Приводит код языка к одному из поддерживаемых.
 *
 * Telegram присылает коды вида `en`, `ru`, `en-US`, поэтому регистр и регион
 * отбрасываются. Неизвестный код — это `undefined`: вызывающий сам решает,
 * какой язык взять вместо него.
 *
 * @param {unknown} value - код языка из CloudStorage или initData.
 * @returns {'ru' | 'en' | undefined} поддерживаемый код или `undefined`.
 */
export function normalizeLanguage(value) {
  if (typeof value !== 'string') return undefined
  const code = value.trim().toLowerCase().split(/[-_]/)[0]
  return SUPPORTED_LANGUAGES.includes(code) ? code : undefined
}

/**
 * Выбирает язык панели.
 *
 * Порядок: сохранённый выбор пользователя, затем язык Telegram, затем русский.
 * Неизвестный сохранённый код не блокирует определение по Telegram.
 *
 * @param {{stored?: unknown, telegram?: unknown}} [candidates] - кандидаты.
 * @returns {'ru' | 'en'} язык интерфейса.
 */
export function resolveLanguage({ stored, telegram } = {}) {
  return normalizeLanguage(stored) || normalizeLanguage(telegram) || DEFAULT_LANGUAGE
}

/**
 * Достаёт `language_code` из сырой строки `initData`.
 *
 * `tg.initDataUnsafe` может быть недоступен (например, в тестах или в старом
 * клиенте), а сама строка `initData` есть всегда при открытии из Telegram.
 * Поле лежит внутри JSON-поля `user`, поэтому строку нужно разобрать.
 *
 * @param {unknown} initData - сырая строка `Telegram.WebApp.initData`.
 * @returns {'ru' | 'en' | undefined} язык Telegram или `undefined`.
 */
export function languageFromInitData(initData) {
  if (typeof initData !== 'string' || initData === '') return undefined
  try {
    const user = JSON.parse(new URLSearchParams(initData).get('user') ?? '')
    if (user === null || typeof user !== 'object' || Array.isArray(user)) return undefined
    return normalizeLanguage(user.language_code)
  } catch {
    return undefined
  }
}

/**
 * Тег локали для форматирования дат.
 *
 * @param {unknown} language - код языка.
 * @returns {string} тег `ru-RU` или `en-US`.
 */
export function localeTag(language) {
  return LOCALE_TAGS[normalizeLanguage(language) ?? DEFAULT_LANGUAGE]
}

/**
 * Переводит ключ по словарю.
 *
 * Если ключа нет, возвращается сам ключ: это видно в интерфейсе и сразу
 * указывает на пропущенную строку. Подстановки записываются как `{name}` и
 * заменяются значениями из `vars`; неизвестная подстановка остаётся как есть.
 *
 * @param {Record<string, string> | undefined} dictionary - плоский словарь.
 * @param {string} key - ключ строки.
 * @param {Record<string, string | number>} [vars] - значения подстановок.
 * @returns {string} переведённая строка или сам ключ.
 */
export function translate(dictionary, key, vars) {
  const value = dictionary && Object.prototype.hasOwnProperty.call(dictionary, key)
    ? dictionary[key]
    : undefined
  if (typeof value !== 'string') return key
  if (vars === undefined || vars === null) return value
  return value.replace(/\{([a-z0-9_]+)\}/gi, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match)
}
