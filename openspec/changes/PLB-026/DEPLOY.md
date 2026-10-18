# Деплой мобильного сайта (PLB-026)

Сайт живёт на том же сервере, что бот: `https://tenkrol.ru/mobile/`.
Код и API уже в релизе; шаги ниже включают пароль и проверку.

## 1. Пароль и секрет (на «Испании»)

Пароль в открытом виде не хранится ни в репозитории, ни в чате. Сгенерируйте его на сервере:

```sh
cd /tmp/tg-deploy/tg-agent
umask 077
node tools/mobile-password.mjs --generate > /root/mobile-site.env
chmod 600 /root/mobile-site.env
```

В файле будут три строки: `MOBILE_PASSWORD` (открытый пароль), `MOBILE_PASSWORD_HASH` и
`MOBILE_SESSION_SECRET`. Перенесите `MOBILE_PASSWORD` в менеджер паролей и удалите строку из
файла:

```sh
grep -v '^MOBILE_PASSWORD=' /root/mobile-site.env > /root/mobile-site.env.tmp
mv /root/mobile-site.env.tmp /root/mobile-site.env
rm /root/mobile-site.env.tmp 2>/dev/null || true
```

Если пароль нужен свой, вместо `--generate` используйте:

```sh
echo 'свой-длинный-пароль' | node tools/mobile-password.mjs --password-stdin > /root/mobile-site.env
```

## 2. Переменные в `.env`

Добавьте в `/opt/tg-agent/.env` (не в репозиторий):

```
MOBILE_USERNAME=tenkrol
MOBILE_PASSWORD_HASH=<из /root/mobile-site.env>
MOBILE_SESSION_SECRET=<из /root/mobile-site.env>
MOBILE_USER_ID=<ваш Telegram id из ALLOWED_USER_IDS>
MOBILE_USER_NAME=Владелец
MOBILE_SESSION_TTL_SEC=604800
MOBILE_COOKIE_SECURE=true
MOBILE_TELEGRAM_URL=https://t.me/Tenkrol_bot
```

`deploy-safe` копирует `.env` из текущего релиза в новый, поэтому правки нужно делать в
`/opt/tg-agent/.env` до деплоя.

## 3. Деплой

```sh
rsync -a --delete --exclude '.git' --exclude 'data' \
  ./tg-agent/ root@185.174.136.53:/tmp/tg-deploy/tg-agent/
ssh root@185.174.136.53
cd /tmp/tg-deploy/tg-agent
sudo node tools/deploy-safe.mjs --notify --test-timeout 900000
```

`deploy-safe` сам прогонит тесты, переключит симлинк, перезапустит сервис и откатит при
провале. Сервер не перезагружается.

## 4. Проверка

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://tenkrol.ru/mobile/          # 200
curl -sS -o /dev/null -w '%{http_code}\n' https://tenkrol.ru/api/auth/session  # 401
curl -sS -o /dev/null -w '%{http_code}\n' https://tenkrol.ru/                  # 200, старая панель
```

На телефоне:

1. открыть `https://tenkrol.ru/mobile/` — должен быть экран входа;
2. ввести логин `tenkrol` и пароль из менеджера — открываются «Планы» и «Чат»;
3. создать напоминание и проверить, что оно видно боту в Telegram;
4. выйти и убедиться, что без пароля данные не показываются;
5. «Добавить на экран» — приложение открывается без адресной строки.

## 5. Откат

```sh
sudo ln -sfn /opt/tg-agent-releases/<предыдущий-релиз> /opt/tg-agent
sudo systemctl restart tg-agent
```

Пароль и секрет остаются в `.env`; удаление `MOBILE_*` выключает только парольный вход,
Telegram Mini App продолжает работать.
