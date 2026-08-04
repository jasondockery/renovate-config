// Parse the small structural subset of GitHub Actions YAML needed by this
// repository's workflow contracts. Comments and run-block contents are not
// treated as executable step properties.
//
// Both entry points must recognise the same `jobs:` line. A parser that
// silently returns zero jobs turns every contract built on it into a guard
// that reports ok while observing nothing, so callers treat an empty result
// from a non-empty workflow as a failure rather than a pass.
const JOBS_KEY = /^jobs:\s*(?:#.*)?$/

function scalar(raw) {
  const withoutComment = raw.replace(/\s+#.*$/, '').trim()
  if (
    (withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
    (withoutComment.startsWith("'") && withoutComment.endsWith("'"))
  ) {
    return withoutComment.slice(1, -1)
  }
  return withoutComment
}

function setStepValue(step, key, raw) {
  step[key] = scalar(raw)
}

export function workflowJobs(text) {
  const lines = text.split('\n')
  const jobs = []
  let inJobs = false
  let current
  for (const line of lines) {
    if (JOBS_KEY.test(line)) {
      inJobs = true
      continue
    }
    if (!inJobs) continue
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

export function workflowJobSteps(text, jobName) {
  const lines = text.split('\n')
  const jobsStart = lines.findIndex((line) => JOBS_KEY.test(line))
  if (jobsStart < 0) return []

  let jobStart = -1
  let jobEnd = lines.length
  for (let index = jobsStart + 1; index < lines.length; index += 1) {
    const match = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*(?:#.*)?$/.exec(lines[index])
    if (!match) continue
    if (jobStart >= 0) {
      jobEnd = index
      break
    }
    if (match[1] === jobName) jobStart = index
  }
  if (jobStart < 0) return []

  const stepsStart = lines.findIndex(
    (line, index) => index > jobStart && index < jobEnd && /^ {4}steps:\s*(?:#.*)?$/.test(line)
  )
  if (stepsStart < 0) return []

  const steps = []
  let current
  let inWith = false
  for (let index = stepsStart + 1; index < jobEnd; index += 1) {
    const line = lines[index]
    const firstProperty = /^ {6}-\s+([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (firstProperty) {
      current = { with: {} }
      steps.push(current)
      inWith = firstProperty[1] === 'with'
      if (!inWith) setStepValue(current, firstProperty[1], firstProperty[2])
      continue
    }
    if (!current || /^\s*(?:#.*)?$/.test(line)) continue

    const property = /^ {8}([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (property) {
      inWith = property[1] === 'with'
      if (inWith) current.with = {}
      else setStepValue(current, property[1], property[2])
      continue
    }
    const withProperty = inWith
      ? /^ {10}([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
      : undefined
    if (withProperty) setStepValue(current.with, withProperty[1], withProperty[2])
  }
  return steps
}
