#!/usr/bin/env bash
#
# Daily backup of everything the assistant owns: the agent's memory and the chat
# bot's live state, plus the configuration needed to rebuild either server.
#
# Why one archive: restore should be one file. The bot's data is pulled from the
# other VPS over the monitoring key, so a single run on the agent's server covers
# both machines.
#
# Secrets (both .env files) end up in the archive, so the whole thing is encrypted
# with BACKUP_PASSPHRASE from /etc/agent/agent.env. Keep that passphrase outside the
# servers as well: without it the off-site copy cannot be opened.
#
#   systemctl list-timers agent-backup.timer
#   bash /opt/agent/deploy/agent-backup.sh          # run once by hand
set -euo pipefail

STATE_ROOT=${STATE_ROOT:-/var/lib/agent}
BACKUP_DIR=${BACKUP_DIR:-/var/lib/agent-backups}
KEEP=${BACKUP_KEEP:-7}
ENV_FILE=${ENV_FILE:-/etc/agent/agent.env}
BOT_HOST=${BOT_HOST:-root@185.174.136.53}
BOT_KEY=${BOT_KEY:-/etc/tg-agent/monitor_key}
BOT_STATE=${BOT_STATE:-/var/lib/tg-agent}
STAMP=$(date +%Y%m%d-%H%M%S)
WORK=$(mktemp -d)
PLAIN="$WORK/backup-$STAMP.tar.gz"
ARCHIVE="$BACKUP_DIR/backup-$STAMP.tar.gz.enc"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

[ -d "$STATE_ROOT" ] || { log "нет $STATE_ROOT — бэкапить нечего"; exit 0; }
install -d -m 0700 "$BACKUP_DIR"

# ---------- 1. состояние и настройки агента ----------
mkdir -p "$WORK/agent"
tar --ignore-failed-read -czf "$WORK/agent/state.tar.gz" -C "$(dirname "$STATE_ROOT")" \
  "$(basename "$STATE_ROOT")/state" \
  "$(basename "$STATE_ROOT")/dsh/sessions" \
  "$(basename "$STATE_ROOT")/workspace/AGENTS.md" 2>/dev/null || true
