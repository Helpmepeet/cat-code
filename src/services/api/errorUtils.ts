import type { APIError } from '@anthropic-ai/sdk'

// SSL/TLS error codes from OpenSSL (used by both Node.js and Bun)
// See: https://www.openssl.org/docs/man3.1/man3/X509_STORE_CTX_get_error.html
const SSL_ERROR_CODES = new Set([
  // Certificate verification errors
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CERT_REVOKED',
  'CERT_REJECTED',
  'CERT_UNTRUSTED',
  // Self-signed certificate errors
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  // Chain errors
  'CERT_CHAIN_TOO_LONG',
  'PATH_LENGTH_EXCEEDED',
  // Hostname/altname errors
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  // TLS handshake errors
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
])

export type ConnectionErrorDetails = {
  code: string
  message: string
  isSSLError: boolean
}

/**
 * Extracts connection error details from the error cause chain.
 * The Anthropic SDK wraps underlying errors in the `cause` property.
 * This function walks the cause chain to find the root error code/message.
 */
export function extractConnectionErrorDetails(
  error: unknown,
): ConnectionErrorDetails | null {
  if (!error || typeof error !== 'object') {
    return null
  }

  // Walk the cause chain to find the root error with a code
  let current: unknown = error
  const maxDepth = 5 // Prevent infinite loops
  let depth = 0

  while (current && depth < maxDepth) {
    if (
      current instanceof Error &&
      'code' in current &&
      typeof current.code === 'string'
    ) {
      const code = current.code
      const isSSLError = SSL_ERROR_CODES.has(code)
      return {
        code,
        message: current.message,
        isSSLError,
      }
    }

    // Move to the next cause in the chain
    if (
      current instanceof Error &&
      'cause' in current &&
      current.cause !== current
    ) {
      current = current.cause
      depth++
    } else {
      break
    }
  }

  return null
}

/**
 * Returns an actionable hint for SSL/TLS errors, intended for contexts outside
 * the main API client (OAuth token exchange, preflight connectivity checks)
 * where `formatAPIError` doesn't apply.
 *
 * Motivation: enterprise users behind TLS-intercepting proxies (Zscaler et al.)
 * see OAuth complete in-browser but the CLI's token exchange silently fails
 * with a raw SSL code. Surfacing the likely fix saves a support round-trip.
 */
export function getSSLErrorHint(error: unknown): string | null {
  const details = extractConnectionErrorDetails(error)
  if (!details?.isSSLError) {
    return null
  }
  return `SSL certificate error (${details.code}). If you are behind a corporate proxy or TLS-intercepting firewall, set NODE_EXTRA_CA_CERTS to your CA bundle path, or ask IT to allowlist *.anthropic.com. Run /doctor for details.`
}

/**
 * Strips HTML content (e.g., CloudFlare error pages) from a message string,
 * returning a user-friendly title or empty string if HTML is detected.
 * Returns the original message unchanged if no HTML is found.
 */
function sanitizeMessageHTML(message: string): string {
  if (message.includes('<!DOCTYPE html') || message.includes('<html')) {
    const titleMatch = message.match(/<title>([^<]+)<\/title>/)
    if (titleMatch && titleMatch[1]) {
      return titleMatch[1].trim()
    }
    return ''
  }
  return message
}

/**
 * Detects if an error message contains HTML content (e.g., CloudFlare error pages)
 * and returns a user-friendly message instead
 */
export function sanitizeAPIError(apiError: APIError): string {
  const message = apiError.message
  if (!message) {
    // Sometimes message is undefined
    // TODO: figure out why
    return ''
  }
  return sanitizeMessageHTML(message)
}

/**
 * Shapes of deserialized API errors from session JSONL.
 *
 * After JSON round-tripping, the SDK's APIError loses its `.message` property.
 * The actual message lives at different nesting levels depending on the provider:
 *
 * - Bedrock/proxy: `{ error: { message: "..." } }`
 * - Standard Anthropic API: `{ error: { error: { message: "..." } } }`
 *   (the outer `.error` is the response body, the inner `.error` is the API error)
 *
 * See also: `getErrorMessage` in `logging.ts` which handles the same shapes.
 */
type NestedAPIError = {
  error?: {
    message?: string
    error?: { message?: string }
  }
}

function hasNestedError(value: unknown): value is NestedAPIError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'object' &&
    value.error !== null
  )
}

/**
 * Extract a human-readable message from a deserialized API error that lacks
 * a top-level `.message`.
 *
 * Checks two nesting levels (deeper first for specificity):
 * 1. `error.error.error.message` — standard Anthropic API shape
 * 2. `error.error.message` — Bedrock shape
 */
