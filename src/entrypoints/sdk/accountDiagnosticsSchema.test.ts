import { describe, expect, test } from 'bun:test'

import {
  SDKAccountDiagnosticMessageSchema,
  SDKMessageSchema,
} from './coreSchemas.js'
import type { SDKAccountDiagnosticMessage } from './coreTypes.generated.js'

const VALID_ACCOUNT_DIAGNOSTIC: SDKAccountDiagnosticMessage = {
  type: 'system',
  subtype: 'cat_code_account_diagnostic',
  version: 1,
  code: 'account.route.selected',
  severity: 'info',
  provider: 'openai',
  recoverable: true,
  uuid: '123e4567-e89b-12d3-a456-426614174000',
  session_id: 'session-account-diagnostic',
}

describe('SDK account diagnostic schema', () => {
  test('accepts a valid account diagnostic system event', () => {
    expect(
      SDKAccountDiagnosticMessageSchema().safeParse(VALID_ACCOUNT_DIAGNOSTIC)
        .success,
    ).toBe(true)
    expect(SDKMessageSchema().safeParse(VALID_ACCOUNT_DIAGNOSTIC).success).toBe(
      true,
    )
  })

  test('accepts the account.identity_mismatch code', () => {
    const message: SDKAccountDiagnosticMessage = {
      ...VALID_ACCOUNT_DIAGNOSTIC,
      code: 'account.identity_mismatch',
      severity: 'warning',
      recoverable: true,
    }
    expect(SDKAccountDiagnosticMessageSchema().safeParse(message).success).toBe(
      true,
    )
    expect(SDKMessageSchema().safeParse(message).success).toBe(true)
  })

  test('accepts Patch 5 account diagnostic codes', () => {
    const patch5Codes = [
      'account.manual_switch',
      'account.active.reroll',
      'account.lease.failover',
      'account.usage.cap',
      'account.usage.uncap',
      'account.retry.exhausted',
    ] as const

    for (const code of patch5Codes) {
      const message: SDKAccountDiagnosticMessage = {
        ...VALID_ACCOUNT_DIAGNOSTIC,
        code,
        severity:
          code === 'account.retry.exhausted'
            ? 'error'
            : code === 'account.usage.cap'
              ? 'warning'
              : 'info',
        recoverable: code !== 'account.retry.exhausted',
        from_account_ref:
          code === 'account.active.reroll' || code === 'account.lease.failover'
            ? 'previous-account'
            : undefined,
        account_ref: 'current-account',
      }
      expect(SDKAccountDiagnosticMessageSchema().safeParse(message).success).toBe(
        true,
      )
      expect(SDKMessageSchema().safeParse(message).success).toBe(true)
    }
  })

  test('rejects diagnostics missing required SDK envelope fields', () => {
    const { uuid, session_id, ...withoutEnvelope } = VALID_ACCOUNT_DIAGNOSTIC
    expect(uuid).toBeDefined()
    expect(session_id).toBeDefined()

    const result = SDKMessageSchema().safeParse(withoutEnvelope)
    expect(result.success).toBe(false)
  })
})
