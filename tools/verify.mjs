#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const processSupervisor = fileURLToPath(new URL('./process-supervisor.mjs', import.meta.url))
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }
const FORBIDDEN_ARTIFACTS = ['pnpm-lock.yaml', 'node_modules', '.pnpm-store']
const VERIFICATION_RELEVANT_IGNORED_PATHS = [
  'hygiene-state.json',
  'security-hygiene-issue.md',
  'security-hygiene-report.md',
  'security-hygiene-summary.md',
]
const GIT_IDENTITY_SCOPE = 'HEAD, Git index, and Git-visible working-tree content'
const IGNORED_STATE_SCOPE = 'named generated security-hygiene outputs only'
const PATH_LIMIT = 20_000
const GIT_VISIBLE_CONTENT_BYTE_LIMIT = 512 * 1024 * 1024
const IGNORED_CONTENT_BYTE_LIMIT = 32 * 1024 * 1024
const GIT_OUTPUT_BYTE_LIMIT = 32 * 1024 * 1024
const HASH_CHUNK_BYTES = 1024 * 1024
const PERFORMANCE_BUDGET_MILLISECONDS = 240_000
const HARD_DEADLINE_MILLISECONDS = 300_000
const CANCEL_GRACE_MILLISECONDS = 2_000
const MAX_PENDING_OUTPUT_BYTES = 1024 * 1024

function git(repoRoot, arguments_, budget) {
  let output
  try {
    output = execFileSync('git', ['-C', repoRoot, ...arguments_], {
      encoding: null,
      maxBuffer: GIT_OUTPUT_BYTE_LIMIT,
      timeout: 15_000,
      killSignal: 'SIGKILL',
    })
  } catch (error) {
    const detail = error?.code === 'ENOBUFS'
      ? ` exceeded the ${GIT_OUTPUT_BYTE_LIMIT}-byte per-command output limit`
      : ` failed: ${error instanceof Error ? error.message : String(error)}`
    throw new Error(`Git ${arguments_.join(' ')}${detail}`)
  }
  budget.gitOutputBytes += output.length
  if (budget.gitOutputBytes > budget.gitOutputByteLimit) {
    throw new Error(
      `Git fingerprint output exceeded the ${budget.gitOutputByteLimit}-byte aggregate budget`
    )
  }
  return output
}

function nulPaths(buffer) {
  const paths = []
  let start = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue
    if (index > start) {
      const raw = buffer.subarray(start, index)
      const decoded = raw.toString('utf8')
      if (!Buffer.from(decoded, 'utf8').equals(raw)) {
        throw new Error('Git returned a path that is not valid UTF-8; exact identity is unavailable')
      }
      paths.push(decoded)
    }
    start = index + 1
  }
  if (start !== buffer.length) throw new Error('Git path output was not NUL terminated')
  return paths
}

function addPath(budget, relative, scope) {
  budget.pathCount += 1
  if (budget.pathCount > budget.pathLimit) {
    throw new Error(`${scope} exceeded the ${budget.pathLimit}-path fingerprint budget`)
  }
  if (Buffer.byteLength(relative) > 4096) {
    throw new Error(`${scope} contains a path longer than 4096 bytes`)
  }
}

function addContent(budget, size, relative, scope) {
  if (!Number.isSafeInteger(size) || size < 0 || budget.contentBytes + size > budget.contentByteLimit) {
    throw new Error(
      `${scope} exceeded the ${budget.contentByteLimit}-byte content budget at ${JSON.stringify(relative)}`
    )
  }
  budget.contentBytes += size
}

function sameFile(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode &&
    before.size === after.size && before.mtimeMs === after.mtimeMs
}

