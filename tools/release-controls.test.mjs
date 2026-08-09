import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyReleaseControls,
  checkReleaseControls,
  collectDesiredReleaseControlProblems,
  collectReleaseControlContractProblems,
  collectReleaseDocumentationProblems,
  collectReleaseControlDrift,
  planReleaseControlMutations,
  parseReleaseControlsArguments,
  readDesiredReleaseControls,
} from './release-controls.mjs'

const desired = readDesiredReleaseControls()

function ruleset(overrides = {}) {
  return {
    id: 42,
    name: desired.tagRuleset.name,
    target: 'tag',
    enforcement: 'active',
    bypass_actors: [],
    conditions: {
      ref_name: {
        include: ['refs/tags/[0-9]*.[0-9]*.[0-9]*'],
        exclude: [],
      },
    },
    rules: [{ type: 'update' }, { type: 'deletion' }],
    ...overrides,
  }
}

function client(initial) {
  let state = structuredClone(initial)
  const calls = []
  return {
    calls,
    async get(endpoint) {
      calls.push(['GET', endpoint])
      if (endpoint.endsWith('/immutable-releases')) return state.immutableReleases
      if (endpoint.includes('/rulesets/')) return state.rulesets[0]
      return state.rulesets.map(({ id, name }) => ({ id, name }))
    },
    async post(endpoint, body) {
      calls.push(['POST', endpoint, body])
      state.rulesets = [{ id: 42, ...body }]
    },
    async put(endpoint, body) {
      calls.push(['PUT', endpoint, body])
      if (endpoint.endsWith('/immutable-releases')) state.immutableReleases = { enabled: true, enforced_by_owner: false }
      else state.rulesets = [{ id: 42, ...body }]
    },
  }
}

test('checked-in desired state protects release tag updates and deletions but allows creation', () => {
  assert.deepEqual(collectDesiredReleaseControlProblems(desired), [])
  assert.deepEqual(desired.tagRuleset.rules, [{ type: 'update' }, { type: 'deletion' }])
  assert.equal(desired.tagRuleset.rules.some(({ type }) => type === 'creation'), false)
  assert.deepEqual(desired.tagRuleset.bypassActors, [])
})

test('offline release contract binds every executable release command', () => {
  assert.deepEqual(collectReleaseControlContractProblems(), [])
})

test('documentation contract rejects missing owner gate or executable command', () => {
  const problems = collectReleaseDocumentationProblems({
    charter: 'immutable GitHub Release with defense in depth',
    contributing: 'release:controls:check',
    roadmap: '- [x] 2b. Owner action:',
  })
  assert.ok(problems.some((problem) => problem.includes('release:preflight')))
  assert.ok(problems.includes('ROADMAP.md must keep live control application open and prohibit a bootstrap tag'))
})

test('disabled immutable releases or weakened tag protections fail closed', () => {
  assert.deepEqual(
    collectReleaseControlDrift(desired, {
      immutableReleases: { enabled: false },
      rulesets: [ruleset({ rules: [{ type: 'deletion' }] })],
    }),
    [
      'GitHub immutable releases are disabled',
      'immutable-release-tags ruleset differs from checked-in desired state',
    ]
  )
})

test('read-only check issues only GET requests', async () => {
  const fake = client({ immutableReleases: { enabled: true }, rulesets: [ruleset()] })
  const result = await checkReleaseControls({ desired, client: fake })
  assert.equal(result.result, 'passed')
  assert.ok(fake.calls.length >= 3)
  assert.equal(fake.calls.every(([method]) => method === 'GET'), true)
})

test('apply is idempotent and re-reads both controls', async () => {
  const fake = client({ immutableReleases: { enabled: false }, rulesets: [] })
  const first = await applyReleaseControls({ desired, client: fake })
  assert.equal(first.result, 'passed')
  assert.deepEqual(first.mutations.map(({ method }) => method), ['PUT', 'POST'])

  const writesAfterFirst = fake.calls.filter(([method]) => method !== 'GET').length
  const second = await applyReleaseControls({ desired, client: fake })
  assert.equal(second.result, 'passed')
  assert.deepEqual(second.mutations, [])
  assert.equal(fake.calls.filter(([method]) => method !== 'GET').length, writesAfterFirst)
})

test('apply refuses ambiguous ruleset ownership', () => {
  assert.throws(
    () => planReleaseControlMutations(desired, {
      immutableReleases: { enabled: false },
      rulesets: [ruleset({ id: 1 }), ruleset({ id: 2 })],
    }),
    /refusing to mutate duplicate/
  )
})

test('apply mode requires explicit owner-admin confirmation', () => {
  assert.deepEqual(parseReleaseControlsArguments(['check']), { mode: 'check' })
  assert.deepEqual(
    parseReleaseControlsArguments(['apply', '--confirm-owner-admin']),
    { mode: 'apply' }
  )
  assert.throws(() => parseReleaseControlsArguments(['apply']), /--confirm-owner-admin/)
})
