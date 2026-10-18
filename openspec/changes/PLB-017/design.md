# Решение

`createRequest` → POST `/v1/requests` с token; ответ `{requestId,branch,sha,compareUrl}`.
Команда не делает анализ компонентов: это draft, доработку спецификации выполняет
агент на следующем этапе.
