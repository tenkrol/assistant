/**
 * Слой хранения: гарантии из спеки storage.
 *
 * Проверяем то, что раньше теряло данные: атомарность, полный диск, один писатель,
 * миграции, битый файл и файл новее кода.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createJsonStore } from '../src/storage/json-store.mjs'
import { withFileLock, lockExists } from '../src/storage/lock.mjs'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-'))
  return { dir, file: path.join(dir, 'state.json'), cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

test('сохранение пишет валидный JSON с версией схемы', async () => {
  const { file, cleanup } = await sandbox()
  try {
    const store = createJsonStore({ file, version: 2, defaults: { items: [] }, logger: silent })
    await store.load()
    store.state.items.push({ id: 1 })
    await store.flush()
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(raw.version, 2)
    assert.deepEqual(raw.items, [{ id: 1 }])
    assert.equal(Number((await fs.stat(file)).mode) & 0o777, 0o600, 'файл состояния только для владельца')
  } finally {
    await cleanup()
  }
})

test('при ошибке записи предыдущий файл остаётся целым', async () => {
  const { file, cleanup } = await sandbox()
  try {
    const store = createJsonStore({ file, version: 1, defaults: { items: ['старое'] }, logger: silent })
    await store.load()
    await store.flush()
    const before = await fs.readFile(file, 'utf8')
    // Ошибку записи моделируем каталогом на месте временного файла: открыть его на
    // запись нельзя. Права (chmod) для этого не подходят — под root они не мешают.
    const tmp = `${file}.tmp-${process.pid}`
    await fs.mkdir(tmp)
    store.state.items.push('новое')
    await assert.rejects(() => store.flush())
    await fs.rm(tmp, { recursive: true, force: true })
    assert.equal(await fs.readFile(file, 'utf8'), before, 'данные не потеряны')
  } finally {
    await cleanup()
  }
})


test('битый файл копируется рядом, состояние стартует с пустого', async () => {
  const { dir, file, cleanup } = await sandbox()
  try {
    await fs.writeFile(file, '{ это не json')
    const store = createJsonStore({ file, version: 1, defaults: { items: [] }, logger: silent })
    await store.load()
    assert.deepEqual(store.state, { items: [] })
    const copies = (await fs.readdir(dir)).filter((name) => name.includes('broken'))
    assert.equal(copies.length, 1, 'повреждённый файл сохранён для разбора')
  } finally {
    await cleanup()
  }
})

test('старый файл мигрирует, рядом остаётся страховочная копия', async () => {
  const { dir, file, cleanup } = await sandbox()
  try {
    await fs.writeFile(file, JSON.stringify({ version: 1, items: ['a'] }))
    const store = createJsonStore({
      file,
      version: 2,
      defaults: { items: [] },
      logger: silent,
      migrate: (data, from, to) => ({ ...data, version: to, migratedFrom: from }),
    })
    await store.load()
    assert.equal(store.state.version, 2)
    assert.equal(store.state.migratedFrom, 1)
    const backups = (await fs.readdir(dir)).filter((name) => name.includes('bak'))
    assert.equal(backups.length, 1)
  } finally {
    await cleanup()
  }
})

test('файл новее кода не перезаписывается', async () => {
  const { file, cleanup } = await sandbox()
  try {
    await fs.writeFile(file, JSON.stringify({ version: 99, items: [] }))
    const store = createJsonStore({ file, version: 1, defaults: { items: [] }, logger: silent })
    await assert.rejects(() => store.load(), /новее/)
    assert.match(await fs.readFile(file, 'utf8'), /"version":99/, 'файл остался нетронутым')
  } finally {
    await cleanup()
  }
})

test('два писателя не перемешивают записи: замок сериализует', async () => {
  const { file, cleanup } = await sandbox()
  try {
    const order = []
    await Promise.all([
      withFileLock(file, async () => { order.push('первый-начало'); await new Promise((r) => setTimeout(r, 60)); order.push('первый-конец') }, { logger: silent }),
      withFileLock(file, async () => { order.push('второй') }, { logger: silent }),
    ])
    assert.deepEqual(order, ['первый-начало', 'первый-конец', 'второй'], 'второй ждёт первого')
    assert.equal(await lockExists(file), false, 'замок снят')
  } finally {
    await cleanup()
  }
})

test('брошенный замок снимается по возрасту', async () => {
  const { file, cleanup } = await sandbox()
  try {
    await fs.writeFile(`${file}.lock`, '999')
    const old = new Date(Date.now() - 120_000)
    await fs.utimes(`${file}.lock`, old, old)
    let ran = false
    await withFileLock(file, async () => { ran = true }, { logger: silent })
    assert.equal(ran, true, 'работа выполнена после снятия брошенного замка')
  } finally {
    await cleanup()
  }
})

test('снимок состояния копируется в каталог бэкапа', async () => {
  const { dir, file, cleanup } = await sandbox()
  try {
    await fs.writeFile(file, JSON.stringify({ version: 1, items: [1] }))
    const store = createJsonStore({ file, version: 1, defaults: { items: [] }, logger: silent })
    await store.load()
    const target = await store.snapshot(path.join(dir, 'backup'))
    assert.match(await fs.readFile(target, "utf8"), /"items":/)
  } finally {
    await cleanup()
  }
})
