import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ageDays,
  boundedIssueBody,
  boundedMarkdown,
  boundedMarkdownBytes,
  boundedSummaryBody,
  codeScanningSeverity,
  collectReportSources,
  countOverdue,
  dependabotSeverity,
  escapeMarkdown,
  fetchSource,
  formatReport,
  monitorHealth,
  sourceRequestUrl,
} from './security-hygiene-report.mjs'
import {
  CODE_SCANNING_SLA,
  DEPENDABOT_SLA,
  desiredLabels,
  HYGIENE_APP_PERMISSIONS,
  RENOVATE_APP_PERMISSIONS,
  REPORT_EXIT_CODES,
  SOURCE_POLICY,
  UNKNOWN_SEVERITY_SLA_DAYS,
} from './security-policy.mjs'

const NOW = '2026-07-30T12:00:00Z'
// Policy repos: groundwork requires everything; roost expects scanning off.
const ALL_REQUIRED = 'jasondockery/groundwork'
const SCANNING_OFF = 'jasondockery/roost'
// Frozen from the live GitHub API on 2026-07-31. Do not paraphrase production
// responses in a classifier fixture: that exact mistake passed unit tests and
// left Roost permanently DEGRADED.
const LIVE_CODE_SCANNING_DISABLED_MESSAGE =
  'Code scanning is not enabled for this repository. Please enable code scanning in the repository settings.'

function available(alerts) {
  return { state: 'available', alerts }
}

function repoEntry(repo, overrides = {}) {
  return {
    repo,
    dependabot: available([]),
    codeScanning: available([]),
    secretScanning: available([]),
    ...overrides,
  }
}

function allPolicyEntries(overrides = {}) {
  return Object.keys(SOURCE_POLICY).map((repo) => repoEntry(repo, overrides[repo]))
}

function dependabotAlert({
  severity = 'high',
  name = 'left-pad',
  createdAt = '2026-07-28T00:00:00Z',
  fixed = '1.0.1',
  assignees = [],
} = {}) {
  return {
    created_at: createdAt,
    html_url: 'https://github.com/o/r/security/dependabot/1',
    security_advisory: { severity, summary: 'Prototype pollution in left-pad' },
    security_vulnerability: { first_patched_version: { identifier: fixed } },
    dependency: { package: { name }, scope: 'runtime', manifest_path: 'pnpm-lock.yaml' },
    assignees,
  }
}

function scanningAlert({
  toolSeverity = 'warning',
  securitySeverity,
  rule = 'zizmor/x',
  createdAt = '2026-07-28T00:00:00Z',
  location = 'ci.yml',
} = {}) {
  return {
    created_at: createdAt,
    html_url: 'https://github.com/o/r/security/code-scanning/2',
    rule: { severity: toolSeverity, security_severity_level: securitySeverity, id: rule },
    tool: { name: 'zizmor' },
    most_recent_instance: { location: { path: location } },
    assignees: [],
  }
}

test('an overdue critical dependabot alert is flagged, linked, and unassigned-marked', () => {
  const report = formatReport({
    generatedAt: NOW,
    repos: [
      repoEntry(ALL_REQUIRED, {
        dependabot: available([
          dependabotAlert({ severity: 'critical', createdAt: '2026-07-25T00:00:00Z' }),
        ]),
      }),
    ],
  })
  assert.match(report, /`critical` \| `runtime` \| `left-pad` .* OVERDUE \(5d, target 1d\)/)
  assert.match(report, /https:\/\/github\.com\/o\/r\/security\/dependabot\/1/)
  assert.match(report, /UNASSIGNED/)
})

test('SLA deadlines are exact timestamps: 1ms before, at, and after 24h', () => {
  const target = (offsetMs) =>
    formatReport({
      generatedAt: NOW,
      repos: [
        repoEntry(ALL_REQUIRED, {
          dependabot: available([
            dependabotAlert({
              severity: 'critical',
              createdAt: new Date(Date.parse(NOW) - 86_400_000 + offsetMs).toISOString(),
            }),
          ]),
        }),
      ],
    })
  assert.match(target(1), /within SLA/) // created 24h-1ms ago: deadline not reached
  assert.match(target(0), /OVERDUE/) // created exactly 24h ago: deadline reached
  assert.match(target(-1), /OVERDUE/) // created 24h+1ms ago
})

test('dependabot low gets 90 days, and code scanning tool levels stay ordered', () => {
  assert.ok(DEPENDABOT_SLA.low > DEPENDABOT_SLA.medium)
  assert.ok(CODE_SCANNING_SLA.error < CODE_SCANNING_SLA.warning)
})

test('code scanning prefers the security severity over the tool level', () => {
  assert.equal(
    codeScanningSeverity(scanningAlert({ toolSeverity: 'warning', securitySeverity: 'high' })),
    'high'
  )
  assert.equal(codeScanningSeverity(scanningAlert({ toolSeverity: 'warning' })), 'warning')
  assert.equal(codeScanningSeverity({ rule: {} }), 'unknown')
  assert.equal(dependabotSeverity({}), 'unknown')
})