function extractNestedErrorMessage(error: APIError): string | null {
  if (!hasNestedError(error)) {
    return null
  }

  // Access `.error` via the narrowed type so TypeScript sees the nested shape
  // instead of the SDK's `Object | undefined`.
  const narrowed: NestedAPIError = error
  const nested = narrowed.error

  // Standard Anthropic API shape: { error: { error: { message } } }
  const deepMsg = nested?.error?.message
  if (typeof deepMsg === 'string' && deepMsg.length > 0) {
    const sanitized = sanitizeMessageHTML(deepMsg)
    if (sanitized.length > 0) {
      return sanitized
    }
  }

  // Bedrock shape: { error: { message } }
  const msg = nested?.message
  if (typeof msg === 'string' && msg.length > 0) {
    const sanitized = sanitizeMessageHTML(msg)
    if (sanitized.length > 0) {
      return sanitized
    }
  }

  return null
}

export function formatAPIError(error: APIError): string {
  // Extract connection error details from the cause chain
  const connectionDetails = extractConnectionErrorDetails(error)

  if (connectionDetails) {
    const { code, isSSLError } = connectionDetails

    // Handle timeout errors
    if (code === 'ETIMEDOUT') {
      return 'Request timed out. Check your internet connection and proxy settings'
    }

    // Handle SSL/TLS errors with specific messages
    if (isSSLError) {
      switch (code) {
        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
        case 'UNABLE_TO_GET_ISSUER_CERT':
        case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
          return 'Unable to connect to API: SSL certificate verification failed. Check your proxy or corporate SSL certificates'
        case 'CERT_HAS_EXPIRED':
          return 'Unable to connect to API: SSL certificate has expired'
        case 'CERT_REVOKED':
          return 'Unable to connect to API: SSL certificate has been revoked'
        case 'DEPTH_ZERO_SELF_SIGNED_CERT':
        case 'SELF_SIGNED_CERT_IN_CHAIN':
          return 'Unable to connect to API: Self-signed certificate detected. Check your proxy or corporate SSL certificates'
        case 'ERR_TLS_CERT_ALTNAME_INVALID':
        case 'HOSTNAME_MISMATCH':
          return 'Unable to connect to API: SSL certificate hostname mismatch'
        case 'CERT_NOT_YET_VALID':
          return 'Unable to connect to API: SSL certificate is not yet valid'
        default:
          return `Unable to connect to API: SSL error (${code})`
      }
    }
  }

  if (error.message === 'Connection error.') {
    // If we have a code but it's not SSL, include it for debugging
    if (connectionDetails?.code) {
      return `Unable to connect to API (${connectionDetails.code})`
    }
    return 'Unable to connect to API. Check your internet connection'
  }

  // Guard: when deserialized from JSONL (e.g. --resume), the error object may
  // be a plain object without a `.message` property.  Return a safe fallback
  // instead of undefined, which would crash callers that access `.length`.
  if (!error.message) {
    return (
      extractNestedErrorMessage(error) ??
      `API error (status ${error.status ?? 'unknown'})`
    )
  }

  const sanitizedMessage = sanitizeAPIError(error)
  // Use sanitized message if it's different from the original (i.e., HTML was sanitized)
  return sanitizedMessage !== error.message && sanitizedMessage.length > 0
    ? sanitizedMessage
    : error.message
}

/**
 * Codex partial-stream interruption marker.
 *
 * The Codex adapter raises this once visible output has already escaped: the
 * request cannot be replayed without duplicating text the user has read or
 * re-running a tool call that already surfaced. The NAME is load-bearing on its
 * own — the provider-neutral non-streaming fallback in `claude.ts` matches on
 * it to refuse a replay — while the structured payload is the only thing that
 * may authorize the engine's bounded continuation.
 *
 * A name-only marker (an error re-thrown through a layer that dropped the
 * field, a shape read back from an older transcript) still blocks replay and
 * never authorizes continuation. Unknown state fails closed.
 */
export const CODEX_PARTIAL_STREAM_ERROR_NAME =
  'CodexPartialStreamReplaySkippedError'

export type CodexPartialStreamTransport = 'websocket' | 'http'

export type CodexPartialStreamCause =
  | 'closed'
  | 'idle_timeout'
  | 'stream_error'
  | 'provider_failure'

export type CodexPartialStreamFailureV1 = {
  version: 1
  code: 'partial_stream_replay_skipped'
  /**
   * Continuation is a Codex-path strategy only. Anthropic thinking blocks carry
   * signature rules that make a partial assistant message unsafe to send back
   * (see the tombstoning in `query.ts`), so the engine predicate requires this.
   */
  provider: 'openai'
  transport: CodexPartialStreamTransport
  cause: CodexPartialStreamCause
  /** An open text block was closed before the failure, so it reached the transcript. */
  sealedPartialText: boolean
  hadClientToolCall: boolean
  openClientToolCalls: number
  /** Provider-side search whose completion and replay semantics are unproven. */
  hadHostedWebSearch: boolean
  automaticContinuationEligible: boolean
}

