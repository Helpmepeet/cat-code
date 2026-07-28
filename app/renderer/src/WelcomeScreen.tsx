/**
 * WelcomeScreen (P4-17) — the first-run / empty-session launcher (`Welcome.jsx`),
 * rebuilt at the D5 DERIVED scope (`decisions/WELCOME-LAUNCHER.md`): a neon-cat
 * hero + wordmark, an interactive meta strip (Project · Start-in · Orchestrator),
 * and the read-only Codex pool table. It replaces the minimal `EmptyShell`.
 *
 * It is PURELY PRESENTATIONAL — it reads props App wires from the EXISTING domain
 * seams and grows no new feed (WELCOME-LAUNCHER §6):
 *  - recents  = `selectRecentWorkspaces` over the shared P4-6 merged selector
 *               (registry rows ∪ engine transcript history), no new store (D5);
 *  - accounts = the P4-5 pool snapshot (read-only);
 *  - trust    = best-effort per-cwd flags App joins from live sessions'
 *               `workspace-trust.snapshot` (P4-15) — the per-session-create trust
 *               GATE itself fires post-spawn on `onOpenFolder`, the real flow;
 *  - orchestrator = the P4-5/agent-mode `active` flag. INTERACTIVE in the session
 *               variant (P4-8b `onToggleOrchestrator` → the `agent-mode.set` verb →
 *               the engine's own `matchSessionMode`, a live per-session env switch);
 *               READ-ONLY in the launcher variant (no session yet to toggle).
 *
 * HC1: the renderer authors no path. A recent with an `appSessionId` opens/restores
 * that registry row; a history-only project (no app id) is browse-only (the P4-6b
 * gap). "Open folder…" is the only way to author a new cwd — via the native picker.
 *
 * Prototype visual grammar (Welcome.jsx) rebuilt on the P0-2 tokens + the shell
 * idiom (SessionsPage/AccountsPage); no inline style (the cat glow is a CSS class,
 * the data-driven bar width is the one blessed §0 width-only exception, per P4-5).
 *
 * §0 deviations (WELCOME-LAUNCHER §3 keep/cut + seam limits), flagged not dropped:
 *  - Branch chooser + "New worktree" start-in option: CUT/deferred (D5 Q2) — absent.
 *  - Greeting username: DEFERRED — no engine-user seam in the renderer today.
 *  - Per-recent trust badge: best-effort (only live sessions expose trust); a
 *    global projects-trust feed is out of scope (no new feed rule).
 *  - Per-window reset: the pool seam carries ONE `usageResetAt`, not per-5h/weekly,
 *    so one reset label is shown (prototype's two reset columns were mock).
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { RecentWorkspace } from './sessionsCatalogState.js'
import type { AccountsSnapshot, AccountStatus } from '../../shared/protocol.js'

/**
 * `WelcomeScreen` serves two surfaces from ONE hero + Codex-table body (zero
 * duplication):
 *  - `'launcher'` (default) — the first-run / empty-shell start page, with the
 *    interactive ProjectPicker (recents + "Open folder…").
 *  - `'session'` — the in-session EMPTY transcript (Chat.jsx:1272 renders the
 *    same WelcomeScreen when `isEmpty`). HC1 adaptation: the cwd is FIXED at
 *    session-create and the renderer authors no path, so Project is READ-ONLY
 *    context (the session's real cwd), not a picker, and the recents launcher /
 *    "Open folder…" is absent — you are already in a project. The hero, Codex
 *    pool table, and orchestrator reflect are identical to the launcher.
 */
type WelcomeScreenProps =
  | {
      variant?: 'launcher'
      recents: readonly RecentWorkspace[]
      accounts: AccountsSnapshot | null
      orchestratorActive: boolean
      /** Open/restore a recent project's most-recent openable session (HC1: id-only). */
      onOpenRecent: (recent: RecentWorkspace) => void
      /** HC1 native folder picker → spawn (the per-path trust gate fires post-spawn). */
      onOpenFolder: () => void
    }
  | {
      variant: 'session'
      /** The session's actual cwd, shown read-only (null if the descriptor is absent). */
      cwd: string | null
      /** The session's git branch, read-only (from the session log's `gitBranch`;
       * null outside a git repo or before the catalog entry lands). */
      branch: string | null
      accounts: AccountsSnapshot | null
      orchestratorActive: boolean
      /**
       * P4-8b — set THIS session's agent mode on/off (the in-session Orchestrator
       * toggle). Present only in the session variant (there IS a session to
       * toggle); when supplied the control is interactive, else it stays a
       * read-only reflect. The launcher variant never gets it (no session yet).
       */
      onToggleOrchestrator?: (next: boolean) => void
    }

