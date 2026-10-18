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
