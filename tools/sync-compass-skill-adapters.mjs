#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKILL_RECEIPT_PATH = /^skills\/([^/]+)\/SKILL\.md$/u
const ADAPTER_RECEIPT_PATH = /^(\.(?:agents|claude|codex)\/skills)\/([^/]+)\/SKILL\.md$/u
const LEGACY_SYMLINKS = Object.freeze(['.agents/skills', '.claude/skills'])
const LEGACY_TARGET = '../skills'
export const COMPASS_SKILL_DISCOVERY_SURFACES = Object.freeze([
  '.agents/skills',
  '.claude/skills',
  '.codex/skills',
])

export function projectedSkillNames(receipt) {
  return Array.isArray(receipt?.includedFiles)
    ? receipt.includedFiles
      .map((entry) => entry?.path?.match(SKILL_RECEIPT_PATH)?.[1])
      .filter(Boolean)
      .sort()
    : []
}

function managedAdapterEntries(receipt) {
  const entries = new Map()
  for (const entry of receipt?.includedFiles ?? []) {
    if (!entry?.path?.match(ADAPTER_RECEIPT_PATH)) continue
    if (entries.has(entry.path)) throw new Error(`Compass receipt contains duplicate managed adapter ${entry.path}`)
    entries.set(entry.path, entry)
  }
  return entries
}

export function renderSkillAdapter(name, { projected = true } = {}) {
  return `---
name: ${name}
description: Route agent discovery to the ${projected ? 'canonical projected Compass' : 'repository-local canonical'} ${name} skill.
---

# Compass skill adapter

Load \`../../../skills/${name}/SKILL.md\` as the canonical procedure. This
adapter contains no independent policy.
`
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
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

function validateManagedAdapter(bytes, entry, name, label, problems) {
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? '')) {
    problems.push(`${label} has invalid receipt metadata`)
    return false
  }
  if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) {
    problems.push(`${label} does not match its receipt-bound bytes`)
    return false
  }
  const source = bytes.toString('utf8')
  if (!source.includes(`name: ${name}\n`) || !source.includes(`../../../skills/${name}/SKILL.md`)) {
    problems.push(`${label} does not route to its named canonical entrypoint`)
    return false
  }
  return true
}

function validateAdapterFile(root, surface, name, issued, managed, problems) {
  const relativePath = `${surface}/${name}/SKILL.md`
  const adapterPath = path.join(root, relativePath)
  const metadata = lstat(adapterPath, `${surface} adapter ${name} entrypoint`, problems)
  if (!metadata || metadata.isSymbolicLink() || !metadata.isFile()) {
    problems.push(`${surface} adapter ${name} entrypoint must be a regular file`)
    return false
  }
  const bytes = fs.readFileSync(adapterPath)
  const managedEntry = managed.get(relativePath)
  if (managedEntry) {
    return validateManagedAdapter(bytes, managedEntry, name, `${surface} adapter ${name}`, problems)
  }
  if (bytes.toString('utf8') !== renderSkillAdapter(name, { projected: issued.has(name) })) {
    problems.push(`${surface} adapter ${name} does not route exactly to its canonical entrypoint`)
    return false
  }
  return true
}

function inspectSurface(root, surface, names, issued, managed, problems) {
  const surfacePath = path.join(root, surface)
  const inventory = []
  if (!assertRegularDirectory(surfacePath, `${surface} discovery surface`, problems)) return inventory
  const entries = fs.readdirSync(surfacePath).sort()
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
    if (validateAdapterFile(root, surface, name, issued, managed, problems)) inventory.push(name)
  }
  return inventory
}

