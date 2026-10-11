// Externalize only client transport/authentication. QueryEngine still builds
// OpenAI-native instructions and runs the production tools and resume machinery.
import { mock } from 'bun:test'
const engine = process.env.TASK_EVAL_ENGINE_PATH!
delete process.env.TASK_EVAL_ENGINE_PATH
const { default: Anthropic } = await import(`${engine}/node_modules/@anthropic-ai/sdk/index.mjs`)
const clientPath = `${engine}/src/services/api/client.ts`
const client = await import(clientPath)
mock.module(clientPath, () => ({ ...client, getAnthropicClient: async () => new Anthropic({
  apiKey: 'isolated-transport-placeholder', maxRetries: 1, timeout: 360000,
  fetch: globalThis.fetch,
}) }))
