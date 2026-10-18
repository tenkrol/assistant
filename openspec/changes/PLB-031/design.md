# Решение

SHA не угадывается: упаковщик кладёт `RELEASE_SHA`, tool проверяет 40-hex. Тест
использует timeZone Europe/Moscow, как конфигурация бота.
