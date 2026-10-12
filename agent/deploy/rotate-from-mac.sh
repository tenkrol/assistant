#!/usr/bin/env bash
#
# Rotate the agent's secrets from the Mac that holds the deploy key.
#
#   bash agent/deploy/rotate-from-mac.sh                 # и токен, и ключ (по очереди)
#   bash agent/deploy/rotate-from-mac.sh --token         # только токен бота
#   bash agent/deploy/rotate-from-mac.sh --api-key       # только ключ модели
#   bash agent/deploy/rotate-from-mac.sh --check         # проверить, что текущие рабочие
#
# The value is typed into an interactive prompt on the server (`ssh -t`), so it is
# never part of a command line, a shell history entry or a `ps` output. The
# server-side script validates the value, keeps a backup, restarts the service and
# rolls back by itself if the agent does not come up.
set -euo pipefail

SERVER=${SERVER:-root@185.106.94.155}
SSH_KEY=${SSH_KEY:-tg-agent/.ssh/tg-agent-deploy}
ENV_FILE=${ENV_FILE:-/etc/agent/agent.env}

ARGS=("$@")
[ ${#ARGS[@]} -gt 0 ] || ARGS=(--token --api-key)

printf 'Сервер: %s\n' "$SERVER"
printf 'Команда: rotate-secrets.sh %s\n\n' "${ARGS[*]}"

# -t: the remote script needs a terminal to read the secret without echoing it.
exec ssh -t -i "$SSH_KEY" -o ConnectTimeout=20 "$SERVER" \
  "ENV_FILE='$ENV_FILE' bash /opt/agent/deploy/rotate-secrets.sh ${ARGS[*]}"
