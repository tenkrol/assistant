#!/usr/bin/env bash
#
# Set up the SSH tunnel that connects the chat bot in Spain to the agent bridge.
#
# Run ON THE SPAIN SERVER as root:
#
#   bash /tmp/setup-bridge-tunnel.sh                 # создать ключ и туннель
#   bash /tmp/setup-bridge-tunnel.sh --show-key      # только показать публичный ключ
#
# The tunnel is a systemd service: `ssh -N -L 127.0.0.1:8787:127.0.0.1:8787` to the
# agent. Nothing is exposed to the internet — the agent listens on loopback, and
# SSH carries (and encrypts) the hop. The key this script generates is meant to be
# restricted on the agent side to exactly this one forward
# (see `deploy/authorize-bridge-key.sh`).
set -euo pipefail

AGENT_HOST=${AGENT_HOST:-185.106.94.155}
AGENT_USER=${AGENT_USER:-agent}
BRIDGE_PORT=${BRIDGE_PORT:-8787}
KEY_DIR=${KEY_DIR:-/etc/agent-bridge}
KEY_FILE=${KEY_FILE:-$KEY_DIR/id_ed25519}
UNIT=${UNIT:-agent-bridge-tunnel.service}
SERVICE_USER=${SERVICE_USER:-root}

log() { printf '\n=== %s\n' "$*"; }
die() { printf '\nОШИБКА: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "запустите через sudo"

if [ "${1:-}" = "--show-key" ]; then
  cat "${KEY_FILE}.pub"
  exit 0
fi

log "1/4 ключ туннеля"
install -d -m 0700 "$KEY_DIR"
if [ ! -f "$KEY_FILE" ]; then
  ssh-keygen -t ed25519 -N '' -C "agent-bridge@$(hostname)" -f "$KEY_FILE" >/dev/null
  printf 'Создан %s\n' "$KEY_FILE"
else
  printf 'Ключ уже есть: %s\n' "$KEY_FILE"
fi
chmod 600 "$KEY_FILE"
printf '\nПубличный ключ (его нужно разрешить на агенте):\n'
cat "${KEY_FILE}.pub"

log "2/4 проверка, что агент доступен"
if ssh -i "$KEY_FILE" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new \
  "$AGENT_USER@$AGENT_HOST" true 2>/dev/null; then
  printf 'SSH до агента работает\n'
else
  printf 'SSH пока не проходит — это ожидаемо, пока ключ не разрешён на агенте.\n'
  printf 'Разрешите его там: bash deploy/authorize-bridge-key.sh "<ключ выше>"\n'
fi

log "3/4 unit systemd"
cat > "/etc/systemd/system/$UNIT" <<UNITEOF
# SSH tunnel to the agent bridge on Finland.
#
# The agent listens on 127.0.0.1:8787 only; this forwards the same local port on
# this server through SSH, so no port is exposed to the internet and no TLS
# certificate is needed. Restart=always keeps the tunnel alive.
[Unit]
Description=SSH tunnel to the agent bridge (Finland)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
ExecStart=/usr/bin/ssh -NT \\
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \\
  -o BatchMode=yes -o StrictHostKeyChecking=accept-new \\
  -i $KEY_FILE \\
  -L 127.0.0.1:$BRIDGE_PORT:127.0.0.1:$BRIDGE_PORT \\
  $AGENT_USER@$AGENT_HOST
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNITEOF
systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null

log "4/4 запуск и проверка"
systemctl restart "$UNIT"
for _ in $(seq 1 10); do
  sleep 1
  if curl -s -m 3 "http://127.0.0.1:$BRIDGE_PORT/health" | grep -q '"ok":true'; then
    printf 'Туннель работает: /health отвечает\n'
    curl -s "http://127.0.0.1:$BRIDGE_PORT/health"; printf '\n'
    exit 0
  fi
done

printf 'Туннель поднят, но /health не ответил. Проверьте: journalctl -u %s -n 30\n' "$UNIT" >&2
journalctl -u "$UNIT" -n 20 --no-pager || true
exit 1
