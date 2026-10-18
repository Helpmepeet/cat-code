/**
 * WelcomeScreen (P4-17) — the first-run / empty-session launcher (`Welcome.jsx`),
 * rebuilt at the D5 DERIVED scope (`decisions/WELCOME-LAUNCHER.md`): a cat mascot
 * hero + wordmark, an interactive meta strip (Project · Start-in),
 * and the read-only Anthropic and Codex pool tables. It replaces the minimal `EmptyShell`.
 *
 * It is PURELY PRESENTATIONAL — it reads props App wires from the EXISTING domain
 * seams and grows no new feed (WELCOME-LAUNCHER §6):
 *  - recents  = `selectRecentWorkspaces` over the shared P4-6 merged selector
 *               (registry rows ∪ engine transcript history), no new store (D5);
 *  - accounts = the P4-5 pool snapshot (read-only);
 *  - trust    = best-effort per-cwd flags App joins from live sessions'
 *               `workspace-trust.snapshot` (P4-15) — the per-session-create trust
 *               GATE itself fires post-spawn on `onOpenFolder`, the real flow;
 *
 * HC1: the renderer authors no path. A recent with an `appSessionId` opens/restores
 * that registry row; a history-only project (no app id) is browse-only (the P4-6b
 * gap). "Open folder…" is the only way to author a new cwd — via the native picker.
 *
 * Prototype visual grammar (Welcome.jsx) rebuilt on the P0-2 tokens + the shell
 * idiom (SessionsPage/AccountsPage); no inline style (the data-driven bar width
 * is the one blessed §0 width-only exception, per P4-5).
 *
 * §0 deviations (WELCOME-LAUNCHER §3 keep/cut + seam limits), flagged not dropped:
 *  - The launcher's branch chooser and "New worktree" option were deferred in
 *    D5 Q2. The in-session empty state now offers local branch switching before
 *    a prompt; "Start in" still reads sandboxing from `diagnostics.snapshot`.
 *  - Project (session variant) shows the workspace NAME, not the raw cwd. §0
 *    adapted: the prototype shows a short `~/project` (`Welcome.jsx:231`) and
 *    the renderer has no home-directory seam to build one, while a full path
 *    truncates mid-path in this column. The path stays in the `title`.
 *  - Greeting username: DEFERRED — no engine-user seam in the renderer today.
 *  - Per-recent trust badge: best-effort (only live sessions expose trust); a
 *    global projects-trust feed is out of scope (no new feed rule).
 *  - Per-window reset: the pool seam carries the upstream position resets and
 *    durations, so each recognized duration shows its own countdown.
 *
 * ➕ real-added (ruled), P4-48 — the first-run order line under the greeting. It
 * has no prototype counterpart: `Startup.jsx:461-489` gates trust and OAuth at
 * APP level before any session, which `decisions/STARTUP-GATES.md` §1.2 declined
 * on 2026-07-31 ("fix discoverability, not architecture"). Copy only: no sign-in
 * control lives here, because an account verb needs an engine process to carry
 * it.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import './branchPicker.css'
import { shouldShowFirstRunOAuth } from './appModel.js'
import {
  handleMenuRovingKeyDown,
  usePopover,
} from './composerPopover.js'
import catBase from './assets/mascot-100/base.png'
import catCoding from './assets/mascot-100/coding.png'
import sleepingCat from './assets/mascot-100/sleeping.png'
import catStretching from './assets/mascot-100/stretching.png'
import catThinking from './assets/mascot-100/thinking.png'
import catWaving from './assets/mascot-100/waving.png'
import { generatedWelcomeCats } from './generatedWelcomeCats.js'
import { basename } from './pathUtils.js'
import { ProviderLogo } from './ProviderLogo.js'
import { resolveRecentOpenRoute } from './sessionsCatalogState.js'
import type { RecentWorkspace } from './sessionsCatalogState.js'
import { useAccountUsageWindows } from './welcomeUsage.js'
import type { AccountsSnapshot, AccountStatus } from '../../shared/protocol.js'
import type { HostResult, WorkspaceBranches } from '../../shared/hostApi.js'

const welcomeCats = [
  catBase,
  sleepingCat,
  catCoding,
  catStretching,
  catThinking,
  catWaving,
  ...generatedWelcomeCats,
] as const

// Pick once per renderer load so every Welcome surface in the window shares its cat.
const welcomeCat = welcomeCats[Math.floor(Math.random() * welcomeCats.length)]!

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
 *    pool table are identical to the launcher.
 */
