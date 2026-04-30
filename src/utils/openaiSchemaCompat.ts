/**
 * Maps dash-prefixed property names to valid identifiers for providers
 * that require identifier-safe property names (e.g., OpenAI).
 *
 * Today only GrepTool has dash-prefixed properties (-A, -B, -C, -n, -i).
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

/** Inverse of OPENAI_PROPERTY_RENAMES: renamed → original. */
export const OPENAI_PROPERTY_RENAMES_INVERSE: Record<string, string> =
  Object.fromEntries(
    Object.entries(OPENAI_PROPERTY_RENAMES).map(([k, v]) => [v, k]),
  )

type OpenAISchemaCompatibleObject = {
  [key: string]: unknown
  properties?: Record<string, unknown>
  required?: readonly string[]
}

export function renameSchemaPropertiesForOpenAI(
  schema: OpenAISchemaCompatibleObject,
): OpenAISchemaCompatibleObject {
  const props = schema.properties
  if (!props || typeof props !== 'object') {
    return schema
  }

  const hasRenames = Object.keys(OPENAI_PROPERTY_RENAMES).some(key => key in props)
  if (!hasRenames) {
    return schema
  }

  const newProps: Record<string, unknown> = { ...props }
  for (const [oldKey, newKey] of Object.entries(OPENAI_PROPERTY_RENAMES)) {
    if (oldKey in newProps) {
      newProps[newKey] = newProps[oldKey]
      delete newProps[oldKey]
    }
  }

  const newRequired = Array.isArray(schema.required)
    ? schema.required.map(required => OPENAI_PROPERTY_RENAMES[required] ?? required)
    : undefined

  return {
    ...schema,
    properties: newProps,
    ...(newRequired && { required: newRequired }),
  }
}

export function renameOpenAIInputKeysToOriginal(
  input: Record<string, unknown>,
): Record<string, unknown> {
  let changed = false
  const normalizedInput: Record<string, unknown> = { ...input }

  for (const [renamed, original] of Object.entries(
    OPENAI_PROPERTY_RENAMES_INVERSE,
  )) {
    if (renamed in normalizedInput && !(original in normalizedInput)) {
      normalizedInput[original] = normalizedInput[renamed]
      delete normalizedInput[renamed]
      changed = true
    }
  }

  return changed ? normalizedInput : input
}
