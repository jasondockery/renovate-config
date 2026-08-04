import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const CHECKER = new URL('check-workflow-timeouts.mjs', import.meta.url).pathname
const SHA = '1234567890abcdef1234567890abcdef12345678'

/** Run the checker over a throwaway workflow directory. */
function run(files, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wf-timeout-'))
  try {
    mkdirSync(dir, { recursive: true })
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
    try {
      return {
        code: 0,
        out: execFileSync('node', [CHECKER, dir], {
          encoding: 'utf8',
          env: { ...process.env, ...env },
        }),
      }
    } catch (error) {
      return { code: error.status, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const job = (body) => `name: T\non: [push]\njobs:\n${body}`

test('accepts bounded jobs in .yml and .yaml, including a trailing comment', () => {
  const result = run({
    'a.yml': job('  one:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10 # short\n'),
    'b.yaml': job('  two:\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n'),
  })
  assert.equal(result.code, 0)
})

test('rejects a job with no timeout, including the last job in a file', () => {
  const result = run({ 'a.yml': job('  unbounded:\n    runs-on: ubuntu-latest\n') })
  assert.equal(result.code, 1)
  assert.match(result.out, /job unbounded has no timeout-minutes/)
})

test('rejects non-integer, zero, and over-ceiling timeouts', () => {
  assert.match(run({ 'a.yml': job('  j:\n    timeout-minutes: abc\n') }).out, /positive integer/)
  assert.match(run({ 'a.yml': job('  j:\n    timeout-minutes: 0\n') }).out, /greater than zero/)
  assert.match(run({ 'a.yml': job('  j:\n    timeout-minutes: 999\n') }).out, /exceeds the 60-minute/)
})

test('exempts SHA-pinned reusable-workflow calls but requires the pin', () => {
  assert.equal(run({ 'a.yml': job(`  s:\n    uses: o/r/.github/workflows/w.yml@${SHA}\n`) }).code, 0)
  assert.match(
    run({ 'a.yml': job('  s:\n    uses: o/r/.github/workflows/w.yml@main\n') }).out,
    /not pinned to a full 40-character SHA/
  )
  assert.match(
    run({ 'a.yml': job(`  s:\n    uses: o/r/.github/workflows/w.yml@${SHA}\n    timeout-minutes: 10\n`) }).out,
    /must not declare timeout-minutes/
  )
})

test('fails when the workflow directory has no workflows', () => {
  assert.equal(run({}).code, 1)
})

// Field failure class: a guard that reports ok while observing nothing.
// `jobs:` carrying an inline comment is valid YAML, but the parser only
// matched a bare `jobs:` line, so every job vanished and an unbounded job
// passed the gate.
test('an unbounded job is still caught when jobs: carries an inline comment', () => {
  const result = run({
    'a.yml': 'name: T\non: [push]\njobs: # inline comment\n  unbounded:\n    runs-on: ubuntu-latest\n',
  })
  assert.equal(result.code, 1)
  assert.match(result.out, /job unbounded has no timeout-minutes/)
})

test('a workflow whose jobs cannot be parsed fails instead of passing', () => {
  const result = run({ 'a.yml': 'name: T\non: [push]\n# no jobs mapping at all\n' })
  assert.equal(result.code, 1)
  assert.match(result.out, /no jobs were parsed/)
})

// Number('abc') is NaN and `value > NaN` is false, so an unparsable override
// used to remove the ceiling for every job in the repository.
test('an unparsable ceiling override fails instead of disabling the ceiling', () => {
  const overCeiling = { 'a.yml': job('  j:\n    timeout-minutes: 999\n') }
  const bad = run(overCeiling, { MAX_TIMEOUT_MINUTES: 'abc' })
  assert.equal(bad.code, 1)
  assert.match(bad.out, /MAX_TIMEOUT_MINUTES must be a positive integer/)

  assert.equal(run(overCeiling, { MAX_TIMEOUT_MINUTES: '0' }).code, 1)
  assert.equal(run(overCeiling, { MAX_TIMEOUT_MINUTES: '' }).code, 1)
  assert.match(run(overCeiling).out, /exceeds the 60-minute/)
  assert.equal(run(overCeiling, { MAX_TIMEOUT_MINUTES: '1000' }).code, 0)
})
