# Задачи

## 1. Спецификация
- [x] 1.1 Дельта `integrations` написана, владелец одобрил

## 2. Перенос подключений (после каждого шага — полный прогон)
- [x] 2.1 `src/integrations/telegram/` (клиент Bot API) + реэкспорт `src/telegram.mjs`
- [x] 2.2 `src/integrations/platforms/` (порт и адаптеры Telegram, VK) + реэкспорты
- [x] 2.3 `src/integrations/model/` (DeepSeek, ошибки провайдера, thinking-модели)
- [x] 2.4 `src/integrations/yandex-speech/` (STT и TTS) 
- [x] 2.5 `src/integrations/weather/` (погода и предупреждения)
- [x] 2.6 `src/integrations/youtube/` и `src/integrations/web/` (поиск и страницы)
- [x] 2.7 `src/integrations/smart-home/` (Home Assistant)
- [x] 2.8 Общий помощник ошибок и таймаутов подключений
- [x] 2.9 Убедиться, что вне `src/integrations/` нет прямых сетевых вызовов

## 3. Проверка
- [x] 3.1 Полный прогон тестов зелёный
- [x] 3.2 Тесты провайдеров не требуют реальной сети

## 4. Деплой и проверка
- [x] 4.1 deploy-safe
- [x] 4.2 На сервере: бот отвечает, погода, голос, поиск

## 5. Закрытие
- [x] 5.1 Дельта влита в `openspec/specs/integrations/`, изменение заархивировано
- [x] 5.2 `docs/HANDOFF.md` обновлён
