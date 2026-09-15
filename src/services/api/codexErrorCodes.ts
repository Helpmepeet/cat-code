/**
 * Structured Codex error codes, in a leaf module so both the fetch adapter and
 * the websocket transport can read the same lists. The transport cannot import
 * the adapter (the adapter imports the transport), which is why these used to
 * be a hand-copied mirror on each side.
 *
 * Only the structured code lists live here. The two text-matching cap
 * predicates in those files are deliberately NOT shared: they match different
 * strings and merging them would change what each path classifies as a cap.
 */

export const CODEX_ACCOUNT_LIMIT_ERROR_CODES = new Set([
  'usage_limit_reached',
  'rate_limit_exceeded',
  'quota_exceeded',
  'insufficient_quota',
  'usage_not_included',
])

/**
 * Structured auth-failure codes. Substring text matching
 * (codexErrorTextIndicatesRevokedAuth) missed `token_invalidated` — the server
 * code emitted when a token is superseded by a re-login — so a 401 bypassed
 * CodexAccountAuthError and all of withRetry's auth recovery. Structured-code
 * match is authoritative; text stays as a fallback.
 */
export const CODEX_ACCOUNT_AUTH_ERROR_CODES = new Set([
  'token_invalidated',
  'token_expired',
  'token_revoked',
  'invalid_token',
])

/** Case-insensitive membership test for CODEX_ACCOUNT_AUTH_ERROR_CODES. */
export function isCodexAuthErrorCode(code: string): boolean {
  return CODEX_ACCOUNT_AUTH_ERROR_CODES.has(code.toLowerCase())
}
