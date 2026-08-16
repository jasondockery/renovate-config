#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { validateAuthorityBundle } from '../.compass/check-authority-record.mjs'
import { inspectCompassProjection } from '../.compass/check-projection.mjs'
import { validateJsonSchema } from '../.compass/validate-json-schema.mjs'
import { isMainModule } from './is-main.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CONSUMER_RECONCILIATION_PATH = 'tools/compass-consumer-reconciliation.json'
export const CONSUMER_ADOPTION_HISTORY_PATH = 'tools/compass-consumer-adoption-history.json'
export const CONSUMER_NATIVE_DISCOVERY_PATH = 'tools/compass-consumer-native-discovery.json'
const INITIAL_ADOPTION_EPOCH_SHA256 = '8105bdc0dc682474034c750bdef299dc8b5811fbf8c409e972dc5443b96a561c'
const COMMIT = /^[0-9a-f]{40}$/u
const SAFE_HISTORY_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u
const REQUIRED_DOCTRINE_ROUTES = Object.freeze([
  '.compass/COMPASS.md',
  '.compass/TERMINOLOGY.md',
  '.compass/ai-workload-policy.json',
  '.compass/authority-policy.json',
  '.compass/authority-registry.json',
  '.compass/consumer-hosted-adoption-receipt.schema.json',
  '.compass/consumer-reconciliation.schema.json',
  'skills/ai-backend-change/SKILL.md',
  'skills/developer-tool-change/SKILL.md',
  'skills/shift-to-authority/SKILL.md',
])
const SKILL_RECEIPT_PATH = /^skills\/([^/]+)\/SKILL\.md$/u

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value
}

function digestValue(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
}

