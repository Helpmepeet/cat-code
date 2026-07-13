/**
 * Startup gate surfaces (P4-15) — the D4-ruled subset of the prototype
 * `Startup.jsx`: the per-session-create **trust gate** and the first-run
 * **Codex OAuth** surface. Rebuilt in TS/Tailwind on the P0-2 tokens; zero
 * inline style, zero ported prototype code.
 *
 * RULED CUTS (present in the prototype, deliberately absent here — do not add):
 *  - `ReadOnlyModeGate` + the "Open read-only" button — Q1 TUI parity: decline
 *    trust = don't open the session (there is no restricted mode).
 *  - `WorkspaceSwitchPrompt` — G4: one-cwd-per-session dissolves it.
 *  - the blocking `ReauthGate` modal — Q2: token death is the non-blocking
 *    `BannerStack` banner (`reauthBannerState.ts`), never a wall.
 *
 * Real backing:
 *  - Trust: `isPathTrusted(cwd)` / `hasTrustDialogAccepted`
 *    (`src/utils/config.ts:790,111`), surfaced per session by the P4-14
 *    `workspace-trust.snapshot`; accept persists through the engine's own
 *    `saveCurrentProjectConfig` (`TrustDialog.tsx:177,272`) via the P4-15
 *    `workspace.trust` verb. Decline closes the session's tab.
 *  - OAuth: the engine's real `OAuthStatus` flow (`ConsoleOAuthFlow.tsx:35-55`);
 *    the renderer drives navigation only, the engine owns the token
 *    (SECURITY-MINIMUM §4). Begin dispatches the existing P4-5 `account.login`
 *    verb; the re-linked/added account re-appears on the next `accounts.snapshot`
 *    (which unmounts the first-run surface). The live progress sub-protocol
 *    (`waiting_for_login → waiting_for_alias → success/error` transitions) is the
 *    coordinated operator step — see the P4-15 report §0.
 */

import type { ReactNode } from 'react'
import { toneClasses, type Tone } from './tone.js'

/* ── shared chrome ─────────────────────────────────────────────────────────── */

function PawLogo(): ReactNode {
  return (
    <span className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-[5px] bg-accent text-app-bg">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <ellipse cx="6.5" cy="5.5" rx="1.8" ry="2.5" opacity=".7" />
        <ellipse cx="11.5" cy="4" rx="1.8" ry="2.5" opacity=".7" />
        <ellipse cx="16.5" cy="5.5" rx="1.8" ry="2.5" opacity=".7" />
        <path d="M12 21.5c-4 0-7-2-7-5s3-5 7-5 7 2 7 5-3 5-7 5z" />
      </svg>
    </span>
  )
}

/** The uppercase status pill above each gate title (Trust required / Sign in / …). */
function Pill({ tone, label }: { tone: Tone; label: string }): ReactNode {
  const t = toneClasses(tone)
  return (
    <span
      className={`inline-block rounded px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.1em] ${t.softBg} ${t.softBorder} border ${t.text}`}
    >
      {label}
    </span>
  )
}

function PrimaryButton({
  children,
  onClick,
  autoFocus,
}: {
  children: ReactNode
  onClick: () => void
  autoFocus?: boolean
}): ReactNode {
  return (
    <button
      type="button"
      // eslint-disable-next-line jsx-a11y/no-autofocus
      autoFocus={autoFocus}
      onClick={onClick}
      className="rounded-lg bg-accent px-[18px] py-2.5 text-[12.5px] font-semibold text-app-bg"
    >
      {children}
    </button>
  )
}

function SecondaryButton({
  children,
  onClick,
}: {
  children: ReactNode
  onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-shell-seam px-4 py-2.5 text-[12.5px] text-text-muted transition-colors hover:bg-shell-hover"
    >
      {children}
    </button>
  )
}

/**
 * Full-bleed centered gate shell with the brand mark + a two-step (Trust →
 * Sign in) progress indicator. `absolute inset-0` so it overlays its positioned
 * parent — the trust gate mounts it inside one session's panel, the first-run
 * OAuth surface mounts it app-level.
 */
export function StartupShell({
  step,
  children,
}: {
  step: 'trust' | 'auth'
  children: ReactNode
}): ReactNode {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center overflow-auto bg-app-bg/95 p-6">
      <div className="absolute left-6 top-5 flex items-center gap-2.5">
        <PawLogo />
        <span className="text-[13px] font-semibold text-text-primary">cat code</span>
      </div>
      <div className="absolute right-6 top-5 flex items-center gap-2 text-[10px] text-text-subtle">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        <span>Trust</span>
        <span className="h-px w-4 bg-white/10" />
        <span
          className={`h-1.5 w-1.5 rounded-full ${step === 'auth' ? 'bg-accent' : 'bg-white/15'}`}
        />
        <span>Sign in</span>
      </div>
      <div className="w-full max-w-[500px] rounded-2xl border border-shell-seam bg-surface-panel px-9 pb-8 pt-9 shadow-[0_24px_80px_rgba(0,0,0,0.6)]">
        {children}
      </div>
    </div>
  )
}

