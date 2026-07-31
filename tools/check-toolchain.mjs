#!/usr/bin/env node
// Dependency-free toolchain contract. The repository owns exact versions;
// version managers are interchangeable ways to satisfy them.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { isMainModule } from './is-main.mjs'

const EXACT_VERSION = /^\d+\.\d+\.\d+$/
export const PROBE_TIMEOUT_MS = 10_000

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

  const workspace = read(repoRoot, 'pnpm-workspace.yaml')
  if (!/^verifyDepsBeforeRun:\s*false\s*$/m.test(workspace ?? '')) {
    problems.push(
      'pnpm-workspace.yaml must disable verifyDepsBeforeRun so verification ' +
        'scripts do not run an implicit install.'
    )
  }
  if (!/^enableModulesDir:\s*false\s*$/m.test(workspace ?? '')) {
    problems.push(
      'pnpm-workspace.yaml must disable enableModulesDir so dependency-free ' +
        'verification does not write node_modules metadata.'
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
      (nodeVersionFiles.length === 0 ||
        nodeVersionFiles.some(
          (value) => !/^(?:[A-Za-z0-9._-]+\/)*\.node-version$/.test(value)
        ))
    ) {
      problems.push(
        `${path.relative(repoRoot, file)} must configure actions/setup-node from the repository .node-version.`
      )
    }
  }

  return problems
}

// How to launch a probe on this platform, as a pure decision so the Windows
// branch is unit-testable without a Windows runner. On win32 pnpm is usually a
// .cmd shim, which spawnSync cannot execute directly — it must go through the
// command interpreter. The command line is built from fixed internal constants
// (never user input), which keeps that shell boundary narrow. No Windows CI
// lane exists in this repo, so the win32 branch is fixture-proven only.
export function probeInvocation(command, args, platform = process.platform) {
  if (platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe'
    return { file: comspec, args: ['/d', '/s', '/c', [command, ...args].join(' ')] }
  }
  return { file: command, args: [...args] }
}

function defaultRunProbe(command, args, { cwd, env = process.env } = {}) {
  const invocation = probeInvocation(command, args)
  const result = spawnSync(invocation.file, invocation.args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  })
  // A failed spawn commonly leaves stderr as '' (not null), so ?? alone would
  // hide result.error — the one message that explains ENOENT and friends.
  const stderr = String(result.stderr ?? '').trim() || String(result.error?.message ?? '').trim()
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout ?? '').trim(),
    stderr,
    signal: result.signal ?? undefined,
    errorCode: result.error?.code,
    timedOut: result.error?.code === 'ETIMEDOUT',
  }
}

export function classifyProbe(probe, expectedVersion, { stripLeadingV = false } = {}) {
  if (probe.timedOut || probe.errorCode === 'ETIMEDOUT') {
    return { kind: 'timeout' }
  }
  if (probe.errorCode === 'ENOENT') {
    return { kind: 'missing' }
  }
  if (probe.signal) {
    return { kind: 'signal', signal: probe.signal }
  }
  if (probe.status !== 0) {
    return {
      kind: 'nonzero',
      status: probe.status,
      stderr: probe.stderr || 'no error output',
    }
  }
  const actual = stripLeadingV ? probe.stdout.replace(/^v/, '') : probe.stdout
  if (expectedVersion && actual !== expectedVersion) {
    return { kind: 'versionMismatch', actual, expected: expectedVersion }
  }
  return null
}

function probeFailure(command, problem, probe, expectedVersion) {
  if (problem.kind === 'timeout') {
    return `bare \`${command}\` probe timed out after ${PROBE_TIMEOUT_MS / 1000} seconds.`
  }
  if (problem.kind === 'missing') {
    return command === 'pnpm'
      ? 'bare `pnpm` is not available; enable Corepack or install the pinned pnpm.'
      : 'bare `node` is not available; install or select the pinned Node version.'
  }
  if (problem.kind === 'signal') {
    return `bare \`${command}\` probe was terminated by signal ${problem.signal}.`
  }
  if (
    command === 'pnpm' &&
    problem.kind === 'nonzero' &&
    /network access disabled|corepack.*(?:network|download|not cached)|(?:network|download).*corepack/i.test(
      probe.stderr ?? ''
    )
  ) {
    return (
      `pnpm ${expectedVersion ?? 'from packageManager'} is not cached or installed, and ` +
      'the read-only probe intentionally disables Corepack networking; prepare the pinned pnpm, then retry.'
    )
  }
  if (problem.kind === 'nonzero') {
    return `bare \`${command}\` probe exited with status ${problem.status} (${problem.stderr}); nested scripts cannot run it.`
  }
  return `bare \`${command}\` resolves ${problem.actual} for child processes; nested scripts would use it instead of ${command === 'node' ? '.node-version' : 'packageManager'} (${problem.expected}).`
}

// The static checks above prove declarations agree, and the running-process
// checks prove the interpreter THIS check happens to run under. Neither proves
// what a nested process resolves: a package script re-resolves bare `node`
// and `pnpm` from PATH, and a shadowing global install can answer there while
// every static file and the invoking process look correct (field-observed as
// pnpm launcher drift). These probes prove that a freshly spawned child,
// launched from the repository root, resolves the pinned versions — an
// approximation of nested-script resolution, not a run of every environment
// transformation pnpm performs. Probes run with cwd=repoRoot because
// Corepack's pnpm selection is directory-sensitive. Runtime-neutral by
// design: any manager may satisfy the outcome; only the outcome is enforced.
export function collectRuntimeParityProblems({
  repoRoot = process.cwd(),
  runProbe = defaultRunProbe,
} = {}) {
  const problems = []
  const expectedNode = read(repoRoot, '.node-version')

  let manifest
  try {
    manifest = JSON.parse(read(repoRoot, 'package.json') ?? '')
  } catch {
    // collectToolchainProblems already reports the unreadable manifest.
  }
  // Corepack pins may carry an integrity suffix (pnpm@11.9.0+sha512.…);
  // the semantic version is the comparison target.
  const expectedPnpm = /^pnpm@(\d+\.\d+\.\d+)(?:\+.+)?$/.exec(manifest?.packageManager ?? '')?.[1]
  const probeEnvironment = {
    ...process.env,
    COREPACK_ENABLE_NETWORK: '0',
  }

  const spawnedNode = runProbe('node', ['--version'], {
    cwd: repoRoot,
    env: probeEnvironment,
  })
  const nodeProblem = classifyProbe(spawnedNode, expectedNode, { stripLeadingV: true })
  if (nodeProblem) {
    problems.push(probeFailure('node', nodeProblem, spawnedNode, expectedNode))
  }

  const spawnedPnpm = runProbe('pnpm', ['--version'], {
    cwd: repoRoot,
    env: probeEnvironment,
  })
  const pnpmProblem = classifyProbe(spawnedPnpm, expectedPnpm)
  if (pnpmProblem) {
    problems.push(probeFailure('pnpm', pnpmProblem, spawnedPnpm, expectedPnpm))
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
  const problems = [
    ...collectToolchainProblems(options),
    ...collectRuntimeParityProblems(options),
  ]
  if (problems.length === 0) return
  console.error(formatToolchainFailure(problems, options?.repoRoot))
  process.exitCode = 1
}

if (isMainModule(import.meta.url)) assertToolchain()
