#!/usr/bin/env node
import process from 'node:process'
import { spawn } from 'node:child_process'
import { isMainModule } from './is-main.mjs'

const SIGNAL_STATUS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }

function parseArguments(arguments_) {
  if (arguments_.length < 2 || arguments_[0] !== '--') {
    throw new Error('usage: node tools/process-supervisor.mjs -- COMMAND [ARGUMENTS...]')
  }
  return { command: arguments_[1], arguments_: arguments_.slice(2) }
}

export function runProcessSupervisor(arguments_ = process.argv.slice(2)) {
  const { command, arguments_: commandArguments } = parseArguments(arguments_)
  let child
  let statusSent = false
  let releaseRequested = false
  let requestedSignal = null

  const sendStatus = (exitCode, signal, error) => {
    if (statusSent) return
    statusSent = true
    process.send?.({
      type: 'command-status',
      exitCode: Number.isInteger(exitCode) ? exitCode : (SIGNAL_STATUS[signal] ?? 1),
      signal: signal ?? null,
      ...(error ? { error } : {}),
    })
    if (releaseRequested) process.exit(0)
  }

  for (const signal of Object.keys(SIGNAL_STATUS)) {
    process.on(signal, () => {
      requestedSignal ??= signal
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill(signal)
        } catch {
          // The process-group signal may already have reached the command.
        }
      }
    })
  }
  process.on('message', (message) => {
    if (message?.type !== 'release') return
    releaseRequested = true
    if (statusSent) process.exit(0)
  })
  process.on('disconnect', () => {
    if (!releaseRequested) {
      try {
        if (process.platform === 'win32') child?.kill('SIGKILL')
        else process.kill(-process.pid, 'SIGKILL')
      } catch {
        // The outer owner disappeared; the OS may already have closed the group.
      }
      process.exit(125)
    }
  })

  child = spawn(command, commandArguments, {
    env: {
      ...process.env,
      RENOVATE_CONFIG_VERIFICATION_SUPERVISOR: String(process.pid),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  child.once('error', (error) => sendStatus(1, null, error.message))
  child.once('exit', (exitCode, signal) => sendStatus(exitCode, signal))
  if (requestedSignal && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill(requestedSignal)
    } catch {
      // The command may have exited during its launch window.
    }
  }
}

if (isMainModule(import.meta.url)) {
  try {
    runProcessSupervisor()
  } catch (error) {
    console.error(`process-supervisor: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 64
  }
}
