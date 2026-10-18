# Дельта для домена agent-link

## ADDED Requirements

### Requirement: Версия агента в боте
Бот ДОЛЖЕН показывать установленный релиз агента из /v1/health; при недоступности —
понятное сообщение без секретов.

#### Scenario: /agentversion
- GIVEN агент доступен
- WHEN владелец вводит /agentversion
- THEN видны service, contract и release.
