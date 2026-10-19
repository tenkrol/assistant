import test from 'node:test'
import assert from 'node:assert/strict'
import { YandexDisk } from '../src/yandex-disk.mjs'

function fakeFetch() {
  return async (url) => {
    const target = new URL(String(url))
    const path = target.searchParams.get('path')
    const payload = path === 'disk:/Агент'
      ? { _embedded: { items: [{ path: 'disk:/Агент/42', name: '42', type: 'dir' }] } }
      : path === 'disk:/Агент/42'
        ? { _embedded: { items: [{ path: 'disk:/Агент/42/отчёт.pdf', name: 'отчёт.pdf', type: 'file', size: 5, modified: '2026-10-19T00:00:00Z' }] } }
        : null
    return {
      ok: Boolean(payload),
      status: payload ? 200 : 404,
      json: async () => payload,
      text: async () => JSON.stringify(payload ?? {}),
      arrayBuffer: async () => new TextEncoder().encode('file').buffer,
    }
  }
}

test('яндекс диск: список файлов и безопасное скачивание', async () => {
  const disk = new YandexDisk({ token: 'test-token', dir: 'Агент', fetchImpl: fakeFetch() })
  const files = await disk.listAgentFiles()
  assert.equal(files.length, 1)
  assert.equal(files[0].task, '42')
  assert.equal(files[0].name, 'отчёт.pdf')
  assert.throws(() => disk.safePath('disk:/чужое/x'), /Чужой/)
})
