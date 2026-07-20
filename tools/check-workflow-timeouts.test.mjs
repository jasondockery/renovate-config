import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const CHECKER = new URL('check-workflow-timeouts.mjs', import.meta.url).pathname
const SHA = '1234567890abcdef1234567890abcdef12345678'

/** Run the checker over a throwaway workflow directory. */
function run(files) {
  const dir = mkdtempSync(join(tmpdir(), 'wf-timeout-'))
  try {
    mkdirSync(dir, { recursive: true })
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
    try {
      return { code: 0, out: execFileSync('node', [CHECKER, dir], { encoding: 'utf8' }) }
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
