/**
 * Только чтение и удаление файлов агента на Яндекс.Диске.
 *
 * Агент складывает результаты в `Агент/<номер задачи>/`. Сайт показывает эти
 * папки как папку агента: список, скачивание и удаление. Токен живёт только в
 * окружении сервера и никогда не уходит в браузер.
 */
const API = 'https://cloud-api.yandex.net/v1/disk'
const MAX_FILES = 200

export class YandexDiskError extends Error {
  constructor(message, code = 'disk_error', status = 502) {
    super(message)
    this.name = 'YandexDiskError'
    this.code = code
    this.status = status
  }
}

function normaliseDir(value) {
  const dir = String(value || 'Агент').trim().replace(/^disk:/, '').replace(/^\/+|\/+$/g, '')
  return dir === '' ? 'Агент' : dir
}

export class YandexDisk {
  constructor({ token, dir = 'Агент', fetchImpl = fetch, logger } = {}) {
    this.token = String(token || '').trim()
    this.dir = normaliseDir(dir)
    this.fetch = fetchImpl
    this.logger = logger
  }

  get enabled() {
    return this.token !== ''
  }

  get root() {
    return 'disk:/' + this.dir
  }

  async call(path, { method = 'GET', query } = {}) {
    if (!this.enabled) throw new YandexDiskError('Яндекс.Диск не настроен', 'not_configured', 503)
    const url = new URL(API + path)
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value))
    const response = await this.fetch(url, { method, headers: { Authorization: 'OAuth ' + this.token } })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      this.logger?.warn?.('yandex disk failed', { status: response.status, path })
      throw new YandexDiskError('Яндекс.Диск вернул ошибку ' + response.status, 'upstream', response.status === 404 ? 404 : 502)
    }
    return response
  }

  async list(path) {
    const response = await this.call('/resources', {
      query: { path, limit: MAX_FILES, sort: '-modified', fields: 'path,name,type,size,modified,created' },
    })
    const data = await response.json()
    return Array.isArray(data?._embedded?.items) ? data._embedded.items : []
  }

  /** Плоский список файлов в папках задач: [{task, name, path, size, modified}] */
  async listAgentFiles() {
    const top = await this.list(this.root)
    const files = []
    const push = (task, item) => {
      if (files.length >= MAX_FILES) return
      files.push({
        task,
        name: String(item.name || 'file'),
        path: String(item.path || ''),
        size: Number(item.size) || 0,
        modified: item.modified || item.created || null,
      })
    }
    for (const item of top) {
      if (files.length >= MAX_FILES) break
      if (item.type === 'file') {
        push('', item)
        continue
      }
      if (item.type !== 'dir') continue
      let children = []
      try {
        children = await this.list(item.path)
      } catch (error) {
        this.logger?.warn?.('yandex disk folder failed', { path: item.path, error: error?.message ?? error })
      }
      const task = String(item.name || '')
      for (const child of children) {
        if (child.type === 'file') push(task, child)
      }
    }
    return files
  }

  /** Скачать файл по пути `disk:/...`; путь обязан быть внутри папки агента. */
  async download(path) {
    const safe = this.safePath(path)
    const ticket = await this.call('/resources/download', { query: { path: safe } })
    const data = await ticket.json()
    const href = String(data?.href || '')
    if (!/^https:\/\//.test(href)) throw new YandexDiskError('Нет ссылки на скачивание')
    const response = await this.fetch(href)
    if (!response.ok) throw new YandexDiskError('Не удалось скачать файл', 'upstream')
    return Buffer.from(await response.arrayBuffer())
  }

  async remove(path) {
    const safe = this.safePath(path)
    await this.call('/resources', { method: 'DELETE', query: { path: safe } })
    return { ok: true }
  }

  safePath(path) {
    const value = String(path || '').replace(/^disk:/, '').replace(/^\/+/, '')
    const prefix = this.dir + '/'
    if (!value.startsWith(prefix)) throw new YandexDiskError('Чужой путь', 'forbidden', 403)
    return 'disk:/' + value
  }
}
