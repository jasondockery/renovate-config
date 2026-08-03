import assert from 'node:assert/strict'
import test from 'node:test'
import { runValidation, VALIDATION_PHASES } from './validate.mjs'

test('validation runner preserves phase order and reports internal timings', () => {
  let clock = 0
  const commands = []
  let output = ''
  const durations = [15, 25, 30, 35, 45]
  const result = runValidation({
    now: () => clock,
    run(command, arguments_, options) {
      commands.push({ command, arguments_, options })
      clock += durations[commands.length - 1]
      return { status: 0 }
    },
    write: (value) => { output += value },
  })

  assert.equal(result.exitCode, 0)
  assert.deepEqual(
    commands.map(({ arguments_ }) => arguments_[0]),
    VALIDATION_PHASES.map(({ script }) => script)
  )
  assert.equal(commands.every(({ options }) => options.stdio === 'inherit'), true)
  assert.deepEqual(result.records.map(({ result: phaseResult }) => phaseResult), Array(5).fill('passed'))
  assert.equal(result.totalMilliseconds, 150)
  assert.match(output, /Toolchain contract\s+passed\s+15ms/)
  assert.match(output, /Renovate runtime contract\s+passed\s+45ms/)
  assert.match(output, /Total\s+150ms/)
})

test('validation runner fails fast and marks later phases skipped', () => {
  let clock = 0
  let calls = 0
  let output = ''
  const result = runValidation({
    now: () => clock,
    run() {
      calls += 1
      clock += 10
      return { status: calls === 2 ? 7 : 0 }
    },
    write: (value) => { output += value },
  })

  assert.equal(result.exitCode, 7)
  assert.equal(result.totalMilliseconds, 20)
  assert.equal(calls, 2)
  assert.deepEqual(
    result.records.map(({ result: phaseResult }) => phaseResult),
    ['passed', 'failed', 'skipped', 'skipped', 'skipped']
  )
  assert.match(output, /Preset freeze\s+failed\s+10ms/)
  assert.match(output, /Renovate system policy\s+skipped\s+-/)
})

test('validation runner treats a phase launch error as authoritative failure', () => {
  let output = ''
  let errors = ''
  const result = runValidation({
    now: () => 0,
    run: () => ({ status: null, error: new Error('spawn unavailable') }),
    write: (value) => { output += value },
    writeError: (value) => { errors += value },
  })

  assert.equal(result.exitCode, 1)
  assert.equal(result.records[0].result, 'failed')
  assert.equal(result.records.slice(1).every(({ result: phaseResult }) => phaseResult === 'skipped'), true)
  assert.match(errors, /Toolchain contract could not start: spawn unavailable/)
  assert.match(output, /Toolchain contract\s+failed/)
})

test('validation timing values are rounded up to whole milliseconds', () => {
  let clock = 0
  const result = runValidation({
    phases: [{ name: 'Fractional phase', script: 'fixture.mjs' }],
    now: () => clock,
    run: () => {
      clock = 1.25
      return { status: 0 }
    },
    write: () => {},
  })
  assert.equal(result.records[0].durationMilliseconds, 2)
  assert.equal(result.totalMilliseconds, 2)
})
