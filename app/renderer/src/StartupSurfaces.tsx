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
 *    through `StartupOAuth` like any other sign-in.
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

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { OAuthSubmitStatus } from './appModel.js'
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
 * Centered gate shell. `absolute inset-0` so it overlays its positioned parent.
 * `page` is the startup sequence (trust gate, first-run sign-in): brand mark and
 * the Trust → Sign in steps on an opaque ground. `modal` is a sign-in started
 * from inside a working app (adding or restoring an account): the same card over
 * a scrim, without startup chrome, because there is no sequence to show.
 */
export function StartupShell({
  step,
  children,
  onEscape,
  presentation = 'page',
}: {
  step: 'trust' | 'auth'
  children: ReactNode
  onEscape?: () => void
  presentation?: 'page' | 'modal'
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
      className={`absolute inset-0 z-40 flex items-center justify-center overflow-auto p-6 ${
        presentation === 'modal'
          ? 'animate-scrim-in bg-scrim backdrop-blur-sm'
          : 'bg-app-bg/95'
      }`}
    >
      {presentation === 'page' ? (
        <>
          <div className="absolute left-6 top-5 flex items-center gap-2.5">
            <PawLogo />
            <span className="text-[13px] font-semibold text-text-primary">cat code</span>
          </div>
          <div className="absolute right-6 top-5 flex items-center gap-2 text-[10px] text-text-subtle">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            <span>Trust</span>
            <span className="h-px w-4 bg-shell-seam" />
            <span
              className={`h-1.5 w-1.5 rounded-full ${step === 'auth' ? 'bg-accent' : 'bg-text-ghost'}`}
            />
            <span>Sign in</span>
          </div>
        </>
      ) : null}
      <div
        className={`w-full rounded-2xl border border-shell-seam shadow-[var(--elev-modal)] ${
          step === 'auth'
            ? 'max-w-[440px] bg-surface-raised px-8 pb-7 pt-8'
            : 'max-w-[500px] bg-surface-panel px-9 pb-8 pt-9'
        }`}
      >
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


/* ── sign-in (Claude / ChatGPT subscription OAuth) ─────────────────────────── */

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

type OAuthProvider = 'anthropic' | 'openai'

const IDLE_SUBMIT: OAuthSubmitStatus = { state: 'idle' }

/**
 * Per-provider wording. The engines hand back different urls, which decides
 * where a pasted value comes from: Codex gives the real authorize url, whose
 * redirect to `localhost:1455` normally lands on its own and carries the code
 * in its address (`runCodexOAuthFlow` accepts that pasted address); Anthropic
 * gives its manual-flow url, whose page always ends on a `code#state` value to
 * paste (`OAuthService.startOAuthFlow`). So a copied Claude link always needs
 * the paste field, and a copied ChatGPT link needs it only when that page fails.
 */
const PROVIDER_COPY: Record<
  OAuthProvider,
  {
    name: string
    detail: string
    initial: string
    pastePlaceholder: string
  }
> = {
  anthropic: {
    name: 'Claude',
    detail: 'Claude subscription',
    initial: 'C',
    pastePlaceholder: 'Paste the code from the sign-in page',
  },
  openai: {
    name: 'ChatGPT',
    detail: 'ChatGPT subscription for Codex models',
    initial: 'G',
    pastePlaceholder: 'Paste the page address',
  },
}

function OAuthSpinner(): ReactNode {
  return (
    <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-accent/20 border-t-accent" />
  )
}

function ProviderMark({ provider }: { provider: OAuthProvider }): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border text-[15px] font-bold ${
        provider === 'anthropic'
          ? 'border-accent/25 bg-accent/10 text-accent'
          : 'border-tone-info/25 bg-tone-info/10 text-tone-info'
      }`}
    >
      {PROVIDER_COPY[provider].initial}
    </span>
  )
}

/** A round status badge heading the outcome steps (alias, success, error). */
function OutcomeMark({ tone }: { tone: 'good' | 'danger' }): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-9 w-9 items-center justify-center rounded-full ${
        tone === 'good'
          ? 'bg-tone-good/12 text-tone-good'
          : 'bg-tone-danger/12 text-tone-danger'
      }`}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {tone === 'good' ? (
          <polyline points="20 6 9 17 4 12" />
        ) : (
          <>
            <line x1="12" y1="7" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12" y2="17" />
          </>
        )}
      </svg>
    </span>
  )
}

