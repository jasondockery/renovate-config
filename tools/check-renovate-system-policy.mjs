#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_CRON = '17 1 * * *'
const REPOSITORY_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u
const REPOSITORY_NAME = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function readJson(root, relativePath, problems) {
  try {
    return JSON.parse(read(root, relativePath))
  } catch (error) {
    problems.push(`${relativePath} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function parseRepositoryList(raw, label, problems, pattern) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.trim() !== raw) {
    problems.push(`${label} must be one nonempty comma-separated repository list.`)
    return []
  }
  const values = raw.split(',').map((value) => value.trim())
  if (values.some((value) => !pattern.test(value))) {
    problems.push(`${label} contains a malformed repository entry.`)
  }
  if (new Set(values).size !== values.length) {
    problems.push(`${label} contains a duplicate repository entry.`)
  }
  return values
}

function requireExactRepositoryOrder(actual, expected, label, problems) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return
  const missing = expected.filter((value) => !actual.includes(value))
  const extra = actual.filter((value) => !expected.includes(value))
  const sameMembers = missing.length === 0 && extra.length === 0 && actual.length === expected.length
  const detail = [
    missing.length > 0 ? `missing ${missing.join(', ')}` : '',
    extra.length > 0 ? `extra ${extra.join(', ')}` : '',
    sameMembers ? 'repository order differs' : '',
  ].filter(Boolean).join('; ')
  problems.push(`${label} must exactly match compatibility-targets.json in order${detail ? `: ${detail}` : ''}.`)
}

function workflowStepBlocks(workflow) {
  const starts = [...workflow.matchAll(/^ {6}- [^\n]+$/gmu)].map((match) => match.index)
  return starts.map((start, index) => workflow.slice(start, starts[index + 1] ?? workflow.length))
}

function checkTokenRepositoryScopes(workflow, relativePath, expectedOwner, expectedNames, problems) {
  const tokenSteps = workflowStepBlocks(workflow).filter((step) =>
    /^\s+uses:\s+actions\/create-github-app-token@[^\s#]+(?:\s+#.*)?$/mu.test(step)
  )
  if (tokenSteps.length === 0) {
    problems.push(`${relativePath} must contain at least one create-github-app-token step.`)
    return
  }
  for (const [index, step] of tokenSteps.entries()) {
    const name = /^ {6}- name:\s*(.+)$/mu.exec(step)?.[1] ?? `token step ${index + 1}`
    const label = `${relativePath} ${name}`
    const owner = /^\s+owner:\s*([^\s#]+).*$/mu.exec(step)?.[1]
    if (owner !== expectedOwner) {
      problems.push(`${label} owner must match compatibility-targets.json owner ${expectedOwner}.`)
    }
    const rawRepositories = /^\s+repositories:\s*([^#\n]+?)(?:\s+#.*)?$/mu.exec(step)?.[1]?.trim()
    const repositories = parseRepositoryList(rawRepositories, `${label} repositories`, problems, REPOSITORY_NAME)
    requireExactRepositoryOrder(repositories, expectedNames, `${label} repositories`, problems)
  }
}

export function collectRenovateSystemPolicyProblems(root = repositoryRoot) {
  const problems = []
  const preset = readJson(root, 'default.json', problems)
  const packageManifest = readJson(root, 'package.json', problems)
  let workflow = ''
  let compatibilityWorkflow = ''
  let securityHygieneWorkflow = ''
  let thesis = ''
  let agentInstructions = ''
  let acceptance = ''
  try {
    workflow = read(root, '.github/workflows/renovate.yml')
  } catch (error) {
    problems.push(`.github/workflows/renovate.yml must be readable: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    compatibilityWorkflow = read(root, '.github/workflows/renovate-compatibility.yml')
    securityHygieneWorkflow = read(root, '.github/workflows/security-hygiene.yml')
    acceptance = read(root, 'specs/renovate-system-acceptance.md')
  } catch (error) {
    problems.push(`compatibility, hygiene, and acceptance contracts must be readable: ${error instanceof Error ? error.message : String(error)}`)
  }

  const compatibilityTargets = readJson(root, 'compatibility-targets.json', problems)
  const targetEntries = Array.isArray(compatibilityTargets?.targets) ? compatibilityTargets.targets : []
  const targetShapeValid = targetEntries.length === 3 && targetEntries.every((target) =>
    target !== null && typeof target === 'object' &&
    typeof target.repository === 'string' && typeof target.directory === 'string' &&
    Array.isArray(target.ignoredPaths) && target.ignoredPaths.every((entry) => typeof entry === 'string')
  )
  const targetDirectories = targetEntries.flatMap((target) =>
    target !== null && typeof target === 'object' && typeof target.directory === 'string'
      ? [target.directory]
      : []
  )
  if (
    compatibilityTargets?.schemaVersion !== 1 ||
    !['manual-only', 'scheduled'].includes(compatibilityTargets?.activation) ||
    !targetShapeValid || new Set(targetDirectories).size !== targetDirectories.length ||
    targetDirectories.filter((directory) => directory === '.').length !== 1
  ) {
    problems.push('compatibility-targets.json must be the canonical ordered inventory of exactly three unique checkout targets, including this repository.')
  }
  const targetRepositories = targetEntries.flatMap((target) =>
    target !== null && typeof target === 'object' && typeof target.repository === 'string'
      ? [target.repository]
      : []
  )
  if (
    targetRepositories.some((repository) => typeof repository !== 'string' || !REPOSITORY_SLUG.test(repository)) ||
    new Set(targetRepositories).size !== targetRepositories.length
  ) {
    problems.push('compatibility-targets.json repositories must be unique lowercase owner/name slugs.')
  }
  const targetOwners = [...new Set(targetRepositories.map((repository) => repository.split('/')[0]))]
  const targetOwner = targetOwners.length === 1 ? targetOwners[0] : ''
  if (!targetOwner) problems.push('compatibility-targets.json repositories must share one GitHub owner.')
  const targetNames = targetRepositories.map((repository) => repository.split('/')[1])
  try {
    thesis = read(root, 'AI_THESIS.md')
    agentInstructions = read(root, 'AGENTS.md')
  } catch (error) {
    problems.push(`AI thesis and agent instructions must be readable: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (preset) {
    const extensions = Array.isArray(preset.extends) ? preset.extends : []
    if (
      JSON.stringify(extensions) !== JSON.stringify(['config:best-practices']) ||
      Object.hasOwn(preset, 'schedule')
    ) {
      problems.push('default.json must preserve daily routine branch creation through config:best-practices without a calendar schedule.')
    }
    if (preset.minimumReleaseAge !== '5 days') {
      problems.push('default.json must preserve the accepted top-level five-day declaration.')
    }
    if (preset.internalChecksFilter !== 'strict') {
      problems.push('default.json must keep strict internal checks for the active five-day policy.')
    }
    const fiveDayRules = (preset.packageRules ?? []).filter((rule) =>
      JSON.stringify(rule.matchDatasources) === JSON.stringify(['npm']) &&
      JSON.stringify(rule.matchUpdateTypes) === JSON.stringify(['major', 'minor', 'patch'])
    )
    if (
      fiveDayRules.length !== 1 ||
      fiveDayRules[0].minimumReleaseAge !== '5 days' ||
      fiveDayRules[0].internalChecksFilter !== 'strict'
    ) {
      problems.push('default.json must retain the one reviewed npm rule that overrides the inherited three-day policy.')
    }
    if (Object.hasOwn(preset, 'enabledManagers')) {
      problems.push('default.json must not silently narrow built-in dependency manager coverage with enabledManagers.')
    }
    const security = preset.vulnerabilityAlerts
    if (
      !security || security.enabled !== true ||
      JSON.stringify(security.schedule) !== JSON.stringify(['at any time']) ||
      security.minimumReleaseAge !== null || security.prHourlyLimit !== 0 ||
      security.prConcurrentLimit !== 0 || security.prCreation !== 'immediate' ||
      security.automerge !== false || security.platformAutomerge !== false
    ) {
      problems.push('the active preset must preserve immediate vulnerability PRs with age/rate bypass and required human merge review.')
    }
  }

  if (workflow) {
    const crons = [...workflow.matchAll(/^\s*-\s+cron:\s*['"]([^'"]+)['"]\s*$/gmu)].map((match) => match[1])
    if (crons.length !== 1 || crons[0] !== EXPECTED_CRON) {
      problems.push(`Renovate must run once daily at ${EXPECTED_CRON}; found ${crons.join(', ') || 'no cron'}.`)
    }
    if (!/^\s{2}workflow_dispatch:\s*$/mu.test(workflow)) {
      problems.push('Renovate must retain manual workflow_dispatch support.')
    }
    const rawRepositories = /^\s+RENOVATE_REPOSITORIES:\s*(\S+)\s*$/mu.exec(workflow)?.[1]
    const repositories = parseRepositoryList(
      rawRepositories,
      '.github/workflows/renovate.yml RENOVATE_REPOSITORIES',
      problems,
      REPOSITORY_SLUG
    )
    requireExactRepositoryOrder(
      repositories,
      targetRepositories,
      '.github/workflows/renovate.yml RENOVATE_REPOSITORIES',
      problems
    )
    checkTokenRepositoryScopes(workflow, '.github/workflows/renovate.yml', targetOwner, targetNames, problems)
    if (!/cancel-in-progress:\s*false/u.test(workflow)) {
      problems.push('Renovate concurrency must keep cancel-in-progress false.')
    }
  }

  if (packageManifest?.scripts?.['renovate:audit'] !== 'node tools/renovate-system-audit.mjs') {
    problems.push('package.json must expose the canonical read-only renovate:audit command.')
  }
  if (packageManifest?.scripts?.['renovate:integration'] !== 'node tools/validate-renovate-integration.mjs') {
    problems.push('package.json must expose the canonical network-backed renovate:integration command.')
  }
  if (packageManifest?.scripts?.['renovate:compatibility'] !== 'node tools/validate-renovate-compatibility.mjs') {
    problems.push('package.json must expose the canonical latest-head renovate:compatibility command.')
  }
  const activePolicyPaths = [
    'specs/preset-freeze-exception.md',
    'tools/check-renovate-effective-policy.mjs',
    'tools/check-renovate-effective-policy.test.mjs',
    'tools/fixtures/preset/default-five-day-policy.json',
    'tools/validate-renovate-effective-policy.mjs',
  ]
  const activePolicyPresence = activePolicyPaths.map((relative) => fs.existsSync(path.join(root, relative)))
  const hasActivePolicyScript = packageManifest?.scripts?.['renovate:policy'] ===
    'node tools/validate-renovate-effective-policy.mjs'
  if (!activePolicyPresence.every(Boolean) || !hasActivePolicyScript) {
    problems.push('the active five-day policy, reviewed fixture, proof, and exact renovate:policy command must remain complete.')
  }

  const compatibilityTokenNames = targetEntries
    .filter((target) => target !== null && typeof target === 'object' && target.directory !== '.')
    .flatMap((target) => typeof target.repository === 'string' ? [target.repository.split('/')[1]] : [])
  if (compatibilityWorkflow) {
    checkTokenRepositoryScopes(
      compatibilityWorkflow,
      '.github/workflows/renovate-compatibility.yml',
      targetOwner,
      compatibilityTokenNames,
      problems
    )
  }
  if (securityHygieneWorkflow) {
    checkTokenRepositoryScopes(
      securityHygieneWorkflow,
      '.github/workflows/security-hygiene.yml',
      targetOwner,
      targetNames,
      problems
    )
  }
  const hasCompatibilitySchedule = /^\s{2}schedule:\s*$/mu.test(compatibilityWorkflow)
  if (
    (compatibilityTargets?.activation === 'manual-only' && hasCompatibilitySchedule) ||
    (compatibilityTargets?.activation === 'scheduled' && !hasCompatibilitySchedule)
  ) problems.push('compatibility workflow schedule must agree with its explicit activation state.')
  if (
    !/^\s{2}workflow_dispatch:\s*$/mu.test(compatibilityWorkflow) ||
    !compatibilityWorkflow.includes('pnpm renovate:compatibility') ||
    !compatibilityWorkflow.includes('RENOVATE_COMPATIBILITY_REPORT') ||
    !compatibilityWorkflow.includes('repository: jasondockery/roost') ||
    !compatibilityWorkflow.includes('repository: jasondockery/groundwork') ||
    !compatibilityWorkflow.includes('permission-contents: read') ||
    !compatibilityWorkflow.includes('retention-days: 30') ||
    !compatibilityWorkflow.includes('path: renovate-config') ||
    !compatibilityWorkflow.includes('working-directory: renovate-config') ||
    /\bmv\s+(?:roost|groundwork)\b/u.test(compatibilityWorkflow) ||
    !compatibilityWorkflow.includes('RECEIPT_OUTCOME')
  ) {
    problems.push('latest-head compatibility workflow must remain activation-gated, side-by-side, read-only, three-repository, and receipt-backed.')
  }
  try {
    const renderer = read(root, 'tools/render-renovate-compatibility.mjs')
    const coverage = read(root, 'tools/check-renovate-repository-coverage.mjs')
    const audit = read(root, 'tools/renovate-system-audit.mjs')
    const acceptanceSkill = read(root, 'skills/live-renovate-acceptance/SKILL.md')
    if (!renderer.includes('passed compatibility report contains changed source identity')) {
      problems.push('compatibility renderer must reject changed identity in passed receipts.')
    }
    if (!coverage.includes('findSharedPresetReferences') || coverage.includes("renovate-config#1.0.0'")) {
      problems.push('actual-repository extraction must derive ignored shared-preset references from consumer configuration.')
    }
    if (!coverage.includes('assertSharedPresetExtractionNeutral')) {
      problems.push('ignored shared preset must remain guarded as extraction-neutral.')
    }
    if (activePolicyPresence.every(Boolean) && hasActivePolicyScript) {
      const policyProof = read(root, 'tools/check-renovate-effective-policy.mjs')
      if (
        !policyProof.includes('renovate-config-validator') ||
        !policyProof.includes('assertReviewedPolicy') ||
        !policyProof.includes("'--strict'") ||
        !policyProof.includes("'--no-global'")
      ) {
        problems.push('active policy proof must keep strict validation and exact reviewed-policy parity.')
      }
    }
    if (!audit.includes("'--state', 'all'")) {
      problems.push('post-run audit must retain Renovate PR evidence across all PR states.')
    }
    if (
      !acceptanceSkill.includes('pnpm renovate:audit --run <run-id>') ||
      !acceptanceSkill.includes('Never guess a bot login') ||
      !acceptanceSkill.includes('GitHub Actions, Docker images, regex/custom managers')
    ) {
      problems.push('live Renovate acceptance skill must require the canonical audit, bound PR identity, and non-pnpm manager coverage.')
    }
  } catch (error) {
    problems.push(`compatibility and audit policy tools must be readable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!acceptance.includes('Contract status: active') || !acceptance.includes('System acceptance: not achieved')) {
    problems.push('the policy contract must remain active while system acceptance stays unachieved until field proof.')
  }

  if (
    !thesis.includes('eligible dependency update') ||
    !thesis.includes('consumer repository CI passes') ||
    !thesis.includes('Every dependency surface') ||
    !thesis.includes('[`CHARTER.md`](CHARTER.md)') ||
    !thesis.includes('[`specs/renovate-system-acceptance.md`](specs/renovate-system-acceptance.md)')
  ) {
    problems.push('AI_THESIS.md must preserve the real consumer outcome, complete surface ownership, and canonical contract links.')
  }
  if (!agentInstructions.includes('Read `AI_THESIS.md` before planning substantial work.')) {
    problems.push('AGENTS.md must route substantial work through AI_THESIS.md.')
  }
  // Claude Code loads CLAUDE.md, not AGENTS.md. Without the import the adapter
  // is a decorative file and the repository's agent policy silently stops
  // reaching the session -- a routing failure no other check can observe.
  let claudeAdapter = ''
  try {
    claudeAdapter = read(root, 'CLAUDE.md')
  } catch (error) {
    problems.push(`CLAUDE.md must exist as the Claude Code adapter: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (claudeAdapter && !/^@AGENTS\.md$/mu.test(claudeAdapter)) {
    problems.push('CLAUDE.md must import the canonical spine with a bare @AGENTS.md line.')
  }
  if (claudeAdapter.includes('Operating Rules') || claudeAdapter.includes('Execution authority')) {
    problems.push('CLAUDE.md is a thin adapter; policy belongs in AGENTS.md only.')
  }
  if (!agentInstructions.includes('specs/verification.md')) {
    problems.push('AGENTS.md must route verification mechanics to specs/verification.md.')
  }

  for (const required of [
    'AI_THESIS.md',
    'AGENTS.md',
    'CLAUDE.md',
    'specs/verification.md',
    'specs/renovate-system-acceptance.md',
    'playbooks/x-renovate-system-acceptance.md',
    'dependency-coverage.json',
    'compatibility-targets.json',
    '.github/workflows/renovate-compatibility.yml',
    'tools/fixtures/github/renovate-pr-author.json',
    'tools/fixtures/github/renovate-dashboard-problems.json',
    'skills/live-renovate-acceptance/SKILL.md',
    'skills/live-renovate-acceptance/agents/openai.yaml',
  ]) {
    if (!fs.existsSync(path.join(root, required))) problems.push(`missing system contract: ${required}`)
  }

  return problems
}

if (isMainModule(import.meta.url)) {
  const problems = collectRenovateSystemPolicyProblems()
  if (problems.length > 0) {
    for (const problem of problems) console.error(`renovate-system-policy: ${problem}`)
    process.exitCode = 1
  } else {
    console.log('ok: daily runner and branch creation, active five-day preset, compatibility activation, scope, and audit policies agree')
  }
}
