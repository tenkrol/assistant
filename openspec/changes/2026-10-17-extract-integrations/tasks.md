# Задачи

## 1. Спецификация
- [x] 1.1 Дельта `integrations` написана, владелец одобрил

## 2. Перенос подключений (после каждого шага — полный прогон)
- [ ] 2.1 `src/integrations/telegram/` (клиент Bot API) + реэкспорт `src/telegram.mjs`
- [ ] 2.2 `src/integrations/platforms/` (порт и адаптеры Telegram, VK) + реэкспорты
- [ ] 2.3 `src/integrations/model/` (DeepSeek, ошибки провайдера, thinking-модели)
- [ ] 2.4 `src/integrations/yandex-speech/` (STT и TTS) 
- [ ] 2.5 `src/integrations/weather/` (погода и предупреждения)
- [ ] 2.6 `src/integrations/youtube/` и `src/integrations/web/` (поиск и страницы)
- [ ] 2.7 `src/integrations/smart-home/` (Home Assistant)
- [ ] 2.8 Общий помощник ошибок и таймаутов подключений
- [ ] 2.9 Убедиться, что вне `src/integrations/` нет прямых сетевых вызовов

## 3. Проверка
- [ ] 3.1 Полный прогон тестов зелёный
- [ ] 3.2 Тесты провайдеров не требуют реальной сети

## 4. Деплой и проверка
- [ ] 4.1 deploy-safe
- [ ] 4.2 На сервере: бот отвечает, погода, голос, поиск

## 5. Закрытие
- [ ] 5.1 Дельта влита в `openspec/specs/integrations/`, изменение заархивировано
- [ ] 5.2 `docs/HANDOFF.md` обновлён
