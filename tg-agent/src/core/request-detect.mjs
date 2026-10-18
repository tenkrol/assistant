/**
 * F1: классификация намерения без модели.
 *
 * data      — операция с данными владельца (напоминания, календарь, память, поручения);
 * product   — изменение поведения бота/агента;
 * ambiguous — продуктовая лексика без явного намерения, нужно уточнение.
 */
const CHANGE = /(^|\s)(добав|измен|доработ|убери|удали|переделай|сделай так,? чтобы|нужно чтобы|надо чтобы|хочу чтобы|научи|поддержи)/i
const EXPLICIT_PRODUCT = /(в бот[ае]|в агент[ае]|бот долж|агент долж|измени поведен|добавь (возможность|функци|команд|поддержк)|научи|поддержи|повторять|сценари|интерфейс|мини-прилож|автоматизац)/i
const DATA = /(напомин|напомина|встреч|календар|памят|запомн|позвон|купить|опрос|проект|поручен|событ|дел[ао])/i
const PRODUCT = /(бот|агент|команд|панел|интерфейс|функци|возможност|приложен|сценари|автоматизац|поддержк|повторя|умел|научи)/i

export function classifyChangeRequest(text) {
  const clean = String(text ?? '').trim()
  if (clean.length < 8 || clean.length > 2000) return 'data'
  if (!CHANGE.test(clean)) return 'data'
  if (EXPLICIT_PRODUCT.test(clean)) return 'product'
  if (DATA.test(clean)) return 'data'
  if (PRODUCT.test(clean)) return 'ambiguous'
  return 'data'
}

export function looksLikeChangeRequest(text) {
  return classifyChangeRequest(text) === 'product'
}
