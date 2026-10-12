/**
 * Yandex.Disk storage for what the agent produces.
 *
 * Telegram is a fine delivery channel and a poor archive: files scroll away, and
 * the owner has no library of what the agent made. Every deliverable is therefore
 * also uploaded to Disk, under `<dir>/<taskId>/`, where it can be found months
 * later. The daily state backup goes to `<dir>/backups/` the same way, which
 * makes it an off-site copy.
 *
 * The REST API is two-step by design: the metadata call asks for an upload URL,
 * and the bytes go to the returned `href` (often another host), so the token is
 * never part of a URL. Only the metadata call carries the OAuth header.
 *
 * Nothing here throws at the caller: a failure comes back as `{ ok: false, error }`
 * so a task that finished is never reported as failed because Disk was down.
 */

/** The API root; every path below is relative to it. */
export const DEFAULT_API_BASE = 'https://cloud-api.yandex.net/v1/disk'

/** The default folder: one place for everything the agent stores. */
export const DEFAULT_DIR = '/Агент'

/** Turn a status code into something worth showing a person. */
function describeStatus(status, body = '') {
  if (status === 401) return 'Яндекс.Диск не принял токен (401): проверьте YANDEX_DISK_TOKEN'
  if (status === 403) {
    return 'Яндекс.Диск отказал в доступе (403): у приложения нет прав на Диск. '
      + 'Добавьте доступ к Яндекс.Диску в настройках приложения и выпустите токен заново, '
      + 'либо подключите WebDAV с паролем приложения (YANDEX_DISK_MODE=webdav)'
  }
  if (status === 404) return 'Яндекс.Диск: путь не найден (404)'
  if (status === 409) return 'Яндекс.Диск: уже существует (409)'
  if (status === 507) return 'Яндекс.Диск: закончилось место (507)'
  const detail = String(body ?? '').replace(/\s+/g, ' ').slice(0, 160)
  return `Яндекс.Диск ответил ${status}${detail === '' ? '' : `: ${detail}`}`
}

/** Join path segments, keeping exactly one leading slash. */
export function joinPath(...parts) {
  const clean = parts
    .filter((part) => part !== undefined && part !== null && String(part) !== '')
    .map((part) => String(part).replace(/^\/+|\/+$/g, ''))
    .filter((part) => part !== '')
  return `/${clean.join('/')}`
}

export class YandexDisk {
  /**
   * @param {object} options - client options.
   * @param {string} [options.token] - OAuth token; without it the client is off.
   * @param {string} [options.dir] - base folder on Disk.
   * @param {string} [options.apiBase] - API root, overridable for tests.
   * @param {number} [options.timeoutMs] - per-request timeout.
   * @param {object} [options.logger] - logger.
   * @param {typeof fetch} [options.fetchImpl] - fetch, injected by tests.
   */
  constructor({
    token,
    dir = DEFAULT_DIR,
    apiBase = DEFAULT_API_BASE,
    timeoutMs = 60_000,
    logger,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.token = token
    this.dir = String(dir ?? DEFAULT_DIR).replace(/\/+$/, '') || DEFAULT_DIR
    this.apiBase = String(apiBase).replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
    this.logger = logger
    this.fetchImpl = fetchImpl
  }

  /** True when the client can make a call. */
  get enabled() {
    return Boolean(this.token && this.apiBase && this.fetchImpl)
  }

  /** One metadata call. */
  async call(method, path, { query, body, raw = false, absolute } = {}) {
    // The API root is a bare path: `${base}${''}` must not become `…/disk/`.
    const url = new URL(absolute ?? `${this.apiBase}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const response = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        authorization: `OAuth ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { ok: false, status: response.status, error: describeStatus(response.status, text) }
    }
    if (raw) return { ok: true, response }
    // 204 and empty bodies are normal for delete/create.
    const text = await response.text().catch(() => '')
    let payload = {}
    if (String(text).trim() !== '') {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = {}
      }
    }
    return { ok: true, status: response.status, payload }
  }

  /** Disk quota and owner, for `/disk`. */
  async info() {
    if (!this.enabled) return { ok: false, error: 'Яндекс.Диск не настроен' }
    try {
      const result = await this.call('GET', '')
      if (!result.ok) return result
      return {
        ok: true,
        total: Number(result.payload?.total_space) || 0,
        used: Number(result.payload?.used_space) || 0,
        trash: Number(result.payload?.trash_size) || 0,
      }
    } catch (error) {
      return { ok: false, error: `Диск недоступен: ${String(error?.message ?? error).slice(0, 120)}` }
    }
  }

