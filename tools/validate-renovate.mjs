#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { findPinnedRenovateRoot } from './pinned-renovate-runtime.mjs'
import { readRenovateVersion } from './renovate-runtime.mjs'

export const RENOVATE_CONFIGS = [
  { file: 'default.json', global: false },
  { file: 'renovate.json', global: false },
  { file: 'runner.json', global: true },
]

export function validatorArguments({ file, global }) {
  return [
    '--strict',
    ...(global ? [] : ['--no-global']),
    file,
  ]
}

export function validatorEnvironment(source = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => !name.startsWith('RENOVATE_'))
  )
}

export function validateRenovate({
  repoRoot = process.cwd(),
  run = spawnSync,
  configs = RENOVATE_CONFIGS,
  environment = process.env,
  output = console,
  findRuntime = findPinnedRenovateRoot,
} = {}) {
  const version = readRenovateVersion(repoRoot)
  const runtimeManifest = JSON.parse(fs.readFileSync(path.join(findRuntime(environment), 'package.json'), 'utf8'))
  if (runtimeManifest.version !== version) throw new Error('PATH Renovate does not match .renovate-version')
  const failures = []

  for (const config of configs) {
    const configKind = config.global ? 'self-hosted global config' : 'repository/preset config'
    output.log(
      `\nValidating ${config.file} as ${configKind} with Renovate ${version}`
    )
    const result = run('renovate-config-validator', validatorArguments(config), {
      cwd: repoRoot,
      stdio: 'inherit',
      env: validatorEnvironment(environment),
    })
    if (result.error) {
      output.error(`could not run Renovate validator for ${config.file}: ${result.error.message}`)
      failures.push(config.file)
    } else if (result.status !== 0) {
      failures.push(config.file)
    }
  }

  if (failures.length > 0) {
    for (const file of failures) {
      output.error(
        `::error title=Renovate config invalid: ${file}::` +
          `validation failed with Renovate ${version}; run pnpm validate locally`
      )
    }
    return { ok: false, version, failures }
  }

  output.log(`\nok: ${configs.length} Renovate configs validated with Renovate ${version}`)
  return { ok: true, version, failures: [] }
}

export function reportOutputs(
  { version, failures },
  { outputPath = process.env.GITHUB_OUTPUT, warn = (message) => console.error(message) } = {}
) {
  if (!outputPath) return false
  try {
    fs.appendFileSync(
      outputPath,
      `version=${version}\nfailed=${failures.join(',') || 'none'}\n`
    )
    return true
  } catch (error) {
    warn(`::warning title=Validation summary unavailable::${error.message}`)
    return false
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = validateRenovate()
    reportOutputs(result)
    if (!result.ok) process.exitCode = 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
