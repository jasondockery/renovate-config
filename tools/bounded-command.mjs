import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const processSupervisor = fileURLToPath(new URL('./process-supervisor.mjs', import.meta.url))
export const DEFAULT_CANCEL_GRACE_MILLISECONDS = 2_000
const MAX_PENDING_OUTPUT_BYTES = 1024 * 1024
const SIGNAL_EXIT_CODES = Object.freeze({ SIGHUP: 129, SIGINT: 130, SIGKILL: 137, SIGTERM: 143 })

function otherProcessGroupMembers(processGroup, supervisorPid = -1) {
  const completed = spawnSync('ps', ['-eo', 'pid=,pgid=,stat='], {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 1024 * 1024,
  })
  if (completed.error || completed.status !== 0) {
    const detail = completed.error?.message ?? `ps exited ${completed.status}`
    throw new Error(`process-group observation unavailable: ${detail}`)
  }
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

function observeProcessGroupMembers(observer, processGroup, supervisorPid = -1) {
  try {
    const members = observer(processGroup, supervisorPid)
    if (!(members instanceof Set)) {
      return { members: null, error: 'process-group observation unavailable: observer returned no member set' }
    }
    return { members, error: null }
  } catch (error) {
    return {
      members: null,
      error: error instanceof Error ? error.message : `process-group observation unavailable: ${String(error)}`,
    }
  }
}

async function waitForProcessGroupExitObserved(
  pid,
  timeoutMilliseconds,
  observer = otherProcessGroupMembers
) {
  if (!pid) return { closureConfirmed: true, error: null }
  const deadline = performance.now() + timeoutMilliseconds
  while (performance.now() < deadline) {
    const observed = observeProcessGroupMembers(observer, pid)
    if (observed.error) return { closureConfirmed: false, error: observed.error }
    if (observed.members.size === 0) return { closureConfirmed: true, error: null }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const observed = observeProcessGroupMembers(observer, pid)
  if (observed.error) return { closureConfirmed: false, error: observed.error }
  return observed.members.size === 0
    ? { closureConfirmed: true, error: null }
    : { closureConfirmed: false, error: 'process-group closure could not be confirmed before the deadline' }
}

export async function waitForProcessGroupExit(pid, timeoutMilliseconds) {
  return (await waitForProcessGroupExitObserved(pid, timeoutMilliseconds)).closureConfirmed
}

export function normalizeBoundedCommandResult({
  exitCode,
  signal,
  error,
  closureConfirmed = true,
  timedOut = false,
  cancelled = false,
}) {
  if (timedOut) return 124
  if (closureConfirmed === false) return 125
  if (Number.isInteger(exitCode) && exitCode !== 0) return exitCode
  if (signal) return SIGNAL_EXIT_CODES[signal] ?? 1
  if (error) return 70
  if (cancelled) return 1
  return exitCode === 0 ? 0 : 1
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

function terminateChild(child, signal, writeError = (value) => process.stderr.write(value)) {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      writeError(`bounded-command: could not send ${signal} to process group ${child.pid}: ${error.message}\n`)
    }
  }
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
  cancelGraceMilliseconds = DEFAULT_CANCEL_GRACE_MILLISECONDS,
  supervisor = processSupervisor,
  processGroupMembers = otherProcessGroupMembers,
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
    let observationError = null
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
      const timedOut = cancellationReason?.type === 'timeout'
      const cancelled = cancellationReason?.type === 'signal'
      const finalError = error ?? observationError ?? null
      const finalSignal = childSignal ?? cancellationReason?.signal ?? null
      resolve({
        name,
        command: [command, ...arguments_].join(' '),
        exitCode: normalizeBoundedCommandResult({
          exitCode,
          signal: finalSignal,
          error: finalError,
          closureConfirmed,
          timedOut,
          cancelled,
        }),
        signal: finalSignal,
        durationMilliseconds: Math.max(0, now() - started),
        timedOut,
        cancelled,
        closureConfirmed,
        ...(finalError ? { error: finalError } : {}),
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
        const observed = observeProcessGroupMembers(processGroupMembers, child.pid, child.pid)
        if (observed.error) observationError ??= observed.error
        else if (observed.members.size === 0) requestRelease()
      }, 25)
      escalation ??= setTimeout(() => {
        const observed = observeProcessGroupMembers(processGroupMembers, child.pid, child.pid)
        if (observed.error) observationError ??= observed.error
        if (!releaseFailed && !observationError && commandStatus && observed.members?.size === 0) requestRelease()
        else terminateChild(child, 'SIGKILL', writeError)
      }, cancelGraceMilliseconds)
      closureDeadline ??= setTimeout(async () => {
        const closure = await waitForProcessGroupExitObserved(
          child.pid,
          0,
          processGroupMembers
        )
        observationError ??= closure.error
        const closureConfirmed = closure.closureConfirmed
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
        const error = observationError ?? (!closureConfirmed
          ? 'process-group closure could not be confirmed'
          : leakDetected
            ? 'lane left a surviving process-group member'
            : commandStatus?.error
              ? commandStatus.error
            : releaseFailed
              ? `lane supervisor release failed with status ${child.exitCode ?? child.signalCode ?? 'unknown'}`
              : undefined)
        finish(
          exitCode,
          cancellationReason?.signal ?? null,
          error,
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
      const observed = observeProcessGroupMembers(processGroupMembers, child.pid, child.pid)
      if (observed.error) {
        observationError ??= observed.error
        beginTermination()
      } else if (observed.members.size > 0) {
        leakDetected = true
        beginTermination()
      } else {
        requestRelease()
      }
    })
    child.once('close', async (supervisorExitCode, supervisorSignal) => {
      const releasedCleanly = releaseRequested && !releaseFailed &&
        supervisorExitCode === 0 && supervisorSignal == null
      const releaseExitFailed = releaseRequested && !releasedCleanly
      const closure = releasedCleanly
        ? { closureConfirmed: true, error: null }
        : await waitForProcessGroupExitObserved(child.pid, cancelGraceMilliseconds, processGroupMembers)
      observationError ??= closure.error
      const closureConfirmed = closure.closureConfirmed
      const unexpectedSupervisorExit = !releasedCleanly && !releaseExitFailed &&
        !releaseFailed && !leakDetected && !cancellationReason
      const effectiveExit = cancellationReason?.type === 'timeout'
        ? 124
        : cancellationReason?.type === 'signal'
          ? 1
          : (releaseFailed || releaseExitFailed || leakDetected || unexpectedSupervisorExit) && commandStatus?.exitCode === 0
            ? 70
            : commandStatus?.exitCode ?? 1
      let error
      if (observationError) error = observationError
      else if (!closureConfirmed) error = 'process-group closure could not be confirmed'
      else if (leakDetected) error = 'lane left a surviving process-group member'
      else if (!commandStatus) error = 'lane supervisor exited before reporting command status'
      else if (commandStatus.error) error = commandStatus.error
      else if (releaseFailed || releaseExitFailed) {
        error = `lane supervisor release failed with status ${supervisorExitCode ?? supervisorSignal ?? 'unknown'}`
      } else if (unexpectedSupervisorExit) {
        error = `lane supervisor exited unexpectedly with status ${supervisorExitCode ?? supervisorSignal ?? 'unknown'}`
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
