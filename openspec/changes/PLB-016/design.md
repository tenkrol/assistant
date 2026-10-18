# Решение

`health()` вызывает `GET /v1/health` без токена (health публичный на loopback), но
клиент уже имеет token; ответ `{ok,service,contract,release}`. Команда не печатает
токены/пути.
