import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
import {
  COMPASS_SKILL_DISCOVERY_SURFACES,
  inspectSkillDiscoveryAdapters,
  migrateLegacySkillDiscoverySymlinks,
  projectedSkillNames,
  renderSkillAdapter,
  writeSkillDiscoveryAdapters,
} from './sync-compass-skill-adapters.mjs'

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

function fixture({ copyAdapters = true } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'renovate-compass-'))
  for (const relativePath of ['.compass', 'skills']) {
    fs.cpSync(path.join(repositoryRoot, relativePath), path.join(root, relativePath), { recursive: true })
  }
  if (copyAdapters) {
    for (const relativePath of ['.agents', '.claude', '.codex']) {
      fs.cpSync(path.join(repositoryRoot, relativePath), path.join(root, relativePath), { recursive: true })
    }
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
  return root
}

function fileManifest(root) {
  const manifest = []
  function visit(relativePath) {
    const absolutePath = path.join(root, relativePath)
    for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
      const child = path.join(relativePath, entry.name)
      if (entry.isDirectory()) visit(child)
      else manifest.push([child, fs.readFileSync(path.join(root, child), 'utf8')])
    }
  }
  for (const surface of COMPASS_SKILL_DISCOVERY_SURFACES) {
    const metadata = fs.lstatSync(path.join(root, surface))
    if (metadata.isSymbolicLink()) manifest.push([surface, 'symlink', fs.readlinkSync(path.join(root, surface))])
    else visit(surface)
  }
  return manifest.sort(([left], [right]) => left.localeCompare(right))
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

test('skill discovery is derived from the receipt and rejects partial projection', () => {
  const root = fixture()
  const receipt = JSON.parse(fs.readFileSync(path.join(root, '.compass/receipt.json'), 'utf8'))
  const futureName = 'future-shared-skill'
  const futurePath = path.join(root, 'skills', futureName, 'SKILL.md')
  fs.mkdirSync(path.dirname(futurePath), { recursive: true })
  fs.writeFileSync(futurePath, '# Future shared skill\n')
  receipt.includedFiles.push({ path: `skills/${futureName}/SKILL.md` })
  writeSkillDiscoveryAdapters(root, receipt)
  assert.deepEqual(checkSkillDiscovery(root, receipt), [])

  fs.rmSync(path.join(root, '.agents/skills', futureName), { recursive: true })
  assert.match(
    checkSkillDiscovery(root, receipt).join('\n'),
    /\.agents\/skills.*future-shared-skill|complete receipt-bound skill inventory/u
  )
})

test('guarded legacy symlink migration preserves the complete inventory and is idempotent', () => {
  const root = fixture({ copyAdapters: false })
  const receipt = JSON.parse(fs.readFileSync(path.join(root, '.compass/receipt.json'), 'utf8'))
  const issued = projectedSkillNames(receipt)
  const expected = fs.readdirSync(path.join(root, 'skills')).filter((name) => fs.existsSync(path.join(root, 'skills', name, 'SKILL.md'))).sort()
  fs.mkdirSync(path.join(root, '.codex'))
  for (const adapterRoot of ['.agents', '.claude']) {
    fs.mkdirSync(path.join(root, adapterRoot))
    fs.symlinkSync('../skills', path.join(root, adapterRoot, 'skills'))
    assert.equal(fs.readlinkSync(path.join(root, adapterRoot, 'skills')), '../skills')
    assert.equal(fs.realpathSync(path.join(root, adapterRoot, 'skills')), fs.realpathSync(path.join(root, 'skills')))
    assert.deepEqual(fs.readdirSync(path.join(root, adapterRoot, 'skills')).filter((name) => expected.includes(name)).sort(), expected)
  }
  fs.writeFileSync(path.join(root, '.agents/unrelated.txt'), 'preserve agents sibling\n')
  fs.writeFileSync(path.join(root, '.claude/settings.local.json'), '{"preserve":true}\n')
  fs.writeFileSync(path.join(root, '.codex/unrelated.txt'), 'preserve codex sibling\n')
  assert.deepEqual(migrateLegacySkillDiscoverySymlinks(root), [
    { surface: '.agents/skills', target: '../skills' },
    { surface: '.claude/skills', target: '../skills' },
  ])
  fs.mkdirSync(path.join(root, '.codex/skills'))
  for (const entry of receipt.includedFiles.filter(({ path: receiptPath }) => /^(?:\.agents|\.claude|\.codex)\/skills\/[^/]+\/SKILL\.md$/u.test(receiptPath))) {
    const destination = path.join(root, entry.path)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(path.join(repositoryRoot, entry.path), destination)
  }

  const first = writeSkillDiscoveryAdapters(root, receipt)
  assert.deepEqual(first.inventories['.agents/skills'], expected)
  assert.deepEqual(first.inventories['.claude/skills'], expected)
  assert.deepEqual(first.inventories['.agents/skills'].filter((name) => issued.includes(name)), issued)
  assert.deepEqual(first.inventories['.claude/skills'].filter((name) => issued.includes(name)), issued)
  assert.equal(fs.readFileSync(path.join(root, '.agents/unrelated.txt'), 'utf8'), 'preserve agents sibling\n')
  assert.equal(fs.readFileSync(path.join(root, '.claude/settings.local.json'), 'utf8'), '{"preserve":true}\n')
  assert.equal(fs.readFileSync(path.join(root, '.codex/unrelated.txt'), 'utf8'), 'preserve codex sibling\n')
  const firstManifest = fileManifest(root)
  const second = writeSkillDiscoveryAdapters(root, receipt)
  assert.deepEqual(second.inventories, first.inventories)
  assert.deepEqual(fileManifest(root), firstManifest)
})

