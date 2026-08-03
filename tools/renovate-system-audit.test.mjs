import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  RENOVATE_BOT_LOGIN,
  TARGET_REPOSITORIES,
  auditSystem,
  parseArguments,
  parseDashboard,
  renderAudit,
  summarizeChecks,
} from './renovate-system-audit.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const run = {
  attempt: 1,
  conclusion: 'success',
  databaseId: 123,
  event: 'schedule',
  headSha: 'a'.repeat(40),
  startedAt: '2026-08-04T01:17:00Z',
  updatedAt: '2026-08-04T01:22:00Z',
  status: 'completed',
  url: 'https://github.com/example/actions/runs/123',
}

const receipt = {
  schema: 'renovate-config.run-receipt',
  receiptKind: 'renovate-run',
  runId: 123,
  runAttempt: 1,
  testedSha: run.headSha,
  result: 'passed',
  facts: {
    'Container log preflight': 'passed',
    'Raw structured log': 'deleted before receipt publication',
    'Private log directory': 'removed before receipt publication',
  },
  repositories: TARGET_REPOSITORIES.map((repository) => ({ repository, result: 'passed' })),
}

function dashboard(sections, updatedAt = '2026-08-04T01:18:00Z') {
  const body = Object.entries(sections).flatMap(([heading, count]) => [
    `## ${heading}`,
    ...Array.from({ length: count }, (_, index) => `- [ ] update-${index}`),
  ]).join('\n')
  return { body, updatedAt, url: 'https://github.com/example/issues/1' }
}

function repositories(overrides = {}) {
  return TARGET_REPOSITORIES.map((repository) => ({
    repository,
    dashboard: dashboard({ 'Awaiting Schedule': 1, 'Detected Dependencies': 0 }),
    branches: [],
    pullRequests: [],
    ...overrides[repository],
  }))
}

function renovatePr(overrides = {}) {
  return {
    number: 35,
    title: 'update dependencies',
    url: 'https://github.com/jasondockery/roost/pull/35',
    headRefName: 'self-hosted-renovate/non-major',
    headRefOid: 'b'.repeat(40),
    baseRefName: 'main',
    author: { login: RENOVATE_BOT_LOGIN },
    createdAt: '2026-08-04T01:18:00Z',
    updatedAt: '2026-08-04T01:19:00Z',
    state: 'OPEN',
    closedAt: null,
    mergedAt: null,
    statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    ...overrides,
  }
}

test('parses recognized dashboard evidence without treating unknown sections as proof', () => {
  assert.deepEqual(parseDashboard(`
## Pending Status Checks
- [ ] one
- [x] two
## Awaiting Schedule
- [ ] three
- [ ] <!-- create-all-awaiting-schedule-prs -->create all
## Pending Approval
- [ ] four
## Rate Limited
- [ ] five
## Open
- [ ] six
## Detected Dependencies
text
## Unrecognized
- [ ] ignored
`), {
    pendingStatusChecks: 2,
    awaitingSchedule: 1,
    awaitingApproval: 1,
    rateLimited: 1,
    open: 1,
    detectedDependencies: 0,
    repositoryProblems: 0,
    warnings: 0,
    errored: 0,
    configMigration: 0,
    ignoredOrBlocked: 0,
    recognizedSections: [
      'awaitingApproval',
      'awaitingSchedule',
      'detectedDependencies',
      'open',
      'pendingStatusChecks',
      'rateLimited',
    ],
    headings: [
      'Pending Status Checks',
      'Awaiting Schedule',
      'Pending Approval',
      'Rate Limited',
      'Open',
      'Detected Dependencies',
      'Unrecognized',
    ],
    unknownSections: ['Unrecognized'],
  })
})

test('summarizes GitHub check states without treating an empty check set as green', () => {
  assert.equal(summarizeChecks([]), 'unknown')
  assert.equal(summarizeChecks([{ status: 'IN_PROGRESS' }]), 'pending')
  assert.equal(summarizeChecks([{ conclusion: 'SUCCESS' }, { conclusion: 'NEUTRAL' }]), 'passed')
  assert.equal(summarizeChecks([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }]), 'failed')
})

test('accepts a fresh out-of-window dashboard explanation', () => {
  const audit = auditSystem({ run, receipt, repositories: repositories() })
  assert.equal(audit.result, 'passed')
  assert.equal(audit.repositories.every(({ explanation }) => /outside the weekly routine update window/.test(explanation)), true)
  assert.match(renderAudit(audit), /Awaiting weekly update window: 1/)
})

