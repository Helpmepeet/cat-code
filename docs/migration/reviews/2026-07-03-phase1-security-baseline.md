# Phase-1 security-baseline review — 2026-07-03

## 1. Workstream verdict

**The walking-skeleton functionality cleared, but the Phase-1 security baseline did not
honestly clear the P1-0 acceptance gate. It cleared on overstated evidence.**

The production source does enforce substantial parts of the intended baseline:

- the only Phase-1 `BrowserWindow` explicitly enables sandbox and context isolation, disables
  Node integration in the page, workers, and subframes, disables webviews, keeps web security
  enabled, and uses an app-relative preload path (`app/main/main.ts:117`);
- main installs a restrictive CSP header (`app/main/main.ts:82`), and the renderer HTML has a
  fallback CSP;
- production main wires `will-navigate`, `will-redirect`, and a deny-only
  `setWindowOpenHandler` (`app/main/main.ts:148`);
- the preload exposes fixed methods rather than a generic channel API
  (`app/preload/preload.ts:26`);
- the sidecar rejects unknown message fields, parses the four engine-bound message types,
  validates goal snapshots through `parseThreadGoal`, requires an engine-minted pending
  permission request, enforces echo-only `updatedInput`, and prevents renderer-authored
  permission-update objects (`app/sidecar/sidecarServer.ts:180`,
  `app/sidecar/sidecarServer.ts:300`, `app/sidecar/sidecarServer.ts:363`).

Those controls are real. The gate still overstates the result because hostile renderer traffic
is bounded only after privileged-process allocation, development navigation admits every path on
the Vite origin, aggregate outbound retention has no byte budget, and the hardening smoke does
not execute production main or the production Markdown/navigation path. These are security
baseline defects, not objections to the Electron-plus-sidecar topology.

No HIGH finding was confirmed. Findings 1–4 are MEDIUM and should be treated as blockers before
Phase-2 renderer/transcript implementation expands the amount and variety of untrusted content.

## 2. Findings

### 1. CONFIRMED — MEDIUM — renderer traffic limits are enforced after privileged allocation

**Anchors:** `app/main/main.ts:209`, `app/supervisor/supervisor.ts:206`,
`app/shared/framing.ts:21`, `app/sidecar/sidecarServer.ts:139`,
`app/sidecar/sidecarServer.ts:284`.

Main accepts renderer prompts, reasons, nonces, and submit options with only shallow type checks
and forwards them. The supervisor then runs `JSON.stringify`, allocates buffers, and writes the
frame. Only after that work does the sidecar decoder enforce `MAX_FRAME_BYTES`; prompt length is
checked later still. The per-connection rate counter also runs only after main IPC, framing, and
socket delivery.

**Safe failure scenario:** a compromised or runaway renderer sends very large or high-rate
allowlisted calls. The sidecar refuses their effects, but Electron main has already cloned and
serialized the data and does that work for every call. The documented T7 control therefore does
not bound memory or CPU consumption at the first privileged boundary.

**Phase-2 impact:** add byte and rate enforcement in Electron main before forwarding, while
retaining sidecar checks as defense in depth. Test the actual preload-to-main-to-supervisor path,
including a rejected over-limit call and rate-window reset.

**Blocker before Phase 2:** **Yes** for Phase-2 implementation that builds on this renderer trust
boundary.

### 2. CONFIRMED — MEDIUM — development navigation trusts the whole Vite origin

**Anchors:** `app/main/navigationPolicy.ts:33`, `app/main/navigationPolicy.ts:49`,
`app/main/main.ts:151`.

Production navigation is restricted to the exact packaged index file, but development mode
allows any URL whose origin equals the configured Vite origin. Top-level path is not constrained.
Every accepted navigation stays in the same `BrowserWindow`, whose preload remains configured,
and the CSP permits same-origin scripts.

**Safe failure scenario:** untrusted Markdown or another renderer-controlled link points to a
different page or route served from the development origin. The navigation policy treats that
page as app content even though it is not the renderer entry document, so it receives the
preload bridge and can operate the documented app API.

