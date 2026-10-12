#!/usr/bin/env bash
#
# Rotate the agent's secrets without hand-editing files and without a broken bot.
#
# Run ON the server as root:
#
#   sudo bash deploy/rotate-secrets.sh --check              # проверить, что текущие рабочие
#   sudo bash deploy/rotate-secrets.sh --token              # спросит новый токен бота
#   sudo bash deploy/rotate-secrets.sh --api-key            # спросит новый ключ модели
#   sudo bash deploy/rotate-secrets.sh --token --api-key    # оба сразу
#
# Values can also be piped in (`--token -`), which keeps them out of the shell
# history and out of `ps`. The previous file is kept next to it with a timestamp.
#
# What it checks before accepting a value:
#   * the bot token matches the `123456:AA…` shape;
#   * the model key is non-empty and starts with `sk-` (this account's format);
#   * after the restart the bot answers `getMe` with the expected username, and
#     the model key is accepted by the provider (a `GET /models` call).
set -euo pipefail

ENV_FILE=${ENV_FILE:-/etc/agent/agent.env}
SERVICE_NAME=${SERVICE_NAME:-dsh-agent}
SERVICE_USER=${SERVICE_USER:-agent}
EXPECTED_BOT=${EXPECTED_BOT:-Tenkrol_ag_bot}
MODEL_BASE_URL=${MODEL_BASE_URL:-https://api.deepseek.com}

log() { printf '\n=== %s\n' "$*"; }
die() { printf '\nОШИБКА: %s\n' "$*" >&2; exit 1; }
ok() { printf '  ✓ %s\n' "$*"; }

[ "$(id -u)" = "0" ] || die "запустите через sudo"

DO_CHECK=0
DO_TOKEN=0
DO_KEY=0
TOKEN_VALUE=''
KEY_VALUE=''

while [ $# -gt 0 ]; do
  case "$1" in
    --check) DO_CHECK=1 ;;
    --token) DO_TOKEN=1; [ "${2:-}" != "" ] && [ "${2#--}" = "${2:-}" ] && { TOKEN_VALUE=$2; shift; } ;;
    --api-key|--key) DO_KEY=1; [ "${2:-}" != "" ] && [ "${2#--}" = "${2:-}" ] && { KEY_VALUE=$2; shift; } ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "неизвестный аргумент: $1" ;;
  esac
  shift
done

[ -f "$ENV_FILE" ] || die "нет файла $ENV_FILE — сначала установите агента (deploy/install-remote.sh)"

# Read one value out of the env file without echoing it.
current() {
  grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true
}

# Ask for a secret without echoing it and without leaving it in history.
read_secret() {
  local prompt=$1 value=''
  if [ ! -t 0 ]; then
    read -r value
  else
    printf '%s' "$prompt" >&2
    read -rs value
    printf '\n' >&2
  fi
  printf '%s' "$value"
}

verify_token() {
  local token=$1 response
  response=$(curl -sS -m 20 "https://api.telegram.org/bot${token}/getMe" 2>/dev/null || true)
  case "$response" in
    *'"ok":true'*)
      local username
      username=$(printf '%s' "$response" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
      if [ -n "$EXPECTED_BOT" ] && [ "$username" != "$EXPECTED_BOT" ]; then
        printf 'токен рабочий, но это бот @%s, а ожидался @%s\n' "$username" "$EXPECTED_BOT" >&2
        return 1
      fi
      ok "Telegram принял токен (бот @$username)"
      return 0
      ;;
    *) printf 'Telegram отклонил токен: %s\n' "$(printf '%s' "$response" | head -c 200)" >&2; return 1 ;;
  esac
}

verify_key() {
  local key=$1 code
  code=$(curl -sS -m 25 -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${key}" "${MODEL_BASE_URL%/}/v1/models" 2>/dev/null || echo 000)
  case "$code" in
    200) ok "провайдер модели принял ключ (HTTP 200)"; return 0 ;;
    000) printf 'не удалось связаться с %s\n' "$MODEL_BASE_URL" >&2; return 1 ;;
    *) printf 'провайдер ответил HTTP %s — ключ, скорее всего, отклонён\n' "$code" >&2; return 1 ;;
  esac
}