function adapterContext(root, receipt, problems) {
  const issuedNames = projectedSkillNames(receipt)
  if (issuedNames.length === 0) problems.push('Compass receipt exposes no projected skill entrypoints')
  if (new Set(issuedNames).size !== issuedNames.length) {
    problems.push('Compass receipt contains duplicate projected skill entrypoints')
  }
  let managed = new Map()
  try {
    managed = managedAdapterEntries(receipt)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
  const names = canonicalSkillNames(root, problems)
  const canonical = new Set(names)
  for (const name of issuedNames) {
    if (!canonical.has(name)) problems.push(`receipt-bound skill ${name} has no canonical repository-local entrypoint`)
  }
  const issued = new Set(issuedNames)
  for (const relativePath of managed.keys()) {
    const match = relativePath.match(ADAPTER_RECEIPT_PATH)
    const name = match?.[2]
    if (!name || !canonical.has(name)) problems.push(`receipt-managed adapter ${relativePath} has no canonical skill`)
    else if (!issued.has(name)) problems.push(`receipt-managed adapter ${relativePath} is not an issued Compass skill`)
  }
  return { names, issuedNames, issued, managed }
}

export function inspectSkillDiscoveryAdapters(root, receipt) {
  const problems = []
  const context = adapterContext(root, receipt, problems)
  const inventories = {}
  for (const surface of COMPASS_SKILL_DISCOVERY_SURFACES) {
    inventories[surface] = inspectSurface(
      root,
      surface,
      context.names,
      context.issued,
      context.managed,
      problems
    )
    if (JSON.stringify(inventories[surface]) !== JSON.stringify(context.names)) {
      problems.push(`${surface} discovery inventory does not equal the complete canonical skill inventory`)
    }
    const discoveredIssued = inventories[surface].filter((name) => context.issued.has(name))
    if (JSON.stringify(discoveredIssued) !== JSON.stringify(context.issuedNames)) {
      problems.push(`${surface} discovery inventory does not expose all issued Compass skills exactly once`)
    }
  }
  return { names: context.names, issuedNames: context.issuedNames, inventories, problems }
}

export function migrateLegacySkillDiscoverySymlinks(root) {
  const problems = []
  const canonicalSkills = path.join(root, 'skills')
  assertRegularDirectory(canonicalSkills, 'canonical skills directory', problems)
  const targets = []
  for (const surface of LEGACY_SYMLINKS) {
    const parent = path.dirname(path.join(root, surface))
    assertRegularDirectory(parent, `${path.relative(root, parent)} adapter parent`, problems)
    const surfacePath = path.join(root, surface)
    const metadata = lstat(surfacePath, `${surface} legacy discovery surface`, problems)
    if (!metadata?.isSymbolicLink()) {
      problems.push(`${surface} must be the expected legacy symlink before migration`)
      continue
    }
    const target = fs.readlinkSync(surfacePath)
    if (target !== LEGACY_TARGET) problems.push(`${surface} has unexpected legacy target ${target}`)
    try {
      if (fs.realpathSync(surfacePath) !== fs.realpathSync(canonicalSkills)) {
        problems.push(`${surface} does not resolve to the repository-local canonical skills directory`)
      }
    } catch (error) {
      problems.push(`${surface} cannot be resolved safely: ${error instanceof Error ? error.message : String(error)}`)
    }
    targets.push({ surface, surfacePath, target })
  }
  if (problems.length > 0) throw new Error(problems.join('; '))

  const migrated = []
  try {
    for (const item of targets) {
      fs.unlinkSync(item.surfacePath)
      migrated.push({ ...item, directoryCreated: false })
      fs.mkdirSync(item.surfacePath)
      migrated.at(-1).directoryCreated = true
    }
  } catch (error) {
    const rollbackErrors = []
    for (const item of migrated.reverse()) {
      try {
        if (item.directoryCreated) fs.rmdirSync(item.surfacePath)
        fs.symlinkSync(item.target, item.surfacePath)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError))
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors.map((message) => new Error(message))],
        'legacy skill adapter migration and rollback failed'
      )
    }
    throw error
  }
  return targets.map(({ surface, target }) => ({ surface, target }))
}

