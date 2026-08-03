#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main.mjs'

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const botIdentityFixture = JSON.parse(fs.readFileSync(
  path.join(moduleRoot, 'tools/fixtures/github/renovate-pr-author.json'),
  'utf8'
))
if (
  botIdentityFixture.schema !== 'renovate-config.github-pr-author-fixture' ||
  botIdentityFixture.response?.author?.is_bot !== true ||
  typeof botIdentityFixture.response?.author?.login !== 'string' ||
  !botIdentityFixture.response.author.login.startsWith('app/') ||
  botIdentityFixture.response.baseRefName !== 'main' ||
  !String(botIdentityFixture.response.headRefName ?? '').startsWith('self-hosted-renovate/') ||
  !/^[0-9a-f]{40}$/u.test(botIdentityFixture.response.headRefOid ?? '')
) throw new Error('Renovate PR-author fixture is invalid')

export const RUNNER_REPOSITORY = 'jasondockery/renovate-config'
export const TARGET_REPOSITORIES = Object.freeze([
  'jasondockery/renovate-config',
  'jasondockery/roost',
  'jasondockery/groundwork',
])
export const RENOVATE_BOT_LOGIN = botIdentityFixture.response.author.login
const BRANCH_PREFIX = botIdentityFixture.response.headRefName.slice(
  0,
  botIdentityFixture.response.headRefName.indexOf('/') + 1
)
const EXPECTED_BASE = botIdentityFixture.response.baseRefName
const GITHUB_TIMESTAMP_ALLOWANCE_MILLISECONDS = 2 * 60 * 1000
const MAX_GITHUB_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_RECEIPT_BYTES = 1024 * 1024
const GH_TIMEOUT_MILLISECONDS = 30_000

const DASHBOARD_SECTIONS = Object.freeze({
  'Pending Status Checks': 'pendingStatusChecks',
  'Awaiting Schedule': 'awaitingSchedule',
  'Pending Approval': 'awaitingApproval',
  'Rate Limited': 'rateLimited',
  Open: 'open',
  'Detected dependencies': 'detectedDependencies',
  'Detected Dependencies': 'detectedDependencies',
  'Repository Problems': 'repositoryProblems',
  Warnings: 'warnings',
  Errored: 'errored',
  'Config Migration Needed': 'configMigration',
  'Ignored or Blocked': 'ignoredOrBlocked',
  'PR Edited (Blocked)': 'ignoredOrBlocked',
  'PR Closed (Blocked)': 'ignoredOrBlocked',
})
const DASHBOARD_SUBSTANTIVE_SECTIONS = new Set([
  'repositoryProblems',
  'warnings',
  'errored',
  'configMigration',
  'ignoredOrBlocked',
])

