import { z } from 'zod/v4'
import { isEnvTruthy } from '../envUtils.js'

export const AUTO_MODE_OUTCOME_CODES = [
  'ok',
  'error',
  'interrupted',
  'rejected-by-user',
  'blocked-by-permissions',
  'automode-blocked',
  'automode-unavailable',
  'automode-parsing-error',
] as const

export type AutoModeOutcomeCode = (typeof AUTO_MODE_OUTCOME_CODES)[number]

export type AutoModeOutcomeRecord = {
  outcome: AutoModeOutcomeCode
}

export type AutoModeMetaInput = {
  /**
   * Harness-produced, bounded records only. Tool results, error text, and
   * transcript content are intentionally not part of this input shape.
   */
  priorOutcomes?: unknown
  /**
   * The structured result of a fresh `git status --porcelain` invocation.
   * Only its exit code and stdout are inspected; stderr and command errors are
   * not representable in the emitted meta shape.
   */
  gitStatus?: unknown
  repoVisibility?: unknown
}

type FreshGitStatusResult = {
  code: number
  stdout: string
}

type AutoModeMeta = {
  outcome?: AutoModeOutcomeCode
  gitStatus?: { clean: boolean }
  repoVisibility?: 'public' | 'private' | 'unknown'
}

type AutoModeMetaOptions = {
  upstreamPortEnabled: boolean
  environment?: Readonly<Record<string, string | undefined>>
  freshGitStatus?: unknown
}

const MAX_PRIOR_OUTCOMES = 8
const MAX_RECORDED_OUTCOMES = 64
const recordedOutcomes = new Map<string, AutoModeOutcomeRecord>()

const outcomeRecordSchema = z
  .object({ outcome: z.enum(AUTO_MODE_OUTCOME_CODES) })
  .strict()

const freshGitStatusSchema = z
  .object({ code: z.number().int(), stdout: z.string() })
  .strict()

const repoVisibilitySchema = z.enum(['public', 'private', 'unknown'])

function environmentValue(
  environment: Readonly<Record<string, string | undefined>> | undefined,
  name: string,
): string | undefined {
  return environment?.[name] ?? process.env[name]
}

export function isAutoModeOutcomeCodesMetaEnabled(
  upstreamPortEnabled: boolean,
  environment?: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    upstreamPortEnabled &&
    isEnvTruthy(
      environmentValue(environment, 'CLAUDE_CODE_AUTO_MODE_OUTCOME_CODES'),
    )
  )
}

export function isAutoModeGitStatusMetaEnabled(
  upstreamPortEnabled: boolean,
  environment?: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    upstreamPortEnabled &&
    isEnvTruthy(environmentValue(environment, 'CLAUDE_CODE_AUTO_MODE_GIT_STATUS'))
  )
}

export function isAutoModeRepoVisibilityMetaEnabled(
  upstreamPortEnabled: boolean,
  environment?: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    upstreamPortEnabled &&
    isEnvTruthy(
      environmentValue(environment, 'CLAUDE_CODE_AUTO_MODE_REPO_VISIBILITY'),
    )
  )
}

export function createAutoModeOutcomeMeta(
  record: unknown,
): AutoModeMeta | null {
  const parsed = outcomeRecordSchema.safeParse(record)
  return parsed.success ? { outcome: parsed.data.outcome } : null
}

export function recordAutoModeOutcome(
  toolUseID: string,
  outcome: AutoModeOutcomeCode,
): void {
  recordedOutcomes.delete(toolUseID)
  recordedOutcomes.set(toolUseID, { outcome })
  if (recordedOutcomes.size > MAX_RECORDED_OUTCOMES) {
    const oldest = recordedOutcomes.keys().next().value
    if (oldest !== undefined) recordedOutcomes.delete(oldest)
  }
}

export function getRecordedAutoModeOutcomes(): AutoModeOutcomeRecord[] {
  return [...recordedOutcomes.values()]
}

export function resetRecordedAutoModeOutcomesForTest(): void {
  recordedOutcomes.clear()
}

/**
 * A fresh, successful `git status --porcelain` can prove either clean or dirty.
 * Failed commands deliberately emit no claim: stderr, errors, and partial output
 * are neither trusted facts nor classifier input.
 */
export function createFreshGitStatusMeta(result: unknown): AutoModeMeta | null {
  const parsed = freshGitStatusSchema.safeParse(result)
  if (!parsed.success || parsed.data.code !== 0) return null
  return { gitStatus: { clean: parsed.data.stdout.trim().length === 0 } }
}

export function createRepoVisibilityMeta(value: unknown): AutoModeMeta | null {
  const parsed = repoVisibilitySchema.safeParse(value)
  return parsed.success ? { repoVisibility: parsed.data } : null
}

function metaLine(meta: AutoModeMeta): string {
  return `${JSON.stringify({ meta })}\n`
}

/**
 * Converts independently gated, schema-validated harness facts to JSONL lines.
 * This function can only emit the fixed shapes above; it never serializes raw
 * tool output, transcript content, stderr, or an error string.
 */
export function buildAutoModeMetaLines(
  input: AutoModeMetaInput | undefined,
  options: AutoModeMetaOptions,
): string[] {
  const lines: string[] = []
  const { upstreamPortEnabled, environment } = options

  if (isAutoModeOutcomeCodesMetaEnabled(upstreamPortEnabled, environment)) {
    if (Array.isArray(input?.priorOutcomes)) {
      for (const record of input.priorOutcomes.slice(-MAX_PRIOR_OUTCOMES)) {
        const meta = createAutoModeOutcomeMeta(record)
        if (meta !== null) lines.push(metaLine(meta))
      }
    }
  }

  if (isAutoModeGitStatusMetaEnabled(upstreamPortEnabled, environment)) {
    const meta = createFreshGitStatusMeta(
      options.freshGitStatus ?? input?.gitStatus,
    )
    if (meta !== null) lines.push(metaLine(meta))
  }

  if (isAutoModeRepoVisibilityMetaEnabled(upstreamPortEnabled, environment)) {
    const meta = createRepoVisibilityMeta(input?.repoVisibility)
    if (meta !== null) lines.push(metaLine(meta))
  }

  return lines
}

export type { FreshGitStatusResult }