  /** Create a folder; an existing one counts as success. */
  async ensureDir(path) {
    if (!this.enabled) return { ok: false, error: 'Яндекс.Диск не настроен' }
    try {
      const result = await this.call('PUT', '/resources', { query: { path } })
      if (result.ok) return { ok: true }
      // 409 means it is already there, which is exactly what we wanted.
      if (result.status === 409) return { ok: true, existed: true }
      return result
    } catch (error) {
      return { ok: false, error: `Диск недоступен: ${String(error?.message ?? error).slice(0, 120)}` }
    }
  }

  /**
   * Create every folder in a path.
   *
   * @param {string} path - absolute path on Disk.
   * @returns {Promise<{ok: boolean, error?: string}>} the outcome.
   */
  async ensureTree(path) {
    const segments = String(path).split('/').filter(Boolean)
    let current = ''
    for (const segment of segments) {
      current = `${current}/${segment}`
      const result = await this.ensureDir(current)
      if (!result.ok) return result
    }
    return { ok: true }
  }

  /**
   * Upload bytes to a path, creating the folders above it.
   *
   * @param {object} request - `path`, `bytes`, optional `overwrite`.
   * @returns {Promise<{ok: boolean, path?: string, error?: string}>} the outcome.
   */
  async upload({ path, bytes, overwrite = true } = {}) {
    if (!this.enabled) return { ok: false, error: 'Яндекс.Диск не настроен' }
    try {
      const parent = String(path).replace(/\/[^/]*$/, '')
      if (parent !== '' && parent !== '/') {
        const tree = await this.ensureTree(parent)
        if (!tree.ok) return tree
      }
      const ticket = await this.call('GET', '/resources/upload', { query: { path, overwrite: overwrite ? 'true' : 'false' } })
      if (!ticket.ok) return ticket
      const href = ticket.payload?.href
      if (!href) return { ok: false, error: 'Яндекс.Диск не вернул адрес загрузки' }
      const response = await this.fetchImpl(href, {
        method: ticket.payload?.method ?? 'PUT',
        body: bytes,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        return { ok: false, status: response.status, error: describeStatus(response.status, detail) }
      }
      this.logger?.info('uploaded to disk', { path, bytes: bytes?.length ?? 0 })
      return { ok: true, path }
    } catch (error) {
      this.logger?.warn('disk upload failed', { path, error })
      return { ok: false, error: `Диск недоступен: ${String(error?.message ?? error).slice(0, 120)}` }
    }
  }

  /** List one folder. */
  async list(path = this.dir, { limit = 100 } = {}) {
    if (!this.enabled) return { ok: false, error: 'Яндекс.Диск не настроен', items: [] }
    try {
      const result = await this.call('GET', '/resources', {
        // `fields` is a projection: plain names drop `_embedded.items` and the
        // folder looks empty, so the nested fields are named explicitly.
        query: {
          path,
          limit,
          sort: '-modified',
          fields: '_embedded.items.name,_embedded.items.path,_embedded.items.size,'
            + '_embedded.items.modified,_embedded.items.type',
        },
      })
      if (!result.ok) return { ...result, items: [] }
      const items = (result.payload?._embedded?.items ?? []).map((item) => ({
        name: String(item.name ?? ''),
        path: String(item.path ?? ''),
        size: Number(item.size) || 0,
        modified: item.modified ?? '',
        type: item.type === 'dir' ? 'dir' : 'file',
      }))
      return { ok: true, items }
    } catch (error) {
      return { ok: false, error: `Диск недоступен: ${String(error?.message ?? error).slice(0, 120)}`, items: [] }
    }
  }

  /** Download a file's bytes. */
  async download(path) {
    if (!this.enabled) return { ok: false, error: 'Яндекс.Диск не настроен' }
    try {
      const ticket = await this.call('GET', '/resources/download', { query: { path } })
      if (!ticket.ok) return ticket
      const href = ticket.payload?.href
      if (!href) return { ok: false, error: 'Яндекс.Диск не вернул адрес скачивания' }
      const response = await this.fetchImpl(href, { method: ticket.payload?.method ?? 'GET', signal: AbortSignal.timeout(this.timeoutMs) })
      if (!response.ok) {
        return { ok: false, status: response.status, error: describeStatus(response.status) }
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      return { ok: true, bytes, path }
    } catch (error) {
      return { ok: false, error: `Диск недоступен: ${String(error?.message ?? error).slice(0, 120)}` }
    }
  }

  /**
   * Make a file public and return its link.
   *
   * Off by default in the bot: a public link is readable by anyone who knows it,
   * so publishing is an explicit action (`/disk link …`).
   */
  async publish(path) {
    if (!this.enabled) return { ok: false, error: 'Яндекс.Диск не настроен' }
    try {
      const result = await this.call('PUT', '/resources/publish', { query: { path } })
      if (!result.ok) return result
      // The publish call answers with a Link; `public_url` appears only when that
      // link is followed. Trusting the first answer silently gave an empty URL.
      const link = result.payload?.href
      if (!link) return { ok: false, error: 'Яндекс.Диск не вернул ссылку на публикацию' }
      const followed = await this.call('GET', '', { absolute: link })
      if (!followed.ok) return followed
      const url = followed.payload?.public_url ?? ''
      if (url === '') return { ok: false, error: 'Яндекс.Диск не отдал публичную ссылку' }
      return { ok: true, url }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error).slice(0, 160) }
    }
  }

