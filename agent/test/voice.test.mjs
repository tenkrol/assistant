import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadConfig, secretsOf } from '../src/config.mjs'
import { saveAttachments } from '../src/inbox.mjs'
import { createBotHarness, createStubPlatform, tempDir, cleanup } from './helpers.mjs'

const base = { TELEGRAM_BOT_TOKEN: '1:a', ALLOWED_USER_IDS: '42' }
const NOW = () => new Date('2026-10-08T19:00:00Z')

const OK_USAGE = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 120, steps: 1, turns: 1 }

const result = (over = {}) => ({
  ok: true,
  exitCode: 0,
  timedOut: false,
  aborted: false,
  text: 'Готово: файл в outbox/отчёт.docx',
  sessionId: 'session-1',
  usage: OK_USAGE,
  tools: [],
  errors: [],
  stderr: '',
  durationMs: 1200,
  ...over,
})

const voiceMessage = (over = {}) => ({
  kind: 'message',
  id: 1,
  chat: { id: 42, type: 'private' },
  from: { id: 42, name: 'Вячеслав', isBot: false },
  text: '',
  attachments: [{ kind: 'voice', fileId: 'voice-1', mime: 'audio/ogg' }],
  addressed: true,
  messageId: 7,
  ...over,
})

test('voice is off by default, and one SpeechKit key serves both directions', () => {
  const config = loadConfig(base)
  assert.equal(config.voice.stt.provider, 'none')
  assert.equal(config.voice.tts.provider, 'none')
  assert.equal(config.voice.reply, 'auto')

  const configured = loadConfig({ ...base, STT_PROVIDER: 'yandex', STT_API_KEY: 'AQVN-secret', TTS_PROVIDER: 'yandex' })
  assert.equal(configured.voice.tts.apiKey, 'AQVN-secret', 'TTS defaults to the STT key')
  assert.equal(secretsOf(configured).includes('AQVN-secret'), true)
})

test('a bad provider or speed is refused with the variable name', () => {
  assert.throws(() => loadConfig({ ...base, STT_PROVIDER: 'whisper-cloud' }), /STT_PROVIDER/)
  assert.throws(() => loadConfig({ ...base, VOICE_REPLY: 'sometimes' }), /VOICE_REPLY/)
  assert.throws(() => loadConfig({ ...base, TTS_SPEED: '9' }), /TTS_SPEED/)
})

test('a voice note is transcribed and its text reaches the task', async () => {
  const dir = await tempDir()
  try {
    const platform = createStubPlatform()
    platform.downloads.set('voice-1', { bytes: Buffer.from('OggS-аудио'), fileName: 'voice.ogg' })
    const calls = []
    const stt = async (bytes, info) => {
      calls.push({ bytes, info })
      return 'собери отчёт по продажам за октябрь'
    }

    const { files, usage } = await saveAttachments({
      platform,
      attachments: [{ kind: 'voice', fileId: 'voice-1', mime: 'audio/ogg' }],
      dir,
      stt,
      now: NOW,
    })

    assert.equal(files[0].text, 'собери отчёт по продажам за октябрь')
    assert.equal(files[0].source, 'stt')
    assert.equal(calls[0].info.mime, 'audio/ogg')
    assert.equal(usage.prompt_tokens, 0, 'transcription is not a token expense')
  } finally {
    await cleanup(dir)
  }
})

test('a failed transcription keeps the reason and the file', async () => {
  const dir = await tempDir()
  try {
    const platform = createStubPlatform()
    platform.downloads.set('voice-1', { bytes: Buffer.from('OggS'), fileName: 'voice.ogg' })
    const { files } = await saveAttachments({
      platform,
      attachments: [{ kind: 'voice', fileId: 'voice-1' }],
      dir,
      stt: async () => {
        throw new Error('Yandex STT HTTP 401')
      },
      now: NOW,
    })
    assert.equal(files[0].text, undefined)
    assert.match(files[0].sttError, /401/)
  } finally {
    await cleanup(dir)
  }
})

test('a recording above the limit is not sent to the recogniser', async () => {
  const dir = await tempDir()
  try {
    const platform = createStubPlatform()
    platform.downloads.set('voice-1', { bytes: Buffer.alloc(4096), fileName: 'long.ogg' })
    let called = 0
    const { files } = await saveAttachments({
      platform,
      attachments: [{ kind: 'voice', fileId: 'voice-1' }],
      dir,
      stt: async () => {
        called += 1
        return 'текст'
      },
      sttMaxBytes: 1024,
      now: NOW,
    })
    assert.equal(called, 0)
    assert.match(files[0].sttError, /больше лимита/)
  } finally {
    await cleanup(dir)
  }
})

test('a voice answer is sent when the task came as a voice note', async () => {
  const said = []
  const env = await createBotHarness({
    runner: { async run() { return result() } },
  })
  try {
    env.bot.tts = async (text) => {
      said.push(text)
      return Buffer.from('OggS-voice-answer')
    }
    env.bot.stt = async () => 'проверь посылку'
    env.platform.downloads.set('voice-1', { bytes: Buffer.from('OggS'), fileName: 'voice.ogg' })

    await env.bot.handleUpdate(voiceMessage())
    await env.bot.worker

    assert.equal(said.length, 1, 'the answer is read aloud')
    assert.match(said[0], /Готово/)
    assert.equal(env.platform.voices.length, 1)
    assert.equal(env.platform.voices[0].chatId, 42)
    assert.equal(env.platform.voices[0].replyToMessageId, 7)
  } finally {
    await env.close()
  }
})

test('a text task is not answered with audio by default', async () => {
  const said = []
  const env = await createBotHarness({ runner: { async run() { return result() } } })
  try {
    env.bot.tts = async (text) => {
      said.push(text)
      return Buffer.from('OggS')
    }
    await env.bot.handleUpdate({ ...voiceMessage(), attachments: [], text: 'сделай отчёт' })
    await env.bot.worker
    assert.equal(said.length, 0, 'VOICE_REPLY=auto keeps text answers textual')
    assert.equal(env.platform.voices.length, 0)
  } finally {
    await env.close()
  }
})

test('a failed synthesis never turns a finished task into a failure', async () => {
  const env = await createBotHarness({ runner: { async run() { return result() } } })
  try {
    env.bot.tts = async () => {
      throw new Error('TTS HTTP 500')
    }
    env.bot.stt = async () => 'проверь посылку'
    env.platform.downloads.set('voice-1', { bytes: Buffer.from('OggS'), fileName: 'voice.ogg' })

    await env.bot.handleUpdate(voiceMessage())
    await env.bot.worker

    assert.equal(env.journal.recent(1)[0].status, 'done')
    assert.ok(env.platform.sent.some((entry) => /Готово/.test(entry.markdown)))
    assert.equal(env.platform.voices.length, 0)
  } finally {
    await env.close()
  }
})

test('VOICE_REPLY=always reads even a text task aloud', async () => {
  const said = []
  const env = await createBotHarness({ runner: { async run() { return result() } }, configEnv: { VOICE_REPLY: 'always' } })
  try {
    env.bot.tts = async (text) => {
      said.push(text)
      return Buffer.from('OggS')
    }
    await env.bot.handleUpdate({ ...voiceMessage(), attachments: [], text: 'сделай отчёт' })
    await env.bot.worker
    assert.equal(said.length, 1)
    assert.equal(env.platform.voices.length, 1)
  } finally {
    await env.close()
  }
})