function hashPath(digest, repoRoot, relative, budget, scope) {
  addPath(budget, relative, scope)
  const absolute = path.join(repoRoot, relative)
  digest.update(`PATH\0${relative}\0`)
  let before
  try {
    before = fs.lstatSync(absolute)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      digest.update('MISSING\0')
      return
    }
    throw error
  }
  digest.update(`MODE\0${before.mode.toString(8)}\0`)
  if (before.isSymbolicLink()) {
    const target = fs.readlinkSync(absolute)
    const after = fs.lstatSync(absolute)
    if (!sameFile(before, after)) throw new Error(`${scope} symlink changed while hashing: ${relative}`)
    addContent(budget, Buffer.byteLength(target), relative, scope)
    digest.update(`SYMLINK\0${target}\0`)
    return
  }
  if (!before.isFile()) throw new Error(`${scope} contains an unsupported path type: ${relative}`)
  addContent(budget, before.size, relative, scope)
  const content = crypto.createHash('sha256')
  const descriptor = fs.openSync(absolute, 'r')
  let total = 0
  try {
    const opened = fs.fstatSync(descriptor)
    if (!sameFile(before, opened)) throw new Error(`${scope} file changed before hashing: ${relative}`)
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
    while (true) {
      const bytes = fs.readSync(descriptor, chunk, 0, chunk.length, null)
      if (bytes === 0) break
      total += bytes
      if (total > before.size) throw new Error(`${scope} file grew while hashing: ${relative}`)
      content.update(chunk.subarray(0, bytes))
    }
    const after = fs.fstatSync(descriptor)
    if (total !== before.size || !sameFile(opened, after)) {
      throw new Error(`${scope} file changed while hashing: ${relative}`)
    }
  } finally {
    fs.closeSync(descriptor)
  }
  digest.update(`FILE\0${total}\0${content.digest('hex')}\0`)
}

function newBudget(pathLimit, contentByteLimit, gitOutputByteLimit = GIT_OUTPUT_BYTE_LIMIT) {
  if (![pathLimit, contentByteLimit, gitOutputByteLimit].every(
    (value) => Number.isSafeInteger(value) && value > 0
  )) {
    throw new Error('fingerprint budgets must be positive safe integers')
  }
  return {
    pathCount: 0,
    contentBytes: 0,
    gitOutputBytes: 0,
    pathLimit,
    contentByteLimit,
    gitOutputByteLimit,
  }
}

function pathExists(absolute) {
  try {
    fs.lstatSync(absolute)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export function fingerprintRepository(repoRoot = repositoryRoot, {
  pathLimit = PATH_LIMIT,
  gitVisibleContentByteLimit = GIT_VISIBLE_CONTENT_BYTE_LIMIT,
  ignoredContentByteLimit = IGNORED_CONTENT_BYTE_LIMIT,
  gitOutputByteLimit = GIT_OUTPUT_BYTE_LIMIT,
} = {}) {
  const gitBudget = newBudget(pathLimit, gitVisibleContentByteLimit, gitOutputByteLimit)
  const head = git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], gitBudget)
    .toString('utf8').trim()
  if (!/^[0-9a-f]{40}$/u.test(head)) throw new Error('Git HEAD is not a complete 40-hex commit ID')

  const gitDigest = crypto.createHash('sha256')
  const index = git(repoRoot, ['ls-files', '--stage', '-z'], gitBudget)
  gitDigest.update(`HEAD\0${head}\0INDEX\0`)
  gitDigest.update(index)
  const visible = [
    ...nulPaths(git(repoRoot, ['diff', '--name-only', '-z', '--no-ext-diff', '--'], gitBudget)),
    ...nulPaths(git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'], gitBudget)),
  ]
  const paths = [...new Set(visible)].sort()
  for (const relative of paths) hashPath(gitDigest, repoRoot, relative, gitBudget, 'Git-visible identity')
  const gitVisibleFingerprint = `sha256:${gitDigest.digest('hex')}`

  const ignoredBudget = newBudget(VERIFICATION_RELEVANT_IGNORED_PATHS.length, ignoredContentByteLimit)
  const ignoredDigest = crypto.createHash('sha256')
  const presentIgnoredPaths = []
  for (const relative of VERIFICATION_RELEVANT_IGNORED_PATHS) {
    if (!pathExists(path.join(repoRoot, relative))) continue
    presentIgnoredPaths.push(relative)
    hashPath(ignoredDigest, repoRoot, relative, ignoredBudget, 'verification-relevant ignored state')
  }
  const ignoredStateFingerprint = `sha256:${ignoredDigest.digest('hex')}`
  const combined = crypto.createHash('sha256')
    .update(`GIT\0${gitVisibleFingerprint}\0IGNORED\0${ignoredStateFingerprint}\0`)
    .digest('hex')
  return {
    head,
    fingerprint: `sha256:${combined}`,
    gitVisibleFingerprint,
    identityScope: GIT_IDENTITY_SCOPE,
    input: gitBudget,
    ignoredState: {
      fingerprint: ignoredStateFingerprint,
      scope: IGNORED_STATE_SCOPE,
      checkedPaths: [...VERIFICATION_RELEVANT_IGNORED_PATHS],
      presentPaths: presentIgnoredPaths,
      input: ignoredBudget,
    },
  }
}

export function collectForbiddenArtifactProblems(repoRoot = repositoryRoot) {
  return FORBIDDEN_ARTIFACTS
    .filter((artifact) => pathExists(path.join(repoRoot, artifact)))
    .map((artifact) => `forbidden verification artifact is present: ${artifact}`)
}

function otherProcessGroupMembers(processGroup, supervisorPid = -1) {
  const completed = spawnSync('ps', ['-eo', 'pid=,pgid=,stat='], {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 1024 * 1024,
  })
  if (completed.error || completed.status !== 0) return null
  const members = new Set()
  for (const line of completed.stdout.split('\n')) {
    const [pidText, groupText, state] = line.trim().split(/\s+/u)
    if (!/^\d+$/u.test(pidText ?? '') || !/^\d+$/u.test(groupText ?? '') || !state) continue
    const pid = Number(pidText)
    if (Number(groupText) === processGroup && pid !== supervisorPid && !state.startsWith('Z')) {
      members.add(pid)
    }
  }
  return members
}

function processGroupRunning(pid) {
  if (!pid) return false
  const members = otherProcessGroupMembers(pid)
  if (members !== null) return members.size > 0
  try {
    if (process.platform === 'win32') process.kill(pid, 0)
    else process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    return true
  }
}

async function waitForProcessGroupExit(pid, timeoutMilliseconds) {
  const deadline = performance.now() + timeoutMilliseconds
  while (processGroupRunning(pid) && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !processGroupRunning(pid)
}

function prefixStream(stream, label, write) {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    pending += chunk
    if (Buffer.byteLength(pending) > MAX_PENDING_OUTPUT_BYTES) {
      write(`[${label}] [unterminated output exceeded ${MAX_PENDING_OUTPUT_BYTES} bytes; segment truncated]\n`)
      pending = ''
      return
    }
    const lines = pending.split('\n')
    pending = lines.pop()
    for (const line of lines) write(`[${label}] ${line}\n`)
  })
  stream.on('end', () => {
    if (pending) write(`[${label}] ${pending}\n`)
  })
}

