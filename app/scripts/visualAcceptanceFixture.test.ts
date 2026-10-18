import { expect, test } from 'bun:test'
import { isolatedCaptureEnvironment } from './visualAcceptanceFixture.js'

test('native bootstrap environment isolates home and credentials', () => {
  const env = isolatedCaptureEnvironment('/tmp/synthetic-config', '/tmp/synthetic-cwd', '/tmp/evidence', 'http://localhost:5197')
  expect(env.HOME).toBe('/tmp/synthetic-config/fixture-home')
  expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/synthetic-config')
  expect(env.CATCODE_HEADLESS_CAPTURE).toBe('1')
  expect(env.ANTHROPIC_API_KEY).toBe('')
  expect(env.OPENAI_API_KEY).toBe('')
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('')
})
