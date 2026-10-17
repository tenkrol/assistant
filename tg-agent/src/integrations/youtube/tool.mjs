/**
 * The `youtube` tool: fetch what a video says so the model can retell it.
 *
 * The tool deliberately returns the *content* (title, description, subtitles) rather
 * than a summary of its own: the summary belongs to the model that is already holding
 * the conversation, and a second model call inside a tool would double the cost and
 * lose the context.
 */
import { MAX_TRANSCRIPT_CHARS, fetchVideo, parseVideoId } from './youtube.mjs'

/** The tool definition handed to the model. */
export const YOUTUBE_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'youtube',
    description:
      'Видео на YouTube: получить название, описание и субтитры по ссылке, чтобы пересказать содержание. '
      + 'Используй, когда присылают ссылку на YouTube и просят конспект, краткое содержание или «о чём видео».',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Ссылка на видео YouTube (watch, youtu.be, shorts).' },
      },
      required: ['url'],
    },
  },
}

/**
 * Build the tool.
 *
 * @param {object} [options] - `{ fetchImpl, logger, maxChars }`.
 * @returns {{definition: object, execute: Function, executeDetailed: Function}} the tool.
 */
export function createYoutubeTool({ fetchImpl, logger, maxChars = MAX_TRANSCRIPT_CHARS } = {}) {
  const executeDetailed = async (args = {}) => {
    const url = String(args.url ?? '').trim()
    if (parseVideoId(url) === undefined) {
      return { text: 'Ошибка инструмента youtube: не нашёл ссылку на видео в аргументе url.' }
    }
    const video = await fetchVideo({ url, ...(fetchImpl ? { fetchImpl } : {}), maxChars, logger })
    if (!video?.ok) {
      return { text: `Ошибка инструмента youtube: ${video?.reason ?? 'не удалось получить видео'}.` }
    }
    const parts = [
      `Видео: ${video.title ?? 'без названия'}${video.author ? ` — канал ${video.author}` : ''}`,
      video.reason ? `Примечание: ${video.reason}` : '',
      video.description ? `Описание:\n${video.description}` : '',
      video.transcript ? `Субтитры (${video.language ?? 'язык не определён'}):\n${video.transcript}` : '',
    ].filter(Boolean)
    return { text: parts.join('\n\n'), video }
  }

  return {
    definition: YOUTUBE_TOOL_DEFINITION,
    executeDetailed,
    execute: async (args) => (await executeDetailed(args)).text,
  }
}
