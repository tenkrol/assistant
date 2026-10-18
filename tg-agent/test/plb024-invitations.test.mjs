/**
 * PLB-024: приглашения с принятием (P2-2 продуктового ревью).
 *
 * Проверяем дельту `core`: pending не даёт доступа, принятие своим аккаунтом
 * делает участником, пересланный код третьему лицу не работает и остаётся в
 * журнале, просроченное и отозванное приглашение бесполезно, одинаковый
 * числовой id на разных платформах не смешивается, миграция сохраняет
 * существующих участников (Машу) и идемпотентна.
 *
 * Все хранилища работают на временных файлах: проверяется настоящая запись и
 * чтение. Даты вычисляются от `Date.now()` или подменённых часов.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ScopeStore, migrateScopeMembers, INVITATION_TTL_MS } from '../src/scopes.mjs'
import { createAccess } from '../src/core/access.mjs'
import { createProjectCommands } from '../src/core/projects.mjs'
import { ReminderStore } from '../src/reminders.mjs'
import { loadConfig } from '../src/config.mjs'
import { createInstance } from '../src/index.mjs'
import { testEnv } from './helpers.mjs'

/** Логгер, который запоминает журнал: попытки принять чужое приглашение видны. */
function makeLogger() {
  return {
    entries: [],
    debug() {},
    info() {},
    error() {},
    warn(event, details) {
      this.entries.push({ event, ...details })
    },
  }
}

