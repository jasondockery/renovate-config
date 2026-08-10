#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const skillNames = Object.freeze([
  'dependency-change',
  'field-failure-backpressure',
  'performance-sensitive-change',
  'verification-selection',
])
const expectedSourcePaths = Object.freeze([
  'COMPASS.md',
  'TERMINOLOGY.md',
  ...skillNames.flatMap((name) => [
    `skills/${name}/SKILL.md`,
    `skills/${name}/agents/openai.yaml`,
  ]),
].sort())

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function projectedPath(sourcePath) {
  if (sourcePath === 'COMPASS.md' || sourcePath === 'TERMINOLOGY.md') {
    return `.compass/${sourcePath}`
  }
  return sourcePath
}

function listFiles(directory, root = directory) {
  if (!fs.existsSync(directory)) return []
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(absolute, root))
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'))
    else files.push(`UNSUPPORTED:${path.relative(root, absolute)}`)
  }
  return files
}

export function checkCompassProjection(root = repositoryRoot) {
  const problems = []
  const receiptPath = path.join(root, '.compass/receipt.json')
  if (!fs.existsSync(receiptPath)) return ['Compass projection receipt is missing: .compass/receipt.json']

  let receipt
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  } catch (error) {
    return [`Compass projection receipt is unreadable: ${error instanceof Error ? error.message : String(error)}`]
  }
  if (receipt?.schema !== 'compass.artifact-receipt' || receipt.schemaVersion !== 1) {
    problems.push('Compass receipt schema is unsupported')
  }
  if (receipt.source?.repository !== 'jasondockery/compass') problems.push('Compass receipt names the wrong source repository')
  if (!/^[0-9a-f]{40}$/u.test(receipt.source?.commit ?? '')) problems.push('Compass source commit must be an exact 40-character SHA')
  if (!/^[0-9a-f]{40}$/u.test(receipt.source?.tree ?? '')) problems.push('Compass source tree must be an exact 40-character Git tree')
  if (!/^[0-9a-f]{64}$/u.test(receipt.source?.fingerprintSha256 ?? '')) problems.push('Compass source fingerprint must be SHA-256')
  if (receipt.source?.dirty !== false) problems.push('Compass source receipt must record dirty=false')
  if (!/^[0-9a-f]{64}$/u.test(receipt.artifactSha256 ?? '') || !Number.isSafeInteger(receipt.artifactBytes) || receipt.artifactBytes <= 0) {
    problems.push('Compass artifact identity is malformed')
  }
  if (receipt.validation?.result !== 'passed' || !/^[0-9a-f]{64}$/u.test(receipt.validation?.receiptSha256 ?? '')) {
    problems.push('Compass artifact lacks a passing validation receipt identity')
  }
  if (!Array.isArray(receipt.includedFiles)) {
    problems.push('Compass included-file inventory is missing')
    return problems
  }
  const listedPaths = receipt.includedFiles.map((file) => file.path)
  if (JSON.stringify(listedPaths) !== JSON.stringify(expectedSourcePaths)) {
    problems.push('Compass included-file inventory is incomplete, extra, or out of order')
  }
  for (const file of receipt.includedFiles) {
    if (!expectedSourcePaths.includes(file.path)) continue
    if (!/^[0-9a-f]{64}$/u.test(file.sha256 ?? '') || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      problems.push(`Compass inventory metadata is malformed: ${file.path}`)
      continue
    }
    const relativePath = projectedPath(file.path)
    const absolutePath = path.join(root, relativePath)
    if (!fs.existsSync(absolutePath)) {
      problems.push(`Compass projected file is missing: ${relativePath}`)
      continue
    }
    const stat = fs.lstatSync(absolutePath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      problems.push(`Compass projected path must be a regular file: ${relativePath}`)
      continue
    }
    const bytes = fs.readFileSync(absolutePath)
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) {
      problems.push(`Compass projected file drifted from its receipt: ${relativePath}`)
    }
  }

  const compassFiles = listFiles(path.join(root, '.compass'), root).sort()
  if (JSON.stringify(compassFiles) !== JSON.stringify(['.compass/COMPASS.md', '.compass/TERMINOLOGY.md', '.compass/receipt.json'])) {
    problems.push('.compass must contain only COMPASS.md, TERMINOLOGY.md, and receipt.json')
  }
  for (const name of skillNames) {
    const actual = listFiles(path.join(root, 'skills', name), root).sort()
    const expected = [`skills/${name}/SKILL.md`, `skills/${name}/agents/openai.yaml`]
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`projected Compass skill has unexpected files: ${name}`)
    }
  }

  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
  for (const reference of [
    '.compass/COMPASS.md',
    '.compass/TERMINOLOGY.md',
    'skills/verification-selection/SKILL.md',
    'skills/dependency-change/SKILL.md',
    'skills/field-failure-backpressure/SKILL.md',
    'skills/performance-sensitive-change/SKILL.md',
  ]) {
    if (!agents.includes(reference)) problems.push(`AGENTS.md does not route to projected Compass authority: ${reference}`)
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
