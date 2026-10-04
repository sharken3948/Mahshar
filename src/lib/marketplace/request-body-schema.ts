const MAX_SCHEMA_BYTES = 32 * 1024
const MAX_SCHEMA_DEPTH = 8
const MAX_OBJECT_PROPERTIES = 100
const ALLOWED_SCHEMA_KEYS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems',
  'title', 'description',
])
const JSON_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

export type RequestSchemaResult = { ok: true } | { ok: false; error: string }

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function finiteInteger(value: unknown, minimum = 0) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function validateSchemaNode(schema: unknown, depth: number): RequestSchemaResult {
  if (!plainObject(schema)) return { ok: false, error: 'Request schema nodes must be JSON objects' }
  if (depth > MAX_SCHEMA_DEPTH) return { ok: false, error: 'Request schema nesting is too deep' }
  const unsupported = Object.keys(schema).find(key => !ALLOWED_SCHEMA_KEYS.has(key))
  if (unsupported) return { ok: false, error: `Request schema keyword "${unsupported}" is not supported` }
  if (typeof schema.type !== 'string' || !JSON_TYPES.has(schema.type)) {
    return { ok: false, error: 'Every request schema node must declare one supported type' }
  }
  if (schema.title !== undefined && typeof schema.title !== 'string') return { ok: false, error: 'Request schema title must be a string' }
  if (schema.description !== undefined && typeof schema.description !== 'string') return { ok: false, error: 'Request schema description must be a string' }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > 100) {
      return { ok: false, error: 'Request schema enum must contain 1 to 100 values' }
    }
    if (schema.enum.some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value))) {
      return { ok: false, error: 'Request schema enum values must be scalar JSON values' }
    }
    if (schema.enum.some(value => !valueMatchesType(value, schema.type as string))) {
      return { ok: false, error: 'Request schema enum values must match the declared type' }
    }
  }
  if (schema.const !== undefined && !valueMatchesType(schema.const, schema.type as string)) {
    return { ok: false, error: 'Request schema const must match the declared type' }
  }
  if (schema.const !== undefined && schema.const !== null && !['string', 'number', 'boolean'].includes(typeof schema.const)) {
    return { ok: false, error: 'Request schema const must be a scalar JSON value' }
  }
  if (schema.type === 'object') {
    if (schema.properties !== undefined && !plainObject(schema.properties)) {
      return { ok: false, error: 'Object request schema properties must be an object' }
    }
    const properties = (schema.properties ?? {}) as Record<string, unknown>
    if (Object.keys(properties).length > MAX_OBJECT_PROPERTIES) return { ok: false, error: 'Request schema declares too many properties' }
    for (const [name, child] of Object.entries(properties)) {
      if (!name || name.length > 128) return { ok: false, error: 'Request schema property names must contain 1 to 128 characters' }
      const result = validateSchemaNode(child, depth + 1)
      if (!result.ok) return result
    }
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || schema.required.some(name => typeof name !== 'string') ||
        new Set(schema.required).size !== schema.required.length ||
        schema.required.some(name => !Object.prototype.hasOwnProperty.call(properties, name as string))) {
        return { ok: false, error: 'Request schema required fields must be unique declared property names' }
      }
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
      return { ok: false, error: 'Request schema additionalProperties must be boolean when provided' }
    }
  } else if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
    return { ok: false, error: 'Object-only request schema keywords require type object' }
  }
  if (schema.type === 'array') {
    if (schema.items === undefined) return { ok: false, error: 'Array request schemas must declare items' }
    const itemResult = validateSchemaNode(schema.items, depth + 1)
    if (!itemResult.ok) return itemResult
    if (schema.minItems !== undefined && !finiteInteger(schema.minItems)) return { ok: false, error: 'minItems must be a non-negative integer' }
    if (schema.maxItems !== undefined && !finiteInteger(schema.maxItems)) return { ok: false, error: 'maxItems must be a non-negative integer' }
    if (typeof schema.minItems === 'number' && typeof schema.maxItems === 'number' && schema.minItems > schema.maxItems) {
      return { ok: false, error: 'minItems cannot exceed maxItems' }
    }
  } else if (schema.items !== undefined || schema.minItems !== undefined || schema.maxItems !== undefined) {
    return { ok: false, error: 'Array-only request schema keywords require type array' }
  }
  if (schema.type === 'string') {
    if (schema.minLength !== undefined && !finiteInteger(schema.minLength)) return { ok: false, error: 'minLength must be a non-negative integer' }
    if (schema.maxLength !== undefined && !finiteInteger(schema.maxLength)) return { ok: false, error: 'maxLength must be a non-negative integer' }
    if (typeof schema.minLength === 'number' && typeof schema.maxLength === 'number' && schema.minLength > schema.maxLength) {
      return { ok: false, error: 'minLength cannot exceed maxLength' }
    }
  } else if (schema.minLength !== undefined || schema.maxLength !== undefined) {
    return { ok: false, error: 'String length constraints require type string' }
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (schema.minimum !== undefined && (typeof schema.minimum !== 'number' || !Number.isFinite(schema.minimum))) return { ok: false, error: 'minimum must be finite' }
    if (schema.maximum !== undefined && (typeof schema.maximum !== 'number' || !Number.isFinite(schema.maximum))) return { ok: false, error: 'maximum must be finite' }
    if (typeof schema.minimum === 'number' && typeof schema.maximum === 'number' && schema.minimum > schema.maximum) {
      return { ok: false, error: 'minimum cannot exceed maximum' }
    }
  } else if (schema.minimum !== undefined || schema.maximum !== undefined) {
    return { ok: false, error: 'Numeric constraints require type number or integer' }
  }
  return { ok: true }
}