cp -a "$ENV_FILE" "$WORK/agent/agent.env" 2>/dev/null || log "нет $ENV_FILE — секреты агента не попали"
tar --ignore-failed-read -czf "$WORK/agent/systemd.tar.gz" \
  $(ls /etc/systemd/system/*.service /etc/systemd/system/*.timer 2>/dev/null | grep -E "agent|dsh|watchdog") 2>/dev/null || true
log "агент: состояние собрано"

# ---------- 2. состояние и настройки бота (с другого сервера) ----------
if ssh -i "$BOT_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
     -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 "$BOT_HOST" \
     "tar --ignore-failed-read -czf - -C / $BOT_STATE /etc/nginx/sites-available /etc/letsencrypt/renewal /opt/tg-agent/.env \$(ls /etc/systemd/system/*.service /etc/systemd/system/*.timer 2>/dev/null | grep -E 'tg-agent|vk-agent|disk-guard|certbot' | sed 's|^/||') 2>/dev/null" \
     > "$WORK/bot.tar.gz" 2>/dev/null; then
  if [ -s "$WORK/bot.tar.gz" ]; then
    log "бот: состояние и настройки собраны ($(du -h "$WORK/bot.tar.gz" | cut -f1))"
  else
    rm -f "$WORK/bot.tar.gz"; log "бот: пустой ответ от $BOT_HOST"
  fi
else
  rm -f "$WORK/bot.tar.gz"; log "бот: $BOT_HOST недоступен — архив будет без его данных"
fi

# ---------- 3. один архив ----------
tar -czf "$PLAIN" -C "$WORK" agent $( [ -f "$WORK/bot.tar.gz" ] && echo bot.tar.gz )
if [ ! -s "$PLAIN" ] || ! tar -tzf "$PLAIN" >/dev/null 2>&1; then
  log "архив пуст или повреждён — прерываю"
  exit 1
fi

# ---------- 4. шифрование ----------
PASSPHRASE=$(grep -E '^BACKUP_PASSPHRASE=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
if [ -z "$PASSPHRASE" ]; then
  PASSPHRASE=$(head -c 32 /dev/urandom | base64 | tr -d '=+/' | cut -c1-32)
  printf '\n# Пароль для расшифровки облачных бэкапов. Храните его вне серверов:\n# без него архив из Яндекс.Диска не открыть.\nBACKUP_PASSPHRASE=%s\n' "$PASSPHRASE" >> "$ENV_FILE"
  log "сгенерирован BACKUP_PASSPHRASE и записан в $ENV_FILE"
fi
openssl enc -aes-256-cbc -pbkdf2 -salt -in "$PLAIN" -out "$ARCHIVE" -pass pass:"$PASSPHRASE"
log "создан $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

# расшифровка проверяется сразу: непроверяемый бэкап — не бэкап
if ! openssl enc -d -aes-256-cbc -pbkdf2 -in "$ARCHIVE" -pass pass:"$PASSPHRASE" 2>/dev/null | tar -tzf - >/dev/null 2>&1; then
  log "архив не расшифровывается — удаляю"
  rm -f "$ARCHIVE"
  exit 1
fi

# ---------- 5. копия на Яндекс.Диск ----------
DISK_TOKEN=$(grep -E '^YANDEX_DISK_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
DISK_ENABLED=$(grep -E '^YANDEX_DISK=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
DISK_DIR=$(grep -E '^YANDEX_DISK_DIR=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || echo '/Агент')
if [ -n "$DISK_TOKEN" ] && [ "$DISK_ENABLED" = "true" ]; then
  DISK_DIR=${DISK_DIR:-/Агент}
  REMOTE="$DISK_DIR/backups/$(basename "$ARCHIVE")"
  UPLOAD_URL=$(curl -sS -m 30 -G "https://cloud-api.yandex.net/v1/disk/resources/upload" \
    --data-urlencode "path=$REMOTE" --data-urlencode "overwrite=true" \
    -H "Authorization: OAuth $DISK_TOKEN" \
    | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("href", ""))
except Exception:
    print("")' 2>/dev/null || true)
  if [ -n "$UPLOAD_URL" ] && curl -sS -m 900 -T "$ARCHIVE" "$UPLOAD_URL" >/dev/null 2>&1; then
    log "копия на Диске: $REMOTE"
    # Ротация в облаке: свои старые копии убираем, чужие не трогаем.
    OLD=$(curl -sS -m 30 -G "https://cloud-api.yandex.net/v1/disk/resources" \
      --data-urlencode "path=$DISK_DIR/backups" --data-urlencode "limit=200" \
      -H "Authorization: OAuth $DISK_TOKEN" 2>/dev/null \
      | python3 -c 'import json,sys
try:
    items = json.load(sys.stdin)["_embedded"]["items"]
except Exception:
    items = []
files = sorted([i["path"] for i in items if i.get("type") == "file" and i.get("name","").endswith(".tar.gz.enc")])
for path in files[:-'"$KEEP"'"]:
    print(path)' 2>/dev/null || true)
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      curl -sS -m 30 -X DELETE -G "https://cloud-api.yandex.net/v1/disk/resources" \
        --data-urlencode "path=$path" --data-urlencode "permanently=true" \
        -H "Authorization: OAuth $DISK_TOKEN" >/dev/null 2>&1 && log "на Диске удалён старый $(basename "$path")"
    done <<< "$OLD"
  else
    log "не удалось отправить копию на Диск"
  fi
else
  log "Яндекс.Диск выключен или токен не задан — копия только локальная"
fi

# ---------- 6. ротация локальных копий ----------
mapfile -t old < <(ls -1t "$BACKUP_DIR"/backup-*.tar.gz.enc 2>/dev/null | tail -n "+$((KEEP + 1))")
for file in "${old[@]:-}"; do
  [ -n "$file" ] || continue
  rm -f -- "$file"
  log "удалён старый $file"
done
