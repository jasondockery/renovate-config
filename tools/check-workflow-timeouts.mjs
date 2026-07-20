#!/usr/bin/env node
// Every workflow job declares a bounded timeout.
//
// GitHub's default job timeout is 360 minutes, so an unbounded job turns a hang
// into a six-hour silent burn — and a hung scheduled Renovate run must end well
// before the next cron invocation can overlap it. This is the OUTER envelope
// only: the Renovate step and its setup carry their own bounds.
//
// A job that calls a reusable workflow (`uses:`) cannot declare
// timeout-minutes; the called workflow owns its job timeouts, and the call must
// be pinned to a full SHA.
//
// Usage: node tools/check-workflow-timeouts.mjs [workflow-directory]
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_TIMEOUT_MINUTES = Number(process.env['MAX_TIMEOUT_MINUTES'] ?? 60)
const directory = process.argv[2] ?? '.github/workflows'

/** Collect the job blocks of one workflow without a YAML dependency. */
function jobsOf(text) {
  const lines = text.split('\n')
  const jobs = []
  let inJobs = false
  let current
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true
      continue
    }
    if (!inJobs) continue
    // Any new top-level key ends the jobs block.
    if (/^[^\s#]/.test(line)) {
      inJobs = false
      continue
    }
    const header = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*(#.*)?$/.exec(line)
    if (header) {
      current = { name: header[1], timeout: undefined, uses: undefined }
      jobs.push(current)
      continue
    }
    if (current === undefined) continue
    const uses = /^ {4}uses:\s+(\S+)/.exec(line)
    if (uses) current.uses = uses[1]
    const timeout = /^ {4}timeout-minutes:\s+(\S+)/.exec(line)
    if (timeout) current.timeout = timeout[1].replace(/\s*#.*$/, '')
  }
  return jobs
}

const problems = []
let files
try {
  files = readdirSync(directory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => join(directory, name))
    .filter((path) => statSync(path).isFile())
} catch {
  console.error(`cannot read workflow directory ${directory}`)
  process.exit(1)
}

if (files.length === 0) {
  console.error(`no workflow files found in ${directory}`)
  process.exit(1)
}

for (const file of files) {
  for (const job of jobsOf(readFileSync(file, 'utf8'))) {
    if (job.uses !== undefined) {
      if (job.timeout !== undefined) {
        problems.push(`${file}: job ${job.name} calls a reusable workflow and must not declare timeout-minutes`)
      }
      if (!/@[0-9a-f]{40}$/.test(job.uses)) {
        problems.push(`${file}: job ${job.name} calls a reusable workflow not pinned to a full 40-character SHA`)
      }
      continue
    }
    if (job.timeout === undefined) {
      problems.push(`${file}: job ${job.name} has no timeout-minutes`)
      continue
    }
    if (!/^\d+$/.test(job.timeout)) {
      problems.push(`${file}: job ${job.name} timeout-minutes must be a positive integer, got "${job.timeout}"`)
      continue
    }
    const value = Number(job.timeout)
    if (value <= 0) {
      problems.push(`${file}: job ${job.name} timeout-minutes must be greater than zero, got ${value}`)
    } else if (value > MAX_TIMEOUT_MINUTES) {
      problems.push(`${file}: job ${job.name} timeout-minutes ${value} exceeds the ${MAX_TIMEOUT_MINUTES}-minute ceiling`)
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem)
  process.exit(1)
}
console.log(`ok: every job in ${directory} declares a bounded timeout`)
