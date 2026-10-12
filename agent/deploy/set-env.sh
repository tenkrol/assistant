#!/usr/bin/env bash
#
# Change one setting of the installed agent, safely.
#
#   sudo bash /opt/agent/deploy/set-env.sh BRIDGE_GROUP_ID=-1001234567890
#   sudo bash /opt/agent/deploy/set-env.sh TASK_MEMORY_MAX_MB=1200 MAX_OUTPUT_FILES=4
#   printf '%s' "$SECRET" | sudo bash /opt/agent/deploy/set-env.sh --stdin MODEL_API_KEY
#
# Secrets are better piped in (`--stdin KEY`): the value then never appears in the
# shell history or in `ps`. Every change keeps a timestamped backup, restarts the
# service and rolls back if it does not come up.
set -euo pipefail

ENV_FILE=${ENV_FILE:-/etc/agent/agent.env}
SERVICE_NAME=${SERVICE_NAME:-dsh-agent}
SERVICE_USER=${SERVICE_USER:-agent}

log() { printf '\n=== %s\n' "$*"; }
die() { printf '\nОШИБКА: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "запустите через sudo"
[ -f "$ENV_FILE" ] || die "нет $ENV_FILE"

STDIN_KEY=''
if [ "${1:-}" = "--stdin" ]; then
  STDIN_KEY=${2:-}
  [ -n "$STDIN_KEY" ] || die "укажите ключ: --stdin KEY"
  shift 2
fi

PAIRS=("$@")
if [ -n "$STDIN_KEY" ]; then
  value=$(cat)
  PAIRS+=("$STDIN_KEY=$value")
fi
[ ${#PAIRS[@]} -gt 0 ] || die "укажите KEY=VALUE (или --stdin KEY)"

for pair in "${PAIRS[@]}"; do
  key=${pair%%=*}
  case "$key" in
    ''|*[!A-Za-z0-9_]*) die "некорректное имя переменной: «$key»" ;;
  esac
done

BACKUP="${ENV_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$ENV_FILE" "$BACKUP"
chmod 600 "$BACKUP"

for pair in "${PAIRS[@]}"; do
  key=${pair%%=*}
  value=${pair#*=}
  sed -i "/^${key}=/d" "$ENV_FILE"
  # printf, not echo: a value must survive backslashes and dashes untouched.
  printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  case "$key" in
    *TOKEN*|*KEY*|*SECRET*) printf '  %s: обновлён (значение не печатаю)\n' "$key" ;;
    *) printf '  %s=%s\n' "$key" "$value" ;;
  esac
done
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 0640 "$ENV_FILE"

log "перезапуск $SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
for _ in $(seq 1 15); do
  [ "$(systemctl is-active "$SERVICE_NAME" || true)" = "active" ] && break
  sleep 1
done
if [ "$(systemctl is-active "$SERVICE_NAME" || true)" != "active" ]; then
  printf 'Сервис не поднялся, откат из %s\n' "$BACKUP" >&2
  cp -p "$BACKUP" "$ENV_FILE"
  chown root:"$SERVICE_USER" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  systemctl restart "$SERVICE_NAME" || true
  die "изменение отменено"
fi
printf '\nГотово: %s активен, бэкап %s\n' "$SERVICE_NAME" "$BACKUP"
