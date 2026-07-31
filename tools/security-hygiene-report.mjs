#!/usr/bin/env node
// Cross-repository security-hygiene report: one durable markdown document
// listing every open Dependabot, code-scanning, and secret-scanning alert
// across the owner repos, with age, owner, links, and SLA status. GitHub
// detects and tracks findings; Renovate proposes dependency updates; this
// report is the daily inbox view that keeps the human review honest. It never
// dismisses, never remediates.
//
// Monitor honesty: a source this monitor cannot read is a broken monitor, not
// a clean repo — and whether "disabled" is acceptable is per-repository
// POLICY (tools/security-policy.mjs), never inferred from an API message
// alone. Broken-monitor and overdue-alert are independent facts: the exit
// code prioritizes the monitor (3 beats 2), the state file and issue labels
// carry both.
import fs from 'node:fs'
import process from 'node:process'
import { isMainModule } from './is-main.mjs'
import {
  CODE_SCANNING_SLA,
  DEPENDABOT_SLA,
  REPORT_EXIT_CODES,
  SOURCE_POLICY,
  UNKNOWN_SEVERITY_SLA_DAYS,
} from './security-policy.mjs'

export { CODE_SCANNING_SLA, DEPENDABOT_SLA } from './security-policy.mjs'

export const COLLECTION_TIMEOUT_MS = 180_000

const SEVERITY_RANK = {
  critical: 0,
  high: 1,
  error: 1,
  medium: 2,
  warning: 3,
  low: 4,
  note: 5,
  unknown: 1, // unknown sorts with high: it needs triage, not burial
}

export function ageDays(createdAt, now) {
  const created = Date.parse(createdAt ?? '')
  if (Number.isNaN(created)) return null
  return Math.floor((now - created) / 86_400_000)
}

