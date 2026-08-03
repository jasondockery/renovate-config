import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { collectRenovateSystemPolicyProblems } from './check-renovate-system-policy.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const required = [
  'AI_THESIS.md',
  'AGENTS.md',
  'default.json',
  'package.json',
  'dependency-coverage.json',
  'compatibility-targets.json',
  '.github/workflows/renovate.yml',
  '.github/workflows/renovate-compatibility.yml',
  'specs/renovate-system-acceptance.md',
  'playbooks/x-renovate-system-acceptance.md',
  'tools/fixtures/github/renovate-pr-author.json',
  'tools/fixtures/github/renovate-dashboard-problems.json',
  'tools/check-renovate-repository-coverage.mjs',
  'tools/render-renovate-compatibility.mjs',
  'tools/renovate-system-audit.mjs',
]

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-system-policy-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const relativePath of required) {
    const target = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(repoRoot, relativePath), target)
  }
  return root
}

function mutateJson(root, relativePath, mutate) {
  const value = JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
  mutate(value)
  fs.writeFileSync(path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`)
}

test('accepts the complete checked-in system policy', () => {
  assert.deepEqual(collectRenovateSystemPolicyProblems(repoRoot), [])
})

test('accepts the green pre-proposal landing state', (context) => {
  const root = fixture(context)
  mutateJson(root, 'package.json', (manifest) => { delete manifest.scripts['renovate:policy-proposal'] })
  assert.deepEqual(collectRenovateSystemPolicyProblems(root), [])
})

test('rejects a proposal package script without its complete files', (context) => {
  const root = fixture(context)
  for (const relative of [
    'specs/preset-freeze-exception.md',
    'tools/check-renovate-effective-policy.mjs',
    'tools/check-renovate-effective-policy.test.mjs',
    'tools/fixtures/preset/default-five-day-policy.json',
    'tools/validate-renovate-policy-proposal.mjs',
  ]) fs.rmSync(path.join(root, relative), { force: true })
  assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /package script must exist or be absent together/)
})

test('rejects schedule, activation, scope, security, and manager-coverage drift', async (context) => {
  await context.test('thesis outcome routing', (subcontext) => {
    const root = fixture(subcontext)
    fs.writeFileSync(path.join(root, 'AI_THESIS.md'), '# Local checks are green\n')
    assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /real consumer outcome/)
  })

  await context.test('daily workflow cadence', (subcontext) => {
    const root = fixture(subcontext)
    const file = path.join(root, '.github/workflows/renovate.yml')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("cron: '17 1 * * *'", "cron: '17 1 * * 1'"))
    assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /run once daily/)
  })

  await context.test('consumer scope', (subcontext) => {
    const root = fixture(subcontext)
    const file = path.join(root, '.github/workflows/renovate.yml')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(',jasondockery/groundwork', ''))
    assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /exactly the three chartered/)
  })

  await context.test('latest-head compatibility scope', (subcontext) => {
    const root = fixture(subcontext)
    mutateJson(root, 'compatibility-targets.json', (manifest) => { manifest.targets.pop() })
    assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /exact three checkout directories/)
  })

  await context.test('manual-only compatibility activation', (subcontext) => {
    const root = fixture(subcontext)
    const file = path.join(root, '.github/workflows/renovate-compatibility.yml')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('  workflow_dispatch:\n', "  workflow_dispatch:\n  schedule:\n    - cron: '43 2 * * *'\n"))
    assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /explicit activation state/)
  })

  await context.test('compatibility artifact action pin identity', (subcontext) => {
    const root = fixture(subcontext)
    const file = path.join(root, '.github/workflows/renovate-compatibility.yml')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1',
      'actions/upload-artifact@a8a3f3ad30e3422c9c7b888a15615d19a852ae32 # v7.0.0',
    ))
    assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /matching version comment/)
  })

  await context.test('truthful acceptance status', (subcontext) => {
    const root = fixture(subcontext)
    const file = path.join(root, 'specs/renovate-system-acceptance.md')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Contract status: proposed', 'Contract status: accepted'))
    assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /must remain proposed/)
  })

  await context.test('preset proposal commit completeness', (subcontext) => {
    const root = fixture(subcontext)
    const relative = 'specs/preset-freeze-exception.md'
    fs.mkdirSync(path.join(root, 'specs'), { recursive: true })
    fs.copyFileSync(path.join(repoRoot, relative), path.join(root, relative))
    assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /one complete isolated contract/)
  })

  await context.test('security timing', (subcontext) => {
    const root = fixture(subcontext)
    mutateJson(root, 'default.json', (preset) => { preset.vulnerabilityAlerts.prCreation = 'not-pending' })
    assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /accepted frozen preset/)
  })

  await context.test('built-in manager narrowing', (subcontext) => {
    const root = fixture(subcontext)
    mutateJson(root, 'default.json', (preset) => { preset.enabledManagers = ['npm'] })
    assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /must not silently narrow/)
  })
})
