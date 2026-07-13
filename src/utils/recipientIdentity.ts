const TEAMMATE_NAME = /^[a-z0-9][a-z0-9_-]*$/
const RESERVED = new Set(['*', 'team-lead'])
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/
export const MAX_TEAMMATE_NAME_BYTES = 64

export class InvalidTeammateNameError extends Error {
  constructor(input: string, reason: string) {
    super(`Invalid teammate name "${input}": ${reason}`)
    this.name = 'InvalidTeammateNameError'
  }
}

export class InvalidRecipientSyntaxError extends Error {
  constructor(input: string) {
    super(`Invalid local recipient "${input}": use exactly one @ before a non-empty alias`)
    this.name = 'InvalidRecipientSyntaxError'
  }
}

export function recipientNameKey(input: string): string {
  return input.trim().toLowerCase()
}

export function canonicalizeNewTeammateName(input: string): string {
  const name = recipientNameKey(input)
  if (!TEAMMATE_NAME.test(name)) {
    throw new InvalidTeammateNameError(
      input,
      'use lowercase letters, numbers, hyphens, or underscores',
    )
  }
  if (RESERVED.has(name)) {
    throw new InvalidTeammateNameError(input, 'name is reserved for message routing')
  }
  if (WINDOWS_DEVICE_NAME.test(name)) {
    throw new InvalidTeammateNameError(input, 'name is reserved by Windows')
  }
  if (Buffer.byteLength(name, 'utf8') > MAX_TEAMMATE_NAME_BYTES) {
    throw new InvalidTeammateNameError(input, 'name exceeds 64 bytes')
  }
  return name
}

export function parseLocalRecipient(input: string):
  | { explicit: true; target: string }
  | { explicit: false; target: string } {
  const trimmed = input.trim()
  if (!trimmed.startsWith('@')) {
    return { explicit: false as const, target: trimmed }
  }
  const target = trimmed.slice(1)
  if (target.length === 0 || target.startsWith('@')) {
    throw new InvalidRecipientSyntaxError(input)
  }
  return { explicit: true as const, target }
}
