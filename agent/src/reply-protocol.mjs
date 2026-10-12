/**
 * The dialogue protocol on top of a one-shot run.
 *
 * DSH's headless profile prints one final message and exits — there is no
 * interactive channel inside the run. The agent is therefore taught two markers
 * in its workspace `AGENTS.md`:
 *
 *   - `ВОПРОС: …`        — I cannot continue without an answer; stop here.
 *   - `ВАРИАНТ 1: …`     — the task has several reasonable paths; pick one.
 *
 * This module recognises those markers in the answer and splits the message into
 * what the user should read and what the bot has to do next. Markers are matched
 * loosely (bold, list bullets, quotes) because a model formats text its own way.
 */

/** How many variants are worth showing, even if the model wrote more. */
export const MAX_VARIANTS = 5

/** Strip the decoration a model adds around a marker word. */
function cleanLabel(line) {
  return String(line ?? '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/^[\s>*#•\-–—]+/, '')
    .trim()
}

const QUESTION_RE = /^ВОПРОС\s*:?\s*(.*)$/i
const VARIANT_RE = /^ВАРИАНТ\s*(\d+)\s*:?\s*(.*)$/i

/**
 * Split a final answer into its parts.
 *
 * @param {string} text - the final message of a run.
 * @param {object} [options] - `maxVariants`.
 * @returns {{kind: 'answer'|'question'|'variants', answer: string, question: string,
 *   variants: Array<{n: number, text: string}>}} the parsed reply.
 */
export function parseReply(text, { maxVariants = MAX_VARIANTS } = {}) {
  const raw = String(text ?? '')
  const lines = raw.split(/\r?\n/)

  // Markers in the order they appear; a body runs up to the next marker of any
  // kind, so a question asked before the variants does not swallow them.
  const markers = []
  for (const [index, line] of lines.entries()) {
    const label = cleanLabel(line)
    if (QUESTION_RE.test(label)) {
      markers.push({ index, kind: 'question', head: label.replace(QUESTION_RE, '$1').trim() })
      continue
    }
    const match = label.match(VARIANT_RE)
    if (match) markers.push({ index, kind: 'variant', n: Number(match[1]), head: match[2].trim() })
  }

  const bodyOf = (marker) => {
    const next = markers.find((other) => other.index > marker.index)?.index ?? lines.length
    const tail = lines.slice(marker.index + 1, next).join('\n').trim()
    return [marker.head, tail].filter(Boolean).join('\n').trim()
  }

  const questionMarker = markers.find((marker) => marker.kind === 'question')
  const variantMarkers = markers.filter((marker) => marker.kind === 'variant')

  // A model that lists variants usually also asks which one to take. Variants
  // win: a choice is an answer, and the question travels along as the intro.
  if (variantMarkers.length >= 2) {
    return {
      kind: 'variants',
      answer: lines.slice(0, markers[0].index).join('\n').trim(),
      question: questionMarker ? bodyOf(questionMarker) : '',
      variants: variantMarkers.slice(0, maxVariants).map((marker) => ({ n: marker.n, text: bodyOf(marker) })),
    }
  }

  if (questionMarker) {
    const question = bodyOf(questionMarker)
    return {
      kind: 'question',
      answer: lines.slice(0, questionMarker.index).join('\n').trim(),
      question: question === '' ? 'Нужно уточнение по задаче.' : question,
      variants: [],
    }
  }

  return { kind: 'answer', answer: raw.trim(), question: '', variants: [] }
}

/**
 * The text handed back to the agent when the user picks a variant or answers a
 * question, so the next run continues exactly where the previous one stopped.
 *
 * @param {object} input - `kind`, `value` (variant text) or `text` (answer).
 * @returns {string} the continuation prompt.
 */
export function buildContinuation({ kind, text, variant } = {}) {
  const answer = String(text ?? '').trim()
  if (kind === 'variant') {
    return [
      'Пользователь выбрал вариант:',
      String(variant ?? '').trim(),
      answer === '' ? '' : `Его уточнение: ${answer}`,
      'Выполни выбранный вариант до конца.',
    ].filter(Boolean).join('\n')
  }
  return [
    'Ответ пользователя на твой вопрос:',
    answer,
    'Продолжи выполнение задачи с учётом этого ответа.',
  ].join('\n')
}

/** A short label for one variant button: the first words of its text. */
export function variantButtonLabel(variant, { maxChars = 28 } = {}) {
  const first = String(variant?.text ?? '').split('\n')[0].replace(/\s+/g, ' ').trim()
  const prefix = `${variant?.n ?? '?'}. `
  // The budget covers the whole button, number included.
  const room = Math.max(4, maxChars - prefix.length)
  const short = first.length > room ? `${first.slice(0, room - 1)}…` : first
  return `${prefix}${short === '' ? 'вариант' : short}`
}
