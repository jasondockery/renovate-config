// A dependency-free validator for the bounded JSON Schema subset this
// repository's own schemas use. It is deliberately NOT a general draft-2020-12
// implementation: an unknown keyword is an error, so a schema can never
// silently validate less than it appears to.
//
// Supported: type, const, enum, required, properties, additionalProperties
// (false only), items, minItems, uniqueItems, minLength, minimum, pattern.

const SUPPORTED_KEYWORDS = new Set([
  '$schema',
  '$id',
  'title',
  'description',
  'type',
  'const',
  'enum',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minItems',
  'uniqueItems',
  'minLength',
  'minimum',
  'pattern',
])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function typeMatches(value, type) {
  switch (type) {
    case 'object': return isPlainObject(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'integer': return Number.isInteger(value)
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'null': return value === null
    default: throw new Error(`unsupported schema type: ${type}`)
  }
}

function describe(location) {
  return location === '' ? '<root>' : location
}

export function validateAgainstSchema(value, schema, location = '') {
  const problems = []
  if (!isPlainObject(schema)) throw new Error(`schema at ${describe(location)} must be an object`)
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(`unsupported schema keyword "${keyword}" at ${describe(location)}`)
    }
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => typeMatches(value, type))) {
      problems.push(`${describe(location)} must be of type ${types.join(' or ')}`)
      return problems
    }
  }
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    problems.push(`${describe(location)} must equal ${JSON.stringify(schema.const)}`)
  }
  if (schema.enum !== undefined && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    problems.push(`${describe(location)} must be one of ${schema.enum.map((o) => JSON.stringify(o)).join(', ')}`)
  }
  if (schema.pattern !== undefined && typeof value === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
    problems.push(`${describe(location)} must match ${schema.pattern}`)
  }
  if (schema.minLength !== undefined && typeof value === 'string' && value.length < schema.minLength) {
    problems.push(`${describe(location)} must be at least ${schema.minLength} characters`)
  }
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    problems.push(`${describe(location)} must be at least ${schema.minimum}`)
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      problems.push(`${describe(location)} must contain at least ${schema.minItems} item(s)`)
    }
    if (schema.uniqueItems === true) {
      const seen = new Set(value.map((item) => JSON.stringify(item)))
      if (seen.size !== value.length) problems.push(`${describe(location)} must contain unique items`)
    }
    if (schema.items !== undefined) {
      for (const [index, item] of value.entries()) {
        problems.push(...validateAgainstSchema(item, schema.items, `${location}[${index}]`))
      }
    }
  }

  if (isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) problems.push(`${describe(location)} is missing required key "${key}"`)
    }
    const properties = schema.properties ?? {}
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          problems.push(`${describe(location)} has unknown key "${key}"`)
        }
      }
    } else if (schema.additionalProperties !== undefined) {
      throw new Error(`only additionalProperties:false is supported, at ${describe(location)}`)
    }
    for (const [key, subschema] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) continue
      problems.push(...validateAgainstSchema(value[key], subschema, location === '' ? key : `${location}.${key}`))
    }
  }

  return problems
}