test('unknown severity is triaged like high, and invalid timestamps never evaluate', () => {
  const report = formatReport({
    generatedAt: NOW,
    repos: [
      repoEntry(ALL_REQUIRED, {
        codeScanning: available([
          { ...scanningAlert({ createdAt: '2026-07-01T00:00:00Z' }), rule: { id: 'x' } },
        ]),
        dependabot: available([dependabotAlert({ createdAt: 'not-a-date' })]),
      }),
    ],
  })
  assert.match(report, /unknown severity — high SLA applied/)
  assert.match(report, /age unavailable; SLA not evaluated/)
  assert.doesNotMatch(report, /NaN/)
  assert.equal(ageDays('not-a-date', Date.parse(NOW)), null)
})

test('missing optional alert fields fall back honestly instead of crashing', () => {
  const report = formatReport({
    generatedAt: NOW,
    repos: [
      repoEntry(ALL_REQUIRED, {
        dependabot: available([{ created_at: NOW }]),
        codeScanning: available([{ created_at: NOW }]),
      }),
    ],
  })
  assert.match(report, /package unknown/)
  assert.match(report, /location unavailable/)
})

test('assignees render as profile links, never as bare mentions', () => {
  const report = formatReport({
    generatedAt: NOW,
    repos: [
      repoEntry(ALL_REQUIRED, {
        dependabot: available([dependabotAlert({ assignees: [{ login: 'octocat' }] })]),
      }),
    ],
  })
  assert.match(report, /\[octocat\]\(https:\/\/github\.com\/octocat\)/)
  assert.doesNotMatch(report, /(^|[^[(/])@octocat/)
})

test('diagnostic strings from the API are sanitized too', () => {
  const report = formatReport({
    generatedAt: NOW,
    repos: [
      repoEntry(ALL_REQUIRED, {
        secretScanning: {
          state: 'unavailable',
          reason: 'bad|reason\nwith newline',
          permissions: 'a|b',
          alerts: [],
        },
      }),
    ],
  })
  assert.match(report, /bad\\\|reason with newline/)
  assert.match(report, /accepted permissions: a\\\|b/)
  assert.equal(escapeMarkdown('a|b\nc`d'), 'a\\|b c\\`d')
})

test('an open secret-scanning alert is urgent regardless of age', () => {
  const repos = [
    repoEntry(ALL_REQUIRED, {
      secretScanning: available([
        {
          created_at: NOW,
          secret_type_display_name: 'GitHub App token',
          validity: 'active',
          html_url: 'https://github.com/o/r/security/secret-scanning/1',
          assignees: [],
        },
      ]),
    }),
  ]
  const report = formatReport({ generatedAt: NOW, repos })
  assert.match(report, /URGENT \| `GitHub App token` \| validity: `active`/)
  assert.match(report, /rotate the credential now/)
  assert.equal(countOverdue({ generatedAt: NOW, repos }), 1)
})

test('unknown secret validity is described as not evaluated or available', () => {
  const report = formatReport({
    generatedAt: NOW,
    repos: [
      repoEntry(ALL_REQUIRED, {
        secretScanning: available([{ created_at: NOW, validity: 'unknown' }]),
      }),
    ],
  })
  assert.match(report, /validity: `not evaluated\/available`/)
  assert.doesNotMatch(report, /validity: `unknown`/)
})

test('policy decides whether disabled is acceptable, per repository and source', () => {
  // roost: scanning expected-disabled → healthy, documented.
  const tolerated = monitorHealth({
    repos: allPolicyEntries({
      [SCANNING_OFF]: {
        codeScanning: { state: 'disabled', reason: 'not enabled', alerts: [] },
        secretScanning: { state: 'disabled', reason: 'not enabled', alerts: [] },
      },
    }),
  })
  assert.deepEqual(tolerated.broken, [])
  // groundwork: everything required → the same disabled state is a regression.
  const regression = monitorHealth({
    repos: allPolicyEntries({
      [ALL_REQUIRED]: {
        codeScanning: { state: 'disabled', reason: 'not enabled', alerts: [] },
      },
    }),
  })
  assert.equal(regression.broken.length, 1)
  assert.match(regression.broken[0], /disabled but policy requires it/)
  const report = formatReport({
    generatedAt: NOW,
    repos: [
      repoEntry(SCANNING_OFF, {
        codeScanning: { state: 'disabled', reason: 'not enabled', alerts: [] },
      }),
    ],
  })
  assert.match(report, /disabled, as policy expects for this repository/)
})

test('unavailable sources, missing source objects, and unpolicied repos all break the monitor', () => {
  const health = monitorHealth({
    repos: [
      repoEntry('jasondockery/renovate-config'),
      repoEntry(SCANNING_OFF, {
        dependabot: { state: 'unavailable', reason: 'no token minted', alerts: [] },
      }),
      { repo: ALL_REQUIRED, dependabot: available([]), codeScanning: available([]) }, // secretScanning missing
      repoEntry('jasondockery/not-in-policy'),
    ],
  })
  assert.equal(health.broken.length, 3)
  assert.match(health.broken[0], /Dependabot/)
  assert.match(health.broken[1], /missing or unrecognized/)
  assert.match(health.broken[2], /no expected-source policy/)
})

test('invalid and far-future alert timestamps break health without hiding urgent secrets', () => {
  const repos = allPolicyEntries({
    [ALL_REQUIRED]: {
      dependabot: available([dependabotAlert({ createdAt: 'not-a-date' })]),
      codeScanning: available([
        scanningAlert({ createdAt: '2026-07-30T12:05:00.001Z' }),
      ]),
      secretScanning: available([
        {
          created_at: 'not-a-date',
          secret_type_display_name: 'Credential',
        },
      ]),
    },
  })
  const health = monitorHealth({ repos, generatedAt: NOW })
  assert.equal(health.broken.length, 3)
  assert.match(health.broken.join('\n'), /no valid created_at/)
  assert.match(health.broken.join('\n'), /too far in the future/)
  assert.equal(countOverdue({ generatedAt: NOW, repos }), 1)
})

test('contradictory source states are corrupt and non-available alerts are never counted', () => {
  for (const source of [
    { state: 'disabled', reason: 'off', alerts: [dependabotAlert()] },
    { state: 'unavailable', reason: 'denied', alerts: [dependabotAlert()] },
    { state: 'unavailable', alerts: [] },
  ]) {
    const repos = allPolicyEntries({
      [ALL_REQUIRED]: { dependabot: source },
    })
    const health = monitorHealth({ repos, generatedAt: NOW })
    assert.equal(health.broken.length, 1)
    assert.match(health.broken[0], /monitor data corrupt/)
    assert.equal(countOverdue({ generatedAt: NOW, repos }), 0)
    assert.match(formatReport({ generatedAt: NOW, repos }), /RESULT CORRUPT/)
  }
})

test('every policy repo declares every source', () => {
  for (const [repo, sources] of Object.entries(SOURCE_POLICY)) {
    assert.deepEqual(
      Object.keys(sources).sort(),
      ['codeScanning', 'dependabot', 'secretScanning'],
      repo
    )
    for (const value of Object.values(sources)) {
      assert.ok(['required', 'expected-disabled'].includes(value))
    }
  }
})

test('the complete report contains every alert while the bounded issue states exact omissions', () => {
  const alerts = []
  for (let index = 0; index < 61; index += 1) {
    alerts.push(
      dependabotAlert({
        severity: 'low',
        name: `distinguishable-alert-${String(index + 1).padStart(2, '0')}`,
        createdAt: '2026-07-29T00:00:00Z',
      })
    )
  }
  alerts.push(dependabotAlert({ severity: 'critical', createdAt: '2026-07-01T00:00:00Z' }))
  const report = formatReport({
    generatedAt: NOW,
    repos: [repoEntry(ALL_REQUIRED, { dependabot: available(alerts) })],
  })
  const first = report.split('\n').find((line) => line.startsWith('  - '))
  assert.match(first, /`critical` .* OVERDUE/)
  assert.match(report, /distinguishable-alert-61/)
  const issueBody = boundedIssueBody(report, { maxChars: 2_000 })
  assert.doesNotMatch(issueBody, /distinguishable-alert-61/)
  assert.match(issueBody, /\d+ line\(s\) omitted/)
})

test('the issue body is bounded for small, oversized-line, Unicode, and exact budgets', () => {
  const longLine = `- ${'x'.repeat(200)}`
  const report = Array.from({ length: 500 }, () => longLine).join('\n')
  const bounded = boundedIssueBody(report, { maxChars: 10_000 })
  assert.ok(bounded.length <= 10_000)
  assert.match(bounded, /Truncated to fit the issue body.*\d+ line\(s\) omitted/s)
  assert.match(bounded, /security-hygiene-report.*artifact/)
  const short = boundedIssueBody('small report', { maxChars: 10_000 })
  assert.equal(short, 'small report')
  const tiny = boundedIssueBody(report, { maxChars: 100 })
  assert.ok(tiny.length <= 100)
  assert.match(tiny, /500 line\(s\) omitted/)
  const oversized = boundedIssueBody('x'.repeat(1_000), { maxChars: 80 })
  assert.ok(oversized.length <= 80)
  assert.match(oversized, /1 line\(s\) omitted/)
  const unicode = boundedIssueBody('🔐'.repeat(100), { maxChars: 50 })
  assert.ok(unicode.length <= 50)
  assert.equal(boundedIssueBody('exact', { maxChars: 5 }), 'exact')
})

test('generic Markdown bounding scales logarithmically and summary wording is delivery-honest', () => {
  const report = Array.from({ length: 9_000 }, (_, index) => `alert ${index}`).join('\n')
  let suffixCalls = 0
  const bounded = boundedMarkdown(report, {
    maxChars: 20_000,
    suffixForOmittedLines: (omitted) => {
      suffixCalls += 1
      return `\n${omitted} omitted`
    },
  })
  assert.ok(bounded.length <= 20_000)
  assert.match(bounded, /\d+ omitted$/)
  assert.ok(suffixCalls < 50, `expected logarithmic search, got ${suffixCalls} suffix calls`)
  const summary = boundedSummaryBody(report, { maxBytes: 2_000 })
  assert.ok(Buffer.byteLength(`${summary}\n`, 'utf8') <= 2_000)
  assert.match(summary, /Job summary truncated/)
  assert.match(summary, /attempted to upload/)
  assert.doesNotMatch(summary, /artifact exists|artifact is available/)
  const issue = boundedIssueBody(report, { maxChars: 2_000 })
  assert.match(issue, /attempted to upload/)
})

test('job summaries are bounded by UTF-8 bytes including their final newline', () => {
  for (const text of [
    '🔐'.repeat(200),
    'ภาษาไทย'.repeat(100),
    '漢字'.repeat(200),
    'e\u0301'.repeat(300),
  ]) {
    const summary = boundedSummaryBody(text, { maxBytes: 128 })
    assert.ok(Buffer.byteLength(`${summary}\n`, 'utf8') <= 128)
  }
  const exact = '🔐ไทย漢e\u0301'
  const exactBudget = Buffer.byteLength(`${exact}\n`, 'utf8')
  assert.equal(boundedSummaryBody(exact, { maxBytes: exactBudget }), exact)
  assert.equal(boundedSummaryBody('oversized', { maxBytes: 1 }), '')

  const byteBounded = boundedMarkdownBytes('🔐\nไทย\n漢字', {
    maxBytes: 18,
    suffixForOmittedLines: (omitted) => `\n${omitted} omitted`,
  })
  assert.ok(Buffer.byteLength(byteBounded, 'utf8') <= 18)
})

test('desiredLabels covers every state transition and preserves unmanaged labels', () => {
  const base = ['security-hygiene']
  // clean → overdue
  assert.deepEqual(desiredLabels(base, { monitorBroken: false, overdueCount: 2 }), [
    'security-hygiene',
    'security-overdue',
  ])
  // overdue → clean
  assert.deepEqual(
    desiredLabels(['security-hygiene', 'security-overdue'], { monitorBroken: false, overdueCount: 0 }),
    ['security-hygiene']
  )
  // clean → broken
  assert.deepEqual(desiredLabels(base, { monitorBroken: true, overdueCount: 0 }), [
    'security-hygiene',
    'security-monitor-broken',
  ])
  // broken → overdue
  assert.deepEqual(
    desiredLabels(['security-hygiene', 'security-monitor-broken'], {
      monitorBroken: false,
      overdueCount: 1,
    }),
    ['security-hygiene', 'security-overdue']
  )
  // both present, both facts preserved; then both → clean
  assert.deepEqual(desiredLabels(base, { monitorBroken: true, overdueCount: 1 }), [
    'security-hygiene',
    'security-monitor-broken',
    'security-overdue',
  ])
  assert.deepEqual(
    desiredLabels(['bug', 'security-hygiene', 'security-monitor-broken', 'security-overdue'], {
      monitorBroken: false,
      overdueCount: 0,
    }),
    ['bug', 'security-hygiene']
  )
})

test('the human-readable and executable policy cover every security source contract', () => {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8')
  for (const [severity, days] of Object.entries(DEPENDABOT_SLA)) {
    assert.match(
      readme,
      new RegExp(`\\| Dependabot \\| ${severity} \\| ${days} day`),
      `README missing Dependabot ${severity} = ${days}d`
    )
  }
  for (const severity of ['critical', 'high', 'medium', 'low']) {
    assert.equal(CODE_SCANNING_SLA[severity], DEPENDABOT_SLA[severity])
  }
  assert.match(readme, /error \/ warning \/ note \(tool level\) \| 7 \/ 14 \/ 30 days/)
  assert.match(readme, /Secret scanning \| any open alert \| immediately/)
  assert.match(readme, /Unknown severity is triaged like high/)
  assert.equal(UNKNOWN_SEVERITY_SLA_DAYS, DEPENDABOT_SLA.high)
  assert.deepEqual(SOURCE_POLICY, {
    'jasondockery/renovate-config': {
      dependabot: 'required',
      codeScanning: 'required',
      secretScanning: 'required',
    },
    'jasondockery/groundwork': {
      dependabot: 'required',
      codeScanning: 'required',
      secretScanning: 'required',
    },
    'jasondockery/roost': {
      dependabot: 'required',
      codeScanning: 'expected-disabled',
      secretScanning: 'expected-disabled',
    },
  })
})

function workflowStep(workflow, name) {
  const marker = `      - name: ${name}`
  const start = workflow.indexOf(marker)
  assert.notEqual(start, -1, `missing workflow step: ${name}`)
  const next = workflow.indexOf('\n      - name:', start + marker.length)
  return workflow.slice(start, next === -1 ? workflow.length : next)
}

function permissionInputs(step) {
  return Object.fromEntries(
    [...step.matchAll(/^\s+permission-([^:]+):\s*([^\s#]+).*$/gm)].map((match) => [
      match[1],
      match[2],
    ])
  )
}

test('workflow repository scopes and delivery contracts match authoritative policy', () => {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'security-hygiene.yml'),
    'utf8'
  )
  const expectedNames = Object.keys(SOURCE_POLICY)
    .map((repo) => repo.split('/')[1])
    .sort()
  assert.match(workflow, /^\s{2}workflow_call:$/m)
  assert.doesNotMatch(workflow, /^\s{2}workflow_dispatch:$/m)
  assert.doesNotMatch(workflow, /^\s+environment:/m)
  const guard = workflowStep(workflow, 'Refuse public output repository')
  assert.ok(
    workflow.indexOf('      - name: Refuse public output repository') <
      workflow.indexOf('      - name: Checkout implementation')
  )
  assert.match(guard, /gh api "repos\/\$GITHUB_REPOSITORY"/)
  assert.match(guard, /\$visibility" != "private"/)
  assert.match(guard, /\^\[0-9a-f\]\{40\}\$/)
  const checkout = workflowStep(workflow, 'Checkout implementation')
  assert.match(checkout, /repository: jasondockery\/renovate-config/)
  assert.match(checkout, /ref: \$\{\{ inputs\.implementation_ref \}\}/)
  assert.match(checkout, /path: renovate-config/)
  for (const name of [
    'Mint alerts token (GitHub App)',
    'Mint code-scanning token (GitHub App)',
    'Mint secret-scanning token (GitHub App)',
  ]) {
    const step = workflowStep(workflow, name)
    const repositories = /^\s+repositories:\s*(.+)$/m.exec(step)?.[1]
    assert.ok(repositories, `${name} must declare repositories`)
    assert.deepEqual(
      repositories
        .split(',')
        .map((repo) => repo.trim())
        .sort(),
      expectedNames,
      name
    )
    assert.match(step, /^\s+continue-on-error:\s+true$/m, name)
  }
  const build = workflowStep(workflow, 'Build report')
  assert.doesNotMatch(build, /HYGIENE_REPOS/)
  assert.match(build, /HYGIENE_ENFORCE: '1'/)
  assert.match(build, /HYGIENE_SUMMARY_FILE: security-hygiene-summary\.md/)
  assert.match(build, /cat security-hygiene-summary\.md/)
  assert.doesNotMatch(build, /cat security-hygiene-report\.md/)
  for (const source of ['DEPENDABOT', 'CODE_SCANNING', 'SECRET_SCANNING']) {
    assert.match(build, new RegExp(`HYGIENE_${source}_MINT_OUTCOME:`))
  }
  const issueIndex = workflow.indexOf('      - name: Upsert the durable report issue')
  const artifactProofIndex = workflow.indexOf('      - name: Prove complete report files')
  const artifactIndex = workflow.indexOf('      - name: Upload complete report artifact')
  const enforceIndex = workflow.indexOf('      - name: Enforce alert states')
  assert.ok(issueIndex < artifactProofIndex && artifactProofIndex < artifactIndex && artifactIndex < enforceIndex)
  for (const name of [
    'Upsert the durable report issue',
    'Upload complete report artifact',
    'Enforce alert states',
  ]) {
    assert.match(workflowStep(workflow, name), /if: \$\{\{ !cancelled\(\)/)
  }
  assert.match(
    workflowStep(workflow, 'Upsert the durable report issue'),
    /Could not parse created issue number/
  )
  assert.match(workflowStep(workflow, 'Upsert the durable report issue'), /gh api --paginate --slurp/)
  assert.match(workflowStep(workflow, 'Upsert the durable report issue'), /state=all/)
  assert.match(workflowStep(workflow, 'Upsert the durable report issue'), /Durable report issue is closed/)
  assert.doesNotMatch(workflowStep(workflow, 'Upsert the durable report issue'), /--limit/)
  assert.doesNotMatch(workflowStep(workflow, 'Upsert the durable report issue'), /issues\/\$number\/labels/)
  assert.match(workflowStep(workflow, 'Upsert the durable report issue'), /--add-label/)
  assert.match(workflowStep(workflow, 'Upsert the durable report issue'), /--remove-label/)
  assert.match(workflowStep(workflow, 'Upload complete report artifact'), /retention-days: 30/)
  assert.match(workflowStep(workflow, 'Prove complete report files'), /test -s "\$file"/)
  assert.match(workflowStep(workflow, 'Prove complete report files'), /sha256sum/)
  assert.match(workflowStep(workflow, 'Upload complete report artifact'), /if-no-files-found: error/)
  assert.match(workflowStep(workflow, 'Upload complete report artifact'), /security-hygiene-artifact\.sha256/)
  assert.match(workflowStep(workflow, 'Report run timing'), /tools\/renovate-config-receipt\.mjs/)
  assert.match(workflowStep(workflow, 'Report run timing'), /security-hygiene-run\.json/)
  assert.match(workflowStep(workflow, 'Report run timing'), /--tested-sha "\$IMPLEMENTATION_REF"/)
  assert.match(workflowStep(workflow, 'Report run timing'), /--implementation-sha "\$IMPLEMENTATION_REF"/)
  assert.match(workflowStep(workflow, 'Report run timing'), /--caller-sha "\$CALLER_SHA"/)
  assert.match(workflowStep(workflow, 'Report run timing'), /Caller repository/)
  assert.match(workflowStep(workflow, 'Report run timing'), /ARTIFACT_OUTCOME/)
  assert.match(workflowStep(workflow, 'Report run timing'), /Artifact manifest SHA-256/)
  assert.match(workflowStep(workflow, 'Upload complete report artifact'), /hygiene-state\.json/)
  assert.match(workflowStep(workflow, 'Upload run receipt'), /security-hygiene-run\.json/)
  assert.match(workflowStep(workflow, 'Upload run receipt'), /retention-days: 30/)
  assert.doesNotMatch(workflow, /^\s+schedule:/m)
  for (const name of ['Build report', 'Upsert the durable report issue', 'Enforce alert states']) {
    assert.match(workflowStep(workflow, name), /run: \|\n\s+set -euo pipefail/)
  }
  assert.match(build, /security-hygiene-state\.mjs hygiene-state\.json/)
  assert.match(
    build,
    new RegExp(
      `${REPORT_EXIT_CODES.success}\\|${REPORT_EXIT_CODES.overdue}\\|${REPORT_EXIT_CODES.monitorBroken}\\)`
    )
  )
  assert.match(workflowStep(workflow, 'Upsert the durable report issue'), /jq -er 'length'/)
  assert.match(workflowStep(workflow, 'Enforce alert states'), /Invalid monitor_broken output/)
  assert.match(workflowStep(workflow, 'Enforce alert states'), /Invalid overdue_count output/)
})

test('App permission policy matches both workflows and the README grant table', () => {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const renovateWorkflow = fs.readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'renovate.yml'),
    'utf8'
  )
  const hygieneWorkflow = fs.readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'security-hygiene.yml'),
    'utf8'
  )
  assert.deepEqual(
    permissionInputs(workflowStep(renovateWorkflow, 'Mint runner token (GitHub App)')),
    RENOVATE_APP_PERMISSIONS
  )
  const hygieneSteps = {
    dependabot: 'Mint alerts token (GitHub App)',
    codeScanning: 'Mint code-scanning token (GitHub App)',
    secretScanning: 'Mint secret-scanning token (GitHub App)',
  }
  for (const [source, name] of Object.entries(hygieneSteps)) {
    assert.deepEqual(
      permissionInputs(workflowStep(hygieneWorkflow, name)),
      HYGIENE_APP_PERMISSIONS[source],
      name
    )
  }

  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8')
  const displayNames = {
    administration: 'Administration',
    checks: 'Checks',
    contents: 'Contents',
    issues: 'Issues',
    metadata: 'Metadata',
    'pull-requests': 'Pull requests',
    statuses: 'Commit statuses',
    'vulnerability-alerts': 'Dependabot alerts',
    workflows: 'Workflows',
    'security-events': 'Code scanning alerts',
    'secret-scanning-alerts': 'Secret scanning alerts',
  }
  const union = {
    ...RENOVATE_APP_PERMISSIONS,
    ...HYGIENE_APP_PERMISSIONS.dependabot,
    ...HYGIENE_APP_PERMISSIONS.codeScanning,
    ...HYGIENE_APP_PERMISSIONS.secretScanning,
  }
  for (const [permission, access] of Object.entries(union)) {
    const displayAccess = access === 'write' ? 'Read and write' : 'Read-only'
    assert.match(
      readme,
      new RegExp(
        `\\| ${displayNames[permission]} \\| ${displayAccess.replaceAll(' ', '\\s+')} \\|`
      ),
      permission
    )
  }
  assert.match(readme, /Members: Read-only.*intentionally/s)
})

test('the runbook renders every canonical report exit code', () => {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const runbook = fs.readFileSync(
    path.join(repoRoot, 'docs', 'runbooks', 'security-hygiene.md'),
    'utf8'
  )
  for (const [name, code] of Object.entries(REPORT_EXIT_CODES)) {
    assert.match(runbook, new RegExp(`\\| ${code} \\| ${name} \\|`), name)
  }
})

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  }
}

