import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { createDiskStorage, formatDiskSize, joinPath, webdavPath, YandexDisk } from '../src/yandex-disk.mjs'
import { createBotHarness, createTestLogger } from './helpers.mjs'

const TOKEN = 'y0_AgAAAABtest-token'

/** A stub of the Disk REST API: metadata calls plus the upload/download hops. */
function stubDisk({ quota = { total_space: 10_000_000_000, used_space: 1_500_000_000, trash_size: 0 }, existing = [], fail } = {}) {
  const calls = []
  const files = new Map()
  const impl = async (url, options = {}) => {
    const parsed = new URL(url)
    const method = options.method ?? 'GET'
    calls.push({ url: parsed, method, body: options.body, auth: options.headers?.authorization })
    const key = `${method} ${parsed.pathname}`
    const respond = (status, payload) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => (payload === undefined ? '' : JSON.stringify(payload)),
      arrayBuffer: async () => Buffer.from(payload?.bytes ?? ''),
    })
    if (fail && key.startsWith(fail.on)) return respond(fail.status, { message: fail.message })

    if (parsed.pathname === '/v1/disk' || parsed.pathname === '/v1/disk/') return respond(200, quota)
    if (key === 'PUT /v1/disk/resources') {
      const target = parsed.searchParams.get('path')
      if (existing.includes(target)) return respond(409, { message: 'already exists' })
      existing.push(target)
      return respond(201, {})
    }
    if (key === 'GET /v1/disk/resources/upload') {
      const target = parsed.searchParams.get('path')
      return respond(200, { href: `https://upload.example/${encodeURIComponent(target)}`, method: 'PUT' })
    }
    if (parsed.host === 'upload.example' && method === 'PUT') {
      files.set(decodeURIComponent(parsed.pathname.slice(1)), options.body)
      return respond(201, {})
    }
    // Following the Link returned by publish: this must be checked before the
    // generic listing branch, exactly as the real API behaves.
    if (key === 'GET /v1/disk/resources' && parsed.searchParams.get('fields') === 'public_url') {
      return respond(200, { public_url: 'https://yadi.sk/i/test-link', path: parsed.searchParams.get('path') })
    }
    if (key === 'GET /v1/disk/resources') {
      const fields = parsed.searchParams.get('fields') ?? ''
      // The real API drops _embedded.items when the projection does not name them.
      if (!fields.includes('_embedded.items')) {
        return respond(200, { path: parsed.searchParams.get('path'), type: 'dir', name: 'Агент' })
      }
      return respond(200, { _embedded: { items: existing.filter((item) => item !== '/').map((item) => ({ name: item.split('/').pop(), path: item, size: 42, modified: '2026-10-09T12:00:00Z', type: 'file' })) } })
    }
    if (key === 'GET /v1/disk/resources/download') {
      const target = parsed.searchParams.get('path')
      return respond(200, { href: `https://download.example/${encodeURIComponent(target)}`, method: 'GET' })
    }
    if (parsed.host === 'download.example') return respond(200, { bytes: 'содержимое' })
    if (key === 'PUT /v1/disk/resources/publish') {
      // Real shape: the call answers with a Link, public_url comes from following it.
      const target = parsed.searchParams.get('path')
      return respond(200, { href: `https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent(target)}&fields=public_url`, method: 'GET', templated: false })
    }
    if (key === 'DELETE /v1/disk/resources') return respond(204)
    return respond(404, { message: 'not found' })
  }
  impl.calls = calls
  impl.files = files
  return impl
}

const client = (fetchImpl, options = {}) => new YandexDisk({ token: TOKEN, logger: createTestLogger(), fetchImpl, ...options })

test('paths are joined without doubling slashes', () => {
  assert.equal(joinPath('/Агент', '212558-ecs', 'файл.docx'), '/Агент/212558-ecs/файл.docx')
  assert.equal(joinPath('Агент/', '/подпапка/', '/имя'), '/Агент/подпапка/имя')
  assert.equal(joinPath(), '/')
})

test('sizes read like sizes', () => {
  assert.equal(formatDiskSize(0), '0 Б')
  assert.equal(formatDiskSize(2048), '2 КБ')
  assert.match(formatDiskSize(1_500_000_000), /1,4 ГБ|1.4 ГБ/)
})

test('a token is required, and a missing one is reported plainly', async () => {
  const fetchImpl = stubDisk()
  const off = new YandexDisk({ token: '', fetchImpl })
  assert.equal(off.enabled, false)
  const probe = await off.probe()
  assert.equal(probe.ok, false)
  assert.match(probe.error, /YANDEX_DISK_TOKEN/)
  assert.equal(fetchImpl.calls.length, 0)
})

