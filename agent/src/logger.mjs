/**
 * Minimal structured logger.
 *
 * Secrets are never interpolated into messages; the optional `redact` list
 * additionally scrubs any occurrence that arrives inside an error text coming
 * from an HTTP layer.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

const serialize = (value) => {
  if (value instanceof Error) return { error: value.name, message: value.message }
  if (typeof value === 'object' && value !== null) return value
  return value
}

/**
 * @param {object} options - logger options.
 * @param {string} [options.level] - minimum level to print: debug, info, warn, error.
 * @param {(line: string) => void} [options.write] - sink, defaults to stdout.
 * @param {string[]} [options.redact] - substrings replaced with `[redacted]`.
 * @param {() => Date} [options.now] - clock, injected by tests.
 */
export function createLogger({ level = 'info', write = (line) => process.stdout.write(line + '\n'), redact = [], now = () => new Date(), bindings = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info
  const scrub = (text) => redact.filter(Boolean).reduce((acc, secret) => acc.split(secret).join('[redacted]'), text)

  const emit = (name, message, fields) => {
    if ((LEVELS[name] ?? 0) < threshold) return
    const parts = [now().toISOString(), name.toUpperCase().padEnd(5), scrub(String(message))]
    const merged = { ...bindings, ...(fields ? Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, serialize(v)])) : {}) }
    if (Object.keys(merged).length) parts.push(JSON.stringify(merged))
    write(scrub(parts.join(' ')))
  }

  return {
    level,
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (extra) => createLogger({ level, write, redact, now, bindings: { ...bindings, ...extra } }),
  }
}
