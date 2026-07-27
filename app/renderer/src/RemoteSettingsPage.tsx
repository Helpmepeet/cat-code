/**
 * RemoteSettings panel (P4-13, D3 cut scope) — rebuilt from the prototype's
 * `RemoteSettings.jsx` (design reference only, zero ported code, no inline
 * `style={{}}`) at the OPERATOR-RULED cut scope
 * (`decisions/PAIRED-DEVICES.md` §4): bridge toggle/status + read-only
 * command-filter truth + a direct-connect form. NO paired-device roster/wizard
 * — `decisions/PAIRED-DEVICES.md` §3 (no device identity/authz model exists
 * upstream to adapt; a roster there is prototype invention).
 *
 * Writes go ONLY through the `onVerb` prop (the HC3 `remoteSettingsVerb`
 * channel), mirroring `AccountsPage.tsx`'s correlate-by-requestId discipline:
 * a control mints a `requestId`, dispatches the verb, and toasts only when the
 * matching `remoteSettings.result` (`lastResult`) arrives — never an
 * optimistic guess.
 */

import { useEffect, useRef, useState } from 'react'
import type {
  RemoteSettingsResultFrame,
  RemoteSettingsSnapshot,
  RemoteVerbMessage,
} from '../../shared/protocol.js'
import { Chip } from './Chip.js'
import { PaneSection } from './SettingsField.js'
import { useToast } from './toastContext.js'

const newRequestId = (): string => crypto.randomUUID()

export function RemoteSettingsPage({
  embedded = false,
  snapshot,
  lastResult,
  onVerb,
}: {
  embedded?: boolean
  snapshot: RemoteSettingsSnapshot | null
  lastResult: RemoteSettingsResultFrame | null
  onVerb: (verb: RemoteVerbMessage) => void
}) {
  const body = !snapshot ? (
    <WaitingState />
  ) : (
    <>
      <BridgePanel bridge={snapshot.bridge} lastResult={lastResult} onVerb={onVerb} />
      <CommandFilterSection filter={snapshot.commandFilter} />
      <DirectConnectSection lastResult={lastResult} onVerb={onVerb} />
    </>
  )

  if (embedded) return body

  return (
    <main className="flex min-h-0 flex-1 overflow-auto px-8 py-7">
      <div className="mx-auto w-full max-w-[660px]">
        <RemoteSettingsHeader />
        {body}
      </div>
    </main>
  )
}

function RemoteSettingsHeader() {
  return (
    <header className="mb-5">
      <h1 className="text-lg font-semibold tracking-tight text-text-primary">
        Remote
      </h1>
      <p className="mt-1 text-[13px] text-text-subtle">
        Remote Control bridge and connect transports.
      </p>
    </header>
  )
}

function WaitingState() {
  return (
    <p className="text-[12.5px] text-text-subtle">
      Waiting for the engine's remote settings snapshot…
    </p>
  )
}

/* ── control role label — survives ONLY as a session-level label ───────────
 * (`decisions/PAIRED-DEVICES.md` §3/§6): no per-device backing, so it is never
 * a per-row control here — just a label on a live remote connection. Only the
 * `control` role is ever instantiated (a successful direct-connect); the
 * prototype's `viewer` variant has no backing state and is cut (YAGNI). */
export function RemoteRolePill() {
  return (
    <Chip
      icon={
        <svg
          aria-hidden="true"
          className="h-2.5 w-2.5"
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <path d="M5 3l14 9-14 9V3z" />
        </svg>
      }
      label="Control"
      title="Can drive this session (send input, approve permissions)"
      tone="accent"
    />
  )
}

/* ── bridge status + toggle ──────────────────────────────────────────────── */

