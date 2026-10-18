/**
 * Аккаунты мобильного сайта: владелец, второй человек, смена логина/пароля.
 * Проверяем файл, хеши, версии сессий и автоматический выбор Telegram id.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MobileUserStore, MobileUsersError, normalizeLogin, validateLogin } from '../src/mobile-users.mjs'
import { hashPassword, verifyPassword } from '../src/mobile-auth.mjs'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }
const OWNER_HASH = hashPassword('owner-pass', { N: 1024 })

async function tempStore(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-mobile-users-'))
  const file = path.join(dir, 'mobile-accounts.json')
  const store = new MobileUserStore({
    file,
    logger: silentLogger,
    seedUsers: options.seedUsers ?? [{
      login: 'andryukovy',
      passwordHash: OWNER_HASH,
      name: 'Вячеслав',
      userId: 777,
      role: 'owner',
    }],
  })
  await store.load()
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return { store, file, dir }
}

test('нормализация и проверка логина', () => {
  assert.equal(normalizeLogin('  Andryukovy '), 'andryukovy')
  assert.equal(validateLogin('andryukovy'), 'andryukovy')
  assert.throws(() => validateLogin('a'), MobileUsersError)
  assert.throws(() => validateLogin('маша'), MobileUsersError)
  assert.throws(() => validateLogin('bad login'), MobileUsersError)
})

test('первый запуск заводит владельца из env', async (t) => {
  const { store } = await tempStore(t)
  assert.equal(store.list().length, 1)
  const owner = store.findByLogin('andryukovy')
  assert.equal(owner.role, 'owner')
  assert.equal(owner.userId, 777)
  assert.equal(store.authenticate('andryukovy', 'owner-pass')?.login, 'andryukovy')
  assert.equal(store.authenticate('andryukovy', 'wrong'), null)
})

test('второй аккаунт: добавление, уникальность, свой id', async (t) => {
  const { store, file } = await tempStore(t)
  const masha = await store.add({ login: 'masha', password: '123', name: 'Маша', userId: 888 })
  assert.equal(masha.login, 'masha')
  assert.equal(masha.role, 'member')
  assert.equal(store.list().length, 2)
  assert.equal(store.freeUserId([777, 888, 999]), 999)
  await assert.rejects(() => store.add({ login: 'masha', password: 'x', userId: 999 }), /занят/)
  await assert.rejects(() => store.add({ login: 'other', password: 'x', userId: 888 }), /привязан/)

  const reopened = new MobileUserStore({ file, logger: silentLogger })
  await reopened.load()
  assert.equal(reopened.list().length, 2)
  assert.equal(reopened.authenticate('masha', '123')?.userId, 888)
})

test('смена логина и пароля поднимает версию и закрывает старые сессии', async (t) => {
  const { store } = await tempStore(t)
  const beforeVersion = store.findByLogin('andryukovy').version
  const result = await store.update('andryukovy', { login: 'owner', password: 'new-pass' })
  assert.equal(result.credentialChanged, true)
  assert.equal(result.user.login, 'owner')
  assert.equal(result.user.version, beforeVersion + 1)
  assert.equal(store.authenticate('andryukovy', 'owner-pass'), null)
  assert.equal(store.authenticate('owner', 'new-pass')?.login, 'owner')
  assert.equal(verifyPassword('new-pass', store.findByLogin('owner').passwordHash), true)
})

test('смена имени не делает сессии недействительными', async (t) => {
  const { store } = await tempStore(t)
  const before = store.findByLogin('andryukovy')
  const result = await store.update('andryukovy', { name: 'Вячеслав Иванович' })
  assert.equal(result.credentialChanged, false)
  assert.equal(result.user.name, 'Вячеслав Иванович')
  assert.equal(result.user.version, before.version)
})

test('слабый пароль разрешён (решение владельца), пустой — нет', async (t) => {
  const { store } = await tempStore(t)
  await store.add({ login: 'masha', password: '123', name: 'Маша', userId: 888 })
  assert.equal(store.authenticate('masha', '123')?.login, 'masha')
  await assert.rejects(() => store.add({ login: 'empty', password: '', userId: 999 }), /пароль/i)
})
