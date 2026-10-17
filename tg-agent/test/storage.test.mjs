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
  let releaseFirst
  try {
    let insideFirst = false
    let secondStartedWhileFirstInside = false
    let signalFirstEntered
    const firstEntered = new Promise((resolve) => { signalFirstEntered = resolve })
    // Первый писатель держит замок, пока тест не разрешит продолжить: так момент
    // проверки не зависит от таймингов и планировщика.
    const gate = new Promise((resolve) => { releaseFirst = resolve })
    const first = withFileLock(file, async () => {
      insideFirst = true
      signalFirstEntered()
      await gate
      assert.equal(secondStartedWhileFirstInside, false, 'второй не начался, пока первый внутри')
      insideFirst = false
    }, { logger: silent })
    await firstEntered

    // Второй писатель пытается войти, пока замок занят. Замок держит первый,
    // поэтому отказ может быть только из-за него; короткий таймаут делает
    // ожидание наблюдаемым, а не гонкой на setTimeout.
    await assert.rejects(
      () => withFileLock(file, async () => {
        if (insideFirst) secondStartedWhileFirstInside = true
      }, { logger: silent, retryMs: 5, timeoutMs: 100 }),
      /занято/,
    )
    assert.equal(secondStartedWhileFirstInside, false, 'второй не начал работу, пока первый внутри')
    assert.equal(insideFirst, true, 'первый всё ещё держит замок')

    releaseFirst()
    await first
    // После освобождения замка второй писатель выполняется.
    let secondRan = false
    await withFileLock(file, async () => { secondRan = true }, { logger: silent })
    assert.equal(secondRan, true, 'после освобождения замка второй пишет')
    assert.equal(await lockExists(file), false, 'замок снят')
  } finally {
    releaseFirst?.()
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
