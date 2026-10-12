/**
 * Per-task resource limits through a delegated cgroup.
 *
 * One DSH run may start LibreOffice, python and a handful of shells. Without a
 * limit, one runaway job can exhaust the 2 GB of the box and get the *agent*
 * killed by the OOM killer along with it. So every run gets its own child
 * cgroup with a memory, CPU and process cap.
 *
 * This needs no root and no sudo: the systemd unit sets `Delegate=yes`, which
 * hands the service's own cgroup subtree to the service user, and cgroup v2
 * lets that user create and populate children. When anything is unavailable
 * (cgroup v1, no delegation, read-only) the limiter reports it and the task runs
 * unlimited — a missing limit must never break a task.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** Where cgroup v2 lives on this platform. */
export const CGROUP_ROOT = '/sys/fs/cgroup'

/** How many times `release` retries while the last processes leave the group. */
const RELEASE_ATTEMPTS = 20
const RELEASE_DELAY_MS = 100

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The service's own cgroup, as a path relative to the cgroup root.
 *
 * @param {object} [options] - `cgroupFile`, defaults to `/proc/self/cgroup`.
 * @returns {Promise<string>} for example `/system.slice/dsh-agent.service`.
 */
export async function ownCgroupPath({ cgroupFile = '/proc/self/cgroup' } = {}) {
  const raw = await fs.readFile(cgroupFile, 'utf8')
  const line = raw.split('\n').find((entry) => entry.startsWith('0::'))
  if (!line) throw new Error('cgroup v2 не обнаружен')
  return line.slice(3).trim() || '/'
}

/** Turn a task id into a safe cgroup directory name. */
export const cgroupNameFor = (id) => `task-${String(id ?? 'x').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 60)}`

export class CgroupLimiter {
  /**
   * @param {object} options - limiter options.
   * @param {string} [options.root] - cgroup mount point.
   * @param {number} [options.memoryMaxBytes] - hard memory cap per task.
   * @param {number} [options.cpuPercent] - CPU quota in percent of one core (150 = 1.5 cores).
   * @param {number} [options.pidsMax] - process/thread cap per task.
   * @param {string} [options.cgroupFile] - `/proc/self/cgroup`, injected by tests.
   * @param {object} [options.logger] - logger.
   */
  constructor({ root = CGROUP_ROOT, memoryMaxBytes = 1500 * 1024 * 1024, cpuPercent = 150, pidsMax = 256, cgroupFile = '/proc/self/cgroup', logger } = {}) {
    this.root = root
    this.memoryMaxBytes = memoryMaxBytes
    this.cpuPercent = cpuPercent
    this.pidsMax = pidsMax
    this.cgroupFile = cgroupFile
    this.logger = logger
    this.base = undefined
    this.usable = undefined
  }

  /**
   * Find a cgroup directory we may put task children into.
   *
   * Two layouts are possible. With `DelegateSubgroup=payload` the service's own
   * processes sit in a leaf, so the controllers can be enabled one level up —
   * that is the layout the unit ships with. Without it the service's processes
   * are in its own cgroup, cgroup v2 forbids enabling controllers there (the
   * "no internal processes" rule), and the limit is reported as unavailable.
   */
  async probe() {
    if (this.usable !== undefined) return this.usable
    const own = await ownCgroupPath({ cgroupFile: this.cgroupFile }).catch(() => undefined)
    const candidates = own === undefined ? [] : [own, path.posix.dirname(own)]
    let lastError
    for (const relative of candidates) {
      const dir = path.join(this.root, relative.replace(/^\/+/, '/'))
      try {
        await this.enableControllers(dir)
        const probeDir = path.join(dir, 'probe-limiter')
        await fs.mkdir(probeDir)
        await fs.rmdir(probeDir)
        this.base = dir
        this.usable = true
        this.logger?.info('task cgroup limits available', {
          base: path.relative(this.root, this.base),
          memoryMaxBytes: this.memoryMaxBytes,
          cpuPercent: this.cpuPercent,
          pidsMax: this.pidsMax,
        })
        return true
      } catch (error) {
        lastError = error
      }
    }
    this.usable = false
    this.logger?.warn('task cgroup limits unavailable, running unlimited', { error: lastError?.message ?? lastError })
    return false
  }

  /** Enable memory, cpu and pids for the children of one cgroup. */
  async enableControllers(dir) {
    const file = path.join(dir, 'cgroup.subtree_control')
    let current = ''
    try {
      current = await fs.readFile(file, 'utf8')
    } catch {
      // The file may be missing on a cgroup v1 host; the write below will fail.
    }
    // One write with the whole list: the kernel accepts `+cpu +memory` in one go.
    const missing = ['memory', 'cpu', 'pids'].filter((controller) => !current.includes(controller))
    if (missing.length > 0) await fs.writeFile(file, missing.map((controller) => `+${controller}`).join(' '))
  }

  /**
   * Create a child cgroup with the limits written into it.
   *
   * @param {string} id - task id.
   * @returns {Promise<{dir: string}|undefined>} a handle for `assign`/`release`.
   */
  async create(id) {
    if (!(await this.probe())) return undefined
    const dir = path.join(this.base, cgroupNameFor(id))
    try {
      await fs.mkdir(dir, { recursive: true })
      await this.write(dir, 'memory.max', String(this.memoryMaxBytes))
      // No swap: the box has none, and a swap-in would hide the leak.
      await this.write(dir, 'memory.swap.max', '0').catch(() => {})
      await this.write(dir, 'cpu.max', `${Math.round((this.cpuPercent / 100) * 100000)} 100000`)
      await this.write(dir, 'pids.max', String(this.pidsMax))
      return { dir }
    } catch (error) {
      this.logger?.warn('could not create task cgroup', { id, error: error?.message ?? error })
      await this.release({ dir })
      return undefined
    }
  }

  /** Move one process (and, by inheritance, its children) into the group. */
  async assign(handle, pid) {
    if (!handle || !pid) return false
    try {
      await this.write(handle.dir, 'cgroup.procs', String(pid))
      return true
    } catch (error) {
      this.logger?.warn('could not place task into its cgroup', { pid, error: error?.message ?? error })
      return false
    }
  }

  /** Remove the group once it is empty; kill whatever is left inside. */
  async release(handle) {
    if (!handle) return
    for (let attempt = 1; attempt <= RELEASE_ATTEMPTS; attempt += 1) {
      try {
        await fs.rmdir(handle.dir)
        return
      } catch (error) {
        if (error.code === 'ENOENT') return
        // EBUSY: processes left. ENOTEMPTY: something is still accounted there.
        // Both mean "kill what is inside and wait for the kernel to reap it".
        if (error.code !== 'EBUSY' && error.code !== 'ENOTEMPTY') {
          this.logger?.debug('task cgroup not removed', { dir: handle.dir, error: error?.message ?? error })
          return
        }
        // Something is still inside: kill it, then wait for the kernel to reap.
        await this.write(handle.dir, 'cgroup.kill', '1').catch(() => {})
        await sleep(RELEASE_DELAY_MS)
      }
    }
    this.logger?.warn('task cgroup still busy after release attempts', { dir: handle.dir })
  }

  /** One cgroup file, written without a trailing newline surprise. */
  async write(dir, file, value) {
    await fs.writeFile(path.join(dir, file), value)
  }
}