test('the probe checks the token and creates the base folder', async () => {
  const fetchImpl = stubDisk()
  const result = await client(fetchImpl, { dir: '/Агент' }).probe()
  assert.equal(result.ok, true)
  assert.equal(result.dir, '/Агент')
  const created = fetchImpl.calls.find((call) => call.method === 'PUT' && call.url.pathname === '/v1/disk/resources')
  assert.equal(created.url.searchParams.get('path'), '/Агент')
  assert.equal(created.auth, `OAuth ${TOKEN}`)
})

test('an existing folder is not an error', async () => {
  const fetchImpl = stubDisk({ existing: ['/Агент'] })
  assert.equal((await client(fetchImpl, { dir: '/Агент' }).ensureDir('/Агент')).ok, true)
})

test('upload creates the folders, then puts the bytes at the signed url', async () => {
  const fetchImpl = stubDisk()
  const result = await client(fetchImpl).upload({ path: '/Агент/212558-ecs/most.txt', bytes: Buffer.from('мост работает') })

  assert.equal(result.ok, true)
  // The folders above the file exist.
  const created = fetchImpl.calls
    .filter((call) => call.method === 'PUT' && call.url.pathname === '/v1/disk/resources')
    .map((call) => call.url.searchParams.get('path'))
  assert.deepEqual(created, ['/Агент', '/Агент/212558-ecs'])
  // The bytes went to the returned href, without the OAuth header.
  const upload = fetchImpl.calls.find((call) => call.url.host === 'upload.example')
  assert.equal(upload.method, 'PUT')
  assert.equal(upload.auth, undefined, 'токен не уходит на чужой хост')
  assert.equal(fetchImpl.files.get('/Агент/212558-ecs/most.txt').toString(), 'мост работает')
})

test('a rejected token is explained, not thrown', async () => {
  const fetchImpl = stubDisk({ fail: { on: 'GET /v1/disk/resources/upload', status: 401, message: 'unauthorized' } })
  const result = await client(fetchImpl).upload({ path: '/Агент/1/a.txt', bytes: Buffer.from('x') })
  assert.equal(result.ok, false)
  assert.match(result.error, /не принял токен/)
})

test('an unreachable disk is reported, not thrown', async () => {
  const result = await client(async () => { throw new Error('ECONNREFUSED') }).upload({ path: '/Агент/1/a.txt', bytes: Buffer.from('x') })
  assert.equal(result.ok, false)
  assert.match(result.error, /недоступен/i)
})

test('listing and downloading work', async () => {
  const fetchImpl = stubDisk({ existing: ['/Агент', '/Агент/1/отчёт.docx'] })
  const listing = await client(fetchImpl).list('/Агент')
  assert.equal(listing.ok, true)
  assert.equal(listing.items.at(-1).path, '/Агент/1/отчёт.docx')

  const downloaded = await client(fetchImpl).download('/Агент/1/отчёт.docx')
  assert.equal(downloaded.ok, true)
  assert.equal(downloaded.bytes.toString(), 'содержимое')
})

test('publishing returns a link, following the Link the API answers with', async () => {
  const fetchImpl = stubDisk()
  const result = await client(fetchImpl).publish('/Агент/1/отчёт.docx')
  assert.equal(result.ok, true)
  assert.match(result.url, /yadi\.sk/)
  // The second call follows the returned href, as the real API requires.
  assert.equal(fetchImpl.calls.filter((call) => call.method === 'GET' && call.url.searchParams.get('fields') === 'public_url').length, 1)
})

test('a publish without a link is reported instead of an empty url', async () => {
  const broken = client(async (url, options = {}) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(options.method === 'PUT' ? {} : {}),
  }))
  const result = await broken.publish('/Агент/1/файл.txt')
  assert.equal(result.ok, false)
  assert.match(result.error, /ссылк/i)
})