  /** Remove a file or folder. */
  async remove(path, { permanently = true } = {}) {
    if (!this.enabled) return { ok: false, error: 'Яндекс.Диск не настроен' }
    try {
      const result = await this.call('DELETE', '/resources', {
        query: { path, permanently: permanently ? 'true' : 'false' },
      })
      if (!result.ok) return result
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error).slice(0, 160) }
    }
  }

  /** Check the token and the base folder: what `/disk` runs first. */
  async probe() {
    if (!this.enabled) return { ok: false, error: 'Яндекс.Диск не настроен (нет YANDEX_DISK_TOKEN)' }
    const info = await this.info()
    if (!info.ok) return info
    const folder = await this.ensureDir(this.dir)
    if (!folder.ok) return folder
    return { ok: true, total: info.total, used: info.used, dir: this.dir }
  }
}

/** Format bytes for a person. */
export function formatDiskSize(bytes) {
  const value = Number(bytes) || 0
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  let index = 0
  let size = value
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  const rounded = index === 0 ? Math.round(size) : Math.round(size * 10) / 10
  return `${rounded.toLocaleString('ru-RU')} ${units[index]}`
}

export const createYandexDisk = (options) => new YandexDisk(options)

/** Percent-encode one path segment, keeping Cyrillic readable for the API. */
const encodeSegment = (segment) => encodeURIComponent(segment)

/** The path Yandex WebDAV expects: every segment encoded, one leading slash. */
export function webdavPath(path) {
  const segments = String(path ?? '').split('/').filter(Boolean).map(encodeSegment)
  return `/${segments.join('/')}`
}

/**
 * The same archive, over WebDAV instead of the REST API.
 *
 * WebDAV exists here because getting it going costs the owner one app password
 * (id.yandex.ru → пароли приложений) instead of registering an OAuth app with
 * the right Disk scopes — the step that actually blocks people. The price is
 * that public links are unavailable (they are a REST-only feature) and the quota
 * is not exposed, so `/disk` says so honestly.
 *
 * Auth is HTTP Basic with the Yandex login and an app password.
 */
