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
  '.github/workflows/security-hygiene.yml',
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
  'skills/live-renovate-acceptance/SKILL.md',
  'skills/live-renovate-acceptance/agents/openai.yaml',
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

function replaceStepRepositories(root, relativePath, stepName, repositories) {
  const file = path.join(root, relativePath)
  const source = fs.readFileSync(file, 'utf8')
  const escapedName = stepName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const pattern = new RegExp(`( {6}- name: ${escapedName}\\n[\\s\\S]*?^ {10}repositories:) [^\\n]+`, 'mu')
  const changed = source.replace(pattern, `$1 ${repositories}`)
  assert.notEqual(changed, source, `${stepName} repositories fixture must be replaced`)
  fs.writeFileSync(file, changed)
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

  await context.test('daily routine branch creation', (subcontext) => {
    const root = fixture(subcontext)
    mutateJson(root, 'default.json', (preset) => { preset.extends.push('schedule:weekly') })
    assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /daily routine branch creation/)
  })

  await context.test('consumer scope', (subcontext) => {
    const root = fixture(subcontext)
    const file = path.join(root, '.github/workflows/renovate.yml')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(',jasondockery/groundwork', ''))
    assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /must exactly match compatibility-targets\.json/)
  })

  await context.test('latest-head compatibility scope', (subcontext) => {
    const root = fixture(subcontext)
    mutateJson(root, 'compatibility-targets.json', (manifest) => { manifest.targets.pop() })
    assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /canonical ordered inventory of exactly three/)
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

  await context.test('security merge authority', (subcontext) => {
    const root = fixture(subcontext)
    mutateJson(root, 'default.json', (preset) => { preset.vulnerabilityAlerts.automerge = true })
    assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /required human merge review/)
  })

  await context.test('built-in manager narrowing', (subcontext) => {
    const root = fixture(subcontext)
    mutateJson(root, 'default.json', (preset) => { preset.enabledManagers = ['npm'] })
    assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /must not silently narrow/)
  })
})

test('binds every GitHub App repository scope to compatibility-targets.json', async (context) => {
  const runnerFile = '.github/workflows/renovate.yml'
  const canonicalSlugs = 'jasondockery/renovate-config,jasondockery/roost,jasondockery/groundwork'
  const canonicalNames = 'renovate-config,roost,groundwork'
  const runnerScopeMutations = {
    missing: 'jasondockery/renovate-config,jasondockery/roost',
    extra: `${canonicalSlugs},jasondockery/unmanaged`,
    duplicate: `${canonicalSlugs},jasondockery/roost`,
    reordered: 'jasondockery/roost,jasondockery/renovate-config,jasondockery/groundwork',
    malformed: 'jasondockery/renovate-config,NOT-A-SLUG,jasondockery/groundwork',
  }

  for (const [label, repositories] of Object.entries(runnerScopeMutations)) {
    await context.test(`runner environment rejects ${label} scope`, (subcontext) => {
      const root = fixture(subcontext)
      const file = path.join(root, runnerFile)
      const source = fs.readFileSync(file, 'utf8')
      fs.writeFileSync(file, source.replace(canonicalSlugs, repositories))
      assert.match(
        collectRenovateSystemPolicyProblems(root).join('\n'),
        /RENOVATE_REPOSITORIES.*(?:malformed|duplicate|exactly match)/
      )
    })
  }

  const tokenCases = [
    [runnerFile, 'Mint runner token (GitHub App)', 'roost,groundwork', /Mint runner token/],
    [runnerFile, 'Mint runner token (GitHub App)', `${canonicalNames},unmanaged`, /Mint runner token/],
    [runnerFile, 'Mint runner token (GitHub App)', `${canonicalNames},roost`, /duplicate repository/],
    [runnerFile, 'Mint runner token (GitHub App)', 'roost,renovate-config,groundwork', /repository order differs/],
    [runnerFile, 'Mint runner token (GitHub App)', 'renovate-config,INVALID,groundwork', /malformed repository/],
    ['.github/workflows/renovate-compatibility.yml', 'Mint read-only consumer token', 'groundwork,roost', /repository order differs/],
    ['.github/workflows/security-hygiene.yml', 'Mint alerts token (GitHub App)', 'renovate-config,roost', /Mint alerts token/],
    ['.github/workflows/security-hygiene.yml', 'Mint code-scanning token (GitHub App)', 'renovate-config,groundwork,roost', /repository order differs/],
    ['.github/workflows/security-hygiene.yml', 'Mint secret-scanning token (GitHub App)', `${canonicalNames},unmanaged`, /Mint secret-scanning token/],
  ]
  for (const [relativePath, stepName, repositories, expected] of tokenCases) {
    await context.test(`${stepName} rejects scope drift`, (subcontext) => {
      const root = fixture(subcontext)
      replaceStepRepositories(root, relativePath, stepName, repositories)
      assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), expected)
    })
  }

  await context.test('token owner must match the canonical inventory owner', (subcontext) => {
    const root = fixture(subcontext)
    const file = path.join(root, runnerFile)
    const source = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, source.replace('          owner: jasondockery\n', '          owner: other-owner\n'))
    assert.match(collectRenovateSystemPolicyProblems(root).join('\n'), /owner must match compatibility-targets\.json/)
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
