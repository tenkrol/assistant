#!/usr/bin/env bash
#
# Install or update the task agent on the Finland server (systemd), idempotently.
#
# Run this ON the server, from the directory that holds the project:
#
#   scp -r agent root@185.106.94.155:/tmp/agent-deploy
#   ssh root@185.106.94.155
#   cd /tmp/agent-deploy/agent && bash deploy/install-remote.sh
#
# What it does:
#   1. checks Node, DSH, LibreOffice and the Python environment the agent promises
#      to its model (the promises in deploy/workspace/AGENTS.md.template);
#   2. creates the `agent` user, its home and state directories;
#   3. installs the code as an immutable release and re-points /opt/agent at it;
#   4. keeps the existing /etc/agent/agent.env (secrets are rotated there, not by
#      a deploy) and installs the systemd units and the backup timer;
#   5. restarts the service and shows the first log lines.
#
# The agent's own state (/var/lib/agent) and the reserved chat-bot state
# (/var/lib/tg-agent) are never touched.
set -euo pipefail

SERVICE_NAME=${SERVICE_NAME:-dsh-agent}
SERVICE_USER=${SERVICE_USER:-agent}
STATE_ROOT=${STATE_ROOT:-/var/lib/agent}
RELEASES_DIR=${RELEASES_DIR:-/opt/agent-releases}
CURRENT_LINK=${CURRENT_LINK:-/opt/agent}
ENV_DIR=${ENV_DIR:-/etc/agent}
ENV_FILE=${ENV_FILE:-$ENV_DIR/agent.env}
KEEP_RELEASES=${KEEP_RELEASES:-3}
BACKUP_DIR=${BACKUP_DIR:-/var/lib/agent-backups}
SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