export function runCommandLane({
  name,
  command,
  arguments_,
  cwd,
  now = () => performance.now(),
  write = (value) => process.stdout.write(value),
  writeError = (value) => process.stderr.write(value),
  registerChild = () => {},
  unregisterChild = () => {},
  signal,
  cancelGraceMilliseconds = CANCEL_GRACE_MILLISECONDS,
  supervisor = processSupervisor,
}) {
  return new Promise((resolve) => {
    const started = now()
    if (signal?.aborted) {
      resolve({
        name,
        command: [command, ...arguments_].join(' '),
        exitCode: signal.reason?.type === 'timeout' ? 124 : 1,
        signal: signal.reason?.signal ?? null,
        durationMilliseconds: 0,
        notStarted: true,
        closureConfirmed: true,
      })
      return
    }
    let child
    try {
      child = spawn(process.execPath, [supervisor, '--', command, ...arguments_], {
        cwd,
        env: process.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeError(`[${name}] could not start: ${message}\n`)
      resolve({
        name,
        command: [command, ...arguments_].join(' '),
        exitCode: 1,
        signal: null,
        durationMilliseconds: Math.max(0, now() - started),
        closureConfirmed: true,
        error: message,
      })
      return
    }
    registerChild(child)
    prefixStream(child.stdout, name, write)
    prefixStream(child.stderr, name, writeError)
    let settled = false
    let cancellationReason = null
    let commandStatus = null
    let leakDetected = false
    let releaseRequested = false
    let releaseFailed = false
    let escalation
    let closureDeadline
    let memberPoll
    let releaseAcknowledgement
    const detachUnconfirmedSupervisor = () => {
      try { child.stdout.destroy() } catch {}
      try { child.stderr.destroy() } catch {}
      try {
        if (child.connected) child.disconnect()
      } catch {}
      try { child.unref() } catch {}
    }
    const finish = (exitCode, childSignal, error, closureConfirmed = true) => {
      if (settled) return
      settled = true
      if (escalation) clearTimeout(escalation)
      if (closureDeadline) clearTimeout(closureDeadline)
      if (memberPoll) clearInterval(memberPoll)
      if (releaseAcknowledgement) clearTimeout(releaseAcknowledgement)
      signal?.removeEventListener('abort', cancel)
      unregisterChild(child)
      resolve({
        name,
        command: [command, ...arguments_].join(' '),
        exitCode: Number.isInteger(exitCode) ? exitCode : 1,
        signal: childSignal ?? cancellationReason?.signal ?? null,
        durationMilliseconds: Math.max(0, now() - started),
        timedOut: cancellationReason?.type === 'timeout',
        cancelled: cancellationReason?.type === 'signal',
        closureConfirmed,
        ...(error ? { error } : {}),
      })
    }
    const requestRelease = () => {
      if (releaseRequested || settled) return
      releaseRequested = true
      try {
        child.send({ type: 'release' }, (error) => {
          if (error && !settled && child.exitCode === null && child.signalCode === null) {
            releaseFailed = true
            beginTermination()
          }
        })
        releaseAcknowledgement ??= setTimeout(() => {
          if (settled || child.exitCode !== null || child.signalCode !== null) return
          releaseFailed = true
          beginTermination()
        }, cancelGraceMilliseconds)
      } catch {
        if (child.exitCode === null && child.signalCode === null) {
          releaseFailed = true
          beginTermination()
        }
      }
    }
    const beginTermination = () => {
      terminateChild(child, 'SIGTERM', writeError)
      memberPoll ??= setInterval(() => {
        if (!commandStatus || releaseRequested || settled) return
        const members = otherProcessGroupMembers(child.pid, child.pid)
        if (members?.size === 0) requestRelease()
      }, 25)
      escalation ??= setTimeout(() => {
        const members = otherProcessGroupMembers(child.pid, child.pid)
        if (!releaseFailed && commandStatus && members?.size === 0) requestRelease()
        else terminateChild(child, 'SIGKILL', writeError)
      }, cancelGraceMilliseconds)
      closureDeadline ??= setTimeout(() => {
        const closureConfirmed = !processGroupRunning(child.pid)
        if (!closureConfirmed) detachUnconfirmedSupervisor()
        const exitCode = !closureConfirmed
          ? 125
          : cancellationReason?.type === 'timeout'
            ? 124
            : cancellationReason?.type === 'signal'
              ? 1
              : (releaseFailed || leakDetected) && commandStatus?.exitCode === 0
                ? 70
                : commandStatus?.exitCode ?? 1
        finish(
          exitCode,
          cancellationReason?.signal ?? null,
          closureConfirmed ? undefined : 'process-group closure could not be confirmed',
          closureConfirmed
        )
      }, cancelGraceMilliseconds * 3)
    }
    const cancel = () => {
      cancellationReason = signal.reason ?? { type: 'cancelled' }
      beginTermination()
    }
    signal?.addEventListener('abort', cancel, { once: true })
    child.once('error', (error) => {
      writeError(`[${name}] could not start: ${error.message}\n`)
      finish(1, null, error.message)
    })
    child.on('message', (message) => {
      if (settled || message?.type !== 'command-status' || commandStatus) return
      commandStatus = message
      const members = otherProcessGroupMembers(child.pid, child.pid)
      if (members === null) {
        beginTermination()
      } else if (members.size > 0) {
        leakDetected = true
        beginTermination()
      } else {
        requestRelease()
      }
    })
    child.once('close', async (supervisorExitCode, supervisorSignal) => {
      const releasedCleanly = releaseRequested && !releaseFailed && supervisorExitCode === 0
      const closureConfirmed = releasedCleanly
        ? true
        : await waitForProcessGroupExit(child.pid, cancelGraceMilliseconds)
      const effectiveExit = cancellationReason?.type === 'timeout'
        ? 124
        : cancellationReason?.type === 'signal'
          ? 1
          : (releaseFailed || leakDetected) && commandStatus?.exitCode === 0
            ? 70
            : commandStatus?.exitCode ?? 1
      let error
      if (!closureConfirmed) error = 'process-group closure could not be confirmed'
      else if (leakDetected) error = 'lane left a surviving process-group member'
      else if (!commandStatus) error = 'lane supervisor exited before reporting command status'
      else if (releaseFailed || (releaseRequested && supervisorExitCode !== 0)) {
        error = `lane supervisor release failed with status ${supervisorExitCode ?? supervisorSignal ?? 'unknown'}`
      }
      finish(
        effectiveExit,
        commandStatus?.signal ?? supervisorSignal,
        error,
        closureConfirmed
      )
    })
    if (signal?.aborted) cancel()
  })
}

function seconds(milliseconds) {
  return Math.ceil(milliseconds / 100) / 10
}

export function renderVerificationReceipt(receipt) {
  const lines = [
    '',
    `Verification receipt · ${receipt.result}`,
    ...receipt.lanes.map((lane) =>
      `  ${lane.name.padEnd(9)} ${lane.result.padEnd(6)} ${seconds(lane.durationMilliseconds).toFixed(1)}s`
    ),
    `  read-only ${receipt.readOnly.result}`,
    `  tree      ${receipt.tree.matches === null ? 'unavailable' : receipt.tree.matches ? 'unchanged' : 'changed'}`,
    `  timeout   ${receipt.termination.timedOut ? 'deadline reached' : 'no'}`,
    `  closure   ${receipt.termination.closureConfirmed ? 'confirmed' : 'unconfirmed'}`,
    `  wall      ${seconds(receipt.timings.wallMilliseconds).toFixed(1)}s`,
    `  critical  ${seconds(receipt.timings.criticalPathMilliseconds).toFixed(1)}s`,
    `  compute   ${seconds(receipt.timings.aggregateComputeMilliseconds).toFixed(1)}s`,
    `  budget    ${receipt.performance.budgetSeconds}s · ${receipt.performance.state} · ${receipt.performance.enforcement}`,
    `  identity  ${receipt.tree.after?.fingerprint ?? 'unavailable'}`,
    ...receipt.readOnly.problems.map((problem) => `  read-only detail: ${problem.replaceAll('\n', ' · ')}`),
    '',
  ]
  return lines.join('\n')
}

export async function runVerification({
  repoRoot = repositoryRoot,
  fingerprint = fingerprintRepository,
  runLane = runCommandLane,
  artifactCheck = collectForbiddenArtifactProblems,
  now = () => performance.now(),
  write = (value) => process.stdout.write(value),
  writeError = (value) => process.stderr.write(value),
  registerChild,
  unregisterChild,
  controller = new AbortController(),
  deadlineMilliseconds = HARD_DEADLINE_MILLISECONDS,
  cancelGraceMilliseconds = CANCEL_GRACE_MILLISECONDS,
  yieldBeforeLaunch = () => new Promise((resolve) => setImmediate(resolve)),
} = {}) {
  const started = now()
  const abortIfDeadlineReached = () => {
    if (!controller.signal.aborted && now() - started >= deadlineMilliseconds) {
      controller.abort({ type: 'timeout' })
    }
  }
  const deadline = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort({ type: 'timeout' })
  }, deadlineMilliseconds)
  let before
  let packageManager
  try {
    const preexistingArtifacts = artifactCheck(repoRoot)
    if (preexistingArtifacts.length > 0) {
      throw new Error(
        `verification prerequisite failed before launch: ${preexistingArtifacts.join('; ')}; ` +
        'remove these dependency artifacts, then rerun pnpm verify'
      )
    }
    before = fingerprint(repoRoot)
    packageManager = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
    ).packageManager
    if (typeof packageManager !== 'string' || packageManager.length === 0) {
      throw new Error('package.json packageManager must be a non-empty string')
    }
  } catch (error) {
    clearTimeout(deadline)
    throw error
  }
  let tests
  let validation
  let readOnlyProblems
  let after
  let finalFingerprintError = null
  try {
    abortIfDeadlineReached()
    await yieldBeforeLaunch()
    abortIfDeadlineReached()
    const laneOptions = {
      cwd: repoRoot,
      now,
      write,
      writeError,
      registerChild,
      unregisterChild,
      signal: controller.signal,
      cancelGraceMilliseconds,
    }
    if (controller.signal.aborted) {
      const reason = controller.signal.reason ?? { type: 'cancelled' }
      const notStarted = (name, command) => ({
        name,
        command,
        exitCode: reason.type === 'timeout' ? 124 : 1,
        signal: reason.signal ?? null,
        durationMilliseconds: 0,
        timedOut: reason.type === 'timeout',
        cancelled: reason.type === 'signal',
        notStarted: true,
        closureConfirmed: true,
      })
      tests = notStarted('tests', 'pnpm run test')
      validation = notStarted('validate', 'pnpm run validate')
    } else {
      [tests, validation] = await Promise.all([
        runLane({ ...laneOptions, name: 'tests', command: 'pnpm', arguments_: ['run', 'test'] }),
        runLane({ ...laneOptions, name: 'validate', command: 'pnpm', arguments_: ['run', 'validate'] }),
      ])
    }
    readOnlyProblems = artifactCheck(repoRoot)
    try {
      after = fingerprint(repoRoot)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      finalFingerprintError = message.replaceAll('\n', ' ').slice(0, 240) || 'unknown fingerprint failure'
    }
    abortIfDeadlineReached()
  } finally {
    clearTimeout(deadline)
  }
  const treeMatches = finalFingerprintError === null ? before.fingerprint === after.fingerprint : null
  const readOnlyPassed = readOnlyProblems.length === 0
  const lanes = [tests, validation].map((lane) => ({
    ...lane,
    result: lane.timedOut ? 'timed-out' : lane.cancelled ? 'cancelled' : lane.exitCode === 0 ? 'passed' : 'failed',
  }))
  const wallMilliseconds = Math.max(0, now() - started)
  const timedOut = controller.signal.aborted && controller.signal.reason?.type === 'timeout'
  const cancelled = controller.signal.aborted && controller.signal.reason?.type === 'signal'
  const closureConfirmed = lanes.every((lane) => lane.closureConfirmed !== false)
  const receipt = {
    schema: 'renovate-config.verify-receipt',
    schemaVersion: 1,
    result: cancelled
      ? 'cancelled'
      : lanes.every(({ result }) => result === 'passed') && treeMatches === true && readOnlyPassed && closureConfirmed
        ? 'passed'
        : 'failed',
    command: 'pnpm verify',
    proofType: 'concurrent deterministic final-tree proof',
    platform: `${process.platform}/${process.arch}`,
    toolchain: {
      node: process.version,
      packageManager,
    },
    lanes,
    readOnly: {
      result: readOnlyPassed ? 'passed' : 'failed',
      problems: readOnlyProblems,
    },
    tree: {
      before,
      after: after ?? null,
      matches: treeMatches,
      observation: finalFingerprintError === null ? 'complete' : 'unavailable',
      ...(finalFingerprintError ? { error: finalFingerprintError } : {}),
    },
    termination: {
      timedOut,
      cancelled,
      hardDeadlineSeconds: deadlineMilliseconds / 1000,
      cancelGraceSeconds: cancelGraceMilliseconds / 1000,
      closureConfirmed,
    },
    timings: {
      wallMilliseconds,
      criticalPathMilliseconds: Math.max(...lanes.map(({ durationMilliseconds }) => durationMilliseconds)),
      aggregateComputeMilliseconds: lanes.reduce((total, lane) => total + lane.durationMilliseconds, 0),
    },
    cacheState: 'unavailable',
    invalidationState: 'not reusable; exact local tree only',
    performance: {
      budgetSeconds: PERFORMANCE_BUDGET_MILLISECONDS / 1000,
      state: wallMilliseconds <= PERFORMANCE_BUDGET_MILLISECONDS ? 'within' : 'exceeded',
      enforcement: 'advisory for the first five representative final-tree runs',
    },
  }
  write(renderVerificationReceipt(receipt))
  return receipt
}

