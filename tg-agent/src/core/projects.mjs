/**
 * Команда `/project`: общие пространства и активный проект.
 *
 * Ядро не решает права само — каждая проверка идёт через `bot.access`, то есть
 * `src/core/access.mjs`. Идентичность берётся из проверенного сообщения
 * (`message.from.id`), а не из аргументов модели.
 *
 * Тексты короткие: команда должна отвечать одной-двумя строками.
 */
const USAGE = [
  '**Проекты**',
  '`/project new <название>` — создать общий проект',
  '`/project list` — список и активный проект',
  '`/project use <id>` — выбрать активный',
  '`/project invite <userId> [viewer|editor]` — пригласить',
  '`/project accept <код>` — принять приглашение',
  '`/project decline <код>` — отклонить приглашение',
  '`/project revoke <userId>` — отозвать доступ',
  '`/project archive <id>` — отправить в архив',
].join('\n')

/** Числовой id или явный principal `<платформа>:<id>`. */
const TARGET_RE = /^(?:[a-z][a-z0-9-]{0,31}:)?\d{1,20}$/i

/** Строка проекта для списка. */
const projectLine = (scope, activeId, userId, role) => {
  const active = scope.id === activeId ? ' · активен' : ''
  const status = scope.status === 'archived' ? ' · архив' : ''
  return `• \`${scope.id}\` — ${scope.title}${status}${active} (${scope.kind === 'personal' ? 'личное' : role ?? 'нет доступа'})`
}

/** Понятный текст отказа для роли viewer. */
export const READ_ONLY_TEXT = 'Только просмотр: в этом проекте у вас роль viewer, изменения недоступны.'

/**
 * Собрать обработчик `/project`.
 *
 * @param {object} bot - экземпляр `Assistant` с `access`, `scopes`, `send`.
 * @returns {{run: (command: {args: string}, message: object) => Promise<void>}} обработчик.
 */