function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} was not valid JSON`)
  }
}

export function parseDashboard(body) {
  if (typeof body !== 'string') throw new Error('Dependency Dashboard body must be text')
  const parsed = {
    pendingStatusChecks: 0,
    awaitingSchedule: 0,
    awaitingApproval: 0,
    rateLimited: 0,
    open: 0,
    detectedDependencies: 0,
    repositoryProblems: 0,
    warnings: 0,
    errored: 0,
    configMigration: 0,
    ignoredOrBlocked: 0,
    recognizedSections: [],
    headings: [],
    unknownSections: [],
  }
  let section
  for (const line of body.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      parsed.headings.push(heading[1])
      section = DASHBOARD_SECTIONS[heading[1]]
      if (section && !parsed.recognizedSections.includes(section)) parsed.recognizedSections.push(section)
      if (!section && !parsed.unknownSections.includes(heading[1])) parsed.unknownSections.push(heading[1])
      continue
    }
    const checkbox = /^\s*[-*+]\s+\[[ xX]\]\s+/u.test(line) && !/<!--\s+create-all-/u.test(line)
    const substantive = /^\s*(?:[-*+]\s+(?!\[[ xX]\])|\d+\.\s+|\|\s*\S)/u.test(line)
    if (section && (checkbox || (DASHBOARD_SUBSTANTIVE_SECTIONS.has(section) && substantive))) {
      parsed[section] += 1
    }
  }
  parsed.recognizedSections.sort()
  parsed.unknownSections.sort()
  return parsed
}

export function summarizeChecks(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) return 'unknown'
  const values = statusCheckRollup.map((check) => String(check.conclusion ?? check.state ?? check.status ?? '').toUpperCase())
  if (values.some((value) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STALE'].includes(value))) {
    return 'failed'
  }
  if (values.some((value) => ['', 'EXPECTED', 'PENDING', 'QUEUED', 'IN_PROGRESS', 'REQUESTED', 'WAITING'].includes(value))) {
    return 'pending'
  }
  return 'passed'
}

export function isRoutineUpdateWindow(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('workflow start time is invalid')
  return date.getUTCDay() === 1 && date.getUTCHours() >= 0 && date.getUTCHours() <= 3
}

function validateReceipt(run, receipt) {
  const problems = []
  if (receipt?.schema !== 'renovate-config.run-receipt' || receipt.receiptKind !== 'renovate-run') {
    problems.push('sanitized artifact is not a Renovate run receipt')
  }
  if (String(receipt?.runId) !== String(run.databaseId)) problems.push('receipt run ID does not match the selected workflow run')
  if (receipt?.runAttempt !== run.attempt) problems.push('receipt attempt does not match the selected workflow run')
  if (receipt?.testedSha !== run.headSha) problems.push('receipt SHA does not match the selected workflow run')
  if (receipt?.result !== 'passed') problems.push('runner receipt did not pass')
  if (receipt?.facts?.['Container log preflight'] !== 'passed') problems.push('container log preflight was not proven')
  if (receipt?.facts?.['Raw structured log'] !== 'deleted before receipt publication') {
    problems.push('raw structured log deletion was not proven')
  }
  if (receipt?.facts?.['Private log directory'] !== 'removed before receipt publication') {
    problems.push('private log directory removal was not proven')
  }
  const rows = Array.isArray(receipt?.repositories) ? receipt.repositories : []
  for (const repository of TARGET_REPOSITORIES) {
    const matches = rows.filter((row) => row?.repository === repository)
    if (matches.length !== 1 || matches[0].result !== 'passed') {
      problems.push(`${repository} does not have one passed receipt row`)
    }
  }
  if (rows.length !== TARGET_REPOSITORIES.length) problems.push('receipt repository scope is not exactly the chartered set')
  return problems
}

function timeWithinRun(value, started, finished) {
  const observed = new Date(value).getTime()
  return Number.isFinite(observed) && observed >= started.getTime() && observed <= finished.getTime()
}

function normalizeBranch(branch) {
  if (typeof branch === 'string') return { name: branch, sha: '' }
  return { name: String(branch?.name ?? ''), sha: String(branch?.sha ?? '') }
}

function validRenovatePrIdentity(pr) {
  if (pr.author?.login !== RENOVATE_BOT_LOGIN) return false
  if (pr.baseRefName !== EXPECTED_BASE || !pr.headRefName?.startsWith(BRANCH_PREFIX)) return false
  if (!/^[0-9a-f]{40}$/u.test(pr.headRefOid ?? '')) return false
  return true
}

function prState(pr) {
  return String(pr.state ?? 'OPEN').toUpperCase()
}

function prAttributionTimes(pr, state) {
  if (state === 'OPEN') return [pr.createdAt, pr.updatedAt]
  if (state === 'CLOSED') return [pr.createdAt, pr.closedAt]
  if (state === 'MERGED') return [pr.createdAt, pr.closedAt, pr.mergedAt]
  return []
}

function prTouchedByRun(pr, started, finished) {
  return prAttributionTimes(pr, prState(pr))
    .some((value) => value && timeWithinRun(value, started, finished))
}

function attributablePr(pr, branchByName, started, finished) {
  if (!validRenovatePrIdentity(pr)) return false
  const state = prState(pr)
  if (state === 'OPEN' && branchByName.get(pr.headRefName) !== pr.headRefOid) return false
  if (!['OPEN', 'CLOSED', 'MERGED'].includes(state)) return false
  return prTouchedByRun(pr, started, finished)
}

function invalidIdentityIsRelevant(pr, branchByName, started, finished) {
  return prState(pr) === 'OPEN' || branchByName.has(pr.headRefName) || prTouchedByRun(pr, started, finished)
}

function dashboardExplanation(counts) {
  const reasons = []
  if (counts.pendingStatusChecks > 0) reasons.push(`${counts.pendingStatusChecks} pending internal checks; publication age is not established`)
  if (counts.awaitingSchedule > 0) reasons.push(`${counts.awaitingSchedule} awaiting weekly routine update window`)
  if (counts.awaitingApproval > 0) reasons.push(`${counts.awaitingApproval} awaiting owner approval`)
  if (counts.rateLimited > 0) reasons.push(`${counts.rateLimited} rate limited`)
  if (counts.open > 0) reasons.push(`${counts.open} dashboard-open updates without current-run PR attribution`)
  if (counts.configMigration > 0) reasons.push('configuration migration awaits owner action')
  if (counts.ignoredOrBlocked > 0) reasons.push(`${counts.ignoredOrBlocked} ignored or blocked update(s)`)
  return reasons.join('; ')
}

export function auditSystem({ run, receipt, repositories }) {
  const globalProblems = []
  if (!run || String(run.databaseId ?? '') === '') throw new Error('workflow run evidence is required')
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    globalProblems.push(`workflow run is ${run.status ?? 'unknown'}/${run.conclusion ?? 'unknown'}`)
  }
  const started = new Date(run.startedAt)
  const finished = new Date(run.updatedAt)
  if (Number.isNaN(started.getTime()) || Number.isNaN(finished.getTime()) || finished < started) {
    globalProblems.push('workflow run timing is missing or invalid')
  }
  globalProblems.push(...validateReceipt(run, receipt))
  const insideRoutineWindow = isRoutineUpdateWindow(run.startedAt)
  const results = []

  for (const repository of TARGET_REPOSITORIES) {
    const source = repositories.find((entry) => entry.repository === repository)
    if (!source) {
      results.push({ repository, result: 'failed', problems: ['live repository evidence is missing'], pending: [] })
      continue
    }
    const problems = []
    const pending = []
    const receiptRow = receipt?.repositories?.find((row) => row.repository === repository)
    const processed = receiptRow?.result === 'passed'
    if (!processed) problems.push('runner processing did not pass')

    const dashboard = source.dashboard
    const counts = dashboard ? parseDashboard(dashboard.body) : parseDashboard('')
    if (!dashboard) problems.push('Dependency Dashboard was not found')
    const dashboardUpdatedAt = dashboard ? new Date(dashboard.updatedAt).getTime() : Number.NaN
    if (dashboard && !Number.isFinite(dashboardUpdatedAt)) problems.push('Dependency Dashboard update time is invalid')
    const dashboardPredatesRun = Boolean(dashboard && dashboardUpdatedAt < started.getTime())
    const dashboardAfterRun = Boolean(
      dashboard && dashboardUpdatedAt > finished.getTime() + GITHUB_TIMESTAMP_ALLOWANCE_MILLISECONDS
    )
    const dashboardRefreshed = Boolean(
      dashboard &&
      dashboardUpdatedAt >= started.getTime() &&
      dashboardUpdatedAt <= finished.getTime() + GITHUB_TIMESTAMP_ALLOWANCE_MILLISECONDS
    )
    if (dashboardPredatesRun) {
      pending.push('Dependency Dashboard predates the selected run; current-run dashboard state is not attributable')
    }
    if (dashboardAfterRun) problems.push('Dependency Dashboard update is not attributable to the selected run')
    if (dashboard && counts.recognizedSections.length === 0) problems.push('Dependency Dashboard has no recognized evidence sections')
    if (counts.repositoryProblems > 0 || counts.warnings > 0 || counts.errored > 0) {
      const message = 'Dependency Dashboard reports repository problems, warnings, or errored updates'
      if (dashboardRefreshed) problems.push(message)
      else pending.push(`${message}; stale issue content is not current-run evidence`)
    }
    if (counts.unknownSections.length > 0) {
      const actionable = counts.unknownSections.filter((heading) => /error|warn|problem|fail|invalid|disabled/iu.test(heading))
      if (actionable.length > 0 && dashboardRefreshed) problems.push(`Dependency Dashboard has unknown actionable sections: ${actionable.join(', ')}`)
      else if (actionable.length > 0) pending.push(`stale Dependency Dashboard has unknown actionable sections: ${actionable.join(', ')}`)
      else pending.push(`Dependency Dashboard has unrecognized sections: ${counts.unknownSections.join(', ')}`)
    }
    if (dashboardRefreshed && counts.configMigration > 0) pending.push('configuration migration awaits owner action')
    if (dashboardRefreshed && counts.ignoredOrBlocked > 0) pending.push('updates are ignored or blocked')

    const branches = source.branches.map(normalizeBranch).filter(({ name }) => name.startsWith(BRANCH_PREFIX))
    const branchByName = new Map(branches.map(({ name, sha }) => [name, sha]))
    const observedPrs = source.pullRequests.filter((pr) => pr.headRefName?.startsWith(BRANCH_PREFIX))
    const invalidIdentityPrs = observedPrs.filter((pr) =>
      !validRenovatePrIdentity(pr) && invalidIdentityIsRelevant(pr, branchByName, started, finished)
    )
    for (const pr of invalidIdentityPrs) {
      problems.push(`PR #${pr.number} uses the Renovate branch prefix with an unexpected author or base branch`)
    }
    const attributable = observedPrs.filter((pr) => attributablePr(pr, branchByName, started, finished)).map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
      state: prState(pr),
      closedAt: pr.closedAt ?? null,
      mergedAt: pr.mergedAt ?? null,
      checks: summarizeChecks(pr.statusCheckRollup),
    }))
    const matchedOpenBranches = new Set(observedPrs.filter((pr) =>
      prState(pr) === 'OPEN' &&
      validRenovatePrIdentity(pr) &&
      branchByName.get(pr.headRefName) === pr.headRefOid
    ).map((pr) => pr.headRefName))
    const orphanBranches = branches.filter(({ name }) => !matchedOpenBranches.has(name)).map(({ name }) => name)
    if (orphanBranches.length > 0) problems.push(`Renovate branch without a matching open PR: ${orphanBranches.join(', ')}`)

    for (const pr of attributable) {
      if (pr.checks === 'failed') problems.push(`PR #${pr.number} consumer CI failed`)
      if (pr.checks === 'pending' || pr.checks === 'unknown') pending.push(`PR #${pr.number} consumer checks are ${pr.checks}`)
    }
    if (counts.pendingStatusChecks > 0) pending.push('pending internal checks do not prove publication age')
    if (counts.rateLimited > 0) pending.push('Renovate was rate limited')
    if (counts.awaitingApproval > 0) pending.push('updates await owner approval')
    if (counts.open > 0 && attributable.length === 0) pending.push('dashboard-open updates lack a PR attributable to this run')

    if (dashboardRefreshed && counts.awaitingSchedule > 0 && insideRoutineWindow && attributable.length === 0) {
      problems.push('eligible scheduled updates did not advance during the weekly routine update window')
    }
    if (dashboardRefreshed && counts.awaitingSchedule > 0 && run.event === 'schedule' && started.getUTCDay() === 1 && !insideRoutineWindow) {
      problems.push('the daily scheduled runner began after the weekly routine update window and missed eligible updates')
    }

    let explanation
    if (attributable.length > 0) explanation = `${attributable.length} Renovate PR(s) attributable to the selected run`
    else if (pending.length > 0) {
      explanation = dashboardExplanation(counts) || 'current-run dashboard state is not attributable'
    }
    else if (dashboardRefreshed && counts.awaitingSchedule > 0 && !insideRoutineWindow) explanation = `${counts.awaitingSchedule} update(s) outside the weekly routine update window`
    else if (dashboardRefreshed && counts.recognizedSections.includes('detectedDependencies')) {
      pending.push('structured no-eligible-update evidence is absent; Detected Dependencies alone is not proof')
      explanation = 'fresh dashboard observed, but no eligible-update conclusion is not proven'
    } else problems.push('dashboard evidence cannot establish that no eligible update exists')

    const result = problems.length > 0 ? 'failed' : pending.length > 0 ? 'pending' : 'passed'
    results.push({
      repository,
      processed,
      dashboard: dashboard ? { url: dashboard.url, updatedAt: dashboard.updatedAt, refreshed: dashboardRefreshed } : null,
      counts,
      branches,
      observedPullRequests: observedPrs.length,
      pullRequests: attributable,
      explanation: explanation ?? 'evidence is incomplete',
      problems,
      pending,
      result,
    })
  }

  const failed = globalProblems.length > 0 || results.some(({ result }) => result === 'failed')
  const hasPending = results.some(({ result }) => result === 'pending')
  return {
    result: failed ? 'failed' : hasPending ? 'pending' : 'passed',
    run,
    insideRoutineWindow,
    globalProblems,
    repositories: results,
  }
}

