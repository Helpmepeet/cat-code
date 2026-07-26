/**
 * P4-6b — `MetadataInspector` (`MetadataInspector.jsx`).
 *
 * A read-only right drawer over the ACTIVE session's per-message + per-session
 * metadata. It reads ONLY data the renderer already holds — the retained raw
 * `SDKMessage[]` (via `messageMetadata.ts`) plus the session-level read-seams
 * (`permission.context` mode, `thread-goal.snapshot`, the catalog row) — so it
 * needs no new wire frame. Every value is text; nothing is a live control
 * (read-only), degrades to `—`, and never throws on a partial message
 * (tolerant narrowing lives in the selector).
 *
 * §0 deferrals rendered as an HONEST note, never mocked: worktree-session
 * details, file-history backups, and content-replacement records do not reach
 * the renderer on any current frame, so the inspector says so instead of
 * inventing them (the prototype's `MOCK_SESSION_META`/`MOCK_MSG_META` fields).
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { TasksSnapshot } from '../../shared/protocol.js'
import type { SessionMetadataView } from './messageMetadata.js'
import {
  selectMessageMetadata,
  selectMessageRefs,
  type MetadataMessageRef,
} from './messageMetadata.js'
import type { RawMessageSessionLog } from './rawMessageLog.js'
import { toneClasses, type Tone } from './tone.js'

const ROLE_TONE: Record<string, Tone> = {
  assistant: 'accent',
  user: 'default',
  system: 'info',
  result: 'good',
}

const GOAL_TONE: Record<string, Tone> = {
  active: 'good',
  paused: 'warn',
  budget_limited: 'warn',
  complete: 'info',
}

export function MetadataInspector({
  session,
  log,
  tasks,
  onClose,
}: {
  session: SessionMetadataView | null
  log: RawMessageSessionLog
  tasks?: TasksSnapshot | null
  onClose?: () => void
}): ReactNode {
  const refs = selectMessageRefs(log)
  const [picked, setPicked] = useState<string | null>(null)
  const activeUuid = picked ?? refs[refs.length - 1]?.uuid ?? null
  const meta = selectMessageMetadata(log, activeUuid, tasks?.subagents)

  useEffect(() => {
    if (!onClose) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <>
      <div
        className="fixed inset-0 z-[80] bg-black/50"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-label="Session metadata"
        className="animate-metadata-inspector-in fixed inset-y-0 right-0 z-[81] flex w-[min(520px,92vw)] flex-col border-l border-shell-seam bg-surface-panel shadow-[-20px_0_60px_rgba(0,0,0,0.6)]"
      >
        <div className="flex items-center gap-2.5 border-b border-shell-seam px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-text-primary">Metadata</div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-text-subtle">
              {meta?.messageId ?? meta?.uuid ?? '—'} · {session?.sessionId ?? 'session'}
            </div>
          </div>
          <span className="shrink-0 rounded border border-shell-seam px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-text-subtle">
            read-only
          </span>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close metadata inspector"
              className="flex h-[26px] w-[26px] shrink-0 items-center justify-center text-base leading-none text-text-subtle hover:text-text-primary"
            >
              ×
            </button>
          ) : null}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {/* Session */}
          <Section title="Session">
            <Row label="Session ID" mono>{session?.sessionId ?? '—'}</Row>
            <Row label="Mode">{session?.mode ?? '—'}</Row>
            <Row label="Permission mode" mono>{session?.permissionMode ?? '—'}</Row>
            <Row label="Tag">
              {session?.tag ? (
                <span className="font-mono text-accent">#{session.tag}</span>
              ) : (
                '—'
              )}
            </Row>
          </Section>

          {/* Thread goal */}
          <Section title="Thread goal">
            {session?.threadGoal ? (
              <>
                <Row label="Objective">{session.threadGoal.objective || '—'}</Row>
                <Row label="Status">
                  <GoalStatus status={session.threadGoal.status} />
                </Row>
                <Row label="Budget" mono>
                  {session.threadGoal.tokenBudget
                    ? `${fmtK(session.threadGoal.tokensUsed)} / ${fmtK(session.threadGoal.tokenBudget)} tokens`
                    : `${fmtK(session.threadGoal.tokensUsed)} tokens · unbounded`}
                </Row>
                <Row label="Time used" mono>{fmtDuration(session.threadGoal.timeUsedSeconds)}</Row>
                <Row label="Goal ID" mono>{session.threadGoal.goalId}</Row>
              </>
            ) : (
              <Empty>No goal on this thread.</Empty>
            )}
          </Section>

          {/* Message picker */}
          <Section title="Message" count={refs.length}>
            {refs.length === 0 ? (
              <Empty>No messages retained for this session yet.</Empty>
            ) : (
              <div className="mb-3 flex max-h-40 flex-col gap-1 overflow-y-auto">
                {refs.map(ref => (
                  <MessagePickRow
                    key={ref.uuid}
                    refItem={ref}
                    active={ref.uuid === activeUuid}
                    onPick={() => setPicked(ref.uuid)}
                  />
                ))}
              </div>
            )}
            {meta ? (
              <>
                <Row label="Kind">
                  <RolePill role={meta.role} subtype={meta.subtype} />
                </Row>
                <Row label="Message ID" mono>{meta.messageId ?? '—'}</Row>
                <Row label="Frame UUID" mono>{meta.uuid}</Row>
                <Row label="Surface">
                  <MIPill text={meta.surface ?? 'cli'} tone="info" />
                </Row>
                <Row label="Model" mono>{meta.model ?? '—'}</Row>
                <Row label="Request ID" mono>{meta.requestId ?? '—'}</Row>
                <Row label="Timestamp" mono>{meta.timestamp ?? '—'}</Row>
                <Row label="Parent tool use" mono>{meta.parentToolUseId ?? '—'}</Row>
                <Row label="Stop reason" mono>{meta.stopReason ?? '—'}</Row>
              </>
            ) : null}
          </Section>

          {/* Subagent — joined by the engine-minted parent tool-use id. */}
          {meta?.subagent ? (
            <Section title="Subagent">
              <Row label="Agent">
                {meta.subagent.agentName ?? 'Agent'}{' '}
                <span className="text-text-subtle">· {meta.subagent.agentType}</span>
              </Row>
              <Row label="Agent ID" mono>{meta.subagent.agentId}</Row>
              <Row label="Tool use ID" mono>{meta.subagent.toolUseId}</Row>
              <Row label="Sidechain">{meta.subagent.isSidechain ? 'yes' : 'no'}</Row>
              <Row label="Spawned at" mono>
                {new Date(meta.subagent.spawnedAt).toLocaleTimeString()}
              </Row>
            </Section>
          ) : null}

          {/* Usage & cost — result frames */}
          {meta?.usage || meta?.totalCostUsd != null || meta?.durationMs != null ? (
            <Section title="Usage & cost">
              <Row label="Input tokens" mono>{numOr(meta.usage?.inputTokens)}</Row>
              <Row label="Output tokens" mono>{numOr(meta.usage?.outputTokens)}</Row>
              <Row label="Total tokens" mono>{numOr(meta.usage?.totalTokens)}</Row>
              <Row label="Cost (USD)" mono>
                {meta.totalCostUsd != null ? `$${meta.totalCostUsd.toFixed(4)}` : '—'}
              </Row>
              <Row label="Duration" mono>
                {meta.durationMs != null ? `${meta.durationMs} ms` : '—'}
              </Row>
            </Section>
          ) : null}

          {/* Context collapse — compact boundary frames */}
          {meta?.compaction ? (
            <Section title="Context collapse">
              <Row label="Trigger" mono>{meta.compaction.trigger ?? '—'}</Row>
              <Row label="Messages summarized" mono>
                {numOr(meta.compaction.messagesSummarized)}
              </Row>
              <Row label="Tokens at boundary" mono>
                {meta.compaction.preTokens == null ? '—' : fmtK(meta.compaction.preTokens)}
              </Row>
              {meta.compaction.preservedSegment ? (
                <Row label="Preserved" mono>
                  {meta.compaction.preservedSegment.headUuid} →{' '}
                  {meta.compaction.preservedSegment.tailUuid}
                </Row>
              ) : null}
            </Section>
          ) : null}

          {/* Attribution + deferrals — honest, source-cited notes (never mocked). */}
          <Section title="Not available">
            <div className="text-[11.5px] leading-relaxed text-text-subtle">
              No per-message account is recorded upstream — attribution is model +
              surface only. Worktree-session, file-history backups and
              content-replacement metadata are not carried on any desktop frame
              yet (no transcript-by-id read seam), so they are omitted rather than
              invented.
            </div>
          </Section>
        </div>
      </div>
    </>
  )
}

