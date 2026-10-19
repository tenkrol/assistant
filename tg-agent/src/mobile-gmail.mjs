/**
 * Gmail OAuth для мобильного сайта: refresh-токены по аккаунтам и тонкий
 * клиент Gmail API. Письма читаются только по запросу пользователя.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createJsonStore } from './storage/json-store.mjs'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

export class GmailError extends Error {
  constructor(message, code = 'gmail_error', status = 502) {
    super(message)
    this.code = code
    this.status = status
  }
}

export class GmailTokenStore {
  constructor({ file, logger } = {}) {
    this.logger = logger
    this.storage = createJsonStore({ file, version: 1, defaults: { tokens: {} }, logger })
  }

  async load() {
    await this.storage.load()
    if (!this.storage.state.tokens || typeof this.storage.state.tokens !== 'object') this.storage.state.tokens = {}
    await fs.promises.mkdir(path.dirname(this.storage.file), { recursive: true })
    return this
  }

  get(userId) {
    const value = this.storage.state.tokens[String(userId)]
    return value && typeof value.refreshToken === 'string' ? value : undefined
  }

  async set(userId, data) {
    this.storage.state.tokens[String(userId)] = { ...data, updatedAt: new Date().toISOString() }
    await this.storage.flush()
  }

  async remove(userId) {
    delete this.storage.state.tokens[String(userId)]
    await this.storage.flush()
  }
}

export class GmailClient {
  constructor({ clientId, clientSecret, redirectUri, logger, fetchImpl = fetch } = {}) {
    this.clientId = String(clientId || '')
    this.clientSecret = String(clientSecret || '')
    this.redirectUri = String(redirectUri || 'https://tenkrol.ru/api/gmail/callback')
    this.logger = logger
    this.fetch = fetchImpl
  }

  get configured() {
    return this.clientId !== '' && this.clientSecret !== ''
  }

  authUrl(state, { loginHint } = {}) {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.searchParams.set('client_id', this.clientId)
    url.searchParams.set('redirect_uri', this.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', 'https://www.googleapis.com/auth/gmail.readonly')
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
    url.searchParams.set('state', state)
    if (loginHint) url.searchParams.set('login_hint', loginHint)
    return url.toString()
  }

  async exchangeCode(code) {
    const body = new URLSearchParams({
      code: String(code),
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
    })
    const response = await this.fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
    if (!response.ok) throw new GmailError('Google не принял код авторизации')
    return response.json()
  }

  async accessToken(refreshToken) {
    const body = new URLSearchParams({
      refresh_token: String(refreshToken),
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
    })
    const response = await this.fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
    if (!response.ok) throw new GmailError('Не удалось обновить доступ к Gmail', 'reauth', 401)
    const data = await response.json()
    return String(data.access_token || '')
  }

  async call(accessToken, pathname, query = {}) {
    const url = new URL(API + pathname)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))
    const response = await this.fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } })
    if (response.status === 401) throw new GmailError('Нужно заново подключить Gmail', 'reauth', 401)
    if (!response.ok) throw new GmailError('Gmail вернул ошибку ' + response.status)
    return response.json()
  }

  async list(accessToken, { q = '', max = 15 } = {}) {
    const data = await this.call(accessToken, '/messages', { maxResults: Math.min(Number(max) || 15, 30), ...(q ? { q } : {}) })
    const messages = []
    for (const item of data.messages ?? []) {
      try {
        const meta = await this.call(accessToken, '/messages/' + encodeURIComponent(item.id), {
          format: 'metadata',
          metadataHeaders: 'From',
        })
        const headers = new Map((meta.payload?.headers ?? []).map((header) => [String(header.name).toLowerCase(), header.value]))
        messages.push({
          id: item.id,
          threadId: item.threadId,
          from: headers.get('from') || '',
          subject: headers.get('subject') || '(без темы)',
          date: headers.get('date') || '',
          snippet: meta.snippet || '',
          unread: Array.isArray(meta.labelIds) && meta.labelIds.includes('UNREAD'),
        })
      } catch (error) {
        this.logger?.warn?.('gmail message metadata failed', { id: item.id, error: error?.message ?? error })
      }
    }
    return messages
  }

  async message(accessToken, id) {
    const data = await this.call(accessToken, '/messages/' + encodeURIComponent(id), { format: 'full' })
    const headers = new Map((data.payload?.headers ?? []).map((header) => [String(header.name).toLowerCase(), header.value]))
    const parts = []
    const walk = (part) => {
      if (!part) return
      if (part.mimeType === 'text/plain' && part.body?.data) {
        parts.push(Buffer.from(part.body.data, 'base64url').toString('utf8'))
      }
      for (const child of part.parts ?? []) walk(child)
    }
    walk(data.payload)
    return {
      id: data.id,
      from: headers.get('from') || '',
      to: headers.get('to') || '',
      subject: headers.get('subject') || '(без темы)',
      date: headers.get('date') || '',
      text: parts.join('\n').slice(0, 100_000),
    }
  }
}
