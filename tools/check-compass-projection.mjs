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
  commit: 'c0a45d8a9c8db0e4dcaa5e2d543c48ac208289a0',
  tree: '42cd8d33e7e0d1a21acf642c98dd146b54f896f8',
  fingerprintSha256: '116bdd9d0e7515339a2eaa0b9a561f0aadd6301e9422226b0a77d06c721fe8ee',
  artifactSha256: '636a96690a5e13c3d69cf98be78fa4c6c2b6f944b96e62438a055c54fc82744a',
  artifactBytes: 101807,
  validationReceiptSha256: 'fc77bd55c55bf050defa635cb8bb1957bb5aa9174ad27d324cfe7dd62a34bd10',
  receiptSha256: '3fed0ea564079a4c676d37f18b3266d8263537260057c69da3cec4f23bf4c005',
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
