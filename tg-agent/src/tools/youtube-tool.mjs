/**
 * Инструмент `youtube`: получить содержание видео, чтобы модель его пересказала.
 *
 * Инструмент намеренно возвращает *контент* (название, описание, субтитры), а не
 * своё резюме: пересказ — работа модели, которая уже держит разговор. Второй
 * вызов модели внутри инструмента удвоил бы цену и потерял бы контекст.
 *
 * Сеть — только через подключение `src/integrations/youtube/`.
 */
import { MAX_TRANSCRIPT_CHARS, fetchVideo, parseVideoId } from '../integrations/youtube/youtube.mjs'
import { createTool } from './contract.mjs'

/** Описание инструмента для модели. */
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
 * Собрать инструмент.
 *
 * @param {object} [options] - `{ fetchImpl, logger, maxChars }`.
 * @returns {{definition: object, executeDetailed: Function, execute: Function}} инструмент.
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

  return createTool({ definition: YOUTUBE_TOOL_DEFINITION, executeDetailed })
}