function OAuthHeading({
  mark,
  title,
  children,
}: {
  mark: ReactNode
  title: string
  children?: ReactNode
}): ReactNode {
  return (
    <div className="mb-6">
      <div className="mb-4">{mark}</div>
      <h1 className="text-[20px] font-semibold tracking-tight text-text-primary">
        {title}
      </h1>
      {children ? (
        <p className="mt-2 text-[13px] leading-relaxed text-text-muted">{children}</p>
      ) : null}
    </div>
  )
}

function OAuthFooter({ children }: { children: ReactNode }): ReactNode {
  return <div className="mt-6 flex justify-end gap-2">{children}</div>
}

const INPUT_CLASS =
  'min-w-0 flex-1 rounded-lg border bg-app-bg px-3 py-2 text-[13px] text-text-primary outline-none placeholder:text-text-faint focus:border-accent/50'

function CopyIcon(): ReactNode {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </svg>
  )
}

function CheckIcon(): ReactNode {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

/**
 * The link actions. Copy leads: the usual route is pasting the link into the
 * browser profile signed in to the right account, not the default browser the
 * engine opened. If the clipboard write fails, the link appears as selectable
 * text so it can still be copied by hand.
 */
function SignInLinkActions({ url }: { url: string | null }): ReactNode {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (copyState !== 'copied') return
    const timer = window.setTimeout(() => setCopyState('idle'), 2000)
    return () => window.clearTimeout(timer)
  }, [copyState])
  return (
    <div>
      <div className="flex gap-2">
        <button
          // Remount when the link arrives: the button mounts disabled, so its
          // first autofocus has nothing to land on.
          key={url === null ? 'pending' : 'ready'}
          type="button"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          disabled={url === null}
          onClick={() => {
            if (url === null) return
            void navigator.clipboard
              .writeText(url)
              .then(() => setCopyState('copied'))
              .catch(() => setCopyState('failed'))
          }}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-[13px] font-semibold text-on-fill disabled:opacity-50"
        >
          {copyState === 'copied' ? <CheckIcon /> : <CopyIcon />}
          {url === null
            ? 'Preparing link'
            : copyState === 'copied'
              ? 'Link copied'
              : 'Copy sign-in link'}
        </button>
        {url === null ? null : (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center rounded-lg border border-shell-seam px-4 py-2.5 text-[13px] text-text-muted transition-colors hover:bg-shell-hover hover:text-text-primary"
          >
            Open in browser
          </a>
        )}
      </div>
      {copyState === 'failed' && url !== null ? (
        <div className="mt-2">
          <p role="alert" className="mb-1.5 text-[12px] text-tone-danger">
            Could not copy.
          </p>
          <input
            readOnly
            value={url}
            aria-label="Sign-in link"
            onFocus={e => e.currentTarget.select()}
            className={`${INPUT_CLASS} w-full border-shell-seam font-mono text-[11.5px]`}
          />
        </div>
      ) : null}
    </div>
  )
}

/**
 * The paste route: whatever the browser ends on goes out on the
 * `account.oauthPasteCode` verb (the engine exchanges it; the renderer never
 * holds a token). A refused value stays in the field with the engine's reason.
 */
function PasteCodeForm({
  provider,
  codeStatus,
  onPasteCode,
}: {
  provider: OAuthProvider
  codeStatus: OAuthSubmitStatus
  onPasteCode: (code: string) => void
}): ReactNode {
  const copy = PROVIDER_COPY[provider]
  const [code, setCode] = useState('')
  const pending = codeStatus.state === 'pending'
  const error = codeStatus.state === 'rejected' ? codeStatus.message : null
  return (
    <>
      <form
        className="flex gap-2"
        onSubmit={e => {
          e.preventDefault()
          const trimmed = code.trim()
          if (!trimmed || pending) return
          onPasteCode(trimmed)
        }}
      >
        <input
          value={code}
          onChange={e => setCode(e.target.value)}
          aria-label={copy.pastePlaceholder}
          aria-invalid={error !== null}
          placeholder={copy.pastePlaceholder}
          spellCheck={false}
          autoComplete="off"
          className={`${INPUT_CLASS} ${error ? 'border-tone-danger/50' : 'border-shell-seam'}`}
        />
        <button
          type="submit"
          disabled={pending || code.trim() === ''}
          className="rounded-lg border border-shell-seam px-3.5 py-2 text-[12.5px] text-text-primary transition-colors hover:bg-shell-hover disabled:opacity-50"
        >
          {pending ? 'Checking…' : 'Continue'}
        </button>
      </form>
      {error ? (
        <p role="alert" className="mt-2 break-words text-[12px] text-tone-danger">
          {error}
        </p>
      ) : null}
    </>
  )
}

