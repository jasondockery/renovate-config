import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ACCEPTED_COMPASS_IDENTITY,
  checkAcceptedCompassIdentity,
  checkCompassConsumerReconciliation,
  checkCompassProjection,
  checkSkillDiscovery,
} from './check-compass-projection.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-compass-'))
  for (const relativePath of ['.compass', 'skills']) {
    fs.cpSync(path.join(repositoryRoot, relativePath), path.join(root, relativePath), { recursive: true })
  }
  fs.copyFileSync(path.join(repositoryRoot, 'AGENTS.md'), path.join(root, 'AGENTS.md'))
  fs.mkdirSync(path.join(root, 'tools'))
  fs.copyFileSync(
    path.join(repositoryRoot, 'tools/compass-consumer-reconciliation.json'),
    path.join(root, 'tools/compass-consumer-reconciliation.json')
  )
  for (const adapterRoot of ['.agents', '.claude']) {
    fs.mkdirSync(path.join(root, adapterRoot))
    fs.symlinkSync('../skills', path.join(root, adapterRoot, 'skills'))
  }
  return root
}

test('Compass projection matches its exact artifact receipt', () => {
  assert.deepEqual(checkCompassProjection(repositoryRoot), [])
})

test('renovate-config binds the corrected Compass authority identity across all seven dimensions', () => {
  const receiptBytes = fs.readFileSync(path.join(repositoryRoot, '.compass/receipt.json'))
  const receipt = JSON.parse(receiptBytes)
  const receiptSha256 = createHash('sha256').update(receiptBytes).digest('hex')
  assert.deepEqual(checkAcceptedCompassIdentity(receipt, receiptSha256), [])
  assert.equal(ACCEPTED_COMPASS_IDENTITY.commit, '043568a695b589154036ec85bc56e681a2b1e370')
  assert.equal(ACCEPTED_COMPASS_IDENTITY.receiptSha256, receiptSha256)

  const cases = [
    ['commit', (candidate) => { candidate.source.commit = '94c7770e4b7d2e8652763ad16c4dba4eb181c8a4' }],
    ['tree', (candidate) => { candidate.source.tree = '0'.repeat(40) }],
    ['fingerprintSha256', (candidate) => { candidate.source.fingerprintSha256 = '0'.repeat(64) }],
    ['artifactSha256', (candidate) => { candidate.artifactSha256 = '0'.repeat(64) }],
    ['artifactBytes', (candidate) => { candidate.artifactBytes = 1 }],
    ['validationReceiptSha256', (candidate) => { candidate.validation.receiptSha256 = '0'.repeat(64) }],
  ]
  for (const [field, mutate] of cases) {
    const candidate = structuredClone(receipt)
    mutate(candidate)
    assert.match(
      checkAcceptedCompassIdentity(candidate, receiptSha256).join('\n'),
      new RegExp(`accepted Compass ${field} differs`, 'u'),
      field
    )
  }
  assert.match(
    checkAcceptedCompassIdentity(receipt, '0'.repeat(64)).join('\n'),
    /accepted Compass receiptSha256 differs/u
  )
})

test('renovate-config owns a direct reconciliation for every issued Compass candidate', () => {
  assert.deepEqual(checkCompassConsumerReconciliation(repositoryRoot), [])
})

test('renovate-config reconciliation fails closed on local identity and state drift', () => {
  const cases = [
    ['sourceCommit', '0'.repeat(40)],
    ['sourceTree', '0'.repeat(40)],
    ['sourceFingerprintSha256', '0'.repeat(64)],
    ['artifactSha256', '0'.repeat(64)],
    ['artifactBytes', 1],
    ['validationReceiptSha256', '0'.repeat(64)],
    ['artifactReceiptSha256', '0'.repeat(64)],
  ]
  for (const [field, value] of cases) {
    const root = fixture()
    const file = path.join(root, 'tools/compass-consumer-reconciliation.json')
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    record.records[0].authorityIdentity[field] = value
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
    assert.match(
      checkCompassConsumerReconciliation(root).join('\n'),
      /differs from the accepted authority identity/u,
      field
    )
  }

  const root = fixture()
  const file = path.join(root, 'tools/compass-consumer-reconciliation.json')
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  record.records[0].relationship = 'via-authority'
  record.records[0].localReconciliation = 'pending'
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
  const problems = checkCompassConsumerReconciliation(root).join('\n')
  assert.match(problems, /not direct/u)
  assert.match(problems, /has not completed local review integration/u)
})

test('renovate-config reconciliation fails when an issued candidate is missing', () => {
  const root = fixture()
  const file = path.join(root, 'tools/compass-consumer-reconciliation.json')
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  record.records.pop()
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
  assert.match(
    checkCompassConsumerReconciliation(root).join('\n'),
    /does not cover every issued candidate exactly once/u
  )
})

test('renovate-config does not reimplement generic Compass conformance', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'tools/check-compass-projection.mjs'), 'utf8')
  assert.match(source, /from '\.\.\/\.compass\/check-projection\.mjs'/u)
  assert.doesNotMatch(source, /expectedSourcePaths/u)
  assert.doesNotMatch(source, /dependency-change|field-failure-backpressure|performance-sensitive-change|verification-selection/u)
  assert.doesNotMatch(source, /REQUIRED_LOCAL_ROUTES/u)
})

test('renovate-config rejects receipt-byte drift even when parsed identity fields are unchanged', () => {
  const root = fixture()
  fs.appendFileSync(path.join(root, '.compass/receipt.json'), '\n')
  assert.match(checkCompassProjection(root).join('\n'), /accepted Compass receiptSha256 differs/u)
})

test('renovate-config wrapper delegates generic drift semantics to Compass', () => {
  const root = fixture()
  fs.appendFileSync(path.join(root, '.compass/COMPASS.md'), '\nindependent policy\n')
  assert.match(checkCompassProjection(root).join('\n'), /COMPASS\.md/u)
})

test('renovate-config wrapper retains only repository-local AGENTS routing', () => {
  const root = fixture()
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Local only\n')
  assert.match(checkCompassProjection(root).join('\n'), /does not route/u)
})

test('skill discovery is derived from the receipt and accepts a future projected skill', () => {
  const root = fixture()
  const receipt = JSON.parse(fs.readFileSync(path.join(root, '.compass/receipt.json'), 'utf8'))
  const futureName = 'future-shared-skill'
  const futurePath = path.join(root, 'skills', futureName, 'SKILL.md')
  fs.mkdirSync(path.dirname(futurePath), { recursive: true })
  fs.writeFileSync(futurePath, '# Future shared skill\n')
  receipt.includedFiles.push({ path: `skills/${futureName}/SKILL.md` })
  assert.deepEqual(checkSkillDiscovery(root, receipt), [])

  fs.rmSync(path.join(root, '.agents/skills'))
  fs.symlinkSync('../missing-skills', path.join(root, '.agents/skills'))
  assert.match(checkSkillDiscovery(root, receipt).join('\n'), /\.agents\/skills/u)
})
