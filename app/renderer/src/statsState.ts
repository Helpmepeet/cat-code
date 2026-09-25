/**
 * Formats model names into short display labels.
 *
 * The renderer-side mirror of the engine's `getMarketingNameForModel`
 * (`src/utils/model/model.ts:785`), whose exact wording the seam already speaks
 * on the composer rail (`RunControlsSnapshot.model.label`). It is mirrored
 * rather than called because the engine module is not in the renderer's graph,
 * and mirrored HERE rather than forked into a second formatter so the app has
 * one answer to "what is this model called". Ordering is the engine's:
 * `claude-opus-4-5` has to be tested before `claude-opus-4`.
 *
 * The pre-4 entries below predate this and stay as they are; the engine spells
 * those the same way.
 */
export function formatModelDisplayName(modelName: string): string {
  if (!modelName) return 'Unknown Model'
  // `[1m]` rides the model id itself and changes what the run IS, so it travels
  // with the name rather than being trimmed for width (engine, `model.ts:791`).
  const long = modelName.toLowerCase().includes('[1m]')
  const wide = (label: string): string =>
    long ? `${label} (with 1M context)` : label
  if (modelName.includes('claude-fable-5')) return wide('Fable 5')
  if (modelName.includes('claude-opus-5')) return wide('Opus 5')
  if (modelName.includes('claude-sonnet-5')) return wide('Sonnet 5')
  if (modelName.includes('claude-opus-4-6')) return wide('Opus 4.6')
  if (modelName.includes('claude-opus-4-5')) return 'Opus 4.5'
  if (modelName.includes('claude-opus-4-1')) return 'Opus 4.1'
  if (modelName.includes('claude-opus-4')) return 'Opus 4'
  if (modelName.includes('claude-sonnet-4-6')) return wide('Sonnet 4.6')
  if (modelName.includes('claude-sonnet-4-5')) return wide('Sonnet 4.5')
  if (modelName.includes('claude-sonnet-4')) return wide('Sonnet 4')
  if (modelName.includes('claude-haiku-4-5')) return 'Haiku 4.5'
  if (modelName.includes('gpt-5.6-sol')) return 'GPT-5.6 Sol'
  if (modelName.includes('gpt-5.6-terra')) return 'GPT-5.6 Terra'
  if (modelName.includes('gpt-5.6-luna')) return 'GPT-5.6 Luna'
  if (modelName.includes('claude-3-7-sonnet')) return 'Claude 3.7 Sonnet'
  if (modelName.includes('claude-3-5-sonnet')) return 'Claude 3.5 Sonnet'
  if (modelName.includes('claude-3-5-haiku')) return 'Claude 3.5 Haiku'
  if (modelName.includes('claude-3-opus')) return 'Claude 3 Opus'
  if (modelName.includes('claude-3-haiku')) return 'Claude 3 Haiku'
  if (modelName.includes('gpt-4o-mini')) return 'GPT-4o mini'
  if (modelName.includes('gpt-4o')) return 'GPT-4o'
  if (modelName.includes('o3-mini')) return 'o3-mini'
  if (modelName.includes('o1')) return 'o1'
  return modelName
}
