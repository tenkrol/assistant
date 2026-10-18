/**
 * Единый слой хранения JSON-состояния.
 *
 * Зачем: раньше каждый store сам писал файл, и расхождения в этой механике стоили
 * данных (однажды `offset.json` обнулился при полном диске). Здесь собраны гарантии,
 * которые домены получают одинаково:
 *
 *  - атомарная запись: временный файл → сброс на диск → переименование;
 *  - один писатель на файл (через `withFileLock`);
 *  - версия схемы в файле + миграции со страховочной копией;
 *  - битый файл не затирается: копируется рядом с датой;
 *  - файл новее, чем понимает код, не перезаписывается;
 *  - транзакция `transaction`: чтение актуального файла, изменение и запись под
 *    одним замком. Нужна там, где два процесса делят один файл и решение
 *    «прочитать → проверить → записать» обязано быть атомарным (проактивность).
 *
 * @param {object} options - `file`, `version`, `defaults`, `migrate`, `logger`, `fsync`.
 * @returns {object} хранилище: `load`, `flush`, `transaction`, `replace`, `state`, `file`.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { withFileLock } from './lock.mjs'

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

/** Создать хранилище одного файла состояния. */
export function createJsonStore({ file, version = 1, defaults = {}, migrate, logger, fsync = true } = {}) {
  if (!file) throw new Error('хранилище: не задан путь к файлу')
  let state = structuredClone(defaults)
  let loaded = false

  /** Копия файла рядом, с пометкой почему (битый, старая версия, ручной снимок). */
  async function preserve(reason) {
    const target = `${file}.${reason}-${stamp()}`
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.copyFile(file, target).catch(() => {})
    return target
  }

  /** Применить версию схемы и миграцию к уже разобранному JSON. */
  async function migrateParsed(parsed) {
    const found = Number(parsed?.version)
    if (Number.isFinite(found) && found > version) {
      // Новее, чем понимает код: не затираем чужую работу.
      throw new Error(`файл ${file} новее этой версии бота (schema ${found} > ${version}) — обновите бота`)
    }
    if (Number.isFinite(found) && found < version) {
      const copy = await preserve('bak')
      logger?.info?.('миграция схемы состояния', { file, from: found, to: version, copy })
      parsed = migrate ? await migrate(parsed, found, version) : parsed
    }
    return migrate && !Number.isFinite(found) ? migrate(parsed, 0, version) : parsed
  }

  /** Прочитать файл: миграции, битый JSON и отсутствие файла обработаны. */
  async function load() {
    let raw
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      state = structuredClone(defaults)
      loaded = true
      return state
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      const copy = await preserve('broken')
      logger?.error?.('файл состояния повреждён, отложена копия', { file, copy })
      state = structuredClone(defaults)
      loaded = true
      return state
    }
    state = await migrateParsed(parsed)
    loaded = true
    return state
  }

  /**
   * Записать подготовленный снимок: временный файл, сброс, переименование.
   *
   * Вызывается только под замком (`flush` или `transaction`).
   *
   * @param {object} payload - состояние вместе с версией схемы.
   */
  async function writePayload(payload) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    const handle = await fs.open(tmp, 'w', 0o600)
    try {
      await handle.writeFile(JSON.stringify(payload, null, 2))
      if (fsync) await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tmp, file)
  }

  /** Сохранить состояние: временный файл, сброс, переименование — под замком. */
  async function flush() {
    await withFileLock(file, async () => {
      const payload = { ...state, version }
      await writePayload(payload)
      state = payload
    }, { logger })
    return state
  }

  /**
   * Атомарно прочитать файл, изменить состояние и записать его обратно.
   *
   * `fn` получает черновик состояния и может его менять; возвращённое значение
   * отдаётся вызывающему. Если `fn` бросит исключение, файл не меняется. Внутри
   * `fn` нельзя вызывать `flush`/`transaction` этого же хранилища — замок уже
   * занят; это осознанное ограничение одного файла.
   *
   * @param {(draft: object) => Promise<*>|*} fn - изменение состояния.
   * @returns {Promise<*>} результат `fn`.
   */
  async function transaction(fn) {
    return withFileLock(file, async () => {
      let raw
      try {
        raw = await fs.readFile(file, 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        state = structuredClone(defaults)
      }
      if (raw !== undefined) {
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          // В транзакции битый файл нельзя молча заменить пустым состоянием:
          // иначе следующая запись потеряла бы данные, которые ещё можно спасти.
          throw new Error(`файл ${file} повреждён: транзакция отменена`)
        }
        state = await migrateParsed(parsed)
      }
      const draft = structuredClone(state)
      const result = await fn(draft)
      const payload = { ...draft, version }
      await writePayload(payload)
      state = payload
      loaded = true
      return result
    }, { logger })
  }

  /** Заменить состояние целиком и сохранить. */
  async function replace(next) {
    state = structuredClone(next)
    return flush()
  }

  /** Снимок файла в отдельный каталог (для бэкапов). */
  async function snapshot(directory) {
    const target = path.join(directory, path.basename(file))
    await fs.mkdir(directory, { recursive: true })
    await fs.copyFile(file, target).catch(() => {})
    return target
  }

  return {
    file,
    get state() {
      return state
    },
    get loaded() {
      return loaded
    },
    load,
    flush,
    transaction,
    replace,
    snapshot,
  }
}
