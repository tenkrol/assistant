# Дельта для домена ops

## ADDED Requirements

### Requirement: Проверка релиза использует установленный Node.js
Установщик ДОЛЖЕН создавать `deploy-verify.service` с фактическим абсолютным
путём Node.js и включать его timer.

#### Scenario: Node.js установлен в /usr/bin
- GIVEN `command -v node` возвращает `/usr/bin/node`
- WHEN выполняется deploy-remote
- THEN ExecStart начинается с `/usr/bin/node`
- AND ручной запуск unit завершается успешно.
