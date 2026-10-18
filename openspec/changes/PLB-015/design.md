# Техническое решение

- v2-клиент: `call('/v1/agents',{method:'GET'})`, `call('/v1/activity?...')`;
  возвращает `agents[]`/`events[]`, ошибки — AgentBridgeError.
- Команды читают `bot.agentBridge`; при `enabled=false` или отсутствии методов
  отвечают «агент недоступен/старый контракт».
- Формат: `/agents` — id, profile, caps, status; `/activity` — время, taskId,
  agent, type, status, tokens.
- Никаких секретов и сырых ошибок в ответе.
