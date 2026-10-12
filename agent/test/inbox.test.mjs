import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { safeFileName, saveAttachments } from '../src/inbox.mjs'
import { cleanup, createStubPlatform, tempDir } from './helpers.mjs'

const NOW = () => new Date('2026-10-08T19:00:00Z')

test('a document is saved into inbox and its text extracted', async () => {
  const dir = await tempDir()
  try {
    const platform = createStubPlatform()
    platform.downloads.set('file-1', { bytes: Buffer.from('Пункт 1. Оплата до 10 числа.'), fileName: 'договор.txt' })

    const { files, notes } = await saveAttachments({
      platform,
      attachments: [{ kind: 'document', fileId: 'file-1', name: 'договор.txt', mime: 'text/plain' }],
      dir,
      now: NOW,
    })

    assert.equal(notes.length, 0)
    assert.equal(files.length, 1)
    assert.match(files[0].relPath, /^inbox\/2026-10-08T19-00-00-договор\.txt$/)
    assert.match(files[0].text, /Оплата до 10 числа/)
    const onDisk = await fs.readFile(path.join(dir, files[0].relPath), 'utf8')
    assert.equal(onDisk, 'Пункт 1. Оплата до 10 числа.')
  } finally {
    await cleanup(dir)
  }
})

test('a failed download becomes a note, not an exception', async () => {
  const dir = await tempDir()
  try {
    const platform = createStubPlatform()
    const { files, notes } = await saveAttachments({
      platform,
      attachments: [{ kind: 'document', fileId: 'missing', name: 'нет.pdf' }],
      dir,
      now: NOW,
    })
    assert.equal(files.length, 0)
    assert.match(notes.join(' '), /не удалось скачать/)
  } finally {
    await cleanup(dir)
  }
})

test('file names cannot escape the inbox', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd')
  assert.equal(safeFileName('/etc/shadow'), 'shadow')
  assert.equal(safeFileName('..'), 'file')
  assert.equal(safeFileName(''), 'file')
  assert.equal(safeFileName('отчёт 2026.docx'), 'отчёт 2026.docx')
  assert.ok(safeFileName('x'.repeat(500)).length <= 120)
})

test('a traversing name still lands inside inbox', async () => {
  const dir = await tempDir()
  try {
    const platform = createStubPlatform()
    platform.downloads.set('evil', { bytes: Buffer.from('x'), fileName: '../../evil.txt' })
    const { files } = await saveAttachments({
      platform,
      attachments: [{ kind: 'document', fileId: 'evil', name: '../../evil.txt', mime: 'text/plain' }],
      dir,
      now: NOW,
    })
    assert.equal(files.length, 1)
    assert.equal(files[0].path.startsWith(path.join(dir, 'inbox')), true)
  } finally {
    await cleanup(dir)
  }
})

/** A vision double: records calls and returns a canned reading. */
const visionStub = (result, { maxImageBytes = 8_000_000 } = {}) => ({
  enabled: true,
  maxImageBytes,
  calls: [],
  async describe(request) {
    this.calls.push(request)
    return result
  },
})

/** An OCR double with the same shape. */
const ocrStub = (result) => ({
  enabled: true,
  calls: [],
  async extract(request) {
    this.calls.push(request)
    return result
  },
})

const pngDownload = (bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) => bytes

test('a photo is read by vision and its tokens are reported', async () => {
  const dir = await tempDir()
  try {
    const platform = createStubPlatform()
    platform.downloads.set('photo-1', { bytes: pngDownload(), fileName: 'photo.png' })
    const vision = visionStub({ text: 'На картинке текст KOD-42.', usage: { prompt_tokens: 197, completion_tokens: 12, cached_tokens: 0 } })

    const { files, usage } = await saveAttachments({
      platform,
      attachments: [{ kind: 'photo', fileId: 'photo-1' }],
      dir,
      vision,
      now: NOW,
    })

    assert.equal(files[0].text, 'На картинке текст KOD-42.')
    assert.equal(files[0].source, 'vision')
    assert.equal(usage.prompt_tokens, 197)
    assert.equal(usage.completion_tokens, 12)
    assert.equal(vision.calls[0].mime, 'image/png', 'mime is sniffed from the bytes')
  } finally {
    await cleanup(dir)
  }
})

test('OCR takes over when vision fails', async () => {
  const dir = await tempDir()
  try {
    const platform = createStubPlatform()
    platform.downloads.set('photo-1', { bytes: pngDownload(), fileName: 'scan.png' })
    const vision = visionStub({ text: '', usage: { prompt_tokens: 0, completion_tokens: 0 }, error: 'провайдер недоступен' })
    const ocr = ocrStub({ text: 'СЧЁТ 12345' })

    const { files } = await saveAttachments({
      platform,
      attachments: [{ kind: 'photo', fileId: 'photo-1' }],
      dir,
      vision,
      ocr,
      now: NOW,
    })

    assert.equal(files[0].text, 'СЧЁТ 12345')
    assert.equal(files[0].source, 'ocr')
    assert.match(files[0].visionError, /провайдер недоступен/)
    assert.equal(ocr.calls[0].path, files[0].path)
  } finally {
    await cleanup(dir)
  }
})

test('an unreadable image keeps both reasons', async () => {
  const dir = await tempDir()
  try {
    const platform = createStubPlatform()
    platform.downloads.set('photo-1', { bytes: pngDownload(), fileName: 'blur.png' })
    const vision = visionStub({ text: '', usage: { prompt_tokens: 5, completion_tokens: 0 }, error: 'модель не дала описания' })
    const ocr = ocrStub({ text: '', error: 'на изображении не нашлось текста' })

    const { files } = await saveAttachments({
      platform,
      attachments: [{ kind: 'photo', fileId: 'photo-1' }],
      dir,
      vision,
      ocr,
      now: NOW,
    })

    assert.equal(files[0].text, undefined)
    assert.match(files[0].visionError, /не дала описания/)
    assert.match(files[0].ocrError, /не нашлось текста/)
  } finally {
    await cleanup(dir)
  }
})

test('an image above the vision limit skips vision but still tries OCR', async () => {
  const dir = await tempDir()
  try {
    const platform = createStubPlatform()
    platform.downloads.set('photo-1', { bytes: pngDownload(Buffer.alloc(64, 1)), fileName: 'big.png' })
    const vision = visionStub({ text: 'не должно вызываться', usage: {} }, { maxImageBytes: 16 })
    const ocr = ocrStub({ text: 'текст из OCR' })

    const { files } = await saveAttachments({
      platform,
      attachments: [{ kind: 'photo', fileId: 'photo-1' }],
      dir,
      vision,
      ocr,
      now: NOW,
    })

    assert.equal(vision.calls.length, 0)
    assert.equal(files[0].source, 'ocr')
    assert.match(files[0].visionError, /больше лимита/)
  } finally {
    await cleanup(dir)
  }
})

test('without vision or OCR a photo is saved with no text', async () => {
  const dir = await tempDir()
  try {
    const platform = createStubPlatform()
    platform.downloads.set('photo-1', { bytes: pngDownload(), fileName: 'photo.png' })
    const { files } = await saveAttachments({
      platform,
      attachments: [{ kind: 'photo', fileId: 'photo-1' }],
      dir,
      now: NOW,
    })
    assert.equal(files[0].text, undefined)
    assert.equal(files[0].source, undefined)
  } finally {
    await cleanup(dir)
  }
})
