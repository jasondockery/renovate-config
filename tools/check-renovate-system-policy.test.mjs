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
  'CLAUDE.md',
  'specs/verification.md',
  'default.json',
  'package.json',
  'dependency-coverage.json',
  'compatibility-targets.json',
  '.github/workflows/renovate.yml',
  '.github/workflows/renovate-compatibility.yml',
  'specs/renovate-system-acceptance.md',
  'playbooks/x-renovate-system-acceptance.md',
  'specs/preset-freeze-exception.md',
  'tools/fixtures/github/renovate-pr-author.json',
  'tools/fixtures/github/renovate-dashboard-problems.json',
  'tools/check-renovate-repository-coverage.mjs',
  'tools/render-renovate-compatibility.mjs',
  'tools/renovate-system-audit.mjs',
  'tools/check-renovate-effective-policy.mjs',
  'tools/check-renovate-effective-policy.test.mjs',
  'tools/fixtures/preset/default-five-day-policy.json',
  'tools/validate-renovate-effective-policy.mjs',
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

test('rejects an incomplete active-policy proof surface', (context) => {
  const root = fixture(context)
  fs.rmSync(path.join(root, 'tools/fixtures/preset/default-five-day-policy.json'))
  assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /active five-day policy/)
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

  await context.test('truthful acceptance status', (subcontext) => {
    const root = fixture(subcontext)
    const file = path.join(root, 'specs/renovate-system-acceptance.md')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Contract status: active', 'Contract status: proposed'))
    assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /must remain active/)
  })

  await context.test('active policy command completeness', (subcontext) => {
    const root = fixture(subcontext)
    mutateJson(root, 'package.json', (manifest) => { delete manifest.scripts['renovate:policy'] })
    assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /exact renovate:policy command/)
  })

  await context.test('security timing', (subcontext) => {
    const root = fixture(subcontext)
    mutateJson(root, 'default.json', (preset) => { preset.vulnerabilityAlerts.prCreation = 'not-pending' })
    assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /active preset/)
  })

  await context.test('built-in manager narrowing', (subcontext) => {
    const root = fixture(subcontext)
    mutateJson(root, 'default.json', (preset) => { preset.enabledManagers = ['npm'] })
    assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /must not silently narrow/)
  })
})

// Claude Code loads CLAUDE.md, not AGENTS.md. If the adapter is deleted or its
// import removed, the repository's agent policy silently stops reaching the
// session and no other check observes it.
test('requires a working Claude Code adapter and verification routing', (context) => {
  const root = fixture(context)
  assert.deepEqual(collectRenovateSystemPolicyProblems(root), [])

  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude\n\nSee [AGENTS.md](AGENTS.md).\n')
  assert.match(
    collectRenovateSystemPolicyProblems(root).join('\n'),
    /must import the canonical spine with a bare @AGENTS\.md line/
  )

  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '@AGENTS.md\n\n## Operating Rules\n\n- do a thing\n')
  assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /thin adapter; policy belongs in AGENTS\.md/)

  fs.rmSync(path.join(root, 'CLAUDE.md'))
  assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /missing system contract: CLAUDE\.md/)
})

test('requires AGENTS.md to route verification mechanics out of the spine', (context) => {
  const root = fixture(context)
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
  fs.writeFileSync(path.join(root, 'AGENTS.md'), agents.replaceAll('specs/verification.md', 'specs/gone.md'))
  assert.match(
    collectRenovateSystemPolicyProblems(root).join('\n'),
    /must route verification mechanics to specs\/verification\.md/
  )

  fs.writeFileSync(path.join(root, 'AGENTS.md'), agents)
  fs.rmSync(path.join(root, 'specs/verification.md'))
  assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /missing system contract: specs\/verification\.md/)
})