function fetchArgs(source, overrides = {}) {
  return {
    source,
    token: 'token',
    url: sourceRequestUrl(ALL_REQUIRED, source),
    repositoryUrl: `https://api.github.com/repos/${ALL_REQUIRED}`,
    retryDelayMs: 0,
    ...overrides,
  }
}

test('fetchSource follows pagination past 100 alerts', async () => {
  const pageOne = Array.from({ length: 100 }, (_, index) => ({ number: index }))
  const urls = []
  const result = await fetchSource(fetchArgs('dependabot', {
    fetchImpl: async (url) => {
      urls.push(url)
      if (urls.length === 1) {
        return jsonResponse(pageOne, {
          headers: {
            link: `<https://api.github.com/repos/${ALL_REQUIRED}/dependabot/alerts?page=2>; rel="next"`,
          },
        })
      }
      return jsonResponse([{ number: 100 }])
    },
  }))
  assert.equal(result.state, 'available')
  assert.equal(result.alerts.length, 101)
})

test('fetchSource keeps the cause on 403, including the permissions hint', async () => {
  const result = await fetchSource(fetchArgs('dependabot', {
    fetchImpl: async () =>
      jsonResponse(
        { message: 'Resource not accessible by integration' },
        { status: 403, headers: { 'x-accepted-github-permissions': 'vulnerability_alerts=read' } }
      ),
  }))
  assert.equal(result.state, 'unavailable')
  assert.equal(result.status, 403)
  assert.equal(result.permissions, 'vulnerability_alerts=read')
})

