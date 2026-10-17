#!/usr/bin/env bash
#
# Проверка, что работа закоммичена и отправлена в origin.
#
#   bash tg-agent/tools/git-check.sh
#
# Коды: 0 — дерево чистое и всё отправлено; 1 — есть незакоммиченное или неотправленное.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
cd "$root"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "git-check: это не git-репозиторий"; exit 1; }

dirty=$(git status --porcelain --untracked-files=normal | grep -vE '^\?\? .*\.DS_Store$' || true)
if [ -n "$dirty" ]; then
  echo "git-check: есть незакоммиченные изменения:"
  printf '%s\n' "$dirty"
  echo "Правило проекта: закрывать работу коммитом и 'git push origin <ветка>'."
  exit 1
fi

git fetch --quiet origin 2>/dev/null || true
ahead=$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
if [ "${ahead:-0}" -gt 0 ]; then
  echo "git-check: $ahead неотправленных коммитов — сделайте 'git push origin <ветка>'"
  exit 1
fi
echo "git-check: дерево чистое, всё отправлено"