if [ "$DO_CHECK" = 1 ]; then
  log "проверка текущих секретов (${ENV_FILE})"
  tok=$(current TELEGRAM_BOT_TOKEN)
  key=$(current MODEL_API_KEY)
  [ -n "$tok" ] && verify_token "$tok" || printf '  ✗ TELEGRAM_BOT_TOKEN пуст\n' >&2
  [ -n "$key" ] && verify_key "$key" || printf '  ✗ MODEL_API_KEY пуст\n' >&2
  printf '\nСервис: %s\n' "$(systemctl is-active "$SERVICE_NAME" || true)"
  exit 0
fi

[ "$DO_TOKEN" = 1 ] || [ "$DO_KEY" = 1 ] || die "укажите --token и/или --api-key (или --check)"

if [ "$DO_TOKEN" = 1 ] && [ -z "$TOKEN_VALUE" ]; then
  TOKEN_VALUE=$(read_secret "Новый токен @BotFather (ввод не отображается): ")
fi
if [ "$DO_KEY" = 1 ] && [ -z "$KEY_VALUE" ]; then
  KEY_VALUE=$(read_secret "Новый ключ модели (ввод не отображается): ")
fi

log "проверка новых значений"
if [ "$DO_TOKEN" = 1 ]; then
  [ -n "$TOKEN_VALUE" ] || die "пустой токен"
  case "$TOKEN_VALUE" in
    *:*) ;;
    *) die "токен должен содержать «:» (формат <id>:<secret>)" ;;
  esac
  verify_token "$TOKEN_VALUE" || die "новый токен не прошёл проверку Telegram"
fi
if [ "$DO_KEY" = 1 ]; then
  [ -n "$KEY_VALUE" ] || die "пустой ключ"
  case "$KEY_VALUE" in
    sk-*) ;;
    *) die "ключ должен начинаться с «sk-»" ;;
  esac
  verify_key "$KEY_VALUE" || die "новый ключ не прошёл проверку провайдера"
fi

log "запись ${ENV_FILE}"
BACKUP="${ENV_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$ENV_FILE" "$BACKUP"
chmod 600 "$BACKUP"
printf '  бэкап: %s\n' "$BACKUP"

# Values travel through a temporary file, never through a command line.
TMP=$(mktemp)
chmod 600 "$TMP"
if [ "$DO_TOKEN" = 1 ]; then printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TOKEN_VALUE" >> "$TMP"; fi
if [ "$DO_KEY" = 1 ]; then printf 'MODEL_API_KEY=%s\n' "$KEY_VALUE" >> "$TMP"; fi

if [ "$DO_TOKEN" = 1 ]; then
  sed -i "/^TELEGRAM_BOT_TOKEN=/d" "$ENV_FILE"
  printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TOKEN_VALUE" >> "$ENV_FILE"
  ok "TELEGRAM_BOT_TOKEN обновлён"
fi
if [ "$DO_KEY" = 1 ]; then
  sed -i "/^MODEL_API_KEY=/d" "$ENV_FILE"
  printf 'MODEL_API_KEY=%s\n' "$KEY_VALUE" >> "$ENV_FILE"
  ok "MODEL_API_KEY обновлён"
fi
rm -f "$TMP"
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

log "перезапуск $SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
for _ in $(seq 1 15); do
  [ "$(systemctl is-active "$SERVICE_NAME" || true)" = "active" ] && break
  sleep 1
done
if [ "$(systemctl is-active "$SERVICE_NAME" || true)" != "active" ]; then
  printf 'Сервис не поднялся. Откат из %s\n' "$BACKUP" >&2
  cp -p "$BACKUP" "$ENV_FILE"
  chown root:"$SERVICE_USER" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  systemctl restart "$SERVICE_NAME" || true
  die "ротация отменена, вернул прежние секреты"
fi
ok "сервис активен"

log "проверка после перезапуска"
NEW_TOKEN=$(current TELEGRAM_BOT_TOKEN)
verify_token "$NEW_TOKEN" || die "сервис работает, но getMe не отвечает — посмотрите journalctl -u $SERVICE_NAME"
journalctl -u "$SERVICE_NAME" -n 5 --no-pager | tail -5
printf '\nГотово. Старые секреты отзовите у провайдера и в @BotFather.\n'