export function WelcomeScreen(props: WelcomeScreenProps) {
  const { accounts, orchestratorActive } = props
  const onToggleOrchestrator =
    props.variant === 'session' ? props.onToggleOrchestrator : undefined
  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1180px] px-10 pb-8 pt-10">
        {/* Hero: cat | wordmark + greeting + meta strip */}
        <div className="mb-12 grid grid-cols-1 items-center gap-6 md:grid-cols-[minmax(200px,300px)_1fr]">
          <div className="flex justify-center">
            <NeonCat />
          </div>

          <div className="min-w-0">
            <h1 className="mb-4 text-[clamp(56px,10vw,120px)] font-bold leading-[0.9] tracking-[-0.06em]">
              <span className="text-text-primary">cat </span>
              <span className="text-accent">code</span>
            </h1>
            <div className="mb-8 text-[26px] font-medium tracking-[-0.02em] text-text-primary">
              Welcome back
            </div>

            {/* Meta strip with vertical dividers */}
            <div className="flex items-stretch border-t border-shell-seam pt-5">
              <MetaCol icon={<FolderIcon />} label="Project">
                {props.variant === 'session' ? (
                  <SessionProject cwd={props.cwd} />
                ) : (
                  <ProjectPicker
                    recents={props.recents}
                    onOpenRecent={props.onOpenRecent}
                    onOpenFolder={props.onOpenFolder}
                  />
                )}
              </MetaCol>
              <div className="w-px bg-shell-seam" />
              <MetaCol icon={<MonitorIcon />} label="Start in">
                {/* Worktree option cut (D5 Q2); "Locally" is the only real start. */}
                <span className="text-[13px] text-text-muted">Locally</span>
              </MetaCol>
              {/* Branch is a SESSION-variant column only: read-only (HC1), the real
                  `gitBranch` from the session log (absent outside a repo / pre-catalog).
                  The launcher's interactive branch chooser was CUT (D5, worktree
                  option cut), so it keeps 3 columns. */}
              {props.variant === 'session' ? (
                <>
                  <div className="w-px bg-shell-seam" />
                  <MetaCol icon={<BranchIcon />} label="Branch">
                    <span className="truncate font-mono text-[13px] text-text-muted">
                      {props.branch ?? 'none'}
                    </span>
                  </MetaCol>
                </>
              ) : null}
              <div className="w-px bg-shell-seam" />
              <MetaCol icon={<AgentIcon />} label="Orchestrator">
                <OrchestratorReflect
                  active={orchestratorActive}
                  onToggle={onToggleOrchestrator}
                />
              </MetaCol>
            </div>
          </div>
        </div>

        {/* Codex account table — read-only pool status (P4-5) */}
        <CodexTable accounts={accounts} />
      </div>
    </div>
  )
}

/**
 * In-session read-only project context (the `'session'` variant). The cwd is
 * fixed at session-create (HC1 — the renderer authors no path), so this is plain
 * text, never the launcher's interactive ProjectPicker. Branch is NOT carried on
 * the SessionDescriptor wire (`app/shared/hostApi.ts:68` has `cwd`, no branch),
 * so it is omitted rather than fabricated (§0 deferred).
 */
function SessionProject({ cwd }: { cwd: string | null }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <span
        className="truncate font-mono text-[13px] text-text-muted"
        title={cwd ?? undefined}
      >
        {cwd ?? 'This workspace'}
      </span>
    </span>
  )
}

/* ── Meta strip ─────────────────────────────────────────────────────────── */

function MetaCol({
  icon,
  label,
  children,
}: {
  icon: ReactNode
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2 px-[18px]">
      <div className="flex items-center gap-2 whitespace-nowrap text-text-muted">
        <span className="flex text-accent">{icon}</span>
        <span className="text-[13px] text-text-muted">{label}</span>
      </div>
      <div className="min-w-0 pl-[22px] text-[13px]">{children}</div>
    </div>
  )
}