**Phase-2 impact:** Phase 2 materially increases Markdown and tool-output rendering. Restrict
top-level development navigation to the intended renderer entry URL/path (query/hash may be
allowed deliberately) and test same-origin non-entry paths as denied.

**Blocker before Phase 2:** **Yes** for renderer work and dogfooding through the development
launcher.

### 3. CONFIRMED — MEDIUM — the hardening smoke tests a surrogate, not production main or Markdown

**Anchors:** `app/scripts/hardening-smoke.ts:23`, `app/scripts/hardening-smoke.ts:40`,
`app/scripts/hardening-smoke.ts:91`, `app/scripts/hardening-smoke.ts:109`,
`app/renderer/src/TranscriptView.test.tsx:5`.

The hardening smoke explicitly re-declares the CSP and creates a separate `BrowserWindow` with a
copied `webPreferences` object. It loads a custom test page, not production main and not
`TranscriptView`. Its nine checks cover Node globals, two inline-execution cases, the compiled
preload's keys, and absence of a raw `ipcRenderer`. It does not exercise production
`applySecurityBaseline`, production event wiring, `will-redirect`, `setWindowOpenHandler`, or a
Markdown-rendered unsafe URL/raw-HTML case. The Markdown unit test proves only ordinary emphasis
rendering.

**Safe failure scenario:** production main loses or mis-wires a navigation/CSP control, or the
Phase-2 Markdown configuration enables a less restrictive plugin. The surrogate smoke remains
green because its copied policy and custom page did not change.

**Phase-2 impact:** replace or supplement the smoke with a test mode that boots the real main
entry and real renderer component against benign checked-in fixtures, then observes CSP,
navigation, redirect, new-window, and bridge behavior. Keep the current smoke as a focused
preload/runtime check.

**Blocker before Phase 2:** **Yes** before expanding Markdown and tool-result rendering. This is
the exact verification item that `SECURITY-MINIMUM.md` made a P1-0 acceptance criterion.

### 4. CONFIRMED — MEDIUM — outbound retention is frame-count bounded but not byte bounded

**Anchors:** `app/shared/limits.ts:19`, `app/shared/limits.ts:26`,
`app/main/replayBuffer.ts:25`, `app/main/replayBuffer.ts:39`,
`app/renderer/src/rawMessageLog.ts:41`.

One outbound frame may be almost 32 MiB. Main retains the latest 512 non-ready frames per session
by count, even while a renderer is attached, and the renderer separately appends every raw
`SDKMessage` without a retention limit. The count cap can therefore retain a multi-gigabyte
theoretical working set before renderer and projected-state duplication.

**Safe failure scenario:** a legitimate turn emits repeated large tool results or image-bearing
events that are individually under the outbound cap. Main and renderer retain enough copies to
make the app unresponsive or terminate it despite every frame passing the advertised limit.

**Phase-2 impact:** define byte budgets for replay and raw debug retention, evict by bytes as well
as count, and avoid retaining/re-rendering duplicate raw data after the production projector
owns it. Add aggregate-size tests, not only tiny-frame count tests.

**Blocker before Phase 2:** **Yes** before the multi-tool transcript and tool-result slices make
large/repeated output routine.

### 5. PLAUSIBLE — MEDIUM — “no token in any form” is broader than the implemented secret guard

**Anchors:** `app/shared/secretGuard.ts:21`, `app/shared/secretGuard.ts:62`,
`app/renderer/src/App.tsx:129`.

The outbound guard rejects objects by known secret **key name**. Primitive strings are accepted
without content inspection. The renderer also offers a debug action that copies the full
projected transcript and raw SDK-message log to the system clipboard.

**Safe failure scenario:** an otherwise valid tool result or diagnostic contains credential
material inside an ordinary text/content field rather than under a recognized secret key. The
guard passes it, the raw renderer log receives it, and the debug export can persist it in the
clipboard. No production engine-owned token leak was observed in this review, so the occurrence
is plausible rather than confirmed.