export function createProjectCommands(bot) {
  const store = () => bot.scopes?.store
  const access = () => bot.access
  // Платформа — из адаптера, а не из текста команды: иначе id одной сети можно
  // было бы выдать за человека другой.
  const platformName = () => String(bot.platform?.name ?? bot.access?.platform ?? 'telegram').toLowerCase()
  const principalOf = (userId) => access().principalOf(userId)

  /** Ответ в тот же чат и только от имени проверенного пользователя. */
  async function say(message, text) {
    await bot.send(message.chat.id, text)
  }

  async function list(message, userId) {
    const accessRules = access()
    const scopeStore = store()
    const activeId = scopeStore?.activeScopeId(userId, message.chat.id)
    const personal = accessRules.scopeOf(userId)
    const shared = accessRules.sharedScopes(userId)
    await say(message, [
      '**Проекты**',
      projectLine(personal, activeId, userId, accessRules.roleOf(userId, personal)),
      ...shared.map((scope) => projectLine(scope, activeId, userId, accessRules.roleOf(userId, scope))),
      '',
      'Выбрать: `/project use <id>`. Новый: `/project new <название>`.',
    ].join('\n'))
  }

  async function create(message, userId, title) {
    const clean = String(title ?? '').trim()
    if (clean === '') {
      await say(message, 'Название проекта? Например: `/project new Ремонт`.')
      return
    }
    const scopeStore = store()
    const scope = scopeStore.create({ title: clean, ownerId: userId, ownerPlatform: access().platform })
    scopeStore.setActive(userId, message.chat.id, scope.id)
    await scopeStore.flush()
    await say(message, `Проект «${scope.title}» создан: \`${scope.id}\`. Вы владелец, проект активен.`)
  }

  async function use(message, userId, id) {
    const scope = store()?.get(id)
    if (!scope || !access().canReadScope(userId, scope.id)) {
      await say(message, 'Проекта с таким id нет или нет доступа. Список — `/project list`.')
      return
    }
    if (scope.status === 'archived') {
      await say(message, 'Этот проект в архиве: история доступна в списке, но активным он не станет.')
      return
    }
    store().setActive(userId, message.chat.id, scope.id)
    await store().flush()
    await say(message, `Активный проект: «${scope.title}» (\`${scope.id}\`).`)
  }

  /** Проект, в который приглашаем: только активный общий и только свой. */
  async function managedScope(message, userId) {
    const scope = access().activeScope(userId, message.chat.id)
    if (!scope || scope.kind !== 'shared') {
      await say(message, 'Сначала выберите общий проект: `/project use <id>`.')
      return undefined
    }
    if (!access().canManageScope(userId, scope)) {
      await say(message, 'Управлять проектом может только владелец.')
      return undefined
    }
    return scope
  }

  async function invite(message, userId, rawTarget, rawRole) {
    const scope = await managedScope(message, userId)
    if (!scope) return
    const target = String(rawTarget ?? '').trim()
    if (!TARGET_RE.test(target)) {
      await say(message, 'Нужен числовой userId. Например: `/project invite 123456789`.')
      return
    }
    const targetPrincipal = principalOf(target)
    if (targetPrincipal === principalOf(userId)) {
      await say(message, 'Вы уже владелец этого проекта.')
      return
    }
    const role = String(rawRole ?? '').trim().toLowerCase() || 'editor'
    if (role !== 'editor' && role !== 'viewer') {
      await say(message, 'Роль в проекте: `editor` (может менять) или `viewer` (только смотрит).')
      return
    }
    const existing = store().member(scope.id, targetPrincipal)
    if (existing) {
      await say(message, `Пользователь ${target} уже участник с ролью ${existing.role}.`)
      return
    }
    // Приглашение только создаётся: в `members` оно попадёт после accept.
    const invitation = store().invite(scope.id, targetPrincipal, role, {
      inviterPrincipal: principalOf(userId),
    })
    await store().flush()
    const days = Math.max(1, Math.round((Date.parse(invitation.expiresAt) - Date.parse(invitation.createdAt)) / 86_400_000))
    await say(
      message,
      `Пользователь ${target} приглашён в «${scope.title}» с ролью ${role}. `
      + `Код: \`${invitation.code}\` (действует ${days} дн.). Передайте код получателю.`,
    )
    const targetPlatform = target.includes(':') ? target.split(':')[0].toLowerCase() : platformName()
    const targetUserId = target.includes(':') ? target.split(':').slice(1).join(':') : target
    // Прямое сообщение получателю — только на своей платформе и только в личный
    // чат: иначе код ушёл бы в общий чат или человеку с тем же id в другой сети.
    if (
      targetPlatform === platformName()
      && message.chat?.type === 'private'
      && targetUserId !== String(message.chat?.id)
    ) {
      // Ошибка доставки не отменяет приглашение: владелец уже видит код.
      try {
        await bot.send(
          targetUserId,
          `Вас пригласили в проект «${scope.title}» с ролью ${role}.\n`
          + `Код: \`${invitation.code}\`\n`
          + `Принять: \`/project accept ${invitation.code}\`\n`
          + `Отклонить: \`/project decline ${invitation.code}\``,
        )
      } catch (error) {
        bot.logger?.warn?.('invitation direct send failed', {
          scopeId: scope.id,
          error: error?.message ?? error,
        })
      }
    }
  }

  /** Общий отказ на недействительное приглашение. */
  async function refused(message, result) {
    if (result.reason === 'foreign') {
      await say(message, 'Это приглашение адресовано другому человеку: принять его нельзя.')
      return
    }
    if (result.reason === 'expired') {
      await say(message, 'Приглашение истекло: доступ не выдан.')
      return
    }
    if (result.reason === 'unknown') {
      await say(message, 'Код приглашения не найден. Проверьте код.')
      return
    }
    if (result.reason === 'revoked') {
      await say(message, 'Приглашение отозвано владельцем: доступ не выдан.')
      return
    }
    if (result.reason === 'declined') {
      await say(message, 'Приглашение уже отклонено.')
      return
    }
    if (result.reason === 'accepted') {
      await say(message, 'Приглашение уже принято.')
      return
    }
    await say(message, 'Приглашение недействительно. Попросите владельца отправить новое.')
  }

  async function accept(message, userId, rawCode) {
    const code = String(rawCode ?? '').trim()
    if (code === '') {
      await say(message, 'Код приглашения? Например: `/project accept ABCDEFGH`.')
      return
    }
    // Principal берётся из проверенного контекста: пересланный код не подменит
    // получателя, потому что сверяется с адресатом приглашения.
    const result = store().acceptInvitation(code, principalOf(userId))
    // Пишем только когда приглашение существует: неизвестный код не трогает файл.
    if (result.invitation) await store().flush()
    if (!result.ok) {
      await refused(message, result)
      return
    }
    await say(
      message,
      `Приглашение принято: «${result.scope.title}» (\`${result.scope.id}\`). `
      + `Роль: ${result.member.role}. Проект в списке: /project list.`,
    )
  }

  async function decline(message, userId, rawCode) {
    const code = String(rawCode ?? '').trim()
    if (code === '') {
      await say(message, 'Код приглашения? Например: `/project decline ABCDEFGH`.')
      return
    }
    const result = store().declineInvitation(code, principalOf(userId))
    if (result.invitation) await store().flush()
    if (!result.ok) {
      await refused(message, result)
      return
    }
    await say(message, 'Приглашение отклонено: доступ не выдан.')
  }

  async function revoke(message, userId, rawTarget) {
    const scope = await managedScope(message, userId)
    if (!scope) return
    const target = String(rawTarget ?? '').trim()
    if (!TARGET_RE.test(target)) {
      await say(message, 'Нужен числовой userId. Например: `/project revoke 123456789`.')
      return
    }
    const outcome = store().revokeAccess(scope.id, target)
    await store().flush()
    if (!outcome) {
      await say(message, 'Такого участника нет; владельца отозвать нельзя.')
      return
    }
    await say(message, outcome.kind === 'invitation'
      ? `Приглашение для ${target} в «${scope.title}» отозвано.`
      : `Доступ пользователя ${target} к «${scope.title}» отозван.`)
  }

  async function archive(message, userId, id) {
    const scope = store()?.get(id)
    if (!scope) {
      await say(message, 'Проекта с таким id нет. Список — `/project list`.')
      return
    }
    if (scope.kind !== 'shared') {
      await say(message, 'Личное пространство не архивируется: оно всегда остаётся вашим.')
      return
    }
    if (!access().canManageScope(userId, scope)) {
      await say(message, 'Отправить проект в архив может только владелец.')
      return
    }
    store().archive(scope.id)
    if (store().activeScopeId(userId, message.chat.id) === undefined) {
      // Архивный проект больше не активен; следующая запись уйдёт в личное.
      store().setActive(userId, message.chat.id, undefined)
    }
    await store().flush()
    await say(message, `Проект «${scope.title}» в архиве: история сохранена, новые изменения запрещены.`)
  }

  return {
    /**
     * Исполнить `/project ...`.
     *
     * @param {{args?: string}} command - аргументы команды.
     * @param {object} message - входящее сообщение.
     */
    async run(command, message) {
      const userId = message?.from?.id
      if (userId === undefined) return
      if (!bot.access || !bot.scopes?.store) {
        await say(message, 'Проекты выключены в этой сборке.')
        return
      }
      const [actionRaw, ...rest] = String(command?.args ?? '').trim().split(/\s+/).filter(Boolean)
      const action = (actionRaw ?? 'list').toLowerCase()
      try {
        if (action === 'list') return await list(message, userId)
        if (action === 'new') return await create(message, userId, rest.join(' '))
        if (action === 'use') return await use(message, userId, rest[0])
        if (action === 'invite') return await invite(message, userId, rest[0], rest[1])
        if (action === 'accept') return await accept(message, userId, rest[0])
        if (action === 'decline') return await decline(message, userId, rest[0])
        if (action === 'revoke') return await revoke(message, userId, rest[0])
        if (action === 'archive') return await archive(message, userId, rest[0])
        await say(message, USAGE)
      } catch (error) {
        bot.logger?.warn?.('project command failed', { action, error: error?.message ?? error })
        await say(message, 'Не получилось выполнить команду проекта. Попробуйте ещё раз.')
      }
    },
  }
}
