import type {
  ToolCardStatus,
  ToolDiffProjection,
  ToolFamily,
  ToolUseRow,
} from './transcriptProjector.js'
import type { Tone } from './tone.js'

export type ToolInspectorModel = {
  family: ToolFamily
  name: string
  summary: string
  status: ToolCardStatus
  statusLabel: string
  statusTone: Tone
  input: Record<string, unknown>
  diff: ToolDiffProjection | null
  output: string | null
}

const SUMMARY_KEYS = [
  'file_path',
  'filePath',
  'path',
  'command',
  'pattern',
  'query',
  'url',
  'prompt',
  'description',
  'name',
] as const

const STATUS_TONE: Record<ToolCardStatus, Tone> = {
  pending: 'accent',
  success: 'good',
  error: 'danger',
}

const STATUS_LABEL: Record<ToolCardStatus, string> = {
  pending: 'running',
  success: 'success',
  error: 'error',
}

export function describeToolForInspector(row: ToolUseRow): ToolInspectorModel {
  const input = isRecord(row.input) ? row.input : {}
  return {
    family: row.toolFamily,
    name: row.toolName,
    summary: deriveSummary(input),
    status: row.status,
    statusLabel: STATUS_LABEL[row.status] ?? 'unknown',
    statusTone: STATUS_TONE[row.status] ?? 'default',
    input,
    diff: row.result?.diff ?? null,
    output: nonEmpty(row.result?.content),
  }
}

function deriveSummary(input: Record<string, unknown>): string {
  for (const key of SUMMARY_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.length > 200 ? `${value.slice(0, 200)}…` : value
    }
  }
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.length > 200 ? `${value.slice(0, 200)}…` : value
    }
  }
  return 'none'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: string | undefined | null): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
