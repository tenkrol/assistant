#!/usr/bin/env bash
#
# Проверка структуры OpenSpec без зависимости от PATH: node ищем сами.
#
#   bash tg-agent/tools/spec-check.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
for candidate in \
  "${NODE:-}" \
  /Users/andryukovy/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node \
  "$(command -v node 2>/dev/null || true)" \
  /usr/local/bin/node \
  /opt/homebrew/bin/node \
  /usr/bin/node; do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  exec "$candidate" "$here/spec-check.mjs" "$root"
done
echo "spec-check: не нашёл node. Укажите путь: NODE=/путь/к/node bash tg-agent/tools/spec-check.sh" >&2
exit 127