export class YandexWebdav {
  constructor({
    login,
    password,
    dir = DEFAULT_DIR,
    apiBase = 'https://webdav.yandex.ru',
    timeoutMs = 60_000,
    logger,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.login = login
    this.password = password
    this.dir = String(dir ?? DEFAULT_DIR).replace(/\/+$/, '') || DEFAULT_DIR
    this.apiBase = String(apiBase).replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
    this.logger = logger
    this.fetchImpl = fetchImpl
  }

  get enabled() {
    return Boolean(this.login && this.password && this.apiBase && this.fetchImpl)
  }

  /** The Basic header; the password never travels in a URL. */
  authHeader() {
    return `Basic ${Buffer.from(`${this.login}:${this.password}`, 'utf8').toString('base64')}`
  }

  /** One WebDAV request. */
  async call(method, path, { body, headers = {}, raw = false } = {}) {
    const url = `${this.apiBase}${webdavPath(path)}`
    const response = await this.fetchImpl(url, {
      method,
      headers: { authorization: this.authHeader(), ...headers },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok && response.status !== 207) {
      const text = await response.text().catch(() => '')
      return { ok: false, status: response.status, error: describeStatus(response.status, text) }
    }
    if (raw) return { ok: true, status: response.status, response }
    const text = await response.text().catch(() => '')
    return { ok: true, status: response.status, text }
  }

  /** WebDAV does not expose the quota; the folder is what matters. */
  async info() {
    return { ok: true, total: 0, used: 0, quotaKnown: false }
  }

  /** Create one folder; "already there" is success. */
  async ensureDir(path) {
    if (!this.enabled) return { ok: false, error: 'Яндекс.Диск не настроен' }
    try {
      const result = await this.call('MKCOL', path)
      if (result.ok) return { ok: true }
      // 405 = already exists, 409 = parent missing (the caller creates parents first).
      if (result.status === 405) return { ok: true, existed: true }
      return result
    } catch (error) {
      return { ok: false, error: `Диск недоступен: ${String(error?.message ?? error).slice(0, 120)}` }
    }
  }

  /** Create every folder in a path, top down. */
  async ensureTree(path) {
    const segments = String(path).split('/').filter(Boolean)
    let current = ''
    for (const segment of segments) {
      current = `${current}/${segment}`
      const result = await this.ensureDir(current)
      if (!result.ok) return result
    }
    return { ok: true }
  }

  /** Put bytes at a path, creating the folders above it. */
  async upload({ path, bytes } = {}) {
    if (!this.enabled) return { ok: false, error: 'Яндекс.Диск не настроен' }
    try {
      const parent = String(path).replace(/\/[^/]*$/, '')
      if (parent !== '' && parent !== '/') {
        const tree = await this.ensureTree(parent)
        if (!tree.ok) return tree
      }
      const result = await this.call('PUT', path, { body: bytes, headers: { 'content-type': 'application/octet-stream' } })
      if (!result.ok) return result
      this.logger?.info('uploaded to disk (webdav)', { path, bytes: bytes?.length ?? 0 })
      return { ok: true, path }
    } catch (error) {
      this.logger?.warn('webdav upload failed', { path, error })
      return { ok: false, error: `Диск недоступен: ${String(error?.message ?? error).slice(0, 120)}` }
    }
  }

  /** List a folder by parsing the Multi-Status answer. */
  async list(path = this.dir, { limit = 100 } = {}) {
    if (!this.enabled) return { ok: false, error: 'Яндекс.Диск не настроен', items: [] }
    try {
      const result = await this.call('PROPFIND', path, { headers: { depth: '1' } })
      if (!result.ok) return { ...result, items: [] }
      const items = []
      const responses = String(result.text ?? '').split(/<\/?d:response[^>]*>/i).filter((chunk) => chunk.includes('href'))
      const listed = String(path).replace(/\/+$/, '')
      for (const chunk of responses) {
        const href = chunk.match(/<d:href>([^<]+)<\/d:href>/i)?.[1]
        if (!href) continue
        // The href is the full path already: building it from the folder plus the
        // name would lose intermediate directories.
        const full = decodeURIComponent(href).replace(/\/+$/, '')
        if (full === '' || full === listed) continue
        const name = full.split('/').pop()
        if (!name) continue
        const size = Number(chunk.match(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/i)?.[1]) || 0
        const isDir = /<d:collection\s*\/?>/i.test(chunk) || /<d:resourcetype>\s*<d:collection/i.test(chunk)
        const modified = chunk.match(/<d:getlastmodified>([^<]+)<\/d:getlastmodified>/i)?.[1] ?? ''
        items.push({ name, path: full, size, modified, type: isDir ? 'dir' : 'file' })
        if (items.length >= limit) break
      }
      return { ok: true, items }
    } catch (error) {
      return { ok: false, error: `Диск недоступен: ${String(error?.message ?? error).slice(0, 120)}`, items: [] }
    }
  }

  /** Download a file's bytes. */
  async download(path) {
    if (!this.enabled) return { ok: false, error: 'Яндекс.Диск не настроен' }
    try {
      const result = await this.call('GET', path, { raw: true })
      if (!result.ok) return result
      const bytes = Buffer.from(await result.response.arrayBuffer())
      return { ok: true, bytes, path }
    } catch (error) {
      return { ok: false, error: `Диск недоступен: ${String(error?.message ?? error).slice(0, 120)}` }
    }
  }

  /** Public links are a REST feature; WebDAV cannot make them. */
  async publish() {
    return {
      ok: false,
      error: 'публичные ссылки доступны только с OAuth-токеном (YANDEX_DISK_MODE=rest), '
        + 'в WebDAV-режиме файл можно скачать на Диске вручную',
    }
  }

  /** Remove a file or folder. */
  async remove(path) {
    if (!this.enabled) return { ok: false, error: 'Яндекс.Диск не настроен' }
    try {
      const result = await this.call('DELETE', path)
      return result.ok ? { ok: true } : result
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error).slice(0, 160) }
    }
  }

  /** Check the credentials and create the base folder. */
  async probe() {
    if (!this.enabled) return { ok: false, error: 'Яндекс.Диск не настроен (нужны логин и пароль приложения)' }
    const folder = await this.ensureTree(this.dir)
    if (!folder.ok) return folder
    return { ok: true, dir: this.dir, total: 0, used: 0, quotaKnown: false }
  }
}

/**
 * Pick the storage backend.
 *
 * @param {object} options - `mode` (`rest` for an OAuth token, `webdav` for an app password) plus the credentials.
 * @returns {YandexDisk|YandexWebdav} a storage client with the same interface.
 */
export function createDiskStorage({ mode = 'rest', ...options } = {}) {
  if (mode === 'webdav') {
    return new YandexWebdav({ login: options.login, password: options.password, dir: options.dir, timeoutMs: options.timeoutMs, logger: options.logger, fetchImpl: options.fetchImpl })
  }
  return new YandexDisk({ token: options.token, dir: options.dir, timeoutMs: options.timeoutMs, logger: options.logger, fetchImpl: options.fetchImpl })
}
