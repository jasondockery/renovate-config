import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const processSupervisor = fileURLToPath(new URL('./process-supervisor.mjs', import.meta.url))
export const DEFAULT_CANCEL_GRACE_MILLISECONDS = 2_000
const MAX_PENDING_OUTPUT_BYTES = 1024 * 1024

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

export async function waitForProcessGroupExit(pid, timeoutMilliseconds) {
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
        const members = processGroupMembers(child.pid, child.pid)
        if (members?.size === 0) requestRelease()
      }, 25)
      escalation ??= setTimeout(() => {
        const members = processGroupMembers(child.pid, child.pid)
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
        const error = !closureConfirmed
          ? 'process-group closure could not be confirmed'
          : leakDetected
            ? 'lane left a surviving process-group member'
            : releaseFailed
              ? `lane supervisor release failed with status ${child.exitCode ?? child.signalCode ?? 'unknown'}`
              : undefined
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
      const members = processGroupMembers(child.pid, child.pid)
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
      const releaseExitFailed = releaseRequested && !releasedCleanly
      const closureConfirmed = releasedCleanly
        ? true
        : await waitForProcessGroupExit(child.pid, cancelGraceMilliseconds)
      const effectiveExit = cancellationReason?.type === 'timeout'
        ? 124
        : cancellationReason?.type === 'signal'
          ? 1
          : (releaseFailed || releaseExitFailed || leakDetected) && commandStatus?.exitCode === 0
            ? 70
            : commandStatus?.exitCode ?? 1
      let error
      if (!closureConfirmed) error = 'process-group closure could not be confirmed'
      else if (leakDetected) error = 'lane left a surviving process-group member'
      else if (!commandStatus) error = 'lane supervisor exited before reporting command status'
      else if (releaseFailed || releaseExitFailed) {
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
