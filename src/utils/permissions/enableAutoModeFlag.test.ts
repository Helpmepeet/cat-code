import { describe, expect, test } from 'bun:test'
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
      expect(modelSupportsAutoMode('gpt-5.6-terra')).toBe(true)
    } finally {
      delete process.env.CLAUDE_CODE_USE_OPENAI
    }
  })

  test('Shift+Tab cycles from bypass permissions back to default for GPT sessions', () => {
    process.env.ANTHROPIC_MODEL = 'gpt-5.6-terra'
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
    process.env.ANTHROPIC_MODEL = 'gpt-5.6-terra'
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

  test('classifier cascades GPT-5.6 transient failures through the available GPT models', () => {
    const unavailable = new Error('model is temporarily unavailable')
    expect(getClassifierFallbackModel('gpt-5.6-sol', unavailable)).toBe(
      'gpt-5.6-terra',
    )
    expect(getClassifierFallbackModel('gpt-5.6-terra', unavailable)).toBe(
      'gpt-5.6-luna',
    )
    expect(getClassifierFallbackModel('gpt-5.6-luna', unavailable)).toBeUndefined()
  })

  // A true account usage cap surfaces as CodexAccountCapError (also status 429).
  // A same-account model swap can't clear it, and falling back would mask the
  // cap signal — so it must NOT fall back, matched by error name.
  test('classifier does not fall back from a Codex account cap on GPT-5.6 Terra', () => {
    const capError = Object.assign(
      new Error('Codex account abc123 hit usage cap'),
      { name: 'CodexAccountCapError', status: 429 },
    )
    expect(getClassifierFallbackModel('gpt-5.6-terra', capError)).toBeUndefined()

    const authError = Object.assign(
      new Error('Codex account abc123 authentication failed (401)'),
      { name: 'CodexAccountAuthError', status: 401 },
    )
    expect(getClassifierFallbackModel('gpt-5.6-terra', authError)).toBeUndefined()
  })
})
