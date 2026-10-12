#!/usr/bin/env node
/**
 * Stand-in for the `dsh` binary in tests.
 *
 * It accepts the same argv shape the runner produces, reads the task from stdin
 * and writes newline-delimited events selected by `FAKE_DSH_MODE`, so the runner
 * can be tested without a model, a network or a DSH installation.
 *
 * Modes:
 *   ok        one tool call, one step, a final answer that echoes the task
 *   fail      an error event and exit code 1
 *   hang      keeps running until killed (timeout and cancel paths)
 *   badjson   noise on stdout, then a valid final event
 *   empty     exit code 0 with no final event
 *   stderr    writes to stderr and exits 1 without a final answer
 */
const mode = process.env.FAKE_DSH_MODE ?? 'ok'
const sessionId = process.env.FAKE_DSH_SESSION ?? 'session-test-0001'
const argv = process.argv.slice(2)

// The runner must send the task on stdin as `-`, never in argv.
if (!argv.includes('-')) {
  process.stderr.write(`fake-dsh: expected a trailing "-" task argument, got ${JSON.stringify(argv)}\n`)
  process.exit(2)
}
if (!argv.includes('--json')) {
  process.stderr.write('fake-dsh: expected --json\n')
  process.exit(2)
}

let task = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { task += chunk })
process.stdin.on('end', () => {
  const write = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
  const cwd = process.cwd()

  if (mode === 'hang') {
    write({ type: 'session', sessionId, cwd })
    setInterval(() => {}, 1000)
    return
  }

  // Reports what the runner put on the command line, so the test can assert on
  // argv (session id, `--json`, the trailing `-`).
  if (mode === 'args') {
    write({ type: 'session', sessionId, cwd })
    write({ type: 'final', text: JSON.stringify({ argv, cwd }) })
    return
  }

  // Reports the environment DSH would actually see.
  if (mode === 'env') {
    write({ type: 'session', sessionId, cwd })
    write({
      type: 'final',
      text: JSON.stringify({
        DSH_HOME: process.env.DSH_HOME,
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
        DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE,
        DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED,
      }),
    })
    return
  }

  if (mode === 'badjson') {
    process.stdout.write('this is not json\n')
    process.stdout.write('\n')
    write({ type: 'session', sessionId, cwd })
    write({ type: 'final', text: 'ответ из шумного потока' })
    return
  }

  if (mode === 'empty') {
    write({ type: 'session', sessionId, cwd })
    write({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } })
    return
  }

  if (mode === 'stderr') {
    process.stderr.write('dsh: MODEL_ERROR: provider refused\n')
    process.exit(1)
  }

  if (mode === 'fail') {
    write({ type: 'session', sessionId, cwd })
    write({ type: 'status', phase: 'turn_start', turn: 1 })
    write({ type: 'error', message: 'модель недоступна' })
    write({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'error', code: 'MODEL_ERROR' } })
    process.stderr.write('dsh: MODEL_ERROR: модель недоступна\n')
    process.exit(1)
  }

  write({ type: 'session', sessionId, cwd })
  write({ type: 'status', phase: 'turn_start', turn: 1 })
  write({ type: 'status', phase: 'step_start', turn: 1, step: 1 })
  write({ type: 'thinking', text: 'надо посмотреть задачу' })
  write({ type: 'tool_call', callId: 'call-1', tool: 'bash', input: { command: 'echo hi' } })
  write({ type: 'tool_result', callId: 'call-1', status: 'completed', result: 'hi' })
  write({
    type: 'status',
    phase: 'step_end',
    turn: 1,
    step: 1,
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0, totalTokens: 150 },
  })
  write({ type: 'status', phase: 'step_start', turn: 1, step: 2 })
  write({ type: 'text', text: `Задача принята: ${task.trim()}` })
  write({
    type: 'status',
    phase: 'step_end',
    turn: 1,
    step: 2,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 5, cacheWriteTokens: 0, totalTokens: 20 },
  })
  write({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } })
  write({ type: 'final', text: `Готово. Задача: ${task.trim()}` })
})
