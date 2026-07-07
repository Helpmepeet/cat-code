# P1-0 CatCode Desktop Scaffold Review

**Date:** 2026-07-02
**Repository:** `/Users/pt/cat-code`
**Branch:** `migration`
**Reviewed scope:** untracked `app/` scaffold
**Review mode:** three parallel audits plus primary-agent validation
**Disposition:** **P1-0 is not ready to hand off to P1-1**

## 1. Executive summary

The scaffold follows the decided high-level topology:

- Electron is the desktop shell.
- A separate Bun process hosts the engine-side controller.
- Electron and the sidecar communicate through a filesystem Unix-domain socket, not stdio,
  child-process IPC, a TCP listener, or Electron `MessagePort`.
- The supervisor is an Electron-free module with a session-keyed process map.
- Protocol v1 carries `sessionId`.
- The sidecar forwards the complete raw `AppSessionEvent`, preserving the structured
  `tool_use` block instead of passing through the lossy web event mapper.
- The principal Electron `webPreferences`, preload allowlist, T4 validation, T5a pending-request
  check, T6b permission-update stripping, JSON-safe event check, and clone-on-serialize discipline
  are present.

However, the implementation does not yet satisfy the full P1-0 DONE-WHEN or security contract.
The most important failures are:

1. an empty `updatedInput` can bypass the T6 echo-only rule and restore a pre-gate tool input;
2. renderer attachment is lossy, so reload or late subscription permanently misses `ready` and
   the probe message;
3. the 128 KiB hostile-inbound frame limit is incorrectly applied to legitimate outbound SDK
   events;
4. the character-based prompt cap conflicts with the byte-based frame cap;
5. closing and reopening the last macOS window creates a shell with no supervisor or sidecar;
6. the required outbound known-secret-key assertion is absent; and
7. several supervisor launch, timeout, disconnect, and restart states are inaccurate or fatal.

Passing unit tests do not invalidate these findings. The current test suite exercises framing,
the in-memory sidecar boundary, and sidecar-to-supervisor transport. It does not cover the
main-to-renderer attachment lifecycle, production navigation boundary, child launch failures,
socket reconnection, or the modified-input permission scenario.

## 2. Review scope and method

Three independent review tracks were run in parallel:

1. **Code correctness:** framing, JSON safety, sidecar validation, permission sanitation,
   supervisor lifecycle, socket paths, and Electron main.
2. **Security-contract fidelity:** `SECURITY-MINIMUM.md`, Electron hardening, preload exposure,
   CSP, navigation, sidecar enforcement of T4/T5a/T6/T6b/T7, and both transport landmines.
3. **Plan versus code:** `PROGRAM-PLAN.md`, `TRANSPORT-DECISION.md`, the P1-0 DONE-WHEN,
   topology, N-process readiness, controller seam, protocol F3, raw event forwarding, D6, and
   source-anchor drift.

The primary review then inspected the same sources, reconciled the findings, traced permission
behavior into the current engine helpers, ran the test and typecheck commands, and reproduced
selected boundary failures with temporary inline probes. No production code was fixed as part of
this review.

## 3. Must-fix findings before P1-1

### F1 — High: empty `updatedInput` bypasses T6 echo-only enforcement

**Locations**

