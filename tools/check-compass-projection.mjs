#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { inspectCompassProjection } from '../.compass/check-projection.mjs'
import { isMainModule } from './is-main.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REQUIRED_DOCTRINE_ROUTES = Object.freeze([
  '.compass/COMPASS.md',
  '.compass/TERMINOLOGY.md',
])
const SKILL_RECEIPT_PATH = /^skills\/([^/]+)\/SKILL\.md$/u
const DISCOVERY_ADAPTERS = Object.freeze(['.agents/skills', '.claude/skills'])
export const ACCEPTED_COMPASS_IDENTITY = Object.freeze({
  commit: '94c7770e4b7d2e8652763ad16c4dba4eb181c8a4',
  tree: '054dcf341b37b04a3bbe8175202bc26ffb272708',
  fingerprintSha256: '24f7c2f58d2641614c0da9cefa567ba2983caf5b37520e2ff1cf19449bce8db0',
  artifactSha256: 'ba5441a9975d6f0d3a72ffc764d84ecbb594a6fa21ab010682457ac6f2bb7e4c',
  artifactBytes: 79802,
  validationReceiptSha256: 'face36ace31e22df4eb50ae96fd79a4685de4fb062768c256e21d35093640c31',
  receiptSha256: '86050efa560bac46c06901840df3cda1a7fadd95168bd3837ecc02e8407bdf14',
})

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

export function checkAcceptedCompassIdentity(receipt, receiptSha256) {
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
    if (actual !== ACCEPTED_COMPASS_IDENTITY[key]) {
      problems.push(`renovate-config accepted Compass ${key} differs`)
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
        `renovate-config accepted Compass receipt cannot be hashed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  const problems = [
    ...inspected.problems,
    ...(inspected.receipt && inspected.problems.length === 0
      ? checkAcceptedCompassIdentity(inspected.receipt, receiptSha256)
      : []),
    ...(inspected.receipt ? checkSkillDiscovery(root, inspected.receipt) : []),
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
