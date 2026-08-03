#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { findPinnedRenovateRoot } from './pinned-renovate-runtime.mjs'
import { readRenovateVersion } from './renovate-runtime.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = path.join(repositoryRoot, 'tools/fixtures/dependency-extraction')
const EXPECTED = Object.freeze([
  { manager: 'npm', depName: 'is-number' },
  { manager: 'dockerfile', depName: 'ubuntu' },
  { manager: 'docker-compose', depName: 'postgres' },
  { manager: 'github-actions', depName: 'actions/checkout' },
  { manager: 'github-actions', depName: 'ghcr.io/gitleaks/gitleaks' },
  { manager: 'github-actions', depName: 'ubuntu' },
  { manager: 'nodenv', depName: 'node' },
  { manager: 'nvm', depName: 'node' },
  { manager: 'mise', depName: 'node' },
  { manager: 'mise', depName: 'pnpm' },
  { manager: 'renovate-config', depName: 'jasondockery/renovate-config' },
  { manager: 'custom.regex', depName: 'renovate' },
  { manager: 'custom.regex', depName: '@opennextjs/aws' },
])
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

export function extractionArguments() {
  return [
    '--platform=local',
    '--dry-run=extract',
    '--require-config=required',
  ]
}

export function extractionEnvironment(source, tempRoot) {
  const environment = Object.fromEntries(
    Object.entries(source).filter(([name]) => !name.startsWith('RENOVATE_') && !name.startsWith('LOG_'))
  )
  return {
    ...environment,
    LOG_FORMAT: 'json',
    LOG_LEVEL: 'debug',
    NO_COLOR: '1',
    RENOVATE_BASE_DIR: path.join(tempRoot, 'base'),
    RENOVATE_CACHE_DIR: path.join(tempRoot, 'cache'),
  }
}

function visitPackageFiles(value, found) {
  if (Array.isArray(value)) {
    for (const entry of value) visitPackageFiles(entry, found)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (value.packageFiles && typeof value.packageFiles === 'object' && !Array.isArray(value.packageFiles)) {
    for (const [rawManager, files] of Object.entries(value.packageFiles)) {
      const manager = rawManager === 'regex' ? 'custom.regex' : rawManager
      for (const packageFile of Array.isArray(files) ? files : []) {
        const relative = typeof packageFile.packageFile === 'string' ? packageFile.packageFile : ''
        for (const dependency of Array.isArray(packageFile.deps) ? packageFile.deps : []) {
          const depName = typeof dependency.depName === 'string' ? dependency.depName : dependency.packageName
          if (typeof depName !== 'string') continue
          const currentValue = typeof dependency.currentValue === 'string' ? dependency.currentValue : ''
          const currentDigest = typeof dependency.currentDigest === 'string' ? dependency.currentDigest : ''
          found.set(`${manager}\0${relative}\0${depName}\0${currentValue}\0${currentDigest}`, {
            manager,
            packageFile: relative,
            depName,
            currentValue,
            currentDigest,
          })
        }
      }
    }
  }
  for (const child of Object.values(value)) visitPackageFiles(child, found)
}

export function parseExtractedDependencies(output) {
  const found = new Map()
  for (const line of output.split(/\r?\n/u)) {
    if (!line.startsWith('{')) continue
    try {
      const record = JSON.parse(line)
      if (record.msg === 'Extracted dependencies') visitPackageFiles(record, found)
    } catch {
      // npx and Renovate can emit non-JSON diagnostic lines around structured logs.
    }
  }
  return [...found.values()].sort((left, right) =>
    `${left.manager}\0${left.packageFile}\0${left.depName}\0${left.currentValue}\0${left.currentDigest}`.localeCompare(
      `${right.manager}\0${right.packageFile}\0${right.depName}\0${right.currentValue}\0${right.currentDigest}`
    )
  )
}

function copyFixture(targetRoot, repoRoot) {
  const copies = [
    ['package.json.fixture', 'package.json'],
    ['Dockerfile.fixture', 'Dockerfile'],
    ['compose.yaml.fixture', 'compose.yaml'],
    ['workflow.yml.fixture', '.github/workflows/fixture.yml'],
    ['renovate.json.fixture', 'renovate.json'],
    ['.node-version.fixture', '.node-version'],
    ['.nvmrc.fixture', '.nvmrc'],
    ['mise.toml.fixture', 'mise.toml'],
    ['opennext.ts.fixture', 'packages/aws/src/opennext.ts'],
  ]
  for (const [source, destination] of copies) {
    const target = path.join(targetRoot, destination)
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.copyFileSync(path.join(fixtureRoot, source), target)
  }
  fs.copyFileSync(path.join(repoRoot, '.renovate-version'), path.join(targetRoot, '.renovate-version'))
}

export function checkExtraction({
  repoRoot = repositoryRoot,
  run = spawnSync,
  environment = process.env,
  output = console,
} = {}) {
  const version = readRenovateVersion(repoRoot)
  const runtimeManifest = JSON.parse(fs.readFileSync(path.join(findPinnedRenovateRoot(environment), 'package.json'), 'utf8'))
  if (runtimeManifest.version !== version) throw new Error('PATH Renovate does not match .renovate-version')
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-extraction-'))
  fs.chmodSync(tempRoot, 0o700)
  try {
    copyFixture(tempRoot, repoRoot)
    const result = run('renovate', extractionArguments(), {
      cwd: tempRoot,
      encoding: 'utf8',
      env: extractionEnvironment(environment, tempRoot),
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: 120_000,
    })
    if (result.error) throw new Error(`could not run pinned Renovate extraction: ${result.error.message}`)
    if (result.status !== 0) {
      throw new Error(`pinned Renovate extraction exited ${String(result.status)}: ${(result.stderr || result.stdout || '').trim()}`)
    }

    const found = parseExtractedDependencies(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    const pairs = new Set(found.map(({ manager, depName }) => `${manager}\0${depName}`))
    const missing = EXPECTED.filter(({ manager, depName }) => !pairs.has(`${manager}\0${depName}`))
    if (missing.length > 0) {
      throw new Error(
        `pinned Renovate extraction missed: ${missing.map(({ manager, depName }) => `${manager}:${depName}`).join(', ')}`
      )
    }
    output.log(`ok: Renovate ${version} extracted ${EXPECTED.length} required manager/dependency pairs`)
    return { ok: true, version, found }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    checkExtraction()
  } catch (error) {
    console.error(`dependency extraction contract failed: ${error.message}`)
    process.exitCode = 1
  }
}