type WelcomeScreenProps =
  | {
      variant?: 'launcher'
      recents: readonly RecentWorkspace[]
      accounts: AccountsSnapshot | null
      /** True only while this renderer document awaits its first global pool snapshot. */
      accountsUsagePending?: boolean
      /** Open/restore a recent project's most-recent openable session (HC1: id-only). */
      onOpenRecent: (recent: RecentWorkspace) => void
      /** HC1 native folder picker → spawn (the per-path trust gate fires post-spawn). */
      onOpenFolder: () => void
      rosterFailure?: {
        retrying: boolean
        onRetry: () => void
      }
    }
  | {
      variant: 'session'
      /**
       * Send-message motion (behavior 3): the first send in an empty chat is
       * landing. Taken out of flow (`position: absolute`) so the row column
       * beneath it lays out at its final place immediately instead of waiting
       * for this screen to unmount, and fades/lifts via `animate-welcome-exit`
       * instead of disappearing on the same frame the row commits.
       */
      exiting?: boolean
      managedChat?: boolean
      /** The session's actual cwd, shown read-only (null if the descriptor is absent). */
      cwd: string | null
      /** The session's git branch. App reads it from this session's
       * own `diagnostics.snapshot` (`getBranch()` at spawn), falling back to the
       * session log's `gitBranch`; null outside a git repo or on a detached HEAD. */
      branch: string | null
      /** Git is read through the host-owned workspace, never a renderer path. */
      onListBranches?: () => Promise<HostResult<WorkspaceBranches>>
      /** Returns an error to show in place, or null after opening a new session. */
      onSwitchBranch?: (branch: string) => Promise<string | null>
      onFocusBranchChat?: (sessionId: string) => void
      branchPending?: boolean
      /** Whether this session's tools run sandboxed (`diagnostics.snapshot`).
       * The "Start in" column's only real variable, now that the launcher's
       * worktree option is cut. */
      sandboxed?: boolean
      accounts: AccountsSnapshot | null
      /** True only while this renderer document awaits its first global pool snapshot. */
      accountsUsagePending?: boolean
    }

