export type CodexCoreErrorCode =
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'model'
  | 'backend'
  | 'account_not_found'
  | 'invalid_request'

export class CodexCoreError extends Error {
  readonly code: CodexCoreErrorCode
  readonly status?: number
  readonly details?: unknown

  constructor(
    code: CodexCoreErrorCode,
    message: string,
    options: { status?: number; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'CodexCoreError'
    this.code = code
    this.status = options.status
    this.details = options.details
  }
}

export function normalizeCodexCoreError(error: unknown): CodexCoreError {
  if (error instanceof CodexCoreError) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error)
  const status = readStatus(error) ?? readStatusFromMessage(message)
  const lower = message.toLowerCase()

  if (status === 401 || status === 403 || lower.includes('auth') || lower.includes('token')) {
    return new CodexCoreError('auth', message, { status, cause: error })
  }
  if (status === 429 && (lower.includes('cap') || lower.includes('quota') || lower.includes('usage'))) {
    return new CodexCoreError('quota', message, { status, cause: error })
  }
  if (status === 429) {
    return new CodexCoreError('rate_limit', message, { status, cause: error })
  }
  if (status === 400 || lower.includes('model')) {
    return new CodexCoreError('model', message, { status, cause: error })
  }
  if (status && status >= 500) {
    return new CodexCoreError('backend', message, { status, cause: error })
  }

  return new CodexCoreError('backend', message, { status, cause: error })
}

function readStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

function readStatusFromMessage(message: string): number | undefined {
  const match = message.match(/\b(?:status |error \()?([1-5][0-9]{2})\b/i)
  if (!match?.[1]) return undefined
  return Number(match[1])
}
