#!/usr/bin/env bash
#
# Запуск инструмента секретов без зависимости от PATH.
#
# В обычной командной строке node может быть не установлен в PATH (он живёт в
# служебной папке инструментов), поэтому обёртка ищет его сама.
#
#   bash tg-agent/tools/secrets.sh encrypt
#   bash tg-agent/tools/secrets.sh decrypt
#   bash tg-agent/tools/secrets.sh check
#
# Можно указать свой путь: NODE=/путь/к/node bash tg-agent/tools/secrets.sh encrypt
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
for candidate in \
  "${NODE:-}" \
  /Users/andryukovy/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node \
  "$(command -v node 2>/dev/null || true)" \
  /usr/local/bin/node \
  /opt/homebrew/bin/node \
  /usr/bin/node; do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  exec "$candidate" "$here/secrets.mjs" "$@"
done
echo "secrets: не нашёл node. Укажите путь: NODE=/путь/к/node bash tg-agent/tools/secrets.sh …" >&2
exit 127
