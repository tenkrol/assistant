/**
 * PLB-026: конфигурация автоперезапуска и сторожа проверяется как файл.
 *
 * Сервер не нужен: systemd-юниты — обычный текст, поэтому тест читает те же
 * файлы, которые устанавливает деплой. Если кто-то уберёт Restart=always или
 * поставит лимит попыток, тест упадёт до выезда.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const deployDir = path.resolve(import.meta.dirname, '..', 'deploy')
const read = (name) => fs.readFileSync(path.join(deployDir, name), 'utf8')

/** Разобрать unit на секции: `{ section: { key: [values] } }`. */
function sections(text) {
  const result = {}
  let current = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const header = /^\[(.+)]$/.exec(line)
    if (header) {
      current = header[1]
      result[current] = result[current] ?? {}
      continue
    }
    const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line)
    if (!pair || current === '') continue
    result[current][pair[1]] = [...(result[current][pair[1]] ?? []), pair[2]]
  }
  return result
}

test('бот перезапускается сам и не упирается в StartLimit', () => {
  const unit = sections(read('tg-agent.service'))
  assert.deepEqual(unit.Unit.StartLimitIntervalSec, ['0'])
  assert.deepEqual(unit.Service.Restart, ['always'])
  assert.deepEqual(unit.Service.RestartSec, ['5'])
  assert.deepEqual(unit.Service.ExecStart, ['/usr/bin/node src/index.mjs'])
  assert.ok(unit.Install.WantedBy.includes('multi-user.target'))
})

test('сторож ставится отдельным юнитом и таймером', () => {
  const service = sections(read('tg-agent-watch.service'))
  assert.deepEqual(service.Service.Type, ['oneshot'])
  assert.deepEqual(service.Service.ExecStart, ['/usr/bin/node tools/watchdog-service.mjs'])
  assert.deepEqual(service.Service.SuccessExitStatus, ['0 1'])
  assert.deepEqual(service.Service.StateDirectory, ['tg-agent'])
  assert.ok(service.Service.ReadWritePaths.includes('/var/lib/tg-agent'))
  assert.deepEqual(service.Service.Environment, ['DATA_DIR=/var/lib/tg-agent', 'WATCHDOG_SERVICE=tg-agent'])

  const timer = sections(read('tg-agent-watch.timer'))
  assert.deepEqual(timer.Timer.OnBootSec, ['2min'])
  assert.deepEqual(timer.Timer.OnUnitActiveSec, ['5min'])
  assert.deepEqual(timer.Timer.Persistent, ['true'])
  assert.deepEqual(timer.Timer.Unit, ['tg-agent-watch.service'])
  assert.ok(timer.Install.WantedBy.includes('timers.target'))
})

test('deploy-remote устанавливает юнит сторожа вместе с ботом', () => {
  const script = fs.readFileSync(path.join(deployDir, 'deploy-remote.sh'), 'utf8')
  assert.match(script, /tg-agent-watch\.service/)
  assert.match(script, /tg-agent-watch\.timer/)
  assert.match(script, /systemctl enable --now tg-agent-watch\.timer/)
})

test('проверка релиза использует существующий Node.js и ставится с таймером', () => {
  const service = sections(read('deploy-verify.service'))
  assert.deepEqual(service.Service.ExecStart, ['/usr/bin/node tools/deploy-safe.mjs --status'])
  const timer = sections(read('deploy-verify.timer'))
  assert.deepEqual(timer.Timer.OnUnitActiveSec, ['1h'])
  assert.deepEqual(timer.Timer.Persistent, ['true'])

  const script = fs.readFileSync(path.join(deployDir, 'deploy-remote.sh'), 'utf8')
  assert.match(script, /deploy-verify\.service/)
  assert.match(script, /s\|\^ExecStart=\.\*\|ExecStart=\$\{NODE_BIN\} tools\/deploy-safe\.mjs --status\|/)
  assert.match(script, /systemctl enable --now deploy-verify\.timer/)
})