export function WelcomeScreen(props: WelcomeScreenProps) {
  const { accounts } = props
  // The sign-in card's OWN predicate, read against the session-free pool view
  // the launcher already gets, so the line promises a sign-in step on exactly
  // the states that produce one: a configured Anthropic route or any pooled
  // account silences it, as does a snapshot that has not reported yet. Nothing
  // here surfaces a sign-in control — an account verb needs an engine process
  // to carry it (`App.tsx` sendAccountVerb answers `ok:false` without one), so
  // `STARTUP-GATES.md` §1.2 ruled this discoverability copy instead.
  // `trustGateVisible` is false because that gate is per-project and this
  // screen renders only while no project is open.
  const showFirstRunOrder =
    props.variant !== 'session' && shouldShowFirstRunOAuth(accounts, false)
  const exiting = props.variant === 'session' && props.exiting === true
  return (
    <div
      className={
        exiting
          ? 'absolute inset-x-0 top-0 pointer-events-none animate-welcome-exit'
          : 'flex min-h-0 flex-1 overflow-y-auto'
      }
    >
      <div className="mx-auto w-full max-w-[1180px] px-10 pb-8 pt-10">
        {/* Hero: cat | wordmark + greeting + meta strip */}
        <div className="mb-12 grid grid-cols-1 items-center gap-6 md:grid-cols-[minmax(200px,300px)_1fr]">
          <div className="flex justify-center">
            <img
              src={welcomeCat}
              className="h-[211px] w-[248px] max-w-full object-contain"
              alt=""
              width={248}
              height={211}
            />
          </div>

          <div className="min-w-0">
            <h1 className="mb-4 text-[clamp(56px,10vw,120px)] font-bold leading-[0.9] tracking-[-0.06em]">
              <span className="text-text-primary">cat </span>
              <span className="text-accent">code</span>
            </h1>
            <div className="mb-8">
              <div className="text-[26px] font-medium tracking-[-0.02em] text-text-primary">
                Welcome back
              </div>
              {showFirstRunOrder ? (
                <p className="mt-2 text-[14px] text-text-muted">
                  Start a chat or open a project. Sign in once it opens.
                </p>
              ) : null}
            </div>

            {/* Meta strip with vertical dividers */}
            <div className="flex items-stretch border-t border-shell-seam pt-5">
              {props.variant !== 'session' || !props.managedChat ? (
                <MetaCol icon={<FolderIcon />} label="Project">
                  {props.variant === 'session' ? (
                    <SessionProject cwd={props.cwd} />
                  ) : (
                    <ProjectPicker
                      recents={props.recents}
                      onOpenRecent={props.onOpenRecent}
                      onOpenFolder={props.onOpenFolder}
                      rosterFailure={props.rosterFailure}
                    />
                  )}
                </MetaCol>
              ) : null}
              {(props.variant !== 'session' || !props.managedChat || props.sandboxed) ? (
                <>
                  {props.variant === 'session' && props.managedChat ? null : (
                    <div className="w-px bg-shell-seam" />
                  )}
                  <MetaCol icon={<MonitorIcon />} label="Start in">
                {/* This reads the one thing about where a session runs that is
                    genuinely variable: whether its tools are sandboxed
                    (`diagnostics.snapshot`). The launcher has no session to ask,
                    so it states the plain default. */}
                    <span className="text-[13px] text-text-muted">
                      {props.variant === 'session' && props.sandboxed
                        ? 'Sandboxed'
                        : 'Locally'}
                    </span>
                  </MetaCol>
                </>
              ) : null}
              {/* Branch is available once a session fixes the project path. The
                  host resolves that path from the session id for Git actions. */}
              {props.variant === 'session' && !props.managedChat ? (
                <>
                  <div className="w-px bg-shell-seam" />
                  <MetaCol icon={<BranchIcon />} label="Branch">
                    {props.onListBranches && props.onSwitchBranch ? (
                      <BranchPicker
                        branch={props.branch}
                        onList={props.onListBranches}
                        onSwitch={props.onSwitchBranch}
                        onFocusChat={props.onFocusBranchChat}
                        handoffPending={props.branchPending}
                      />
                    ) : (
                      <span className={`truncate font-mono text-[13px] text-text-muted${props.branchPending ? ' opacity-50' : ''}`}>
                        {props.branch ?? 'none'}
                      </span>
                    )}
                  </MetaCol>
                </>
              ) : null}
            </div>
          </div>
        </div>

        <AnthropicTable
          accounts={accounts}
          accountsUsagePending={props.accountsUsagePending ?? false}
        />

        {/* Codex account table — read-only pool status (P4-5) */}
        <CodexTable
          accounts={accounts}
          accountsUsagePending={props.accountsUsagePending ?? false}
        />
      </div>
    </div>
  )
}

