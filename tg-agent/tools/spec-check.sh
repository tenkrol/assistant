#!/usr/bin/env bash
#
# Проверка структуры OpenSpec без зависимости от PATH и от текущего каталога.
#
#   bash /путь/к/проекту/tg-agent/tools/spec-check.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)
gitroot=$(git rev-parse --show-toplevel 2>/dev/null || true)

find_tool() {
  for dir in "$here" "$gitroot/tg-agent/tools" "$PWD/tg-agent/tools" \
             "$HOME/Documents/deepseek-harness/default-workspace/tg-agent/tools"; do
    [ -n "$dir" ] && [ -f "$dir/spec-check.mjs" ] && { printf '%s\n' "$dir/spec-check.mjs"; return 0; }
  done
  return 1
}

find_node() {
  for candidate in "${NODE:-}" \
    /Users/andryukovy/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node \
    "$(command -v node 2>/dev/null || true)" /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

tool=$(find_tool) || { echo "spec-check: не нашёл spec-check.mjs. Запустите из проекта." >&2; exit 2; }
node=$(find_node) || { echo "spec-check: не нашёл node. Укажите NODE=/путь/к/node" >&2; exit 127; }
root=$(cd "$(dirname "$tool")/../.." && pwd)
exec "$node" "$tool" "$root"
