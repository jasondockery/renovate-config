import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { collectToolchainConsumerProblems } from './check-renovate-repository-coverage.mjs'

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url))
const CONSUMER_MODULES = [
  'toolchain-contract.mjs',
  'sync-toolchain.mjs',
  'check-toolchain.mjs',
  'show-outdated.mjs',
  'is-main.mjs',
]

// A consumer repository whose declarations agree, so each assertion below
// isolates the one thing it is about.
function consumerFixture(context, { renovate = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-audit-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'tools'))
  for (const file of CONSUMER_MODULES)
    fs.copyFileSync(path.join(TOOL_DIR, file), path.join(root, 'tools', file))
  fs.writeFileSync(path.join(root, '.node-version'), '20.11.1\n')
  fs.writeFileSync(path.join(root, '.nvmrc'), '20.11.1\n')
  fs.writeFileSync(path.join(root, 'mise.toml'), '[tools]\nnode = "20.11.1"\n')
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify(
      {
        packageManager: 'pnpm@9.15.5',
        engines: { node: '20.11.1', pnpm: '9.15.5' },
        scripts: {
          'toolchain:sync': 'node tools/sync-toolchain.mjs',
          'check:toolchain': 'node tools/check-toolchain.mjs',
          'check:outdated': 'node tools/show-outdated.mjs',
        },
      },
      null,
      2
    )}\n`
  )
  if (renovate)
    fs.writeFileSync(
      path.join(root, 'renovate.json'),
      `${JSON.stringify({ postUpgradeTasks: { commands: ['node tools/sync-toolchain.mjs'] } }, null, 2)}\n`
    )
  return root
}

test('a synchronized consumer audits clean through the real child process', (context) => {
  assert.deepEqual(collectToolchainConsumerProblems(consumerFixture(context)), [])
})

test('a consumer with no renovate.json is reported, not thrown', (context) => {
  // The audit reads renovate.json defensively; an absent file must produce a
  // problem for this repository rather than aborting the whole sweep.
  const problems = collectToolchainConsumerProblems(consumerFixture(context, { renovate: false }))
  assert.match(problems.join('\n'), /renovate\.json is missing or unreadable/)
  assert.match(problems.join('\n'), /Renovate does not run exact toolchain sync/)
})

test('a consumer that cannot be audited fails closed with a named reason', (context) => {
  const root = consumerFixture(context)
  const cases = [
    [{ error: new Error('spawn ENOENT') }, /could not run \(spawn ENOENT\)/],
    [{ status: null, signal: 'SIGTERM' }, /terminated by SIGTERM/],
    [{ status: 3, stdout: '', stderr: 'boom' }, /exited 3: boom/],
    [{ status: 0, stdout: 'not json' }, /malformed JSON evidence/],
    [{ status: 0, stdout: '{}' }, /returned no problem list/],
  ]
  for (const [result, expected] of cases)
    assert.match(collectToolchainConsumerProblems(root, () => result).join('\n'), expected)
})

test('an audited repository cannot corrupt the auditing process', (context) => {
  const root = consumerFixture(context)
  // Top-level code in a consumer module runs on import. In-process, this would
  // patch the auditor itself; in a child process it can only affect its own
  // verdict, and the auditing process keeps working for every other repository.
  fs.appendFileSync(
    path.join(root, 'tools', 'sync-toolchain.mjs'),
    '\nArray.prototype.includes = () => true\n'
  )
  collectToolchainConsumerProblems(root)
  assert.equal([1, 2].includes(3), false)
  assert.deepEqual(collectToolchainConsumerProblems(consumerFixture(context)), [])
})
