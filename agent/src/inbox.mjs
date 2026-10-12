/**
 * Incoming attachments: save them in the workspace, extract what text we can.
 *
 * The agent runs headless, so everything reaching the model is plain text.
 * Documents give their text through `extract.mjs`; images are read by the vision
 * client and, if that is unavailable, by local OCR — either way the result is
 * text in the task. Whatever could not be read is reported to the user instead
 * of being silently dropped.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { extractText, MAX_TEXT_CHARS } from './extract.mjs'
import { sniffImageMime } from './vision.mjs'

/** Human word for an attachment kind. */
const KIND_WORD = { photo: 'фото', voice: 'голосовое', audio: 'аудио', document: 'файл', video: 'видео' }

/** Characters of extracted text kept per file for the prompt. */
const PER_FILE_TEXT_CHARS = 12_000

/** Strip path separators and control characters from a user-supplied name. */
export function safeFileName(name, fallback = 'file') {
  const cleaned = String(name ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
  return cleaned === '' ? fallback : cleaned
}

/** Timestamp prefix that keeps inbox files unique and ordered. */
const stamp = (date) => date.toISOString().replace(/[:.]/g, '-').slice(0, 19)

/**
 * Download every attachment into `inbox/` and try to read text out of it.
 *
 * Nothing here throws for a single bad attachment: an unusable file becomes a
 * note, and the task still runs.
 *
 * @param {object} options - intake options.
 * @param {object} options.platform - adapter with `downloadFile`.
 * @param {Array<object>} options.attachments - normalised attachments.
 * @param {string} options.dir - workspace root.
 * @param {number} [options.maxBytes] - per-file download cap.
 * @param {object} [options.vision] - vision client for images (optional).
 * @param {object} [options.ocr] - local OCR fallback for images (optional).
 * @param {Function} [options.stt] - transcriber `(bytes, info) => Promise<string>`.
 * @param {number} [options.sttMaxBytes] - recordings above this are not transcribed.
 * @param {object} [options.logger] - logger.
 * @param {() => Date} [options.now] - clock, injected by tests.
 * @returns {Promise<{files: Array<object>, notes: Array<string>, usage: object}>} saved
 *   files, user-facing notes, and the token usage of the image calls.
 */
export async function saveAttachments({
  platform,
  attachments = [],
  dir,
  maxBytes = 20_000_000,
  vision,
  ocr,
  stt,
  sttMaxBytes = 1_000_000,
  logger,
  now = () => new Date(),
} = {}) {
  const files = []
  const notes = []
  const usage = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 }
  if (attachments.length === 0) return { files, notes, usage }

  const inbox = path.join(dir, 'inbox')
  await fs.mkdir(inbox, { recursive: true })
  const moment = now()

  for (const attachment of attachments) {
    const word = KIND_WORD[attachment.kind] ?? 'вложение'
    if (!attachment.fileId) {
      notes.push(`${word}: не удалось получить файл (нет идентификатора).`)
      continue
    }
    let downloaded
    try {
      downloaded = await platform.downloadFile({ fileId: attachment.fileId, maxBytes })
    } catch (error) {
      logger?.warn('attachment download failed', { kind: attachment.kind, error })
      notes.push(`${word}: не удалось скачать (${String(error?.description ?? error?.message ?? error).slice(0, 120)}).`)
      continue
    }

    const name = safeFileName(attachment.name ?? downloaded?.fileName, `${attachment.kind ?? 'file'}`)
    const target = path.join(inbox, `${stamp(moment)}-${name}`)
    try {
      await fs.writeFile(target, downloaded.bytes, { mode: 0o600 })
    } catch (error) {
      logger?.warn('attachment save failed', { error })
      notes.push(`${word} «${name}»: не удалось сохранить в рабочей папке.`)
      continue
    }

    const entry = {
      path: target,
      relPath: path.relative(dir, target),
      name,
      size: downloaded.bytes.length,
      kind: attachment.kind,
      mime: attachment.mime,
    }

    if (attachment.kind === 'photo') {
      // An image reaches the model only as text, so it is read here: vision
      // first (it understands layout, not just glyphs), local OCR as fallback.
      await readImage({ entry, bytes: downloaded.bytes, vision, ocr, logger, usage })
    } else if (attachment.kind === 'voice' || attachment.kind === 'audio') {
      // A voice note becomes text for the same reason an image does.
      await readAudio({ entry, bytes: downloaded.bytes, stt, maxBytes: sttMaxBytes, logger })
    } else if (attachment.kind === 'document' || attachment.kind === 'video') {
      try {
        const result = extractText({ fileName: name, mimeType: attachment.mime, bytes: downloaded.bytes })
        if (result?.error) {
          entry.extractError = result.error
        } else if (typeof result?.text === 'string' && result.text.trim() !== '') {
          entry.text = result.text.slice(0, PER_FILE_TEXT_CHARS)
          entry.truncated = Boolean(result.truncated) || result.text.length > PER_FILE_TEXT_CHARS
        }
      } catch (error) {
        logger?.warn('attachment extraction failed', { error, name })
        entry.extractError = 'не удалось разобрать файл'
      }
    }

    logger?.info('attachment saved', { kind: attachment.kind, name, bytes: entry.size, text: Boolean(entry.text), source: entry.source })
    files.push(entry)
  }

  return { files, notes, usage }
}