test('skill adapter migration rejects hostile and one-sided symlinks before mutation', () => {
  const symlinkRoot = fixture({ copyAdapters: false })
  fs.mkdirSync(path.join(symlinkRoot, '.agents'))
  fs.mkdirSync(path.join(symlinkRoot, '.claude'))
  fs.symlinkSync('../skills', path.join(symlinkRoot, '.agents/skills'))
  fs.symlinkSync(fs.realpathSync(os.tmpdir()), path.join(symlinkRoot, '.claude/skills'))
  const beforeAgents = fs.readlinkSync(path.join(symlinkRoot, '.agents/skills'))
  const beforeClaude = fs.readlinkSync(path.join(symlinkRoot, '.claude/skills'))
  assert.throws(
    () => migrateLegacySkillDiscoverySymlinks(symlinkRoot),
    /unexpected legacy target|does not resolve/u
  )
  assert.equal(fs.readlinkSync(path.join(symlinkRoot, '.agents/skills')), beforeAgents)
  assert.equal(fs.readlinkSync(path.join(symlinkRoot, '.claude/skills')), beforeClaude)

  fs.rmSync(path.join(symlinkRoot, '.claude/skills'))
  fs.mkdirSync(path.join(symlinkRoot, '.claude/skills'))
  assert.throws(() => migrateLegacySkillDiscoverySymlinks(symlinkRoot), /expected legacy symlink/u)
  assert.equal(fs.readlinkSync(path.join(symlinkRoot, '.agents/skills')), '../skills')
})

test('adapter synchronization preflights the final surface before any write', () => {
  const root = fixture()
  fs.rmSync(path.join(root, '.agents/skills/live-renovate-acceptance'), { recursive: true })
  fs.writeFileSync(
    path.join(root, '.codex/skills/toolchain-authority/SKILL.md'),
    renderSkillAdapter('privacy-by-design')
  )
  const before = fileManifest(root)
  const receipt = JSON.parse(fs.readFileSync(path.join(root, '.compass/receipt.json'), 'utf8'))
  assert.throws(() => writeSkillDiscoveryAdapters(root, receipt), /does not route exactly/u)
  assert.deepEqual(fileManifest(root), before)
})

test('skill adapter inspection rejects stale adapters and modified routes', () => {

  const staleRoot = fixture()
  fs.mkdirSync(path.join(staleRoot, '.claude/skills/stale-skill'))
  assert.match(
    inspectSkillDiscoveryAdapters(
      staleRoot,
      JSON.parse(fs.readFileSync(path.join(staleRoot, '.compass/receipt.json'), 'utf8'))
    ).problems.join('\n'),
    /stale or orphaned adapter/u
  )

  const modifiedRoot = fixture()
  const modified = path.join(modifiedRoot, '.agents/skills/dependency-change/SKILL.md')
  fs.writeFileSync(modified, renderSkillAdapter('privacy-by-design'))
  assert.match(
    inspectSkillDiscoveryAdapters(
      modifiedRoot,
      JSON.parse(fs.readFileSync(path.join(modifiedRoot, '.compass/receipt.json'), 'utf8'))
    ).problems.join('\n'),
    /does not route exactly/u
  )

  const managedRoot = fixture()
  fs.appendFileSync(
    path.join(managedRoot, '.claude/skills/reviewable-agent-workspaces/SKILL.md'),
    '\nmanaged drift\n'
  )
  assert.match(
    inspectSkillDiscoveryAdapters(
      managedRoot,
      JSON.parse(fs.readFileSync(path.join(managedRoot, '.compass/receipt.json'), 'utf8'))
    ).problems.join('\n'),
    /does not match its receipt-bound bytes/u
  )

  const retiedRoot = fixture()
  const retiedReceipt = JSON.parse(fs.readFileSync(path.join(retiedRoot, '.compass/receipt.json'), 'utf8'))
  const managedPath = '.claude/skills/reviewable-agent-workspaces/SKILL.md'
  const wrongRoute = Buffer.from(renderSkillAdapter('privacy-by-design'))
  fs.writeFileSync(path.join(retiedRoot, managedPath), wrongRoute)
  const managedEntry = retiedReceipt.includedFiles.find(({ path: receiptPath }) => receiptPath === managedPath)
  managedEntry.bytes = wrongRoute.length
  managedEntry.sha256 = createHash('sha256').update(wrongRoute).digest('hex')
  assert.match(
    inspectSkillDiscoveryAdapters(retiedRoot, retiedReceipt).problems.join('\n'),
    /does not route to its named canonical entrypoint/u
  )
})

test('duplicate receipt skill entries fail closed', () => {
  const root = fixture()
  const receipt = JSON.parse(fs.readFileSync(path.join(root, '.compass/receipt.json'), 'utf8'))
  receipt.includedFiles.push({ path: 'skills/dependency-change/SKILL.md' })
  assert.match(inspectSkillDiscoveryAdapters(root, receipt).problems.join('\n'), /duplicate projected/u)
})

test('receipt-managed adapter expectations are generic rather than skill-specific', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'tools/sync-compass-skill-adapters.mjs'), 'utf8')
  assert.match(source, /ADAPTER_RECEIPT_PATH/u)
  assert.match(source, /validateManagedAdapter/u)
  assert.doesNotMatch(source, /expectedReviewableAdapter/u)
})
