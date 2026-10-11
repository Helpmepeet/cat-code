/**
 * Maps dash-prefixed property names to valid identifiers for providers
 * that require identifier-safe property names (e.g., OpenAI).
 *
 * Used by toolToAPISchema (outbound schema adaptation) and
 * normalizeToolInput (inbound input reverse-mapping).
 */
export const OPENAI_PROPERTY_RENAMES: Record<string, string> = {
  '-A': 'lines_after',
  '-B': 'lines_before',
  '-C': 'context_lines',
  '-n': 'show_line_numbers',
  '-i': 'case_insensitive',
}

type OpenAISchemaCompatibleObject = {
  [key: string]: unknown
  properties?: Record<string, unknown>
  required?: readonly string[]
}

function getPropertyRenames(
  schema: OpenAISchemaCompatibleObject,
): Record<string, string> {
  if (!schema.properties || typeof schema.properties !== 'object') return {}
  const occupiedNames = new Set(Object.keys(schema.properties))
  const renames: Record<string, string> = {}
  for (const [original, preferred] of Object.entries(OPENAI_PROPERTY_RENAMES)) {
    if (!occupiedNames.has(original)) continue
    let renamed = preferred
    let suffix = 2
    while (occupiedNames.has(renamed)) renamed = `${preferred}_${suffix++}`
    renames[original] = renamed
    occupiedNames.add(renamed)
  }
  return renames
}

export function renameSchemaPropertiesForOpenAI(
  schema: OpenAISchemaCompatibleObject,
): OpenAISchemaCompatibleObject {
  const props = schema.properties
  if (!props || typeof props !== 'object') {
    return schema
  }

  const renames = getPropertyRenames(schema)
  if (Object.keys(renames).length === 0) {
    return schema
  }

  const newProps: Record<string, unknown> = { ...props }
  for (const [oldKey, newKey] of Object.entries(renames)) {
    newProps[newKey] = newProps[oldKey]
    delete newProps[oldKey]
  }

  const newRequired = Array.isArray(schema.required)
    ? schema.required.map(required => renames[required] ?? required)
    : undefined

  return {
    ...schema,
    properties: newProps,
    ...(newRequired && { required: newRequired }),
  }
}

export function renameOpenAIInputKeysToOriginal(
  input: Record<string, unknown>,
  originalSchema: OpenAISchemaCompatibleObject,
): Record<string, unknown> {
  let changed = false
  const normalizedInput: Record<string, unknown> = { ...input }

  // Natural names belong to the server unless this schema introduced an alias.
  for (const [original, renamed] of Object.entries(
    getPropertyRenames(originalSchema),
  )) {
    if (renamed in normalizedInput && !(original in normalizedInput)) {
      normalizedInput[original] = normalizedInput[renamed]
      delete normalizedInput[renamed]
      changed = true
    }
  }

  return changed ? normalizedInput : input
}
