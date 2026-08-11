#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  validateAuthorityRegistry,
  validateConsumerReconciliation,
} from '../.compass/check-authority-record.mjs'
import { inspectCompassProjection } from '../.compass/check-projection.mjs'
import { isMainModule } from './is-main.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REQUIRED_DOCTRINE_ROUTES = Object.freeze([
  '.compass/COMPASS.md',
  '.compass/TERMINOLOGY.md',
  '.compass/ai-workload-policy.json',
  '.compass/authority-policy.json',
  '.compass/authority-registry.json',
  '.compass/consumer-reconciliation.schema.json',
  'skills/ai-backend-change/SKILL.md',
  'skills/shift-to-authority/SKILL.md',
])
const CONSUMER_RECONCILIATION_PATH = 'tools/compass-consumer-reconciliation.json'
const SKILL_RECEIPT_PATH = /^skills\/([^/]+)\/SKILL\.md$/u
const DISCOVERY_ADAPTERS = Object.freeze(['.agents/skills', '.claude/skills'])
export const HISTORICAL_COMPASS_IDENTITY = Object.freeze({
  commit: '043568a695b589154036ec85bc56e681a2b1e370',
  tree: 'b5c9cab0aa018332a12498ffe58a5d60ef4af793',
  fingerprintSha256: 'd22d95c06b507a6506d49c290d5d3a14f435ebcf2db7d6bd3ea0a91abb37c69d',
  artifactSha256: '5a7b66cf0f36c95561eff56b386e7df6d9895b4e2a4c65ce5f5aaa8046293d43',
  artifactBytes: 189698,
  validationReceiptSha256: '8f637ca850edbedd39bc440939006b10c8b37dc59fe0cc8d167f15699a0e5b5d',
  receiptSha256: '920c5cee7f4ac98582d3a541751f5fa147c1aa58318756cc6e9ea14381506374',
})

const HISTORICAL_EXACT_IDENTITY = Object.freeze({
  sourceCommit: HISTORICAL_COMPASS_IDENTITY.commit,
  sourceTree: HISTORICAL_COMPASS_IDENTITY.tree,
  sourceFingerprintSha256: HISTORICAL_COMPASS_IDENTITY.fingerprintSha256,
  artifactSha256: HISTORICAL_COMPASS_IDENTITY.artifactSha256,
  artifactBytes: HISTORICAL_COMPASS_IDENTITY.artifactBytes,
  validationReceiptSha256: HISTORICAL_COMPASS_IDENTITY.validationReceiptSha256,
  artifactReceiptSha256: HISTORICAL_COMPASS_IDENTITY.receiptSha256,
})

