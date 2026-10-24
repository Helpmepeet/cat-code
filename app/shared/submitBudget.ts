export { validateAppSubmitPromptBudget as validateSubmitPromptBudget } from '../../src/app-runtime/appSubmitLimits.js'

export function submitPromptSerializedBytes(prompt: unknown): number {
  try {
    const serialized = JSON.stringify(prompt)
    return serialized === undefined ? Infinity : new TextEncoder().encode(serialized).byteLength
  } catch {
    return Infinity
  }
}

export function isImageSubmitPrompt(prompt: unknown): boolean {
  return Array.isArray(prompt) && prompt.some(block =>
    block !== null && typeof block === 'object' && block.type === 'image',
  )
}
