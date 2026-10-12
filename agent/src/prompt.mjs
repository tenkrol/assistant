/**
 * Task text assembly.
 *
 * The agent receives one plain-text task per run. This module decides what that
 * text contains: what the person asked, which files came with the message, what
 * text was extracted from them, and the small set of conventions the agent must
 * follow to hand a result back (deliverables belong in `outbox/`).
 *
 * Environment facts — the working directory, LibreOffice, the Python
 * environment — do not belong here: they ship once in the workspace `AGENTS.md`,
 * which DSH loads on every run.
 */
import { formatSize } from './workspace.mjs'

/** Default budget for the whole prompt, in characters. */
const DEFAULT_MAX_CHARS = 8000

/**
 * How the agent should behave when a task is ambiguous or under-specified.
 *
 * These lines are the runtime half of the dialogue protocol: `AGENTS.md`
 * explains what the markers mean, this decides how eagerly to use them.
 */
export const VARIANT_DIRECTIVES = {
  auto: 'Если у задачи несколько разумных путей и выбор меняет результат — предложи 2–3 варианта строками «ВАРИАНТ 1: …», «ВАРИАНТ 2: …», коротко пояснив разницу и цену каждого, и остановись, не выполняя работу до выбора. Если задача однозначная — просто выполни её. Если не хватает данных — задай один вопрос строкой «ВОПРОС: …» и остановись.',
  always: 'Всегда предлагай 2–3 варианта решения строками «ВАРИАНТ 1: …», «ВАРИАНТ 2: …» с пояснением разницы и не выполняй работу, пока вариант не выбран. Если данных не хватает — сначала задай вопрос строкой «ВОПРОС: …».',
  never: 'Варианты не предлагай: выбери лучший путь сам и выполни задачу. Если без ответа пользователя задачу не решить — задай один вопрос строкой «ВОПРОС: …» и остановись.',
}

/**
 * Build the task text for one headless run.
 *
 * @param {object} input - `text` from the user, saved `files`, `notes`.
 * @param {string} [input.text] - the message text.
 * @param {Array<object>} [input.files] - entries from `saveAttachments`.
 * @param {Array<string>} [input.notes] - attachment problems to report.
 * @param {number} [input.maxChars] - prompt size budget.
 * @param {string} [input.variantsMode] - `auto`, `always` or `never`.
 * @returns {string} the task text, never empty.
 */
export function buildTaskPrompt({ text = '', files = [], notes = [], memory = '', maxChars = DEFAULT_MAX_CHARS, variantsMode } = {}) {
  const asked = String(text ?? '').trim()
  const budget = Math.max(1000, Number(maxChars) || DEFAULT_MAX_CHARS)
  const parts = []

  parts.push(asked === ''
    ? 'Разбери вложения из этой задачи и выполни то, что в них требуется. Ответь по-русски.'
    : asked)

  if (variantsMode && VARIANT_DIRECTIVES[variantsMode]) parts.push(VARIANT_DIRECTIVES[variantsMode])

  // Durable facts about the owner: what was learned in earlier tasks, so it does
  // not have to be repeated. Never invented by the model, only accumulated.
  const facts = String(memory ?? '').trim()
  if (facts !== '') {
    parts.push(['', 'Что уже известно о пользователе и его делах (учитывай, но не переспрашивай):', facts].join('\n'))
  }

  if (files.length > 0 || notes.length > 0) {
    const inventory = files.map((file) => {
      const where = `- \`${file.relPath}\` (${formatSize(file.size)}`
      const spoken = file.kind === 'voice' || file.kind === 'audio'
      const extra = file.text
        ? (file.kind === 'photo' ? ', изображение распознано ниже' : spoken ? ', расшифровка ниже' : ', текст извлечён ниже')
        : file.kind === 'photo' ? ', изображение не прочитано' : spoken ? ', речь не распознана' : ''
      return `${where}${extra})`
    })
    const lines = ['', 'Приложенные файлы уже лежат в рабочей папке:']
    lines.push(...inventory)
    for (const note of notes) lines.push(`- ${note}`)
    parts.push(lines.join('\n'))
  }

  // Extracted text is the expensive part: give each file a share of what is
  // left after the task text and the inventory, and say when it was cut.
  const header = parts.join('\n')
  const remaining = Math.max(0, budget - header.length)
  const share = files.filter((file) => file.text).length > 0
    ? Math.floor(remaining / files.filter((file) => file.text).length)
    : 0
  for (const file of files) {
    if (!file.text) continue
    const text = share > 0 ? file.text.slice(0, share) : ''
    if (text.trim() === '') continue
    const cut = text.length < file.text.length
    parts.push([
      '',
      `Содержимое файла «${file.name}»${cut || file.truncated ? ' (приведено частично)' : ''}:`,
      '```',
      text,
      '```',
    ].join('\n'))
  }

  return parts.join('\n').trim()
}

/**
 * The user-facing note about attachments that could not be read.
 *
 * @param {Array<object>} files - entries from `saveAttachments`.
 * @param {Array<string>} notes - problems already collected there.
 * @returns {string} an empty string when everything was usable.
 */
export function describeAttachmentIssues(files = [], notes = []) {
  const lines = [...notes]
  for (const file of files) {
    if (file.extractError) lines.push(`«${file.name}»: ${file.extractError}`)
    if (file.kind === 'photo' && !file.text) {
      const reason = file.visionError ?? file.ocrError
      lines.push(`«${file.name}»: не удалось прочитать изображение${reason ? ` (${reason})` : ''}.`)
    }
    if ((file.kind === 'voice' || file.kind === 'audio') && !file.text) {
      lines.push(file.sttError
        ? `«${file.name}»: не удалось распознать речь (${file.sttError}).`
        : 'Голосовые сообщения агент пока не расшифровывает: нужен ключ распознавания речи (STT).')
    }
  }
  return lines.join('\n')
}
