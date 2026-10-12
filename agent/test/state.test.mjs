import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { StateStore } from '../src/state.mjs'
import { cleanup, tempDir } from './helpers.mjs'

test('state is stored, flushed and read back', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'state.json')
    const store = new StateStore({ file })
    store.set('offset', 4242)
    store.set('session:42', 'session-abc')
    await store.flush()

    const reloaded = await new StateStore({ file }).load()
    assert.equal(reloaded.get('offset'), 4242)
    assert.equal(reloaded.get('session:42'), 'session-abc')
    assert.equal(reloaded.get('missing', 'default'), 'default')
  } finally {
    await cleanup(dir)
  }
})

test('deleting a key removes it from disk too', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'state.json')
    const store = new StateStore({ file })
    store.set('session:42', 'session-abc')
    await store.flush()
    store.delete('session:42')
    await store.flush()
    assert.equal(await new StateStore({ file }).load().then((reloaded) => reloaded.get('session:42')), undefined)
  } finally {
    await cleanup(dir)
  }
})

test('a corrupt state file is ignored, not fatal', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'state.json')
    await fs.writeFile(file, '{ это не json')
    const store = await new StateStore({ file }).load()
    assert.equal(store.get('offset'), undefined)
    store.set('offset', 7)
    await store.flush()
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).data.offset, 7)
  } finally {
    await cleanup(dir)
  }
})
