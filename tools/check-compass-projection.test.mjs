import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  checkConsumerAdoptionHistory,
  checkCompassConsumerReconciliation,
  checkCompassProjection,
  checkNativeDiscoveryEvidence,
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
  for (const relativePath of ['.agents', '.claude', '.compass', 'skills']) {
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
  fs.copyFileSync(
    path.join(repositoryRoot, 'tools/compass-consumer-adoption-history.json'),
    path.join(root, 'tools/compass-consumer-adoption-history.json')
  )
  fs.copyFileSync(
    path.join(repositoryRoot, 'tools/compass-consumer-native-discovery.json'),
    path.join(root, 'tools/compass-consumer-native-discovery.json')
  )
  return root
}

function mutateRecord(root, mutate) {
  const file = path.join(root, 'tools/compass-consumer-reconciliation.json')
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  mutate(record)
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
}

function mutateHistory(root, mutate) {
  const file = path.join(root, 'tools/compass-consumer-adoption-history.json')
  const history = JSON.parse(fs.readFileSync(file, 'utf8'))
  mutate(history)
  fs.writeFileSync(file, `${JSON.stringify(history, null, 2)}\n`)
}

function makeNativeDiscoveryObserved(root) {
  const evidencePath = path.join(root, 'tools/compass-consumer-native-discovery.json')
  const routing = JSON.parse(fs.readFileSync(path.join(root, '.compass/agent-routing-surfaces.json'), 'utf8'))
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'))
  const inventory = routing.skills
    .map(({ name, canonicalSkillSha256 }) => ({ name, canonicalSkillSha256 }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : value
  const skillInventorySha256 = createHash('sha256').update(JSON.stringify(stable(inventory))).digest('hex')
  for (const observation of evidence.observations) {
    if (!['codex', 'github-copilot', 'opencode'].includes(observation.id)) continue
    Object.assign(observation, {
      state: 'observed',
      toolVersion: 'fixture-tool-version',
      command: 'fixture native discovery smoke',
      skillInventorySha256,
      skillCount: inventory.length,
    })
    delete observation.reason
  }
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
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
  makeNativeDiscoveryObserved(root)
  mutateRecord(root, (record) => {
    const item = record.records[0]
    item.consumerState = 'adopted'
    item.localReconciliation = 'complete'
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

test('consumer adoption history preserves authenticated predecessor epochs immutably', async () => {
  const sourceHistory = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'tools/compass-consumer-adoption-history.json'), 'utf8')
  )
  const sourceRecord = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'tools/compass-consumer-reconciliation.json'), 'utf8')
  )
  assert.deepEqual(checkConsumerAdoptionHistory(sourceHistory, sourceRecord), [])

  const wrongOuterConsumer = structuredClone(sourceHistory)
  wrongOuterConsumer.consumer.repository = 'someone/else'
  assert.match(
    checkConsumerAdoptionHistory(wrongOuterConsumer, sourceRecord).join('\n'),
    /history identity does not match/u
  )

  const wrongSnapshotConsumer = structuredClone(sourceHistory)
  wrongSnapshotConsumer.epochs[0].snapshot.consumer.name = 'other-consumer'
  assert.match(
    checkConsumerAdoptionHistory(wrongSnapshotConsumer, sourceRecord).join('\n'),
    /snapshot consumer does not match/u
  )

  const wrongHistoricalSource = structuredClone(sourceHistory)
  wrongHistoricalSource.epochs[0].sourceTree = '0'.repeat(40)
  assert.match(
    checkConsumerAdoptionHistory(wrongHistoricalSource, sourceRecord).join('\n'),
    /source tree does not match/u
  )

  const wrongHistoricalSchema = structuredClone(sourceHistory)
  wrongHistoricalSchema.epochs[0].snapshot.schemaVersion = 3
  assert.match(
    checkConsumerAdoptionHistory(wrongHistoricalSchema, sourceRecord).join('\n'),
    /historical schema/u
  )

  const duplicateCurrent = structuredClone(sourceRecord)
  duplicateCurrent.records.push(structuredClone(duplicateCurrent.records[0]))
  assert.match(
    checkConsumerAdoptionHistory(sourceHistory, duplicateCurrent).join('\n'),
    /current reconciliation duplicates candidate/u
  )

  const mutated = fixture()
  mutateHistory(mutated, (history) => {
    history.epochs[0].snapshot.records[0].adoptionEvidence.hostedRun.runId += 1
  })
  assert.match((await checkCompassConsumerReconciliation(mutated)).join('\n'), /digest does not match/u)

  const truncated = fixture()
  mutateHistory(truncated, (history) => { history.epochs = [] })
  assert.match((await checkCompassConsumerReconciliation(truncated)).join('\n'), /retain at least/u)

  const duplicateSequence = fixture()
  mutateHistory(duplicateSequence, (history) => { history.epochs.push(structuredClone(history.epochs[0])) })
  assert.match((await checkCompassConsumerReconciliation(duplicateSequence)).join('\n'), /sequence, predecessor, or state/u)

  const reusedIdentity = fixture()
  const historicalIdentity = structuredClone(sourceHistory.epochs[0].snapshot.records[0].authorityIdentity)
  mutateRecord(reusedIdentity, (record) => { record.records[0].authorityIdentity = historicalIdentity })
  assert.match((await checkCompassConsumerReconciliation(reusedIdentity)).join('\n'), /reuses a historical adopted identity/u)

  const droppedCandidate = fixture()
  mutateRecord(droppedCandidate, (record) => {
    record.records = record.records.filter(({ candidateId }) => candidateId !== 'sta-compass-shift-to-authority')
  })
  assert.match((await checkCompassConsumerReconciliation(droppedCandidate)).join('\n'), /dropped historical candidate/u)
})

