#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { validateAuthorityBundle } from '../.compass/check-authority-record.mjs'
import { inspectCompassProjection } from '../.compass/check-projection.mjs'
import { isMainModule } from './is-main.mjs'
import { inspectSkillDiscoveryAdapters } from './sync-compass-skill-adapters.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CONSUMER_RECONCILIATION_PATH = 'tools/compass-consumer-reconciliation.json'
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
export function checkSkillDiscovery(root, receipt) {
  return inspectSkillDiscoveryAdapters(root, receipt).problems
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
