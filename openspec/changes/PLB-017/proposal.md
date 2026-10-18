# PLB-017: команда /request — заявка из сообщения

Основание: E4. Агент PLA-29 принимает POST /v1/requests и публикует draft-ветку.

## Что меняется
- v2 client `createRequest(text,title)`.
- `/request <текст>` создаёт заявку в spec-репозитории и возвращает requestId/compare URL.
- Понятные ошибки при выключенном/старом мосте.