function preflightSkillDiscoveryAdapterWrite(root, receipt) {
  const problems = []
  const context = adapterContext(root, receipt, problems)
  const writes = []
  for (const surface of COMPASS_SKILL_DISCOVERY_SURFACES) {
    const parent = path.dirname(path.join(root, surface))
    assertRegularDirectory(parent, `${path.relative(root, parent)} adapter parent`, problems)
    const surfacePath = path.join(root, surface)
    if (!assertRegularDirectory(surfacePath, `${surface} discovery surface`, problems)) continue
    const entries = fs.readdirSync(surfacePath)
    for (const entry of entries) {
      if (!context.names.includes(entry)) problems.push(`${surface} contains unexpected adapter ${entry}`)
    }
    for (const name of context.names) {
      const relativePath = `${surface}/${name}/SKILL.md`
      const directory = path.join(surfacePath, name)
      const entrypoint = path.join(directory, 'SKILL.md')
      const managedEntry = context.managed.get(relativePath)
      if (!fs.existsSync(directory)) {
        if (managedEntry) problems.push(`${surface} receipt-managed adapter ${name} is missing; rerun the canonical projector`)
        else writes.push({ directory, entrypoint, bytes: renderSkillAdapter(name, { projected: context.issued.has(name) }) })
        continue
      }
      const directoryMetadata = fs.lstatSync(directory)
      if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
        problems.push(`${surface} adapter ${name} must be a regular directory`)
        continue
      }
      const children = fs.readdirSync(directory)
      if (children.length === 0) {
        if (managedEntry) problems.push(`${surface} receipt-managed adapter ${name} is missing; rerun the canonical projector`)
        else writes.push({ directory: null, entrypoint, bytes: renderSkillAdapter(name, { projected: context.issued.has(name) }) })
        continue
      }
      if (children.length !== 1 || children[0] !== 'SKILL.md') {
        problems.push(`${surface} adapter ${name} contains unexpected entries`)
        continue
      }
      validateAdapterFile(root, surface, name, context.issued, context.managed, problems)
    }
  }
  if (problems.length > 0) throw new Error(problems.join('; '))
  return writes
}

export function writeSkillDiscoveryAdapters(root, receipt) {
  const writes = preflightSkillDiscoveryAdapterWrite(root, receipt)
  const createdFiles = []
  const createdDirectories = []
  try {
    for (const write of writes) {
      if (write.directory) {
        fs.mkdirSync(write.directory)
        createdDirectories.push(write.directory)
      }
      fs.writeFileSync(write.entrypoint, write.bytes, { flag: 'wx' })
      createdFiles.push(write.entrypoint)
    }
    const inspected = inspectSkillDiscoveryAdapters(root, receipt)
    if (inspected.problems.length > 0) throw new Error(inspected.problems.join('; '))
    return inspected
  } catch (error) {
    const rollbackErrors = []
    for (const file of createdFiles.reverse()) {
      try {
        fs.unlinkSync(file)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError))
      }
    }
    for (const directory of createdDirectories.reverse()) {
      try {
        fs.rmdirSync(directory)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError))
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors.map((message) => new Error(message))],
        'skill adapter synchronization and rollback failed'
      )
    }
    throw error
  }
}

function parseArguments(arguments_) {
  const options = { root: repositoryRoot, write: false, migrate: false }
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--write') options.write = true
    else if (argument === '--migrate-legacy-symlinks') options.migrate = true
    else if (argument === '--root' && arguments_[index + 1]) options.root = path.resolve(arguments_[index += 1])
    else throw new Error('usage: node tools/sync-compass-skill-adapters.mjs [--root PATH] [--write | --migrate-legacy-symlinks]')
  }
  if (options.write && options.migrate) throw new Error('--write and --migrate-legacy-symlinks are separate phases')
  return options
}

if (isMainModule(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2))
    if (options.migrate) {
      const migrated = migrateLegacySkillDiscoverySymlinks(options.root)
      console.log(`Migrated ${migrated.length} repository-local legacy skill discovery symlinks.`)
    } else {
      const receipt = JSON.parse(fs.readFileSync(path.join(options.root, '.compass/receipt.json'), 'utf8'))
      const result = options.write
        ? writeSkillDiscoveryAdapters(options.root, receipt)
        : inspectSkillDiscoveryAdapters(options.root, receipt)
      if (result.problems.length > 0) throw new Error(result.problems.join('; '))
      console.log(`${options.write ? 'Synchronized' : 'Verified'} ${result.names.length} canonical skills (${result.issuedNames.length} issued by Compass) across ${COMPASS_SKILL_DISCOVERY_SURFACES.length} discovery surfaces.`)
    }
  } catch (error) {
    console.error(`sync-compass-skill-adapters: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