export function renderAudit(audit) {
  const lines = [
    'Renovate system audit',
    '',
    `Run: ${audit.run.url}`,
    `SHA: ${audit.run.headSha}`,
    `Started: ${audit.run.startedAt}`,
    `Routine update window: ${audit.insideRoutineWindow ? 'open' : 'closed'}`,
    `Result: ${audit.result}`,
  ]
  if (audit.globalProblems.length > 0) {
    lines.push('', 'System findings')
    for (const problem of audit.globalProblems) lines.push(`  - ${problem}`)
  }
  for (const repository of audit.repositories) {
    lines.push('', repository.repository)
    if (!repository.processed && repository.problems?.length === 1 && repository.problems[0] === 'live repository evidence is missing') {
      lines.push('  Evidence: missing', '  Result: failed')
      continue
    }
    lines.push(
      `  Processed: ${repository.processed ? 'yes' : 'no'}`,
      `  Dashboard observed: ${repository.dashboard ? 'yes' : 'no'}`,
      `  Dashboard refreshed after run: ${repository.dashboard?.refreshed ? 'yes' : 'not proven'}`,
      `  Pending internal status checks: ${repository.counts.pendingStatusChecks}`,
      `  Awaiting weekly update window: ${repository.counts.awaitingSchedule}`,
      `  Awaiting owner approval: ${repository.counts.awaitingApproval}`,
      `  Rate limited: ${repository.counts.rateLimited}`,
      `  Open Renovate branches: ${repository.branches.length}`,
      `  Observed Renovate PRs (all states): ${repository.observedPullRequests}`,
      `  Current-run attributable PRs: ${repository.pullRequests.length}`,
    )
    for (const pr of repository.pullRequests) lines.push(`  PR #${pr.number}: ${pr.state.toLowerCase()} · ${pr.checks} · ${pr.url}`)
    lines.push(`  Classification: ${repository.explanation}`)
    for (const problem of repository.problems) lines.push(`  Finding: ${problem}`)
    for (const item of repository.pending) lines.push(`  Pending: ${item}`)
    lines.push(`  Result: ${repository.result}`)
  }
  return `${lines.join('\n')}\n`
}