function BridgePanel({
  bridge,
  lastResult,
  onVerb,
}: {
  bridge: RemoteSettingsSnapshot['bridge']
  lastResult: RemoteSettingsResultFrame | null
  onVerb: (verb: RemoteVerbMessage) => void
}) {
  const toast = useToast()
  const [toggling, setToggling] = useState(false)
  const pendingRequestId = useRef<string | null>(null)

  useEffect(() => {
    if (
      !lastResult ||
      lastResult.verb !== 'remoteSettings.bridgeToggle' ||
      lastResult.requestId !== pendingRequestId.current
    ) {
      return
    }
    pendingRequestId.current = null
    setToggling(false)
    toast(lastResult.message, { tone: lastResult.ok ? 'success' : 'danger' })
  }, [lastResult, toast])

  const toggle = () => {
    const requestId = newRequestId()
    pendingRequestId.current = requestId
    setToggling(true)
    onVerb({ type: 'remoteSettings.bridgeToggle', requestId, enable: !bridge.enabled })
  }

  return (
    <div
      className={`mb-6 rounded-xl border px-[18px] py-[18px] ${
        bridge.enabled
          ? 'border-accent/20 bg-accent/5'
          : 'border-shell-seam bg-shell-hover/40'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-1.5 flex items-center gap-2.5">
            <span className="text-[14px] font-semibold text-text-primary">
              Remote Control bridge
            </span>
            {/* Honesty (review fix 2026-07-09): the desktop path only SETS the
             * `replBridgeEnabled` flag — no worker actually serves the session
             * (the `initReplBridge` loop is Ink-REPL-only). "Enabled" ≠
             * "Publishing"; the flag is on, but nothing is being served yet. */}
            <Chip label={bridge.enabled ? 'Enabled' : 'Offline'} tone={bridge.enabled ? 'good' : 'default'} />
          </div>
          <p className="max-w-[420px] text-[12px] leading-relaxed text-text-subtle">
            Sets the Remote Control flag for this session (the same flag{' '}
            <code className="font-mono text-text-muted">/remote-control</code>{' '}
            sets). A live web or mobile connection is not served from the
            desktop app yet.
          </p>
          {bridge.enabled ? (
            <div className="mt-3 flex flex-wrap items-center gap-3 text-[11.5px] text-text-subtle">
              <span>
                <span className="font-mono text-text-muted">{bridge.transport}</span> transport
              </span>
            </div>
          ) : null}
          {bridge.error ? (
            <p className="mt-2 text-[11.5px] text-tone-danger">{bridge.error}</p>
          ) : null}
        </div>
        <button
          className={`shrink-0 rounded-lg border px-3.5 py-2 text-[12.5px] font-semibold transition-colors disabled:opacity-50 ${
            bridge.enabled
              ? 'border-tone-danger/40 bg-tone-danger/10 text-tone-danger'
              : 'border-accent/40 bg-accent/12 text-accent'
          }`}
          disabled={toggling}
          onClick={toggle}
          type="button"
        >
          {bridge.enabled ? 'Stop bridge' : 'Start bridge'}
        </button>
      </div>
    </div>
  )
}

/* ── command filter (read-only truth) ────────────────────────────────────── */

function CommandFilterSection({
  filter,
}: {
  filter: RemoteSettingsSnapshot['commandFilter']
}) {
  return (
    <PaneSection title="Inbound command filter">
      <p className="mb-3 text-[11.5px] leading-relaxed text-text-subtle">
        Slash commands arriving over the bridge are filtered.{' '}
        <span className="text-text-muted">Skill</span> commands expand to text
        and are always safe; <span className="text-text-muted">local</span>{' '}
        commands need an explicit opt-in;{' '}
        <span className="text-text-muted">Ink-UI</span> commands are always
        blocked.
      </p>
      <div className="grid grid-cols-2 gap-2.5">
        <FilterCard note="prompt-type commands expand to text" title="Allowed: skills" tone="good" commands={filter.skillSafe} />
        <FilterCard note="BRIDGE_SAFE_COMMANDS allowlist" title="Allowed: opt-in" tone="warn" commands={filter.optIn} />
        <FilterCard full note="local-jsx renders a terminal picker" title="Blocked: Ink UI" tone="danger" commands={filter.blocked} />
      </div>
    </PaneSection>
  )
}

function FilterCard({
  title,
  note,
  commands,
  tone,
  full = false,
}: {
  title: string
  note: string
  commands: string[]
  tone: 'good' | 'warn' | 'danger'
  full?: boolean
}) {
  return (
    <div
      className={`rounded-lg border border-shell-seam bg-shell-hover/40 px-3.5 py-3 ${
        full ? 'col-span-2' : ''
      }`}
    >
      <div className="mb-0.5 flex items-center gap-1.5">
        <Chip label={title} tone={tone} />
      </div>
      <div className="mb-2 text-[10.5px] text-text-subtle">{note}</div>
      <div className="flex flex-wrap gap-1.5">
        {commands.length === 0 ? (
          <span className="text-[10.5px] text-text-subtle">(none)</span>
        ) : (
          commands.map(name => (
            <span
              className="rounded-[5px] border border-shell-seam bg-shell-chrome px-1.5 py-px font-mono text-[10.5px] text-text-muted"
              key={name}
            >
              /{name}
            </span>
          ))
        )}
      </div>
    </div>
  )
}

/* ── direct connect ──────────────────────────────────────────────────────── */

function DirectConnectSection({
  lastResult,
  onVerb,
}: {
  lastResult: RemoteSettingsResultFrame | null
  onVerb: (verb: RemoteVerbMessage) => void
}) {
  const toast = useToast()
  const [serverUrl, setServerUrl] = useState('')
  const [connecting, setConnecting] = useState(false)
  const pendingRequestId = useRef<string | null>(null)

  const matched =
    !!lastResult &&
    lastResult.verb === 'remoteSettings.directConnect' &&
    lastResult.requestId === pendingRequestId.current

  useEffect(() => {
    if (!matched || !lastResult) return
    pendingRequestId.current = null
    setConnecting(false)
    toast(lastResult.message, { tone: lastResult.ok ? 'success' : 'danger' })
  }, [matched, lastResult, toast])

  const connected = matched && lastResult?.ok ? lastResult.directConnect : undefined

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!serverUrl.trim() || connecting) return
    const requestId = newRequestId()
    pendingRequestId.current = requestId
    setConnecting(true)
    onVerb({ type: 'remoteSettings.directConnect', requestId, serverUrl: serverUrl.trim() })
  }

  return (
    <PaneSection title="Connect a remote session">
      <form className="rounded-lg border border-shell-seam bg-shell-hover/40 px-4 py-3.5" onSubmit={submit}>
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[12px] text-text-subtle">
            Connect to a cat-code server over WebSocket
          </span>
          {connected ? <RemoteRolePill /> : null}
        </div>
        <label className="mb-1 block text-[11px] text-text-subtle" htmlFor="remote-server-url">
          Server URL
        </label>
        <input
          className="mb-3 w-full rounded-lg border border-shell-seam bg-app-bg px-2.5 py-2 font-mono text-[12.5px] text-text-primary outline-none"
          disabled={connecting}
          id="remote-server-url"
          onChange={event => setServerUrl(event.target.value)}
          placeholder="cc://host:8200"
          value={serverUrl}
        />
        <button
          className="rounded-lg bg-accent px-3.5 py-2 text-[12.5px] font-semibold text-app-bg transition-opacity disabled:opacity-50"
          disabled={connecting || !serverUrl.trim()}
          type="submit"
        >
          {connecting ? 'Connecting…' : 'Connect'}
        </button>
        {connected ? (
          <p className="mt-2.5 text-[11.5px] text-text-subtle">
            Session <span className="font-mono text-text-muted">{connected.sessionId}</span> is
            reachable at <span className="font-mono text-text-muted">{connected.wsUrl}</span>.
          </p>
        ) : null}
      </form>
    </PaneSection>
  )
}
