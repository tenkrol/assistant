/**
 * Блокировка файла состояния: один писатель на файл.
 *
 * Основа — эксклюзивное создание файла-замка (`wx`): его может создать только один
 * процесс. Остальные ждут до таймаута. Замок старше `staleMs` считается брошенным
 * (процесс упал, не успев удалить) и снимается.
 *
 * @param {string} file - файл состояния, рядом с которым создаётся `.lock`.
 * @param {Function} fn - работа под замком.
 * @param {object} [options] - `timeoutMs`, `retryMs`, `staleMs`, `logger`.
 * @returns {Promise<*>} результат `fn`.
 */
import fs from 'node:fs/promises'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function withFileLock(file, fn, { timeoutMs = 5000, retryMs = 50, staleMs = 60_000, logger } = {}) {
  const lockPath = `${file}.lock`
  const started = Date.now()
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx')
      await handle.writeFile(String(process.pid))
      try {
        return await fn()
      } finally {
        await handle.close().catch(() => {})
        await fs.rm(lockPath, { force: true }).catch(() => {})
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      // Замок брошен упавшим процессом — снимаем и пробуем снова.
      const stat = await fs.stat(lockPath).catch(() => undefined)
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        logger?.warn?.('снят брошенный замок хранилища', { lockPath, ageMs: Date.now() - stat.mtimeMs })
        await fs.rm(lockPath, { force: true }).catch(() => {})
        continue
      }
      if (Date.now() - started > timeoutMs) throw new Error(`хранилище занято: не дождались замка ${lockPath}`)
      await sleep(retryMs)
    }
  }
}

/** Существует ли замок (для тестов и диагностики). */
export async function lockExists(file) {
  return fs.access(`${file}.lock`).then(() => true, () => false)
}
