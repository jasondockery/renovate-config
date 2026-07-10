#!/usr/bin/env node
// Dependency-free toolchain contract. The repository owns exact versions;
// version managers are interchangeable ways to satisfy them.
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const EXACT_VERSION = /^\d+\.\d+\.\d+$/

function read(root, relativePath) {
  try {
    return fs.readFileSync(path.join(root, relativePath), 'utf8').trim()
  } catch {
    return undefined
  }
}

function tomlToolVersion(text, tool) {
  if (!text) return undefined
  let inTools = false
  for (const line of text.split('\n')) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (section) {
      inTools = section[1] === 'tools'
      continue
    }
    if (!inTools) continue
    const match = new RegExp(`^\\s*${tool}\\s*=\\s*["']([^"']+)["']`).exec(line)
    if (match) return match[1]
  }
  return undefined
}

function workflowFiles(root) {
  const workflows = path.join(root, '.github', 'workflows')
  if (!fs.existsSync(workflows)) return []
  return fs
    .readdirSync(workflows)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => path.join(workflows, file))
}

export function collectToolchainProblems({
  repoRoot = process.cwd(),
  nodeVersion = process.version,
  userAgent = process.env.npm_config_user_agent ?? '',
} = {}) {
  const problems = []
  const expectedNode = read(repoRoot, '.node-version')

  if (!expectedNode || !EXACT_VERSION.test(expectedNode)) {
    problems.push('.node-version must contain one exact Node version such as 24.18.0.')
    return problems
  }

  const nvmrc = read(repoRoot, '.nvmrc')
  if (nvmrc !== expectedNode) {
    problems.push(`.nvmrc (${nvmrc ?? 'missing'}) must match .node-version (${expectedNode}).`)
  }

  let manifest
  try {
    manifest = JSON.parse(read(repoRoot, 'package.json') ?? '')
  } catch {
    problems.push('package.json must be readable JSON.')
  }

  const packageManager = manifest?.packageManager ?? ''
  const managerPin = /^pnpm@(\d+\.\d+\.\d+)(?:\+.+)?$/.exec(packageManager)
  const expectedPnpm = managerPin?.[1]
  if (!expectedPnpm) problems.push('packageManager must pin an exact pnpm version.')
  if (manifest?.engines?.node !== expectedNode) {
    problems.push(
      `package.json engines.node (${manifest?.engines?.node ?? 'missing'}) must match .node-version (${expectedNode}).`
    )
  }
  if (expectedPnpm && manifest?.engines?.pnpm !== expectedPnpm) {
    problems.push(
      `package.json engines.pnpm (${manifest?.engines?.pnpm ?? 'missing'}) must match packageManager (${expectedPnpm}).`
    )
  }

  const mise = read(repoRoot, 'mise.toml')
  const miseNode = tomlToolVersion(mise, 'node')
  const misePnpm = tomlToolVersion(mise, 'pnpm')
  if (miseNode !== expectedNode) {
    problems.push(`mise.toml node (${miseNode ?? 'missing'}) must match .node-version (${expectedNode}).`)
  }
  if (expectedPnpm && misePnpm !== expectedPnpm) {
    problems.push(
      `mise.toml pnpm (${misePnpm ?? 'missing'}) must match packageManager (${expectedPnpm}).`
    )
  }

  const actualNode = nodeVersion.replace(/^v/, '')
  if (actualNode !== expectedNode) {
    problems.push(`running Node ${actualNode} must match .node-version (${expectedNode}).`)
  }

  if (userAgent) {
    const runningPnpm = /pnpm\/(\d+\.\d+\.\d+)/.exec(userAgent)?.[1]
    if (!runningPnpm) {
      problems.push(`this repository uses pnpm, not ${userAgent.split(' ')[0]}.`)
    } else if (expectedPnpm && runningPnpm !== expectedPnpm) {
      problems.push(`running pnpm ${runningPnpm} must match packageManager (${expectedPnpm}).`)
    }
  }

  for (const file of workflowFiles(repoRoot)) {
    const text = fs.readFileSync(file, 'utf8')
    const nodeVersionFiles = [...text.matchAll(/node-version-file:\s*([^\s#]+)/g)].map(
      (match) => match[1]
    )
    if (
      text.includes('actions/setup-node@') &&
      (nodeVersionFiles.length === 0 || nodeVersionFiles.some((value) => value !== '.node-version'))
    ) {
      problems.push(
        `${path.relative(repoRoot, file)} must configure actions/setup-node from .node-version.`
      )
    }
  }

  return problems
}

export function formatToolchainFailure(problems, repoRoot = process.cwd()) {
  const expectedNode = read(repoRoot, '.node-version') ?? '<version>'
  return [
    'toolchain check failed:',
    ...problems.map((problem) => `  - ${problem}`),
    '',
    `Install or select Node ${expectedNode} with any manager, then retry:`,
    '  nvm install && nvm use',
    '  fnm use --install-if-missing',
    '  mise install',
    `  volta install node@${expectedNode}`,
  ].join('\n')
}

export function assertToolchain(options) {
  const problems = collectToolchainProblems(options)
  if (problems.length === 0) return
  console.error(formatToolchainFailure(problems, options?.repoRoot))
  process.exitCode = 1
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) assertToolchain()
