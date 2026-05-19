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

  test('rejects diagnostics missing required SDK envelope fields', () => {
    const { uuid, session_id, ...withoutEnvelope } = VALID_ACCOUNT_DIAGNOSTIC
    expect(uuid).toBeDefined()
    expect(session_id).toBeDefined()

    const result = SDKMessageSchema().safeParse(withoutEnvelope)
    expect(result.success).toBe(false)
  })
})