function ProjectPicker({
  recents,
  onOpenRecent,
  onOpenFolder,
}: {
  recents: readonly RecentWorkspace[]
  onOpenRecent: (recent: RecentWorkspace) => void
  onOpenFolder: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const triggerLabel = recents.length > 0 ? recents[0]!.name : 'Open a project'

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        className="inline-flex max-w-full items-center gap-1.5"
      >
        <span className="truncate font-mono text-[13px] text-text-muted">
          {triggerLabel}
        </span>
        <ChevronIcon open={open} />
      </button>

      {open ? (
        <div className="absolute left-0 top-[calc(100%+4px)] z-30 w-[288px] rounded-xl border border-shell-seam bg-surface-raised p-1.5 shadow-[0_18px_50px_rgba(0,0,0,0.6)]">
          {recents.length > 0 ? (
            <>
              <div className="px-2.5 pb-1 pt-1.5 text-[9.5px] font-bold uppercase tracking-[0.09em] text-text-faint">
                Recent
              </div>
              {recents.map(recent => (
                <RecentItem
                  key={recent.cwd}
                  recent={recent}
                  onOpen={() => {
                    if (recent.appSessionId == null) return
                    onOpenRecent(recent)
                    setOpen(false)
                  }}
                />
              ))}
              <div className="my-1 h-px bg-shell-seam" />
            </>
          ) : (
            <div className="px-2.5 py-2 text-[12px] text-text-subtle">
              No recent projects yet.
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onOpenFolder()
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.045]"
          >
            <span className="flex shrink-0 text-accent">
              <PlusIcon />
            </span>
            <span className="flex-1 text-[12.5px] text-text-primary">
              Open folder…
            </span>
            <span className="font-mono text-[11px] text-text-faint">⌘O</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}

function RecentItem({
  recent,
  onOpen,
}: {
  recent: RecentWorkspace
  onOpen: () => void
}) {
  const openable = recent.appSessionId != null
  const untrusted = recent.trusted === false
  const body = (
    <>
      <span className="flex shrink-0 text-text-subtle">
        <FolderIcon />
      </span>
      {/* The disambiguated project label, not the raw path: two projects that
          share a basename get told apart by leading path, and each carries its
          own trust badge, so one name must never stand for both. The full path
          stays one hover away. */}
      <span
        className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-text-muted"
        title={recent.cwd}
      >
        {recent.name}
      </span>
      {untrusted ? (
        <span className="shrink-0 rounded border border-tone-warn/20 bg-tone-warn/10 px-[5px] py-px text-[8.5px] font-bold uppercase tracking-wide text-tone-warn">
          untrusted
        </span>
      ) : null}
      {recent.sessionCount > 1 ? (
        <span className="shrink-0 font-mono text-[10px] text-text-subtle">
          {recent.sessionCount}
        </span>
      ) : null}
    </>
  )
  if (openable) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.045]"
      >
        {body}
      </button>
    )
  }
  return (
    <div
      className="flex w-full cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left opacity-60"
      title="Open this project from the terminal. The desktop cannot restore it yet."
    >
      {body}
    </div>
  )
}

/**
 * The orchestrator (Agent Mode) switch. INTERACTIVE when `onToggle` is supplied
 * (P4-8b — the in-session `variant:'session'` case: clicking calls the callback
 * with the negated `active`, which drives `setAgentMode` → the engine's own
 * `matchSessionMode`, a live env switch that the NEXT turn picks up — no respawn).
 * READ-ONLY otherwise (the launcher variant: there is no session to toggle, so the
 * element stays an honest `aria-readonly` reflect of the focused session's
 * `agentMode.active`, ledger §29). Exported for the DOM-free handler test (this
 * package has no click harness — AccountsPage.test.tsx convention).
 */
export function OrchestratorReflect({
  active,
  onToggle,
}: {
  active: boolean
  onToggle?: (next: boolean) => void
}) {
  const visual = (
    <>
      <span
        className={
          'relative h-[22px] w-[38px] shrink-0 rounded-full border transition-colors ' +
          (active
            ? 'border-accent/45 bg-accent/20'
            : 'border-white/10 bg-white/[0.07]')
        }
      >
        <span
          className={
            'absolute top-1 h-3 w-3 rounded-full transition-all ' +
            (active ? 'left-[18px] bg-accent-soft' : 'left-1 bg-text-subtle')
          }
        />
      </span>
      <span
        className={
          'text-[13px] font-medium ' +
          (active ? 'font-mono text-accent-soft' : 'text-text-subtle')
        }
      >
        {active ? 'On' : 'Off'}
      </span>
    </>
  )

  if (onToggle) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={active}
        onClick={() => onToggle(!active)}
        title="Toggle this session's Agent Mode. Takes effect on the next turn."
        className="inline-flex items-center gap-2.5"
      >
        {visual}
      </button>
    )
  }

  return (
    <span
      role="switch"
      aria-checked={active}
      aria-readonly="true"
      title="Reflects the focused session's Agent Mode, which is set at session start."
      className="inline-flex items-center gap-2.5"
    >
      {visual}
    </span>
  )
}