test('source-specific disabled classification rejects ambiguous and permission failures', async () => {
  let disabledCalls = 0
  const disabled = await fetchSource(fetchArgs('codeScanning', {
    fetchImpl: async () => {
      disabledCalls += 1
      return disabledCalls === 1
        ? jsonResponse({ message: LIVE_CODE_SCANNING_DISABLED_MESSAGE }, { status: 403 })
        : jsonResponse({ full_name: ALL_REQUIRED })
    },
  }))
  assert.equal(disabled.state, 'disabled')
  assert.equal(disabledCalls, 2)

  const unreadableRepository = await fetchSource(fetchArgs('codeScanning', {
    fetchImpl: async () =>
      jsonResponse({ message: LIVE_CODE_SCANNING_DISABLED_MESSAGE }, { status: 403 }),
  }))
  assert.equal(unreadableRepository.state, 'unavailable')

  for (const message of [
    'Access disabled by organization policy',
    'GitHub App disabled',
    'Feature access is not enabled for this token',
    'Resource not accessible by integration',
  ]) {
    const result = await fetchSource(fetchArgs('codeScanning', {
      fetchImpl: async () => jsonResponse({ message }, { status: 403 }),
    }))
    assert.equal(result.state, 'unavailable', message)
  }

  const repositoryNotFound = await fetchSource(fetchArgs('secretScanning', {
    fetchImpl: async () => jsonResponse({ message: 'Not Found' }, { status: 404 }),
  }))
  assert.equal(repositoryNotFound.state, 'unavailable')

  let secretCalls = 0
  const verifiedSecretDisabled = await fetchSource(fetchArgs('secretScanning', {
    fetchImpl: async () => {
      secretCalls += 1
      return secretCalls === 1
        ? jsonResponse({ message: 'Not Found' }, { status: 404 })
        : jsonResponse({ full_name: ALL_REQUIRED })
    },
  }))
  assert.equal(verifiedSecretDisabled.state, 'disabled')

  const appUnavailable = await fetchSource(fetchArgs('dependabot', {
    fetchImpl: async () =>
      jsonResponse({ message: 'GitHub App installation unavailable' }, { status: 403 }),
  }))
  assert.equal(appUnavailable.state, 'unavailable')

  const ambiguousExpectedDisabled = monitorHealth({
    repos: allPolicyEntries({
      [SCANNING_OFF]: {
        secretScanning: unavailableResult('Not Found', 404),
      },
    }),
  })
  assert.equal(ambiguousExpectedDisabled.broken.length, 1)

  const requiredFeatureDisabled = monitorHealth({
    repos: allPolicyEntries({
      [ALL_REQUIRED]: {
        codeScanning: { state: 'disabled', reason: 'verified feature state', alerts: [] },
      },
    }),
  })
  assert.match(requiredFeatureDisabled.broken.join('\n'), /coverage regression/)
})

