import type { ScheduledModelOption } from './scheduledTasks.js'

export const MAX_SCHEDULED_OPTIONS_BYTES = 1024 * 1024
export type ScheduledTaskOptionsRequest = { type: 'scheduled-options'; version: 1 }
export type ScheduledTaskOptionsResult = {
  type: 'scheduled-options-result'
  version: 1
  models: ScheduledModelOption[]
  defaultEffortOptions: string[]
  projectPaths: string[]
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
}
function efforts(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 6 && new Set(value).size === value.length &&
    value.every(item => ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(item))
}
export function validScheduledTaskOptionsPayload(value: unknown): value is undefined {
  return value === undefined
}
export function parseScheduledTaskOptionsRequest(value: unknown): ScheduledTaskOptionsRequest | null {
  return object(value) && Object.keys(value).length === 2 && value.type === 'scheduled-options' && value.version === 1 ? value as ScheduledTaskOptionsRequest : null
}
export function parseScheduledTaskOptionsResult(value: unknown): ScheduledTaskOptionsResult | null {
  if (!object(value) || Object.keys(value).length !== 5 || value.type !== 'scheduled-options-result' || value.version !== 1 ||
      !efforts(value.defaultEffortOptions) || !Array.isArray(value.models) || value.models.length > 128 ||
      !Array.isArray(value.projectPaths) || value.projectPaths.length > 4096 ||
      !value.projectPaths.every(path => text(path, 4096) && path.startsWith('/'))) return null
  if (!value.models.every(model => object(model) && Object.keys(model).length === 4 &&
      text(model.value, 100) && /^[a-zA-Z0-9._:/[\]-]+$/.test(model.value) && text(model.label, 200) &&
      ['anthropic', 'openai', 'bedrock', 'vertex', 'foundry'].includes(model.provider as string) && efforts(model.effortOptions))) return null
  return value as ScheduledTaskOptionsResult
}
