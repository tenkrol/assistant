# Решение

`src/core/request-detect.mjs` — чистый детектор без сети. В `conversation.handleMessage`
после команд и до обычного ответа: если детектор true, `agentBridge.createRequest`,
ответ и return. Порог строгий: нужен глагол изменения и слово про продукт.