log() { printf '\n=== %s\n' "$*"; }
die() { printf '\nОШИБКА: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "запустите через sudo: sudo bash deploy/install-remote.sh"
[ -f "$SOURCE_DIR/src/index.mjs" ] || die "не найден src/index.mjs — запустите скрипт из каталога проекта"

log "1/7 проверка окружения"
NODE_BIN=$(command -v node || true)
[ -n "$NODE_BIN" ] || die "node не найден. Поставьте Node 20+ и повторите"
node_major=$("$NODE_BIN" -v | sed 's/^v\([0-9]*\).*/\1/')
[ "$node_major" -ge 20 ] || die "нужен Node 20+, найден $("$NODE_BIN" -v)"
printf 'Node: %s (%s)\n' "$("$NODE_BIN" -v)" "$NODE_BIN"

DSH_BIN=$(command -v dsh || true)
[ -n "$DSH_BIN" ] || die "dsh не найден. Поставьте: npm i -g @deepseek-ai/dsh@0.2.0-rc.2"
printf 'DSH: %s (%s)\n' "$($DSH_BIN --version 2>/dev/null | head -1)" "$DSH_BIN"

if command -v soffice >/dev/null 2>&1; then
  printf 'LibreOffice: %s\n' "$(soffice --version 2>/dev/null | head -1)"
else
  printf 'ВНИМАНИЕ: soffice не найден — агент не сможет делать документы.\n'
  printf 'Установите: apt-get install -y --no-install-recommends libreoffice-writer libreoffice-calc libreoffice-impress fonts-dejavu fonts-liberation\n'
fi

if [ -x /opt/agent-venv/bin/python ]; then
  /opt/agent-venv/bin/python -c "import docx, openpyxl, pptx, xlsxwriter, PIL" 2>/dev/null \
    && printf 'Python-библиотеки: /opt/agent-venv — ок\n' \
    || printf 'ВНИМАНИЕ: в /opt/agent-venv не хватает библиотек (docx/openpyxl/pptx/xlsxwriter/PIL)\n'
else
  printf 'ВНИМАНИЕ: нет /opt/agent-venv — создайте: python3 -m venv /opt/agent-venv && /opt/agent-venv/bin/pip install python-pptx XlsxWriter Pillow python-docx openpyxl\n'
fi

# AGENTS.md promises these to the model, so a missing one is a false promise.
for tool in rg zip jq curl git; do
  command -v "$tool" >/dev/null 2>&1 || printf 'ВНИМАНИЕ: %s не найден (обещан агенту в AGENTS.md)\n' "$tool"
done

log "2/7 пользователь и каталоги состояния"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE_ROOT" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  printf 'Создан пользователь %s\n' "$SERVICE_USER"
else
  printf 'Пользователь %s уже есть\n' "$SERVICE_USER"
fi
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$STATE_ROOT" \
  "$STATE_ROOT/dsh" "$STATE_ROOT/state" "$STATE_ROOT/workspace" \
  "$STATE_ROOT/workspace/inbox" "$STATE_ROOT/workspace/outbox"
printf 'Каталоги: %s (dsh, state, workspace/inbox, workspace/outbox)\n' "$STATE_ROOT"

log "3/7 релиз кода"
STAMP=$(date +%Y%m%d-%H%M%S)
RELEASE_DIR="$RELEASES_DIR/release-$STAMP"
install -d -m 0755 "$RELEASE_DIR"
tar -C "$SOURCE_DIR" \
  --exclude='./.env' --exclude='./data' --exclude='./node_modules' --exclude='./.git' \
  --exclude='./test/tmp' --exclude='./.DS_Store' \
  -cf - . | tar -C "$RELEASE_DIR" -xf -
chmod -R a+rX "$RELEASE_DIR"
# Maintenance scripts are meant to be run directly (install-remote.sh, rotate-secrets.sh).
chmod +x "$RELEASE_DIR"/deploy/*.sh 2>/dev/null || true
printf 'Установлен релиз %s\n' "$RELEASE_DIR"

# AGENTS.md lives in the workspace, not in the release, and is never overwritten:
# the owner may have edited the copy the agent reads.
if [ -f "$RELEASE_DIR/deploy/workspace/AGENTS.md.template" ] && [ ! -f "$STATE_ROOT/workspace/AGENTS.md" ]; then
  install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0644 \
    "$RELEASE_DIR/deploy/workspace/AGENTS.md.template" "$STATE_ROOT/workspace/AGENTS.md"
  printf 'Установлен %s/workspace/AGENTS.md\n' "$STATE_ROOT"
fi

# `/opt/agent` must be a symlink this script owns: a real directory there (an old
# venv, a manual copy) silently swallows the link and ExecStart then points at a
# path with no code in it.
if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
  die "$CURRENT_LINK существует и не является симлинком. Уберите его вручную (например: mv $CURRENT_LINK ${CURRENT_LINK}.old) и повторите запуск"
fi
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
if [ "$(readlink -f "$CURRENT_LINK")" != "$(readlink -f "$RELEASE_DIR")" ]; then
  die "не удалось переключить $CURRENT_LINK на $RELEASE_DIR"
fi
printf 'Симлинк: %s -> %s\n' "$CURRENT_LINK" "$(readlink -f "$CURRENT_LINK")"

# Keep only the newest releases, but never remove what the symlink points to.
mapfile -t old_releases < <(ls -1dt "$RELEASES_DIR"/release-* 2>/dev/null | tail -n "+$((KEEP_RELEASES + 1))")
for old in "${old_releases[@]:-}"; do
  [ -n "$old" ] || continue
  [ "$(readlink -f "$CURRENT_LINK")" = "$(readlink -f "$old")" ] && continue
  rm -rf -- "$old"
  printf 'Удалён старый релиз %s\n' "$old"
done

log "4/7 секреты"
install -d -o root -g "$SERVICE_USER" -m 0750 "$ENV_DIR"
# The server's env file is the source of truth once it exists: secrets are
# rotated there (deploy/rotate-secrets.sh), and a deploy must never resurrect a
# token that was revoked on purpose. REPLACE_ENV=1 overwrites it deliberately.
if [ -f "$ENV_FILE" ] && [ "${REPLACE_ENV:-0}" != "1" ]; then
  chown root:"$SERVICE_USER" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  # Existing values win: they may be rotated secrets. Keys that the running file
  # does not know yet are appended, so a new setting reaches the server with the
  # deploy that introduces it.
  ADDED=0
  if [ -f "$SOURCE_DIR/.env" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in ''|'#'*) continue ;; esac
      key=${line%%=*}
      case "$key" in *[!A-Za-z0-9_]*) continue ;; esac
      if ! grep -qE "^${key}=" "$ENV_FILE"; then
        printf '%s\n' "$line" >> "$ENV_FILE"
        ADDED=$((ADDED + 1))
      fi
    done < "$SOURCE_DIR/.env"
  fi
  printf 'Сохранён существующий %s%s\n' "$ENV_FILE" "$([ "$ADDED" -gt 0 ] && printf ' (добавлено новых переменных: %s)' "$ADDED")"
elif [ -f "$SOURCE_DIR/.env" ]; then
  install -o root -g "$SERVICE_USER" -m 0640 "$SOURCE_DIR/.env" "$ENV_FILE"
  printf 'Обновлён %s из %s\n' "$ENV_FILE" "$SOURCE_DIR/.env"
elif [ -f "$ENV_FILE" ]; then
  chown root:"$SERVICE_USER" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  printf 'Сохранён существующий %s\n' "$ENV_FILE"
else
  die "нет ни $SOURCE_DIR/.env, ни $ENV_FILE — скопируйте .env с токеном и ключом модели"
fi
grep -q '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" || die "$ENV_FILE: нет TELEGRAM_BOT_TOKEN"
grep -q '^MODEL_API_KEY=' "$ENV_FILE" || printf 'ВНИМАНИЕ: в %s нет MODEL_API_KEY — модель не ответит\n' "$ENV_FILE"

log "5/7 unit systemd"
install -m 0644 "$RELEASE_DIR/deploy/$SERVICE_NAME.service" "/etc/systemd/system/$SERVICE_NAME.service"
# The unit ships a placeholder so the file stays readable as documentation.
sed -i "s|^ExecStart=__NODE_BIN__ |ExecStart=$NODE_BIN |" "/etc/systemd/system/$SERVICE_NAME.service"
sed -i "s|^Environment=DSH_BIN=.*|Environment=DSH_BIN=$DSH_BIN|" "/etc/systemd/system/$SERVICE_NAME.service"

# Daily backup of the agent's own state (journal, usage, DSH sessions).
install -d -m 0700 "$BACKUP_DIR"
install -m 0755 "$RELEASE_DIR/deploy/agent-backup.sh" /etc/agent/agent-backup.sh
install -m 0644 "$RELEASE_DIR/deploy/agent-backup.service" /etc/systemd/system/agent-backup.service
install -m 0644 "$RELEASE_DIR/deploy/agent-backup.timer" /etc/systemd/system/agent-backup.timer
sed -i "s|^ExecStart=.*|ExecStart=/etc/agent/agent-backup.sh|" /etc/systemd/system/agent-backup.service

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl enable --now agent-backup.timer >/dev/null 2>&1 || true

log "6/7 перезапуск"
systemctl restart "$SERVICE_NAME"
sleep 2

log "7/7 состояние"
printf 'Активен: %s\n' "$(systemctl is-active "$SERVICE_NAME" || true)"
printf 'Бэкап: %s\n' "$(systemctl list-timers agent-backup.timer --no-pager 2>/dev/null | sed -n 2p | sed 's/  */ /g' || true)"
journalctl -u "$SERVICE_NAME" -n 25 --no-pager || true

printf '\nГотово. Проверьте: journalctl -u %s -f\n' "$SERVICE_NAME"
printf 'Чат-бот в Испании не затронут: systemctl is-active tg-agent vk-agent на 185.174.136.53\n'
