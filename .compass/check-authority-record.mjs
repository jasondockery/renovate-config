#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const COMMIT = /^[0-9a-f]{40}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const CANDIDATE_ID = /^sta-[a-z0-9]+(?:-[a-z0-9]+)*$/u
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const MAX_RECORD_BYTES = 1024 * 1024
const REQUIRED_IDENTITY_DIMENSIONS = Object.freeze([
  'sourceCommit',
  'sourceTree',
  'sourceFingerprintSha256',
  'artifactSha256',
  'artifactBytes',
  'validationReceiptSha256',
  'artifactReceiptSha256',
])
const modulePath = fileURLToPath(import.meta.url)

function exactKeys(value, expected, label, problems) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${label} must be an object`)
    return false
  }
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    problems.push(`${label} has missing or unknown fields`)
    return false
  }
  return true
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function oneOf(value, allowed, label, problems) {
  if (!allowed.includes(value)) problems.push(`${label} is invalid`)
}

function validateExactIdentity(identity, label, problems) {
  if (!exactKeys(identity, REQUIRED_IDENTITY_DIMENSIONS, label, problems)) return
  if (!COMMIT.test(identity.sourceCommit) || !COMMIT.test(identity.sourceTree)) problems.push(`${label} commit or tree is invalid`)
  for (const key of ['sourceFingerprintSha256', 'artifactSha256', 'validationReceiptSha256', 'artifactReceiptSha256']) {
    if (!SHA256.test(identity[key])) problems.push(`${label} ${key} is invalid`)
  }
  if (!Number.isSafeInteger(identity.artifactBytes) || identity.artifactBytes < 1) problems.push(`${label} artifactBytes is invalid`)
}

function validateTransitionIdentity(identity, label, problems) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    problems.push(`${label} must be an object`)
    return
  }
  if (identity.kind === 'source') {
    if (!exactKeys(identity, ['kind', 'repository', 'commit'], label, problems)) return
    if (!nonEmpty(identity.repository) || !COMMIT.test(identity.commit)) problems.push(`${label} source identity is invalid`)
    return
  }
  if (identity.kind === 'containing-artifact-receipt') {
    if (!exactKeys(identity, ['kind', 'requiredDimensions'], label, problems)) return
    if (JSON.stringify(identity.requiredDimensions) !== JSON.stringify(REQUIRED_IDENTITY_DIMENSIONS)) {
      problems.push(`${label} does not require the exact seven-dimensional artifact identity`)
    }
    return
  }
  problems.push(`${label} kind is invalid`)
}

export function validateAuthorityPolicy(policy) {
  const problems = []
  const keys = [
    'schema', 'schemaVersion', 'term', 'skillIdentifier', 'reviewField', 'requiredReviewClasses',
    'lifecycle', 'candidateStates', 'localRepairStates', 'authorityReconciliationStates',
    'incorporationStates', 'consumerStates', 'relationships', 'candidateIdPattern',
    'authorities', 'newAuthorityPrerequisites', 'contracts', 'reviewTemplateFields',
  ]
  if (!exactKeys(policy, keys, 'authority policy', problems)) return problems
  if (policy.schema !== 'compass.shift-to-authority-policy' || policy.schemaVersion !== 2 || policy.term !== 'Shift to Authority') {
    problems.push('authority policy identity is invalid')
  }
  for (const [key, minimum] of [
    ['requiredReviewClasses', 1], ['lifecycle', 5], ['candidateStates', 5], ['localRepairStates', 3],
    ['authorityReconciliationStates', 3], ['incorporationStates', 4], ['consumerStates', 5],
    ['relationships', 3], ['newAuthorityPrerequisites', 1], ['reviewTemplateFields', 1],
  ]) {
    const values = policy[key]
    if (!Array.isArray(values) || values.length < minimum || values.some((value) => !nonEmpty(value)) || new Set(values).size !== values.length) {
      problems.push(`authority policy ${key} is invalid`)
    }
  }
  if (policy.candidateIdPattern !== CANDIDATE_ID.source) problems.push('authority policy candidate ID pattern is invalid')
  if (!policy.authorities || typeof policy.authorities !== 'object' || Array.isArray(policy.authorities)) problems.push('authority policy authorities are invalid')
  if (!exactKeys(policy.contracts, ['authorityRegistry', 'authorityRegistrySchema', 'consumerReconciliationSchema', 'validator'], 'authority policy contracts', problems)) return problems
  for (const value of Object.values(policy.contracts)) if (!nonEmpty(value) || path.posix.isAbsolute(value) || value.includes('..')) problems.push('authority policy contract path is invalid')
  return problems
}

export function validateAuthorityRegistry(registry, policy) {
  const problems = [...validateAuthorityPolicy(policy)]
  if (!exactKeys(registry, ['schema', 'schemaVersion', 'authority', 'candidates', 'heldAuthorityIdentities'], 'authority registry', problems)) return problems
  if (registry.schema !== 'compass.shift-to-authority-registry' || registry.schemaVersion !== 1 || registry.authority !== 'compass') {
    problems.push('authority registry identity is invalid')
  }
  if (!Array.isArray(registry.candidates) || registry.candidates.length < 1) problems.push('authority registry candidates are missing')
  const ids = new Set()
  const legal = new Set(['local:nominated', 'nominated:accepted', 'accepted:issued', 'local:rejected', 'nominated:rejected', 'accepted:rejected'])
  for (const candidate of registry.candidates ?? []) {
    const label = `candidate ${String(candidate?.id)}`
    const keys = [
      'id', 'invariant', 'origin', 'evidence', 'affectedScope', 'localRepairStatus',
      'authorityReconciliation', 'incorporationStatus', 'proposedAuthority', 'ownershipReason',
      'consumerOwnedRemainder', 'candidateState', 'authorityIdentity', 'supersedes', 'transitionHistory',
    ]
    if (!exactKeys(candidate, keys, label, problems)) continue
    if (!CANDIDATE_ID.test(candidate.id) || ids.has(candidate.id)) problems.push(`${label} ID is invalid or duplicated`)
    ids.add(candidate.id)
    for (const key of ['invariant', 'ownershipReason', 'consumerOwnedRemainder']) if (!nonEmpty(candidate[key])) problems.push(`${label} ${key} is empty`)
    if (!Array.isArray(candidate.affectedScope) || candidate.affectedScope.length < 1 || candidate.affectedScope.some((value) => !nonEmpty(value))) problems.push(`${label} affectedScope is invalid`)
    if (!exactKeys(candidate.origin, ['repository', 'identity'], `${label} origin`, problems)) continue
    if (!nonEmpty(candidate.origin.repository)) problems.push(`${label} origin repository is invalid`)
    validateTransitionIdentity(candidate.origin.identity, `${label} origin identity`, problems)
    if (!Array.isArray(candidate.evidence) || candidate.evidence.length < 1) problems.push(`${label} evidence is missing`)
    for (const [index, evidence] of (candidate.evidence ?? []).entries()) {
      const evidenceLabel = `${label} evidence ${index + 1}`
      if (!exactKeys(evidence, ['id', 'type', 'repository', 'sourceCommit', 'summary'], evidenceLabel, problems)) continue
      if (!NAME.test(evidence.id) || !NAME.test(evidence.type) || !nonEmpty(evidence.repository) || !COMMIT.test(evidence.sourceCommit) || !nonEmpty(evidence.summary)) problems.push(`${evidenceLabel} is invalid`)
    }
    oneOf(candidate.localRepairStatus, policy.localRepairStates ?? [], `${label} localRepairStatus`, problems)
    oneOf(candidate.authorityReconciliation, policy.authorityReconciliationStates ?? [], `${label} authorityReconciliation`, problems)
    oneOf(candidate.incorporationStatus, policy.incorporationStates ?? [], `${label} incorporationStatus`, problems)
    oneOf(candidate.candidateState, policy.candidateStates ?? [], `${label} candidateState`, problems)
    if (!nonEmpty(candidate.proposedAuthority) || !Object.hasOwn(policy.authorities ?? {}, candidate.proposedAuthority)) problems.push(`${label} proposedAuthority is invalid`)
    if (candidate.supersedes !== null && !CANDIDATE_ID.test(candidate.supersedes)) problems.push(`${label} supersedes is invalid`)
    if (!Array.isArray(candidate.transitionHistory) || candidate.transitionHistory.length < 1) {
      problems.push(`${label} transition history is missing`)
      continue
    }
    let previous = null
    for (const [index, transition] of candidate.transitionHistory.entries()) {
      const transitionLabel = `${label} transition ${index + 1}`
      if (!exactKeys(transition, ['sequence', 'state', 'identity'], transitionLabel, problems)) continue
      if (transition.sequence !== index + 1) problems.push(`${transitionLabel} sequence is invalid`)
      oneOf(transition.state, policy.candidateStates ?? [], `${transitionLabel} state`, problems)
      validateTransitionIdentity(transition.identity, `${transitionLabel} identity`, problems)
      if (previous && !legal.has(`${previous}:${transition.state}`)) problems.push(`${transitionLabel} is an illegal ${previous} to ${transition.state} transition`)
      previous = transition.state
    }
    if (candidate.transitionHistory[0]?.state !== 'local' || previous !== candidate.candidateState) problems.push(`${label} current state does not match ordered transition history`)
    if (candidate.candidateState === 'issued') {
      validateTransitionIdentity(candidate.authorityIdentity, `${label} authorityIdentity`, problems)
      if (candidate.authorityIdentity?.kind !== 'containing-artifact-receipt' || candidate.authorityReconciliation !== 'complete' || candidate.incorporationStatus !== 'complete') {
        problems.push(`${label} issued state lacks exact receipt binding or completed authority work`)
      }
    } else if (candidate.authorityIdentity !== null) problems.push(`${label} non-issued state has an authorityIdentity`)
  }
  if (!Array.isArray(registry.heldAuthorityIdentities) || registry.heldAuthorityIdentities.length < 1) problems.push('authority registry held identities are missing')
  for (const [index, hold] of (registry.heldAuthorityIdentities ?? []).entries()) {
    const label = `held authority identity ${index + 1}`
    if (!exactKeys(hold, ['identity', 'disposition', 'reason'], label, problems)) continue
    validateExactIdentity(hold.identity, `${label} identity`, problems)
    if (hold.disposition !== 'historical-not-adoptable' || !nonEmpty(hold.reason)) problems.push(`${label} disposition is invalid`)
  }
  return problems
}

export function validateConsumerReconciliation(record, policy) {
  const problems = [...validateAuthorityPolicy(policy)]
  if (!exactKeys(record, ['schema', 'schemaVersion', 'consumer', 'records'], 'consumer reconciliation', problems)) return problems
  if (record.schema !== 'compass.consumer-reconciliation' || record.schemaVersion !== 1) problems.push('consumer reconciliation identity is invalid')
  if (!exactKeys(record.consumer, ['name', 'repository'], 'consumer identity', problems) || !NAME.test(record.consumer?.name ?? '') || !nonEmpty(record.consumer?.repository)) problems.push('consumer identity is invalid')
  if (!Array.isArray(record.records) || record.records.length < 1) problems.push('consumer reconciliation records are missing')
  const ids = new Set()
  for (const item of record.records ?? []) {
    const label = `consumer record ${String(item?.candidateId)}`
    const base = ['candidateId', 'relationship', 'consumerState', 'localReconciliation']
    if (!item || typeof item !== 'object' || Array.isArray(item)) { problems.push(`${label} must be an object`); continue }
    const allowed = new Set([...base, 'authorityIdentity', 'viaAuthority', 'consumerProof', 'deferredDisposition', 'notApplicableReason'])
    if (Object.keys(item).some((key) => !allowed.has(key)) || base.some((key) => !Object.hasOwn(item, key))) problems.push(`${label} has missing or unknown fields`)
    if (!CANDIDATE_ID.test(item.candidateId) || ids.has(item.candidateId)) problems.push(`${label} candidate ID is invalid or duplicated`)
    ids.add(item.candidateId)
    oneOf(item.relationship, policy.relationships ?? [], `${label} relationship`, problems)
    oneOf(item.consumerState, policy.consumerStates ?? [], `${label} consumerState`, problems)
    oneOf(item.localReconciliation, ['pending', 'complete', 'not-required'], `${label} localReconciliation`, problems)
    if (item.relationship === 'direct') {
      validateExactIdentity(item.authorityIdentity, `${label} authorityIdentity`, problems)
      if (Object.hasOwn(item, 'viaAuthority') || Object.hasOwn(item, 'notApplicableReason')) problems.push(`${label} direct relationship has forbidden relationship fields`)
    } else if (item.relationship === 'via-authority') {
      if (!exactKeys(item.viaAuthority, ['name', 'identity'], `${label} viaAuthority`, problems)) continue
      if (!NAME.test(item.viaAuthority.name)) problems.push(`${label} via authority name is invalid`)
      validateExactIdentity(item.viaAuthority.identity, `${label} via authority identity`, problems)
      if (Object.hasOwn(item, 'authorityIdentity') || Object.hasOwn(item, 'notApplicableReason')) problems.push(`${label} via-authority relationship has forbidden relationship fields`)
    } else if (item.relationship === 'not-applicable') {
      if (item.consumerState !== 'not-applicable' || item.localReconciliation !== 'not-required' || !nonEmpty(item.notApplicableReason)) problems.push(`${label} not-applicable relationship lacks its reason and exact state`)
      for (const key of ['authorityIdentity', 'viaAuthority', 'consumerProof', 'deferredDisposition']) if (Object.hasOwn(item, key)) problems.push(`${label} not-applicable relationship has forbidden ${key}`)
      continue
    }
    if (item.consumerState === 'adopted') {
      if (item.localReconciliation !== 'complete') problems.push(`${label} adopted state lacks complete local reconciliation`)
      if (!exactKeys(item.consumerProof, ['commit', 'tree', 'receiptSha256', 'hostedRun'], `${label} consumerProof`, problems)) continue
      if (!COMMIT.test(item.consumerProof.commit) || !COMMIT.test(item.consumerProof.tree) || !SHA256.test(item.consumerProof.receiptSha256)) problems.push(`${label} consumer proof identity is invalid`)
      if (!exactKeys(item.consumerProof.hostedRun, ['provider', 'runId', 'attempt', 'headSha'], `${label} hostedRun`, problems) || item.consumerProof.hostedRun?.provider !== 'github-actions' || !Number.isSafeInteger(item.consumerProof.hostedRun?.runId) || !Number.isSafeInteger(item.consumerProof.hostedRun?.attempt) || item.consumerProof.hostedRun?.headSha !== item.consumerProof.commit) problems.push(`${label} hosted proof is invalid`)
    } else if (Object.hasOwn(item, 'consumerProof')) problems.push(`${label} non-adopted state has consumer proof`)
    if (item.consumerState === 'deferred') {
      if (!exactKeys(item.deferredDisposition, ['reason', 'approvingOwner', 'exactScope', 'reviewOrExpirationDate', 'conformanceClaim'], `${label} deferredDisposition`, problems)) continue
      if (![item.deferredDisposition.reason, item.deferredDisposition.approvingOwner, item.deferredDisposition.exactScope, item.deferredDisposition.reviewOrExpirationDate].every(nonEmpty) || item.deferredDisposition.conformanceClaim !== false) problems.push(`${label} deferred disposition is invalid`)
    } else if (Object.hasOwn(item, 'deferredDisposition')) problems.push(`${label} non-deferred state has a deferred disposition`)
  }
  return problems
}

export function renderReviewTemplate(policy) {
  return `${policy.reviewField}:\n- none\n\nCandidate fields (one or more; never combine with none):\n${policy.reviewTemplateFields.map((field) => `- ${field}: <value>`).join('\n')}\n`
}

function parseJson(file) {
  const absolute = path.resolve(file)
  const stat = fs.lstatSync(absolute)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`record must be a regular non-symlink file: ${absolute}`)
  if (stat.size > MAX_RECORD_BYTES) throw new Error(`record exceeds ${MAX_RECORD_BYTES} bytes: ${absolute}`)
  return JSON.parse(fs.readFileSync(absolute, 'utf8'))
}

function parseArguments(arguments_) {
  const options = {}
  for (let index = 0; index < arguments_.length; index += 1) {
    const key = arguments_[index]
    if (!['--policy', '--registry', '--consumer', '--print-review-template'].includes(key)) throw new Error('unsupported argument')
    if (key === '--print-review-template') { options.printReviewTemplate = true; continue }
    if (!arguments_[index + 1]) throw new Error(`missing value for ${key}`)
    options[key.slice(2)] = arguments_[index + 1]
    index += 1
  }
  if (!options.policy) throw new Error('missing --policy')
  if (options.printReviewTemplate && (options.registry || options.consumer)) throw new Error('template mode cannot validate records')
  if (!options.printReviewTemplate && Boolean(options.registry) === Boolean(options.consumer)) throw new Error('provide exactly one of --registry or --consumer')
  return options
}

function isMainModule() {
  try { return fs.realpathSync.native(path.resolve(process.argv[1])) === fs.realpathSync.native(modulePath) } catch { return false }
}

if (isMainModule()) {
  try {
    const options = parseArguments(process.argv.slice(2))
    const policy = parseJson(options.policy)
    if (options.printReviewTemplate) process.stdout.write(renderReviewTemplate(policy))
    else {
      const problems = options.registry
        ? validateAuthorityRegistry(parseJson(options.registry), policy)
        : validateConsumerReconciliation(parseJson(options.consumer), policy)
      if (problems.length > 0) throw new Error(problems.join('; '))
      console.log(`Authority record valid: ${path.resolve(options.registry ?? options.consumer)}`)
    }
  } catch (error) {
    console.error(`check-authority-record: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