test('consumer-native discovery remains explicit and blocks false completion', () => {
  const evidence = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'tools/compass-consumer-native-discovery.json'), 'utf8')
  )
  const routing = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, '.compass/agent-routing-surfaces.json'), 'utf8')
  )
  const receiptBytes = fs.readFileSync(path.join(repositoryRoot, '.compass/receipt.json'))
  const receipt = JSON.parse(receiptBytes)
  const reconciliation = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'tools/compass-consumer-reconciliation.json'), 'utf8')
  )
  assert.deepEqual(checkNativeDiscoveryEvidence(evidence, routing, receipt, receiptBytes, reconciliation), [])

  const complete = structuredClone(reconciliation)
  complete.records[0].localReconciliation = 'complete'
  assert.match(
    checkNativeDiscoveryEvidence(evidence, routing, receipt, receiptBytes, complete).join('\n'),
    /requires observed native discovery for codex/u
  )

  const partial = structuredClone(evidence)
  partial.observations.pop()
  assert.match(
    checkNativeDiscoveryEvidence(partial, routing, receipt, receiptBytes, reconciliation).join('\n'),
    /does not cover every declared ecosystem/u
  )

  const duplicate = structuredClone(evidence)
  duplicate.observations.push(structuredClone(duplicate.observations[0]))
  assert.match(
    checkNativeDiscoveryEvidence(duplicate, routing, receipt, receiptBytes, reconciliation).join('\n'),
    /duplicates claude/u
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

test('skill discovery requires every receipt-bound canonical skill in each declared adapter', () => {
  const root = fixture()
  const receipt = JSON.parse(fs.readFileSync(path.join(root, '.compass/receipt.json'), 'utf8'))
  assert.deepEqual(checkSkillDiscovery(root, receipt), [])

  fs.rmSync(path.join(root, '.agents/skills/reviewable-agent-workspaces/SKILL.md'))
  assert.match(checkSkillDiscovery(root, receipt).join('\n'), /\.agents\/skills.*receipt-bound canonical skill inventory/u)

  const symlinkRoot = fixture()
  fs.rmSync(path.join(symlinkRoot, '.claude/skills'), { recursive: true })
  fs.symlinkSync('../skills', path.join(symlinkRoot, '.claude/skills'))
  assert.match(checkSkillDiscovery(symlinkRoot, receipt).join('\n'), /regular directory/u)

  const extraFileRoot = fixture()
  fs.writeFileSync(path.join(extraFileRoot, '.agents/skills/unexpected.txt'), 'unexpected\n')
  assert.match(checkSkillDiscovery(extraFileRoot, receipt).join('\n'), /unexpected, missing, or stale/u)

  const emptyDirectoryRoot = fixture()
  fs.mkdirSync(path.join(emptyDirectoryRoot, '.claude/skills/stale-removed-skill'))
  assert.match(checkSkillDiscovery(emptyDirectoryRoot, receipt).join('\n'), /unexpected, missing, or stale/u)

  const symlinkParentRoot = fixture()
  fs.renameSync(path.join(symlinkParentRoot, '.agents'), path.join(symlinkParentRoot, '.agents-real'))
  fs.symlinkSync('.agents-real', path.join(symlinkParentRoot, '.agents'))
  assert.match(checkSkillDiscovery(symlinkParentRoot, receipt).join('\n'), /symlink parent/u)
})
