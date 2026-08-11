import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  checkCompassConsumerReconciliation,
  checkCompassProjection,
  checkSkillDiscovery,
} from './check-compass-projection.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function pendingRecord(record) {
  const pending = structuredClone(record)
  for (const item of pending.records) {
    if (item.consumerState !== 'adopted') continue
    item.consumerState = 'pending-adoption'
    item.transitionHistory.pop()
    delete item.adoptionEvidence
  }
  return pending
}

function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'renovate-compass-'))
  for (const relativePath of ['.compass', 'skills']) {
    fs.cpSync(path.join(repositoryRoot, relativePath), path.join(root, relativePath), { recursive: true })
  }
  fs.copyFileSync(path.join(repositoryRoot, 'AGENTS.md'), path.join(root, 'AGENTS.md'))
  fs.mkdirSync(path.join(root, 'tools'))
  const sourceRecord = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'tools/compass-consumer-reconciliation.json'), 'utf8')
  )
  fs.writeFileSync(
    path.join(root, 'tools/compass-consumer-reconciliation.json'),
    `${JSON.stringify(pendingRecord(sourceRecord), null, 2)}\n`
  )
  for (const adapterRoot of ['.agents', '.claude']) {
    fs.mkdirSync(path.join(root, adapterRoot))
    fs.symlinkSync('../skills', path.join(root, adapterRoot, 'skills'))
  }
  return root
}

function mutateRecord(root, mutate) {
  const file = path.join(root, 'tools/compass-consumer-reconciliation.json')
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  mutate(record)
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
}

test('Compass projection and consumer reconciliation match the issued authority', async () => {
  assert.deepEqual(await checkCompassProjection(repositoryRoot), [])
})

test('canonical Compass validation binds every exact identity dimension', async () => {
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
    mutateRecord(root, (record) => { record.records[0].authorityIdentity[field] = value })
    assert.match(
      (await checkCompassConsumerReconciliation(root)).join('\n'),
      /direct authority identity does not equal the containing projection receipt/u,
      field
    )
  }
})

test('canonical Compass validation rejects state, candidate, and adoption-contract drift', async () => {
  const relationshipRoot = fixture()
  mutateRecord(relationshipRoot, (record) => { record.records[0].relationship = 'via-authority' })
  assert.match((await checkCompassConsumerReconciliation(relationshipRoot)).join('\n'), /viaAuthority/u)

  const missingRoot = fixture()
  mutateRecord(missingRoot, (record) => { record.records.pop() })
  assert.match((await checkCompassConsumerReconciliation(missingRoot)).join('\n'), /every issued candidate/u)

  const contractRoot = fixture()
  mutateRecord(contractRoot, (record) => {
    record.records[0].adoptionContract.requiredGate = ''
  })
  assert.match((await checkCompassConsumerReconciliation(contractRoot)).join('\n'), /hosted authority is invalid/u)
})

test('offline verification preserves local cross-binding while provider adoption stays explicit', async () => {
  const root = fixture()
  mutateRecord(root, (record) => {
    const item = record.records[0]
    item.consumerState = 'adopted'
    item.transitionHistory.push({ sequence: 3, state: 'adopted' })
    item.adoptionEvidence = {
      repository: 'jasondockery/renovate-config',
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      hostedRun: {
        provider: 'github-actions',
        repository: 'jasondockery/renovate-config',
        workflow: '.github/workflows/ci.yml',
        requiredGate: 'ci-gate',
        requiredJobId: 10,
        requiredCheckId: 10,
        conclusion: 'success',
        runId: 20,
        attempt: 1,
        headSha: 'a'.repeat(40),
        evidence: {
          kind: 'artifact',
          artifactId: 30,
          name: 'renovate-config-ci-receipt-20-1',
          path: 'compass-hosted-adoption-receipt.json',
          artifactSha256: 'c'.repeat(64),
          receiptSha256: 'd'.repeat(64),
        },
      },
    }
  })
  assert.deepEqual(await checkCompassConsumerReconciliation(root), [])
  assert.match(
    (await checkCompassConsumerReconciliation(root, { authenticateProvider: true, providerToken: '' })).join('\n'),
    /actions-read GitHub token is required/u
  )
})

test('renovate-config delegates authority binding and generic projection semantics to Compass', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'tools/check-compass-projection.mjs'), 'utf8')
  assert.match(source, /validateAuthorityBundle/u)
  assert.match(source, /inspectCompassProjection/u)
  assert.doesNotMatch(source, /HISTORICAL_COMPASS_IDENTITY|LOCAL_EXACT_IDENTITY|sameExactIdentity/u)
  assert.doesNotMatch(source, /dependency-change|field-failure-backpressure|performance-sensitive-change|verification-selection/u)
})

test('renovate-config rejects receipt-byte and projected-byte drift', async () => {
  const receiptRoot = fixture()
  fs.appendFileSync(path.join(receiptRoot, '.compass/receipt.json'), '\n')
  assert.match((await checkCompassProjection(receiptRoot)).join('\n'), /receipt/u)

  const doctrineRoot = fixture()
  fs.appendFileSync(path.join(doctrineRoot, '.compass/COMPASS.md'), '\nindependent policy\n')
  assert.match((await checkCompassProjection(doctrineRoot)).join('\n'), /COMPASS\.md/u)
})

test('renovate-config wrapper retains repository-local AGENTS routing', async () => {
  const root = fixture()
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Local only\n')
  assert.match((await checkCompassProjection(root)).join('\n'), /does not route/u)
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
