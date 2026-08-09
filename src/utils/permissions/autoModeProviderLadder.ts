import type { APIProvider } from '../model/providers.js'

export type AutoModeClassifierAttempt = {
  provider: APIProvider
  model: string
}

const GPT_CLASSIFIER_FALLBACKS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
] as const

export function getAutoModeClassifierAttempts(
  configuredModel: string,
  _maxRetries: number,
  anthropicProvider: Exclude<APIProvider, 'openai'>,
): AutoModeClassifierAttempt[] {
  const attempts: AutoModeClassifierAttempt[] = configuredModel.startsWith(
    'gpt-',
  )
    ? [
        { provider: 'openai', model: configuredModel },
        ...GPT_CLASSIFIER_FALLBACKS.map(model => ({
          provider: 'openai' as const,
          model,
        })),
        { provider: anthropicProvider, model: 'sonnet' },
      ]
    : [
        { provider: anthropicProvider, model: configuredModel },
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
