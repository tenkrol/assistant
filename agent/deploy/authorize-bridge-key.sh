#!/usr/bin/env bash
#
# Authorise the tunnel key from the Spain server on the agent.
#
# Run ON THE FINLAND SERVER as root:
#
#   bash /tmp/authorize-bridge-key.sh "ssh-ed25519 AAAA… agent-bridge@spain"
#   bash /tmp/authorize-bridge-key.sh --list
#
# The key is added with the narrowest options SSH allows: it cannot open a shell,
# cannot forward other ports, and may only reach the bridge port on loopback from
# the Spain address. Even if the Spain server is compromised, the key cannot be
# used for anything else.
set -euo pipefail

PORT=${BRIDGE_PORT:-8787}
SPAIN_IP=${SPAIN_IP:-185.174.136.53}
# The tunnel authenticates as an unprivileged user: `restrict` does not stop
# command execution, so the key must never belong to root.
BRIDGE_USER=${BRIDGE_USER:-agent}
AUTHORIZED=${AUTHORIZED:-$(getent passwd "$BRIDGE_USER" | cut -d: -f6)/.ssh/authorized_keys}
MARKER='agent-bridge-tunnel'

die() { printf '\nОШИБКА: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "запустите через sudo"
install -d -m 0700 "$(dirname "$AUTHORIZED")"

if [ "${1:-}" = "--list" ]; then
  grep -n "$MARKER" "$AUTHORIZED" 2>/dev/null || printf 'Ключ туннеля не добавлен.\n'
  exit 0
fi

PUBLIC_KEY=${1:-}
[ -n "$PUBLIC_KEY" ] || die "укажите публичный ключ строкой (см. setup-bridge-tunnel.sh --show-key)"
case "$PUBLIC_KEY" in
  ssh-ed25519\ *|ssh-rsa\ *) ;;
  *) die "это не похоже на публичный ключ OpenSSH" ;;
esac

OPTIONS="restrict,port-forwarding,permitopen=\"127.0.0.1:$PORT\",from=\"$SPAIN_IP\""
ENTRY="$OPTIONS $PUBLIC_KEY $MARKER"

[ -n "$AUTHORIZED" ] || die "не найден домашний каталог пользователя $BRIDGE_USER"
install -d -o "$BRIDGE_USER" -g "$BRIDGE_USER" -m 0700 "$(dirname "$AUTHORIZED")"
touch "$AUTHORIZED"
# Replace an earlier entry instead of piling up duplicates.
sed -i "/$MARKER\$/d" "$AUTHORIZED"
printf '%s\n' "$ENTRY" >> "$AUTHORIZED"
chown "$BRIDGE_USER":"$BRIDGE_USER" "$AUTHORIZED"
chmod 600 "$AUTHORIZED"

printf 'Добавлено в %s (пользователь %s):\n  %s … %s\n' "$AUTHORIZED" "$BRIDGE_USER" "${ENTRY%% *}" "$MARKER"
printf 'Разрешено: только forward на 127.0.0.1:%s с %s под %s (без shell: у пользователя nologin).\n' "$PORT" "$SPAIN_IP" "$BRIDGE_USER"
