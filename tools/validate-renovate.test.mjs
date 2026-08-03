import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  RENOVATE_CONFIGS,
  validateRenovate,
  validatorEnvironment,
} from './validate-renovate.mjs'

const SILENT = { log() {}, error() {} }

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-validator-'))
  fs.writeFileSync(path.join(repoRoot, '.renovate-version'), '1.2.3\n')
  fs.writeFileSync(path.join(repoRoot, 'package.json'), '{"name":"renovate","version":"1.2.3"}\n')
  return repoRoot
}

test('sanitizes ambient Renovate configuration and preserves unrelated environment', () => {
  assert.deepEqual(
    validatorEnvironment({
      PATH: '/bin',
      RENOVATE_CONFIG_FILE: 'other.json',
      RENOVATE_ALLOWED_COMMANDS: '["^.*$"]',
    }),
    { PATH: '/bin' }
  )
})

test('runs the exact strict validators in the correct configuration modes', (context) => {
  const repoRoot = fixture()
  context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  const calls = []
  const result = validateRenovate({
    repoRoot,
    environment: {
      PATH: process.env.PATH,
      RENOVATE_CONFIG_FILE: 'other.json',
      RENOVATE_ALLOWED_COMMANDS: '["^.*$"]',
    },
    output: SILENT,
    findRuntime: () => repoRoot,
    run(command, args, options) {
      calls.push({ command, args, options })
      return { status: 0 }
    },
  })

  assert.deepEqual(result, { ok: true, version: '1.2.3', failures: [] })
  assert.equal(calls.length, RENOVATE_CONFIGS.length)
  assert.deepEqual(
    calls.map(({ args }) => args.at(-1)),
    ['default.json', 'renovate.json', 'runner.json']
  )
  assert.deepEqual(
    calls.map(({ args }) => args.includes('--no-global')),
    [true, true, false]
  )
  assert.ok(calls.every(({ args }) => args.includes('--strict')))
  assert.ok(calls.every(({ options }) => options.cwd === repoRoot))
  assert.ok(calls.every(({ options }) => options.stdio === 'inherit'))
  assert.ok(calls.every(({ command }) => command === 'renovate-config-validator'))
  assert.ok(calls.every(({ options }) => options.env.PATH === process.env.PATH))
  assert.ok(
    calls.every(({ options }) =>
      Object.keys(options.env).every((name) => !name.startsWith('RENOVATE_'))
    )
  )
})

test('continues after spawn errors, non-zero exits, and signal termination', (context) => {
  const repoRoot = fixture()
  context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  const results = [
    { error: new Error('missing npx'), status: null },
    { status: 2 },
    { status: null, signal: 'SIGTERM' },
  ]
  let calls = 0
  const result = validateRenovate({
    repoRoot,
    output: SILENT,
    findRuntime: () => repoRoot,
    run() {
      const value = results[calls]
      calls += 1
      return value
    },
  })

  assert.equal(calls, 3)
  assert.deepEqual(result, {
    ok: false,
    version: '1.2.3',
    failures: ['default.json', 'renovate.json', 'runner.json'],
  })
})

test('reports success only when every validator succeeds', (context) => {
  const repoRoot = fixture()
  context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  const result = validateRenovate({
    repoRoot,
    output: SILENT,
    findRuntime: () => repoRoot,
    run() {
      return { status: 0 }
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.failures, [])
})
