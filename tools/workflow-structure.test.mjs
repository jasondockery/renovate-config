import assert from 'node:assert/strict'
import test from 'node:test'
import { workflowJobs, workflowJobSteps } from './workflow-structure.mjs'

// This parser backs the timeout gate and the runtime-contract step checks.
// Its dangerous failure is returning an empty result for a workflow that
// really does have jobs, because every caller then reports "ok".
const WORKFLOW = `name: T
on: [push]

permissions:
  contents: read

jobs:
  first:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - name: Checkout
        uses: actions/checkout@1111111111111111111111111111111111111111 # v7.0.0
        with:
          persist-credentials: false
      - name: Run
        id: run
        run: pnpm test
  second:
    runs-on: ubuntu-24.04
    timeout-minutes: 10 # trailing comment
    steps:
      - name: Only
        id: only
        run: echo hi
`

test('parses every job and its bounds', () => {
  const jobs = workflowJobs(WORKFLOW)
  assert.deepEqual(jobs.map(({ name }) => name), ['first', 'second'])
  assert.deepEqual(jobs.map(({ timeout }) => timeout), ['5', '10'])
})

test('recognizes jobs: with and without a trailing comment', () => {
  assert.equal(workflowJobs(WORKFLOW).length, 2)
  assert.equal(workflowJobs(WORKFLOW.replace('jobs:', 'jobs: # the jobs')).length, 2)
  assert.equal(workflowJobSteps(WORKFLOW.replace('jobs:', 'jobs: # the jobs'), 'first').length, 2)
})

test('returns nothing for a workflow with no jobs mapping, so callers can fail', () => {
  assert.deepEqual(workflowJobs('name: T\non: [push]\n'), [])
  assert.deepEqual(workflowJobSteps('name: T\non: [push]\n', 'first'), [])
  assert.deepEqual(workflowJobSteps(WORKFLOW, 'absent'), [])
})

test('reads step id, run, uses, and with values without leaking across jobs', () => {
  const first = workflowJobSteps(WORKFLOW, 'first')
  assert.equal(first.length, 2)
  assert.equal(first[0].uses, 'actions/checkout@1111111111111111111111111111111111111111')
  assert.equal(first[0].with['persist-credentials'], 'false')
  assert.equal(first[1].id, 'run')
  assert.equal(first[1].run, 'pnpm test')

  const second = workflowJobSteps(WORKFLOW, 'second')
  assert.equal(second.length, 1)
  assert.equal(second[0].id, 'only')
})

test('a reusable-workflow job exposes its uses target', () => {
  const jobs = workflowJobs('jobs:\n  call:\n    uses: o/r/.github/workflows/w.yml@abc\n')
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].uses, 'o/r/.github/workflows/w.yml@abc')
  assert.equal(jobs[0].timeout, undefined)
})
