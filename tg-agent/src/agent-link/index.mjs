/**
 * Домен agent-link: правила связи с агентом-исполнителем (PLB-009).
 *
 * Домен не ходит в сеть: транспорт приходит портом (`bridge`). Здесь — режим
 * контракта v2, ожидающие вопросы и ответ владельца обычным сообщением.
 */
const CANCEL_WORDS = /^(отмена|отмени|cancel|стоп)$/i

export function createAgentLink({ bridge, events, answerTimeoutMs = 86_400_000, logger, now = () => Date.now() } = {}) {
  return {
    enabled: Boolean(bridge?.enabled),

    /** Запомнить вопрос агента, чтобы ответ владельца продолжил задачу. */
    async rememberQuestion(event, chatId) {
      if (!events) return
      const routeChat = chatId ?? event?.route?.chatId
      if (routeChat === undefined) return
      await events.setPending(routeChat, {
        taskId: event.taskId,
        eventId: event.eventId,
        question: event.question?.text ?? event.text ?? '',
        askedAt: now(),
      })
    },

    /** Ожидающий вопрос, если он ещё не просрочен. */
    pendingFor(chatId) {
      const pending = events?.pendingFor?.(chatId)
      if (!pending) return undefined
      if (now() - Number(pending.askedAt ?? 0) > answerTimeoutMs) return { ...pending, expired: true }
      return pending
    },

    /**
     * Обработать сообщение владельца, если бот ждёт ответа агента.
     *
     * @returns {Promise<{handled: boolean, message?: string}|undefined>} результат или undefined,
     *   если сообщение не относится к вопросу агента.
     */
    async handleOwnerMessage({ chatId, text } = {}) {
      const pending = this.pendingFor(chatId)
      if (!pending) return undefined
      if (pending.expired) {
        await events?.clearPending?.(chatId)
        return { handled: true, message: '🕓 Вопрос агента больше не актуален: время ожидания истекло. Это сообщение обработаю как новую задачу.' }
      }
      const answer = String(text ?? '').trim()
      try {
        if (CANCEL_WORDS.test(answer)) {
          await bridge.cancelTask(pending.taskId)
          await events?.clearPending?.(chatId)
          return { handled: true, message: `⛔ Задачу ${pending.taskId} отменил.` }
        }
        await bridge.replyTask(pending.taskId, answer)
        await events?.clearPending?.(chatId)
        return { handled: true, message: `✅ Ответ передал агенту по задаче ${pending.taskId}.` }
      } catch (error) {
        logger?.warn('agent answer delivery failed', { taskId: pending.taskId, error: error?.message ?? error })
        return { handled: true, message: '⚠️ Не удалось передать ответ агенту. Попробуйте ещё раз или /cancel.' }
      }
    },

    /** Постановка задачи через транспорт (для инструмента и тестов). */
    submit: (request) => bridge.submitTask(request),
  }
}
