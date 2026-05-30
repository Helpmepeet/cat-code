import { describe, expect, test } from 'bun:test'
import { initialPermissionModeFromCLI } from './permissionSetup.js'

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

  test('without enableAutoMode, default mode is unchanged', () => {
    const { mode } = initialPermissionModeFromCLI({
      permissionModeCli: undefined,
      dangerouslySkipPermissions: false,
      enableAutoMode: false,
    })
    expect(mode).toBe('default')
  })
})
