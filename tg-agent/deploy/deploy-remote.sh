#!/usr/bin/env bash
#
# Deploy the Telegram bot to a Linux server (systemd), idempotently.
#
# Run this ON the server, from the directory that holds the project:
#
#   scp -r tg-agent user@server:/tmp/tg-agent
#   ssh user@server
#   cd /tmp/tg-agent && sudo bash deploy/deploy-remote.sh
#
# What it does:
#   1. checks that the server can reach Telegram and the model provider;
#   2. installs the project into /opt/tg-agent;
#   3. creates the service user and the state directory;
#   4. writes a systemd unit with the node path it finds;
#   5. enables and (re)starts the service and shows the first log lines.
#
# The bot uses long polling: it needs no inbound port, no domain and no TLS.
# Only outbound HTTPS to api.telegram.org and the model provider is required.
set -euo pipefail

INSTALL_DIR=${INSTALL_DIR:-/opt/tg-agent}
SERVICE_USER=${SERVICE_USER:-tgagent}
SERVICE_NAME=${SERVICE_NAME:-tg-agent}
STATE_DIR=${STATE_DIR:-/var/lib/tg-agent}
SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

log() { printf '\n=== %s\n' "$*"; }
die() { printf '\nОШИБКА: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "запустите через sudo: sudo bash deploy/deploy-remote.sh"
[ -f "$SOURCE_DIR/src/index.mjs" ] || die "не найден src/index.mjs — запустите скрипт из каталога проекта"
[ -f "$SOURCE_DIR/.env" ] || die "нет файла .env рядом с проектом: скопируйте его на сервер (в нём токен и ключ модели)"

log "1/8 проверка сети: Telegram и провайдер модели"
telegram_code=$(curl -sS -m 12 -o /dev/null -w '%{http_code}' "https://api.telegram.org/" 2>/dev/null || echo 000)
if [ "$telegram_code" = "000" ]; then
  printf 'ВНИМАНИЕ: api.telegram.org недоступен с этого сервера (код %s).\n' "$telegram_code"
  printf 'Бот не сможет получать сообщения. Варианты: прокси (HTTPS_PROXY + --use-env-proxy),\n'
  printf 'другой хостинг или запуск на машине, где Telegram доступен.\n'
  printf 'Продолжить всё равно? [y/N] '
  read -r answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || die "остановлено: сначала решите вопрос с доступом к Telegram"
else
  printf 'Telegram отвечает (HTTP %s)\n' "$telegram_code"
fi

model_base=$(grep -E '^MODEL_BASE_URL=' "$SOURCE_DIR/.env" | head -1 | cut -d= -f2- || true)
if [ -n "${model_base:-}" ]; then
  model_code=$(curl -sS -m 12 -o /dev/null -w '%{http_code}' "${model_base%/}/models" 2>/dev/null || echo 000)
  printf 'Провайдер модели %s: HTTP %s (401 тоже значит «доступен»)\n' "$model_base" "$model_code"
fi

log "2/8 поиск Node.js"
NODE_BIN=$(command -v node || true)
if [ -z "$NODE_BIN" ]; then
  die "node не найден. Поставьте Node 20+ (например: curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs) или используйте Docker: docker compose -f deploy/docker-compose.yml up -d --build"
fi
node_major=$("$NODE_BIN" -v | sed 's/^v\([0-9]*\).*/\1/')
[ "$node_major" -ge 20 ] || die "нужен Node 20+, найден $("$NODE_BIN" -v)"
printf 'node: %s (%s)\n' "$NODE_BIN" "$("$NODE_BIN" -v)"

log "3/8 установка файлов в $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude 'data/' --exclude '.git/' --exclude 'node_modules/' "$SOURCE_DIR"/ "$INSTALL_DIR"/
else
  cp -R "$SOURCE_DIR"/. "$INSTALL_DIR"/
  rm -rf "$INSTALL_DIR/data" "$INSTALL_DIR/.git"
fi
printf 'файлов: %s\n' "$(find "$INSTALL_DIR/src" -type f | wc -l | tr -d ' ')"

log "4/8 пользователь и каталог состояния"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --shell /usr/sbin/nologin "$SERVICE_USER"
  printf 'создан пользователь %s\n' "$SERVICE_USER"
fi
# StateDirectory в юните создаст каталог сам, но при первом запуске до systemd
# лучше создать его заранее с правильным владельцем.
mkdir -p "$STATE_DIR"
# Перенести состояние с машины-источника: offset (иначе Telegram перечитает
# последние сутки обновлений и бот ответит на старое), история и напоминания.
# `-n` не перезаписывает то, что уже накоплено на сервере.
if [ -d "$SOURCE_DIR/data" ]; then
  for state_file in "$SOURCE_DIR"/data/*.json; do
    [ -e "$state_file" ] || continue
    case "$state_file" in *.old*.json) continue ;; esac   # локальные архивы не нужны
    cp -n "$state_file" "$STATE_DIR"/ 2>/dev/null || true
  done
  printf 'перенесено файлов состояния: %s\n' "$(find "$STATE_DIR" -name '*.json' | wc -l | tr -d ' ')"
fi
chown -R "$SERVICE_USER":"$SERVICE_USER" "$STATE_DIR" "$INSTALL_DIR"
# PLATFORM задаётся юнитом, а не .env: systemd применяет EnvironmentFile после
# Environment=, поэтому строка PLATFORM из .env перекрыла бы выбор адаптера.
sed -i '/^PLATFORM=/d' "$INSTALL_DIR/.env"

# ВАЖНО: systemd применяет EnvironmentFile ПОСЛЕ Environment=, поэтому значение
# DATA_DIR из .env перекрывает юнит. Если оставить там «./data», бот попытается
# писать внутрь /opt (запрещено ProtectSystem=strict) и все сохранения упадут с
# ENOENT. Поэтому каталог состояния прописываем прямо в установленном .env.
if grep -q '^DATA_DIR=' "$INSTALL_DIR/.env"; then
  sed -i "s|^DATA_DIR=.*|DATA_DIR=${STATE_DIR}|" "$INSTALL_DIR/.env"
else
  printf 'DATA_DIR=%s\n' "$STATE_DIR" >> "$INSTALL_DIR/.env"
fi
if ! grep -q '^TIME_ZONE=' "$INSTALL_DIR/.env"; then
  printf 'TIME_ZONE=%s\n' "${TIME_ZONE:-Europe/Moscow}" >> "$INSTALL_DIR/.env"
fi
chmod 600 "$INSTALL_DIR/.env"
printf 'состояние: %s (прописано в .env)\n' "$STATE_DIR"

log "5/8 systemd-юнит"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
sed -e "s|^ExecStart=.*|ExecStart=${NODE_BIN} src/index.mjs|" \
    -e "s|^User=.*|User=${SERVICE_USER}|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=${INSTALL_DIR}|" \
    -e "s|^EnvironmentFile=.*|EnvironmentFile=${INSTALL_DIR}/.env|" \
    -e "s|^Environment=DATA_DIR=.*|Environment=DATA_DIR=${STATE_DIR}|" \
    -e "s|^Environment=PLATFORM=.*|Environment=PLATFORM=telegram|" \
    -e "s|^ReadWritePaths=.*|ReadWritePaths=${STATE_DIR}|" \
    -e "s|^Documentation=.*|Documentation=file:${INSTALL_DIR}/README.md|" \
    "$INSTALL_DIR/deploy/tg-agent.service" > "$UNIT_PATH"
# ProtectHome=true скрывает /root и /home; если проект лежит там, отключаем.
case "$INSTALL_DIR" in /root/*|/home/*) sed -i 's|^ProtectHome=.*|ProtectHome=false|' "$UNIT_PATH" ;; esac
sed -i "s|^StateDirectory=.*|StateDirectory=$(basename "$STATE_DIR")|" "$UNIT_PATH"
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME" >/dev/null
printf 'юнит: %s\n' "$UNIT_PATH"

log "6/8 ежедневный бэкап состояния"
BACKUP_DIR=${BACKUP_DIR:-/var/backups/tg-agent}
# Каталог создаётся здесь от root: его родитель принадлежит root, а сервис
# работает под непривилегированным пользователем.
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$BACKUP_DIR"
if [ -f "$INSTALL_DIR/deploy/tg-agent-backup.service" ] && [ -f "$INSTALL_DIR/deploy/tg-agent-backup.timer" ]; then
  sed -e "s|^User=.*|User=${SERVICE_USER}|" \
      -e "s|^WorkingDirectory=.*|WorkingDirectory=${INSTALL_DIR}|" \
      -e "s|^EnvironmentFile=.*|EnvironmentFile=${INSTALL_DIR}/.env|" \
      -e "s|^Environment=STATE_DIR=.*|Environment=STATE_DIR=${STATE_DIR}|" \
      -e "s|^Environment=BACKUP_DIR=.*|Environment=BACKUP_DIR=${BACKUP_DIR}|" \
      -e "s|^ReadWritePaths=.*|ReadWritePaths=${STATE_DIR} $(dirname "$BACKUP_DIR")|" \
      -e "s|^ExecStart=.*|ExecStart=${NODE_BIN} tools/backup-state.mjs --send|" \
      -e "s|t -o tgagent -g tgagent|t -o ${SERVICE_USER} -g ${SERVICE_USER}|" \
      "$INSTALL_DIR/deploy/tg-agent-backup.service" > /etc/systemd/system/tg-agent-backup.service
  cp "$INSTALL_DIR/deploy/tg-agent-backup.timer" /etc/systemd/system/tg-agent-backup.timer
  systemctl daemon-reload
  systemctl enable --now tg-agent-backup.timer >/dev/null
  printf 'таймер: %s (следующий запуск: %s)\n' \
    "$(systemctl is-active tg-agent-backup.timer)" \
    "$(systemctl show tg-agent-backup.timer -p NextElapseUSecRealtime --value)"
else
  printf 'юниты бэкапа не найдены — пропускаю\n'
fi

log "7/8 сервис MAX (если задан MAX_TOKEN)"
if grep -q '^MAX_TOKEN=..*' "$INSTALL_DIR/.env"; then
  sed -e "s|^ExecStart=.*|ExecStart=${NODE_BIN} src/index.mjs|" \
      -e "s|^User=.*|User=${SERVICE_USER}|" \
      -e "s|^WorkingDirectory=.*|WorkingDirectory=${INSTALL_DIR}|" \
      -e "s|^EnvironmentFile=.*|EnvironmentFile=${INSTALL_DIR}/.env|" \
      -e "s|^Environment=DATA_DIR=.*|Environment=DATA_DIR=${STATE_DIR}|" \
      -e "s|^ReadWritePaths=.*|ReadWritePaths=${STATE_DIR}|" \
      -e "s|^Documentation=.*|Documentation=file:${INSTALL_DIR}/README.md|" \
      "$INSTALL_DIR/deploy/max-agent.service" > /etc/systemd/system/max-agent.service
  systemctl daemon-reload
  systemctl enable --now max-agent >/dev/null
  printf 'max-agent: %s\n' "$(systemctl is-active max-agent)"
else
  printf 'MAX_TOKEN не задан — сервис MAX не включаю (добавьте токен в .env и запустите скрипт снова)\n'
fi

log "8/8 состояние сервиса"
sleep 4
systemctl --no-pager --full status "$SERVICE_NAME" | head -12 || true
printf '\nпоследние строки журнала:\n'
journalctl -u "$SERVICE_NAME" -n 15 --no-pager || true

cat <<EOF

------------------------------------------------------------------
Готово. Полезные команды на сервере:
  journalctl -u ${SERVICE_NAME} -f          # смотреть лог
  systemctl restart ${SERVICE_NAME}         # перезапуск
  systemctl stop ${SERVICE_NAME}            # остановка

ВАЖНО: у бота должен быть ровно один экземпляр на токен.
Если он ещё запущен на вашем Mac под launchd, остановите его там:
  node tools/install-launchd.mjs --unload
Иначе Telegram будет отдавать Conflict: terminated by other getUpdates request.
------------------------------------------------------------------
EOF
