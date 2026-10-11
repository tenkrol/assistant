/**
 * Install, reload or remove a macOS LaunchAgent for this project.
 *
 * Two agents are supported:
 *   - `bot` (default) keeps the bot running on this Mac: it restarts on any exit
 *     and starts at login. Only one instance may poll a Telegram token, so use it
 *     instead of running `node src/index.mjs` by hand — and remember that the bot
 *     normally runs on the server, where this agent must stay unloaded;
 *   - `watchdog` runs the external monitor every 30 minutes, which is what warns
 *     you when the server-side bot stops answering.
 *
 * Usage:
 *   node tools/install-launchd.mjs                    # install the bot agent
 *   node tools/install-launchd.mjs --watchdog         # install the watchdog agent
 *   node tools/install-launchd.mjs --watchdog --status
 *   node tools/install-launchd.mjs --unload           # stop and remove it
 *   node tools/install-launchd.mjs --node /path/to/node
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

/** Every agent this installer knows about. */
const TARGETS = {
  bot: {
    label: 'com.tg-agent.bot',
    entry: path.join(root, 'src', 'index.mjs'),
    template: path.join(root, 'deploy', 'tg-agent.launchd.plist'),
    log: path.join(root, 'data', 'bot.log'),
  },
  watchdog: {
    label: 'com.tg-agent.watchdog',
    entry: path.join(root, 'tools', 'watchdog.mjs'),
    template: path.join(root, 'deploy', 'tg-agent-watchdog.launchd.plist'),
    log: path.join(root, 'data', 'watchdog.log'),
  },
}

const argv = process.argv.slice(2)
const flag = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const targetName = argv.includes('--watchdog') ? 'watchdog' : 'bot'
const target = TARGETS[targetName]
const { label } = target
const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`)

/** `gui/<uid>` is the domain a user agent lives in on modern macOS. */
const domain = `gui/${process.getuid()}`

const run = (command, args, { allowFailure = false } = {}) => {
  try {
    return { ok: true, output: execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  } catch (error) {
    if (!allowFailure) throw error
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}${error.message}`.trim() }
  }
}

/** Pick a node that will still exist tomorrow. */
function resolveNode() {
  const explicit = flag('--node')
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`--node path does not exist: ${explicit}`)
    return explicit
  }
  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    process.execPath,
  ]
  for (const candidate of candidates) {
    // Some installs expose `node` as a shell wrapper that needs environment the
    // agent does not have; a real interpreter starts with the Mach-O magic.
    if (!fs.existsSync(candidate)) continue
    if (/^#!/.test(fs.readFileSync(candidate, { encoding: 'utf8', flag: 'r' }).slice(0, 2))) continue
    return candidate
  }
  throw new Error('no real node executable found; pass --node <path>')
}

function status() {
  const listed = run('launchctl', ['list'], { allowFailure: true })
  const rows = listed.output.split('\n').filter((row) => row.includes('com.tg-agent'))
  const print = run('launchctl', ['print', `${domain}/${label}`], { allowFailure: true })
  const pid = print.output.match(/pid = (\d+)/)?.[1]
  console.log(`агент:   ${targetName} (${label})`)
  console.log(`plist:   ${plistPath} (${fs.existsSync(plistPath) ? 'есть' : 'нет'})`)
  console.log(`launchctl list: ${rows.length > 0 ? rows.map((row) => row.trim()).join(' | ') : 'агенты com.tg-agent не загружены'}`)
  console.log(`pid: ${pid ?? '—'}`)
  console.log(`log: ${target.log}`)
}

function unload() {
  run('launchctl', ['bootout', `${domain}/${label}`], { allowFailure: true })
  run('launchctl', ['unload', '-w', plistPath], { allowFailure: true })
  if (fs.existsSync(plistPath)) fs.rmSync(plistPath)
  console.log(`агент остановлен и удалён: ${plistPath}`)
}

function install() {
  const node = resolveNode()
  if (!fs.existsSync(target.entry)) throw new Error(`entry not found: ${target.entry}`)
  fs.mkdirSync(path.dirname(target.log), { recursive: true })
  fs.mkdirSync(path.dirname(plistPath), { recursive: true })

  const template = fs.readFileSync(target.template, 'utf8')
  const plist = template
    .replaceAll('__LABEL__', label)
    .replaceAll('__NODE__', node)
    .replaceAll('__ENTRY__', target.entry)
    .replaceAll('__DIR__', root)
    .replaceAll('__LOG__', target.log)
  fs.writeFileSync(plistPath, plist)
  console.log(`plist записан: ${plistPath}`)
  console.log(`node: ${node}`)
  console.log(`каталог: ${root}`)
  console.log(`лог: ${target.log}`)

  // Stop an agent from an earlier install before loading the new one.
  run('launchctl', ['bootout', `${domain}/${label}`], { allowFailure: true })
  const bootstrapped = run('launchctl', ['bootstrap', domain, plistPath], { allowFailure: true })
  if (!bootstrapped.ok) {
    const loaded = run('launchctl', ['load', '-w', plistPath], { allowFailure: true })
    if (!loaded.ok) throw new Error(`не удалось загрузить агент: ${bootstrapped.output} ${loaded.output}`)
  }
  // The bot agent is restarted right away; the watchdog waits for its interval,
  // so kicking it here would only send a needless check.
  if (targetName === 'bot') run('launchctl', ['kickstart', '-k', `${domain}/${label}`], { allowFailure: true })
  console.log('агент загружен; перезапуск: launchctl kickstart -k ' + `${domain}/${label}`)
  console.log('если приложение обновят и путь к node изменится — повторите: node tools/install-launchd.mjs --node <новый путь>')
}

try {
  if (argv.includes('--unload')) unload()
  else if (argv.includes('--status')) status()
  else install()
  status()
} catch (error) {
  console.error(`ошибка: ${error.message}`)
  process.exitCode = 1
}
