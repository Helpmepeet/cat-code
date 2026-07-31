/**
 * P4-6b — `MetadataInspector` (`MetadataInspector.jsx`), grown into the session
 * inspector of CC-19 §4.
 *
 * A read-only right drawer over the ACTIVE session's per-message + per-session
 * state. It reads ONLY data the renderer already holds — the retained raw
 * `SDKMessage[]` (via `messageMetadata.ts`) plus the session-level read-seams
 * (`permission.context`, `settings.snapshot`, `workspace-trust.snapshot`,
 * `diagnostics.snapshot`, `thread-goal.snapshot`, the catalog row) — so it needs
 * no new wire frame. Every value is text; nothing is a live control (read-only),
 * degrades to `—`, and never throws on a partial message (tolerant narrowing
 * lives in the selector).
 *
 * **Why the live halves live here** (`docs/migration/specs/2026-07-27-settings-redesign.md`
 * §4, Law 1 — *Settings edits sources; sessions show state*): the running
 * permission context and mode, the trust of the session's cwd and its extra
 * directories, what the session's settings actually resolved to, the flag layer,
 * and the engine's own doctor output are all facts about ONE running process.
 * They were displayed under Settings headings that promise durable
 * configuration, which is the mistake that surface is being rebuilt to remove.
 * They are display-only here: the renderer authors no permission rule (T6b) and
 * writes nothing from this drawer.
 *
 * The live sections arrive as ONE optional `sessionState` bundle
 * (`sessionInspectorState.ts`) so that (a) App's wiring is a single prop and
 * (b) an unwired drawer makes one honest statement instead of five. Absent
 * bundle ≠ "this session has nothing": see `selectSeamState`.
 *
 * §0 deferrals rendered as an HONEST note, never mocked: worktree-session
 * details, file-history backups, content-replacement records, and IDE/LSP status
 * do not reach the renderer on any current frame, so the inspector says so
 * instead of inventing them (the prototype's `MOCK_SESSION_META`/`MOCK_MSG_META`
 * fields).
 */