test('deliverables of a finished task are archived on disk', async () => {
  const fetchImpl = stubDisk()
  const env = await createBotHarness({
    runner: {
      async run() {
        await fs.mkdir(path.join(env.ws, 'outbox'), { recursive: true })
        await fs.writeFile(path.join(env.ws, 'outbox', 'отчёт.docx'), 'документ')
        return { ok: true, exitCode: 0, timedOut: false, aborted: false, text: 'готово', sessionId: 's', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, steps: 1 }, tools: [], errors: [], stderr: '', durationMs: 20 }
      },
    },
  })
  try {
    env.bot.disk = client(fetchImpl)
    await env.bot.handleUpdate({ kind: 'message', id: 1, chat: { id: 42, type: 'private' }, from: { id: 42, name: 'В', isBot: false }, text: 'сделай отчёт по продажам', attachments: [], addressed: true, messageId: 30 })
    await env.bot.worker

    assert.equal(fetchImpl.files.has('/Агент/' + env.journal.recent(1)[0].id + '/отчёт.docx'), true, 'файл ушёл на Диск')
    assert.ok(env.platform.sent.some((entry) => /лежат на Яндекс\.Диске/.test(entry.markdown)), 'путь назван в чате')
    assert.ok(env.journal.recent(1)[0].disk.length === 1, 'путь записан в журнал')
  } finally {
    await env.close()
  }
})

test('a disk failure never spoils a finished task', async () => {
  const env = await createBotHarness({
    runner: {
      async run() {
        await fs.mkdir(path.join(env.ws, 'outbox'), { recursive: true })
        await fs.writeFile(path.join(env.ws, 'outbox', 'файл.txt'), 'данные')
        return { ok: true, exitCode: 0, timedOut: false, aborted: false, text: 'готово', sessionId: 's', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, steps: 1 }, tools: [], errors: [], stderr: '', durationMs: 20 }
      },
    },
  })
  try {
    env.bot.disk = client(stubDisk({ fail: { on: 'GET /v1/disk/resources/upload', status: 507, message: 'no space' } }))
    await env.bot.handleUpdate({ kind: 'message', id: 2, chat: { id: 42, type: 'private' }, from: { id: 42, name: 'В', isBot: false }, text: 'сделай файл', attachments: [], addressed: true, messageId: 31 })
    await env.bot.worker

    assert.equal(env.journal.recent(1)[0].status, 'done', 'задача осталась выполненной')
    assert.equal(env.platform.documents.length, 1, 'файл всё равно отправлен в Telegram')
  } finally {
    await env.close()
  }
})

test('the /disk command explains itself when the disk is off', async () => {
  const env = await createBotHarness()
  try {
    await env.bot.handleUpdate({ kind: 'message', id: 3, chat: { id: 42, type: 'private' }, from: { id: 42, name: 'В', isBot: false }, text: '/disk', attachments: [], addressed: true, messageId: 32 })
    await env.bot.worker
    assert.match(env.platform.sent.at(-1).markdown, /не подключён/)
  } finally {
    await env.close()
  }
})

test('the /disk command shows the folder and downloads a file into the workspace', async () => {
  const fetchImpl = stubDisk({ existing: ['/Агент', '/Агент/1/данные.csv'] })
  const env = await createBotHarness()
  try {
    env.bot.disk = client(fetchImpl)
    const say = async (text, messageId) => {
      await env.bot.handleUpdate({ kind: 'message', id: 4, chat: { id: 42, type: 'private' }, from: { id: 42, name: 'В', isBot: false }, text, attachments: [], addressed: true, messageId })
      await env.bot.worker
      return env.platform.sent.at(-1).markdown
    }
    assert.match(await say('/disk', 33), /Папка: \/Агент/)
    assert.match(await say('/disk get /Агент/1/данные.csv', 34), /inbox\/данные\.csv/)
    assert.equal(await fs.readFile(path.join(env.ws, 'inbox', 'данные.csv'), 'utf8'), 'содержимое')
    assert.match(await say('/disk link /Агент/1/данные.csv', 35), /yadi\.sk|disk\.yandex\.ru/)
  } finally {
    await env.close()
  }
})

// ─── WebDAV: тот же архив, но с паролем приложения вместо OAuth-приложения ───

