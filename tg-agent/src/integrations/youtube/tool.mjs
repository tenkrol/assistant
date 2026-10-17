/**
 * Прежний путь инструмента YouTube.
 *
 * Инструмент переехал в `src/tools/youtube-tool.mjs`; здесь остаётся реэкспорт,
 * чтобы не ломать внешние импорты. Подключение к сети живёт в `./youtube.mjs`.
 */
export * from '../../tools/youtube-tool.mjs'