/** Временный мир: пространства, доступ, напоминания и команды. */
async function makeWorld({ platform = 'telegram', clock } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-plb024-'))
  const logger = makeLogger()
  const now = clock ?? { value: new Date('2026-10-18T12:00:00.000Z') }
  const store = new ScopeStore({
    file: path.join(dir, 'scopes.json'),
    logger,
    platform,
    now: () => now.value,
  })
  await store.load()
  const access = createAccess({ store, platform, logger })
  const reminders = new ReminderStore({
    file: path.join(dir, 'reminders.json'),
    logger,
    access,
    now: () => now.value,
  })
  await reminders.load()
  const sent = []
  const bot = {
    access,
    scopes: { store },
    platform: { name: platform },
    logger,
    send: async (chatId, text) => {
      sent.push({ chatId, text })
    },
  }
  const projects = createProjectCommands(bot)
  return {
    dir,
    logger,
    now,
    store,
    access,
    reminders,
    sent,
    projects,
    /** Сообщение из проверенного контекста платформы. */
    message: (userId, chatId = userId, type = 'private') => ({ from: { id: userId }, chat: { id: chatId, type } }),
    cleanup: async () => {
      await store.flush()
      await reminders.flush()
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
  }
}

/** Код из ответа владельцу: «Код: `ABCD2345`». */
const codeOf = (text) => {
  const match = /Код: `([A-Z2-9]+)`/.exec(String(text))
  assert.ok(match, `код в ответе: ${text}`)
  return match[1]
}

test('PLB-024: pending не даёт доступа, принятие своим аккаунтом делает участником', async () => {
  const world = await makeWorld()
  try {
    const { store, access, reminders, projects, sent } = world
    await projects.run({ args: 'new Семья' }, world.message(1, 555))
    assert.equal(store.activeScopeId(1, 555), 'project-1')

    // Общая запись проекта: до принятия B её не видит.
    reminders.reminders.push({
      id: 'shared-1',
      chatId: 555,
      userId: 1,
      scope_id: 'project-1',
      text: 'купить краску',
      dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      repeat: 'none',
      createdAt: new Date(Date.now()).toISOString(),
    })
    assert.equal(access.canReadScope(2, 'project-1'), false, 'посторонний не читает проект')
    assert.deepEqual(access.sharedScopes(2), [])

    await projects.run({ args: 'invite 2 editor' }, world.message(1, 555))
    const code = codeOf(sent.at(-1).text)
    // Код передан получателю лично (в его чат), а не только владельцу.
    const direct = sent.find((item) => String(item.chatId) === '2' && /Вас пригласили/.test(item.text))
    assert.ok(direct, 'код отправлен получателю')
    assert.match(direct.text, new RegExp(code))
    assert.match(direct.text, /\/project accept/)
    const invitation = store.invitationByCode(code)
    assert.equal(invitation.status, 'pending')
    assert.equal(invitation.role, 'editor')
    assert.equal(invitation.inviteePrincipal, 'telegram:2')
    assert.equal(invitation.inviterPrincipal, 'telegram:1')
    assert.equal(invitation.scopeId, 'project-1')
    assert.ok(Date.parse(invitation.expiresAt) - Date.parse(invitation.createdAt) === INVITATION_TTL_MS)
    assert.equal(store.member('project-1', 2), undefined, 'pending не попадает в members')

    // До принятия: нет ни списка проекта, ни поиска, ни данных.
    assert.equal(access.canReadScope(2, 'project-1'), false)
    assert.deepEqual(access.sharedScopes(2), [])
    assert.deepEqual(reminders.list(777, 2), [], 'записи проекта не видны')
    await projects.run({ args: 'list' }, world.message(2, 777))
    assert.doesNotMatch(sent.at(-1).text, /project-1/)

    // B принимает своим подтверждённым аккаунтом.
    await projects.run({ args: `accept ${code}` }, world.message(2, 777))
    assert.match(sent.at(-1).text, /Приглашение принято/)
    assert.equal(access.canReadScope(2, 'project-1'), true)
    assert.equal(access.roleOf(2, store.get('project-1')), 'editor')
    assert.deepEqual(reminders.list(777, 2).map((item) => item.text), ['купить краску'])
    assert.equal(store.invitationByCode(code).status, 'accepted')

    // Схема приглашения на диске: все поля дельты.
    await store.flush()
    const saved = JSON.parse(await fs.readFile(path.join(world.dir, 'scopes.json'), 'utf8'))
    assert.equal(saved.invitations.length, 1)
    for (const field of ['id', 'scopeId', 'inviterPrincipal', 'inviteePrincipal', 'role', 'status', 'code', 'expiresAt', 'createdAt']) {
      assert.ok(saved.invitations[0][field] !== undefined, `поле ${field}`)
    }
    assert.equal(saved.scopes['project-1'].members.find((member) => member.principal === 'telegram:2').platform, 'telegram')
  } finally {
    await world.cleanup()
  }
})

test('PLB-024: пересланный код третьему лицу не даёт доступа и попадает в журнал', async () => {
  const world = await makeWorld()
  try {
    const { store, access, projects, sent, logger } = world
    await projects.run({ args: 'new Дача' }, world.message(1, 555))
    await projects.run({ args: 'invite 2 viewer' }, world.message(1, 555))
    const code = codeOf(sent.at(-1).text)

    // Третье лицо получило код пересылкой и пробует принять его собой.
    await projects.run({ args: `accept ${code}` }, world.message(3, 999))
    assert.match(sent.at(-1).text, /адресовано другому человеку/)
    assert.equal(store.member('project-1', 3), undefined, 'третье лицо не стало участником')
    assert.equal(access.canReadScope(3, 'project-1'), false)
    assert.deepEqual(access.sharedScopes(3), [])
    assert.equal(store.invitationByCode(code).status, 'pending', 'чужой не сжёг приглашение')

    const denial = logger.entries.find((entry) => entry.event === 'invitation accept denied' && entry.reason === 'foreign')
    assert.ok(denial, 'попытка в журнале')
    assert.equal(denial.actor, 'telegram:3')
    assert.equal(denial.invitee, 'telegram:2')
    assert.equal(denial.scopeId, 'project-1')

    // Настоящий адресат тем же кодом принимает успешно.
    await projects.run({ args: `accept ${code}` }, world.message(2, 777))
    assert.match(sent.at(-1).text, /Приглашение принято/)
    assert.equal(access.canReadScope(2, 'project-1'), true)
  } finally {
    await world.cleanup()
  }
})

test('PLB-024: просроченное, отозванное и отклонённое приглашение не дают доступа', async () => {
  const clock = { value: new Date('2026-10-18T12:00:00.000Z') }
  const world = await makeWorld({ clock })
  try {
    const { store, access, projects, sent } = world
    await projects.run({ args: 'new Поездка' }, world.message(1, 555))

    // Просроченное: срок вышел, принимать нельзя.
    await projects.run({ args: 'invite 2 editor' }, world.message(1, 555))
    const expiredCode = codeOf(sent.at(-1).text)
    clock.value = new Date(clock.value.getTime() + INVITATION_TTL_MS + 60_000)
    await projects.run({ args: `accept ${expiredCode}` }, world.message(2, 777))
    assert.match(sent.at(-1).text, /истекло/)
    assert.equal(access.canReadScope(2, 'project-1'), false)
    assert.equal(store.invitationByCode(expiredCode).status, 'expired')

    // Отозванное владельцем.
    await projects.run({ args: 'invite 3 viewer' }, world.message(1, 555))
    const revokedCode = codeOf(sent.at(-1).text)
    await projects.run({ args: 'revoke 3' }, world.message(1, 555))
    assert.match(sent.at(-1).text, /отозвано/)
    assert.equal(store.invitationByCode(revokedCode).status, 'revoked')
    await projects.run({ args: `accept ${revokedCode}` }, world.message(3, 888))
    assert.match(sent.at(-1).text, /отозвано/)
    assert.equal(access.canReadScope(3, 'project-1'), false)

    // Отклонённое: доступ не появляется, повторное принятие отклоняется.
    await projects.run({ args: 'invite 4 viewer' }, world.message(1, 555))
    const declinedCode = codeOf(sent.at(-1).text)
    await projects.run({ args: `decline ${declinedCode}` }, world.message(4, 444))
    assert.match(sent.at(-1).text, /отклонено/)
    assert.equal(access.canReadScope(4, 'project-1'), false)
    assert.equal(store.invitationByCode(declinedCode).status, 'declined')
    await projects.run({ args: `accept ${declinedCode}` }, world.message(4, 444))
    assert.match(sent.at(-1).text, /уже отклонено/)
    assert.equal(access.canReadScope(4, 'project-1'), false)
  } finally {
    await world.cleanup()
  }
})

test('PLB-024: telegram:7 и vk:7 — разные люди, чужой проект недоступен', async () => {
  const world = await makeWorld({ platform: 'telegram' })
  try {
    const { store } = world
    const telegram = world.access
    const vk = createAccess({ store, platform: 'vk', logger: world.logger })

    const project = store.create({ title: 'Семья', ownerId: 1 })
    assert.equal(telegram.principalOf(7), 'telegram:7')
    assert.equal(vk.principalOf(7), 'vk:7')

    // Приглашение адресовано telegram:7.
    const invitation = store.invite(project.id, 'telegram:7', 'viewer', { inviterPrincipal: 'telegram:1' })

    // Тот же код, принятый vk:7, не работает: это другой человек.
    const foreign = store.acceptInvitation(invitation.code, vk.principalOf(7))
    assert.equal(foreign.ok, false)
    assert.equal(foreign.reason, 'foreign')
    assert.equal(vk.canReadScope(7, project.id), false, 'vk:7 не получает чужой проект')
    assert.deepEqual(vk.sharedScopes(7), [])
    assert.equal(vk.canRead(7, { id: 'r', scope_id: project.id, userId: 1 }), false)
    assert.ok(world.logger.entries.some((entry) => entry.event === 'invitation accept denied'
      && entry.reason === 'foreign'
      && entry.actor === 'vk:7'))

    // Настоящий адресат telegram:7 принимает и получает доступ.
    assert.equal(store.acceptInvitation(invitation.code, telegram.principalOf(7)).ok, true)
    assert.equal(telegram.canReadScope(7, project.id), true)

    // Своё приглашение vk:7 принимает и получает доступ как отдельный участник.
    const vkInvitation = store.invite(project.id, 'vk:7', 'viewer', { inviterPrincipal: 'telegram:1' })
    assert.equal(store.acceptInvitation(vkInvitation.code, vk.principalOf(7)).ok, true)
    assert.equal(vk.canReadScope(7, project.id), true)
    const members = store.get(project.id).members
    assert.ok(members.some((member) => member.principal === 'telegram:7' && member.platform === 'telegram'))
    assert.ok(members.some((member) => member.principal === 'vk:7' && member.platform === 'vk'))

    // Отзыв vk:7 не задевает telegram:7 с тем же числовым id.
    assert.equal(store.revokeAccess(project.id, 'vk:7').kind, 'member')
    assert.equal(vk.canReadScope(7, project.id), false, 'vk:7 отозван')
    assert.equal(telegram.canReadScope(7, project.id), true, 'telegram:7 остался')
  } finally {
    await world.cleanup()
  }
})

test('PLB-024: миграция сохраняет Машу, добавляет платформу, копия одна и повтор пустой', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-plb024-legacy-'))
  try {
    const file = path.join(dir, 'scopes.json')
    const legacy = {
      version: 1,
      nextProjectId: 2,
      active: {},
      scopes: {
        'project-1': {
          id: 'project-1',
          kind: 'shared',
          title: 'Семья',
          ownerId: 1,
          members: [
            { userId: 1, role: 'owner' },
            { userId: 2, role: 'editor' },
          ],
          status: 'active',
          version: 1,
          createdAt: '2026-10-01T00:00:00.000Z',
        },
        'personal-2': {
          id: 'personal-2',
          kind: 'personal',
          title: 'Личное',
          ownerId: 2,
          members: [{ userId: 2, role: 'owner' }],
          status: 'active',
          version: 1,
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      },
    }
    await fs.writeFile(file, JSON.stringify(legacy, null, 2))
    const original = await fs.readFile(file, 'utf8')
    const logger = makeLogger()

    const store = new ScopeStore({ file, logger, platform: 'telegram' })
    await store.load()
    assert.equal(store.needsMemberMigration(), true)
    // До миграции старый участник уже читает проект (id без платформы).
    const access = createAccess({ store, platform: 'telegram', logger })
    assert.equal(access.canReadScope(2, 'project-1'), true)
    assert.equal(access.canWriteScope(2, 'project-1'), true)

    const first = await migrateScopeMembers({
      store,
      backupDir: path.join(dir, 'backups'),
      logger,
      now: () => new Date('2026-10-18T12:00:00.000Z'),
    })
    assert.equal(first.migrated, 5, 'владелец и участники обоих пространств')
    const backupDirs = (await fs.readdir(path.join(dir, 'backups'))).filter((name) => name.startsWith('scope-member-migration-'))
    assert.equal(backupDirs.length, 1, 'копия ровно одна')
    assert.equal(
      await fs.readFile(path.join(dir, 'backups', backupDirs[0], 'scopes.json'), 'utf8'),
      original,
      'копия сделана до изменения',
    )

    // Маша (2) осталась участником, роль не изменилась, появился principal.
    const masha = store.member('project-1', 'telegram:2')
    assert.ok(masha, 'существующий участник не потерян')
    assert.equal(masha.role, 'editor')
    assert.equal(masha.platform, 'telegram')
    assert.equal(masha.principal, 'telegram:2')
    assert.equal(store.member('personal-2', 'telegram:2').role, 'owner')
    assert.equal(access.canReadScope(2, 'project-1'), true)
    assert.equal(access.canWriteScope(2, 'project-1'), true)
    assert.equal(store.needsMemberMigration(), false)

    const afterFirst = await fs.readFile(file, 'utf8')
    const saved = JSON.parse(afterFirst)
    assert.equal(saved.scopes['project-1'].members[1].principal, 'telegram:2')
    assert.equal(saved.scopes['project-1'].ownerPlatform, 'telegram')

    // Повторный запуск: ничего не меняет и не создаёт вторую копию.
    const reopened = new ScopeStore({ file, logger, platform: 'telegram' })
    await reopened.load()
    assert.equal(reopened.needsMemberMigration(), false)
    const second = await migrateScopeMembers({
      store: reopened,
      backupDir: path.join(dir, 'backups'),
      logger,
      now: () => new Date('2026-10-18T12:05:00.000Z'),
    })
    assert.equal(second.migrated, 0)
    assert.equal(second.backupDir, undefined)
    assert.equal(await fs.readFile(file, 'utf8'), afterFirst, 'файл не переписан')
    const afterSecond = (await fs.readdir(path.join(dir, 'backups'))).filter((name) => name.startsWith('scope-member-migration-'))
    assert.equal(afterSecond.length, 1, 'вторая копия не создана')
    assert.equal(reopened.member('project-1', 'telegram:2').role, 'editor', 'Маша на месте после перезапуска')
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

/** Платформа-заглушка: сборка бота без сети. */
function fakePlatform() {
  return {
    name: 'telegram',
    namespace: 'tg',
    identity: { id: 1, username: 'stub' },
    async start() {},
    async stop() {},
    async getUpdates({ signal } = {}) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
      return { updates: [], cursor: undefined }
    },
    async sendText() { return { messageId: 1 } },
    async editText() {},
    async answerCallback() {},
    async sendTyping() {},
  }
}

test('PLB-024: запуск бота мигрирует участников с копией и не повторяет миграцию', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-plb024-startup-'))
  try {
    const file = path.join(dir, 'scopes.json')
    const legacy = {
      version: 1,
      nextProjectId: 2,
      active: {},
      scopes: {
        'project-1': {
          id: 'project-1',
          kind: 'shared',
          title: 'Семья',
          ownerId: 1,
          members: [{ userId: 1, role: 'owner' }, { userId: 2, role: 'editor' }],
          status: 'active',
          version: 1,
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      },
    }
    await fs.writeFile(file, JSON.stringify(legacy))
    const original = await fs.readFile(file, 'utf8')
    const config = loadConfig(testEnv({
      telegramApiBase: 'http://127.0.0.1:1',
      modelBaseUrl: 'http://127.0.0.1:1',
      dataDir: dir,
      overrides: { STREAM: 'false', DIGEST: 'false', REMINDERS: 'true', MEMORY: 'true' },
    }))
    const instance = { label: 'main', platform: 'telegram', token: config.telegram.token, namespace: 'telegram' }
    const shared = { model: { name: 'stub' } }

    const first = await createInstance({ config, logger: makeLogger(), instance, shared, platformFactory: async () => fakePlatform() })
    await first.bot.stop()
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    const masha = saved.scopes['project-1'].members.find((member) => member.principal === 'telegram:2')
    assert.ok(masha, 'Маша осталась участником')
    assert.equal(masha.role, 'editor')
    assert.equal(masha.platform, 'telegram')
    const backups = (await fs.readdir(path.join(dir, 'backups'))).filter((name) => name.startsWith('scope-member-migration-'))
    assert.equal(backups.length, 1, 'копия одна')
    assert.equal(await fs.readFile(path.join(dir, 'backups', backups[0], 'scopes.json'), 'utf8'), original, 'копия до записи')

    // Второй запуск: файл не переписан, новой копии нет.
    const snapshot = await fs.readFile(file, 'utf8')
    const second = await createInstance({ config, logger: makeLogger(), instance, shared, platformFactory: async () => fakePlatform() })
    await second.bot.stop()
    assert.equal(await fs.readFile(file, 'utf8'), snapshot)
    const after = (await fs.readdir(path.join(dir, 'backups'))).filter((name) => name.startsWith('scope-member-migration-'))
    assert.equal(after.length, 1)
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