function unavailableResult(reason, status) {
  return { state: 'unavailable', reason, status, alerts: [] }
}

test('fetchSource retries transient statuses and rejects external pagination origins', async () => {
  let calls = 0
  const recovered = await fetchSource(fetchArgs('dependabot', {
    fetchImpl: async () => {
      calls += 1
      return calls === 1 ? jsonResponse({ message: 'unavailable' }, { status: 503 }) : jsonResponse([])
    },
  }))
  assert.equal(recovered.state, 'available')
  assert.equal(calls, 2)

  let externalCalls = 0
  const external = await fetchSource(fetchArgs('dependabot', {
    fetchImpl: async () => {
      externalCalls += 1
      return jsonResponse([], {
        headers: { link: '<https://attacker.example/steal>; rel="next"' },
      })
    },
  }))
  assert.equal(external.state, 'unavailable')
  assert.match(external.reason, /escaped the expected GitHub API origin/)
  assert.equal(externalCalls, 1)
})

test('fetchSource reports missing token, invalid JSON, network failure, and wrong shape', async () => {
  const mintFailure = await fetchSource(fetchArgs('dependabot', {
    token: '',
    tokenFailureReason: 'token mint failed',
  }))
  assert.equal(mintFailure.state, 'unavailable')
  assert.equal(mintFailure.reason, 'token mint failed')
  const badJson = await fetchSource(fetchArgs('dependabot', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new Error('bad json')
      },
    }),
  }))
  assert.match(badJson.reason, /invalid JSON/)
  const network = await fetchSource(fetchArgs('dependabot', {
    fetchImpl: async () => {
      throw new Error('socket hang up')
    },
  }))
  assert.match(network.reason, /network failure: socket hang up/)
  const shape = await fetchSource(fetchArgs('dependabot', {
    fetchImpl: async () => jsonResponse({ not: 'an array' }),
  }))
  assert.match(shape.reason, /unexpected response shape/)
})