**Phase-2 impact:** narrow the documented guarantee to “known credential-bearing fields do not
cross IPC” unless value-level redaction is added. Treat raw debug export as sensitive, add
redaction/retention policy, and decide whether it belongs in non-development builds.

**Blocker before Phase 2:** **No**, provided the claim is corrected and the debug surface is
tracked before broader tool-result rendering.

### 6. PLAUSIBLE — MEDIUM — the Unix-socket sidecar has no peer authentication

**Anchors:** `app/sidecar/index.ts:76`, `app/sidecar/index.ts:79`,
`app/sidecar/sidecarServer.ts:107`, `app/sidecar/sidecarServer.ts:118`.

The sidecar accepts every Unix-socket connection and immediately sends a ready frame containing
the session id and pending permission state. Protocol version and session id validate routing,
not peer identity. This is outside the renderer-only threat model in
`SECURITY-MINIMUM.md`, but the transport is already being positioned as a window-independent
host boundary.

**Safe failure scenario:** another local process able to open the socket attaches as a client,
learns the session id from the ready frame, receives session events, and can send allowlisted
commands or permission responses. Impact depends on OS account/process trust assumptions, which
the current decision docs do not state.

**Phase-2 impact:** no immediate protocol rewrite is required if same-account local processes are
explicitly trusted for v1. Before Phase 3 or daemon/reattach work, define socket permissions,
peer/authentication expectations, single-client versus multi-client policy, and tests.

**Blocker before Phase 2:** **No** under the current renderer-only threat model; **yes before
Phase 3 host/reattach expansion** unless the local-peer trust assumption is explicit.

### 7. CONFIRMED — LOW — the renderer-visible bridge is broader than the four-sender claim

**Anchors:** `app/preload/preload.ts:34`, `app/preload/preload.ts:58`,
`app/shared/protocol.ts:130`, `app/shared/protocol.ts:151`.

`SECURITY-MINIMUM.md` and the Phase-1 STATUS claim four renderer senders plus subscribe. The
actual bridge also exposes `rendererReady`, a fifth renderer-to-main operation, and current
hardening tests intentionally require it. It has no payload and does not send an engine command,
so this is a contract/accounting defect rather than a privilege escalation.

**Safe failure scenario:** future reviews or allowlist tests trust the “four senders” statement
and fail to assess attachment/replay behavior as a renderer-triggerable operation.

**Phase-2 impact:** document attachment control separately from the four engine commands and
include it in threat/bridge tables.

**Blocker before Phase 2:** **No.**

### 8. CONFIRMED — LOW — `app.abort.requestId` is accepted but does not name the aborted turn

**Anchors:** `app/main/main.ts:219`, `app/sidecar/sidecarServer.ts:260`,
`app/sidecar/sidecarServer.ts:271`.

Main forwards the renderer-provided abort `requestId`, but the sidecar validates only the optional
reason and calls `controller.abort(reason)`. The request id is not compared with an active turn.
This does not bypass tool permission; it makes the contract's “abort the named turn” claim
incorrect.

**Safe failure scenario:** a stale or mismatched request id aborts whichever turn is active in
that session.

**Phase-2 impact:** either make abort explicitly session-scoped and remove the misleading field,
or track the main-owned active request id and reject mismatches before streaming/cancellation UI
depends on it.

**Blocker before Phase 2:** **No** while one turn per session remains invariant.

## 3. Security carry-forward