function terminateChild(child, signal, writeError = (value) => process.stderr.write(value)) {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      writeError(`verify: could not send ${signal} to process group ${child.pid}: ${error.message}\n`)
    }
  }
}

function writeAtomicJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

export function validateReportPath(value, repoRoot = repositoryRoot) {
  if (!path.isAbsolute(value)) throw new Error('--report must be an absolute path')
  const requestedOutput = path.resolve(value)
  let realRepository
  let realParent
  try {
    realRepository = fs.realpathSync(repoRoot)
    realParent = fs.realpathSync(path.dirname(requestedOutput))
  } catch (error) {
    throw new Error(`--report path could not be resolved: ${error.message}`)
  }
  if (!fs.statSync(realParent).isDirectory()) {
    throw new Error('--report parent must be a directory')
  }
  const output = path.join(realParent, path.basename(requestedOutput))
  const relative = path.relative(realRepository, output)
  const insideRepository = relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
  if (insideRepository) {
    throw new Error('--report must be outside the tested repository')
  }
  return output
}

export function writeVerificationReport(file, receipt) {
  writeAtomicJson(validateReportPath(file), receipt)
}

function deadlineFailureReceipt(
  reason,
  elapsedMilliseconds,
  closureConfirmed = true,
  deadlineMilliseconds = HARD_DEADLINE_MILLISECONDS,
  cancelGraceMilliseconds = CANCEL_GRACE_MILLISECONDS
) {
  const timedOut = reason.type === 'timeout'
  const lanes = ['tests', 'validate'].map((name) => ({
    name,
    command: `pnpm run ${name}`,
    exitCode: timedOut ? 124 : 1,
    signal: reason.signal ?? null,
    durationMilliseconds: 0,
    timedOut,
    cancelled: !timedOut,
    notStarted: true,
    closureConfirmed,
    result: timedOut ? 'timed-out' : 'cancelled',
  }))
  return {
    schema: 'renovate-config.verify-receipt',
    schemaVersion: 1,
    result: timedOut ? 'failed' : 'cancelled',
    command: 'pnpm verify',
    proofType: 'externally bounded final-tree proof',
    platform: `${process.platform}/${process.arch}`,
    toolchain: { node: process.version, packageManager: 'unavailable' },
    lanes,
    readOnly: { result: 'failed', problems: ['verification core did not complete its evidence transaction'] },
    tree: { before: null, after: null, matches: null, observation: 'unavailable' },
    termination: {
      timedOut,
      cancelled: !timedOut,
      hardDeadlineSeconds: deadlineMilliseconds / 1000,
      cancelGraceSeconds: cancelGraceMilliseconds / 1000,
      closureConfirmed,
    },
    timings: {
      wallMilliseconds: elapsedMilliseconds,
      criticalPathMilliseconds: 0,
      aggregateComputeMilliseconds: 0,
    },
    cacheState: 'unavailable',
    invalidationState: 'not reusable; source identity unavailable',
    performance: {
      budgetSeconds: PERFORMANCE_BUDGET_MILLISECONDS / 1000,
      state: elapsedMilliseconds <= PERFORMANCE_BUDGET_MILLISECONDS ? 'within' : 'exceeded',
      enforcement: 'advisory for the first five representative final-tree runs',
    },
  }
}

