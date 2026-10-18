# Дельта для домена agent-link

## ADDED Requirements

### Requirement: Заявка из бота
Бот ДОЛЖЕН создавать draft-заявку через агентский `/v1/requests` и показывать
requestId и ссылку на сравнение; ошибки — понятным сообщением.

#### Scenario: /request
- GIVEN агент доступен
- WHEN владелец вводит /request <текст>
- THEN создаётся заявка
- AND видны requestId и compare URL.
