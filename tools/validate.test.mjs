import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  runValidation,
  validationTimingReceipt,
  VALIDATION_PHASES,
  VALIDATION_PHASE_DEADLINE_MILLISECONDS,
} from './validate.mjs'
import { HARD_DEADLINE_MILLISECONDS } from './verify.mjs'

test('validation runner preserves phase order, shared process bounds, and internal timings', async () => {
  let clock = 0
  const commands = []
  let output = ''
  // Derived from the real phase list so adding a validation phase does not
  // require editing arithmetic in this test.
  const durations = VALIDATION_PHASES.map((_, index) => 15 + index * 5)
  const expectedTotal = durations.reduce((total, value) => total + value, 0)
  const result = await runValidation({
    now: () => clock,
    runPhase(options) {
      commands.push(options)
      clock += durations[commands.length - 1]
      return { exitCode: 0, signal: null, closureConfirmed: true }
    },
    write: (value) => { output += value },
  })

  assert.equal(result.exitCode, 0)
  assert.deepEqual(
    commands.map(({ arguments_ }) => arguments_[0]),
    VALIDATION_PHASES.map(({ script }) => script)
  )
  assert.equal(commands.every(({ signal, cancelGraceMilliseconds }) => signal instanceof AbortSignal && cancelGraceMilliseconds === 1_000), true)
  assert.deepEqual(
    result.records.map(({ result: phaseResult }) => phaseResult),
    Array(VALIDATION_PHASES.length).fill('passed')
  )
  assert.equal(result.totalMilliseconds, expectedTotal)
  assert.match(output, /Toolchain contract\s+passed\s+15ms/)
  assert.match(
    output,
    new RegExp(`Renovate runtime contract\\s+passed\\s+${durations.at(-1)}ms`)
  )
  assert.match(output, new RegExp(`Total\\s+${expectedTotal}ms`))
})

test('validation runner preserves ordinary nonzero status and marks later phases skipped', async () => {
  let clock = 0
  let calls = 0
  let output = ''
  const result = await runValidation({
    now: () => clock,
    runPhase() {
      calls += 1
      clock += 10
      return { exitCode: calls === 2 ? 7 : 0, signal: null, closureConfirmed: true }
    },
    write: (value) => { output += value },
  })

  assert.equal(result.exitCode, 7)
  assert.equal(result.totalMilliseconds, 20)
  assert.equal(calls, 2)
  assert.equal(result.records[1].exitCode, 7)
  assert.deepEqual(
    result.records.map(({ result: phaseResult }) => phaseResult),
    ['passed', 'failed', ...Array(VALIDATION_PHASES.length - 2).fill('skipped')]
  )
  assert.match(
    output,
    new RegExp(`${VALIDATION_PHASES[1].name}\\s+failed\\s+10ms`)
  )
  assert.match(output, /Renovate system policy\s+skipped\s+-/)
})

test('validation runner retains a process error and signal as authoritative failure', async () => {
  let output = ''
  let errors = ''
  const result = await runValidation({
    now: () => 0,
    runPhase: () => ({ exitCode: 143, signal: 'SIGTERM', error: 'spawn unavailable', closureConfirmed: true }),
    write: (value) => { output += value },
    writeError: (value) => { errors += value },
  })

  assert.equal(result.records[0].result, 'failed')
  assert.equal(result.records.slice(1).every(({ result: phaseResult }) => phaseResult === 'skipped'), true)
  assert.equal(result.exitCode, 143)
  assert.equal(result.records[0].signal, 'SIGTERM')
  assert.match(errors, /Toolchain contract failed: spawn unavailable/)
  assert.match(errors, /ended from signal SIGTERM/)
  assert.match(output, /Toolchain contract\s+failed/)
})

test('validation runner refuses exit zero when process-tree closure is unconfirmed', async () => {
  let output = ''
  let errors = ''
  let calls = 0
  const result = await runValidation({
    phases: [
      { name: 'Unclosed phase', script: 'unclosed.mjs' },
      { name: 'Must skip', script: 'skipped.mjs' },
    ],
    now: () => 0,
    runPhase: () => {
      calls += 1
      return {
        exitCode: 0,
        closureConfirmed: false,
        error: 'process-group closure could not be confirmed',
      }
    },
    write: (value) => { output += value },
    writeError: (value) => { errors += value },
  })

  assert.equal(calls, 1)
  assert.equal(result.exitCode, 125)
  assert.equal(result.records[0].result, 'failed')
  assert.equal(result.records[0].closureConfirmed, false)
  assert.equal(result.records[1].result, 'skipped')
  assert.match(errors, /process-tree closure could not be confirmed/u)
  assert.doesNotMatch(output, /Unclosed phase\s+passed/u)
})

test('validation runner refuses a supervisor error even when exit code is zero', async () => {
  let errors = ''
  const result = await runValidation({
    phases: [{ name: 'Supervisor error', script: 'error.mjs' }],
    now: () => 0,
    runPhase: () => ({ exitCode: 0, closureConfirmed: true, error: 'supervisor protocol failed' }),
    write: () => {},
    writeError: (value) => { errors += value },
  })
  assert.equal(result.exitCode, 1)
  assert.equal(result.records[0].result, 'failed')
  assert.match(errors, /supervisor protocol failed/u)
})