export function validateSupportedRequestSchema(schema: unknown): RequestSchemaResult {
  if (schema === null || schema === undefined) return { ok: true }
  let serialized: string
  try { serialized = JSON.stringify(schema) }
  catch { return { ok: false, error: 'Request schema must be serializable JSON' } }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SCHEMA_BYTES) return { ok: false, error: 'Request schema is too large' }
  return validateSchemaNode(schema, 0)
}

function sameScalar(left: unknown, right: unknown) {
  return left === right
}

function valueMatchesType(value: unknown, type: string) {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return plainObject(value)
  if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === type
}

function validateValue(schema: Record<string, unknown>, value: unknown, path: string): RequestSchemaResult {
  const type = schema.type as string
  if (!valueMatchesType(value, type)) return { ok: false, error: `${path} must be ${type}` }
  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => sameScalar(candidate, value))) {
    return { ok: false, error: `${path} must use an allowed value` }
  }
  if (schema.const !== undefined && !sameScalar(schema.const, value)) return { ok: false, error: `${path} must use the required value` }
  if (type === 'string') {
    if (typeof schema.minLength === 'number' && (value as string).length < schema.minLength) return { ok: false, error: `${path} is too short` }
    if (typeof schema.maxLength === 'number' && (value as string).length > schema.maxLength) return { ok: false, error: `${path} is too long` }
  }
  if (type === 'number' || type === 'integer') {
    if (typeof schema.minimum === 'number' && (value as number) < schema.minimum) return { ok: false, error: `${path} is below the minimum` }
    if (typeof schema.maximum === 'number' && (value as number) > schema.maximum) return { ok: false, error: `${path} exceeds the maximum` }
  }
  if (type === 'array') {
    const values = value as unknown[]
    if (typeof schema.minItems === 'number' && values.length < schema.minItems) return { ok: false, error: `${path} has too few items` }
    if (typeof schema.maxItems === 'number' && values.length > schema.maxItems) return { ok: false, error: `${path} has too many items` }
    for (let index = 0; index < values.length; index += 1) {
      const result = validateValue(schema.items as Record<string, unknown>, values[index], `${path}[${index}]`)
      if (!result.ok) return result
    }
  }
  if (type === 'object') {
    const object = value as Record<string, unknown>
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
    for (const name of (schema.required ?? []) as string[]) {
      if (!Object.prototype.hasOwnProperty.call(object, name)) return { ok: false, error: `${path}.${name} is required` }
    }
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(object).find(name => !Object.prototype.hasOwnProperty.call(properties, name))
      if (unknown) return { ok: false, error: `${path}.${unknown} is not allowed` }
    }
    for (const [name, child] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(object, name)) continue
      const result = validateValue(child, object[name], `${path}.${name}`)
      if (!result.ok) return result
    }
  }
  return { ok: true }
}

export function validateRequestBody(schema: unknown, body: unknown): RequestSchemaResult {
  if (schema === null || schema === undefined) return { ok: true }
  const supported = validateSupportedRequestSchema(schema)
  if (!supported.ok) return { ok: false, error: 'Listing request schema is unsupported' }
  return validateValue(schema as Record<string, unknown>, body, 'Request body')
}