| Item | Reason | Suggested Phase-2 owner | Source finding |
|---|---|---|---|
| Enforce inbound byte/rate limits in main | Sidecar-only enforcement does not bound privileged main work | IPC/transport owner | F1 |
| Restrict dev top-level navigation by path | Same-origin non-entry documents inherit the preload bridge | Electron shell owner | F2 |
| Boot production main/renderer in hardening tests | Current smoke duplicates policy and omits Markdown/navigation effects | Security-test owner | F3 |
| Add byte-based replay/raw-log retention | Count-only retention composes unsafely with 32 MiB frames | Transcript/transport owners | F4 |
| Define raw-output and clipboard redaction policy | Key-name guard does not support “no token in any form” | Transcript/security owner | F5 |
| Define local socket peer trust/authentication | Required before the host becomes attachable or long-lived | Phase-3 supervisor owner | F6 |
| Reconcile bridge inventory | Attachment control is a fifth sender, outside the four engine commands | IPC contract owner | F7 |
| Make abort correlation honest | Request id is currently decorative | Streaming/control owner | F8 |

## 4. Test evidence

### Tests run

- `bun test app/` — **122 pass, 0 fail, 295 assertions**.
- `bun run --cwd app test:hardening` — **9/9 checks passed** in Electron.
- `bunx tsc --noEmit -p app/tsconfig.json` — **passed**.

### What the evidence proves

- `SidecarServer` production boundary code rejects wrong protocol/session ids, unknown message
  types/keys, malformed goal snapshots, unknown permission ids, rewritten `updatedInput`,
  renderer-authored `updatedPermissions`, invalid suggestion selections, known secret keys, and
  over-cap prompts.
- Framing rejects an oversized declared inbound length before the sidecar buffers its body.
- The real supervisor plus a real Bun sidecar communicate over a real Unix socket for ready,
  ping, and fixture `tool_use` forwarding.
- Pure navigation decisions reject different origins, opaque schemes, non-entry production
  files, and every new Electron window; only HTTPS is eligible for OS-browser handoff.
- The compiled preload has no Node globals/raw `ipcRenderer` in the hardening renderer and exposes
  the six currently expected bridge methods.

### What the evidence does not prove

- No test drives a large or high-rate call through the real preload, production `ipcMain`
  handlers, supervisor serialization, and sidecar. The rate counter itself has no threshold/reset
  test.
- The test named “a forged sessionId frame is rejected at the sidecar boundary”
  (`app/sidecar/roundtrip.probe.test.ts:126`) sends only a correctly addressed happy-path ping;
  the forged-id rejection is proved separately by the in-memory server unit test.
- The hardening smoke does not import/boot production main, does not load the production renderer,
  and does not observe production navigation, redirects, or new-window effects.
- Markdown security is not tested. `TranscriptView.test.tsx` proves bold rendering and normal tool
  cards only.
- Replay tests prove a 512-frame count cap with tiny frames, not a total-byte cap.
- Passing secret-guard tests prove recognized key-name rejection, not value redaction in arbitrary
  text.
- The Phase-1 operator evidence in `STATUS.md` proves a real tool and permission round-trip. This
  review did not repeat that GUI work, and that evidence does not prove hostile-content
  hardening.

## 5. Explicit limits and safe manual verification

This was a defensive source/test review. No exploit code was written, no destructive testing was
performed, app/tests/plan docs were not changed, and the live CatCode GUI was not driven.

The following still needs verification against the actual production main/renderer path:

1. Build and launch the app through the normal development entrypoint:
   `bun run --cwd app dev`.
2. In the loaded CatCode page, inspect only benign runtime facts: confirm
   `window.require`, `window.process`, `window.module`, and `window.global` are undefined; record
   `Object.keys(window.catcode)`.
3. Render an ordinary HTTPS Markdown link from a non-sensitive test turn. Confirm the CatCode
   main-frame URL does not change and no second Electron window is created. If external opening
   is intended, confirm it occurs only in the OS browser.
4. Reload the CatCode window and confirm the bridge reattaches and buffered non-sensitive test
   messages replay once, not twice.
5. Prefer a committed automated successor to these manual checks: boot the real main entry in a
   test mode with benign checked-in fixtures and assert CSP, Markdown URL handling, navigation,
   redirect, new-window, and bridge behavior without copying the policy into the harness.

Do not use real credentials, private file contents, or destructive tool commands for these
checks.
