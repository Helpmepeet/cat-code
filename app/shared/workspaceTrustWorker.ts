import { narrowExact, oneOf, isBoolean } from './narrow.js'

export const MAX_WORKSPACE_TRUST_BYTES = 16 * 1024
const pathText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')

/** Cwd is spawn authority supplied by main, never a renderer or stdin path. */
export type WorkspaceTrustWorkerRequest =
  | { type: 'workspace.inspect'; version: 1 }
  | { type: 'workspace.trust'; version: 1; expectedTrustRoot: string }
export type WorkspaceTrustWorkerResult = { type: 'workspace-trust-result'; version: 1; trustRoot: string; trusted: boolean }

export function parseWorkspaceTrustWorkerRequest(value: unknown): WorkspaceTrustWorkerRequest | null {
  return narrowExact(value, { type: oneOf(['workspace.inspect'] as const), version: oneOf([1] as const) })
    ?? narrowExact(value, { type: oneOf(['workspace.trust'] as const), version: oneOf([1] as const), expectedTrustRoot: pathText })
}
export function parseWorkspaceTrustWorkerResult(value: unknown): WorkspaceTrustWorkerResult | null {
  return narrowExact(value, { type: oneOf(['workspace-trust-result'] as const), version: oneOf([1] as const), trustRoot: pathText, trusted: isBoolean })
}
