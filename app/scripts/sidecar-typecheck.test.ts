import { expect, test } from 'bun:test'
import {
  collectOwnedDiagnostics,
  hasTypecheckInfrastructureFailure,
} from './sidecar-typecheck.js'

test('scoped sidecar typecheck reports only diagnostics owned by the desktop boundary', () => {
  const output = [
    "src/QueryEngine.ts(1,1): error TS9999: existing engine error",
    "app/sidecar/index.ts(2,3): error TS2322: new sidecar error",
    "app/shared/protocol.ts(4,5): error TS2345: new shared error",
  ].join('\n')

  expect(collectOwnedDiagnostics(output)).toEqual([
    "app/sidecar/index.ts(2,3): error TS2322: new sidecar error",
    "app/shared/protocol.ts(4,5): error TS2345: new shared error",
  ])
})

test('scoped sidecar typecheck rejects locationless compiler failures', () => {
  expect(
    hasTypecheckInfrastructureFailure(
      2,
      "error TS5058: The specified path does not exist: 'missing.json'.",
    ),
  ).toBe(true)
  expect(
    hasTypecheckInfrastructureFailure(
      2,
      'src/QueryEngine.ts(1,1): error TS9999: existing engine error',
    ),
  ).toBe(false)
})
