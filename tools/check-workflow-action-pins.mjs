#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workflowDirectory = '.github/workflows'
const canonicalWorkflow = '.github/workflows/ci.yml'
const shaPattern = /^[0-9a-f]{40}$/u
const versionPattern = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

function workflowPaths(root) {
  const directory = path.join(root, workflowDirectory)
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
      .map((entry) => path.posix.join(workflowDirectory, entry.name))
      .sort()
  } catch (error) {
    throw new Error(`${workflowDirectory} must be readable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function collectReferences(root, relativePaths, problems) {
  const references = []
  for (const relativePath of relativePaths) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8')
    for (const [index, line] of source.split('\n').entries()) {
      if (!/^\s*(?:-\s*)?uses:/u.test(line)) continue
      const location = `${relativePath}:${index + 1}`
      const match = /^\s*(?:-\s*)?uses:\s*(\S+?)(?:\s+#\s*(\S+))?\s*$/u.exec(line)
      if (!match) {
        problems.push(`${location} action reference must use "uses: owner/action@SHA # vX.Y.Z".`)
        continue
      }
      const target = match[1]
      if (target.startsWith('./') || target.startsWith('docker://')) continue
      const separator = target.lastIndexOf('@')
      if (separator < 1 || separator === target.length - 1) {
        problems.push(`${location} external action reference must include a full commit SHA.`)
        continue
      }
      const action = target.slice(0, separator)
      const sha = target.slice(separator + 1)
      const version = match[2] ?? ''
      if (!shaPattern.test(sha)) {
        problems.push(`${location} ${action} must be pinned to a full lowercase 40-character SHA.`)
      }
      if (!versionPattern.test(version)) {
        problems.push(`${location} ${action} must have an exact semver comment such as # v1.2.3.`)
      }
      if (shaPattern.test(sha) && versionPattern.test(version)) {
        references.push({ action, sha, version, relativePath, location })
      }
    }
  }
  return references
}

function uniquePairs(references) {
  return new Map(references.map(({ action, sha, version }) => [action, `${sha} # ${version}`]))
}

export function collectWorkflowActionPinProblems(root = repositoryRoot) {
  const problems = []
  let relativePaths = []
  try {
    relativePaths = workflowPaths(root)
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)]
  }
  if (relativePaths.length === 0) return [`${workflowDirectory} must contain at least one .yml or .yaml workflow.`]
  if (!relativePaths.includes(canonicalWorkflow)) {
    problems.push(`${canonicalWorkflow} must exist as the repository's canonical action-pin source.`)
  }

  const references = collectReferences(root, relativePaths, problems)
  const pairShas = new Map()
  const shaVersions = new Map()
  for (const reference of references) {
    const pairKey = `${reference.action}\0${reference.version}`
    const shaKey = `${reference.action}\0${reference.sha}`
    const shas = pairShas.get(pairKey) ?? new Set()
    shas.add(reference.sha)
    pairShas.set(pairKey, shas)
    const versions = shaVersions.get(shaKey) ?? new Set()
    versions.add(reference.version)
    shaVersions.set(shaKey, versions)
  }
  for (const [key, shas] of pairShas) {
    if (shas.size > 1) {
      const [action, version] = key.split('\0')
      problems.push(`${action} ${version} is paired with conflicting SHAs: ${[...shas].sort().join(', ')}.`)
    }
  }
  for (const [key, versions] of shaVersions) {
    if (versions.size > 1) {
      const [action, sha] = key.split('\0')
      problems.push(`${action}@${sha} is labeled with conflicting versions: ${[...versions].sort().join(', ')}.`)
    }
  }

  const canonicalReferences = references.filter(({ relativePath }) => relativePath === canonicalWorkflow)
  const canonicalCounts = new Map()
  for (const reference of canonicalReferences) {
    const pairs = canonicalCounts.get(reference.action) ?? new Set()
    pairs.add(`${reference.sha} # ${reference.version}`)
    canonicalCounts.set(reference.action, pairs)
  }
  for (const [action, pairs] of canonicalCounts) {
    if (pairs.size > 1) problems.push(`${canonicalWorkflow} declares conflicting canonical pins for ${action}.`)
  }
  const canonical = uniquePairs(canonicalReferences)
  for (const reference of references) {
    const expected = canonical.get(reference.action)
    const actual = `${reference.sha} # ${reference.version}`
    if (expected && actual !== expected) {
      problems.push(`${reference.location} ${reference.action} differs from the canonical ${expected}.`)
    }
  }
  return problems
}

if (isMainModule(import.meta.url)) {
  const problems = collectWorkflowActionPinProblems()
  if (problems.length > 0) {
    for (const problem of problems) console.error(`workflow-action-pins: ${problem}`)
    process.exitCode = 1
  } else {
    console.log('ok: every workflow action pin is immutable, semver-labeled, and repository-consistent')
  }
}