test('keeps stale dashboard evidence pending and fails absent or unrecognized evidence', () => {
  const stale = repositories({
    'jasondockery/groundwork': {
      dashboard: dashboard({ 'Detected Dependencies': 0 }, '2026-08-03T01:17:00Z'),
    },
  })
  const staleAudit = auditSystem({ run, receipt, repositories: stale })
  assert.equal(staleAudit.result, 'pending')
  assert.match(renderAudit(staleAudit), /predates the selected run/)

  const unrecognized = repositories({
    'jasondockery/groundwork': { dashboard: dashboard({ Unknown: 1 }) },
  })
  assert.equal(auditSystem({ run, receipt, repositories: unrecognized }).result, 'failed')

  const laterRun = repositories({
    'jasondockery/groundwork': {
      dashboard: dashboard({ 'Detected Dependencies': 0 }, '2026-08-04T02:00:00Z'),
    },
  })
  const laterAudit = auditSystem({ run, receipt, repositories: laterRun })
  assert.equal(laterAudit.result, 'failed')
  assert.match(renderAudit(laterAudit), /not attributable to the selected run/)
})

test('parses real dashboard problem, error, migration, and blocked section shapes', () => {
  const fixture = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'tools/fixtures/github/renovate-dashboard-problems.json'),
    'utf8'
  ))
  assert.equal(fixture.schema, 'renovate-config.github-dashboard-fixture')
  const counts = parseDashboard(fixture.body)
  assert.equal(counts.repositoryProblems, 2)
  assert.equal(counts.warnings, 1)
  assert.equal(counts.errored, 1)
  assert.equal(counts.configMigration, 1)
  assert.equal(counts.ignoredOrBlocked, 2)

  const state = repositories({
    'jasondockery/groundwork': { dashboard: { ...dashboard({}), body: fixture.body } },
  })
  const audit = auditSystem({ run, receipt, repositories: state })
  assert.equal(audit.result, 'failed')
  assert.match(renderAudit(audit), /repository problems, warnings, or errored updates/)
})

test('does not infer no eligible updates from Detected Dependencies alone', () => {
  const state = repositories()
  for (const entry of state) entry.dashboard = dashboard({ 'Detected Dependencies': 1 })
  const audit = auditSystem({ run, receipt, repositories: state })
  assert.equal(audit.result, 'pending')
  assert.match(renderAudit(audit), /Detected Dependencies alone is not proof/)
})

test('pending status checks, rate limiting, and approval remain pending', () => {
  for (const heading of ['Pending Status Checks', 'Rate Limited', 'Pending Approval']) {
    const state = repositories({
      'jasondockery/roost': { dashboard: dashboard({ [heading]: 1, 'Detected Dependencies': 0 }) },
    })
    const audit = auditSystem({ run, receipt, repositories: state })
    assert.equal(audit.result, 'pending', heading)
  }
})

test('fails when a delayed Monday schedule misses eligible updates', () => {
  const delayed = {
    ...run,
    startedAt: '2026-08-03T04:05:00Z',
    updatedAt: '2026-08-03T04:10:00Z',
  }
  const state = repositories()
  for (const entry of state) entry.dashboard.updatedAt = '2026-08-03T04:06:00Z'
  const audit = auditSystem({ run: delayed, receipt, repositories: state })
  assert.equal(audit.result, 'failed')
  assert.match(renderAudit(audit), /began after the weekly routine update window/)
})

test('binds accepted PR evidence to author, branch SHA, base, and selected-run time', () => {
  const pr = renovatePr()
  const state = repositories({
    'jasondockery/roost': {
      dashboard: dashboard({ Open: 1, 'Detected Dependencies': 0 }),
      branches: [{ name: pr.headRefName, sha: pr.headRefOid }],
      pullRequests: [pr],
    },
  })
  const audit = auditSystem({ run, receipt, repositories: state })
  assert.equal(audit.result, 'passed')
  assert.equal(audit.repositories.find(({ repository }) => repository.endsWith('/roost')).pullRequests.length, 1)

  for (const changed of [
    { author: { login: 'someone-else[bot]' } },
    { baseRefName: 'release' },
    { headRefOid: 'c'.repeat(40) },
    { createdAt: '2026-08-01T01:18:00Z', updatedAt: '2026-08-01T01:19:00Z' },
  ]) {
    const old = renovatePr(changed)
    const oldState = repositories({
      'jasondockery/roost': {
        dashboard: dashboard({ Open: 1, 'Detected Dependencies': 0 }),
        branches: [{ name: old.headRefName, sha: 'b'.repeat(40) }],
        pullRequests: [old],
      },
    })
    assert.notEqual(auditSystem({ run, receipt, repositories: oldState }).result, 'passed')
  }
})

test('retains merged and closed current-run PR evidence without a live branch', () => {
  for (const stateName of ['MERGED', 'CLOSED']) {
    const pr = renovatePr({
      state: stateName,
      createdAt: '2026-08-01T01:18:00Z',
      updatedAt: '2026-08-01T01:19:00Z',
      closedAt: '2026-08-04T01:20:00Z',
      mergedAt: stateName === 'MERGED' ? '2026-08-04T01:20:00Z' : null,
    })
    const state = repositories({
      'jasondockery/roost': {
        dashboard: dashboard({ Open: 1 }),
        branches: [],
        pullRequests: [pr],
      },
    })
    const audit = auditSystem({ run, receipt, repositories: state })
    const row = audit.repositories.find(({ repository }) => repository.endsWith('/roost'))
    assert.equal(row.pullRequests.length, 1, stateName)
    assert.equal(row.pullRequests[0].state, stateName)
  }
})