/* ── trust gate (Q1: no read-only; decline = don't open) ───────────────────── */

export function WorkspaceTrustGate({
  cwd,
  onTrust,
  onDecline,
  errorMessage,
}: {
  cwd: string
  onTrust: () => void
  onDecline: () => void
  /** An `ok:false` trust-accept outcome (write didn't persist) — shown inline. */
  errorMessage?: string | null
}): ReactNode {
  return (
    <StartupShell step="trust">
      <div className="mb-5">
        <Pill tone="warn" label="Trust required" />
      </div>
      <h1 className="mb-2.5 text-[22px] font-semibold tracking-tight text-text-primary">
        Trust this workspace?
      </h1>
      <p className="mb-[18px] max-w-[460px] text-[13px] leading-relaxed text-text-muted">
        Cat Code is about to load files, plugins, and LSP from this folder. Until
        you trust the workspace, project commands stay gated.
      </p>
      <div className="mb-5 rounded-[9px] border border-shell-seam bg-app-bg px-3.5 py-3">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.08em] text-text-faint">
          Workspace
        </div>
        <code className="break-all font-mono text-[13px] text-text-primary">{cwd}</code>
      </div>
      {errorMessage ? (
        <div
          role="alert"
          className="mb-4 rounded-[9px] border border-tone-danger/25 bg-tone-danger/10 px-3.5 py-2.5 text-[12.5px] text-tone-danger"
        >
          {errorMessage}
        </div>
      ) : null}
      <div className="flex gap-2">
        <PrimaryButton autoFocus onClick={onTrust}>
          Trust workspace
        </PrimaryButton>
        <SecondaryButton onClick={onDecline}>Don&apos;t open</SecondaryButton>
      </div>
    </StartupShell>
  )
}

/* ── first-run Codex OAuth ─────────────────────────────────────────────────── */

/** The renderer-visible OAuth phase. Live sub-states are the operator step (§0). */
export type StartupOAuthPhase = 'ready' | 'waiting'

export function StartupOAuth({
  phase,
  onBegin,
  onCancel,
}: {
  phase: StartupOAuthPhase
  onBegin: () => void
  onCancel: () => void
}): ReactNode {
  if (phase === 'waiting') {
    return (
      <StartupShell step="auth">
        <h1 className="mb-2 text-[22px] font-semibold tracking-tight text-text-primary">
          Continue in your browser
        </h1>
        <p className="mb-5 max-w-[420px] text-[13px] leading-relaxed text-text-muted">
          Opening your browser to sign in — authorize the request, then return
          here. Your Codex account appears once the engine captures the callback.
        </p>
        <div className="mb-3.5 flex items-center gap-2.5 rounded-[9px] border border-shell-seam bg-app-bg px-3.5 py-3">
          <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-accent/20 border-t-accent" />
          <span className="text-[12.5px] text-text-muted">
            Waiting for browser authorization…
          </span>
        </div>
        <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
      </StartupShell>
    )
  }
  return (
    <StartupShell step="auth">
      <div className="mb-5">
        <Pill tone="info" label="Sign in" />
      </div>
      <h1 className="mb-2.5 text-[22px] font-semibold tracking-tight text-text-primary">
        Sign in with Codex
      </h1>
      <p className="mb-5 max-w-[460px] text-[13px] leading-relaxed text-text-muted">
        Cat Code routes turns through your ChatGPT / Codex subscription. We&apos;ll
        open your browser to authorize, then come back here. Add more accounts
        later in Settings → Accounts.
      </p>
      <div className="mb-5 flex items-center gap-3 rounded-[10px] border border-shell-seam bg-shell-hover/20 px-3.5 py-3">
        <span className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[7px] border border-tone-info/25 bg-tone-info/10 text-[13px] font-bold text-tone-info">
          C
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold text-text-primary">
            Codex · ChatGPT subscription
          </span>
          <span className="text-[11.5px] text-text-subtle">
            OAuth via auth.openai.com · account pool, capped/dead detection
          </span>
        </span>
      </div>
      <PrimaryButton autoFocus onClick={onBegin}>
        Open browser to sign in
      </PrimaryButton>
    </StartupShell>
  )
}
