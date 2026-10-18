# Решение

Запись WorkItem: id, kind, title/detail, ownerId, scopeId, source{type,ref,at},
epistemic, status, createdAt/updatedAt, dueAt/staleAfter, parentId, history[].
Факт, предположение и предложение различаются явно. Изменение статуса пишет историю.
Хранилище — JSON-store, как reminders, с фильтрацией по scope/owner.
