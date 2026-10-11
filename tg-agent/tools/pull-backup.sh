#!/usr/bin/env bash
#
# Pull the newest state backup from the server to this Mac.
#
# The server keeps a daily tg-agent state archive (see deploy/tg-agent-backup.timer);
# this script copies the newest one over SSH, so losing the VPS does not lose the
# bot's history, offset and reminders.
#
# Usage:
#
#   bash tools/pull-backup.sh
#   SERVER=root@example.com KEY=~/.ssh/id_ed25519 bash tools/pull-backup.sh
#   LOCAL_DIR=~/tg-backups LOCAL_KEEP=30 bash tools/pull-backup.sh
#
# Variables (all optional):
#   SERVER      server to read from            (default root@185.174.136.53)
#   KEY         SSH private key                (default ./.ssh/tg-agent-deploy)
#   REMOTE_DIR  remote backup directory        (default /var/backups/tg-agent)
#   LOCAL_DIR   local destination directory    (default ./backups)
#   LOCAL_KEEP  how many local archives to keep (default 14)
#
# Run it on a schedule with launchd (macOS). Save the plist below as
# ~/Library/LaunchAgents/com.tg-agent.pull-backup.plist, replace the user name,
# then load it once:
#
#   launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.tg-agent.pull-backup.plist
#   launchctl print gui/$UID/com.tg-agent.pull-backup        # state
#   launchctl kickstart -k gui/$UID/com.tg-agent.pull-backup # run now
#
#   <?xml version="1.0" encoding="UTF-8"?>
#   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
#   <plist version="1.0">
#   <dict>
#     <key>Label</key><string>com.tg-agent.pull-backup</string>
#     <key>ProgramArguments</key>
#     <array>
#       <string>/bin/bash</string>
#       <string>/Users/andryukovy/Documents/deepseek-harness/default-workspace/tg-agent/tools/pull-backup.sh</string>
#     </array>
#     <key>WorkingDirectory</key><string>/Users/andryukovy/Documents/deepseek-harness/default-workspace/tg-agent</string>
#     <key>StartCalendarInterval</key>
#     <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
#     <key>StandardOutPath</key><string>/tmp/tg-agent-pull-backup.log</string>
#     <key>StandardErrorPath</key><string>/tmp/tg-agent-pull-backup.err</string>
#   </dict>
#   </plist>
#
# Or with cron (the same command, once a day at 09:00):
#
#   crontab -e
#   0 9 * * * cd /Users/andryukovy/Documents/deepseek-harness/default-workspace/tg-agent && bash tools/pull-backup.sh >> backups/pull.log 2>&1
#
set -euo pipefail

# Defaults resolve relative to the project, not to the current directory, so the
# script behaves the same from cron/launchd and from a shell.
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SERVER=${SERVER:-root@185.174.136.53}
KEY=${KEY:-$ROOT_DIR/.ssh/tg-agent-deploy}
REMOTE_DIR=${REMOTE_DIR:-/var/backups/tg-agent}
LOCAL_DIR=${LOCAL_DIR:-$ROOT_DIR/backups}
LOCAL_KEEP=${LOCAL_KEEP:-14}

log() { printf '=== %s\n' "$*"; }
die() { printf 'ОШИБКА: %s\n' "$*" >&2; exit 1; }

[ -n "$SERVER" ] || die "не задан SERVER (например SERVER=root@185.174.136.53)"
[ -f "$KEY" ] || die "нет файла SSH-ключа: $KEY — задайте KEY=/путь/к/ключу или положите ключ в .ssh/tg-agent-deploy"
case "$LOCAL_KEEP" in
  ''|*[!0-9]*) die "LOCAL_KEEP должен быть целым числом >= 1, получено: $LOCAL_KEEP" ;;
esac
[ "$LOCAL_KEEP" -ge 1 ] || die "LOCAL_KEEP должен быть >= 1, получено: $LOCAL_KEEP"

# BatchMode: never hang on a password prompt under cron/launchd.
SSH_OPTS=(-i "$KEY" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)

log "ищу свежий архив на $SERVER:$REMOTE_DIR"
latest=$(ssh "${SSH_OPTS[@]}" "$SERVER" "ls -1t '$REMOTE_DIR'/state-*.tar.gz 2>/dev/null | head -1" || true)
[ -n "$latest" ] || die "не удалось получить список архивов с $SERVER:$REMOTE_DIR — сервер недоступен или архивов ещё нет (проверьте: ssh -i $KEY $SERVER)"

mkdir -p "$LOCAL_DIR"
target="$LOCAL_DIR/$(basename "$latest")"
log "копирую $latest -> $target"
scp -q "${SSH_OPTS[@]}" "$SERVER:$latest" "$target" || die "scp не смог скачать архив (проверьте доступ к $SERVER и путь $latest)"
[ -s "$target" ] || die "получен пустой файл: $target"

# Rotation: keep the newest LOCAL_KEEP archives, delete older ones. The list is
# processed line by line so names with spaces survive and bash 3.2 (macOS) works.
removed=0
old_archives=$(ls -1t "$LOCAL_DIR"/state-*.tar.gz 2>/dev/null | tail -n +$((LOCAL_KEEP + 1)) || true)
if [ -n "$old_archives" ]; then
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    rm -f -- "$old"
    removed=$((removed + 1))
    log "удалён старый локальный архив: $old"
  done <<EOF
$old_archives
EOF
fi

kept=$(ls -1 "$LOCAL_DIR"/state-*.tar.gz 2>/dev/null | wc -l | tr -d ' ')
log "готово: $target ($(du -h "$target" | cut -f1))"
log "локально: $kept архив(ов) в $LOCAL_DIR, удалено старых: $removed"