/** A tiny WebDAV server stub: MKCOL, PUT, PROPFIND, GET, DELETE. */
function stubWebdav({ fail } = {}) {
  const calls = []
  const files = new Map()
  const impl = async (url, options = {}) => {
    const parsed = new URL(url)
    const method = options.method ?? 'GET'
    const path = decodeURIComponent(parsed.pathname)
    calls.push({ method, path, auth: options.headers?.authorization, depth: options.headers?.depth, body: options.body })
    const respond = (status, body = '') => ({ ok: status >= 200 && status < 300, status, text: async () => body, arrayBuffer: async () => Buffer.from(body) })
    if (fail && method === fail.on) return respond(fail.status, '<html>error</html>')
    if (method === 'MKCOL') {
      if (['/Агент', '/Агент/212558-ecs', '/Агент/backups'].includes(path)) return respond(405, 'exists')
      return respond(201, '')
    }
    if (method === 'PUT') {
      files.set(path, options.body)
      return respond(201, '')
    }
    if (method === 'PROPFIND') {
      const items = [...files.keys()].filter((item) => item.startsWith(path) && item !== path)
      const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">`
        + `<d:response><d:href>${encodeURI(path)}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`
        + items.map((item) => `<d:response><d:href>${encodeURI(item)}</d:href><d:propstat><d:prop><d:getcontentlength>12</d:getcontentlength><d:getlastmodified>Thu, 09 Oct 2026 12:00:00 GMT</d:getlastmodified><d:resourcetype/></d:prop></d:propstat></d:response>`).join('')
        + '</d:multistatus>'
      return { ok: true, status: 207, text: async () => xml, arrayBuffer: async () => Buffer.from(xml) }
    }
    if (method === 'GET') {
      if (!files.has(path)) return respond(404, 'not found')
      return respond(200, files.get(path).toString())
    }
    if (method === 'DELETE') {
      files.delete(path)
      return respond(204, '')
    }
    return respond(404, '')
  }
  impl.calls = calls
  impl.files = files
  return impl
}

const webdav = (fetchImpl, options = {}) => createDiskStorage({
  mode: 'webdav',
  login: 'user@yandex.ru',
  password: 'app-password',
  logger: createTestLogger(),
  fetchImpl,
  ...options,
})

test('webdav paths are encoded, cyrillic and spaces included', () => {
  assert.equal(webdavPath('/Агент/моя папка/отчёт 1.docx'), '/%D0%90%D0%B3%D0%B5%D0%BD%D1%82/%D0%BC%D0%BE%D1%8F%20%D0%BF%D0%B0%D0%BF%D0%BA%D0%B0/%D0%BE%D1%82%D1%87%D1%91%D1%82%201.docx')
})

test('webdav upload creates folders and sends basic auth, never the password in a url', async () => {
  const fetchImpl = stubWebdav()
  const result = await webdav(fetchImpl).upload({ path: '/Агент/212558-ecs/отчёт.docx', bytes: Buffer.from('документ') })

  assert.equal(result.ok, true)
  const mkcol = fetchImpl.calls.filter((call) => call.method === 'MKCOL').map((call) => call.path)
  assert.deepEqual(mkcol, ['/Агент', '/Агент/212558-ecs'])
  const put = fetchImpl.calls.find((call) => call.method === 'PUT')
  assert.equal(put.path, '/Агент/212558-ecs/отчёт.docx')
  assert.equal(put.auth, `Basic ${Buffer.from('user@yandex.ru:app-password').toString('base64')}`)
  // The credential never travels in the URL itself.
  assert.equal(fetchImpl.calls.some((call) => call.path.includes('app-password')), false)
})

test('an existing folder is fine, and a bad password is explained', async () => {
  const good = webdav(stubWebdav())
  assert.equal((await good.ensureDir('/Агент')).ok, true, '405 значит «уже есть»')

  const bad = webdav(stubWebdav({ fail: { on: 'MKCOL', status: 401 } }))
  const failed = await bad.ensureDir('/Агент')
  assert.equal(failed.ok, false)
  assert.match(failed.error, /не принял токен|401/)
})

test('webdav lists files and downloads them', async () => {
  const fetchImpl = stubWebdav()
  const client = webdav(fetchImpl)
  await client.upload({ path: '/Агент/1/данные.csv', bytes: Buffer.from('a;b;c') })

  const listing = await client.list('/Агент')
  assert.equal(listing.ok, true)
  assert.deepEqual(listing.items.map((item) => item.path), ['/Агент/1/данные.csv'])
  assert.equal(listing.items[0].size, 12)

  const downloaded = await client.download('/Агент/1/данные.csv')
  assert.equal(downloaded.ok, true)
  assert.equal(downloaded.bytes.toString(), 'a;b;c')
})

test('webdav admits it cannot publish links or show the quota', async () => {
  const client = webdav(stubWebdav())
  const published = await client.publish('/Агент/1/файл.txt')
  assert.equal(published.ok, false)
  assert.match(published.error, /OAuth/)
  const probe = await client.probe()
  assert.equal(probe.ok, true)
  assert.equal(probe.quotaKnown, false)
})

test('the factory picks the backend by mode', () => {
  assert.equal(createDiskStorage({ mode: 'rest', token: 'x' }).constructor.name, 'YandexDisk')
  assert.equal(createDiskStorage({ mode: 'webdav', login: 'u', password: 'p' }).constructor.name, 'YandexWebdav')
  assert.equal(createDiskStorage({}).constructor.name, 'YandexDisk')
})
