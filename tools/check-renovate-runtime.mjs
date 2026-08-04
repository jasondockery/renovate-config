#!/usr/bin/env node
// Keep the self-hosted runtime, validator, updater, and command allowlist wired
// to one reviewable contract instead of trusting duplicated pins to review.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'
import { readRenovateVersion } from './renovate-runtime.mjs'
import { workflowJobSteps } from './workflow-structure.mjs'

const EXPECTED_TEST = 'node --test tools/*.test.mjs'
const EXPECTED_VALIDATE = 'node tools/validate.mjs'
const EXPECTED_VERIFY = 'node tools/verify.mjs'
const EXPECTED_FORMATTER_COMMAND = '^node tools/renovate-format-artifacts\\.mjs$'
const EXPECTED_RUNTIME_MANAGER = {
  customType: 'regex',
  description:
    'Track the one canonical Renovate runtime pin used by the self-hosted runner and every config validator.',
  managerFilePatterns: ['/^\\.renovate-version$/'],
  matchStrings: ['(?<currentValue>\\d+\\.\\d+\\.\\d+)'],
  depNameTemplate: 'renovate',
  datasourceTemplate: 'npm',
  versioningTemplate: 'semver',
}
const EXPECTED_RUNTIME_RESOLVER =
  'echo "version=$(node tools/renovate-runtime.mjs --print-version)" >> "$GITHUB_OUTPUT"'
const EXPECTED_RUNTIME_INPUT = '${{ steps.renovate-runtime.outputs.version }}'
const EXPECTED_RENOVATE_ENV_REGEX =
  '^(?:RENOVATE_\\w+|LOG_(?:LEVEL|FILE|FILE_FORMAT|FILE_LEVEL)|GITHUB_COM_TOKEN|NODE_OPTIONS|NO_COLOR|(?:HTTPS?|NO)_PROXY|(?:https?|no)_proxy)$'
const EXPECTED_CLEAN_CHECK = 'node tools/check-verification-clean.mjs'