function sendGroup(pid, signal, writeError = (value) => process.stderr.write(value)) {
  if (!pid) return
  try {
    if (process.platform === 'win32') process.kill(pid, signal)
    else process.kill(-pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') writeError(`verify: could not send ${signal} to group ${pid}: ${error.message}\n`)
  }
}

export function completeVerificationCore({
  send = process.send?.bind(process),
  disconnect = () => process.disconnect(),
} = {}) {
  if (!send) return Promise.resolve()
  return new Promise((resolve, reject) => {
    send({ type: 'receipt-completed' }, (error) => {
      if (error) {
        reject(error)
        return
      }
      disconnect()
      resolve()
    })
  })
}

export function runVerificationWatchdog({
  command = process.execPath,
  arguments_,
  cwd = repositoryRoot,
  report,
  deadlineMilliseconds = HARD_DEADLINE_MILLISECONDS,
  cancelGraceMilliseconds = CANCEL_GRACE_MILLISECONDS,
  controller = new AbortController(),
  write = (value) => process.stdout.write(value),
  writeError = (value) => process.stderr.write(value),
} = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const groups = new Set()
    let reason = null
    let cooperativeTimer
    let escalationTimer
    let hardStopTimer
    let settled = false
    let receiptCompleted = false
    let child
    const cleanup = () => {
      clearTimeout(deadlineTimer)
      if (cooperativeTimer) clearTimeout(cooperativeTimer)
      if (escalationTimer) clearTimeout(escalationTimer)
      if (hardStopTimer) clearTimeout(hardStopTimer)
      controller.signal.removeEventListener('abort', stop)
    }
    const stop = () => {
      if (reason || settled) return
      reason = controller.signal.reason ?? { type: 'cancelled' }
      if (child.connected) {
        try {
          child.send({ type: 'cancel', reason }, () => {})
        } catch {}
      }
      cooperativeTimer = setTimeout(() => {
        sendGroup(child.pid, reason.signal ?? 'SIGTERM', writeError)
        for (const group of groups) sendGroup(group, reason.signal ?? 'SIGTERM', writeError)
      }, 25)
      escalationTimer = setTimeout(() => {
        sendGroup(child.pid, 'SIGKILL', writeError)
        for (const group of groups) sendGroup(group, 'SIGKILL', writeError)
      }, cancelGraceMilliseconds)
      hardStopTimer = setTimeout(() => {
        if (!settled) {
          cleanup()
          reject(new Error('verification watchdog could not reap the verification core'))
        }
      }, cancelGraceMilliseconds * 3)
    }
    const deadlineTimer = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort({ type: 'timeout' })
    }, deadlineMilliseconds)
    controller.signal.addEventListener('abort', stop, { once: true })
    try {
      child = spawn(command, arguments_, {
        cwd,
        env: {
          ...process.env,
          RENOVATE_CONFIG_VERIFY_PARENT: String(process.pid),
        },
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      })
    } catch (error) {
      cleanup()
      reject(error)
      return
    }
    child.on('message', (message) => {
      if (message?.type === 'register-group' && Number.isSafeInteger(message.pid)) groups.add(message.pid)
      if (message?.type === 'unregister-group' && Number.isSafeInteger(message.pid)) groups.delete(message.pid)
      if (message?.type === 'receipt-completed') receiptCompleted = true
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
    child.once('close', async (exitCode, signal) => {
      if (settled) return
      settled = true
      cleanup()
      for (const group of groups) sendGroup(group, 'SIGKILL', writeError)
      const closure = await Promise.all(
        [...groups].map((group) => waitForProcessGroupExit(group, cancelGraceMilliseconds))
      )
      const closureConfirmed = closure.every(Boolean)
      const elapsed = Math.max(0, performance.now() - started)
      if (reason && !receiptCompleted) {
        const receipt = deadlineFailureReceipt(
          reason,
          Math.ceil(elapsed),
          closureConfirmed,
          deadlineMilliseconds,
          cancelGraceMilliseconds
        )
        if (report) writeAtomicJson(report, receipt)
        write(renderVerificationReceipt(receipt))
      }
      if (!closureConfirmed) {
        reject(new Error('verification watchdog could not confirm descendant closure'))
        return
      }
      if (reason?.type === 'timeout') resolve(124)
      else if (reason?.type === 'signal') resolve(SIGNAL_EXIT_CODES[reason.signal] ?? 1)
      else resolve(Number.isInteger(exitCode) ? exitCode : SIGNAL_EXIT_CODES[signal] ?? 1)
    })
    if (controller.signal.aborted) stop()
  })
}

