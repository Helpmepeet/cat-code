import { describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import type { ToolPermissionContext } from '../../Tool.js'
import { modelSupportsAutoMode } from '../betas.js'
import { getNextPermissionMode } from './getNextPermissionMode.js'
import {
  getAutoModeAvailabilityEnabledState,
  getAutoModeEnabledState,
  initialPermissionModeFromCLI,
} from './permissionSetup.js'
import { isExternalPermissionMode } from './PermissionMode.js'
import { getClassifierFallbackModel } from './yoloClassifier.js'

// Verifies the --enable-auto-mode CLI flag activates auto mode, with the
// correct precedence relative to --permission-mode. Requires the
// TRANSCRIPT_CLASSIFIER feature (run with --feature=TRANSCRIPT_CLASSIFIER).
// Relies on no settings file / no cached tengu_auto_mode_config being present
// in the test environment (fresh => circuit breaker not tripped).
describe('initialPermissionModeFromCLI --enable-auto-mode', () => {
  test('enableAutoMode activates auto mode', () => {
    const { mode } = initialPermissionModeFromCLI({
      permissionModeCli: undefined,
      dangerouslySkipPermissions: false,
      enableAutoMode: true,
    })
    expect(mode).toBe('auto')
  })

  test('explicit --permission-mode takes precedence over --enable-auto-mode', () => {
    const { mode } = initialPermissionModeFromCLI({
      permissionModeCli: 'plan',
      dangerouslySkipPermissions: false,
      enableAutoMode: true,
    })
    expect(mode).toBe('plan')
  })

  test('without enableAutoMode, auto mode is the default when available', () => {
    const { mode } = initialPermissionModeFromCLI({
      permissionModeCli: undefined,
      dangerouslySkipPermissions: false,
      enableAutoMode: false,
    })
    expect(mode).toBe('auto')
  })
})

describe('auto mode with Codex models', () => {
  test('shared auto mode config defaults to disabled for migration safety', () => {
    expect(getAutoModeEnabledState()).toBe('disabled')
  })

  test('auto mode availability is enabled by default when no remote config overrides it', () => {
    expect(getAutoModeAvailabilityEnabledState()).toBe('enabled')
  })

  test('GPT models support auto mode through the OpenAI provider', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    try {
      expect(modelSupportsAutoMode('gpt-5.5')).toBe(true)
    } finally {
      delete process.env.CLAUDE_CODE_USE_OPENAI
    }
  })

  test('Shift+Tab cycles from bypass permissions back to default for GPT sessions', () => {
    process.env.ANTHROPIC_MODEL = 'gpt-5.5'
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    try {
      const context = {
        mode: 'bypassPermissions',
        isAutoModeAvailable: true,
        isBypassPermissionsModeAvailable: true,
      } as ToolPermissionContext

      expect(getNextPermissionMode(context)).toBe('default')
    } finally {
      delete process.env.ANTHROPIC_MODEL
      delete process.env.CLAUDE_CODE_USE_OPENAI
    }
  })

  test('Shift+Tab reaches auto mode directly from default when available', () => {
    process.env.ANTHROPIC_MODEL = 'gpt-5.5'
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    try {
      const context = {
        mode: 'default',
        isAutoModeAvailable: true,
        isBypassPermissionsModeAvailable: true,
      } as ToolPermissionContext

      expect(getNextPermissionMode(context)).toBe('auto')
    } finally {
      delete process.env.ANTHROPIC_MODEL
      delete process.env.CLAUDE_CODE_USE_OPENAI
    }
  })

  test('auto mode is stored as an internal mode in external sessions', () => {
    const previousUserType = process.env.USER_TYPE
    process.env.USER_TYPE = 'external'
    try {
      expect(isExternalPermissionMode('auto')).toBe(false)
    } finally {
      if (previousUserType === undefined) {
        delete process.env.USER_TYPE
      } else {
        process.env.USER_TYPE = previousUserType
      }
    }
  })

  test('classifier falls back from temporarily unavailable GPT-5.5 to GPT-5.4', () => {
    expect(
      getClassifierFallbackModel(
        'gpt-5.5',
        new Error('gpt-5.5 is temporarily unavailable'),
      ),
    ).toBe('gpt-5.4')
    expect(
      getClassifierFallbackModel(
        'gpt-5.4',
        new Error('gpt-5.4 is temporarily unavailable'),
      ),
    ).toBeUndefined()
  })

  test('classifier falls back from structured GPT-5.5 capacity errors to GPT-5.4', () => {
    expect(
      getClassifierFallbackModel('gpt-5.5', {
        status: 529,
        message: 'request failed',
      }),
    ).toBe('gpt-5.4')
    expect(
      getClassifierFallbackModel('gpt-5.5', {
        code: 'model_unavailable',
        message: 'request failed',
      }),
    ).toBe('gpt-5.4')
  })

  // Codex transient outages surface as bare 5xx statuses with a generic body.
  // Before the fix only 503/529 were recognized, so 500/502/504 silently failed
  // closed and blocked the tool with the gpt-5.5 unavailable message.
  test('classifier falls back from bare GPT-5.5 5xx outage statuses to GPT-5.4', () => {
    for (const status of [500, 502, 503, 504, 529]) {
      expect(
        getClassifierFallbackModel('gpt-5.5', {
          status,
          message: `Codex API error (${status}): upstream error`,
        }),
      ).toBe('gpt-5.4')
    }
  })

  // The Codex WS→HTTP fallback rethrows as an SDK APIConnectionError, which drops
  // the numeric status. The upstream status stays embedded in the message; the
  // classifier must recover it so the action isn't blocked on a transient error.
  test('classifier falls back when GPT-5.5 status is only embedded in the message', () => {
    expect(
      getClassifierFallbackModel(
        'gpt-5.5',
        new Error('Codex API error (503): Service Unavailable'),
      ),
    ).toBe('gpt-5.4')
    expect(
      getClassifierFallbackModel(
        'gpt-5.5',
        new Error('Codex API error (500): internal server error'),
      ),
    ).toBe('gpt-5.4')
  })

  // A real "model not found" (404) is not a transient capacity error — falling
  // back would mask a genuine misconfiguration, so it must NOT trigger fallback.
  test('classifier does not fall back from GPT-5.5 on a non-transient 404', () => {
    expect(
      getClassifierFallbackModel('gpt-5.5', {
        status: 404,
        message: 'Codex API error (404): model gpt-5.5 not found',
      }),
    ).toBeUndefined()
  })

  // A real SDK APIError instance (not just a plain object) is the actual shape
  // the non-streaming Codex HTTP path produces. Asserts the status path matches
  // a genuine InternalServerError, not only hand-rolled { status } literals.
  test('classifier falls back from a real SDK APIError on GPT-5.5', () => {
    const sdkError = new APIError(
      503,
      { error: { message: 'Codex API error (503): Service Unavailable' } },
      '503 Codex API error (503): Service Unavailable',
      new Headers() as unknown as Headers,
    )
    expect(getClassifierFallbackModel('gpt-5.5', sdkError)).toBe('gpt-5.4')
  })

  // The classifier path has no app-level account failover, so a non-cap 429
  // (generic rate limit) must fall back rather than fail closed and block.
  test('classifier falls back from a non-cap GPT-5.5 429 to GPT-5.4', () => {
    expect(
      getClassifierFallbackModel('gpt-5.5', {
        status: 429,
        message: 'Codex API error (429): rate limit exceeded',
      }),
    ).toBe('gpt-5.4')
    // 429 whose body advertises overload also falls back via text matching.
    expect(
      getClassifierFallbackModel('gpt-5.5', {
        status: 429,
        message: 'Codex API error (429): the model is currently overloaded',
      }),
    ).toBe('gpt-5.4')
  })

  // A true account usage cap surfaces as CodexAccountCapError (also status 429).
  // A same-account model swap can't clear it, and falling back would mask the
  // cap signal — so it must NOT fall back, matched by error name.
  test('classifier does not fall back from a Codex account cap on GPT-5.5', () => {
    const capError = Object.assign(
      new Error('Codex account abc123 hit usage cap'),
      { name: 'CodexAccountCapError', status: 429 },
    )
    expect(getClassifierFallbackModel('gpt-5.5', capError)).toBeUndefined()

    const authError = Object.assign(
      new Error('Codex account abc123 authentication failed (401)'),
      { name: 'CodexAccountAuthError', status: 401 },
    )
    expect(getClassifierFallbackModel('gpt-5.5', authError)).toBeUndefined()
  })
})
