import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { analyzeWorkflowExternalConfig } from './workflow-external-config.mjs'

const REGISTRY_PATH = 'tools/github-external-config.json'
const DELIVERY_KINDS = new Set(['direct', 'workflow_call_input', 'workflow_call_secret'])
const COMMON_DELIVERY_FIELDS = [
  'consumer',
  'delivery',
  'kind',
  'required',
  'sensitive',
  'workflows',
]

export function collectGithubExternalConfigViolations(root) {
  const registry = readRegistry(path.join(root, REGISTRY_PATH))
  const analysis = collectWorkflowAnalysis(path.join(root, '.github/workflows'), root)
  const violations = [...analysis.violations]
  const capabilities = registry.capabilities ?? {}
  const credentials = registry.credentials ?? {}
  const deliveries = []

  validateCapabilities(capabilities, violations)
  for (const [credential, entry] of Object.entries(credentials)) {
    if (!isRecord(entry)) {
      violations.push(`Credential ${credential} must be an object.`)
      continue
    }
    for (const field of ['owner', 'purpose']) {
      if (typeof entry[field] !== 'string' || entry[field].length === 0) {
        violations.push(`Credential ${credential} is missing ${field}.`)
      }
    }
    if (typeof entry.capability !== 'string' || !capabilities[entry.capability]) {
      violations.push(`Credential ${credential} names an unknown capability.`)
    }
    if (!Array.isArray(entry.deliveries) || entry.deliveries.length === 0) {
      violations.push(`Credential ${credential} must declare deliveries.`)
      continue
    }
    for (const delivery of entry.deliveries) {
      if (!isRecord(delivery)) {
        violations.push(`Credential ${credential} contains a malformed delivery.`)
        continue
      }
      deliveries.push({ credential, ...delivery })
      validateDelivery(credential, delivery, root, violations)
    }
  }

  validateUniqueDeliveryAuthorities(deliveries, violations)
  validateObservedDeliveries(deliveries, analysis.files, violations)
  return violations
}

function validateCapabilities(capabilities, violations) {
  if (!isRecord(capabilities)) {
    violations.push('Registry capabilities must be an object.')
    return
  }
  for (const [name, entry] of Object.entries(capabilities)) {
    if (!isRecord(entry)) {
      violations.push(`Capability ${name} must be an object.`)
      continue
    }
    for (const field of ['description', 'owner']) {
      if (typeof entry[field] !== 'string' || entry[field].length === 0) {
        violations.push(`Capability ${name} is missing ${field}.`)
      }
    }
  }
}

function validateDelivery(credential, delivery, root, violations) {
  const label = `${credential}/${String(delivery.consumer)}`
  validateDeliveryFields(label, delivery, violations)
  for (const field of ['consumer', 'kind']) {
    if (typeof delivery[field] !== 'string' || delivery[field].length === 0) {
      violations.push(`Delivery ${label} is missing ${field}.`)
    }
  }
  if (!DELIVERY_KINDS.has(delivery.delivery)) {
    violations.push(`Delivery ${label} has unsupported delivery ${String(delivery.delivery)}.`)
  }
  if (!['secret', 'variable'].includes(delivery.kind)) {
    violations.push(`Delivery ${label} has invalid kind ${String(delivery.kind)}.`)
  }
  if (typeof delivery.required !== 'boolean' || typeof delivery.sensitive !== 'boolean') {
    violations.push(`Delivery ${label} must declare required and sensitive.`)
  }
  if (delivery.kind === 'variable' && delivery.sensitive !== false) {
    violations.push(`Delivery ${label} variables cannot be sensitive.`)
  }
  if (!Array.isArray(delivery.workflows) || delivery.workflows.length === 0) {
    violations.push(`Delivery ${label} must name its workflows.`)
  } else {
    for (const workflow of delivery.workflows) {
      if (typeof workflow !== 'string' || !workflow.startsWith('.github/workflows/')) {
        violations.push(`Delivery ${label} has invalid workflow ${String(workflow)}.`)
      } else if (!fs.existsSync(path.join(root, workflow))) {
        violations.push(`Delivery ${label} names missing workflow ${workflow}.`)
      }
    }
  }

  if (delivery.delivery === 'direct') validateDirectDelivery(label, delivery, violations)
  if (delivery.delivery === 'workflow_call_input') {
    validateCallerDelivery(label, delivery, 'variable', violations)
  }
  if (delivery.delivery === 'workflow_call_secret') {
    validateCallerDelivery(label, delivery, 'secret', violations)
  }
}

function validateDeliveryFields(label, delivery, violations) {
  const kindFields = {
    direct: ['environment', 'reference', 'scope'],
    workflow_call_input: ['input', 'sourceScopes'],
    workflow_call_secret: ['input', 'sourceScopes'],
  }
  const allowed = new Set([...COMMON_DELIVERY_FIELDS, ...(kindFields[delivery.delivery] ?? [])])
  for (const field of Object.keys(delivery)) {
    if (!allowed.has(field)) {
      violations.push(
        `Delivery ${label} field ${field} is not valid for ${String(delivery.delivery)} delivery.`
      )
    }
  }
}