- [`app/main/main.ts:229-243`](../../app/main/main.ts#L229-L243)
- [`app/sidecar/sidecarServer.ts:410-436`](../../app/sidecar/sidecarServer.ts#L410-L436)
- [`src/app-runtime/appRuntimeCanUseTool.ts:61-81`](../../src/app-runtime/appRuntimeCanUseTool.ts#L61-L81)
- [`src/utils/permissions/PermissionPromptToolResultSchema.ts:95-115`](../../src/utils/permissions/PermissionPromptToolResultSchema.ts#L95-L115)

**Concrete failure scenario**

1. A tool originally requests:

   ```json
   {"command":"curl http://unsafe.example"}
   ```

2. The engine permission layer produces a safer gated input:

   ```json
   {"command":"curl https://safe.example"}
   ```

3. The human-facing permission request contains the safer input.
4. A compromised renderer sends a bare allow:

   ```json
   {"behavior":"allow"}
   ```

5. Electron main converts the missing `updatedInput` to `{}`.
6. The sidecar permits `{}` without requiring it to echo the gated input.
7. `permissionPromptToolResultToPermissionDecision` treats empty input as “use original.”
8. The executed input becomes the original unsafe HTTP command, not the gated HTTPS command.

This was reproduced through the real permission helper chain. The observed gated prompt input was
the HTTPS command; the resulting executed input was the original HTTP command.

**Why it matters**

This is a genuine permission-boundary failure. The sidecar correctly rejects a non-empty rewrite,
but its empty-object exception reverses a prior engine-side input rewrite. The P1-0 security
contract explicitly requires renderer input to be echo-only.

**Disposition**

Must be resolved before continuing past P1-0, even though the first live permission UI is scheduled
later. This is part of the security baseline that P1-0 was required to freeze.

### F2 — High: renderer attachment loses one-shot frames

**Locations**

- [`app/main/main.ts:148-154`](../../app/main/main.ts#L148-L154)
- [`app/main/main.ts:251-258`](../../app/main/main.ts#L251-L258)
- [`app/renderer/src/App.tsx:24-34`](../../app/renderer/src/App.tsx#L24-L34)
- [`app/sidecar/roundtrip.probe.test.ts:4-8`](../../app/sidecar/roundtrip.probe.test.ts#L4-L8)

**Concrete failure scenario**

1. Electron starts the supervisor and sidecar.
2. The sidecar attaches to the supervisor socket and emits its one-time `ready` frame and probe
   message.
3. Main forwards frames only to the currently loaded `mainWindow.webContents`.
4. The renderer reloads, starts slowly, or registers `subscribe` after those sends.
5. There is no frame buffer, renderer-ready handshake, snapshot request, or replay.
6. The renderer remains at `connecting…`, receives zero frames, never learns its `sessionId`, and
   never sees the `tool_use` probe.

**Evidence**

A real Electron/CDP reproduction showed:

- before reload: `OPEN (app.ready received)` and `SURVIVED transport intact`;
- after reload: `connecting…`, `not yet seen`, and `Server frames (0)`.

The existing round-trip test explicitly stops at sidecar-to-supervisor and does not exercise the
main-to-renderer hop.

**Why it matters**

P1-0 DONE-WHEN requires sidecar-to-main-to-renderer delivery. P1-1 specifically depends on reliable
attachment and `app.ready`; a one-shot fire-and-forget bridge is not a usable attachment contract.

**Disposition**

Must be fixed before P1-1.

### F3 — High: legitimate large engine events are rejected as hostile frames

**Locations**

- [`app/shared/limits.ts:11-12`](../../app/shared/limits.ts#L11-L12)
- [`app/supervisor/supervisor.ts:149-155`](../../app/supervisor/supervisor.ts#L149-L155)
- [`app/supervisor/supervisor.ts:264-270`](../../app/supervisor/supervisor.ts#L264-L270)
- [`app/sidecar/sidecarServer.ts:477-490`](../../app/sidecar/sidecarServer.ts#L477-L490)

**Concrete failure scenario**

1. The engine emits a valid raw SDK event containing a large text block, tool result, diagnostic,
   or base64 image.
2. The sidecar JSON-safe check passes and `encodeFrame` writes the complete event without an
   outbound size policy.
3. The supervisor decodes sidecar output with the same `MAX_FRAME_BYTES = 128 KiB` used for
   hostile renderer-to-sidecar input.
4. A valid frame above 128 KiB produces a frame-length error.
5. The supervisor destroys the socket, drops the event, and drops all subsequent events.

**Evidence**

A valid 131,232-byte server frame produced:

```text
frame length 131232 exceeds max 131072
```

**Why it matters**

The limit is directionally wrong. T7 requires bounding hostile inbound renderer traffic; it does
not permit silently breaking legitimate raw SDK output. Raw image and tool-result fidelity is a
stated reason for selecting this transport.

**Disposition**

Must be corrected in the scaffold before live engine traffic is built on top of it.

### F4 — High: prompt character limit conflicts with the frame byte limit

**Locations**

- [`app/shared/framing.ts:17-23`](../../app/shared/framing.ts#L17-L23)
- [`app/shared/limits.ts:20-21`](../../app/shared/limits.ts#L20-L21)
- [`app/main/main.ts:159-166`](../../app/main/main.ts#L159-L166)
- [`app/supervisor/supervisor.ts:174-185`](../../app/supervisor/supervisor.ts#L174-L185)
- [`app/sidecar/sidecarServer.ts:260-270`](../../app/sidecar/sidecarServer.ts#L260-L270)

**Concrete failure scenario**

1. The renderer submits `"界".repeat(70000)`.
2. The prompt is only 70,000 JavaScript characters, so it is under `MAX_PROMPT_CHARS = 100000`.
3. UTF-8 JSON framing produces a 210,103-byte frame.
4. Main and the supervisor fully clone, stringify, and allocate the oversized value.
5. The sidecar frame decoder rejects it before prompt validation and closes the connection.
6. The supervisor may continue reporting the session as `ready`.

**Evidence**

The end-to-end probe returned:

```text
frame length 210103 exceeds max 131072
```

**Why it matters**

The public prompt contract advertises values the transport cannot carry. The sidecar guard also
cannot protect Electron main from allocating arbitrarily large renderer values before the frame
reaches the trust-boundary decoder.

**Disposition**

Must be made internally consistent before prompt submission work begins.

### F5 — High: closing and reopening the last macOS window creates a disconnected shell

**Locations**

- [`app/main/main.ts:251-262`](../../app/main/main.ts#L251-L262)
- [`app/main/main.ts:285-293`](../../app/main/main.ts#L285-L293)

**Concrete failure scenario**

1. On macOS, the user closes the last window.
2. `window-all-closed` shuts down the supervisor and sets `supervisor` and `primarySessionId` to
   `null`.
3. The app remains running, as is normal on macOS.
4. The user clicks the Dock icon.
5. `activate` calls only `createWindow()`.
6. No new supervisor is created, no sidecar is spawned, and no bridge is wired to a live host.
7. Existing IPC handlers still close over the old, shut-down supervisor.

**Wrong result**

The new window remains disconnected and cannot receive `ready` or successfully send messages.

**Disposition**

Must be fixed before P1-1 connection behavior is considered complete. This is not a D6 violation:
die-with-window is allowed, but reopening must produce a new functioning session.

### F6 — High: required outbound secret-key assertion is absent

**Locations**

- [`app/shared/jsonSafe.ts:30-113`](../../app/shared/jsonSafe.ts#L30-L113)
- [`app/sidecar/sidecarServer.ts:111-123`](../../app/sidecar/sidecarServer.ts#L111-L123)
- [`app/sidecar/sidecarServer.ts:443-485`](../../app/sidecar/sidecarServer.ts#L443-L485)
- `SECURITY-MINIMUM.md` §4, “No token field crosses IPC”

**Concrete failure scenario**

An engine event or pending permission request accidentally contains:

```json
{
  "account": {
    "accessToken": "sk-secret"
  }
}
```

`checkJsonSafe` returns `{ok:true}` because the object is structurally valid JSON. The event is
then sent raw to the renderer. A `ready` payload containing the same key bypasses even the
event-only JSON-safe check.

The same applies to the contract’s other forbidden keys:

- `refreshToken`
- `apiKey`
- `vaultFilePath`

**Why it matters**

Landmine 1 is a JSON-losslessness check, not a secret-redaction check. The security specification
requires a separate serializer-level known-secret-key rejection. Passing the former does not
satisfy the latter.

**Disposition**

Must be added before P1-0 is considered security-complete.

### F7 — Medium: sidecar launch failure can terminate Electron main

**Location**

- [`app/supervisor/supervisor.ts:139-170`](../../app/supervisor/supervisor.ts#L139-L170)

**Concrete failure scenario**

1. `CATCODE_BUN_BIN` names a missing executable, or the packaged sidecar executable is absent.
2. `spawn` produces a child-process `error` such as `ENOENT`.
3. No `child.on('error', ...)` listener is registered.
4. Node treats the event as unhandled and may terminate Electron main.

**Wrong result**

A recoverable sidecar launch/configuration problem crashes the desktop shell instead of producing
a session failure state.

**Disposition**

Must be handled before P1-1 relies on launch and readiness reporting.

## 4. Confirmed findings that can be sequenced after the immediate blockers

### F8 — Medium: production navigation accepts every `file:` URL

**Locations**

- [`app/main/main.ts:106-123`](../../app/main/main.ts#L106-L123)
- [`app/main/main.ts:135-146`](../../app/main/main.ts#L135-L146)

In packaged mode, `isAppOrigin` returns true for any `file:` URL rather than only the packaged
renderer bundle. An attacker-controlled local HTML file can therefore pass the navigation guard.
The BrowserWindow preload is configured for the window, so an accepted local document may receive
the CatCode bridge.

The current P1-0 renderer does not expose untrusted links, which makes this latent today. It must be
closed before model-controlled links or Markdown are rendered. Because navigation lockdown is an
explicit P1-0 acceptance criterion, the safest phase decision is to address it with the other
P1-0 security corrections rather than defer it to P1-3.

### F9 — Medium: dev CSP permits inline script

**Location**

- [`app/main/main.ts:54-83`](../../app/main/main.ts#L54-L83)

The development response header includes:

```text
script-src 'self' 'unsafe-inline' http://localhost:5173
```

`SECURITY-MINIMUM.md` explicitly requires no `'unsafe-inline'` and no `'unsafe-eval'`. The current
`index.html` also contains a stricter meta CSP, so the current page receives intersecting policies
and is protected more strongly than the header alone. Nevertheless, another same-origin
development document without the meta policy would permit inline handlers.

This is a contract failure, though lower risk than F1-F7 for the current renderer.

### F10 — Medium: the sidecar allowlist is not strict

**Locations**

- [`src/web/appSessionProtocol.ts:13-48`](../../src/web/appSessionProtocol.ts#L13-L48)
- [`app/sidecar/sidecarServer.ts:203-218`](../../app/sidecar/sidecarServer.ts#L203-L218)
- [`app/sidecar/sidecarServer.ts:310-318`](../../app/sidecar/sidecarServer.ts#L310-L318)

The reused Zod objects strip unknown fields instead of rejecting them.

Example:

```json
{
  "type": "app.ping",
  "nonce": "n",
  "runCommand": "rm -rf ~"
}
```

This is accepted, the extra field is discarded, and a pong is returned instead of the required
`bad_request`. The extra field does not execute, so this is not currently a command-execution
bypass. It does violate the explicit `.strict()` and “everything else rejected and logged”
contract.

The source schema also permits `app.submit.options.uuid`, and the sidecar forwards it into engine
message identity even though the renderer-facing protocol does not expose that field. Current main
reconstructs submit options and strips `uuid`, so the path is not reachable through the current
preload bridge; the sidecar boundary still fails closed less strictly than required.

### F11 — Medium: restart produces stale exit events

**Locations**

- [`app/supervisor/supervisor.ts:160-166`](../../app/supervisor/supervisor.ts#L160-L166)
- [`app/supervisor/supervisor.ts:198-210`](../../app/supervisor/supervisor.ts#L198-L210)

`restartSession(sessionId)` deregisters and terminates the old record, then immediately registers a
replacement under the same `sessionId`. The old child’s asynchronous exit handler later emits
`status: "exited"` for that same ID without checking whether the registry still points to the old
record.

A reproduction observed `status:exited` while `listSessions()` showed the replacement already
`spawning`, followed later by `ready`. A UI consuming supervisor events can therefore display a
live replacement as dead.

This should be fixed before restart state becomes user-visible or Phase 3 depends on N-process
status accuracy.

### F12 — Medium: startup timeout permanently abandons a slow sidecar

**Location**

- [`app/supervisor/supervisor.ts:235-250`](../../app/supervisor/supervisor.ts#L235-L250)

After roughly five seconds without a socket file, the supervisor only logs and returns. It does not
mark the record failed, terminate the child, continue waiting, or expose a retry.

A delayed-listener probe began listening after 5.2 seconds. At six seconds the registry still
reported `spawning` and no connection was attempted. This may become more likely when P1-1/P1-2
load a heavier engine graph or packaged sidecar.

### F13 — Medium: socket loss leaves a false `ready` state

**Location**

- [`app/supervisor/supervisor.ts:253-288`](../../app/supervisor/supervisor.ts#L253-L288)

If a connected sidecar socket closes while the child remains alive, the supervisor nulls the
socket but does not change `record.status`, emit a disconnected status, or reconnect.

Observed result:

- `listSessions()` continued to return `ready`;
- later `send()` failed; and
- no recovery path was triggered.

This is relevant to F4 because a frame violation closes the socket while the supervisor can remain
logically ready.

### F14 — Low: malformed UTF-8 is silently replaced

**Location**

- [`app/shared/framing.ts:62-70`](../../app/shared/framing.ts#L62-L70)

The decoder uses `body.toString('utf8')`. Node replaces malformed bytes with U+FFFD rather than
throwing. A JSON string body containing invalid byte `0xff` can therefore become a valid string
containing `�` instead of a protocol error.

This is a codec correctness gap, but current frames are generated by `JSON.stringify` and
`Buffer.from(..., 'utf8')`, so it is not reachable from an honest peer.

### F15 — Low: JSON-safe check is not fully lossless

**Location**

- [`app/shared/jsonSafe.ts:51-55`](../../app/shared/jsonSafe.ts#L51-L55)

Two confirmed examples:

- `checkJsonSafe({v: -0})` returns true, but JSON round-trip produces positive zero.
- A POJO with a symbol-keyed property returns true, but JSON drops the symbol-keyed property.

These violate the helper’s stated lossless-round-trip contract. Current SDK payloads are unlikely
to depend on signed zero or symbol-keyed data, so this can be treated as low-priority hardening.

### F16 — Low: required renderer-hardening smoke tests are missing

No current app test proves:

- `window.require`, `window.process`, and `window.module` are undefined;
- inline `<script>` and `<img onerror>` payloads cannot execute;
- `javascript:` navigation is blocked;
- redirects are blocked;
- `target=_blank` cannot create an Electron window; or
- allowed external URLs are handed only to `shell.openExternal`.

The current renderer displays `JSON.stringify(frame)` through a React text node at
[`app/renderer/src/App.tsx:96-108`](../../app/renderer/src/App.tsx#L96-L108), so React escapes it
and there is no current raw-Markdown XSS sink. A Markdown sanitizer can reasonably arrive with the
Markdown renderer, but the explicit P1-0 Electron-hardening verification gate remains uncovered.

## 5. Architecture and security checks that passed

### 5.1 Filesystem Unix-domain socket

Confirmed:

- supervisor uses Node `net.connect`:
  [`app/supervisor/supervisor.ts:23-24`](../../app/supervisor/supervisor.ts#L23-L24);
- sidecar uses `Bun.listen({unix: socketPath})`:
  [`app/sidecar/index.ts:78-94`](../../app/sidecar/index.ts#L78-L94);
- child stdio is diagnostic inheritance only, not the protocol transport;
- there is no TCP listener, child-process IPC channel, or Electron `MessagePort`.

This matches D6 pin 1.

### 5.2 Electron-free, N-ready supervisor

Confirmed:

- `app/supervisor/` has zero Electron imports;
- the registry is `Map<SessionId, SidecarRecord>`:
  [`app/supervisor/supervisor.ts:55-73`](../../app/supervisor/supervisor.ts#L55-L73);
- spawn, send, kill, restart, and list operations are keyed by `sessionId`.

The implementation is structurally an N-sidecar registry rather than a single global child handle.
The remaining lifecycle bugs do not change that architectural conclusion.

### 5.3 Correct controller seam and no lossy mapper

Confirmed:

- sidecar imports the real controller/factory seam:
  [`app/sidecar/index.ts:22-23`](../../app/sidecar/index.ts#L22-L23);
- it creates the same `AppSessionController` class wrapped by the current CLI/web builders:
  [`app/sidecar/index.ts:58-71`](../../app/sidecar/index.ts#L58-L71);
- there is no runtime import under `app/sidecar/` of:
  - `AppSessionWebSocketServer`,
  - `appSessionEventMapper`, or
  - `createAppSessionEventMapper`.

### 5.4 Protocol v1 carries `sessionId`

Confirmed on all client/server envelopes:

- [`app/shared/protocol.ts:59-63`](../../app/shared/protocol.ts#L59-L63)
- [`app/shared/protocol.ts:74-124`](../../app/shared/protocol.ts#L74-L124)

This satisfies the F3 requirement to reserve session addressing before Phase 3 multiplexing.

### 5.5 Raw `tool_use` is preserved

Confirmed:

- the sidecar broadcasts the full cloned `AppSessionEvent`:
  [`app/sidecar/sidecarServer.ts:443-485`](../../app/sidecar/sidecarServer.ts#L443-L485);
- the probe message contains a structured `tool_use` block with `name` and object `input`:
  [`app/sidecar/probeAdapter.ts:32-64`](../../app/sidecar/probeAdapter.ts#L32-L64);
- the sidecar-to-supervisor round-trip test verifies the block survives:
  [`app/sidecar/roundtrip.probe.test.ts:67-106`](../../app/sidecar/roundtrip.probe.test.ts#L67-L106).

The initial Electron renderer also received the intact block in the real smoke. F2 concerns
reliable attachment/replay, not flattening.

### 5.6 Electron baseline preferences

Confirmed at [`app/main/main.ts:92-102`](../../app/main/main.ts#L92-L102):

- `sandbox: true`
- `contextIsolation: true`
- `nodeIntegration: false`
- `nodeIntegrationInWorker: false`
- `nodeIntegrationInSubFrames: false`
- `webviewTag: false`
- `webSecurity: true`
- no remote module enablement

### 5.7 Default-deny preload shape

Confirmed at [`app/preload/preload.ts:26-59`](../../app/preload/preload.ts#L26-L59):

- four fixed-channel senders:
  - submit,
  - abort,
  - respondPermission,
  - ping;
- one subscribe method;
- no renderer-controlled channel parameter;
- no exposed `require`, `process`, `fs`, `child_process`, or raw `ipcRenderer` handle.

The generated CommonJS preload internally uses `require("electron")`; that is bundler/runtime
plumbing and is not exposed to the renderer page.

### 5.8 Sidecar boundary controls

Confirmed:

- **T4:** `goalSnapshot` is passed through `parseThreadGoal` before controller mutation:
  [`app/sidecar/sidecarServer.ts:273-297`](../../app/sidecar/sidecarServer.ts#L273-L297).
- **T5a:** permission response IDs must match an engine-minted pending request:
  [`app/sidecar/sidecarServer.ts:340-369`](../../app/sidecar/sidecarServer.ts#L340-L369).
- **T6b:** valid `updatedPermissions` are removed before the response reaches the controller:
  [`app/sidecar/sidecarServer.ts:403-408`](../../app/sidecar/sidecarServer.ts#L403-L408).
- **T7 presence:** declared frame size, prompt/text length, and per-connection effect-rate checks
  exist at the sidecar.

T6 is only a partial pass because of F1. T7 is only a partial pass because of F3, F4, and the
upstream allocation exposure.

### 5.9 Transport landmines

**Landmine 1 — JSON-safe assertion:** correctly placed on outbound raw controller events before
wire encoding. It catches the named structural hazards: Buffer, typed arrays, Date, Map, Set,
bigint, cycles, sparse arrays, undefined, and non-finite numbers. F6 and F15 are separate gaps in
secret rejection and full losslessness.

**Landmine 2 — clone-on-serialize:** correctly placed at the raw controller-event serialization
boundary before fan-out:
[`app/sidecar/sidecarServer.ts:448-485`](../../app/sidecar/sidecarServer.ts#L448-L485).
The sidecar does not mutate the controller-owned event reference.

### 5.10 D6 and source anchors

No forbidden sidecar-to-window ownership was found inside the sidecar or supervisor. Electron main
chooses die-with-window behavior by calling the supervisor shutdown API, which D6 permits for v1.
The macOS reopen bug is lifecycle incompleteness, not architectural welding.

The implementation’s cited controller, session-event, protocol, permission-schema, and builder
anchors still match current `src/`. No source-anchor drift affecting this scaffold was found.

## 6. Test and verification results

### 6.1 Fresh commands

```text
bun test app/
```

Result:

```text
25 pass
0 fail
56 expect() calls
```

Covered files:

- `app/shared/jsonSafe.test.ts`
- `app/shared/framing.test.ts`
- `app/sidecar/sidecarServer.test.ts`
- `app/sidecar/roundtrip.probe.test.ts`

Type checking:

```text
bunx tsc --noEmit -p app/tsconfig.json
```

Result: exit code 0.

Static architecture checks also confirmed:

- no Electron imports in `app/supervisor/`;
- no runtime WS server or event-mapper imports in `app/sidecar/`.

### 6.2 Important coverage limitations

The green suite does not currently cover:

- Electron main-to-preload-to-renderer delivery;
- renderer reload or late subscription;
- macOS close/reopen;
- child-process `error`;
- delayed socket startup;
- unexpected socket close/reconnect;
- restart event ordering;
- valid outbound frames above 128 KiB;
- multibyte prompts near the frame limit;
- engine-side gated input differing from the original tool input;
- production `file:` navigation scope;
- renderer Node-global exposure; or
- the crafted XSS/navigation smoke required by `SECURITY-MINIMUM.md`.

The existing test named “a forged sessionId frame is rejected at the sidecar boundary” does not
perform a forged raw-frame integration test. Its comments acknowledge that the unit test covers
the forged envelope while the integration portion sends a valid ping and verifies the happy-path
pong. This is not a product bug, but the test name overstates its integration coverage.

## 7. Phase decision

### 7.1 Hard stop before P1-1

Resolve F1-F7 before declaring P1-0 complete:

- permission echo-only semantics;
- reliable renderer attachment/replay;
- directionally correct frame limits;
- byte-consistent prompt limits and pre-allocation protection;
- functioning macOS reopen;
- outbound secret-key rejection; and
- non-fatal sidecar launch failure.

F8-F10 are also explicit P1-0 security-contract discrepancies. They should be closed in the same
correction pass unless the owner explicitly records a narrower temporary exception with a deadline
before untrusted content is rendered.

### 7.2 Acceptable later hardening

The following can reasonably be sequenced after the immediate P1-0 blockers, provided they are
tracked before their dependent features:

- stale restart exit events, before restart status becomes user-visible;
- slow-start timeout and socket reconnection policy, before production packaging/recovery work;
- strict malformed UTF-8 rejection;
- signed-zero and symbol-key JSON-losslessness edge cases; and
- Markdown sanitizer implementation, when Markdown rendering is introduced.

The Electron security smoke itself is an existing P1-0 acceptance requirement and should not be
lost merely because the current renderer has no Markdown sink.

## 8. Final assessment

The scaffold made the important irreversible decisions correctly: process isolation, filesystem
socket transport, Electron-free supervisor boundary, session-addressed protocol, real controller
seam, and raw SDK event fidelity. There is no need to revisit the selected architecture.

The remaining problems are implementation-contract failures at lifecycle, framing, and security
boundaries. In particular, F1 and F2 are not stylistic concerns or hypothetical refactors:

- F1 can change which tool input executes after the user approves a different gated input.
- F2 has been reproduced in the real Electron renderer and prevents reliable `app.ready`
  attachment.

Therefore the correct status is:

> **Architecture accepted; P1-0 implementation not yet ready for P1-1.**

No production fixes were made during this review.