test('secret-scanning URLs hide literals before the request leaves the process', () => {
  for (const repo of Object.keys(SOURCE_POLICY)) {
    const parsed = new URL(sourceRequestUrl(repo, 'secretScanning'))
    assert.equal(parsed.searchParams.get('hide_secret'), 'true')
  }
})

test('all nine independent source timeouts become a degraded report within the collection budget', async () => {
  const started = Date.now()
  const repos = await collectReportSources({
    tokens: {
      dependabot: 'token',
      codeScanning: 'token',
      secretScanning: 'token',
    },
    fetchImpl: async () => new Promise(() => {}),
    retryDelayMs: 0,
    requestTimeoutMs: 60_000,
    collectionTimeoutMs: 25,
  })
  assert.ok(Date.now() - started < 1_000)
  assert.equal(repos.length, 3)
  for (const entry of repos) {
    for (const source of ['dependabot', 'codeScanning', 'secretScanning']) {
      assert.equal(entry[source].state, 'unavailable')
      assert.match(entry[source].reason, /collection deadline/)
    }
  }
  assert.equal(monitorHealth({ repos }).broken.length, 9)
  assert.match(formatReport({ generatedAt: NOW, repos }), /Monitor health: DEGRADED/)
})

test('available results without alert arrays are corrupt, not renderer crashes', () => {
  const repos = allPolicyEntries({
    [ALL_REQUIRED]: { dependabot: { state: 'available' } },
  })
  assert.match(monitorHealth({ repos }).broken.join('\n'), /alerts are not an array/)
  assert.match(formatReport({ generatedAt: NOW, repos }), /RESULT CORRUPT/)
  assert.equal(countOverdue({ generatedAt: NOW, repos }), 0)
})

test('API display values cannot inject Markdown or off-origin alert links', () => {
  const report = formatReport({
    generatedAt: NOW,
    repos: [
      repoEntry(ALL_REQUIRED, {
        dependabot: available([
          dependabotAlert({
            name: '[click](https://attacker.example)',
            assignees: [{ login: 'bad/login' }, { login: 'good-user' }],
          }),
        ].map((alert) => ({ ...alert, html_url: 'https://attacker.example/alert' }))),
      }),
    ],
  })
  assert.doesNotMatch(report, / — https:\/\/attacker\.example/)
  assert.match(report, /https:\/\/github\.com\/good-user/)
  assert.match(report, /`\[click\]\(https:\/\/attacker\.example\)`/)
})

test('the CLI runs through a symlink in a spaces path, and import does not run main', (t) => {
  if (process.platform === 'win32') return t.skip('posix symlink fixture')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene cli '))
  const link = path.join(dir, 'report-link.mjs')
  fs.symlinkSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'security-hygiene-report.mjs'),
    link
  )
  try {
    const result = spawnSync(process.execPath, [link], {
      encoding: 'utf8',
      env: { ...process.env, HYGIENE_REPOS: '' },
    })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /Monitor health: DEGRADED/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