function gitBytes(root, commit, relativePath, label, problems) {
  if (!COMMIT.test(commit ?? '') || !SAFE_HISTORY_PATH.test(relativePath ?? '')) {
    problems.push(`${label} Git identity is invalid`)
    return null
  }
  const result = spawnSync('git', ['-C', root, 'show', `${commit}:${relativePath}`], {
    encoding: null,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    problems.push(`${label} is not retrievable from its recorded Git commit`)
    return null
  }
  return result.stdout
}

function gitTree(root, commit, label, problems) {
  if (!COMMIT.test(commit ?? '')) {
    problems.push(`${label} source commit is invalid`)
    return null
  }
  const result = spawnSync('git', ['-C', root, 'rev-parse', `${commit}^{tree}`], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  const tree = result.stdout?.trim()
  if (result.status !== 0 || !COMMIT.test(tree ?? '')) {
    problems.push(`${label} source tree cannot be resolved`)
    return null
  }
  return tree
}

function sameConsumerIdentity(left, right) {
  return left?.name === right?.name &&
    left?.repository === right?.repository &&
    left?.reconciliationPath === right?.reconciliationPath
}

export function checkConsumerAdoptionHistory(history, reconciliation, historyRepositoryRoot = repositoryRoot) {
  const problems = []
  if (!exactKeys(history, ['schema', 'schemaVersion', 'consumer', 'epochs', 'head']) ||
      history.schema !== 'renovate-config.compass-consumer-adoption-history' || history.schemaVersion !== 1) {
    return ['consumer adoption history envelope is invalid']
  }
  if (!Array.isArray(history.epochs) || history.epochs.length === 0) {
    return ['consumer adoption history must retain at least the authenticated initial epoch']
  }
  if (!exactKeys(history.consumer, ['name', 'repository', 'reconciliationPath']) ||
      !sameConsumerIdentity(history.consumer, reconciliation?.consumer)) {
    problems.push('consumer adoption history identity does not match the current reconciliation consumer')
  }

  let previousEpochSha256 = null
  const historicalCandidates = new Set()
  const historicalIdentities = new Set()
  for (const [index, epoch] of history.epochs.entries()) {
    const label = `consumer adoption epoch ${index + 1}`
    if (!exactKeys(epoch, [
      'sequence', 'previousEpochSha256', 'state', 'sourceCommit', 'sourceTree', 'snapshotPath',
      'snapshotFileSha256', 'snapshotSchemaPath', 'snapshotSchemaFileSha256', 'snapshot', 'epochSha256',
    ])) {
      problems.push(`${label} fields are invalid`)
      continue
    }
    if (epoch.sequence !== index + 1 || epoch.previousEpochSha256 !== previousEpochSha256 || epoch.state !== 'adopted') {
      problems.push(`${label} sequence, predecessor, or state is invalid`)
    }
    const digestInput = { ...epoch }
    delete digestInput.epochSha256
    if (epoch.epochSha256 !== digestValue(digestInput)) problems.push(`${label} digest does not match its immutable contents`)
    const snapshotBytes = `${JSON.stringify(epoch.snapshot, null, 2)}\n`
    if (epoch.snapshotFileSha256 !== createHash('sha256').update(snapshotBytes).digest('hex')) {
      problems.push(`${label} snapshot-file digest is invalid`)
    }
    const resolvedTree = gitTree(historyRepositoryRoot, epoch.sourceCommit, label, problems)
    if (resolvedTree !== epoch.sourceTree) problems.push(`${label} source tree does not match its recorded Git commit`)
    const historicalSnapshot = gitBytes(
      historyRepositoryRoot, epoch.sourceCommit, epoch.snapshotPath, `${label} snapshot`, problems
    )
    if (historicalSnapshot && !historicalSnapshot.equals(Buffer.from(snapshotBytes))) {
      problems.push(`${label} snapshot bytes do not match the recorded historical Git object`)
    }
    const schemaBytes = gitBytes(
      historyRepositoryRoot, epoch.sourceCommit, epoch.snapshotSchemaPath, `${label} schema`, problems
    )
    if (schemaBytes) {
      if (createHash('sha256').update(schemaBytes).digest('hex') !== epoch.snapshotSchemaFileSha256) {
        problems.push(`${label} schema digest does not match the recorded historical Git object`)
      }
      try {
        const schema = JSON.parse(schemaBytes.toString('utf8'))
        for (const problem of validateJsonSchema(epoch.snapshot, schema)) {
          problems.push(`${label} historical schema: ${problem}`)
        }
      } catch (error) {
        problems.push(`${label} historical schema is unreadable: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!sameConsumerIdentity(epoch.snapshot?.consumer, history.consumer)) {
      problems.push(`${label} snapshot consumer does not match the immutable history consumer`)
    }
    const records = epoch.snapshot?.records
    if (!Array.isArray(records) || records.length === 0) {
      problems.push(`${label} contains no adopted records`)
      continue
    }
    const epochCandidates = new Set()
    for (const record of records) {
      if (epochCandidates.has(record?.candidateId)) problems.push(`${label} duplicates candidate ${String(record?.candidateId)}`)
      epochCandidates.add(record?.candidateId)
      historicalCandidates.add(record?.candidateId)
      const identity = JSON.stringify(stableValue(record?.authorityIdentity))
      historicalIdentities.add(identity)
      if (record?.consumerState !== 'adopted' || record?.transitionHistory?.at(-1)?.state !== 'adopted' ||
          !record?.adoptionEvidence?.hostedRun || record?.localReconciliation !== 'complete') {
        problems.push(`${label} candidate ${String(record?.candidateId)} does not preserve complete authenticated adoption evidence`)
      }
    }
    previousEpochSha256 = epoch.epochSha256
  }

  if (history.epochs[0]?.epochSha256 !== INITIAL_ADOPTION_EPOCH_SHA256) {
    problems.push('consumer adoption history does not retain the authenticated initial epoch anchor')
  }
  if (!exactKeys(history.head, ['sequence', 'epochSha256']) ||
      history.head.sequence !== history.epochs.length || history.head.epochSha256 !== previousEpochSha256) {
    problems.push('consumer adoption history head does not bind the final immutable epoch')
  }
  const currentRecords = new Map()
  for (const record of reconciliation?.records ?? []) {
    if (currentRecords.has(record?.candidateId)) {
      problems.push(`current reconciliation duplicates candidate ${String(record?.candidateId)}`)
      continue
    }
    currentRecords.set(record?.candidateId, record)
  }
  for (const candidateId of historicalCandidates) {
    if (!currentRecords.has(candidateId)) problems.push(`current reconciliation dropped historical candidate ${candidateId}`)
  }
  for (const record of currentRecords.values()) {
    if (historicalIdentities.has(JSON.stringify(stableValue(record.authorityIdentity)))) {
      problems.push(`current candidate ${record.candidateId} reuses a historical adopted identity`)
    }
  }
  return problems
}

function readableRealPath(candidate, label, problems) {
  try {
    return fs.realpathSync(candidate)
  } catch (error) {
    problems.push(`${label} cannot be resolved: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

export function checkSkillDiscovery(root, receipt) {
  const problems = []
  let routing
  try {
    routing = JSON.parse(fs.readFileSync(path.join(root, '.compass/agent-routing-surfaces.json'), 'utf8'))
  } catch (error) {
    problems.push(`Compass routing inventory is unreadable: ${error instanceof Error ? error.message : String(error)}`)
    return problems
  }

  const receiptPaths = new Set((receipt?.includedFiles ?? []).map(({ path: relative }) => relative))
  const projectedSkillNames = [...receiptPaths]
    .map((relative) => relative.match(SKILL_RECEIPT_PATH)?.[1])
    .filter(Boolean)
    .sort()
  if (projectedSkillNames.length === 0) problems.push('Compass receipt exposes no canonical shared skills')
  const adapterRoutes = (routing.physicalRoutes ?? [])
    .filter(({ distribution, routingMechanism }) =>
      distribution === 'projected' && routingMechanism === 'skill-directory-adapter')
  const projectedRoutes = adapterRoutes.flatMap(({ canonicalPaths }) => canonicalPaths ?? [])
  if (projectedRoutes.length === 0) problems.push('Compass routing inventory exposes no projected skill adapters')
  const adapters = adapterRoutes.map(({ canonicalPaths = [], id }) => {
    const roots = new Set(canonicalPaths.map((relative) => relative.split('/').slice(0, 2).join('/')))
    if (roots.size !== 1 || [...roots][0].split('/').length !== 2) {
      problems.push(`Compass routing inventory adapter ${String(id)} does not have one exact skill-directory root`)
      return null
    }
    return [...roots][0]
  }).filter(Boolean)
  if (new Set(adapters).size !== adapters.length) problems.push('Compass routing inventory duplicates a skill-directory root')

  for (const adapter of adapters) {
    const adapterPath = path.join(root, adapter)
    let current = root
    for (const part of adapter.split('/')) {
      current = path.join(current, part)
      try {
        if (fs.lstatSync(current).isSymbolicLink()) problems.push(`${adapter} discovery path contains symlink parent ${part}`)
      } catch {
        break
      }
    }
    let metadata
    try {
      metadata = fs.lstatSync(adapterPath)
    } catch (error) {
      problems.push(`${adapter} discovery adapter is unreadable: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      problems.push(`${adapter} discovery adapter must be a regular directory`)
      continue
    }

    const expected = projectedSkillNames.map((name) => `${adapter}/${name}/SKILL.md`)
    const declared = projectedRoutes.filter((relative) => relative.startsWith(`${adapter}/`)).sort()
    if (JSON.stringify(declared) !== JSON.stringify(expected)) {
      problems.push(`${adapter} routing manifest does not expose every receipt-bound canonical skill exactly once`)
    }
    const rootEntries = fs.readdirSync(adapterPath, { withFileTypes: true })
    const expectedNames = projectedSkillNames
    const actualNames = rootEntries.map(({ name }) => name).sort()
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      problems.push(`${adapter} contains an unexpected, missing, or stale adapter entry`)
    }
    const actual = []
    for (const entry of rootEntries) {
      const relative = `${adapter}/${entry.name}/SKILL.md`
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        problems.push(`${adapter}/${entry.name} must be a regular skill directory`)
        continue
      }
      const children = fs.readdirSync(path.join(adapterPath, entry.name), { withFileTypes: true })
      if (children.length !== 1 || children[0].name !== 'SKILL.md' ||
          children[0].isSymbolicLink() || !children[0].isFile()) {
        problems.push(`${adapter}/${entry.name} must contain only one regular SKILL.md adapter`)
        continue
      }
      actual.push(relative)
    }
    actual.sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`${adapter} discovery adapter inventory differs from the receipt-bound canonical skill inventory`)
    }
    for (const relative of expected) {
      const absolute = path.join(root, relative)
      try {
        const file = fs.lstatSync(absolute)
        if (file.isSymbolicLink() || !file.isFile()) problems.push(`${relative} must be a regular non-symlink file`)
      } catch (error) {
        problems.push(`${relative} is unreadable: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!receiptPaths.has(relative)) problems.push(`${relative} is absent from the Compass receipt`)
    }
  }
  return problems
}

function receiptAuthorityIdentity(receipt, receiptBytes) {
  return {
    sourceCommit: receipt?.source?.commit,
    sourceTree: receipt?.source?.tree,
    sourceFingerprintSha256: receipt?.source?.fingerprintSha256,
    artifactSha256: receipt?.artifactSha256,
    artifactBytes: receipt?.artifactBytes,
    validationReceiptSha256: receipt?.validation?.receiptSha256,
    artifactReceiptSha256: createHash('sha256').update(receiptBytes).digest('hex'),
  }
}

export function checkNativeDiscoveryEvidence(evidence, routing, receipt, receiptBytes, reconciliation) {
  const problems = []
  if (!exactKeys(evidence, ['schema', 'schemaVersion', 'authorityIdentity', 'observations']) ||
      evidence.schema !== 'renovate-config.compass-consumer-native-discovery' || evidence.schemaVersion !== 1) {
    return ['consumer-native discovery evidence envelope is invalid']
  }
  if (JSON.stringify(stableValue(evidence.authorityIdentity)) !==
      JSON.stringify(stableValue(receiptAuthorityIdentity(receipt, receiptBytes)))) {
    problems.push('consumer-native discovery evidence does not bind the containing Compass receipt')
  }
  const ecosystems = new Map((routing?.ecosystems ?? []).map((ecosystem) => [ecosystem.id, ecosystem]))
  const expectedSkillInventory = (routing?.skills ?? [])
    .map(({ name, canonicalSkillSha256 }) => ({ name, canonicalSkillSha256 }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const expectedSkillInventorySha256 = digestValue(expectedSkillInventory)
  if (ecosystems.size !== (routing?.ecosystems ?? []).length) {
    problems.push('Compass routing inventory duplicates an ecosystem identifier')
  }
  const observations = new Map()
  for (const observation of evidence.observations ?? []) {
    if (observations.has(observation?.id)) {
      problems.push(`consumer-native discovery evidence duplicates ${String(observation?.id)}`)
      continue
    }
    observations.set(observation?.id, observation)
    if (!ecosystems.has(observation?.id)) {
      problems.push(`consumer-native discovery evidence contains unknown ecosystem ${String(observation?.id)}`)
      continue
    }
    if (observation.state === 'unobserved' || observation.state === 'unsupported') {
      if (!exactKeys(observation, ['id', 'state', 'reason']) ||
          typeof observation.reason !== 'string' || observation.reason.trim() === '') {
        problems.push(`consumer-native discovery ${observation.id} lacks an exact non-success disposition`)
      }
    } else if (observation.state === 'observed') {
      if (!exactKeys(observation, ['id', 'state', 'toolVersion', 'command', 'skillInventorySha256', 'skillCount']) ||
          typeof observation.toolVersion !== 'string' || observation.toolVersion.trim() === '' ||
          typeof observation.command !== 'string' || observation.command.trim() === '' ||
          !/^[0-9a-f]{64}$/u.test(observation.skillInventorySha256 ?? '') ||
          !Number.isSafeInteger(observation.skillCount) || observation.skillCount < 1 ||
          observation.skillInventorySha256 !== expectedSkillInventorySha256 ||
          observation.skillCount !== expectedSkillInventory.length) {
        problems.push(`consumer-native discovery ${observation.id} observed evidence is invalid`)
      }
    } else {
      problems.push(`consumer-native discovery ${String(observation?.id)} state is invalid`)
    }
  }
  const expectedIds = [...ecosystems.keys()].sort()
  const observedIds = [...observations.keys()].sort()
  if (JSON.stringify(observedIds) !== JSON.stringify(expectedIds)) {
    problems.push('consumer-native discovery evidence does not cover every declared ecosystem exactly once')
  }
  const claimsComplete = (reconciliation?.records ?? []).some((record) =>
    record.localReconciliation === 'complete' || record.consumerState === 'adopted')
  if (claimsComplete) {
    const requiredNative = [...ecosystems.values()]
      .filter(({ id, support }) => id === 'codex' || String(support).includes('native-smoke-required'))
    for (const ecosystem of requiredNative) {
      if (observations.get(ecosystem.id)?.state !== 'observed') {
        problems.push(`complete Compass adoption requires observed native discovery for ${ecosystem.id}`)
      }
    }
  }
  return problems
}

export async function checkCompassConsumerReconciliation(root = repositoryRoot, options = {}) {
  const authenticateProvider = options.authenticateProvider === true
  const problems = await validateAuthorityBundle({
    projectionRoot: root,
    consumerRoot: root,
    reconciliationPath: CONSUMER_RECONCILIATION_PATH,
    providerToken: authenticateProvider ? options.providerToken : '',
  })
  if (!authenticateProvider) {
    const missingToken = 'provider provenance: an actions-read GitHub token is required'
    const index = problems.indexOf(missingToken)
    if (index >= 0) problems.splice(index, 1)
  }
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(root, '.compass/authority-registry.json'), 'utf8'))
    const reconciliation = JSON.parse(
      fs.readFileSync(path.join(root, CONSUMER_RECONCILIATION_PATH), 'utf8')
    )
    const adoptionHistory = JSON.parse(
      fs.readFileSync(path.join(root, CONSUMER_ADOPTION_HISTORY_PATH), 'utf8')
    )
    const nativeDiscovery = JSON.parse(
      fs.readFileSync(path.join(root, CONSUMER_NATIVE_DISCOVERY_PATH), 'utf8')
    )
    const routing = JSON.parse(
      fs.readFileSync(path.join(root, '.compass/agent-routing-surfaces.json'), 'utf8')
    )
    const receiptBytes = fs.readFileSync(path.join(root, '.compass/receipt.json'))
    const receipt = JSON.parse(receiptBytes)
    problems.push(...checkConsumerAdoptionHistory(adoptionHistory, reconciliation))
    problems.push(...checkNativeDiscoveryEvidence(nativeDiscovery, routing, receipt, receiptBytes, reconciliation))
    const issued = (registry.candidates ?? [])
      .filter(({ candidateState }) => candidateState === 'issued')
      .map(({ id }) => id)
      .sort()
    const local = (reconciliation.records ?? []).map(({ candidateId }) => candidateId).sort()
    if (JSON.stringify(local) !== JSON.stringify(issued)) {
      problems.push('renovate-config consumer reconciliation does not cover every issued candidate exactly once')
    }
  } catch (error) {
    problems.push(`renovate-config candidate coverage is unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
  return problems
}

export async function checkCompassProjection(root = repositoryRoot, options = {}) {
  const inspected = inspectCompassProjection(root)
  const problems = [
    ...inspected.problems,
    ...(inspected.receipt ? checkSkillDiscovery(root, inspected.receipt) : []),
    ...await checkCompassConsumerReconciliation(root, options),
  ]
  let agents
  try {
    agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
  } catch (error) {
    problems.push(`renovate-config AGENTS.md is unreadable: ${error instanceof Error ? error.message : String(error)}`)
    return problems
  }
  for (const reference of REQUIRED_DOCTRINE_ROUTES) {
    if (!agents.includes(reference)) {
      problems.push(`AGENTS.md does not route to projected Compass authority: ${reference}`)
    }
  }
  return problems
}

if (isMainModule(import.meta.url)) {
  const problems = await checkCompassProjection()
  if (problems.length > 0) {
    console.error(`Compass projection check failed:\n- ${problems.join('\n- ')}`)
    process.exitCode = 1
  } else {
    const receipt = JSON.parse(fs.readFileSync(path.join(repositoryRoot, '.compass/receipt.json'), 'utf8'))
    console.log(`Compass projection and consumer reconciliation match ${receipt.source.commit} (${receipt.artifactSha256}).`)
  }
}
