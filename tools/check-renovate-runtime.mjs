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
const EXPECTED_VALIDATE = [
  'node tools/check-toolchain.mjs',
  'node tools/check-preset-freeze.mjs',
  'node tools/check-workflow-timeouts.mjs',
  'node tools/check-renovate-runtime.mjs',
  'node tools/validate-renovate.mjs',
].join(' && ')
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

function duplicateRuntimeFiles(repoRoot, version, candidateFiles) {
  const versionToken = new RegExp(`(?<!\\d)${escapeRegExp(version)}(?!\\d)`)
  const duplicates = []
  for (const file of candidateFiles) {
    if (file === '.renovate-version') continue
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
      for (const file of duplicateRuntimeFiles(repoRoot, version, files)) {
        problems.push(`${file} duplicates the canonical Renovate runtime ${version}.`)
      }
    } catch (error) {
      problems.push(`cannot enumerate repository files for runtime-pin checking: ${error.message}`)
    }
  }

  let ciSteps = []
  try {
    ciSteps = workflowJobSteps(read(repoRoot, '.github/workflows/ci.yml'), 'validate')
  } catch {
    problems.push('.github/workflows/ci.yml must be readable.')
  }
  if (ciSteps.filter((step) => step.run === 'pnpm test').length !== 1) {
    problems.push('ci.yml validate job must execute pnpm test exactly once.')
  }
  const ciValidate = ciSteps.filter((step) => step.run === 'pnpm validate')
  if (ciValidate.length !== 1 || ciValidate[0].id !== 'validate-config') {
    problems.push('ci.yml validate job must execute pnpm validate once as validate-config.')
  }
  const expectedReadOnlyChecks = [
    ['pnpm test', 'test-read-only'],
    ['pnpm validate', 'validate-read-only'],
  ]
  for (const [command, checkId] of expectedReadOnlyChecks) {
    const commandIndex = ciSteps.findIndex((step) => step.run === command)
    const check = ciSteps[commandIndex + 1]
    if (
      commandIndex < 0 ||
      check?.id !== checkId ||
      check.run !== EXPECTED_CLEAN_CHECK
    ) {
      problems.push(
        `ci.yml validate job must check repository cleanliness immediately after ${command}.`
      )
    }
  }
  if (ciSteps.filter((step) => step.run === EXPECTED_CLEAN_CHECK).length !== 2) {
    problems.push('ci.yml validate job must contain exactly two verification cleanliness checks.')
  }

  let runnerSteps = []
  try {
    runnerSteps = workflowJobSteps(read(repoRoot, '.github/workflows/renovate.yml'), 'renovate')
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
    renovateActions[0].with['renovate-version'] !== EXPECTED_RUNTIME_INPUT
  ) {
    problems.push('renovate.yml must pass the resolved canonical version to the runner action.')
  }

  const manifest = json(repoRoot, 'package.json', problems)
  if (manifest?.scripts?.test !== EXPECTED_TEST) {
    problems.push('package.json test must execute every tools/*.test.mjs file.')
  }
  if (manifest?.scripts?.validate !== EXPECTED_VALIDATE) {
    problems.push('package.json validate must own every deterministic validation entry point.')
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
