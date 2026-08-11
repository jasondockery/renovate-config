#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { validateJsonSchema } from '../.compass/validate-json-schema.mjs'
import { writeAtomicJson } from './atomic-write.mjs'
import { isMainModule } from './is-main.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const schema = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, '.compass/consumer-hosted-adoption-receipt.schema.json'), 'utf8')
)

function positiveInteger(value, label) {
  if (!/^[1-9][0-9]*$/u.test(String(value ?? ''))) throw new Error(`${label} must be a positive integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a safe positive integer`)
  return parsed
}

export function buildCompassHostedAdoptionReceipt({
  repository,
  commit,
  tree,
  reconciliationPath,
  workflow,
  requiredGate,
  runId,
  attempt,
  headSha,
  artifactName,
  artifactPath,
}) {
  const receipt = {
    schema: 'compass.consumer-hosted-adoption-receipt',
    schemaVersion: 1,
    consumer: {
      repository,
      commit,
      tree,
      reconciliationPath,
    },
    hostedRun: {
      provider: 'github-actions',
      repository,
      workflow,
      requiredGate,
      conclusion: 'success',
      runId: positiveInteger(runId, 'run ID'),
      attempt: positiveInteger(attempt, 'run attempt'),
      headSha,
    },
    artifact: {
      name: artifactName,
      path: artifactPath,
    },
    result: 'passed',
  }
  const problems = validateJsonSchema(receipt, schema)
  if (problems.length > 0) throw new Error(`receipt violates projected Compass schema: ${problems.join('; ')}`)
  if (receipt.consumer.commit !== receipt.hostedRun.headSha) {
    throw new Error('consumer commit and hosted run head SHA must match')
  }
  if (receipt.hostedRun.repository !== receipt.consumer.repository) {
    throw new Error('consumer and hosted repository must match')
  }
  return receipt
}

export function writeCompassHostedAdoptionReceipt({ output, ...input }) {
  if (typeof output !== 'string' || output.length === 0) throw new Error('output path is required')
  const receipt = buildCompassHostedAdoptionReceipt(input)
  writeAtomicJson(output, receipt)
  return receipt
}

function usage() {
  return 'usage: node tools/compass-hosted-adoption-receipt.mjs --output FILE --repository OWNER/REPO --commit 40-HEX --tree 40-HEX --reconciliation-path PATH --workflow PATH --required-gate NAME --run-id N --attempt N --head-sha 40-HEX --artifact-name NAME --artifact-path PATH'
}

function parseArguments(argv) {
  const supported = new Set([
    '--output',
    '--repository',
    '--commit',
    '--tree',
    '--reconciliation-path',
    '--workflow',
    '--required-gate',
    '--run-id',
    '--attempt',
    '--head-sha',
    '--artifact-name',
    '--artifact-path',
  ])
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help') return { help: true }
    if (!supported.has(argument)) throw new Error(`unknown argument: ${argument}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    if (values[argument] !== undefined) throw new Error(`${argument} may be provided only once`)
    values[argument] = value
    index += 1
  }
  return {
    output: values['--output'],
    repository: values['--repository'],
    commit: values['--commit'],
    tree: values['--tree'],
    reconciliationPath: values['--reconciliation-path'],
    workflow: values['--workflow'],
    requiredGate: values['--required-gate'],
    runId: values['--run-id'],
    attempt: values['--attempt'],
    headSha: values['--head-sha'],
    artifactName: values['--artifact-name'],
    artifactPath: values['--artifact-path'],
  }
}

if (isMainModule(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2))
    if (options.help) console.log(usage())
    else writeCompassHostedAdoptionReceipt(options)
  } catch (error) {
    console.error(`compass-hosted-adoption-receipt: ${error instanceof Error ? error.message : String(error)}`)
    console.error(usage())
    process.exitCode = 64
  }
}