function MessagePickRow({
  refItem,
  active,
  onPick,
}: {
  refItem: MetadataMessageRef
  active: boolean
  onPick: () => void
}) {
  const t = toneClasses(ROLE_TONE[refItem.role] ?? 'default')
  return (
    <button
      type="button"
      onClick={onPick}
      className={
        'flex items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors ' +
        (active
          ? `${t.softBg} ${t.softBorder}`
          : 'border-transparent hover:bg-white/[0.04]')
      }
    >
      <span className={`shrink-0 text-[9.5px] font-bold uppercase tracking-wide ${t.text}`}>
        {refItem.role}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-text-muted">
        {refItem.preview}
      </span>
    </button>
  )
}

function RolePill({ role, subtype }: { role: string; subtype: string | null }) {
  const t = toneClasses(ROLE_TONE[role] ?? 'default')
  return (
    <span className={t.text}>
      {role}
      {subtype ? <span className="text-text-subtle"> · {subtype}</span> : null}
    </span>
  )
}

function GoalStatus({ status }: { status: string }) {
  const t = toneClasses(GOAL_TONE[status] ?? 'default')
  return <span className={t.text}>{status}</span>
}

function MIPill({ text, tone }: { text: string; tone: Tone }) {
  const t = toneClasses(tone)
  return (
    <span className={`rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold ${t.text} ${t.softBg} ${t.softBorder}`}>
      {text}
    </span>
  )
}

function Section({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children: ReactNode
}) {
  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-text-subtle">
          {title}
        </span>
        {count != null ? (
          <span className="font-mono text-[10px] text-text-subtle/70">{count}</span>
        ) : null}
        <div className="h-px flex-1 bg-shell-seam" />
      </div>
      {children}
    </div>
  )
}

function Row({
  label,
  mono,
  children,
}: {
  label: string
  mono?: boolean
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-[128px_1fr] items-baseline gap-x-3 py-[3px]">
      <span className="text-[11.5px] text-text-subtle">{label}</span>
      <span
        className={
          'break-words text-[12.5px] text-text-muted ' + (mono ? 'font-mono' : '')
        }
      >
        {children}
      </span>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="text-[12px] text-text-subtle">{children}</div>
}

function numOr(value: number | null | undefined): string {
  return typeof value === 'number' ? String(value) : '—'
}

function fmtK(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}
