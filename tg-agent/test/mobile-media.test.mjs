/** Хранилище фото/видео веб-чата: файлы, метаданные и отдача. */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MobileMediaError, MobileMediaStore, mediaKind } from '../src/mobile-media.mjs'
import { prepareAttachments } from '../src/media-handler.mjs'

const logger = { debug() {}, info() {}, warn() {}, error() {} }

test('mediaKind', () => {
  assert.equal(mediaKind('image/jpeg'), 'photo')
  assert.equal(mediaKind('video/mp4'), 'video')
  assert.equal(mediaKind('audio/webm'), 'voice')
  assert.equal(mediaKind('application/pdf'), 'document')
})

test('MobileMediaStore: фото сохраняется, отдаётся и переживает перезапуск', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-media-'))
  const file = path.join(dir, 'media.json')
  const mediaDir = path.join(dir, 'files')
  const store = new MobileMediaStore({ file, dir: mediaDir, logger })
  await store.load()
  try {
    const item = await store.add({ userId: 777, bytes: Buffer.from([1, 2, 3]), name: 'photo.jpg', mime: 'image/jpeg' })
    assert.equal(item.kind, 'photo')
    assert.equal(item.size, 3)
    assert.match(item.id, /^[0-9a-f-]+$/)
    const read = await store.read(item.id, { userId: 777 })
    assert.deepEqual(read.bytes, Buffer.from([1, 2, 3]))
    assert.equal(await store.read(item.id, { userId: 888 }), null)
    assert.equal(await store.read(item.id), null)
    assert.equal(store.publicItem(item).url, `/api/media/${item.id}`)
    const voice = await store.add({ userId: 777, bytes: Buffer.from('voice'), name: 'voice.webm', mime: 'audio/webm' })
    assert.equal(voice.kind, 'voice')
    await assert.rejects(() => store.add({ userId: 777, bytes: Buffer.from('pdf'), name: 'x.pdf', mime: 'application/pdf' }), MobileMediaError)

    const other = new MobileMediaStore({ file, dir: mediaDir, logger })
    await other.load()
    assert.equal(other.get(item.id).name, 'photo.jpg')
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})


test('prepareAttachments берёт байты веб-загрузки без платформы', async () => {
  const prepared = await prepareAttachments({
    platform: {},
    attachments: [{ kind: 'photo', bytes: Buffer.from([1, 2, 3]), mime: 'image/png', name: 'p.png' }],
    caption: 'что тут?',
  })
  assert.equal(prepared.parts[0].type, 'text')
  assert.equal(prepared.parts[1].type, 'image_url')
  assert.match(prepared.parts[1].image_url.url, /^data:image\/png;base64,/)
  const video = await prepareAttachments({
    platform: {},
    attachments: [{ kind: 'video', bytes: Buffer.from([1]), mime: 'video/mp4', name: 'v.mp4' }],
    caption: '',
  })
  assert.match(video.parts.map((part) => part.text || '').join(' '), /видео/)
})