function validateDirectDelivery(label, delivery, violations) {
  const expectedPrefix = delivery.kind === 'secret' ? 'secrets' : 'vars'
  if (
    typeof delivery.reference !== 'string' ||
    !new RegExp(`^${expectedPrefix}\\.[A-Za-z_][A-Za-z0-9_]*$`).test(delivery.reference)
  ) {
    violations.push(`Delivery ${label} must declare a ${expectedPrefix}.* reference.`)
  }
  if (!['environment', 'repository'].includes(delivery.scope)) {
    violations.push(`Delivery ${label} has invalid direct scope.`)
  }
  if (delivery.scope === 'environment' && typeof delivery.environment !== 'string') {
    violations.push(`Delivery ${label} must name its environment.`)
  }
  if (delivery.scope === 'repository' && delivery.environment !== undefined) {
    violations.push(`Delivery ${label} is repository-scoped and cannot name an environment.`)
  }
}

function validateCallerDelivery(label, delivery, expectedKind, violations) {
  if (delivery.kind !== expectedKind) {
    violations.push(`Delivery ${label} must use kind ${expectedKind}.`)
  }
  if (typeof delivery.input !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(delivery.input)) {
    violations.push(`Delivery ${label} must name its workflow_call input.`)
  }
  if (
    !Array.isArray(delivery.sourceScopes) ||
    delivery.sourceScopes.length === 0 ||
    delivery.sourceScopes.some((scope) => !['organization', 'repository'].includes(scope))
  ) {
    violations.push(`Delivery ${label} must declare repository/organization source scopes.`)
  }
  if (delivery.reference !== undefined || delivery.environment !== undefined) {
    violations.push(`Delivery ${label} cannot claim a direct reference or environment.`)
  }
}

function validateUniqueDeliveryAuthorities(deliveries, violations) {
  const consumers = new Set()
  for (const delivery of deliveries) {
    const key = `${delivery.credential}/${String(delivery.consumer)}`
    if (consumers.has(key)) violations.push(`Duplicate delivery authority ${key}.`)
    consumers.add(key)
  }
}

function validateObservedDeliveries(deliveries, files, violations) {
  const observed = new Map(deliveries.map((delivery) => [delivery, new Set()]))

  for (const [file, analysis] of files) {
    for (const usage of analysis.usages) {
      if (usage.workflowCallInput && usage.environment) {
        violations.push(
          `${file}: ${usage.reference} is a workflow_call secret consumed by a job with environment ${usage.environment}; environment secret shadowing is forbidden.`
        )
      }
      const expectedType = usage.workflowCallInput ? 'workflow_call_secret' : 'direct'
      const candidates = deliveries.filter(
        (delivery) =>
          delivery.delivery === expectedType &&
          delivery.workflows?.includes(file) &&
          (expectedType === 'direct'
            ? delivery.reference === usage.reference
            : `secrets.${delivery.input}` === usage.reference)
      )
      if (candidates.length !== 1) {
        violations.push(
          `${file}: ${usage.reference} must resolve to exactly one ${expectedType} delivery; found ${candidates.length}.`
        )
        continue
      }
      const delivery = candidates[0]
      observed.get(delivery)?.add(file)
      if (
        delivery.delivery === 'direct' &&
        delivery.scope === 'environment' &&
        usage.environment !== delivery.environment
      ) {
        violations.push(
          `${file}: ${usage.reference} must be used by a job in environment ${delivery.environment}; found ${usage.environment ?? 'none'}.`
        )
      }
    }

    for (const name of analysis.workflowCallSecrets) {
      if (
        !deliveries.some(
          (delivery) =>
            delivery.delivery === 'workflow_call_secret' &&
            delivery.input === name &&
            delivery.workflows?.includes(file)
        )
      ) {
        violations.push(`${file}: workflow_call secret ${name} has no registered caller delivery.`)
      }
    }
  }

  for (const delivery of deliveries) {
    if (delivery.delivery === 'workflow_call_input') {
      for (const file of delivery.workflows ?? []) {
        const analysis = files.get(file)
        if (!analysis?.workflowCallInputs.includes(delivery.input)) {
          violations.push(`${file}: required workflow_call input ${delivery.input} is not declared.`)
        } else if (!analysis.inputUsages.includes(delivery.input)) {
          violations.push(`${file}: required workflow_call input ${delivery.input} is not used.`)
        } else {
          observed.get(delivery)?.add(file)
        }
      }
    }
    if (delivery.required === true) {
      for (const file of delivery.workflows ?? []) {
        if (!observed.get(delivery)?.has(file)) {
          violations.push(
            `${file}: required delivery ${delivery.credential}/${delivery.consumer} is not observed.`
          )
        }
      }
    }
  }
}

function collectWorkflowAnalysis(workflowsDir, root) {
  const files = new Map()
  const violations = []
  if (!fs.existsSync(workflowsDir)) return { files, violations }
  for (const file of workflowFiles(workflowsDir)) {
    const relative = path.relative(root, file).split(path.sep).join('/')
    const analysis = analyzeWorkflowExternalConfig(fs.readFileSync(file, 'utf8'))
    files.set(relative, analysis)
    violations.push(...analysis.violations.map((message) => `${relative}: ${message}`))
  }
  return { files, violations }
}

function workflowFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) return workflowFiles(entryPath)
      return entry.isFile() && /\.ya?ml$/.test(entry.name) ? [entryPath] : []
    })
    .sort()
}

function readRegistry(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing GitHub external configuration registry: ${file}`)
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!isRecord(parsed)) throw new Error('Registry must be an object.')
  if (!isRecord(parsed.capabilities) || !isRecord(parsed.credentials)) {
    throw new Error('Registry must contain capabilities and credentials objects.')
  }
  return parsed
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..')
  try {
    const violations = collectGithubExternalConfigViolations(root)
    if (violations.length > 0) {
      for (const violation of violations) process.stderr.write(`${violation}\n`)
      process.exitCode = 1
    } else {
      process.stdout.write('GitHub external configuration registry passed.\n')
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
