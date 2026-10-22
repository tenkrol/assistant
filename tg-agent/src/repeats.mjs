/**
 * Совместимый вход к расписаниям повторов.
 *
 * Сами правила повторов живут в доменном слое — `src/domain/repeats.mjs`.
 * Файл оставлен, чтобы старые импорты продолжали работать; нового кода здесь
 * быть не должно.
 */
export {
  EVERY_LIMITS,
  REPEAT_VALUES,
  describeRepeat,
  isRepeat,
  nextDue,
  repeatAfterDelivery,
  repeatIssue,
} from './domain/repeats.mjs'