function read(repoRoot, relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function json(repoRoot, relativePath, problems) {
  try {
    return JSON.parse(read(repoRoot, relativePath))
  } catch {
    problems.push(`${relativePath} must be readable JSON.`)
    return undefined
  }
}

function repositoryFiles(repoRoot) {
  return execFileSync(
    'git',
    ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' }
  )
    .split('\0')
    .filter(Boolean)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function runtimeFixturePaths(version) {
  return [
    `tools/fixtures/renovate-${version}-structured-log.jsonl`,
    `tools/fixtures/renovate-${version}-structured-log.md`,
  ]
}

function hasExactKeys(value, expected) {
  return isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())
}

function isSourceConfirmedMessageLessUpdateFixture(record) {
  return record !== null &&
    !Array.isArray(record) &&
    typeof record === 'object' &&
    hasExactKeys(record, ['baseBranch', 'level', 'name', 'repository', 'update']) &&
    record.level === 20 &&
    record.name === 'renovate' &&
    typeof record.repository === 'string' && record.repository.length > 0 &&
    typeof record.baseBranch === 'string' && record.baseBranch.length > 0 &&
    record.update !== null &&
    !Array.isArray(record.update) &&
    typeof record.update === 'object' &&
    hasExactKeys(record.update, ['bucket', 'newVersion', 'newValue', 'updateType']) &&
    Object.values(record.update).every((value) => typeof value === 'string' && value.length > 0)
}

function validateRuntimeFixtures(repoRoot, version, problems) {
  const [logPath, provenancePath] = runtimeFixturePaths(version)
  try {
    const lines = read(repoRoot, logPath)
      .split('\n')
      .filter((line) => line.trim() !== '')
    if (lines.length === 0) {
      problems.push(logPath + ' must contain structured-log records.')
    }
    for (const [index, line] of lines.entries()) {
      let record
      try {
        record = JSON.parse(line)
      } catch {
        problems.push(logPath + ' line ' + (index + 1) + ' must be valid JSON.')
        continue
      }
      if (record && !Array.isArray(record) && typeof record === 'object' && !Object.hasOwn(record, 'msg')) {
        if (!isSourceConfirmedMessageLessUpdateFixture(record)) {
          problems.push(
            logPath +
              ' line ' +
              (index + 1) +
              ' message-less update fixture must match the exact source-confirmed shape; provenance belongs in the adjacent Markdown file.'
          )
        }
        continue
      }
      if (
        record === null ||
        Array.isArray(record) ||
        typeof record !== 'object' ||
        record.fixtureRuntime !== version
      ) {
        problems.push(
          logPath +
            ' line ' +
            (index + 1) +
            ' must explicitly declare fixtureRuntime ' +
            version +
            '.'
        )
      }
    }
  } catch {
    problems.push(logPath + ' must preserve pinned-runtime structured-log provenance.')
  }

  try {
    const provenance = read(repoRoot, provenancePath)
    const expectedHeading = '# Renovate ' + version + ' structured-log fixture provenance\n'
    if (!provenance.startsWith(expectedHeading)) {
      problems.push(provenancePath + ' heading must identify Renovate ' + version + '.')
    }
    if (!/immutable commit\n?\x60[0-9a-f]{40}\x60/u.test(provenance)) {
      problems.push(provenancePath + ' must name the immutable source commit.')
    }
    if (!provenance.includes('source-verified')) {
      problems.push(provenancePath + ' must state that runtime shapes were source-verified.')
    }
  } catch {
    problems.push(provenancePath + ' must preserve pinned-runtime structured-log provenance.')
  }
}

function duplicateRuntimeFiles(repoRoot, version, candidateFiles, acceptedRuntimeFiles) {
  const versionToken = new RegExp(`(?<!\\d)${escapeRegExp(version)}(?!\\d)`)
  const duplicates = []
  for (const file of candidateFiles) {
    if (file === '.renovate-version' || acceptedRuntimeFiles.has(file)) continue
    let buffer
    try {
      buffer = fs.readFileSync(path.join(repoRoot, file))
    } catch {
      continue
    }
    if (buffer.includes(0)) continue
    if (versionToken.test(buffer.toString('utf8'))) duplicates.push(file)
  }
  return duplicates
}

export function collectRenovateRuntimeProblems(
  repoRoot = process.cwd(),
  { candidateFiles } = {}
) {
  const problems = []
  let version
  try {
    version = readRenovateVersion(repoRoot)
  } catch (error) {
    problems.push(error.message)
  }

  if (version) {
    try {
      const files = candidateFiles ?? repositoryFiles(repoRoot)
      const acceptedRuntimeFiles = new Set(runtimeFixturePaths(version))
      for (const file of duplicateRuntimeFiles(repoRoot, version, files, acceptedRuntimeFiles)) {
        problems.push(`${file} duplicates the canonical Renovate runtime ${version}.`)
      }
    } catch (error) {
      problems.push(`cannot enumerate repository files for runtime-pin checking: ${error.message}`)
    }
  }

  let ciTestSteps = []
  let ciValidationSteps = []
  let ciIntegrationSteps = []
  let ciSource = ''
  try {
    ciSource = read(repoRoot, '.github/workflows/ci.yml')
    ciTestSteps = workflowJobSteps(ciSource, 'tests')
    ciValidationSteps = workflowJobSteps(ciSource, 'validation')
    ciIntegrationSteps = workflowJobSteps(ciSource, 'renovate_integration')
  } catch {
    problems.push('.github/workflows/ci.yml must be readable.')
  }
  if (ciTestSteps.filter((step) => step.run === 'pnpm test').length !== 1) {
    problems.push('ci.yml tests job must execute pnpm test exactly once.')
  }
  const ciValidate = ciValidationSteps.filter((step) => step.run === 'pnpm validate')
  if (ciValidate.length !== 1 || ciValidate[0].id !== 'validate') {
    problems.push('ci.yml validation job must execute pnpm validate once as validate.')
  }
  const ciIntegration = ciIntegrationSteps.filter((step) => step.run === 'pnpm renovate:integration')
  if (ciIntegration.length !== 1 || ciIntegration[0].id !== 'integration') {
    problems.push('ci.yml integration job must execute pnpm renovate:integration once as integration.')
  }
  const expectedReadOnlyChecks = [
    [ciTestSteps, 'pnpm test'],
    [ciValidationSteps, 'pnpm validate'],
    [ciIntegrationSteps, 'pnpm renovate:integration'],
  ]
  for (const [steps, command] of expectedReadOnlyChecks) {
    const commandIndex = steps.findIndex((step) => step.run === command)
    const check = steps[commandIndex + 1]
    if (
      commandIndex < 0 ||
      check?.id !== 'read_only' ||
      check.run !== EXPECTED_CLEAN_CHECK
    ) {
      problems.push(
        `ci.yml must check repository cleanliness immediately after ${command}.`
      )
    }
  }
  if (
    [...ciTestSteps, ...ciValidationSteps, ...ciIntegrationSteps]
      .filter((step) => step.run === EXPECTED_CLEAN_CHECK).length !== 3
  ) {
    problems.push('ci.yml test, validation, and integration jobs must contain exactly three cleanliness checks.')
  }
  if (!/^permissions:\n  contents: read$/mu.test(ciSource)) {
    problems.push('ci.yml must default the workflow token to contents: read.')
  }
  if (/if-no-files-found:\s*ignore/u.test(ciSource)) {
    problems.push('ci.yml authoritative receipt uploads must fail when the file is missing.')
  }
  if (!ciSource.includes("--reproduce 'pnpm verify && pnpm renovate:integration'") ||
      !ciSource.includes("--reproduce-label 'Local tests/validation equivalent'")) {
    problems.push('ci.yml must identify the separate offline and pinned-integration local equivalents, not the CI security proof.')
  }
  if (!ciSource.includes('RENOVATE_VALIDATION_TIMING_OUTPUT') || !ciSource.includes('validation-timing-summary.mjs')) {
    problems.push('ci.yml must publish bounded internal validation phase timings.')
  }
  if (/repository:\s*jasondockery\/(?:roost|groundwork)/u.test(ciSource) || /Mint read-only consumer token/u.test(ciSource)) {
    problems.push('required ci.yml must not bind renovate-config proof to mutable consumer default branches.')
  }
  try {
    const integrationSource = read(repoRoot, 'tools/validate-renovate-integration.mjs')
    const innerSource = read(repoRoot, 'tools/run-renovate-integration.mjs')
    if ((integrationSource.match(/spawnSync\(\s*['"]npx['"]/gu) ?? []).length !== 1) {
      problems.push('Renovate integration must acquire the exact runtime once.')
    }
    if (!integrationSource.includes('tools/run-renovate-integration.mjs') || /\bnpx\b/u.test(innerSource)) {
      problems.push('Renovate integration phases must share the one provisioned runtime environment.')
    }
  } catch {
    problems.push('single-acquisition Renovate integration tools must be readable.')
  }

  let runnerSteps = []
  let runnerSource = ''
  try {
    runnerSource = read(repoRoot, '.github/workflows/renovate.yml')
    runnerSteps = workflowJobSteps(runnerSource, 'renovate')
  } catch {
    problems.push('.github/workflows/renovate.yml must be readable.')
  }
  const resolvers = runnerSteps.filter((step) => step.id === 'renovate-runtime')
  if (resolvers.length !== 1 || resolvers[0].run !== EXPECTED_RUNTIME_RESOLVER) {
    problems.push('renovate.yml must resolve the runtime from .renovate-version.')
  }
  const renovateActions = runnerSteps.filter((step) =>
    /^renovatebot\/github-action@[0-9a-f]{40}$/.test(step.uses ?? '')
  )
  if (
    renovateActions.length !== 1 ||
    renovateActions[0].with['renovate-version'] !== EXPECTED_RUNTIME_INPUT ||
    renovateActions[0].with['env-regex'] !== EXPECTED_RENOVATE_ENV_REGEX
  ) {
    problems.push(
      'renovate.yml must pass the canonical version and exact structured-log environment allowlist to the runner action.'
    )
  }
  if (!/^permissions:\n  contents: read$/mu.test(runnerSource)) {
    problems.push('renovate.yml must default the workflow token to contents: read.')
  }
  if (/if-no-files-found:\s*ignore/u.test(runnerSource)) {
    problems.push('renovate.yml authoritative receipt upload must fail when the file is missing.')
  }

  let verifySource = ''
  try {
    verifySource = read(repoRoot, 'tools/verify.mjs')
  } catch {
    problems.push('tools/verify.mjs must be readable.')
  }
  for (const [contract, pattern] of [
    ['a 300-second total deadline', /HARD_DEADLINE_MILLISECONDS\s*=\s*300_000/u],
    ['bounded fingerprint Git commands', /timeout:\s*15_000/u],
    ['an external whole-transaction watchdog', /runVerificationWatchdog[\s\S]*--verification-core/u],
    ['explicit verification-relevant ignored-state fingerprinting', /VERIFICATION_RELEVANT_IGNORED_PATHS/u],
    ['bounded Git-visible fingerprint input', /GIT_VISIBLE_CONTENT_BYTE_LIMIT/u],
    ['chunked file hashing', /HASH_CHUNK_BYTES/u],
    ['a launch-window cancellation guard', /controller\.signal\.aborted/u],
    ['a persistent lane supervisor', /processSupervisor/u],
    ['bounded unterminated output buffering', /MAX_PENDING_OUTPUT_BYTES/u],
    ['bounded process-group escalation', /SIGTERM[\s\S]*SIGKILL/u],
  ]) {
    if (!pattern.test(verifySource)) problems.push(`tools/verify.mjs must preserve ${contract}.`)
  }
  if (version) validateRuntimeFixtures(repoRoot, version, problems)
  for (const fixture of version ? runtimeFixturePaths(version) : []) {
    try {
      read(repoRoot, fixture)
    } catch {
      problems.push(`${fixture} must preserve pinned-runtime structured-log provenance.`)
    }
  }
  if (/collectVerificationCleanProblems/u.test(verifySource)) {
    problems.push('tools/verify.mjs must not require a clean implementation tree.')
  }

  let supervisorSource = ''
  try {
    supervisorSource = read(repoRoot, 'tools/process-supervisor.mjs')
  } catch {
    problems.push('tools/process-supervisor.mjs must be readable.')
  }
  if (!/command-status/u.test(supervisorSource) || !/releaseRequested/u.test(supervisorSource)) {
    problems.push('the verification lane supervisor must remain alive until explicit release.')
  }
  if (!/process\.kill\(-process\.pid,\s*'SIGKILL'\)/u.test(supervisorSource)) {
    problems.push('the verification lane supervisor must kill its complete owned group when its outer owner disconnects.')
  }

  let renovateReceiptSource = ''
  try {
    renovateReceiptSource = read(repoRoot, 'tools/renovate-run-receipt.mjs')
  } catch {
    problems.push('tools/renovate-run-receipt.mjs must be readable.')
  }
  for (const [contract, pattern] of [
    ['bounded structured-log bytes', /DEFAULT_LOG_BYTE_LIMIT/u],
    ['bounded structured-log lines', /DEFAULT_LOG_LINE_LIMIT/u],
    ['bounded structured-log line length', /DEFAULT_LOG_LINE_BYTE_LIMIT/u],
    ['streamed structured-log parsing', /parseRenovateLogFile/u],
    ['advisory unexpected informational evidence', /unexpectedRepositoryInformational/u],
  ]) {
    if (!pattern.test(renovateReceiptSource)) {
      problems.push(`tools/renovate-run-receipt.mjs must preserve ${contract}.`)
    }
  }

  const manifest = json(repoRoot, 'package.json', problems)
  if (manifest?.scripts?.test !== EXPECTED_TEST) {
    problems.push('package.json test must execute every tools/*.test.mjs file.')
  }
  if (manifest?.scripts?.validate !== EXPECTED_VALIDATE) {
    problems.push('package.json validate must own every deterministic validation entry point.')
  }
  if (manifest?.scripts?.verify !== EXPECTED_VERIFY) {
    problems.push('package.json verify must own the concurrent final-tree proof.')
  }

  const renovate = json(repoRoot, 'renovate.json', problems)
  const runtimeManagers = (renovate?.customManagers ?? []).filter(
    (manager) => manager.depNameTemplate === 'renovate'
  )
  if (
    runtimeManagers.length !== 1 ||
    !isDeepStrictEqual(runtimeManagers[0], EXPECTED_RUNTIME_MANAGER)
  ) {
    problems.push('renovate.json must contain the exact canonical runtime custom manager.')
  } else if (version) {
    const match = new RegExp(runtimeManagers[0].matchStrings[0]).exec(version)
    if (match?.groups?.currentValue !== version) {
      problems.push('renovate.json runtime custom manager must extract .renovate-version.')
    }
  }

  const runner = json(repoRoot, 'runner.json', problems)
  if (
    JSON.stringify(runner?.allowedCommands) !== JSON.stringify([EXPECTED_FORMATTER_COMMAND])
  ) {
    problems.push(
      `runner.json allowedCommands must contain only ${EXPECTED_FORMATTER_COMMAND}.`
    )
  }
  if (runner?.allowShellExecutorForPostUpgradeCommands !== false) {
    problems.push('runner.json must explicitly disable the post-upgrade command shell.')
  }
  for (const file of ['config.js', 'config.cjs', 'config.mjs']) {
    if (fs.existsSync(path.join(repoRoot, file))) {
      problems.push(`${file} must not supply ambient global Renovate configuration.`)
    }
  }

  return problems
}

export function checkRenovateRuntime(repoRoot = process.cwd()) {
  const problems = collectRenovateRuntimeProblems(repoRoot)
  if (problems.length === 0) {
    console.log('ok: Renovate runtime and formatter command contracts are exact')
    return true
  }
  console.error('Renovate runtime contract check failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  return false
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url) && !checkRenovateRuntime()) {
  process.exitCode = 1
}