function exactIdentityMatches(candidate) {
  return candidate && Object.keys(HISTORICAL_EXACT_IDENTITY).every(
    (field) => candidate[field] === HISTORICAL_EXACT_IDENTITY[field]
  ) && Object.keys(candidate).length === Object.keys(HISTORICAL_EXACT_IDENTITY).length
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
  const projectedSkillNames = Array.isArray(receipt?.includedFiles)
    ? receipt.includedFiles
      .map((entry) => entry?.path?.match(SKILL_RECEIPT_PATH)?.[1])
      .filter(Boolean)
    : []
  if (projectedSkillNames.length === 0) {
    problems.push('Compass receipt exposes no projected skill entrypoints')
    return problems
  }

  const canonicalSkills = readableRealPath(path.join(root, 'skills'), 'canonical skills directory', problems)
  if (!canonicalSkills) return problems

  for (const adapter of DISCOVERY_ADAPTERS) {
    const adapterPath = path.join(root, adapter)
    let metadata
    try {
      metadata = fs.lstatSync(adapterPath)
    } catch (error) {
      problems.push(`${adapter} discovery adapter is unreadable: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (!metadata.isSymbolicLink()) {
      problems.push(`${adapter} discovery adapter must be a symbolic link to skills`)
      continue
    }
    const resolvedAdapter = readableRealPath(adapterPath, `${adapter} discovery adapter`, problems)
    if (resolvedAdapter !== canonicalSkills) {
      problems.push(`${adapter} discovery adapter does not resolve exactly to the canonical skills directory`)
      continue
    }
    for (const name of projectedSkillNames) {
      const canonicalSkill = readableRealPath(
        path.join(root, 'skills', name, 'SKILL.md'),
        `canonical skill ${name}`,
        problems
      )
      const discoveredSkill = readableRealPath(
        path.join(adapterPath, name, 'SKILL.md'),
        `${adapter} skill ${name}`,
        problems
      )
      if (canonicalSkill && discoveredSkill && discoveredSkill !== canonicalSkill) {
        problems.push(`${adapter} skill ${name} does not resolve to its canonical entrypoint`)
      }
    }
  }
  return problems
}

export function checkHistoricalCompassIdentity(receipt, receiptSha256) {
  const problems = []
  for (const [key, actual] of [
    ['commit', receipt?.source?.commit],
    ['tree', receipt?.source?.tree],
    ['fingerprintSha256', receipt?.source?.fingerprintSha256],
    ['artifactSha256', receipt?.artifactSha256],
    ['artifactBytes', receipt?.artifactBytes],
    ['validationReceiptSha256', receipt?.validation?.receiptSha256],
    ['receiptSha256', receiptSha256],
  ]) {
    if (actual !== HISTORICAL_COMPASS_IDENTITY[key]) {
      problems.push(`renovate-config historical Compass ${key} differs`)
    }
  }
  return problems
}

function parseLocalJson(root, relativePath, label, problems) {
  try {
    const file = path.join(root, relativePath)
    const metadata = fs.lstatSync(file)
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      problems.push(`${label} must be a regular non-symlink file`)
      return null
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    problems.push(`${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

export function checkCompassConsumerReconciliation(root = repositoryRoot) {
  const problems = []
  const policy = parseLocalJson(root, '.compass/authority-policy.json', 'Compass authority policy', problems)
  const registry = parseLocalJson(root, '.compass/authority-registry.json', 'Compass authority registry', problems)
  const reconciliation = parseLocalJson(root, CONSUMER_RECONCILIATION_PATH, 'renovate-config Compass reconciliation', problems)
  if (!policy || !registry || !reconciliation) return problems

  problems.push(...validateAuthorityRegistry(registry, policy))
  problems.push(...validateConsumerReconciliation(reconciliation, policy))
  if (reconciliation.consumer?.name !== 'renovate-config' || reconciliation.consumer?.repository !== 'jasondockery/renovate-config') {
    problems.push('renovate-config Compass reconciliation has the wrong consumer identity')
  }

  const issuedCandidateIds = (Array.isArray(registry.candidates) ? registry.candidates : [])
    .filter((candidate) => candidate.candidateState === 'issued')
    .map((candidate) => candidate.id)
    .sort()
  const records = Array.isArray(reconciliation.records) ? reconciliation.records : []
  const localCandidateIds = records.map((record) => record.candidateId).sort()
  if (JSON.stringify(localCandidateIds) !== JSON.stringify(issuedCandidateIds)) {
    problems.push('renovate-config Compass reconciliation does not cover every issued candidate exactly once')
  }
  for (const record of records) {
    if (record.relationship !== 'direct') {
      problems.push(`renovate-config Compass reconciliation ${record.candidateId} is not direct`)
    }
    if (record.consumerState !== 'pending-adoption' || record.localReconciliation !== 'pending') {
      problems.push(`renovate-config Compass reconciliation ${record.candidateId} does not preserve the adoption hold`)
    }
    if (!exactIdentityMatches(record.authorityIdentity)) {
      problems.push(`renovate-config Compass reconciliation ${record.candidateId} differs from the historical projection identity`)
    }
    if (Object.hasOwn(record, 'consumerProof')) {
      problems.push(`renovate-config Compass reconciliation ${record.candidateId} retains withdrawn consumer proof`)
    }
  }
  return problems
}

export function checkCompassProjection(root = repositoryRoot) {
  const inspected = inspectCompassProjection(root)
  let receiptSha256
  if (inspected.receipt && inspected.problems.length === 0) {
    try {
      receiptSha256 = createHash('sha256')
        .update(fs.readFileSync(path.join(root, '.compass/receipt.json')))
        .digest('hex')
    } catch (error) {
      inspected.problems.push(
        `renovate-config historical Compass receipt cannot be hashed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  const problems = [
    ...inspected.problems,
    ...(inspected.receipt && inspected.problems.length === 0
      ? checkHistoricalCompassIdentity(inspected.receipt, receiptSha256)
      : []),
    ...(inspected.receipt ? checkSkillDiscovery(root, inspected.receipt) : []),
    ...checkCompassConsumerReconciliation(root),
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
  const problems = checkCompassProjection()
  if (problems.length > 0) {
    console.error(`Compass projection check failed:\n- ${problems.join('\n- ')}`)
    process.exitCode = 1
  } else {
    const receipt = JSON.parse(fs.readFileSync(path.join(repositoryRoot, '.compass/receipt.json'), 'utf8'))
    console.log(`Compass projection matches ${receipt.source.commit} (${receipt.artifactSha256}).`)
  }
}
