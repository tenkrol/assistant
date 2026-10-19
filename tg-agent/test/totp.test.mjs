import test from 'node:test'
import assert from 'node:assert/strict'
import { base32Decode, base32Encode, generateTotpSecret, totpCode, verifyTotp } from '../src/totp.mjs'

test('TOTP: base32 и известный вектор RFC 6238', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'))
  assert.equal(base32Decode(secret).toString(), '12345678901234567890')
  assert.equal(totpCode(secret, { at: 59_000 }), '287082')
  assert.equal(verifyTotp(secret, '287082', { at: 59_000 }), true)
  assert.equal(verifyTotp(secret, '000000', { at: 59_000 }), false)
  assert.equal(generateTotpSecret().length, 32)
})