function singleLine(text) {
  return String(text ?? '')
    .replaceAll(/[\u0000-\u001f\u007f]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

// API-provided prose can contain Markdown control characters or newlines.
// Escape all inline Markdown punctuation; field values use inlineCode() below
// so they cannot create links or formatting.
export function escapeMarkdown(text) {
  return singleLine(text).replaceAll(/([\\`*_[\]()<>#|~])/g, '\\$1')
}

function inlineCode(text) {
  return `\`${singleLine(text).replaceAll('`', "'")}\``
}

function githubAlertLink(value) {
  try {
    const parsed = new URL(String(value))
    return parsed.protocol === 'https:' && parsed.origin === 'https://github.com'
      ? parsed.href
      : null
  } catch {
    return null
  }
}

export function dependabotSeverity(alert) {
  return alert.security_advisory?.severity ?? 'unknown'
}

export function codeScanningSeverity(alert) {
  // GitHub prefers the security severity when one exists; rule.severity is
  // only the tool level (error/warning/note).
  return alert.rule?.security_severity_level ?? alert.rule?.severity ?? 'unknown'
}

function assigneeText(alert) {
  // Profile links, not @login: a daily issue rewrite must not re-notify
  // every assignee every morning.
  const assignees = (alert.assignees ?? [])
    .map((user) => singleLine(user?.login))
    .filter((login) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login))
    .map((login) => `[${escapeMarkdown(login)}](https://github.com/${encodeURIComponent(login)})`)
  return assignees.length > 0 ? assignees.join(' ') : 'UNASSIGNED'
}

function hasValidAssignee(alert) {
  return (alert.assignees ?? []).some((user) =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(singleLine(user?.login))
  )
}

// "Resolve within 1 day" means the deadline arrives at 24 hours — computed
// from exact timestamps, never from floored whole days (which would grant a
// one-day SLA almost 48 hours). Floored days appear only in display text.
function slaState(severity, table, createdAt, now) {
  const created = Date.parse(createdAt ?? '')
  if (Number.isNaN(created)) {
    return { overdue: false, text: 'age unavailable; SLA not evaluated' }
  }
  const known = table[severity] !== undefined
  const target = known ? table[severity] : UNKNOWN_SEVERITY_SLA_DAYS
  const applied = known ? '' : ' (unknown severity — high SLA applied)'
  const overdue = now >= created + target * 86_400_000
  const age = Math.floor((now - created) / 86_400_000)
  return overdue
    ? { overdue: true, text: `OVERDUE (${age}d, target ${target}d)${applied}` }
    : { overdue: false, text: `within SLA (${age}d / ${target}d)${applied}` }
}

function dependabotLine(alert, now) {
  const severity = dependabotSeverity(alert)
  const sla = dependabotSla(alert, now)
  const fixed = alert.security_vulnerability?.first_patched_version?.identifier
  const parts = [
    inlineCode(severity),
    inlineCode(alert.dependency?.scope ?? 'scope unknown'),
    inlineCode(alert.dependency?.package?.name ?? 'package unknown'),
    inlineCode(alert.security_advisory?.summary ?? 'no advisory summary'),
    fixed ? `fixed in ${inlineCode(fixed)}` : 'no patched version yet',
    inlineCode(alert.dependency?.manifest_path ?? 'manifest unknown'),
    assigneeText(alert),
    sla.text,
  ]
  const safeLink = githubAlertLink(alert.html_url)
  const link = safeLink ? ` — ${safeLink}` : ''
  return {
    severity,
    overdue: sla.overdue,
    unassigned: !hasValidAssignee(alert),
    age: ageDays(alert.created_at, now) ?? -1,
    text: `  - ${parts.join(' | ')}${link}`,
  }
}

function codeScanningLine(alert, now) {
  const severity = codeScanningSeverity(alert)
  const sla = codeScanningSla(alert, now)
  const parts = [
    inlineCode(severity),
    inlineCode(alert.rule?.id ?? 'rule unknown'),
    inlineCode(alert.tool?.name ?? 'tool unknown'),
    inlineCode(alert.most_recent_instance?.location?.path ?? 'location unavailable'),
    assigneeText(alert),
    sla.text,
  ]
  const safeLink = githubAlertLink(alert.html_url)
  const link = safeLink ? ` — ${safeLink}` : ''
  return {
    severity,
    overdue: sla.overdue,
    unassigned: !hasValidAssignee(alert),
    age: ageDays(alert.created_at, now) ?? -1,
    text: `  - ${parts.join(' | ')}${link}`,
  }
}

function secretScanningLine(alert, now) {
  const age = ageDays(alert.created_at, now)
  const validity =
    alert.validity && alert.validity !== 'unknown'
      ? alert.validity
      : 'not evaluated/available'
  const parts = [
    'URGENT',
    inlineCode(alert.secret_type_display_name ?? alert.secret_type ?? 'secret type unknown'),
    `validity: ${inlineCode(validity)}`,
    assigneeText(alert),
    age === null
      ? 'age unavailable'
      : `${age}d old — rotate the credential now; removal from code is not remediation`,
  ]
  const safeLink = githubAlertLink(alert.html_url)
  const link = safeLink ? ` — ${safeLink}` : ''
  // Never include locations or values: the report is a pointer, not a copy.
  return {
    severity: 'critical',
    overdue: true,
    unassigned: !hasValidAssignee(alert),
    age: age ?? -1,
    text: `  - ${parts.join(' | ')}${link}`,
  }
}

function dependabotSla(alert, now) {
  return slaState(dependabotSeverity(alert), DEPENDABOT_SLA, alert.created_at, now)
}

function codeScanningSla(alert, now) {
  return slaState(codeScanningSeverity(alert), CODE_SCANNING_SLA, alert.created_at, now)
}

function sortLines(lines) {
  return [...lines].sort(
    (a, b) =>
      Number(b.overdue) - Number(a.overdue) ||
      (SEVERITY_RANK[a.severity] ?? 1) - (SEVERITY_RANK[b.severity] ?? 1) ||
      Number(b.unassigned) - Number(a.unassigned) ||
      b.age - a.age
  )
}

export const SOURCE_KEYS = ['dependabot', 'codeScanning', 'secretScanning']
const SOURCE_LABELS = {
  dependabot: 'Dependabot alerts',
  codeScanning: 'Code scanning',
  secretScanning: 'Secret scanning',
}
const KNOWN_STATES = new Set(['available', 'disabled', 'unavailable'])
export const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000

function sourceShapeProblem(source) {
  if (!source || !KNOWN_STATES.has(source.state)) {
    return 'result missing or unrecognized'
  }
  if (!Array.isArray(source.alerts)) {
    return 'alerts are not an array'
  }
  if (source.state !== 'available' && source.alerts.length > 0) {
    return `${source.state} result contains alerts`
  }
  if (
    source.state === 'unavailable' &&
    (typeof source.reason !== 'string' || source.reason.trim() === '')
  ) {
    return 'unavailable result has no reason'
  }
  return null
}

function alertTimestampProblem(alert, now) {
  if (typeof alert?.created_at !== 'string' || alert.created_at.trim() === '') {
    return 'has no valid created_at'
  }
  const created = Date.parse(alert.created_at)
  if (!Number.isFinite(created)) return 'has no valid created_at'
  if (created > now + MAX_FUTURE_CLOCK_SKEW_MS) {
    return 'has a created_at too far in the future'
  }
  return null
}

// Per-repo, per-source health under SOURCE_POLICY:
//   required + disabled          → broken (coverage regression, not a state)
//   expected-disabled + disabled → healthy, coverage gap documented
//   expected-disabled + available→ report normally
//   unavailable                  → broken, always
//   missing/unknown state        → broken (the monitor's own data is corrupt)
//   repo missing from policy     → broken (undeclared coverage)
export function monitorHealth({ repos, generatedAt = new Date().toISOString() }) {
  const broken = []
  const now = Date.parse(generatedAt)
  if (!Number.isFinite(now)) {
    broken.push('report generatedAt is invalid — SLA evaluation is unsafe')
  }
  const seen = new Set()
  for (const { repo } of repos) {
    if (seen.has(repo)) broken.push(`${escapeMarkdown(repo)}: duplicate fetched repository result`)
    seen.add(repo)
  }
  for (const repo of Object.keys(SOURCE_POLICY)) {
    if (!seen.has(repo)) {
      broken.push(`${escapeMarkdown(repo)}: policy repository was not fetched`)
    }
  }
  for (const { repo, ...sources } of repos) {
    const policy = SOURCE_POLICY[repo]
    if (!policy) {
      broken.push(`${escapeMarkdown(repo)}: no expected-source policy declared (tools/security-policy.mjs)`)
      continue
    }
    for (const key of SOURCE_KEYS) {
      const source = sources[key]
      const label = SOURCE_LABELS[key]
      const shapeProblem = sourceShapeProblem(source)
      if (shapeProblem) {
        broken.push(
          `${escapeMarkdown(repo)}: ${label} ${escapeMarkdown(shapeProblem)} — monitor data corrupt`
        )
        continue
      }
      if (source.state === 'unavailable') {
        broken.push(`${escapeMarkdown(repo)}: ${label} ${escapeMarkdown(source.reason)}`)
        continue
      }
      if (source.state === 'disabled' && policy[key] === 'required') {
        broken.push(
          `${escapeMarkdown(repo)}: ${label} is disabled but policy requires it — coverage regression`
        )
      }
      if (source.state === 'available' && Number.isFinite(now)) {
        for (const [index, alert] of source.alerts.entries()) {
          const timestampProblem = alertTimestampProblem(alert, now)
          if (timestampProblem) {
            broken.push(
              `${escapeMarkdown(repo)}: ${label} alert ${index + 1} ${timestampProblem} — SLA cannot be evaluated safely`
            )
          }
        }
      }
    }
  }
  return { broken }
}

function renderSource(out, repo, key, source, toLine, now) {
  const label = SOURCE_LABELS[key]
  const policy = SOURCE_POLICY[repo]?.[key]
  const shapeProblem = sourceShapeProblem(source)
  if (shapeProblem) {
    out.push(
      `- ${label}: RESULT CORRUPT — ${escapeMarkdown(shapeProblem)}; the monitor is unhealthy.`
    )
    return
  }
  if (source.state === 'unavailable') {
    out.push(
      `- ${label}: NOT READABLE (${escapeMarkdown(source.reason ?? 'unknown cause')}${source.status ? `, HTTP ${source.status}` : ''}${source.permissions ? `; accepted permissions: ${escapeMarkdown(source.permissions)}` : ''}) — unknown, not zero. The monitor itself is unhealthy.`
    )
    return
  }
  if (source.state === 'disabled') {
    out.push(
      policy === 'expected-disabled'
        ? `- ${label}: disabled, as policy expects for this repository — a documented coverage gap, not a finding source.`
        : `- ${label}: DISABLED but policy requires it — coverage regression (${escapeMarkdown(source.reason ?? 'feature off')}).`
    )
    return
  }
  if (source.alerts.length === 0) {
    out.push(`- ${label}: none open.`)
    return
  }
  out.push(`- ${label}: ${source.alerts.length} open`)
  const lines = sortLines(source.alerts.map((alert) => toLine(alert, now)))
  for (const line of lines) out.push(line.text)
}

const LINE_BUILDERS = {
  dependabot: dependabotLine,
  codeScanning: codeScanningLine,
  secretScanning: secretScanningLine,
}

export function formatReport({ generatedAt, repos }) {
  const now = Date.parse(generatedAt)
  const health = monitorHealth({ repos, generatedAt })
  const out = [
    '## Security hygiene report',
    '',
    `Generated ${generatedAt} by the security-hygiene workflow (renovate-config).`,
    'Sources: Dependabot, code scanning, and secret scanning, per repository, under',
    'the per-repo policy in tools/security-policy.mjs. This report never dismisses',
    'or remediates; unreadable or policy-required-but-disabled sources make the',
    'monitor itself report unhealthy.',
    '',
    `Monitor health: ${health.broken.length === 0 ? 'OK' : `DEGRADED — ${health.broken.join('; ')}`}`,
    '',
  ]
  for (const entry of repos) {
    out.push(`### ${escapeMarkdown(entry.repo)}`, '')
    for (const key of SOURCE_KEYS) {
      renderSource(out, entry.repo, key, entry[key], LINE_BUILDERS[key], now)
    }
    out.push('')
  }
  out.push(
    'SLA policy (canonical: tools/security-policy.mjs; displayed in README.md →',
    'Security hygiene): Dependabot critical 1d / high 7d / medium 30d / low 90d;',
    'code scanning by security severity, else error 7d / warning 14d / note 30d;',
    'any open secret-scanning alert is immediately urgent. Deadlines are exact',
    'timestamps (created + N×24h), not floored days.',
    'Review cadence: manual during launch; daily after owner gates; a human reviews weekly.',
    'A dismissal needs a reason, owner, evidence, and review date — never dismiss to reach zero.'
  )
  return out.join('\n')
}

// GitHub caps issue bodies (65536 chars). The durable issue gets a body that
// provably fits; the complete report goes to the workflow artifact. Truncation
// is by rendered size at a line boundary, and says exactly what was omitted.
export const ISSUE_BODY_BUDGET = 60_000
export const SUMMARY_BODY_BUDGET = 900_000

function assertCharacterBudget(maxChars) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) {
    throw new RangeError('maxChars must be a non-negative safe integer')
  }
}

export function boundedMarkdown(
  fullText,
  { maxChars, suffixForOmittedLines }
) {
  assertCharacterBudget(maxChars)
  if (typeof suffixForOmittedLines !== 'function') {
    throw new TypeError('suffixForOmittedLines must be a function')
  }
  if (fullText.length <= maxChars) return fullText
  const lines = fullText.split('\n')
  const prefixLengths = [0]
  for (let index = 0; index < lines.length; index += 1) {
    prefixLengths.push(
      prefixLengths[index] + (index === 0 ? 0 : 1) + lines[index].length
    )
  }

  let low = 0
  let high = lines.length - 1
  let best = -1
  while (low <= high) {
    const kept = Math.floor((low + high) / 2)
    const suffix = suffixForOmittedLines(lines.length - kept)
    if (prefixLengths[kept] + suffix.length <= maxChars) {
      best = kept
      low = kept + 1
    } else {
      high = kept - 1
    }
  }
  if (best >= 0) {
    return `${lines.slice(0, best).join('\n')}${suffixForOmittedLines(lines.length - best)}`
  }
  return null
}

function assertByteBudget(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer')
  }
}

export function boundedMarkdownBytes(
  fullText,
  { maxBytes, suffixForOmittedLines }
) {
  assertByteBudget(maxBytes)
  if (typeof suffixForOmittedLines !== 'function') {
    throw new TypeError('suffixForOmittedLines must be a function')
  }
  if (Buffer.byteLength(fullText, 'utf8') <= maxBytes) return fullText
  const lines = fullText.split('\n')
  const prefixLengths = [0]
  for (let index = 0; index < lines.length; index += 1) {
    prefixLengths.push(
      prefixLengths[index] +
        (index === 0 ? 0 : 1) +
        Buffer.byteLength(lines[index], 'utf8')
    )
  }

  let low = 0
  let high = lines.length - 1
  let best = -1
  while (low <= high) {
    const kept = Math.floor((low + high) / 2)
    const suffix = suffixForOmittedLines(lines.length - kept)
    if (prefixLengths[kept] + Buffer.byteLength(suffix, 'utf8') <= maxBytes) {
      best = kept
      low = kept + 1
    } else {
      high = kept - 1
    }
  }
  if (best >= 0) {
    return `${lines.slice(0, best).join('\n')}${suffixForOmittedLines(lines.length - best)}`
  }
  return null
}

export function boundedIssueBody(fullReport, { maxChars = ISSUE_BODY_BUDGET } = {}) {
  assertCharacterBudget(maxChars)
  if (fullReport.length <= maxChars) return fullReport
  const fullSuffix = (omitted) =>
    `\n\n---\n**Truncated to fit the issue body**: ${omitted} line(s) omitted. The workflow attempted to upload the complete report as the \`security-hygiene-report\` artifact on this run. Every finding also remains available in each repository's Security tab.`
  const compactSuffix = (omitted) => `\n… ${omitted} line(s) omitted.`
  for (const makeSuffix of [fullSuffix, compactSuffix]) {
    const bounded = boundedMarkdown(fullReport, {
      maxChars,
      suffixForOmittedLines: makeSuffix,
    })
    if (bounded !== null) return bounded
  }
  if (maxChars === 0) return ''
  return '…'.slice(0, maxChars)
}

export function boundedSummaryBody(fullReport, { maxBytes = SUMMARY_BODY_BUDGET } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('maxBytes must be a positive safe integer')
  }
  // The caller writes `${body}\n`; reserve that final UTF-8 byte here so the
  // actual file appended to GITHUB_STEP_SUMMARY remains inside the budget.
  const contentBudget = maxBytes - 1
  if (Buffer.byteLength(fullReport, 'utf8') <= contentBudget) return fullReport
  const suffix = (omitted) =>
    `\n\n---\n**Job summary truncated**: ${omitted} line(s) omitted. The workflow attempted to upload the complete report as the \`security-hygiene-report\` artifact on this run.`
  return (
    boundedMarkdownBytes(fullReport, {
      maxBytes: contentBudget,
      suffixForOmittedLines: suffix,
    }) ?? (contentBudget >= Buffer.byteLength('…', 'utf8') ? '…' : '')
  )
}

