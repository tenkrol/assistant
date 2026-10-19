/**
 * TOTP (RFC 6238) без зависимостей: секрет base32, код 6 цифр, окно ±1 шаг.
 * Используется для двухфакторной защиты входа по паролю на мобильном сайте.
 */
import crypto from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buffer) {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31]
  return output
}

export function base32Decode(value) {
  const clean = String(value || '').toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let current = 0
  const bytes = []
  for (const char of clean) {
    const index = ALPHABET.indexOf(char)
    if (index === -1) continue
    current = (current << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((current >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20))
}

export function totpCode(secret, { at = Date.now(), step = 30, digits = 6 } = {}) {
  const key = base32Decode(secret)
  if (key.length === 0) throw new Error('Пустой TOTP-секрет')
  const counter = Math.floor(at / 1000 / step)
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(BigInt(counter))
  const digest = crypto.createHmac('sha1', key).update(buffer).digest()
  const offset = digest[digest.length - 1] & 15
  const binary = digest.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 10 ** digits).padStart(digits, '0')
}

export function verifyTotp(secret, code, { at = Date.now(), step = 30, window = 1 } = {}) {
  const value = String(code || '').replace(/\s+/g, '')
  if (!/^\d{6}$/.test(value)) return false
  for (let offset = -window; offset <= window; offset += 1) {
    if (totpCode(secret, { at: at + offset * step * 1000, step }) === value) return true
  }
  return false
}

export function totpUri({ secret, login, issuer = 'TenKrol' }) {
  const label = encodeURIComponent(`${issuer}:${login}`)
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' })
  return `otpauth://totp/${label}?${params.toString()}`
}