export function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true }
  if (argv.length !== 2 || argv[0] !== '--run' || !/^[1-9][0-9]*$/u.test(argv[1])) {
    throw new Error('usage: pnpm renovate:audit --run <run-id>')
  }
  const runId = Number(argv[1])
  if (!Number.isSafeInteger(runId)) throw new Error('run ID must be a positive safe integer')
  return { runId }
}

function defaultGh(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: MAX_GITHUB_OUTPUT_BYTES,
    timeout: GH_TIMEOUT_MILLISECONDS,
    env: process.env,
  })
  if (result.error) throw new Error(`gh ${args[0]} could not start: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = String(result.stderr || '').trim().split('\n').at(-1) || `exit ${result.status}`
    throw new Error(`gh ${args[0]} failed: ${detail}`)
  }
  return result.stdout
}

function readDownloadedReceipt(run, gh) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-system-audit-'))
  try {
    fs.chmodSync(directory, 0o700)
    gh([
      'run', 'download', String(run.databaseId),
      '--repo', RUNNER_REPOSITORY,
      '--name', `renovate-run-receipt-${run.databaseId}-${run.attempt}`,
      '--dir', directory,
    ])
    const file = path.join(directory, 'renovate-run-receipt.json')
    const status = fs.lstatSync(file)
    if (status.isSymbolicLink() || !status.isFile()) throw new Error('downloaded receipt is not a regular file')
    if (status.size <= 0 || status.size > MAX_RECEIPT_BYTES) throw new Error('downloaded receipt size is outside the accepted bound')
    return parseJson(fs.readFileSync(file, 'utf8'), 'downloaded receipt')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function collectRepository(repository, gh) {
  const issues = parseJson(gh([
    'issue', 'list', '--repo', repository, '--state', 'open',
    '--search', 'Dependency Dashboard in:title', '--limit', '10',
    '--json', 'number,title,url,updatedAt,body',
  ]), `${repository} issues`)
  const dashboards = issues.filter((issue) => issue.title === 'Dependency Dashboard')
  if (dashboards.length > 1) throw new Error(`${repository} has more than one open Dependency Dashboard`)
  const pullRequests = parseJson(gh([
    'pr', 'list', '--repo', repository, '--state', 'all', '--limit', '100',
    '--json', 'number,title,url,state,headRefName,headRefOid,baseRefName,author,createdAt,updatedAt,closedAt,mergedAt,statusCheckRollup',
  ]), `${repository} pull requests`)
  const refs = parseJson(gh([
    'api', `repos/${repository}/git/matching-refs/heads/${BRANCH_PREFIX}`,
  ]), `${repository} Renovate branches`)
  return {
    repository,
    dashboard: dashboards[0] ?? null,
    pullRequests,
    branches: refs.map((entry) => ({
      name: String(entry.ref).replace(/^refs\/heads\//u, ''),
      sha: String(entry.object?.sha ?? ''),
    })),
  }
}

export function collectLiveAudit(runId, { gh = defaultGh } = {}) {
  const run = parseJson(gh([
    'run', 'view', String(runId), '--repo', RUNNER_REPOSITORY,
    '--json', 'attempt,conclusion,databaseId,event,headSha,startedAt,status,updatedAt,url',
  ]), 'workflow run')
  const receipt = readDownloadedReceipt(run, gh)
  const repositories = TARGET_REPOSITORIES.map((repository) => collectRepository(repository, gh))
  return auditSystem({ run, receipt, repositories })
}

if (isMainModule(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2))
    if (options.help) {
      console.log('usage: pnpm renovate:audit --run <run-id>')
    } else {
      const audit = collectLiveAudit(options.runId)
      process.stdout.write(renderAudit(audit))
      if (audit.result === 'failed') process.exitCode = 1
      else if (audit.result === 'pending') process.exitCode = 2
    }
  } catch (error) {
    console.error(`renovate-system-audit: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
