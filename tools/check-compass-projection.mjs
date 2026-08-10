#!/usr/bin/env node
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

export function checkCompassProjection(root = repositoryRoot) {
  const inspected = inspectCompassProjection(root)
  const problems = [
    ...inspected.problems,
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
