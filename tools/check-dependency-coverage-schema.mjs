#!/usr/bin/env node
// Bind dependency-coverage.json to the schema it declares.
//
// The `$schema` pointer was documentation: nothing read it, so the inventory
// and its published contract could drift apart while every check stayed green.
// Consumers author their schema-v2 inventories against this file, so it must
// be enforced here first.
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main.mjs'
import { validateAgainstSchema } from './json-schema-subset.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INVENTORY = 'dependency-coverage.json'
const SCHEMA = 'specs/dependency-coverage.schema.json'

function readJson(root, relative, problems) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'))
  } catch (error) {
    problems.push(`${relative} must be readable JSON: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

export function collectDependencyCoverageSchemaProblems(root = repositoryRoot) {
  const problems = []
  const schema = readJson(root, SCHEMA, problems)
  const inventory = readJson(root, INVENTORY, problems)
  if (!schema || !inventory) return problems

  const declared = inventory.$schema
  const expected = `./${SCHEMA}`
  if (declared !== expected) {
    problems.push(`${INVENTORY} must declare "$schema": "${expected}", got ${JSON.stringify(declared)}`)
  }

  try {
    problems.push(...validateAgainstSchema(inventory, schema).map((problem) => `${INVENTORY}: ${problem}`))
  } catch (error) {
    problems.push(`${SCHEMA} uses an unsupported construct: ${error instanceof Error ? error.message : String(error)}`)
  }
  return problems
}

export function checkDependencyCoverageSchema(root = repositoryRoot) {
  const problems = collectDependencyCoverageSchemaProblems(root)
  if (problems.length === 0) {
    console.log(`ok: ${INVENTORY} matches ${SCHEMA}`)
    return true
  }
  console.error('dependency coverage schema check failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  return false
}

if (isMainModule(import.meta.url) && !checkDependencyCoverageSchema()) process.exitCode = 1