function OAuthWaiting({
  provider,
  url,
  codeStatus,
  onPasteCode,
  onCancel,
}: {
  provider: OAuthProvider
  url: string | null
  codeStatus: OAuthSubmitStatus
  onPasteCode: (code: string) => void
  onCancel: () => void
}): ReactNode {
  const accepted = codeStatus.state === 'accepted'
  const name = PROVIDER_COPY[provider].name
  return (
    <>
      <OAuthHeading mark={<ProviderMark provider={provider} />} title={`Sign in with ${name}`} />
      {accepted ? null : <SignInLinkActions url={url} />}
      <div
        role="status"
        className="mt-4 flex items-center gap-2.5 text-[12.5px] text-text-subtle"
      >
        <OAuthSpinner />
        {url === null
          ? 'Preparing sign-in'
          : accepted
            ? 'Finishing sign-in'
            : 'Waiting for approval'}
      </div>
      {url !== null && !accepted ? (
        provider === 'anthropic' ? (
          <div className="mt-5 border-t border-shell-seam pt-4">
            <PasteCodeForm
              provider={provider}
              codeStatus={codeStatus}
              onPasteCode={onPasteCode}
            />
          </div>
        ) : (
          <details className="group mt-5 border-t border-shell-seam pt-4">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12.5px] text-text-muted transition-colors hover:text-text-primary [&::-webkit-details-marker]:hidden">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="transition-transform group-open:rotate-90"
              >
                <polyline points="9 6 15 12 9 18" />
              </svg>
              Approved, but the page didn&apos;t load?
            </summary>
            <div className="mt-3 pl-[18px]">
              <PasteCodeForm
                provider={provider}
                codeStatus={codeStatus}
                onPasteCode={onPasteCode}
              />
            </div>
          </details>
        )
      ) : null}
      <OAuthFooter>
        <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
      </OAuthFooter>
    </>
  )
}

/**
 * The Codex `waiting_for_alias` naming step (`ConsoleOAuthFlow.tsx`
 * `getCodexAliasPrompt`). The tokens are already captured, so there is no
 * cancel here: Skip saves the account unnamed, which is what the TUI's empty
 * Enter does. A refused alias keeps the step open with the engine's reason.
 */
function OAuthAlias({
  aliasStatus,
  onSubmitAlias,
}: {
  aliasStatus: OAuthSubmitStatus
  onSubmitAlias: (alias: string) => void
}): ReactNode {
  const [alias, setAlias] = useState('')
  const busy = aliasStatus.state === 'pending' || aliasStatus.state === 'accepted'
  const error = aliasStatus.state === 'rejected' ? aliasStatus.message : null
  return (
    <>
      <OAuthHeading mark={<OutcomeMark tone="good" />} title="Name this account" />
      <form
        id="oauth-alias"
        onSubmit={e => {
          e.preventDefault()
          if (!busy) onSubmitAlias(alias)
        }}
      >
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={alias}
          onChange={e => setAlias(e.target.value)}
          aria-label="Account name"
          aria-invalid={error !== null}
          placeholder="work"
          spellCheck={false}
          autoComplete="off"
          className={`${INPUT_CLASS} w-full ${error ? 'border-tone-danger/50' : 'border-shell-seam'}`}
        />
        {error ? (
          <p role="alert" className="mt-2 break-words text-[12px] text-tone-danger">
            {error}
          </p>
        ) : null}
      </form>
      <OAuthFooter>
        <button
          type="button"
          disabled={busy}
          onClick={() => onSubmitAlias('')}
          className="rounded-lg border border-shell-seam px-4 py-2.5 text-[12.5px] text-text-muted transition-colors hover:bg-shell-hover disabled:opacity-50"
        >
          Skip
        </button>
        <button
          type="submit"
          form="oauth-alias"
          disabled={busy || alias.trim() === ''}
          className="rounded-lg bg-accent px-[18px] py-2.5 text-[12.5px] font-semibold text-on-fill disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </OAuthFooter>
    </>
  )
}

