#!/usr/bin/env bash
#
# Настройка связи «агент → бот»: токен, права и туннель.
#
# Запускать на сервере агента под root, один раз и после переустановок. Скрипт
# идемпотентен: повторный запуск ничего не ломает, только приводит к нужному виду.
#
#   sudo bash /opt/agent/deploy/setup-outbox.sh
#
# Почему это вообще нужно: агент работает под пользователем agent, а точка приёма
# требует токен. Если файл токена принадлежит только root (600), агент не может его
# прочитать, agent-notify молча отказывает, и владелец не получает ни одного отчёта.
set -euo pipefail

TOKEN_FILE=${TOKEN_FILE:-/etc/tg-agent/outbox-token}
AGENT_USER=${AGENT_USER:-agent}
BOT_HOST=${BOT_HOST:-root@185.174.136.53}
BOT_KEY=${BOT_KEY:-/etc/tg-agent/monitor_key}
BOT_ENV=${BOT_ENV:-/opt/tg-agent/.env}
NOTIFY=${NOTIFY:-/usr/local/bin/agent-notify}
TUNNEL=tg-outbox-tunnel.service

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }

[ "$(id -u)" = "0" ] || { echo "нужен root" >&2; exit 1; }

# 1. Токен: если своего нет — забираем с бота по ключу мониторинга.
install -d -m 0755 /etc/tg-agent
if [ ! -s "$TOKEN_FILE" ]; then
  log "беру токен с бота ($BOT_HOST)"
  ssh -i "$BOT_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
      -o UserKnownHostsFile=/root/.ssh/known_hosts "$BOT_HOST" \
      "grep '^OUTBOX_TOKEN=' $BOT_ENV" > "$TOKEN_FILE" || {
    echo "не удалось получить токен с бота: проверьте ключ $BOT_KEY и наличие OUTBOX_TOKEN в $BOT_ENV" >&2
    exit 1
  }
fi
[ -s "$TOKEN_FILE" ] || { echo "файл токена пуст: $TOKEN_FILE" >&2; exit 1; }

# 2. Права: владелец root, группа агента, 640. Именно из-за 600 root отчёты не доходили.
chown root:"$AGENT_USER" "$TOKEN_FILE"
chmod 640 "$TOKEN_FILE"
log "права: $(stat -c '%a %U:%G' "$TOKEN_FILE")"

# 3. Проверка от имени самого агента — так, как это будет в бою.
if ! runuser -u "$AGENT_USER" -- test -r "$TOKEN_FILE"; then
  echo "пользователь $AGENT_USER не может прочитать токен — отчёты не пойдут" >&2
  exit 1
fi
log "пользователь $AGENT_USER читает токен"

# 4. Туннель до точки приёма бота.
# list-unit-files обрезает длинные имена, поэтому спрашиваем systemd напрямую.
if systemctl cat "$TUNNEL" >/dev/null 2>&1; then
  systemctl is-enabled --quiet "$TUNNEL" || systemctl enable "$TUNNEL" >/dev/null 2>&1
  systemctl is-active --quiet "$TUNNEL" || systemctl restart "$TUNNEL"
  log "туннель: $(systemctl is-active "$TUNNEL")"
else
  log "нет юнита $TUNNEL — связь не поднимется, установите его из deploy/"
fi

# 5. Отправитель и живая проверка.
[ -x "$NOTIFY" ] || log "нет $NOTIFY — агент не сможет отправить отчёт"
if [ -x "$NOTIFY" ] && [ "${SKIP_TEST:-0}" != "1" ]; then
  if runuser -u "$AGENT_USER" -- "$NOTIFY" --title "Проверка связи" "Установка связи агент → бот завершена." >/dev/null 2>&1; then
    log "проверочное сообщение отправлено — оно должно прийти в Telegram владельцу"
  else
    log "проверочное сообщение НЕ ушло: смотрите systemctl status $TUNNEL и журнал бота"
  fi
fi
log "готово"