test('validation timing values are rounded up to whole milliseconds', async () => {
  let clock = 0
  const result = await runValidation({
    phases: [{ name: 'Fractional phase', script: 'fixture.mjs' }],
    now: () => clock,
    runPhase: () => {
      clock = 1.25
      return { exitCode: 0, closureConfirmed: true }
    },
    write: () => {},
  })
  assert.equal(result.records[0].durationMilliseconds, 2)
  assert.equal(result.totalMilliseconds, 2)
})

test('validation phase timeout is authoritative, bounded, and recovery-directed', async () => {
  let errors = ''
  const result = await runValidation({
    phases: [{ name: 'Hung phase', script: 'hung.mjs' }],
    phaseDeadlineMilliseconds: 10,
    cancelGraceMilliseconds: 5,
    runPhase: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({
        exitCode: 124,
        signal: null,
        timedOut: true,
        closureConfirmed: true,
      }), { once: true })
    }),
    write: () => {},
    writeError: (value) => { errors += value },
  })
  assert.equal(result.exitCode, 124)
  assert.equal(result.records[0].timedOut, true)
  assert.equal(result.records[0].closureConfirmed, true)
  assert.match(errors, /Hung phase timed out after 10ms/u)
  assert.match(errors, /process-tree closure confirmed/u)
  assert.match(errors, /Recovery: run node hung\.mjs/u)
})

test('validation timeout cancels a real child tree through the shared supervisor', async (context) => {
  if (process.platform === 'win32') return
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-validation-timeout-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ready = path.join(directory, 'ready')
  const hostile = path.join(directory, 'hostile.mjs')
  fs.writeFileSync(hostile, `import fs from 'node:fs'
import { spawn } from 'node:child_process'
process.on('SIGTERM', () => {})
spawn('/bin/bash', ['-c', "trap '' TERM; while :; do sleep 1; done"], { stdio: 'ignore' })
fs.writeFileSync(process.argv[2], process.env.RENOVATE_CONFIG_VERIFICATION_SUPERVISOR)
setInterval(() => {}, 1000)
`)
  const result = await runValidation({
    phases: [{ name: 'Hostile tree', script: hostile, arguments: [ready] }],
    phaseDeadlineMilliseconds: 100,
    cancelGraceMilliseconds: 50,
    write: () => {},
    writeError: () => {},
  })
  assert.equal(result.exitCode, 124)
  assert.equal(result.records[0].timedOut, true)
  assert.equal(result.records[0].closureConfirmed, true)
  assert.equal(fs.existsSync(ready), true)
})

test('default validation phase deadline is distinct from the outer verify deadline', () => {
  assert.equal(VALIDATION_PHASE_DEADLINE_MILLISECONDS, 30_000)
  assert.ok(VALIDATION_PHASE_DEADLINE_MILLISECONDS < HARD_DEADLINE_MILLISECONDS)
})

test('validate and verify share one neutral bounded-command implementation', () => {
  const bounded = fs.readFileSync(new URL('./bounded-command.mjs', import.meta.url), 'utf8')
  const validate = fs.readFileSync(new URL('./validate.mjs', import.meta.url), 'utf8')
  const verify = fs.readFileSync(new URL('./verify.mjs', import.meta.url), 'utf8')
  assert.match(validate, /from '\.\/bounded-command\.mjs'/u)
  assert.doesNotMatch(validate, /from '\.\/verify\.mjs'/u)
  assert.match(verify, /from '\.\/bounded-command\.mjs'/u)
  assert.equal(bounded.match(/export function runCommandLane/gu)?.length, 1)
  assert.doesNotMatch(verify, /export function runCommandLane\s*\(/u)
})

test('validation timing receipt retains executed process evidence and explicit skipped semantics', async () => {
  const result = await runValidation({
    phases: [
      { name: 'Failed phase', script: 'failed.mjs', timeoutMilliseconds: 321 },
      { name: 'Skipped phase', script: 'skipped.mjs' },
    ],
    now: () => 0,
    runPhase: () => ({
      exitCode: 9,
      signal: null,
      timedOut: false,
      closureConfirmed: true,
    }),
    write: () => {},
    writeError: () => {},
  })
  const receipt = validationTimingReceipt(result)
  assert.deepEqual(receipt.phases[0], {
    name: 'Failed phase',
    script: 'failed.mjs',
    deadlineMilliseconds: 321,
    exitCode: 9,
    signal: null,
    timedOut: false,
    closureConfirmed: true,
    error: null,
    result: 'failed',
    durationMilliseconds: 0,
  })
  assert.deepEqual(receipt.phases[1], {
    name: 'Skipped phase',
    script: 'skipped.mjs',
    deadlineMilliseconds: null,
    exitCode: null,
    signal: null,
    timedOut: null,
    closureConfirmed: null,
    error: null,
    result: 'skipped',
    durationMilliseconds: 0,
  })
})
