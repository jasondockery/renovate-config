#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_CRON = '17 1 * * *'
const EXPECTED_REPOSITORIES = 'jasondockery/renovate-config,jasondockery/roost,jasondockery/groundwork'

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

export function collectRenovateSystemPolicyProblems(root = repositoryRoot) {
  const problems = []
  const preset = readJson(root, 'default.json', problems)
  const packageManifest = readJson(root, 'package.json', problems)
  let workflow = ''
  let compatibilityWorkflow = ''
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
    acceptance = read(root, 'specs/renovate-system-acceptance.md')
  } catch (error) {
    problems.push(`compatibility workflow and acceptance spec must be readable: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    thesis = read(root, 'AI_THESIS.md')
    agentInstructions = read(root, 'AGENTS.md')
  } catch (error) {
    problems.push(`AI thesis and agent instructions must be readable: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (preset) {
    const extensions = Array.isArray(preset.extends) ? preset.extends : []
    if (!extensions.includes('config:best-practices') || !extensions.includes('schedule:weekly')) {
      problems.push('default.json must preserve config:best-practices plus the weekly routine update/branch schedule.')
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
      security.automerge !== true || security.platformAutomerge !== true
    ) {
      problems.push('the active preset must preserve the reviewed vulnerability-alert schedule, age, rate-limit, and automerge bypass.')
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
    const repositories = /^\s+RENOVATE_REPOSITORIES:\s*(\S+)\s*$/mu.exec(workflow)?.[1]
    if (repositories !== EXPECTED_REPOSITORIES) {
      problems.push('Renovate must target exactly the three chartered consumer repositories.')
    }
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

  const compatibilityTargets = readJson(root, 'compatibility-targets.json', problems)
  const expectedCompatibilityTargets = [
    ['jasondockery/renovate-config', '.'],
    ['jasondockery/roost', '../roost'],
    ['jasondockery/groundwork', '../groundwork'],
  ]
  if (
    compatibilityTargets?.schemaVersion !== 1 ||
    !['manual-only', 'scheduled'].includes(compatibilityTargets?.activation) ||
    JSON.stringify((compatibilityTargets?.targets ?? []).map(({ repository, directory }) => [repository, directory])) !==
      JSON.stringify(expectedCompatibilityTargets)
  ) {
    problems.push('compatibility-targets.json must name the exact three checkout directories.')
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

  for (const required of [
    'AI_THESIS.md',
    'AGENTS.md',
    'specs/renovate-system-acceptance.md',
    'playbooks/x-renovate-system-acceptance.md',
    'dependency-coverage.json',
    'compatibility-targets.json',
    '.github/workflows/renovate-compatibility.yml',
    'tools/fixtures/github/renovate-pr-author.json',
    'tools/fixtures/github/renovate-dashboard-problems.json',
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
    console.log('ok: daily runner, active five-day preset, compatibility activation, scope, and audit policies agree')
  }
}