export class CodexPartialStreamReplaySkippedError extends Error {
  readonly partialStreamFailure: CodexPartialStreamFailureV1

  constructor(message: string, failure: CodexPartialStreamFailureV1) {
    super(message)
    this.name = CODEX_PARTIAL_STREAM_ERROR_NAME
    this.partialStreamFailure = failure
  }
}

const CAUSE_CHAIN_MAX_DEPTH = 5

const PARTIAL_STREAM_TRANSPORTS = new Set<string>(['websocket', 'http'])
const PARTIAL_STREAM_CAUSES = new Set<string>([
  'closed',
  'idle_timeout',
  'stream_error',
  'provider_failure',
])

/**
 * Walks an error's `cause` chain, bounded and cycle-safe. The SDK wraps
 * transport errors, so neither the name nor the payload is reliably on the
 * error the caller catches.
 */
function walkCauseChain<T>(
  error: unknown,
  visit: (candidate: Error) => T | null,
): T | null {
  let current: unknown = error
  const seen = new Set<unknown>()
  let depth = 0

  while (current instanceof Error && depth < CAUSE_CHAIN_MAX_DEPTH) {
    if (seen.has(current)) {
      return null
    }
    const hit = visit(current)
    if (hit !== null) {
      return hit
    }
    seen.add(current)
    current = current.cause
    depth++
  }

  return null
}

/**
 * Name-only recognition. Enough to refuse a same-request replay, never enough
 * to authorize a continuation — use `findCodexPartialStreamFailure` for that.
 */
export function isCodexPartialStreamReplaySkippedError(
  error: unknown,
): boolean {
  // Deliberately NOT depth-capped. This is the gate that stops a replay of a
  // request whose output the user already read; if a future SDK wraps deeper
  // than the payload walk's limit, the gate must not silently stop firing.
  // Cycle-safety comes from `seen`, not from the depth bound.
  let current: unknown = error
  const seen = new Set<unknown>()
  while (current instanceof Error && !seen.has(current)) {
    if (current.name === CODEX_PARTIAL_STREAM_ERROR_NAME) {
      return true
    }
    seen.add(current)
    current = current.cause
  }
  return false
}

/**
 * Parses the structured marker, rejecting anything malformed or partial. Every
 * field is required: a payload missing one is a payload whose provenance we
 * cannot establish, and an unrecoverable turn is a better outcome than a
 * continuation authorized by a guess.
 */
export function parseCodexPartialStreamFailure(
  value: unknown,
): CodexPartialStreamFailureV1 | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const candidate = value as Record<string, unknown>
  if (
    candidate.version !== 1 ||
    candidate.code !== 'partial_stream_replay_skipped' ||
    candidate.provider !== 'openai' ||
    typeof candidate.transport !== 'string' ||
    !PARTIAL_STREAM_TRANSPORTS.has(candidate.transport) ||
    typeof candidate.cause !== 'string' ||
    !PARTIAL_STREAM_CAUSES.has(candidate.cause) ||
    typeof candidate.sealedPartialText !== 'boolean' ||
    typeof candidate.hadClientToolCall !== 'boolean' ||
    typeof candidate.openClientToolCalls !== 'number' ||
    !Number.isInteger(candidate.openClientToolCalls) ||
    candidate.openClientToolCalls < 0 ||
    typeof candidate.hadHostedWebSearch !== 'boolean' ||
    typeof candidate.automaticContinuationEligible !== 'boolean'
  ) {
    return null
  }
  return {
    version: 1,
    code: 'partial_stream_replay_skipped',
    provider: 'openai',
    transport: candidate.transport as CodexPartialStreamTransport,
    cause: candidate.cause as CodexPartialStreamCause,
    sealedPartialText: candidate.sealedPartialText,
    hadClientToolCall: candidate.hadClientToolCall,
    openClientToolCalls: candidate.openClientToolCalls,
    hadHostedWebSearch: candidate.hadHostedWebSearch,
    automaticContinuationEligible: candidate.automaticContinuationEligible,
  }
}

/**
 * Finds the first error in the chain whose name is one of `names`. Used to
 * recover a provider verdict (a quota cap, a revoked token) that a transport
 * wrapper is carrying, so the wrapper decides replay while the verdict decides
 * what the user is told.
 */
export function findErrorInChainByName(
  error: unknown,
  names: ReadonlySet<string>,
): Error | null {
  return walkCauseChain(error, candidate =>
    names.has(candidate.name) ? candidate : null,
  )
}

/**
 * Finds the structured marker anywhere in the cause chain. Returns null for a
 * name-only marker.
 */
export function findCodexPartialStreamFailure(
  error: unknown,
): CodexPartialStreamFailureV1 | null {
  return walkCauseChain(error, candidate =>
    parseCodexPartialStreamFailure(
      (candidate as { partialStreamFailure?: unknown }).partialStreamFailure,
    ),
  )
}