/**
 * Give an image a textual reading: vision when possible, OCR when not.
 *
 * The result lands in `entry.text` with `entry.source` saying where it came
 * from, so the prompt and the reply can be honest about how the picture was
 * understood.
 */
async function readImage({ entry, bytes, vision, ocr, logger, usage }) {
  const mime = entry.mime ?? sniffImageMime(bytes)

  if (vision?.enabled && entry.size <= (vision.maxImageBytes ?? Number.POSITIVE_INFINITY)) {
    const result = await vision.describe({ bytes, mime })
    if (result.usage) {
      usage.prompt_tokens += Number(result.usage.prompt_tokens) || 0
      usage.completion_tokens += Number(result.usage.completion_tokens) || 0
      usage.cached_tokens += Number(result.usage.cached_tokens) || 0
    }
    if (result.text) {
      entry.text = result.text.slice(0, PER_FILE_TEXT_CHARS)
      entry.source = 'vision'
      return
    }
    entry.visionError = result.error
  } else if (vision?.enabled) {
    entry.visionError = `изображение больше лимита распознавания (${entry.size} Б)`
  }

  if (ocr?.enabled) {
    const result = await ocr.extract({ path: entry.path })
    if (result.text) {
      entry.text = result.text.slice(0, PER_FILE_TEXT_CHARS)
      entry.source = 'ocr'
      return
    }
    entry.ocrError = result.error
    logger?.debug('ocr did not read the image', { name: entry.name, error: result.error })
  }
}

/**
 * Transcribe a voice note into text.
 *
 * SpeechKit's short-audio endpoint takes about a minute of speech, so a longer
 * recording is reported rather than silently dropped: the answer says the note
 * could not be read, and the file stays in `inbox/`.
 */
async function readAudio({ entry, bytes, stt, maxBytes, logger }) {
  if (!stt) return
  if (bytes.length > maxBytes) {
    entry.sttError = `запись больше лимита распознавания (${bytes.length} Б)`
    return
  }
  try {
    const text = await stt(bytes, { mime: entry.mime, name: entry.name })
    if (typeof text === 'string' && text.trim() !== '') {
      entry.text = text.trim().slice(0, PER_FILE_TEXT_CHARS)
      entry.source = 'stt'
      return
    }
    entry.sttError = 'речь не распознана'
  } catch (error) {
    logger?.warn('transcription failed', { name: entry.name, error })
    entry.sttError = String(error?.message ?? error).slice(0, 200)
  }
}

/** The largest text we will ever take from one file. */
export { MAX_TEXT_CHARS }