import { useRef, useState, type ReactNode } from 'react'
import type { TasksSnapshot } from '../../shared/protocol.js'
import type { SessionMetadataView } from './messageMetadata.js'
import {
  selectMessageMetadata,
  selectMessageRefs,
  type MetadataMessageRef,
} from './messageMetadata.js'
import { PermissionRulesEditor } from './PermissionRulesEditor.js'
import type { RawMessageSessionLog } from './rawMessageLog.js'
import {
  DIRECTORY_SOURCE_AMBIGUITY_NOTE,
  INSPECTOR_SEAM_UNREAD_NOTE,
  INSPECTOR_UNWIRED_NOTE,
  LAUNCH_FLAGS_UNAVAILABLE_NOTE,
  selectEffectiveSettingRows,
  selectFlagLayer,
  selectRunControls,
  selectSessionDirectories,
  selectSettingsLayerViews,
  selectValuedSettingCount,
  type SessionInspectorState,
} from './sessionInspectorState.js'
import { SourceBadge } from './SettingsField.js'
import { useModalFocus } from './overlayFocus.js'
import { settingsWereRead } from './settingsReadState.js'
import { selectPermissionDefaultMode } from './settingsState.js'
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
  sessionState,
}: {
  session: SessionMetadataView | null
  log: RawMessageSessionLog
  tasks?: TasksSnapshot | null
  onClose?: () => void
  /**
   * CC-19 §4 — the session's live seams, in one bundle. OPTIONAL with no default
   * on purpose: `undefined` means App has not handed this drawer anything, which
   * is a different fact from "this session has no snapshot" and must not be
   * rendered as one (`sessionInspectorState.ts` `selectSeamState`, the
   * `settingsReadState.ts` doctrine). App wires it in one line:
   * `sessionState={buildSessionInspectorState({ … })}`.
   */
  sessionState?: SessionInspectorState
}): ReactNode {
  const refs = selectMessageRefs(log)
  const [picked, setPicked] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const activeUuid = picked ?? refs[refs.length - 1]?.uuid ?? null
  const meta = selectMessageMetadata(log, activeUuid, tasks?.subagents)

  useModalFocus({
    open: true,
    containerRef: dialogRef,
    onEscape: onClose ?? (() => {}),
    escapeEnabled: onClose !== undefined,
  })

  return (
    <>
      <div
        className="fixed inset-0 z-[80] bg-black/50"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Session metadata"
        tabIndex={-1}
        className="animate-toast-in fixed inset-y-0 right-0 z-[81] flex w-[min(520px,92vw)] flex-col border-l border-shell-seam bg-surface-panel shadow-[-20px_0_60px_rgba(0,0,0,0.6)]"
      >
        <div className="flex items-center gap-2.5 border-b border-shell-seam px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-text-primary">Metadata</div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-text-subtle">
              {meta?.messageId ?? meta?.uuid ?? 'none'} · {session?.sessionId ?? 'session'}
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
            <Row label="Session ID" mono>{session?.sessionId ?? 'none'}</Row>
            <Row label="Mode">{session?.mode ?? 'none'}</Row>
            <Row label="Permission mode" mono>{session?.permissionMode ?? 'none'}</Row>
            <Row label="Tag">
              {session?.tag ? (
                <span className="font-mono text-accent">#{session.tag}</span>
              ) : (
                'none'
              )}
            </Row>
          </Section>

          {/* Thread goal */}
          <Section title="Thread goal">
            {session?.threadGoal ? (
              <>
                <Row label="Objective">{session.threadGoal.objective || 'none'}</Row>
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

          {/* CC-19 §4 — the live halves that moved off Settings. One statement
           * when the bundle is absent; per-seam honesty when it is present. */}
          {sessionState === undefined ? (
            <Section title="Live session state">
              <Empty>{INSPECTOR_UNWIRED_NOTE}</Empty>
            </Section>
          ) : (
            <>
              <WorkspaceFacts state={sessionState} />
              <PermissionFacts state={sessionState} />
              <EffectiveSettings state={sessionState} />
              <SessionFlags state={sessionState} />
              <EngineDiagnostics state={sessionState} />
            </>
          )}

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
                <Row label="Message ID" mono>{meta.messageId ?? 'none'}</Row>
                <Row label="Frame UUID" mono>{meta.uuid}</Row>
                <Row label="Model" mono>{meta.model ?? 'none'}</Row>
                <Row label="Request ID" mono>{meta.requestId ?? 'none'}</Row>
                <Row label="Timestamp" mono>{meta.timestamp ?? 'none'}</Row>
                <Row label="Parent tool use" mono>{meta.parentToolUseId ?? 'none'}</Row>
                <Row label="Stop reason" mono>{meta.stopReason ?? 'none'}</Row>
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
                {meta.totalCostUsd != null ? `$${meta.totalCostUsd.toFixed(4)}` : 'none'}
              </Row>
              <Row label="Duration" mono>
                {meta.durationMs != null ? `${meta.durationMs} ms` : 'none'}
              </Row>
            </Section>
          ) : null}

          {/* Context collapse — compact boundary frames */}
          {meta?.compaction ? (
            <Section title="Context collapse">
              <Row label="Trigger" mono>{meta.compaction.trigger ?? 'none'}</Row>
              <Row label="Messages summarized" mono>
                {numOr(meta.compaction.messagesSummarized)}
              </Row>
              <Row label="Tokens at boundary" mono>
                {meta.compaction.preTokens == null
                  ? 'none'
                  : fmtK(meta.compaction.preTokens)}
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
              No per-message account or client surface is recorded, so
              attribution is by model alone. Worktree, file-history and
              content-replacement details are not carried on any frame yet, so
              they are left out rather than invented.
            </div>
          </Section>
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------------- *
 * CC-19 §4 — the live session state that moved off Settings
 * ------------------------------------------------------------------------- */

/**
 * Where a directory came from, in words. The wire carries the engine's own
 * `PermissionRuleSource` token (`src/types/permissions.ts:54-62`), which is
 * source vocabulary, not something an operator reads.
 *
 * Duplicated from `PermissionRulesEditor`'s identical map rather than imported,
 * because a renderer `.tsx` may export React components only
 * (`lint:fast-refresh`) — the same reason `permissionPromptModel.ts` keeps its
 * own copy of the mode names. The wire type is an open `string`, so an
 * unrecognized tag falls back to a phrase instead of leaking the token.
 */
const DIRECTORY_SOURCE_LABEL: Record<string, string> = {
  userSettings: 'your defaults',
  projectSettings: "this project's settings",
  localSettings: 'your private settings',
  flagSettings: 'a launch flag',
  policySettings: 'organization policy',
  cliArg: 'a launch flag',
  command: 'a command',
  session: 'this session',
}

function directorySourceLabel(source: string): string {
  return DIRECTORY_SOURCE_LABEL[source] ?? 'another source'
}

/**
 * Trust of the session's cwd, plus HOW MANY extra directories it runs with.
 * Counts, never a second path list: `PermissionRulesEditor` below already
 * renders the authoritative paths from the same `permission.context` snapshot,
 * and two renderings of one list is two places to disagree (§10).
 */
function WorkspaceFacts({ state }: { state: SessionInspectorState }) {
  const trust = state.workspaceTrust
  const directories = selectSessionDirectories(state.permissionContext)
  return (
    <Section title="Workspace">
      <Row label="Working directory" mono>
        {state.cwd ?? 'none'}
      </Row>
      {trust ? (
        <>
          <Row label="Trust">
            <TrustState trusted={trust.trusted} />
          </Row>
          <Row label="Trust root" mono>
            {trust.trustRoot ?? 'none'}
          </Row>
          <Row label="Detected repo" mono>
            {trust.detectedRepo ?? 'none'}
          </Row>
        </>
      ) : (
        <Empty>{INSPECTOR_SEAM_UNREAD_NOTE.workspaceTrust}</Empty>
      )}
      {state.permissionContext ? (
        <Row label="Extra directories">
          {directories.total === 0
            ? 'none'
            : `${directories.total} · ${directories.groups
                .map(group => `${group.count} from ${directorySourceLabel(group.source)}`)
                .join(', ')}`}
        </Row>
      ) : null}
      {directories.cliArgAmbiguous ? (
        <Note>{DIRECTORY_SOURCE_AMBIGUITY_NOTE}</Note>
      ) : null}
    </Section>
  )
}

/**
 * The engine's LIVE resolved permission context for this session — reusing the
 * canonical view (`PermissionRulesEditor`) rather than a second one, so the
 * rule-source/match-type grammar stays in one place (§10).
 *
 * `showModes={false}` + `onSetMode` never invoked: this drawer is display-only,
 * so the renderer authors no permission value (T6b). Mode switching stays on the
 * composer's `PermissionModeChip`; the durable `permissions.defaultMode` stays a
 * read-only row here and an editable one in Settings.
 */
function PermissionFacts({ state }: { state: SessionInspectorState }) {
  return (
    <Section title="Permissions">
      {state.permissionContext ? (
        <PermissionRulesEditor
          context={state.permissionContext}
          defaultMode={selectPermissionDefaultMode(state.settings)}
          onSetMode={NEVER_SETS_MODE}
          // No settings snapshot ⇒ no settings file has been read, so a null
          // defaultMode is UNKNOWN rather than unset (`settingsReadState.ts`).
          settingsLoaded={settingsWereRead(state.settings)}
          showModes={false}
        />
      ) : (
        <Empty>{INSPECTOR_SEAM_UNREAD_NOTE.permission}</Empty>
      )}
    </Section>
  )
}

/** The drawer never writes a permission mode; this exists to satisfy the prop. */
const NEVER_SETS_MODE = () => {}

/** What this session's settings files actually resolved to, layer by layer. */
function EffectiveSettings({ state }: { state: SessionInspectorState }) {
  const snapshot = state.settings
  if (!snapshot) {
    return (
      <Section title="Effective settings">
        <Empty>{INSPECTOR_SEAM_UNREAD_NOTE.settings}</Empty>
      </Section>
    )
  }
  const layers = selectSettingsLayerViews(snapshot)
  const rows = selectEffectiveSettingRows(snapshot)
  const valued = selectValuedSettingCount(rows)
  return (
    <Section count={rows.length} title="Effective settings">
      {layers.length === 0 ? (
        <Empty>
          No settings file exists at any layer for this session, so every value
          is at its built-in default.
        </Empty>
      ) : (
        <div className="mb-2 flex flex-col gap-1">
          {layers.map(layer => (
            <div className="flex items-center gap-2" key={layer.source}>
              <SourceBadge origin={layer.origin} source={layer.source} />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-subtle">
                {layer.origin}
              </span>
              <span className="shrink-0 text-[11px] text-text-muted">
                {layer.keyCount} {layer.keyCount === 1 ? 'key' : 'keys'}
              </span>
            </div>
          ))}
        </div>
      )}
      {rows.map(row => (
        <div className="flex items-baseline gap-2 py-[3px]" key={row.key}>
          <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-muted">
            {row.key}
          </code>
          {row.value !== null ? (
            <span className="shrink-0 font-mono text-[11.5px] text-text-primary">
              {String(row.value)}
            </span>
          ) : null}
          <SourceBadge source={row.source} />
        </div>
      ))}
      {rows.length > 0 ? (
        <Note>
          {valued} of {rows.length} keys arrive here with a value; the rest
          arrive as names only, so that no secret is ever sent to this window. A
          blank value means it was not sent, not that the key is unset.
        </Note>
      ) : null}
    </Section>
  )
}

/**
 * The flag layer and the session's current run controls, kept in one section
 * because an operator asks one question of both — *why is this session behaving
 * differently?* — and honest about what it cannot answer (see
 * `LAUNCH_FLAGS_UNAVAILABLE_NOTE`).
 */
function SessionFlags({ state }: { state: SessionInspectorState }) {
  const flags = selectFlagLayer(state.settings)
  const run = selectRunControls(state.diagnostics)
  return (
    <Section title="Flags & run controls">
      {state.settings ? (
        flags ? (
          <>
            <Row label="Flag settings" mono>
              {flags.origin}
            </Row>
            <Row label="Keys set" mono>
              {flags.keys.length > 0 ? flags.keys.join(', ') : 'none'}
            </Row>
            <Row label="Keys it wins" mono>
              {flags.winningKeys.length > 0
                ? flags.winningKeys.join(', ')
                : 'none'}
            </Row>
          </>
        ) : (
          <Row label="Flag layer">
            none: no --settings file or SDK inline settings
          </Row>
        )
      ) : (
        <Empty>{INSPECTOR_SEAM_UNREAD_NOTE.settings}</Empty>
      )}
      {run ? (
        <>
          <Row label="Model override" mono>
            {run.modelOverride ?? 'none'}
          </Row>
          <Row label="Resolved model" mono>
            {run.resolvedModel ?? 'none'}
          </Row>
          <Row label="Reasoning effort" mono>
            {run.effort ?? 'provider default'}
          </Row>
          <Row label="Fast mode" mono>
            {run.fastMode ? 'on' : 'off'}
          </Row>
        </>
      ) : (
        <Empty>{INSPECTOR_SEAM_UNREAD_NOTE.diagnostics}</Empty>
      )}
      <Note>{LAUNCH_FLAGS_UNAVAILABLE_NOTE}</Note>
    </Section>
  )
}

/**
 * The engine's own doctor/status output for THIS session. Rendered in the
 * drawer's row grammar rather than by reusing `DiagnosticsSection`: that
 * component also renders version/model/setting-sources, all of which this drawer
 * already shows above, so reusing it would put three facts on screen twice.
 * Nothing is re-derived — every value is read straight off the snapshot.
 */
function EngineDiagnostics({ state }: { state: SessionInspectorState }) {
  const diagnostics = state.diagnostics
  if (!diagnostics) {
    return (
      <Section title="Engine diagnostics">
        <Empty>{INSPECTOR_SEAM_UNREAD_NOTE.diagnostics}</Empty>
      </Section>
    )
  }
  return (
    <Section title="Engine diagnostics">
      <Row label="Version" mono>
        {diagnostics.version}
      </Row>
      <Row label="Bash sandbox" mono>
        {diagnostics.sandboxEnabled ? 'enabled' : 'disabled'}
      </Row>
      <WarningRow items={diagnostics.installationWarnings} label="Installation" />
      <WarningRow items={diagnostics.healthWarnings} label="Health" />
      <WarningRow items={diagnostics.memoryWarnings} label="Context usage" />
    </Section>
  )
}

function WarningRow({
  items,
  label,
}: {
  items: readonly string[]
  label: string
}) {
  return (
    <Row label={label}>
      {items.length === 0 ? (
        <span className="text-tone-good">no issues</span>
      ) : (
        <span className="flex flex-col gap-1">
          {/* Warning strings are not guaranteed unique — pair with the index. */}
          {items.map((item, index) => (
            <span className="text-tone-warn" key={`${index}:${item}`}>
              {item}
            </span>
          ))}
        </span>
      )}
    </Row>
  )
}

function TrustState({ trusted }: { trusted: boolean }) {
  const t = toneClasses(trusted ? 'good' : 'danger')
  return <span className={t.text}>{trusted ? 'trusted' : 'untrusted'}</span>
}

/** A cited limit or caveat under a section — never a value. */
function Note({ children }: { children: ReactNode }) {
  return (
    <p className="mt-2 text-[11px] leading-relaxed text-text-subtle">
      {children}
    </p>
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
  return typeof value === 'number' ? String(value) : 'none'
}

function fmtK(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}