export function countOverdue({ generatedAt, repos }) {
  const now = Date.parse(generatedAt)
  let overdue = 0
  for (const entry of repos) {
    const dependabotAlerts = entry.dependabot?.state === 'available' &&
      Array.isArray(entry.dependabot.alerts)
      ? entry.dependabot.alerts
      : []
    const codeScanningAlerts = entry.codeScanning?.state === 'available' &&
      Array.isArray(entry.codeScanning.alerts)
      ? entry.codeScanning.alerts
      : []
    const secretScanningAlerts = entry.secretScanning?.state === 'available' &&
      Array.isArray(entry.secretScanning.alerts)
      ? entry.secretScanning.alerts
      : []
    for (const alert of dependabotAlerts) {
      if (dependabotSla(alert, now).overdue) overdue += 1
    }
    for (const alert of codeScanningAlerts) {
      if (codeScanningSla(alert, now).overdue) overdue += 1
    }
    overdue += secretScanningAlerts.length // open secrets are always urgent
  }
  return overdue
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim())
    if (match) return match[1]
  }
  return null
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504])
const MAX_PAGES = 10

function unavailable(reason, details = {}) {
  return {
    state: 'unavailable',
    ...details,
    reason: singleLine(reason).slice(0, 160) || 'unknown failure',
    alerts: [],
  }
}

