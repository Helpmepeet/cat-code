/** Additive session event v1. See decisions/FOCUSED-LIVE-ACTIVITY.md. */
export type ToolActivity = {
  type: 'tool.activity'
  toolUseId: string
  phase: 'reviewing' | 'executing'
  startedAt: number
  output?: string
  totalLines?: number
  timeoutMs?: number
}

export const MAX_TOOL_ACTIVITY_OUTPUT_BYTES = 2048

/** Closed validation at the desktop socket receiving boundary. */
export function isToolActivity(value: unknown): value is ToolActivity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(key => !['type', 'toolUseId', 'phase', 'startedAt', 'output', 'totalLines', 'timeoutMs'].includes(key))) return false
  if (v.type !== 'tool.activity' || typeof v.toolUseId !== 'string' || !v.toolUseId.length || v.toolUseId.length > 200) return false
  if (v.phase !== 'reviewing' && v.phase !== 'executing') return false
  if (typeof v.startedAt !== 'number' || !Number.isSafeInteger(v.startedAt) || v.startedAt < 0) return false
  if (v.phase === 'reviewing' && ('output' in v || 'totalLines' in v || 'timeoutMs' in v)) return false
  if (v.output !== undefined && (typeof v.output !== 'string' || new TextEncoder().encode(v.output).byteLength > MAX_TOOL_ACTIVITY_OUTPUT_BYTES)) return false
  return ['totalLines', 'timeoutMs'].every(key => v[key] === undefined || (typeof v[key] === 'number' && Number.isSafeInteger(v[key]) && (v[key] as number) >= 0))
}
