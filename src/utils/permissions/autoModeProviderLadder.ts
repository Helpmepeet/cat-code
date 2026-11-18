import { getProviderForModel } from '../model/providerForModel.js'
import { CODEX_ROUTES, currentCodexRelease } from '../model/configs.js'
import type { APIProvider } from '../model/providers.js'
import { remapRetiredGptModel } from '../model/model.js'

export type AutoModeClassifierAttempt = {
  provider: APIProvider
  model: string
}

export const GPT_CLASSIFIER_FALLBACKS: readonly string[] = CODEX_ROUTES.classifierFallbacks.map(
  family => currentCodexRelease(family).id,
)

export function getAutoModeClassifierAttempts(
  configuredModel: string,
  _maxRetries: number,
  anthropicProvider: Exclude<APIProvider, 'openai'>,
): AutoModeClassifierAttempt[] {
  const selectedModel = remapRetiredGptModel(configuredModel)
  const configuredGptIndex = GPT_CLASSIFIER_FALLBACKS.indexOf(selectedModel)
  const attempts: AutoModeClassifierAttempt[] = getProviderForModel(selectedModel) === 'openai'
    ? [
        { provider: 'openai', model: selectedModel },
        ...GPT_CLASSIFIER_FALLBACKS.slice(
          configuredGptIndex === -1 ? 0 : configuredGptIndex + 1,
        ).map(model => ({
          provider: 'openai' as const,
          model,
        })),
        { provider: anthropicProvider, model: 'sonnet' },
      ]
    : [
        { provider: anthropicProvider, model: selectedModel },
        ...GPT_CLASSIFIER_FALLBACKS.map(model => ({
          provider: 'openai' as const,
          model,
        })),
      ]

  const seen = new Set<string>()
  return attempts
    .filter(attempt => {
      const key = `${attempt.provider}\0${attempt.model}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}
