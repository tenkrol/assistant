# Техническое решение

## Как устроено сейчас
`scopes.mjs`: `invite` сразу добавляет `members[{userId, role}]`; `canRead/canWrite` смотрят
только `members`; платформа не входит в ключ.

## Предлагаемое решение
1. `scopes.json`: `invitations: [{id, scopeId, inviterPrincipal, inviteePrincipal, role, status:
   'pending'|'accepted'|'declined'|'expired'|'revoked', code, expiresAt, createdAt}]`.
2. Principal — `<platform>:<userId>` (из проверенного контекста); `members` получают `platform`.
   `canRead/canWrite` проверяют только `members` → pending сам по себе доступа не даёт.
3. Команды: `/project invite <id> [роль]` создаёт pending и отправляет получателю код;
   `/project accept <код>` / `/project decline <код>`; `/project revoke <principal>` у владельца;
   истечение — 7 дней по умолчанию.
4. Миграция: существующие активные участники остаются (владелец уже их принял фактически),
   добавляется `platform` по известному каналу; копия файла, идемпотентность.
5. Тесты: pending без доступа, accept, пересылка кода, expire, revoke, коллизия id разных платформ.

## Влияние
Риск: сломать доступ существующему участнику (Маша). Поэтому миграция сохраняет текущих members
и тест на реальном формате `scopes.json`. Откат — `deploy-safe`.

## Альтернативы
Хранить приглашение как участника с `status:'pending'` — проще, но легко забыть фильтр; выбрана
отдельная сущность.
