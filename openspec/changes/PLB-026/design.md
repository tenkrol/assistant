# Техническое решение

## Как устроено сейчас
- `tg-agent/public/app.html` — Telegram Mini App: вход только по подписи `initData`,
  вкладки «Напоминания / Календарь / Память / Статистика».
- Сервер — `src/miniapp.mjs`: проверяет `initData`, отдаёт `/api/reminders`, `/api/events`,
  `/api/memory`, `/api/state` и статику `public/`.
- Чат, агент, файлы и настройки живут только в Telegram-командах.

## Предлагаемое решение
### Сервер
- `src/mobile-auth.mjs` — чистые функции: scrypt-хеш пароля, HMAC-подписанный токен сессии,
  разбор cookie, `Set-Cookie` с `HttpOnly`, `Secure`, `SameSite=Strict`.
- `src/mobile-users.mjs` — аккаунты в `mobile-accounts.json`: логин, scrypt-хеш, Telegram id,
  роль и версия учётных данных; версия входит в сессию и закрывает старые cookie после смены пароля.
- `src/miniapp.mjs`:
  - `POST /api/auth/login` — принимает пароль, сверяет хеш за постоянное время, ставит
    cookie; лимит попыток по IP (5 ошибок / 15 минут → 429 и `Retry-After`);
  - `POST /api/auth/logout`, `GET /api/auth/session`;
  - существующие API принимают либо `initData`, либо cookie; для cookie-сессии изменяющие
    запросы требуют `X-Mobile-Client: 1` и совпадения `Origin`;
  - новые `GET /api/chat/history`, `GET/PATCH /api/settings`, `GET /api/stats`;
  - `GET/POST /api/accounts` и `PATCH /api/account` — список, добавление Маши и смена
    своего логина/пароля; добавлять пользователей может только владелец;
  - `GET /api/chats` — личный чат и настроенный общий чат с Машей;
  - `POST /api/chat/message` — текст уходит в `bot.handleWebMessage`; ответы и файлы
    возвращаются JSON-ом, а не отправляются в Telegram; `chatId` выбирает личный/общий чат;
  - `GET /api/agent/status` — доступность моста, агенты и последние события (кеш 10 с);
  - `POST /api/agent/task` — шаблонное задание сразу в `agentBridge.execute('ask_agent')`
    с маршрутом в чат пользователя; задание и подтверждение добавляются в историю;
  - `GET /api/push/config`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe` —
    VAPID-ключ и подписки браузера; сами push отправляются при напоминаниях, ответах
    агента и дайджесте, а не на каждое сообщение.
  - статика `/mobile/` с CSP, `nosniff`, `X-Frame-Options: DENY`; `/mobile` → `/mobile/`.
- `UsageStore.recent(days)` — последние дни для графика.
- `src/config.mjs` + `.env.example`: `MOBILE_PASSWORD_HASH`, `MOBILE_SESSION_SECRET`,
  `MOBILE_USER_ID`, `MOBILE_USER_NAME`, `MOBILE_SESSION_TTL_SEC`, `MOBILE_COOKIE_SECURE`,
  `MOBILE_TELEGRAM_URL`.
- `tools/mobile-password.mjs` — генерация пароля/секрета и scrypt-хеша; значения не попадают
  в репозиторий.

### Клиент
`public/mobile/` — HTML/CSS/JS без зависимостей и сборки:
- `index.html` — вход и пять разделов, PWA-манифест, иконки;
- `app.css` — токены и компоненты из макета PLB-026;
- `app.js` — API-клиент, авторизация, рендер данных, шторки, темы.

Пароль нигде не сохраняется; cookie HttpOnly. Если страница открыта внутри Telegram и есть
`initData`, вход по паролю не нужен — используется подпись Telegram.

**Общий чат.** Группа задаётся в `.env`: id, название и тип. Веб-сообщение получает
`chat.type=group`, `addressed=true` и уходит в тот же конвейер; ответ доставляется в веб,
а не в Telegram. `resolveChat` не даёт запросить чужой chat id.

**Push.** Подписка хранится в `mobile-push.json` (endpoint + ключи браузера). Сервер
подписывает VAPID JWT и отправляет пустой POST: service worker показывает общее
уведомление «Ассистент», текст сообщения не шифруется и не пересылается в push.
На iPhone push работает только в standalone-приложении Safari 16.4+.

**Агент.** Раздел показывает блоки-шаблоны (документ, таблица, отчёт, исследование,
перевод, проверка, своя задача). Клиент собирает текст задания, даёт его отредактировать и
отправляет в `/api/agent/task`. Сервер вызывает мост напрямую — без лишнего вызова модели —
и возвращает номер задачи; результат приходит в чат через outbox и попадает в историю.

**Веб-чат.** `Assistant.handleWebMessage` запускает тот же `conversation.handleMessage`,
что и Telegram, но через `AsyncLocalStorage` подменяет доставку: `send`, стример и файлы
складываются в ответ сайту. Сообщение и ответ попадают в общую историю, поэтому диалог
продолжается и в Telegram. `sendto` в другой чат по-прежнему идёт через платформу.

## Влияние
- Пароль и секрет живут только в `.env` на сервере; без них вход по паролю выключен,
  данные закрыты. Утечка хеша не даёт открытый пароль (scrypt).
- Сессия stateless: смена `MOBILE_SESSION_SECRET` завершает все сессии.
- Существующий Telegram Mini App не меняется: `/` по-прежнему отдаёт `app.html`.
- Откат — `deploy-safe`; старые релизы остаются.

## Альтернативы
- **Telegram Login Widget / код из бота** — сложнее для владельца и зависит от доступности
  Telegram; пароль выбран как явное требование.
- **Пароль в открытом виде в env** — отвергнуто: env читается процессами и бэкапами.
- **Сессии в JSON-файле** — лишнее состояние и гонки; stateless HMAC проще и переживает
  перезапуск.
- **Отправка чата с сайта** — требует отдельного веб-канала в ядро бота; вынесено в следующий шаг.