/* ── Codex account table (read-only, P4-5) ──────────────────────────────── */

function CodexTable({ accounts }: { accounts: AccountsSnapshot | null }) {
  const rows = accounts?.accounts ?? []
  // Prototype header counts status-`healthy` accounts and labels them "healthy"
  // (`Welcome.jsx:434`), not the stricter ready = healthy-and-not-capped metric.
  const healthyCount = rows.filter(a => a.status === 'healthy').length
  return (
    <div className="border-t border-shell-seam">
      <div className="flex items-center justify-between px-1 pb-3.5 pt-5">
        <div className="flex items-center gap-2.5">
          <span className="flex text-accent">
            <CubeIcon />
          </span>
          <span className="text-[16px] font-semibold text-text-primary">
            Codex
          </span>
        </div>
        {accounts ? (
          <div className="flex items-center gap-2 text-[12.5px] text-text-muted">
            <span>
              <span className="text-text-primary">{accounts.poolCount}</span>{' '}
              account{accounts.poolCount === 1 ? '' : 's'}
            </span>
            <span className="text-text-subtle">·</span>
            <span>
              <span className="text-text-primary">{healthyCount}</span> healthy
            </span>
            <span
              className={
                'h-2 w-2 rounded-full ' +
                (healthyCount > 0 ? 'bg-tone-good' : 'bg-tone-warn')
              }
            />
          </div>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <div className="border-t border-shell-seam px-1 py-6 text-[12.5px] text-text-subtle">
          No Codex account data for this view yet.
        </div>
      ) : (
        rows.map(account => <CodexRow key={account.id} account={account} />)
      )}
    </div>
  )
}

function CodexRow({ account }: { account: AccountStatus }) {
  const capped = account.status === 'capped' || account.usageLimitReached
  const reset =
    account.usageResetAt != null ? formatResetCompact(account.usageResetAt) : ''
  return (
    <div className="grid grid-cols-[1.4fr_1.6fr_0.5fr_0.6fr_1.6fr_0.5fr_0.6fr] items-center gap-x-2.5 border-t border-white/[0.04] px-1 py-3.5 text-[13px]">
      <div className="flex min-w-0 items-center gap-2.5">
        <Radio on={account.isDefault} />
        <span className="truncate font-medium text-text-primary">
          {account.alias ?? account.id}
        </span>
        {capped ? (
          <span className="shrink-0 rounded border border-accent/20 bg-accent/10 px-[7px] py-0.5 text-[9.5px] font-bold uppercase tracking-[0.08em] text-accent">
            capped
          </span>
        ) : null}
      </div>
      <UsageBar pct={account.usagePrimary} />
      <UsagePct pct={account.usagePrimary} />
      <ResetCell value={reset} />
      <UsageBar pct={account.usageWeekly} />
      <UsagePct pct={account.usageWeekly} />
      {/* §0: the seam carries ONE `usageResetAt` (the 5h/primary window), so the
          weekly reset column stays blank rather than duplicating or fabricating
          a second value — never a mock. */}
      <ResetCell value="" />
    </div>
  )
}

/**
 * The prototype `MiniUsageBar` (`Welcome.jsx:121`): ONE flat pink gradient fill
 * for every account regardless of percentage — NOT the threshold red/green/amber
 * of the AccountsPage meter. Min 2% fill so a live account is always visible.
 */
function UsageBar({ pct }: { pct: number | null }) {
  const filled = Math.max(2, Math.min(100, pct ?? 0))
  return (
    <div className="h-[5px] min-w-0 max-w-[220px] overflow-hidden rounded-[3px] bg-white/[0.06]">
      {/* §0 EXCEPTION: data-driven width Tailwind can't express — the single
          allowed width-only inline style (P4-5 precedent). */}
      <div
        className="h-full rounded-[3px] bg-gradient-to-r from-[#f9a8d4] to-[#ec4899]"
        style={{ width: `${filled}%` }}
      />
    </div>
  )
}

/** Percent label — pink like the prototype (`pctColor`, `Welcome.jsx:149`),
 * darker at ≥100%; never the tone-coded green/amber/red. */