function ProviderChoice({
  provider,
  autoFocus,
  onBegin,
}: {
  provider: OAuthProvider
  autoFocus?: boolean
  onBegin: (provider: OAuthProvider) => void
}): ReactNode {
  const copy = PROVIDER_COPY[provider]
  return (
    <button
      type="button"
      // eslint-disable-next-line jsx-a11y/no-autofocus
      autoFocus={autoFocus}
      onClick={() => onBegin(provider)}
      className="group flex w-full items-center gap-3 rounded-[11px] border border-shell-seam bg-app-bg px-3.5 py-3 text-left transition-colors hover:border-accent/40 hover:bg-shell-hover focus-visible:border-accent/60 focus-visible:outline-none"
    >
      <ProviderMark provider={provider} />
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-semibold text-text-primary">
          {copy.name}
        </span>
        <span className="block text-[12px] text-text-subtle">{copy.detail}</span>
      </span>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="shrink-0 text-text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-text-muted"
      >
        <polyline points="9 6 15 12 9 18" />
      </svg>
    </button>
  )
}

export function StartupOAuth({
  view,
  provider,
  presentation = 'page',
  codeStatus = IDLE_SUBMIT,
  aliasStatus = IDLE_SUBMIT,
  onBegin,
  onCancel,
  onPasteCode,
  onSubmitAlias,
  onRetry,
}: {
  view: StartupOAuthView
  provider: OAuthProvider
  /** `page` for first-run, `modal` for a sign-in started from inside the app. */
  presentation?: 'page' | 'modal'
  /** Outcome of the last pasted code (`account.oauthPasteCode`). */
  codeStatus?: OAuthSubmitStatus
  /** Outcome of the last alias submission (`account.oauthAlias`). */
  aliasStatus?: OAuthSubmitStatus
  onBegin: (provider: OAuthProvider) => void
  onCancel: () => void
  onPasteCode: (code: string) => void
  onSubmitAlias: (alias: string) => void
  onRetry: () => void
}): ReactNode {
  const shell = (children: ReactNode, onEscape: (() => void) | undefined) => (
    <StartupShell step="auth" presentation={presentation} onEscape={onEscape}>
      {children}
    </StartupShell>
  )
  switch (view.phase) {
    case 'ready':
      return shell(
        <>
          <OAuthHeading mark={<PawLogo />} title="Sign in to get started" />
          <div className="flex flex-col gap-2">
            <ProviderChoice provider="anthropic" autoFocus onBegin={onBegin} />
            <ProviderChoice provider="openai" onBegin={onBegin} />
          </div>
        </>,
        onCancel,
      )

    case 'waiting':
      return shell(
        <OAuthWaiting
          provider={provider}
          url={view.url}
          codeStatus={codeStatus}
          onPasteCode={onPasteCode}
          onCancel={onCancel}
        />,
        onCancel,
      )

    case 'alias':
      return shell(
        <OAuthAlias aliasStatus={aliasStatus} onSubmitAlias={onSubmitAlias} />,
        undefined,
      )

    case 'success':
      return shell(
        <div role="status">
          <OAuthHeading mark={<OutcomeMark tone="good" />} title="Signed in" />
        </div>,
        undefined,
      )

    case 'error':
      return shell(
        <>
          <OAuthHeading mark={<OutcomeMark tone="danger" />} title="Sign-in didn't finish" />
          <p
            role="alert"
            className="-mt-3 break-words rounded-[10px] bg-tone-danger/[0.07] px-3.5 py-3 text-[12.5px] leading-relaxed text-tone-danger"
          >
            {view.message}
          </p>
          <OAuthFooter>
            <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
            <PrimaryButton autoFocus onClick={onRetry}>
              Try again
            </PrimaryButton>
          </OAuthFooter>
        </>,
        onCancel,
      )

    default: {
      const exhaustive: never = view
      return exhaustive
    }
  }
}