function requestSignal(timeoutMs, collectionSignal) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return collectionSignal ? AbortSignal.any([timeout, collectionSignal]) : timeout
}

function requestOptions(token, timeoutMs, collectionSignal) {
  return {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    signal: requestSignal(timeoutMs, collectionSignal),
  }
}

async function errorDetails(response) {
  let message = ''
  try {
    message = String((await response.json())?.message ?? '')
  } catch {
    // A non-JSON error body stays uncaptured; status is enough.
  }
  return {
    status: response.status,
    reason: singleLine(message).slice(0, 160) || `HTTP ${response.status}`,
    permissions: response.headers.get('x-accepted-github-permissions') ?? undefined,
    rateLimitRemaining: response.headers.get('x-ratelimit-remaining') ?? undefined,
  }
}

function codeScanningDisabled(status, message) {
  const normalized = singleLine(message).toLowerCase()
  return (
    status === 403 &&
    normalized.startsWith('code scanning is not enabled for this repository.')
  )
}

async function repositoryIsReadable({
  token,
  repositoryUrl,
  fetchImpl,
  timeoutMs,
  collectionSignal,
}) {
  if (!repositoryUrl) return false
  let parsed
  try {
    parsed = new URL(repositoryUrl)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  try {
    const repository = await fetchImpl(
      parsed.href,
      requestOptions(token, timeoutMs, collectionSignal)
    )
    return repository.ok
  } catch {
    return false
  }
}

// Paginated fetch with a timeout and one retry for transient statuses.
// Returns a structured source result; every failure keeps its cause (status,
// sanitized message, and the X-Accepted-GitHub-Permissions hint GitHub
// documents for diagnosing missing App grants).
export async function fetchSource({
  source,
  token,
  url,
  repositoryUrl,
  tokenFailureReason = 'no token minted',
  fetchImpl = fetch,
  retryDelayMs = 1000,
  timeoutMs = 30_000,
  collectionSignal,
}) {
  if (!SOURCE_KEYS.includes(source)) return unavailable(`unknown source: ${source}`)
  if (!token) return unavailable(tokenFailureReason)
  let allowedOrigin
  try {
    const initial = new URL(url)
    if (initial.protocol !== 'https:') return unavailable('request URL is not HTTPS')
    allowedOrigin = initial.origin
  } catch {
    return unavailable('invalid request URL')
  }
  const alerts = []
  let next = url
  let pages = 0
  while (next && pages < MAX_PAGES) {
    let parsedNext
    try {
      parsedNext = new URL(next)
    } catch {
      return unavailable('invalid pagination URL')
    }
    if (parsedNext.protocol !== 'https:' || parsedNext.origin !== allowedOrigin) {
      return unavailable('pagination link escaped the expected GitHub API origin')
    }
    pages += 1
    let response
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await fetchImpl(
          parsedNext.href,
          requestOptions(token, timeoutMs, collectionSignal)
        )
      } catch (error) {
        if (attempt === 0 && !collectionSignal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
          continue
        }
        return unavailable(
          `network failure: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      if (RETRYABLE_STATUS.has(response.status) && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
        continue
      }
      break
    }
    if (!response.ok) {
      const details = await errorDetails(response)
      const knownDisabledResponse =
        (source === 'codeScanning' &&
          codeScanningDisabled(details.status, details.reason)) ||
        (source === 'secretScanning' && details.status === 404)
      const disabled =
        knownDisabledResponse &&
        (await repositoryIsReadable({
            token,
            repositoryUrl,
            fetchImpl,
            timeoutMs,
            collectionSignal,
          }))
      return {
        state: disabled ? 'disabled' : 'unavailable',
        ...details,
        alerts: [],
      }
    }
    let page
    try {
      page = await response.json()
    } catch {
      return { state: 'unavailable', reason: 'invalid JSON from the API', alerts: [] }
    }
    if (!Array.isArray(page)) {
      return { state: 'unavailable', reason: 'unexpected response shape', alerts: [] }
    }
    alerts.push(...page)
    next = parseNextLink(response.headers.get('link'))
  }
  if (next) {
    return {
      state: 'unavailable',
      reason: `more than ${MAX_PAGES} pages of alerts; refusing to claim completeness`,
      alerts: [],
    }
  }
  return { state: 'available', alerts }
}

export function sourceRequestUrl(repo, source) {
  const base = `https://api.github.com/repos/${repo}`
  if (source === 'dependabot') return `${base}/dependabot/alerts?state=open&per_page=100`
  if (source === 'codeScanning') return `${base}/code-scanning/alerts?state=open&per_page=100`
  if (source === 'secretScanning') {
    return `${base}/secret-scanning/alerts?state=open&hide_secret=true&per_page=100`
  }
  throw new Error(`unknown security source: ${source}`)
}

function tokenSpec(tokens, source) {
  const spec = tokens[source]
  if (typeof spec === 'string') return { token: spec }
  return spec ?? {}
}

export async function collectReportSources({
  repos = Object.keys(SOURCE_POLICY),
  tokens = {},
  fetchImpl = fetch,
  retryDelayMs = 1000,
  requestTimeoutMs = 30_000,
  collectionTimeoutMs = COLLECTION_TIMEOUT_MS,
} = {}) {
  const controller = new AbortController()
  let deadlineResolve
  const deadline = new Promise((resolve) => {
    deadlineResolve = resolve
  })
  const timer = setTimeout(() => {
    deadlineResolve(unavailable('whole-report collection deadline exceeded'))
    controller.abort(new Error('whole-report collection deadline exceeded'))
  }, collectionTimeoutMs)

  const tasks = repos.flatMap((repo) =>
    SOURCE_KEYS.map(async (source) => {
      const spec = tokenSpec(tokens, source)
      const tokenFailureReason =
        spec.mintOutcome && spec.mintOutcome !== 'success' ? 'token mint failed' : 'no token minted'
      const operation = fetchSource({
        source,
        token: spec.token,
        tokenFailureReason,
        url: sourceRequestUrl(repo, source),
        repositoryUrl: `https://api.github.com/repos/${repo}`,
        fetchImpl,
        retryDelayMs,
        timeoutMs: requestTimeoutMs,
        collectionSignal: controller.signal,
      }).catch((error) =>
        unavailable(
          `unexpected collector failure: ${error instanceof Error ? error.message : String(error)}`
        )
      )
      const result = await Promise.race([operation, deadline])
      return { repo, source, result }
    })
  )

  try {
    const settled = await Promise.all(tasks)
    return repos.map((repo) => {
      const entry = { repo }
      for (const { source, result } of settled.filter((item) => item.repo === repo)) {
        entry[source] = result
      }
      return entry
    })
  } finally {
    clearTimeout(timer)
  }
}

function sameRepoSet(left, right) {
  return (
    left.length === new Set(left).size &&
    right.length === new Set(right).size &&
    left.length === right.length &&
    left.every((repo) => right.includes(repo))
  )
}

async function main() {
  const policyRepos = Object.keys(SOURCE_POLICY)
  const configuredRepos = (process.env.HYGIENE_REPOS ?? '')
    .split(',')
    .map((repo) => repo.trim())
    .filter(Boolean)
  if (configuredRepos.length > 0 && !sameRepoSet(configuredRepos, policyRepos)) {
    console.error(
      'security-hygiene-report: HYGIENE_REPOS must exactly match tools/security-policy.mjs.'
    )
    process.exitCode = REPORT_EXIT_CODES.usage
    return
  }
  const results = await collectReportSources({
    repos: policyRepos,
    tokens: {
      dependabot: {
        token: process.env.HYGIENE_DEPENDABOT_TOKEN,
        mintOutcome: process.env.HYGIENE_DEPENDABOT_MINT_OUTCOME,
      },
      codeScanning: {
        token: process.env.HYGIENE_CODE_SCANNING_TOKEN,
        mintOutcome: process.env.HYGIENE_CODE_SCANNING_MINT_OUTCOME,
      },
      secretScanning: {
        token: process.env.HYGIENE_SECRET_SCANNING_TOKEN,
        mintOutcome: process.env.HYGIENE_SECRET_SCANNING_MINT_OUTCOME,
      },
    },
  })
  const generatedAt = new Date().toISOString()
  const report = formatReport({ generatedAt, repos: results })
  process.stdout.write(`${report}\n`)
  const monitorBroken = monitorHealth({ repos: results, generatedAt }).broken.length > 0
  const overdueCount = countOverdue({ generatedAt, repos: results })
  // Broken and overdue are independent facts. The exit code prioritizes the
  // monitor (blindness may hide findings); the state file preserves both so
  // the workflow can label the durable issue with each.
  if (process.env.HYGIENE_STATE_FILE) {
    fs.writeFileSync(
      process.env.HYGIENE_STATE_FILE,
      `${JSON.stringify({ monitorBroken, overdueCount })}\n`
    )
  }
  if (process.env.HYGIENE_ISSUE_BODY_FILE) {
    fs.writeFileSync(process.env.HYGIENE_ISSUE_BODY_FILE, `${boundedIssueBody(report)}\n`)
  }
  if (process.env.HYGIENE_SUMMARY_FILE) {
    fs.writeFileSync(process.env.HYGIENE_SUMMARY_FILE, `${boundedSummaryBody(report)}\n`)
  }
  if (process.env.HYGIENE_ENFORCE === '1') {
    if (monitorBroken) process.exitCode = REPORT_EXIT_CODES.monitorBroken
    else if (overdueCount > 0) process.exitCode = REPORT_EXIT_CODES.overdue
  }
}

if (isMainModule(import.meta.url)) {
  await main()
}