function usage() {
  return 'usage: node tools/verify.mjs [--report ABSOLUTE-PATH]'
}

if (isMainModule(import.meta.url)) {
  const rawArguments = process.argv.slice(2)
  const arguments_ = rawArguments[0] === '--' ? rawArguments.slice(1) : rawArguments
  if (arguments_.length === 1 && arguments_[0] === '--help') {
    console.log(usage())
  } else {
    try {
      const core = arguments_[0] === '--verification-core'
      if (core && process.env.RENOVATE_CONFIG_VERIFY_PARENT !== String(process.ppid)) {
        throw new Error('the internal verification core requires its watchdog parent')
      }
      const publicArguments = core ? arguments_.slice(1) : arguments_
      let report
      if (publicArguments.length > 0) {
        if (publicArguments.length !== 2 || publicArguments[0] !== '--report') {
          throw new Error(`unexpected argument: ${publicArguments[0]}`)
        }
        report = validateReportPath(publicArguments[1])
      }
      if (core) {
        const controller = new AbortController()
        let terminalSignal = null
        const handleCancellation = (reason) => {
          if (reason?.type === 'signal') terminalSignal ??= reason.signal
          if (!controller.signal.aborted) controller.abort(reason)
        }
        process.on('message', (message) => {
          if (message?.type === 'cancel') handleCancellation(message.reason)
        })
        for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
          process.once(signal, () => handleCancellation({ type: 'signal', signal }))
        }
        const receipt = await runVerification({
          controller,
          registerChild: (child) => process.send?.({ type: 'register-group', pid: child.pid }),
          unregisterChild: (child) => process.send?.({ type: 'unregister-group', pid: child.pid }),
        })
        if (report) writeAtomicJson(report, receipt)
        await completeVerificationCore()
        process.exitCode = terminalSignal
          ? SIGNAL_EXIT_CODES[terminalSignal]
          : receipt.result === 'passed' ? 0 : 1
      } else {
        const controller = new AbortController()
        for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
          process.once(signal, () => {
            if (!controller.signal.aborted) controller.abort({ type: 'signal', signal })
          })
        }
        process.exitCode = await runVerificationWatchdog({
          arguments_: [fileURLToPath(import.meta.url), '--verification-core', ...(report ? ['--report', report] : [])],
          report,
          controller,
        })
      }
    } catch (error) {
      console.error(`verify: ${error instanceof Error ? error.message : String(error)}`)
      console.error(usage())
      process.exitCode = /argument|--report|internal verification core/u.test(error.message) ? 64 : 1
    }
  }
}
