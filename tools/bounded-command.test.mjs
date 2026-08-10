import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import {
  normalizeBoundedCommandResult,
  runCommandLane,
} from './bounded-command.mjs'

function silentLane(overrides = {}) {
  return runCommandLane({
    name: 'fixture',
    command: process.execPath,
    arguments_: ['-e', 'process.exit(0)'],
    cwd: process.cwd(),
    write: () => {},
    writeError: () => {},
    cancelGraceMilliseconds: 50,
    ...overrides,
  })
}

function supervisorFixture(context, source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-bounded-command-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'supervisor.mjs')
  fs.writeFileSync(file, source)
  return file
}

test('normalization never lets incomplete process evidence retain exit zero', () => {
  assert.equal(normalizeBoundedCommandResult({ exitCode: 0, closureConfirmed: false }), 125)
  assert.equal(normalizeBoundedCommandResult({ exitCode: 0, signal: 'SIGKILL' }), 137)
  assert.equal(normalizeBoundedCommandResult({ exitCode: 0, error: 'protocol failed' }), 70)
  assert.equal(normalizeBoundedCommandResult({ exitCode: 9, error: 'secondary detail' }), 9)
  assert.equal(normalizeBoundedCommandResult({ exitCode: 0, timedOut: true }), 124)
  assert.equal(normalizeBoundedCommandResult({ exitCode: 0 }), 0)
})

test('the shared supervisor preserves clean and ordinary nonzero command status', async () => {
  const clean = await silentLane()
  assert.equal(clean.exitCode, 0)
  assert.equal(clean.signal, null)
  assert.equal(clean.closureConfirmed, true)
  assert.equal(clean.error, undefined)

  const failed = await silentLane({ arguments_: ['-e', 'process.exit(9)'] })
  assert.equal(failed.exitCode, 9)
  assert.equal(failed.signal, null)
  assert.equal(failed.closureConfirmed, true)
})

test('a supervisor signal after a reported zero is an explicit failure', async (context) => {
  const supervisor = supervisorFixture(context, `
process.send({ type: 'command-status', exitCode: 0, signal: null }, () => {
  process.kill(process.pid, 'SIGKILL')
})
setInterval(() => {}, 1000)
`)
  const result = await silentLane({ supervisor })
  assert.notEqual(result.exitCode, 0)
  assert.equal(result.signal, 'SIGKILL')
  assert.match(result.error, /supervisor (?:release failed|exited unexpectedly)/u)
})

test('a supervisor protocol error after a reported zero is an explicit failure', async (context) => {
  const supervisor = supervisorFixture(context, `
process.on('message', (message) => {
  if (message?.type === 'release') process.exit(0)
})
process.send({
  type: 'command-status',
  exitCode: 0,
  signal: null,
  error: 'fixture protocol failed',
})
setInterval(() => {}, 1000)
`)
  const result = await silentLane({ supervisor })
  assert.equal(result.exitCode, 70)
  assert.equal(result.closureConfirmed, true)
  assert.equal(result.error, 'fixture protocol failed')
})

test('unavailable process-group observation fails closed with explicit evidence', async () => {
  const result = await silentLane({ processGroupMembers: () => null })
  assert.equal(result.exitCode, 125)
  assert.equal(result.closureConfirmed, false)
  assert.match(result.error, /process-group observation unavailable/u)
})

test('a real hanging command reaches the authoritative timeout status', async () => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort({ type: 'timeout' }), 50)
  try {
    const result = await silentLane({
      arguments_: ['-e', 'setInterval(() => {}, 1000)'],
      signal: controller.signal,
    })
    assert.equal(result.exitCode, 124)
    assert.equal(result.timedOut, true)
    assert.equal(result.closureConfirmed, true)
  } finally {
    clearTimeout(timeout)
  }
})
