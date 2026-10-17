#!/usr/bin/env bash
#
# Запуск инструмента секретов без зависимости от PATH и от текущего каталога.
#
#   bash /путь/к/проекту/tg-agent/tools/secrets.sh encrypt|decrypt|check
#
# Обёртка ищет сам скрипт рядом с собой, затем в корне git-репозитория и в известных
# местах проекта. Node ищет среди типичных путей; можно задать NODE=/путь/к/node.
set -euo pipefail
here=$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)
gitroot=$(git rev-parse --show-toplevel 2>/dev/null || true)

find_tool() {
  for dir in "$here" "$gitroot/tg-agent/tools" "$PWD/tg-agent/tools" \
             "$HOME/Documents/deepseek-harness/default-workspace/tg-agent/tools"; do
    [ -n "$dir" ] && [ -f "$dir/secrets.mjs" ] && { printf '%s\n' "$dir/secrets.mjs"; return 0; }
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

tool=$(find_tool) || {
  echo "secrets: не нашёл secrets.mjs. Запустите обёртку из самого проекта:" >&2
  echo "  bash /Users/andryukovy/Documents/deepseek-harness/default-workspace/tg-agent/tools/secrets.sh encrypt" >&2
  exit 2
}
node=$(find_node) || {
  echo "secrets: не нашёл node. Укажите путь: NODE=/путь/к/node bash $0 …" >&2
  exit 127
}
exec "$node" "$tool" "$@"
