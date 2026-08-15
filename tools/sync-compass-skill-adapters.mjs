#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKILL_RECEIPT_PATH = /^skills\/([^/]+)\/SKILL\.md$/u
export const COMPASS_SKILL_DISCOVERY_SURFACES = Object.freeze([
  '.agents/skills',
  '.claude/skills',
  '.codex/skills',
])

function expectedReviewableAdapter() {
  return `---
name: reviewable-agent-workspaces
description: Route agent workspace and review-surface decisions to the canonical projected Compass skill.
---

# Reviewable agent workspaces adapter

Load \`../../../skills/reviewable-agent-workspaces/SKILL.md\` as the canonical
procedure. This adapter contains no independent workspace policy.
`
}

export function projectedSkillNames(receipt) {
  return Array.isArray(receipt?.includedFiles)
    ? receipt.includedFiles
      .map((entry) => entry?.path?.match(SKILL_RECEIPT_PATH)?.[1])
      .filter(Boolean)
      .sort()
    : []
}

export function renderSkillAdapter(name, { projected = true } = {}) {
  if (name === 'reviewable-agent-workspaces') return expectedReviewableAdapter()
  return `---
name: ${name}
description: Route agent discovery to the ${projected ? 'canonical projected Compass' : 'repository-local canonical'} ${name} skill.
---

# Compass skill adapter

Load \`../../../skills/${name}/SKILL.md\` as the canonical procedure. This
adapter contains no independent policy.
`
}