function BranchPicker({
  branch,
  onList,
  onSwitch,
  onFocusChat,
  handoffPending = false,
}: {
  branch: string | null
  onList: () => Promise<HostResult<WorkspaceBranches>>
  onSwitch: (branch: string) => Promise<string | null>
  onFocusChat?: (sessionId: string) => void
  handoffPending?: boolean
}) {
  const { open, setOpen, close, ref, triggerRef } = usePopover(undefined, {
    selector: 'input, [role="menuitemradio"]:not(:disabled), .branch-picker-chat-link',
    prioritySelector: 'input, [aria-checked="true"]',
  })
  const [branches, setBranches] = useState<WorkspaceBranches | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [pendingTarget, setPendingTarget] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const filterRef = useRef<HTMLInputElement>(null)
  const requestRef = useRef(0)
  const pending = handoffPending || pendingTarget !== null

  const refresh = useCallback(() => {
    const ownRequest = ++requestRef.current
    setLoading(true)
    return onList().then(result => {
      if (ownRequest !== requestRef.current) return
      if (result.ok) {
        setBranches(result.value)
        setError(null)
      } else setError(result.error.message)
    }).catch(() => {
      if (ownRequest === requestRef.current) setError('Could not read branches for this project.')
    }).finally(() => {
      if (ownRequest === requestRef.current) setLoading(false)
    })
  }, [onList])
  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => { ++requestRef.current; window.removeEventListener('focus', refresh) }
  }, [refresh])
  useEffect(() => {
    if (open) refresh()
    else {
      setSwitchError(null)
      setFilter('')
    }
  }, [open, refresh])
  const showFilter = (branches?.branches.length ?? 0) > 8
  useEffect(() => {
    if (open && showFilter) filterRef.current?.focus()
  }, [open, showFilter])

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const trigger = triggerRef.current
      const menu = ref.current?.querySelector<HTMLElement>('[role="menu"]')
      if (!trigger || !menu) return
      const rect = trigger.getBoundingClientRect()
      const edge = ref.current?.getBoundingClientRect().left ?? rect.left
      const gap = 6
      const margin = 8
      const width = Math.min(300, window.innerWidth - margin * 2)
      const below = Math.max(0, window.innerHeight - rect.bottom - gap - margin)
      const above = Math.max(0, rect.top - gap - margin)
      const desiredHeight = Math.min(320, menu.scrollHeight || 320)
      const placeAbove = below < desiredHeight && above > below
      const available = placeAbove ? above : below
      const maxHeight = Math.min(320, available)
      menu.style.setProperty('--branch-menu-top', `${placeAbove ? rect.top - gap - Math.min(desiredHeight, maxHeight) : rect.bottom + gap}px`)
      menu.style.setProperty('--branch-menu-left', `${Math.max(margin, Math.min(edge, window.innerWidth - width - margin))}px`)
      menu.style.setProperty('--branch-menu-width', `${width}px`)
      menu.style.setProperty('--branch-menu-height', `${maxHeight}px`)
    }
    place()
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [open, branches, error, switchError, loading, filter, ref, triggerRef])

  const current = pendingTarget ?? (handoffPending ? branch : null) ?? (error ? 'Unavailable' : branches ? branches.current ?? branches.detached ?? 'Detached' : branch ?? '…')
  const sessionBranchStale = !pending && branches !== null && branch !== null && branches.current !== branch
  const otherChats = branches?.otherChats ?? []
  const blocked = branches?.dirty || otherChats.length > 0
  const ordered = branches ? [
    ...branches.branches.filter(name => name === branches.current),
    ...branches.branches.filter(name => name !== branches.current),
  ].filter(name => name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) : []
  const choose = (name: string) => {
    if (name === branches?.current && (!sessionBranchStale || blocked)) {
      close()
      return
    }
    setPendingTarget(name)
    setSwitchError(null)
    void onSwitch(name).then(async message => {
      await refresh()
      if (message) setSwitchError(message)
      else close()
    }).catch(() => setSwitchError('Could not switch branches.')).finally(() => setPendingTarget(null))
  }
  return (
    <div ref={ref} className="relative inline-block max-w-full">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Choose Git branch. Current branch: ${current}${sessionBranchStale ? `. This chat started on ${branch}` : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={pending}
        onClick={() => setOpen(value => !value)}
        className="inline-flex max-w-full items-center gap-1.5 rounded-sm text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className={`truncate font-mono text-[13px] text-text-muted${pending ? ' opacity-50' : ''}`}>{current}</span>
        {sessionBranchStale ? <span className="text-tone-warn" title={`This chat started on ${branch}. Start a fresh chat to use ${branches?.current ?? 'this checkout'}.`}>!</span> : null}
        <ChevronIcon open={open} />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Local Git branches"
          onKeyDown={event => {
            if (event.target === filterRef.current) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter') {
                event.preventDefault()
                const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)')]
                const row = event.key === 'ArrowUp' ? rows.at(-1) : rows[0]
                if (event.key === 'Enter') row?.click()
                else row?.focus()
              }
              return
            }
            handleMenuRovingKeyDown(event)
          }}
          className="branch-picker-menu fixed z-[71] rounded-xl border border-shell-seam bg-surface-raised p-1.5 shadow-[var(--elev-menu)]"
        >
          {branches?.dirty ? (
            <p className="branch-picker-heading text-tone-warn">Commit or stash local changes before switching.</p>
          ) : otherChats.length > 0 ? (
            <p className="branch-picker-heading text-tone-warn">Close {otherChats.map((chat, index) => (
              <span key={chat.appSessionId}>
                {index > 0 ? index === otherChats.length - 1 ? ' and ' : ', ' : ''}
                <button type="button" className="branch-picker-chat-link" onClick={() => { close(); onFocusChat?.(chat.appSessionId) }}>{chat.title}</button>
              </span>
            ))} to switch.</p>
          ) : sessionBranchStale ? (
            <p className="branch-picker-heading text-tone-warn">This chat started on {branch}. Select {branches?.current ?? 'the current branch'} to open a fresh chat on the current checkout.</p>
          ) : error ?? switchError ? (
            <p className="branch-picker-heading text-tone-danger">{error ?? switchError}</p>
          ) : branches?.branches.some(name => name !== branches.current && !branches.occupied?.[name]) ? (
            <p className="branch-picker-heading text-text-subtle">Switching closes this empty chat and opens a new one.</p>
          ) : null}
          {showFilter ? <input ref={filterRef} aria-label="Filter branches" placeholder="Filter branches" className="branch-picker-filter" value={filter} onChange={event => setFilter(event.target.value)} /> : null}
          <div className="branch-picker-scroll" aria-busy={loading}>
          {ordered.map(name => (
            <button
              key={name}
              type="button"
              role="menuitemradio"
              aria-checked={name === branches?.current}
              disabled={pending || (name !== branches?.current && (blocked || Boolean(branches?.occupied?.[name])))}
              onClick={() => choose(name)}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left font-mono text-[12px] text-text-primary hover:bg-white/[0.045] disabled:opacity-50"
            >
              <span className="min-w-0 flex-1 truncate" title={name}>{name}</span>
              {branches?.occupied?.[name] && name !== branches.current ? <span className="branch-picker-occupant" title={branches.occupied[name]}>{branches.occupied[name]}</span> : null}
              {name === branches?.current ? <span className="text-accent">✓</span> : null}
            </button>
          ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * In-session read-only project context (the `'session'` variant). The cwd is
 * fixed at session-create (HC1 — the renderer authors no path), so this is plain
 * text, never the launcher's interactive ProjectPicker.
 */
function SessionProject({ cwd }: { cwd: string | null }) {
  // The NAME, not the raw path: a full cwd truncates mid-path in this column
  // ("/Users/pt/Discor…") and tells you nothing. The prototype has the same
  // instinct, showing a short `~/project` (`Welcome.jsx:231`); the renderer has
  // no home-directory seam to build that form, so it uses the shared `basename`
  // every other surface already names a workspace by. The full path stays one
  // hover away. §0 adapted, not cut.
  const name = cwd ? basename(cwd) : ''
  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <span
        className="truncate font-mono text-[13px] text-text-muted"
        title={cwd ?? undefined}
      >
        {name || cwd || 'This workspace'}
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
  rosterFailure,
}: {
  recents: readonly RecentWorkspace[]
  onOpenRecent: (recent: RecentWorkspace) => void
  onOpenFolder: () => void
  rosterFailure?: {
    retrying: boolean
    onRetry: () => void
  }
}) {
  const { open, setOpen, close, ref, triggerRef } = usePopover()

  if (rosterFailure) {
    return (
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="text-[12.5px] text-tone-danger">
          Recent projects could not load.
        </span>
        <button
          type="button"
          disabled={rosterFailure.retrying}
          aria-busy={rosterFailure.retrying}
          onClick={rosterFailure.onRetry}
          className="text-[12.5px] font-medium text-accent transition-opacity disabled:opacity-50"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div ref={ref} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className="inline-flex max-w-full items-center gap-1.5"
      >
        {/* An action, not a selection: New Chat starts without a project, so
            naming the latest recent here would claim a choice nothing uses. */}
        <span className="truncate font-mono text-[13px] text-text-muted">
          Open a project
        </span>
        <ChevronIcon open={open} />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Recent projects"
          onKeyDown={handleMenuRovingKeyDown}
          className="absolute left-0 top-[calc(100%+4px)] z-30 w-[288px] rounded-xl border border-shell-seam bg-surface-raised p-1.5 shadow-[var(--elev-menu)]"
        >
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
                    close()
                    onOpenRecent(recent)
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
            role="menuitem"
            onClick={() => {
              close()
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
          </button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * One recent-project row. Exported so its openable/unopenable rendering can be
 * asserted directly: the dropdown is closed on first paint, so the rows never
 * appear in this package's SSR markup while the menu is closed.
 */
export function RecentItem({
  recent,
  onOpen,
}: {
  recent: RecentWorkspace
  onOpen: () => void
}) {
  // P4-40 — openability is the shared open decision, not a second rule here. A
  // project made only of terminal-created sessions used to fail this test and
  // render dead; it now opens by engine id like every other surface does. What
  // still cannot open is a project whose folder is gone from disk.
  const openable = resolveRecentOpenRoute(recent).kind !== 'none'
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
        role="menuitem"
        onClick={onOpen}
        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.045]"
      >
        {body}
      </button>
    )
  }
  return (
    <div
      role="menuitem"
      aria-disabled="true"
      className="flex w-full cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left opacity-60"
      title="This folder is missing from disk. Put it back to open the project again."
    >
      {body}
    </div>
  )
}

/* ── Codex account table (read-only, P4-5) ──────────────────────────────── */

/**
 * Re-login accounts (dead authentication / Needs re-login) are hidden from the
 * Welcome screen table. Usable accounts (including accounts with no usage data
 * and capped accounts) remain visible.
 */
function isReLoginAccount(account: AccountStatus): boolean {
  return (
    account.status === 'dead' ||
    account.statusReason === 'auth_dead' ||
    account.availabilityLabel === 'Needs re-login'
  )
}

function CodexTable({
  accounts,
  accountsUsagePending,
}: {
  accounts: AccountsSnapshot | null
  accountsUsagePending: boolean
}) {
  const rows = (accounts?.accounts ?? []).filter(
    account => !isReLoginAccount(account),
  )
  // Prototype header counts status-`healthy` accounts and labels them "healthy"
  // (`Welcome.jsx:434`), not the stricter ready = healthy-and-not-capped metric.
  const healthyCount = rows.filter(a => a.status === 'healthy').length
  return (
    <div className="border-t border-shell-seam">
      <PoolHeader
        provider="openai"
        title="Codex"
        counts={accounts ? { total: rows.length, healthy: healthyCount } : null}
      />

      {rows.length === 0 ? (
        <div className="border-t border-shell-seam px-1 py-6 text-[12.5px] text-text-subtle">
          {accounts ? 'No usable Codex accounts.' : 'No Codex account data for this view yet.'}
        </div>
      ) : (
        rows.map(account => (
          <CodexRow
            key={account.id}
            account={account}
            accountsUsagePending={accountsUsagePending}
          />
        ))
      )}
    </div>
  )
}

/** Table title row: brand-colored provider mark, name, and pool counts. */
function PoolHeader({
  provider,
  title,
  counts,
}: {
  provider: 'anthropic' | 'openai'
  title: string
  /** `healthy` is null when every listed row is healthy by construction. */
  counts: { total: number; healthy: number | null } | null
}) {
  const live = counts ? (counts.healthy ?? counts.total) : 0
  return (
    <div className="flex items-center justify-between px-1 pb-3.5 pt-5">
      <div className="flex items-center gap-2.5">
        <span
          className={
            'flex ' +
            (provider === 'anthropic' ? 'text-provider-claude' : 'text-provider-openai')
          }
        >
          <ProviderLogo provider={provider} size={16} />
        </span>
        <span className="text-[16px] font-semibold text-text-primary">
          {title}
        </span>
      </div>
      {counts ? (
        <div className="flex items-center gap-2 text-[12.5px] text-text-muted">
          <span>
            <span className="text-text-primary">{counts.total}</span>{' '}
            account{counts.total === 1 ? '' : 's'}
          </span>
          {counts.healthy !== null ? (
            <>
              <span className="text-text-subtle">·</span>
              <span>
                <span className="text-text-primary">{counts.healthy}</span> healthy
              </span>
            </>
          ) : null}
          <span
            className={
              'h-2 w-2 rounded-full ' + (live > 0 ? 'bg-tone-good' : 'bg-tone-warn')
            }
          />
        </div>
      ) : null}
    </div>
  )
}

/* ── Anthropic account table (read-only) ────────────────────────────────── */

/**
 * Claude subscription accounts from the same pool snapshot. Dead accounts and
 * idle ones whose login has gone stale are hidden like Codex re-login rows,
 * which leaves every listed row usable, so the header carries the count alone.
 * Usage arrives only on the global pool snapshot, and an idle account keeps its
 * last reading until that window resets.
 */
function AnthropicTable({
  accounts,
  accountsUsagePending,
}: {
  accounts: AccountsSnapshot | null
  accountsUsagePending: boolean
}) {
  const rows = (accounts?.anthropicAccounts ?? []).filter(
    account => account.status === 'healthy' && account.loginStale !== true,
  )
  return (
    <div className="border-t border-shell-seam">
      <PoolHeader
        provider="anthropic"
        title="Anthropic"
        counts={accounts ? { total: rows.length, healthy: null } : null}
      />

      {rows.length === 0 ? (
        <div className="border-t border-shell-seam px-1 py-6 text-[12.5px] text-text-subtle">
          {!accounts
            ? 'No Anthropic account data for this view yet.'
            : accounts.anthropicRouteAvailable
              ? 'Using an API key or cloud provider.'
              : 'No usable Anthropic accounts.'}
        </div>
      ) : (
        rows.map(account => {
          const fiveHour = anthropicWindow(
            account.usageFiveHour,
            account.usageFiveHourResetAt,
          )
          const weekly = anthropicWindow(
            account.usageWeekly,
            account.usageWeeklyResetAt,
          )
          return (
            <AccountUsageRow
              key={account.id}
              name={account.alias ?? account.email}
              isDefault={account.isDefault}
              capped={
                (fiveHour?.percent ?? 0) >= 100 || (weekly?.percent ?? 0) >= 100
              }
              fiveHour={fiveHour}
              weekly={weekly}
              accountsUsagePending={accountsUsagePending}
            />
          )
        })
      )}
    </div>
  )
}

function anthropicWindow(
  percent: number | null | undefined,
  resetAt: number | null | undefined,
): UsageWindow | null {
  return percent == null && resetAt == null
    ? null
    : { percent: percent ?? null, resetAt: resetAt ?? null }
}

function CodexRow({
  account,
  accountsUsagePending,
}: {
  account: AccountStatus
  accountsUsagePending: boolean
}) {
  const { fiveHour, weekly } = useAccountUsageWindows(account)
  return (
    <AccountUsageRow
      name={account.alias ?? account.id}
      isDefault={account.isDefault}
      capped={account.status === 'capped' || account.usageLimitReached}
      fiveHour={fiveHour}
      weekly={weekly}
      accountsUsagePending={accountsUsagePending}
      usageStale={account.usageStale}
    />
  )
}

type UsageWindow = { percent: number | null; resetAt: number | null }

function AccountUsageRow({
  name,
  isDefault,
  capped,
  fiveHour,
  weekly,
  accountsUsagePending,
  usageStale,
}: {
  name: string
  isDefault: boolean
  capped: boolean
  fiveHour: UsageWindow | null
  weekly: UsageWindow | null
  accountsUsagePending: boolean
  usageStale?: boolean
}) {
  const hasSupportedWindow = fiveHour !== null || weekly !== null
  const hasBothWindows = fiveHour !== null && weekly !== null
  return (
    <div className="grid grid-cols-[1.4fr_4.9fr] items-center gap-x-5 border-t border-white/[0.04] px-1 py-3.5 text-[13px]">
      <div className="flex min-w-0 items-center gap-2.5">
        <Radio on={isDefault} />
        <span className="truncate font-medium text-text-primary">
          {name}
        </span>
        {usageStale && hasSupportedWindow ? (
          <span
            title="Showing the last successful usage check."
            className="shrink-0 text-[10px] text-text-faint"
          >
            Stale
          </span>
        ) : null}
        {capped ? (
          <span className="shrink-0 rounded border border-accent/20 bg-accent/10 px-[7px] py-0.5 text-[9.5px] font-bold uppercase tracking-[0.08em] text-accent">
            capped
          </span>
        ) : null}
      </div>
      <div
        data-welcome-usage-region="true"
        className="grid min-w-0"
      >
        {hasSupportedWindow ? (
          <div
            data-welcome-usage-state="real"
            className={
              'animate-toast-in grid min-w-0 ' +
              (hasBothWindows ? 'grid-cols-2 gap-x-7' : 'grid-cols-1')
            }
          >
            {fiveHour ? (
              <UsageTrack label="5-hour" shortLabel="5h" window={fiveHour} />
            ) : null}
            {weekly ? (
              <UsageTrack label="Weekly" shortLabel="7d" window={weekly} />
            ) : null}
          </div>
        ) : accountsUsagePending ? (
          <UsageLoadingRail />
        ) : null}
      </div>
    </div>
  )
}

/** Decorative placeholder while this renderer document awaits global usage. */
function UsageLoadingRail() {
  return (
    <div
      data-welcome-usage-state="pending"
      aria-hidden="true"
      className="flex min-w-0 items-center"
    >
      <span className="h-[5px] w-full rounded-[3px] bg-white/[0.06]" />
    </div>
  )
}

function UsageTrack({
  label,
  shortLabel,
  window,
}: {
  label: string
  shortLabel: string
  window: { percent: number | null; resetAt: number | null }
}) {
  return (
    <div className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)_2.75rem_3.75rem] items-center gap-x-2.5">
      <span
        aria-hidden="true"
        className="font-mono text-[10px] font-medium uppercase tracking-[0.06em] text-text-faint"
      >
        {shortLabel}
      </span>
      {window.percent != null ? (
        <UsageBar label={label} pct={window.percent} />
      ) : (
        <span aria-hidden="true" />
      )}
      {window.percent != null ? (
        <UsagePct pct={window.percent} />
      ) : (
        <span aria-hidden="true" />
      )}
      <ResetCell
        label={`${label} reset`}
        value={window.resetAt != null ? formatResetCompact(window.resetAt) : ''}
      />
    </div>
  )
}

/**
 * The prototype `MiniUsageBar` (`Welcome.jsx:121`): ONE accent gradient fill
 * for every account regardless of percentage — NOT the threshold red/green/amber
 * of the AccountsPage meter. Min 2% fill so a live account is always visible.
 */
function UsageBar({ label, pct }: { label: string; pct: number }) {
  const value = pct
  const filled = Math.max(2, Math.min(100, value))
  return (
    <div
      aria-label={`${label} usage: ${value}%`}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={value}
      className="h-[5px] min-w-0 overflow-hidden rounded-[3px] bg-white/[0.06]"
      role="progressbar"
    >
      {/* §0 EXCEPTION: data-driven width Tailwind can't express — the single
          allowed width-only inline style (P4-5 precedent). */}
      <div
        className="h-full rounded-[3px] bg-gradient-to-r from-accent-soft to-accent"
        style={{ width: `${filled}%` }}
      />
    </div>
  )
}

/** Percent label — accent-tinted like the prototype (`pctColor`, `Welcome.jsx:149`),
 * darker at ≥100%; never the tone-coded green/amber/red. */
function UsagePct({ pct }: { pct: number }) {
  const p = pct
  return (
    <span
      aria-hidden="true"
      className={
        'text-right text-[13px] font-semibold tabular-nums ' +
        (p >= 100 ? 'text-accent' : 'text-accent-soft')
      }
    >
      {p}%
    </span>
  )
}

/** Compact reset countdown, mono + dim (`Welcome.jsx:169`). Blank cell when absent. */
function ResetCell({ label, value }: { label: string; value: string }) {
  return (
    <span
      aria-hidden={value ? undefined : 'true'}
      aria-label={value ? `${label}: ${value}` : undefined}
      className="truncate text-right font-mono text-[12px] tabular-nums text-text-subtle"
    >
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
