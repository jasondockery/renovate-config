import { isDeepStrictEqual } from 'node:util'

function resolveReference(root, reference) {
  if (!reference.startsWith('#/')) throw new Error(`unsupported JSON Schema reference: ${reference}`)
  return reference.slice(2).split('/').reduce((value, segment) => value?.[segment.replaceAll('~1', '/').replaceAll('~0', '~')], root)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function matchesType(value, type) {
  if (type === 'object') return isObject(value)
  if (type === 'array') return Array.isArray(value)
  if (type === 'string') return typeof value === 'string'
  if (type === 'integer') return Number.isSafeInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'null') return value === null
  return false
}

export function validateJsonSchema(instance, schema) {
  const problems = []
  const visit = (value, current, location) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      problems.push(`${location} has an invalid schema`)
      return
    }
    if (current.$ref) {
      const resolved = resolveReference(schema, current.$ref)
      if (!resolved) problems.push(`${location} references a missing schema`)
      else visit(value, resolved, location)
      return
    }
    if (Object.hasOwn(current, 'const') && !isDeepStrictEqual(value, current.const)) problems.push(`${location} does not equal its const`)
    if (Array.isArray(current.enum) && !current.enum.some((candidate) => isDeepStrictEqual(value, candidate))) problems.push(`${location} is outside its enum`)
    if (current.type && !matchesType(value, current.type)) {
      problems.push(`${location} is not type ${current.type}`)
      return
    }
    if (typeof value === 'string') {
      if (Number.isSafeInteger(current.minLength) && value.length < current.minLength) problems.push(`${location} is shorter than minLength`)
      if (current.pattern && !new RegExp(current.pattern, 'u').test(value)) problems.push(`${location} does not match its pattern`)
    }
    if (typeof value === 'number' && Number.isFinite(current.minimum) && value < current.minimum) problems.push(`${location} is below minimum`)
    if (Array.isArray(value)) {
      if (Number.isSafeInteger(current.minItems) && value.length < current.minItems) problems.push(`${location} has too few items`)
      if (current.items) value.forEach((item, index) => visit(item, current.items, `${location}/${index}`))
    }
    if (isObject(value)) {
      for (const required of current.required ?? []) if (!Object.hasOwn(value, required)) problems.push(`${location} is missing ${required}`)
      if (current.additionalProperties === false) {
        for (const key of Object.keys(value)) if (!Object.hasOwn(current.properties ?? {}, key)) problems.push(`${location} has unknown ${key}`)
      }
      for (const [key, child] of Object.entries(current.properties ?? {})) if (Object.hasOwn(value, key)) visit(value[key], child, `${location}/${key}`)
    }
    for (const child of current.allOf ?? []) visit(value, child, location)
    if (Array.isArray(current.anyOf)) {
      const accepted = current.anyOf.some((child) => validateSubschema(value, child))
      if (!accepted) problems.push(`${location} does not match anyOf`)
    }
    if (Array.isArray(current.oneOf)) {
      const count = current.oneOf.filter((child) => validateSubschema(value, child)).length
      if (count !== 1) problems.push(`${location} does not match exactly one oneOf branch`)
    }
    if (current.not && validateSubschema(value, current.not)) problems.push(`${location} matches forbidden schema`)
    if (current.if) visit(value, validateSubschema(value, current.if) ? current.then ?? {} : current.else ?? {}, location)
  }
  const validateSubschema = (value, subschema) => {
    const start = problems.length
    visit(value, subschema, '$probe')
    const accepted = problems.length === start
    problems.splice(start)
    return accepted
  }
  visit(instance, schema, '$')
  return problems
}
