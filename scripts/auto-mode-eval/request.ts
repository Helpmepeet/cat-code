import { createHash } from 'node:crypto'
import { translateToCodexBody } from '../../src/services/api/codex-fetch-adapter.js'
import { isFastModeSupportedByModel } from '../../src/utils/fastMode.js'
import { getInitialSettings } from '../../src/utils/settings/settings.js'
import type { sideQuery } from '../../src/utils/sideQuery.js'

type ReviewOptions = Parameters<typeof sideQuery>[0]

export function buildPinnedReviewRequest(options: ReviewOptions) {
  const system = typeof options.system === 'string' ? [{ type: 'text' as const, text: options.system }] : options.system ?? []
  return {
    model: options.model, max_tokens: options.max_tokens ?? 1024, system, messages: options.messages,
    _openaiInstructionAssembly: { instructions: system.map(block => block.text).join('\n\n'), inputMessages: options.messages },
    ...(options.tools && { tools: options.tools }), ...(options.tool_choice && { tool_choice: options.tool_choice }),
    ...(options.temperature !== undefined && { temperature: options.temperature }),
    ...(options.reasoningEffort && { output_config: { effort: options.reasoningEffort } }),
    ...(getInitialSettings().autoModeFastMode === true && isFastModeSupportedByModel(options.model) && { speed: 'fast' as const }),
    ...(options.thinking === false ? { thinking: { type: 'disabled' as const } } : options.thinking === undefined ? {} :
      { thinking: { type: 'enabled' as const, budget_tokens: Math.min(options.thinking, (options.max_tokens ?? 1024) - 1) } }),
  }
}

export function pinnedReviewRequestDigest(options: ReviewOptions): string {
  const request = buildPinnedReviewRequest(options)
  const projection = translateToCodexBody(request)
  // Hash both the SDK inputs and translated request. Session IDs, credentials,
  // deadlines and caches are operational state, not request configuration.
  return createHash('sha256').update(JSON.stringify({ request, projection })).digest('hex')
}
