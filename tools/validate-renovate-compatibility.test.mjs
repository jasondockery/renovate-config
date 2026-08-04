import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  loadTargets,
  parseCoverageEvidence,
  validateCompatibilityReportPath,
} from './validate-renovate-compatibility.mjs'

const REPOSITORIES = ['jasondockery/renovate-config', 'jasondockery/roost', 'jasondockery/groundwork']
const PREFIX = 'RENOVATE_COVERAGE_EVIDENCE '

function evidenceLine(rows) {
  return `noise\n${PREFIX}${JSON.stringify(rows)}\nmore noise\n`
}

function rows(overrides = {}) {
  return REPOSITORIES.map((repository) => ({
    repository,
    tuples: 1,
    declarations: 2,
    scanHits: 3,
    ...(overrides[repository] ?? {}),
  }))
}

test('compatibility report cannot be written into any tested repository', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-report-boundary-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repositories = ['renovate-config', 'roost', 'groundwork'].map((name) => {
    const directory = path.join(root, name)
    fs.mkdirSync(directory)
    return directory
  })
  const reportRoot = path.join(root, 'receipts')
  fs.mkdirSync(reportRoot)

  for (const repository of repositories) {
    assert.throws(
      () => validateCompatibilityReportPath(path.join(repository, 'compatibility.json'), repositories),
      /outside every tested repository/
    )
  }
  assert.equal(
    validateCompatibilityReportPath(path.join(reportRoot, 'compatibility.json'), repositories),
    path.join(fs.realpathSync(reportRoot), 'compatibility.json')
  )

  const redirected = path.join(root, 'redirected')
  fs.symlinkSync(repositories[1], redirected)
  assert.throws(
    () => validateCompatibilityReportPath(path.join(redirected, 'compatibility.json'), repositories),
    /outside every tested repository/
  )
})

// Coverage evidence is what turns a zero-exit integration run into a passed
// compatibility receipt. Anything it accepts becomes published proof.
test('coverage evidence must be present exactly once and complete', () => {
  assert.deepEqual(parseCoverageEvidence(evidenceLine(rows()), REPOSITORIES).map((r) => r.repository), REPOSITORIES)

  assert.throws(() => parseCoverageEvidence('no record here', REPOSITORIES), /exactly one coverage evidence record/)
  assert.throws(
    () => parseCoverageEvidence(`${evidenceLine(rows())}${PREFIX}[]\n`, REPOSITORIES),
    /exactly one coverage evidence record/
  )
  assert.throws(
    () => parseCoverageEvidence(evidenceLine(rows().slice(0, 2)), REPOSITORIES),
    /repository scope is incomplete/
  )
})

test('coverage evidence rejects duplicate, missing, and non-integer counts', () => {
  const duplicated = rows()
  duplicated[1].repository = REPOSITORIES[0]
  assert.throws(() => parseCoverageEvidence(evidenceLine(duplicated), REPOSITORIES), /invalid for/)

  for (const bad of [{ tuples: -1 }, { tuples: 1.5 }, { declarations: null }, { scanHits: '3' }]) {
    assert.throws(
      () => parseCoverageEvidence(evidenceLine(rows({ [REPOSITORIES[2]]: bad })), REPOSITORIES),
      /invalid for jasondockery\/groundwork/
    )
  }
})

test('compatibility targets must declare activation and exactly three schema-v1 entries', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-targets-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (value) =>
    fs.writeFileSync(path.join(root, 'compatibility-targets.json'), JSON.stringify(value))
  const valid = {
    schemaVersion: 1,
    activation: 'manual-only',
    targets: REPOSITORIES.map((repository, index) => ({ repository, directory: `d${index}`, ignoredPaths: [] })),
  }

  write(valid)
  assert.deepEqual(loadTargets(root).map(({ repository }) => repository), REPOSITORIES)
  assert.equal(loadTargets(root)[0].root, path.resolve(root, 'd0'))

  for (const invalid of [
    { ...valid, schemaVersion: 2 },
    { ...valid, activation: 'whenever' },
    { ...valid, targets: valid.targets.slice(0, 2) },
    { ...valid, targets: 'not-an-array' },
  ]) {
    write(invalid)
    assert.throws(() => loadTargets(root), /activation and exactly three schema-v1 targets/)
  }
})