function lstat(candidate, label, problems) {
  try {
    return fs.lstatSync(candidate)
  } catch (error) {
    problems.push(`${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function assertRegularDirectory(candidate, label, problems) {
  const metadata = lstat(candidate, label, problems)
  if (!metadata) return false
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    problems.push(`${label} must be a regular directory, not a symlink or other node`)
    return false
  }
  return true
}

function canonicalSkillNames(root, problems) {
  const skillsRoot = path.join(root, 'skills')
  if (!assertRegularDirectory(skillsRoot, 'canonical skills directory', problems)) return []
  const names = []
  for (const entry of fs.readdirSync(skillsRoot).sort()) {
    const directory = path.join(skillsRoot, entry)
    const metadata = fs.lstatSync(directory)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue
    const skill = path.join(directory, 'SKILL.md')
    if (!fs.existsSync(skill)) continue
    const skillMetadata = fs.lstatSync(skill)
    if (skillMetadata.isSymbolicLink() || !skillMetadata.isFile()) {
      problems.push(`canonical skill ${entry} must be a regular repository-local file`)
      continue
    }
    names.push(entry)
  }
  return names
}

function inspectSurface(root, surface, names, issuedNames, problems) {
  const surfacePath = path.join(root, surface)
  const inventory = []
  if (!assertRegularDirectory(surfacePath, `${surface} discovery surface`, problems)) return inventory

  let entries
  try {
    entries = fs.readdirSync(surfacePath).sort()
  } catch (error) {
    problems.push(`${surface} inventory is unreadable: ${error instanceof Error ? error.message : String(error)}`)
    return inventory
  }
  const expected = new Set(names)
  for (const entry of entries) {
    if (!expected.has(entry)) problems.push(`${surface} contains stale or orphaned adapter ${entry}`)
  }
  for (const name of names) {
    const skillDirectory = path.join(surfacePath, name)
    if (!assertRegularDirectory(skillDirectory, `${surface} adapter ${name}`, problems)) continue
    const children = fs.readdirSync(skillDirectory).sort()
    if (children.length !== 1 || children[0] !== 'SKILL.md') {
      problems.push(`${surface} adapter ${name} must contain only SKILL.md`)
      continue
    }
    const adapterPath = path.join(skillDirectory, 'SKILL.md')
    const metadata = lstat(adapterPath, `${surface} adapter ${name} entrypoint`, problems)
    if (!metadata || metadata.isSymbolicLink() || !metadata.isFile()) {
      problems.push(`${surface} adapter ${name} entrypoint must be a regular file`)
      continue
    }
    const actual = fs.readFileSync(adapterPath, 'utf8')
    if (actual !== renderSkillAdapter(name, { projected: issuedNames.has(name) })) {
      problems.push(`${surface} adapter ${name} does not route exactly to its canonical entrypoint`)
      continue
    }
    inventory.push(name)
  }
  return inventory
}

export function inspectSkillDiscoveryAdapters(root, receipt) {
  const problems = []
  const issuedNames = projectedSkillNames(receipt)
  if (issuedNames.length === 0) {
    return { names: [], issuedNames, inventories: {}, problems: ['Compass receipt exposes no projected skill entrypoints'] }
  }
  if (new Set(issuedNames).size !== issuedNames.length) {
    problems.push('Compass receipt contains duplicate projected skill entrypoints')
  }
  const names = canonicalSkillNames(root, problems)
  const canonical = new Set(names)
  for (const name of issuedNames) {
    if (!canonical.has(name)) problems.push(`receipt-bound skill ${name} has no canonical repository-local entrypoint`)
  }
  const issued = new Set(issuedNames)
  const inventories = {}
  for (const surface of COMPASS_SKILL_DISCOVERY_SURFACES) {
    inventories[surface] = inspectSurface(root, surface, names, issued, problems)
    if (JSON.stringify(inventories[surface]) !== JSON.stringify(names)) {
      problems.push(`${surface} discovery inventory does not equal the complete canonical skill inventory`)
    }
    const discoveredIssued = inventories[surface].filter((name) => issued.has(name))
    if (JSON.stringify(discoveredIssued) !== JSON.stringify(issuedNames)) {
      problems.push(`${surface} discovery inventory does not expose all issued Compass skills exactly once`)
    }
  }
  return { names, issuedNames, inventories, problems }
}

function ensureWritableSurface(root, surface) {
  const parent = path.dirname(path.join(root, surface))
  const parentMetadata = fs.lstatSync(parent)
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error(`${path.relative(root, parent)} must be a regular directory`)
  }
  const surfacePath = path.join(root, surface)
  const surfaceMetadata = fs.lstatSync(surfacePath)
  if (surfaceMetadata.isSymbolicLink() || !surfaceMetadata.isDirectory()) {
    throw new Error(`${surface} must be an explicitly migrated regular directory`)
  }
  return surfacePath
}

export function writeSkillDiscoveryAdapters(root, receipt) {
  const issuedNames = projectedSkillNames(receipt)
  if (issuedNames.length === 0) throw new Error('Compass receipt exposes no projected skill entrypoints')
  if (new Set(issuedNames).size !== issuedNames.length) throw new Error('Compass receipt contains duplicate projected skill entrypoints')
  const sourceProblems = []
  const names = canonicalSkillNames(root, sourceProblems)
  if (sourceProblems.length > 0) throw new Error(sourceProblems.join('; '))
  const issued = new Set(issuedNames)
  for (const surface of COMPASS_SKILL_DISCOVERY_SURFACES) {
    const surfacePath = ensureWritableSurface(root, surface)
    const entries = fs.readdirSync(surfacePath)
    for (const entry of entries) {
      if (!names.includes(entry)) throw new Error(`${surface} contains unexpected adapter ${entry}`)
    }
    for (const name of names) {
      const directory = path.join(surfacePath, name)
      if (!fs.existsSync(directory)) fs.mkdirSync(directory)
      const directoryMetadata = fs.lstatSync(directory)
      if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
        throw new Error(`${surface} adapter ${name} must be a regular directory`)
      }
      const entrypoint = path.join(directory, 'SKILL.md')
      const expected = renderSkillAdapter(name, { projected: issued.has(name) })
      if (fs.existsSync(entrypoint)) {
        const metadata = fs.lstatSync(entrypoint)
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          throw new Error(`${surface} adapter ${name} entrypoint must be a regular file`)
        }
        if (fs.readFileSync(entrypoint, 'utf8') !== expected) {
          throw new Error(`${surface} adapter ${name} has unexpected existing bytes`)
        }
      } else {
        fs.writeFileSync(entrypoint, expected, { flag: 'wx' })
      }
      const children = fs.readdirSync(directory)
      if (children.length !== 1 || children[0] !== 'SKILL.md') {
        throw new Error(`${surface} adapter ${name} contains unexpected entries`)
      }
    }
  }
  const inspected = inspectSkillDiscoveryAdapters(root, receipt)
  if (inspected.problems.length > 0) throw new Error(inspected.problems.join('; '))
  return inspected
}

function parseRoot(arguments_) {
  if (arguments_.length === 0) return repositoryRoot
  if (arguments_.length === 2 && arguments_[0] === '--root') return path.resolve(arguments_[1])
  throw new Error('usage: node tools/sync-compass-skill-adapters.mjs [--root PATH] [--write]')
}

if (isMainModule(import.meta.url)) {
  try {
    const arguments_ = process.argv.slice(2)
    const write = arguments_.includes('--write')
    const root = parseRoot(arguments_.filter((argument) => argument !== '--write'))
    const receipt = JSON.parse(fs.readFileSync(path.join(root, '.compass/receipt.json'), 'utf8'))
    const result = write
      ? writeSkillDiscoveryAdapters(root, receipt)
      : inspectSkillDiscoveryAdapters(root, receipt)
    if (result.problems.length > 0) throw new Error(result.problems.join('; '))
    console.log(`${write ? 'Synchronized' : 'Verified'} ${result.names.length} canonical skills (${result.issuedNames.length} issued by Compass) across ${COMPASS_SKILL_DISCOVERY_SURFACES.length} discovery surfaces.`)
  } catch (error) {
    console.error(`sync-compass-skill-adapters: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
