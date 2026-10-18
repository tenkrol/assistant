# Ключи и подключения

**Значений здесь нет.** Только имена, назначение и где взять новый. Сами значения — в
`secrets/prod.env.enc` (шифртекст), пароль — в менеджере паролей и на сервере.

| Переменная | Зачем | Где взять новый |
|---|---|---|
`TELEGRAM_BOT_TOKEN` | бот-ассистент в Telegram | @BotFather → /newbot или /token |
`MODEL_API_KEY` | модель DeepSeek (ответы и инструменты) | platform.deepseek.com → API keys |
`VK_TOKEN` | сообщество VK | настройки сообщества → работа с API |
`YANDEX_API_KEY` / `YANDEX_FOLDER_ID` | распознавание и синтез речи | Yandex Cloud → сервисный аккаунт |
`YANDEX_DISK_TOKEN` | зашифрованные бэкапы | oauth.yandex.ru → приложение с доступом к Диску |
`BACKUP_PASSPHRASE` | пароль шифрования бэкапов | генерируется один раз, хранить вне серверов |
`OUTBOX_TOKEN` | приём ответов агента | генерируется на сервере бота |
`AGENT_BRIDGE_TOKEN` | передача задач агенту | генерируется на сервере бота |
`OWNER_NAME` | подпись «От …:» в sendto | не секрет, настраивается в `.env` |
`ALLOWED_USER_IDS`, `ALLOWED_USER_IDS_VK` | кто имеет доступ | id пользователей |
`MINIAPP_*` | панель Telegram | настраивается в `.env` |
`MOBILE_PASSWORD_HASH` | пароль мобильного сайта `/mobile/` (scrypt-хеш) | `node tg-agent/tools/mobile-password.mjs --generate` |
`MOBILE_SESSION_SECRET` | подпись сессий мобильного сайта | тот же скрипт; 32+ символа |
`MOBILE_VAPID_PUBLIC_KEY` | публичный ключ Web Push | `node tg-agent/tools/mobile-push-keys.mjs` |
`MOBILE_VAPID_PRIVATE_KEY` | приватный ключ Web Push (не публиковать) | тот же скрипт |

## Как добавить ключ
1. Получить значение у провайдера.
2. Добавить в `.env` на машине, где удобно.
3. `bash tg-agent/tools/secrets.sh encrypt` → обновится `secrets/prod.env.enc`.
4. Добавить строку в таблицу выше (без значения) и закоммитить.
