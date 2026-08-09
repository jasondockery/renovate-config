#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main.mjs'
import { findPinnedRenovateRoot, importRenovateModule } from './pinned-renovate-runtime.mjs'
import { readRenovateVersion } from './renovate-runtime.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STABLE_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u

export function collectResolvedPresetProblems({
  version,
  expectedRuntime,
  runtime,
  reference,
  visitedPresets,
  validation,
}) {
  const expectedReference = `github>jasondockery/renovate-config#${version}`
  const problems = []
  if (!STABLE_VERSION.test(version ?? '')) problems.push('release version must be stable SemVer without a v prefix')
  if (runtime !== expectedRuntime) problems.push('active Renovate runtime does not match .renovate-version')
  if (reference !== expectedReference || !visitedPresets?.merged?.includes(expectedReference)) {
    problems.push('Renovate did not report visiting the exact version-pinned preset')
  }
  if (!validation || validation.errors?.length > 0 || validation.warnings?.length > 0) {
    problems.push('resolved version-pinned preset failed strict repository-config validation')
  }
  return problems
}

export async function resolveReleasePreset({
  version,
  root = repositoryRoot,
  environment = process.env,
} = {}) {
  if (!STABLE_VERSION.test(version ?? '')) {
    throw new Error('release version must be stable SemVer without a v prefix')
  }
  const expectedRuntime = readRenovateVersion(root)
  const runtimeRoot = findPinnedRenovateRoot(environment)
  const runtime = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8')).version
  const reference = `github>jasondockery/renovate-config#${version}`
  const [{ resolveConfigPresets }, { validateConfig }] = await Promise.all([
    importRenovateModule(runtimeRoot, 'config/presets/index.js'),
    importRenovateModule(runtimeRoot, 'config/validation.js'),
  ])
  const source = { extends: [reference] }
  const { config, visitedPresets } = await resolveConfigPresets(
    structuredClone(source),
    structuredClone(source)
  )
  const validation = await validateConfig('repo', config, false)
  const problems = collectResolvedPresetProblems({
    expectedRuntime,
    reference,
    runtime,
    validation,
    version,
    visitedPresets,
  })
  return {
    schema: 'renovate-config.resolved-release-preset',
    schemaVersion: 1,
    result: problems.length === 0 ? 'passed' : 'failed',
    reference,
    renovateVersion: runtime,
    visitedPresets,
    problems,
  }
}

export function parseResolveReleasePresetArguments(arguments_) {
  if (arguments_.length === 2 && arguments_[0] === '--version') {
    return { version: arguments_[1] }
  }
  throw new Error('usage: node tools/resolve-release-preset.mjs --version X.Y.Z')
}

if (isMainModule(import.meta.url)) {
  try {
    const receipt = await resolveReleasePreset(
      parseResolveReleasePresetArguments(process.argv.slice(2))
    )
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
    if (receipt.result !== 'passed') process.exitCode = 1
  } catch (error) {
    process.stderr.write(`resolve release preset: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