function UsagePct({ pct }: { pct: number | null }) {
  const p = pct ?? 0
  return (
    <span
      className={
        'text-right text-[13px] font-semibold tabular-nums ' +
        (p >= 100 ? 'text-[#ec4899]' : 'text-[#f9a8d4]')
      }
    >
      {p}%
    </span>
  )
}

/** Compact reset countdown, mono + dim (`Welcome.jsx:169`). Blank cell when absent. */
function ResetCell({ value }: { value: string }) {
  return (
    <span className="truncate font-mono text-[12px] tabular-nums text-text-subtle">
      {value}
    </span>
  )
}

function Radio({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={
        'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ' +
        (on ? 'border-accent' : 'border-text-faint')
      }
    >
      {on ? <span className="h-[7px] w-[7px] rounded-full bg-accent" /> : null}
    </span>
  )
}

/**
 * Compact reset countdown matching the prototype strings (`4h56m`, `5d21h`,
 * `22m`, `3d`) — days→`Nd`/`NdNh`, hours→`Nh`/`NhNm`, else `Nm`.
 */
function formatResetCompact(sec: number): string {
  const ms = sec * 1000 - Date.now()
  if (ms <= 0) return 'now'
  const totalMin = Math.round(ms / 60000)
  const days = Math.floor(totalMin / 1440)
  const hrs = Math.floor((totalMin % 1440) / 60)
  const mins = totalMin % 60
  if (days > 0) return hrs > 0 ? `${days}d${hrs}h` : `${days}d`
  if (hrs > 0) return mins > 0 ? `${hrs}h${mins}m` : `${hrs}h`
  return `${mins}m`
}

/* ── icons (stroke, currentColor — shell idiom) ─────────────────────────── */

/**
 * The neon sleeping cat — the prototype's hand-drawn `NeonCatSVG` (Welcome.jsx:7),
 * re-expressed on theme tokens: stroke = `currentColor` under a `text-accent`
 * wrapper, glow via the `.welcome-cat-glow` class (no inline style). This IS the
 * asset (the prototype's PNG path has no analog in the packaged app), so it
 * doubles as the img-onError fallback element (ledger §29).
 */
function NeonCat() {
  return (
    <span className="welcome-cat-glow flex text-accent" aria-hidden="true">
      <svg width="248" height="211" viewBox="0 0 400 340" fill="none">
        <g
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        >
          <path d="M70 250 C 30 230, 30 170, 80 145 C 130 120, 220 120, 270 155 C 310 180, 320 220, 290 250 C 270 270, 220 280, 170 280 C 120 280, 90 270, 70 250 Z" />
          <path d="M75 250 C 50 220, 60 180, 100 175" />
          <path d="M210 195 C 200 165, 215 140, 250 138 C 290 138, 310 158, 308 188 C 305 215, 280 230, 250 230 C 230 230, 215 215, 210 195 Z" />
          <path d="M222 152 L 215 122 L 245 142" />
          <path d="M285 142 L 300 118 L 305 150" />
          <path d="M255 178 Q 262 184, 269 178" strokeWidth="2.5" />
          <path d="M285 195 Q 288 198, 291 195" strokeWidth="2.5" />
          <line x1="270" y1="200" x2="240" y2="198" strokeWidth="2" opacity="0.85" />
          <line x1="270" y1="206" x2="240" y2="210" strokeWidth="2" opacity="0.85" />
          <path d="M285 205 Q 280 212, 274 208" strokeWidth="2" />
          <path d="M180 280 Q 195 260, 220 262" opacity="0.9" />
          <g strokeWidth="2.8">
            <path d="M210 70 L 235 70 L 210 95 L 235 95" />
            <path d="M250 38 L 270 38 L 250 58 L 270 58" opacity="0.85" />
            <path d="M280 14 L 295 14 L 280 30 L 295 30" opacity="0.7" />
          </g>
        </g>
      </svg>
    </span>
  )
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function MonitorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M8 21h8M12 17v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

function AgentIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="5" r="2.4" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="5" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="19" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 7.4v3.6M12 11l-6 5M12 11l6 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function BranchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="6" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="18" cy="7" r="2.4" stroke="currentColor" strokeWidth="1.7" />
      <path d="M6 8.4v7.2M18 9.4c0 4-3 4.6-6 5.1" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CubeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="m3.3 7 8.7 5 8.7-5M12 22V12" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={'shrink-0 text-text-subtle transition-transform ' + (open ? 'rotate-180' : '')}
    >
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
