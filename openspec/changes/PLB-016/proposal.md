# PLB-016: показ установленной версии агента

Основание: REQ-0002, E3. Агент PLA-28 отдаёт release в /v1/health.

## Что меняется
- v2 client `health()`.
- Команда `/agentversion`: service/contract/release, понятная ошибка при недоступности.

## Не входит
API создания PR, деплой.
