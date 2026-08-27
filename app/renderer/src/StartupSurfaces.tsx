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
 *  - the blocking `ReauthGate` modal — Q2: token death never walls the window.
 *    The interim non-blocking reauth banner/wall was itself REMOVED entirely
 *    (#12, 2026-07-20 — `docs/migration/decisions/STARTUP-GATES.md`); the pool
 *    error now surfaces inline at request time. P4-34 then removed the floating
 *    `ReauthOAuthProgress` card that had survived it: with no banner left to
 *    launch the flow, its `'reauth'` context could only be set by the card's own
 *    Retry button, so the card could never appear. Re-linking an account runs
 *    through `StartupOAuth` and the add-account dialog like any other sign-in.
 *
 * Real backing:
 *  - Trust: `isPathTrusted(cwd)` / `hasTrustDialogAccepted`
 *    (`src/utils/config.ts:790,111`), surfaced per session by the P4-14
 *    `workspace-trust.snapshot`; accept persists through the engine's own
 *    `saveCurrentProjectConfig` (`TrustDialog.tsx:177,272`) via the P4-15
 *    `workspace.trust` verb. Decline closes the session's tab. The gate names the
 *    snapshot's `trustRoot` — the git root the write is actually keyed at
 *    (`config.ts:1626,1675`), which is wider than the session cwd — so approving
 *    is informed; see the `trustRoot` doc-comment in `protocol.ts`.
 *  - OAuth: the engine's real `OAuthStatus` flow (`ConsoleOAuthFlow.tsx:35-55`);
 *    the renderer drives navigation only, the engine owns the token
 *    (SECURITY-MINIMUM §4). Begin dispatches the existing P4-5 `account.login`
 *    verb; the re-linked/added account re-appears on the next `accounts.snapshot`
 *    (which unmounts the first-run surface). The live progress sub-protocol
 *    (`waiting_for_login → waiting_for_alias → success/error` transitions) is the
 *    coordinated operator step — see the P4-15 report §0.
 */

import { useRef, useState, type ReactNode } from 'react'
import { useModalFocus } from './overlayFocus.js'
import { toneClasses, type Tone } from './tone.js'

/* ── shared chrome ─────────────────────────────────────────────────────────── */

function PawLogo(): ReactNode {
  return (
    <span className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-[5px] bg-accent text-on-fill">
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
      className="rounded-lg bg-accent px-[18px] py-2.5 text-[12.5px] font-semibold text-on-fill"
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
  onEscape,
}: {
  step: 'trust' | 'auth'
  children: ReactNode
  onEscape?: () => void
}): ReactNode {
  const shellRef = useRef<HTMLDivElement>(null)
  useModalFocus({
    open: true,
    containerRef: shellRef,
    onEscape: onEscape ?? (() => {}),
    escapeEnabled: onEscape !== undefined,
  })
  return (
    <div
      ref={shellRef}
      role="dialog"
      aria-modal="true"
      aria-label={step === 'trust' ? 'Workspace trust' : 'Sign in'}
      tabIndex={-1}
      className="absolute inset-0 z-40 flex items-center justify-center overflow-auto bg-app-bg/95 p-6"
    >
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
      <div className="w-full max-w-[500px] rounded-2xl border border-shell-seam bg-surface-panel px-9 pb-8 pt-9 shadow-[var(--elev-modal)]">
        {children}
      </div>
    </div>
  )
}

/* ── trust gate (Q1: no read-only; decline = don't open) ───────────────────── */

export function WorkspaceTrustGate({
  cwd,
  trustRoot,
  onTrust,
  onDecline,
  errorMessage,
}: {
  cwd: string
  /**
   * Where accepting actually persists trust — the engine's own
   * `getProjectPathForConfig()`, delivered on `workspace-trust.snapshot`
   * (`protocol.ts` `WorkspaceTrustSnapshot.trustRoot`). Null = the engine could
   * not resolve it. HC1: rendered verbatim; the renderer never derives a path.
   */
  trustRoot: string | null
  onTrust: () => void
  onDecline: () => void
  /** An `ok:false` trust-accept outcome (write didn't persist) — shown inline. */
  errorMessage?: string | null
}): ReactNode {
  // Comparing two ENGINE-supplied strings to pick which copy is truthful — not
  // path derivation (HC1). Trust is keyed at the git root, so when the root is an
  // ancestor of the session folder, approving reaches sibling projects too; that
  // widening must be stated, never implied by showing only the session folder.
  const widerThanCwd = trustRoot !== null && trustRoot !== cwd
  return (
    <StartupShell step="trust" onEscape={onDecline}>
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
      <p className="mb-[18px] max-w-[460px] break-words text-[13px] leading-relaxed text-text-muted">
        {trustRoot === null
          ? 'Cat Code could not resolve where this trust would be saved. Trust is stored per git repository, so approving may cover more than this folder.'
          : widerThanCwd
            ? `Trust is stored per git repository. Approving saves trust for ${trustRoot} and covers every folder under it, including sibling projects, both here and in the terminal CLI, which share this setting.`
            : 'Approving trusts this folder and everything under it, both here and in the terminal CLI, which share this setting.'}
      </p>
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

/**
 * The renderer-visible OAuth sub-states — a projection of the engine's real
 * `OAuthStatus` flow delivered on the `oauth.login.progress` back-channel
 * (`accountsDomain.ts`). `waiting` covers `starting`+`waiting_for_login` (`url`
 * is null until the engine mints it); the live run is the operator's step.
 */
export type StartupOAuthView =
  | { phase: 'ready' }
  | { phase: 'waiting'; url: string | null }
  | { phase: 'alias' }
  | { phase: 'success' }
  | { phase: 'error'; message: string }

/** Pink spinner shared by every OAuth waiting affordance (auth + reauth). */
function OAuthSpinner(): ReactNode {
  return (
    <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-accent/20 border-t-accent" />
  )
}

/** Green check shared by the success affordances (matches the prototype tick). */
function OAuthCheck(): ReactNode {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-tone-good"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

/**
 * The paste-code fallback — the engine-minted authorize `url` plus an input that
 * dispatches the pasted code (the `account.oauthPasteCode` verb; the engine
 * exchanges it, the renderer never retains a token). Rendered only once the url
 * has arrived (`waiting_for_login`), matching the prototype's "Visit … and paste
 * the code you get back" affordance (`Startup.jsx:216`, `ConsoleOAuthFlow.tsx:672`).
 */
function PasteCodeFallback({
  url,
  onPasteCode,
}: {
  url: string
  onPasteCode: (code: string) => void
}): ReactNode {
  const [code, setCode] = useState('')
  return (
    <div className="mb-3.5">
      <div className="mb-2 text-[11px] leading-relaxed text-text-faint">
        Browser didn&apos;t open? Visit{' '}
        <code className="break-all font-mono text-[10.5px] text-text-subtle">{url}</code>{' '}
        and paste the code you get back.
      </div>
      <form
        className="flex gap-2"
        onSubmit={e => {
          e.preventDefault()
          const trimmed = code.trim()
          if (!trimmed) return
          onPasteCode(trimmed)
          setCode('')
        }}
      >
        <input
          value={code}
          onChange={e => setCode(e.target.value)}
          placeholder="Paste authorization code"
          className="min-w-0 flex-1 rounded-lg border border-shell-seam bg-app-bg px-3 py-2 font-mono text-[12px] text-text-primary outline-none focus:border-accent/40"
        />
        <button
          type="submit"
          className="rounded-lg border border-shell-seam px-3 py-2 text-[12px] text-text-muted transition-colors hover:bg-shell-hover"
        >
          Submit
        </button>
      </form>
    </div>
  )
}

/**
 * The waiting affordance body (spinner + status label + paste-code fallback),
 * shared by the first-run surface and the reauth progress card so both read
 * identically (`Startup.jsx:198-221` auth / `:427-430` reauth).
 */
function OAuthWaitingBody({
  url,
  onPasteCode,
}: {
  url: string | null
  onPasteCode: (code: string) => void
}): ReactNode {
  return (
    <>
      <div className="mb-3.5 flex items-center gap-2.5 rounded-[9px] border border-shell-seam bg-app-bg px-3.5 py-3">
        <OAuthSpinner />
        <span className="text-[12.5px] text-text-muted">
          Waiting for browser authorization…
        </span>
      </div>
      {url ? <PasteCodeFallback url={url} onPasteCode={onPasteCode} /> : null}
    </>
  )
}

/** The Codex `waiting_for_alias` naming step (`Startup.jsx:129`, `ConsoleOAuthFlow.tsx:48`). */
function AliasForm({
  onSubmitAlias,
  onCancel,
}: {
  onSubmitAlias: (alias: string) => void
  onCancel: () => void
}): ReactNode {
  const [alias, setAlias] = useState('')
  return (
    <StartupShell step="auth" onEscape={onCancel}>
      <div className="mb-5">
        <Pill tone="good" label="Authorized" />
      </div>
      <h1 className="mb-2.5 text-[22px] font-semibold tracking-tight text-text-primary">
        Name this account
      </h1>
      <p className="mb-[18px] max-w-[420px] text-[13px] leading-relaxed text-text-muted">
        Optional alias to tell this Codex account apart in the pool. Leave blank
        to use the account email.
      </p>
      <form
        onSubmit={e => {
          e.preventDefault()
          onSubmitAlias(alias)
        }}
      >
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={alias}
          onChange={e => setAlias(e.target.value)}
          placeholder="work · personal · team-a"
          className="mb-3.5 w-full rounded-[9px] border border-shell-seam bg-app-bg px-3.5 py-2.5 font-mono text-[13px] text-text-primary outline-none focus:border-accent/40"
        />
        <button
          type="submit"
          className="rounded-lg bg-accent px-[18px] py-2.5 text-[12.5px] font-semibold text-on-fill"
        >
          Continue <span className="ml-1.5 text-[11px] opacity-60">↵</span>
        </button>
      </form>
    </StartupShell>
  )
}

export function StartupOAuth({
  view,
  provider,
  onBegin,
  onCancel,
  onPasteCode,
  onSubmitAlias,
  onRetry,
}: {
  view: StartupOAuthView
  provider: 'anthropic' | 'openai'
  onBegin: (provider: 'anthropic' | 'openai') => void
  onCancel: () => void
  onPasteCode: (code: string) => void
  onSubmitAlias: (alias: string) => void
  onRetry: () => void
}): ReactNode {
  switch (view.phase) {
    case 'waiting':
      return (
        <StartupShell step="auth" onEscape={onCancel}>
          <h1 className="mb-2 text-[22px] font-semibold tracking-tight text-text-primary">
            Continue in your browser
          </h1>
          <p className="mb-5 max-w-[420px] text-[13px] leading-relaxed text-text-muted">
            Opening browser to sign in… authorize the request, then return here.
            Your {provider === 'anthropic' ? 'Anthropic' : 'Codex'} account appears
            here after you finish in the browser.
          </p>
          <OAuthWaitingBody url={view.url} onPasteCode={onPasteCode} />
          <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
        </StartupShell>
      )

    case 'success':
      return (
        <StartupShell step="auth" onEscape={onCancel}>
          <h1 className="mb-2 text-[22px] font-semibold tracking-tight text-text-primary">
            Signed in
          </h1>
          <p className="mb-5 max-w-[420px] text-[13px] leading-relaxed text-text-muted">
            Account linked. Setting up your workspace…
          </p>
          <div className="flex items-center gap-2.5 rounded-[9px] border border-shell-seam bg-app-bg px-3.5 py-3">
            <OAuthCheck />
            <span className="text-[12.5px] text-text-muted">Authorized</span>
          </div>
        </StartupShell>
      )

    case 'alias':
      return <AliasForm onSubmitAlias={onSubmitAlias} onCancel={onCancel} />

    case 'error':
      return (
        <StartupShell step="auth" onEscape={onCancel}>
          <div className="mb-5">
            <Pill tone="danger" label="OAuth error" />
          </div>
          <h1 className="mb-2.5 text-[22px] font-semibold tracking-tight text-text-primary">
            Sign-in didn&apos;t complete
          </h1>
          <p className="mb-4 max-w-[420px] text-[13px] leading-relaxed text-text-muted">
            The browser flow was cancelled or timed out before authorization came
            back.
          </p>
          <div className="mb-[22px] rounded-lg border border-tone-danger/20 bg-tone-danger/[0.06] px-3 py-2.5">
            <code className="break-all font-mono text-[12px] text-tone-danger">
              OAuth error: {view.message}
            </code>
          </div>
          <div className="flex gap-2">
            <PrimaryButton autoFocus onClick={onRetry}>
              Retry <span className="ml-1.5 text-[11px] opacity-60">↵</span>
            </PrimaryButton>
            <SecondaryButton onClick={onCancel}>Back</SecondaryButton>
          </div>
        </StartupShell>
      )

    case 'ready':
      return (
        <StartupShell step="auth" onEscape={onCancel}>
          <div className="mb-5">
            <Pill tone="info" label="Sign in" />
          </div>
          <h1 className="mb-2.5 text-[22px] font-semibold tracking-tight text-text-primary">
            Choose your provider
          </h1>
          <p className="mb-5 max-w-[460px] text-[13px] leading-relaxed text-text-muted">
            Link an Anthropic Claude or ChatGPT / Codex subscription. You can switch
            models later without signing out.
          </p>
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-3 rounded-[10px] border border-shell-seam bg-shell-hover/20 px-3.5 py-3">
              <span className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[7px] border border-accent/25 bg-accent/10 text-[13px] font-bold text-accent">
                A
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-semibold text-text-primary">
                  Anthropic · Claude subscription
                </span>
                <span className="text-[11.5px] text-text-subtle">
                  Claude Opus, Sonnet, and Haiku via Anthropic OAuth
                </span>
              </span>
              <PrimaryButton autoFocus onClick={() => onBegin('anthropic')}>
                Open browser to sign in
              </PrimaryButton>
            </div>
            <div className="flex items-center gap-3 rounded-[10px] border border-shell-seam bg-shell-hover/20 px-3.5 py-3">
              <span className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[7px] border border-tone-info/25 bg-tone-info/10 text-[13px] font-bold text-tone-info">
                C
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-semibold text-text-primary">
                  Codex · ChatGPT subscription
                </span>
                <span className="text-[11.5px] text-text-subtle">
                  OpenAI models via ChatGPT / Codex OAuth
                </span>
              </span>
              <PrimaryButton onClick={() => onBegin('openai')}>
                Open browser to sign in
              </PrimaryButton>
            </div>
          </div>
        </StartupShell>
      )

    default: {
      const exhaustive: never = view
      return exhaustive
    }
  }
}
