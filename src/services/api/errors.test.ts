import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { getIsInteractive, setIsInteractive } from '../../bootstrap/state.js'
import {
  classifyAPIError,
  getAssistantMessageFromError,
  TOKEN_REVOKED_ERROR_MESSAGE,
} from './errors.js'

const originalIsInteractive = getIsInteractive()
const originalApiKey = process.env.ANTHROPIC_API_KEY

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = 'test-placeholder'
})

afterEach(() => {
  setIsInteractive(originalIsInteractive)
})

afterAll(() => {
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = originalApiKey
})

test('recognizes a 401 OAuth access-token revocation response', () => {
  setIsInteractive(true)

  const error = new APIError(
    401,
    {
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'OAuth access token has been revoked.',
      },
      request_id: null,
    },
    'OAuth access token has been revoked.',
    new Headers(),
  )
  const message = getAssistantMessageFromError(error, 'claude-sonnet-5')

  expect(message.isApiErrorMessage).toBe(true)
  expect(message.error).toBe('authentication_failed')
  expect(message.message.content).toEqual([
    { type: 'text', text: TOKEN_REVOKED_ERROR_MESSAGE },
  ])
  expect(classifyAPIError(error)).toBe('token_revoked')
})