test('historical closed PR metadata edits do not create attribution or identity failures', () => {
  for (const stateName of ['MERGED', 'CLOSED']) {
    const pr = renovatePr({
      state: stateName,
      author: { login: 'historical-import[bot]' },
      createdAt: '2026-07-01T01:18:00Z',
      updatedAt: '2026-08-04T01:19:00Z',
      closedAt: '2026-07-02T01:20:00Z',
      mergedAt: stateName === 'MERGED' ? '2026-07-02T01:20:00Z' : null,
    })
    const state = repositories({
      'jasondockery/roost': {
        dashboard: dashboard({ Open: 1 }),
        branches: [],
        pullRequests: [pr],
      },
    })
    const audit = auditSystem({ run, receipt, repositories: state })
    const row = audit.repositories.find(({ repository }) => repository.endsWith('/roost'))
    assert.equal(row.pullRequests.length, 0, stateName)
    assert.doesNotMatch(row.problems.join('\n'), /unexpected author or base branch/, stateName)
  }
})

test('wrong-author or wrong-base Renovate-prefix PRs fail and cannot mask branches', () => {
  for (const changed of [
    { author: { login: 'someone-else[bot]' } },
    { baseRefName: 'release' },
  ]) {
    const pr = renovatePr(changed)
    const state = repositories({
      'jasondockery/roost': {
        dashboard: dashboard({ Open: 1 }),
        branches: [{ name: pr.headRefName, sha: pr.headRefOid }],
        pullRequests: [pr],
      },
    })
    const audit = auditSystem({ run, receipt, repositories: state })
    assert.equal(audit.result, 'failed')
    assert.match(renderAudit(audit), /unexpected author or base branch/)
    assert.match(renderAudit(audit), /without a matching open PR/)
  }
})

test('fails an attributable PR with red CI and reports incomplete checks as pending', () => {
  const failed = renovatePr({ statusCheckRollup: [{ conclusion: 'FAILURE' }] })
  const failedState = repositories({
    'jasondockery/roost': {
      dashboard: dashboard({ Open: 1 }),
      branches: [{ name: failed.headRefName, sha: failed.headRefOid }],
      pullRequests: [failed],
    },
  })
  assert.equal(auditSystem({ run, receipt, repositories: failedState }).result, 'failed')

  const incomplete = renovatePr({ statusCheckRollup: [{ status: 'IN_PROGRESS' }] })
  const pendingState = repositories({
    'jasondockery/roost': {
      dashboard: dashboard({ Open: 1 }),
      branches: [{ name: incomplete.headRefName, sha: incomplete.headRefOid }],
      pullRequests: [incomplete],
    },
  })
  assert.equal(auditSystem({ run, receipt, repositories: pendingState }).result, 'pending')
})

test('fails an orphan branch and an old green PR cannot satisfy the current run', () => {
  const state = repositories({
    'jasondockery/roost': {
      dashboard: dashboard({ Open: 1 }),
      branches: [{ name: 'self-hosted-renovate/orphan', sha: 'c'.repeat(40) }],
      pullRequests: [],
    },
    'jasondockery/groundwork': {
      dashboard: dashboard({ Open: 1 }),
      branches: [{ name: 'self-hosted-renovate/old', sha: 'd'.repeat(40) }],
      pullRequests: [renovatePr({
        headRefName: 'self-hosted-renovate/old',
        headRefOid: 'd'.repeat(40),
        createdAt: '2026-08-01T01:18:00Z',
        updatedAt: '2026-08-01T01:19:00Z',
      })],
    },
  })
  const audit = auditSystem({ run, receipt, repositories: state })
  assert.equal(audit.result, 'failed')
  assert.match(renderAudit(audit), /branch without a matching open PR/)
  assert.equal(audit.repositories.find(({ repository }) => repository.endsWith('/groundwork')).result, 'pending')
})

test('fails closed on receipt identity or cleanup drift', () => {
  const changed = {
    ...receipt,
    testedSha: 'b'.repeat(40),
    facts: { ...receipt.facts, 'Raw structured log': 'missing' },
  }
  const audit = auditSystem({ run, receipt: changed, repositories: repositories() })
  assert.equal(audit.result, 'failed')
  assert.match(audit.globalProblems.join('\n'), /receipt SHA/)
  assert.match(audit.globalProblems.join('\n'), /deletion was not proven/)
})

test('CLI arguments are exact and help has no side effects', () => {
  assert.deepEqual(parseArguments(['--run', '123']), { runId: 123 })
  assert.deepEqual(parseArguments(['--help']), { help: true })
  assert.throws(() => parseArguments([]), /usage:/)
  assert.throws(() => parseArguments(['--run', '../bad']), /usage:/)
  assert.throws(() => parseArguments(['--run', '1', '--json']), /usage:/)
})
