# P0-1 — Transport & shell decision (packaged topology bake-off)

**Status: DECIDED 2026-07-02.** Spike session on branch `migration` in `~/cat-code`,
pinned to engine commit **`234da9e`** (`fix: pin /insights chunk summarizer to Anthropic provider`).
Toolchain: `bun 1.3.11`, `node v24.3.0`, `Darwin arm64`.

This settles the one decision P0-1 owns: **shell + transport for the desktop app.** It
supersedes the withdrawn "Electron + engine in-process" call (refuted below against source)
and the STALE `backlog/phase0-1.md` P0-1 block. Source was re-verified against `~/cat-code/src`;
where the brief or PROGRAM-PLAN cited line numbers that had drifted, the verified anchors below win.

---

## 1. Chosen topology + rationale

**CHOSEN: (a) Electron + Bun sidecar, over a local IPC channel carrying raw `SDKMessage`.**

The engine is Bun-only (proven §3), so under *every* candidate it is a separate Bun process
(a sidecar) — "host it in-process in Electron's Node main" is impossible. That collapses the
old Electron-vs-Tauri argument (which hinged on cheap in-process hosting that does not exist):
Electron's Node main becomes a **supervisor + IPC broker**, not an engine host, and the
spike shows that role works (spawns/kills/restarts N Bun sidecars cleanly, §2). Candidate **(c)
loopback-WS is eliminated on evidence**: it is the only candidate that *drops `tool_use` today*
(the mapper flatten, proven at runtime §2), it would force the mapper rewrite before Phase 1
can render even one tool card, and a listening WS/TCP port is a larger attack surface than
in-process IPC for a renderer showing untrusted model/tool/Markdown output (P0-3). Candidates
**(a) and (b) are seam-identical** — both forward raw `SDKMessage` over IPC and bypass the
mapper entirely, and both supervise Bun sidecars with the same OS-level child-process
primitives. Between them the deciding factors are project-fit, not the seam: Electron keeps the
project on **one JS toolchain** (Tauri adds Rust), and has the **most mature signing +
auto-update** story (`electron-builder` / `electron-updater`) for the ship gate the program
requires. Tauri's win is smaller binaries + a tighter default sandbox; not worth a second
toolchain here. **Operator confirmed Electron on 2026-07-02.**

> The transport *shape* that (c) pioneered is not wasted: "a controller-`subscribe` listener
> serializes each event to a JSON frame; the client deserializes" is exactly what (a) reuses
> over IPC. We drop the WS *server* and its lossy mapper, not the frame model.

---

## 2. The evidence — packaged vs. reasoned

The bar was "as close to a packaged build driving the real `QueryEngine` as feasible in one
sitting; scope honestly what was proven packaged vs. reasoned." Here is exactly that split.

Spike code lives in `~/cat-code/.spike-p0-1/` (throwaway, **not committed** — untracked on
`migration`). Three probes, all run under real Bun against real engine modules.

### Measurement 1 — Seam fidelity: does a real `tool_use` block survive end-to-end? ✅ PACKAGED (at the seam)

`.spike-p0-1/seam-probe.ts` builds a **real `AppSessionController`** (`src/app-runtime/AppSessionController.ts`)
with an adapter that yields a realistic assistant `SDKMessage` carrying a `text` block **and** a
`tool_use` block (`{name:"Read", input:{file_path:"/etc/hosts"}}`), subscribes to it, and ships
each event as a JSON line over a **real loopback TCP socket** to a separate client that asserts
what arrives. Two serializers, same controller, same socket:

| Serializer | `tool_use` reaches client? | What the client received |
|---|---|---|
| **Raw-forwarding** (ship `event` incl. `event.message: SDKMessage`) | **YES ✅** | full block: `{"type":"tool_use","id":"toolu_probe_1","name":"Read","input":{"file_path":"/etc/hosts"}}` |
| **Current mapper** (`createAppSessionEventMapper`) | **NO ❌** | text only: `{role:"assistant", content:"I'll read that file.", sdkType:"assistant"}` — the `tool_use` block is gone |

This is the whole point of P0-1, reproduced at runtime, not by reading: **raw-forwarding
preserves rich content; the current mapper flattens it.** (a)/(b) get the top row for free;
(c) as-built gets the bottom row.

> ⚠️ **Scope of "preserves" (corrected by the 2026-07-02 review — see §6):** raw-forwarding is
> lossless **for JSON-safe (POJO) payloads**, which is all the real engine emits today (image
> blocks are already base64 *strings*). It is **not** unconditionally lossless: the seam types
> `content`/`event` as `unknown[]`/`unknown`, so the schema would *accept* a Buffer / `Date` /
> `Map` / `bigint` / cyclic value that `JSON.stringify → parse` silently corrupts or throws on.
> No current producer emits such a value; the fix is a JSON-safe assertion at the sidecar
> serializer (§6, scoped into Phase 1), not a change to the topology.

- **Packaged:** the real controller, the real event plumbing (`subscribe → createMessageEvent
  → emit`), the real mapper, a real socket + JSON (de)serialization, a real cross-process read.
- **Reasoned (scoped honestly):** the `tool_use` `SDKMessage` is a hand-built fixture, not one
  emitted by a live `QueryEngine.runTurn()` making a model call. A live turn needs account
  credentials and adds nothing at *this* boundary — the mapper and the serializer operate on
  the `SDKMessage` shape regardless of where it originated, and the fixture matches the shape
  the engine emits (`assistant` message → `message.content: [...]` with a `tool_use` block).
  The flatten is a property of `mapSdkMessage` (`appSessionEventMapper.ts:72`), which has **no
  `tool_use`/`tool_result` case** and falls through to `return []`.

### Measurement 2 — Multi-process viability: can the shell spawn/manage N Bun sidecars? ✅ PACKAGED

`.spike-p0-1/supervisor.ts` spawns **N=3 Bun sidecars** (`sidecar.ts`, each importing the real
`AppSessionController` module to prove engine code loads under the child Bun runtime). Result:
3 sidecars up with 3 distinct PIDs, each printing `READY`. This is plain OS child-process
supervision — identical whether the parent is Electron's Node main, Tauri's Rust core, or a
bare launcher.

### Measurement 3 — Crash isolation: kill one sidecar; does the shell survive + restart it? ✅ PACKAGED

Same probe: `SIGKILL` sidecar `s2`. Result — supervisor **stayed running**, survivors `s1`/`s3`
**stayed alive** (`exitCode === null`), and the supervisor **restarted `s2` with a fresh PID**
(80032 replacing the killed 80030). Crash isolation + restart both hold.

### Measurement 4 — Packaging/signing the Bun sidecar: what does shipping it take? ✅ PACKAGED (the load-bearing facts) · ⚠️ reasoned (the full installer)

- `bun build … --compile --target bun` produced a **standalone Mach-O 64-bit arm64 executable**
  that **runs directly** with **no `bun` on PATH at runtime**. So the sidecar ships as one native
  binary; the user needs nothing pre-installed. Sizes: a hello-world was 58 MB; the **real engine
  sidecar** (a `--compile --bytecode --packages bundle` binary that imports the real builder and
  constructs `QueryEngine`) was **~159 MB / 5,312 modules** (2026-07-02 review, §6) — that is the
  true shipping unit, ~3× the hello-world figure. Large, not a blocker.
- `codesign --force --sign - hello-bin` → **signed cleanly**; `codesign --verify` →
  `valid on disk`, `satisfies its Designated Requirement`. Ad-hoc here, but it proves the
  packed Mach-O accepts a signature — the real ship uses the same `codesign` + `notarytool`
  flow any bundled native helper uses, just with a Developer ID.
- **Bounded caveat (reasoned):** the engine build externalizes 5 native `.node` addons
  (`scripts/build.ts:124` — `@ant/*`, `audio-capture-napi`, `image-processor-napi`,
  `modifiers-napi`, `url-handler-napi`). Those can't be baked into the Bun binary; a headless
  sidecar either omits them (doesn't use audio/image/computer-use) or ships them as sibling
  files. Real, bounded, not a blocker.
- **What was NOT packaged:** a full `electron-builder` run producing a signed, notarized `.app`
  with the sidecar embedded + `electron-updater` auto-update. That pulls a large toolchain
  beyond one sitting and belongs in W5/Phase-5. What it *depends on* (a runnable, signable
  standalone Bun binary) is proven; wiring it into an Electron resources dir + notarization is
  mechanical.

### Elimination summary

| Candidate | Seam (tool_use) | Multi-proc | Crash-iso | Packaging | Verdict |
|---|---|---|---|---|---|
| (a) Electron + Bun sidecar (IPC, raw) | ✅ survives | ✅ | ✅ | ✅ binary+sign proven | **CHOSEN** |
| (b) Tauri + Bun sidecar (IPC, raw) | ✅ survives (seam-identical to a) | ✅ | ✅ | ✅ (adds Rust) | viable; loses on toolchain/ship-maturity |
| (c) loopback-WS behind thin shell | ❌ **drops tool_use today** | ✅ | ✅ | ✅ | **eliminated** (mapper tax + attack surface) |

---

## 3. Bun-sidecar confirmation (independently re-verified, not on faith)

**The engine is Bun-only → it is a separate Bun process under any shell. CONFIRMED.**

Source anchors checked against commit `234da9e`:
- `package.json:7` → `"packageManager": "bun@1.3.11"`; `engines.bun ">=1.3.11"`.
- `scripts/build.ts:162-174` → `bun build … --compile --target bun --format esm --bytecode
  --packages bundle --conditions bun`. (`--target bun`, `--bytecode`, `--conditions bun` are
  Bun-specific.)
- `src/QueryEngine.ts:1` → `import { feature } from 'bun:bundle'` — the engine's **first import
  line** is a Bun-only virtual module.

Runtime probes (the empirical half):
- **Node cannot resolve the engine's Bun import.** `await import('bun:bundle')` under
  `node v24.3.0` throws exactly the predicted error:
  `ERR_UNSUPPORTED_ESM_URL_SCHEME` — *"Only URLs with a scheme in: file, data, and node are
  supported by the default ESM loader. Received protocol 'bun:'"*.
  (Importing `QueryEngine.ts` directly under Node throws earlier, `ERR_MODULE_NOT_FOUND`, on
  the bare `src` specifier before it even reaches line 1 — so the brief's exact prediction is
  reproduced by probing the `bun:bundle` import itself, which is the true blocker.)
- **Bun resolves it** (control): `import { feature } from 'bun:bundle'` under Bun 1.3.11 loads
  with no error. (`feature` is `undefined` at runtime because its macro is populated at build
  time by `--packages bundle`; the *module resolves*, which is the point.)

Corollary confirmed for the multi-session context (P0-2's job, not this one): the engine
carries **process-global** session/CWD state — `src/bootstrap/state.ts` `STATE.cwd` (:69) and
`STATE.sessionId` (:105) are module-level singletons, mutated per-submit by `setCwd` at
`src/QueryEngine.ts:245` (→ `setCwdState` at `state.ts:537`) and by `switchSession`
(`state.ts:474`). One global per process ⇒ N sessions require N processes. This reinforces the
sidecar model but its existential proof is **P0-2**, not P0-1.

---

## 4. Follow-on work for Phase 1 — (a) won, so: IPC carries raw `SDKMessage`

**The mapper is NOT fixed — it is bypassed.** (a) does not use `AppSessionWebSocketServer` or
`appSessionEventMapper` at all. The raw rich stream already exists at the controller seam
(`src/app-runtime/sessionEvents.ts:20-23` → `{ type:'message'; message: SDKMessage }`); the flatten
is introduced *only* by the WS server's subscriber (`AppSessionWebSocketServer.ts:69-74`, running
`createAppSessionEventMapper()`). An IPC transport never touches that code.

**Scoped as real Phase-1 work (this replaces the stale "fix the mapper" line):**

1. **New Bun sidecar entrypoint** (small, net-new). A headless Bun process that constructs the
   `AppSessionController` (reuse `createRuntimeBackedWebAppSession` /
   `createQueryEngineAppSession` — the same builders `startRuntimeBackedWebMode.ts:59` uses) and
   speaks a **raw-`SDKMessage` framing** over Electron IPC (stdio/`MessageChannel`/local socket)
   instead of over `ws`. Its outbound serializer is the **raw-forwarding** one proven in §2
   (ship the `AppSessionEvent` whole, incl. `event.message`) — explicitly **not**
   `createAppSessionEventMapper`.
   - ⚠️ **JSON-safe contract (from the §6 review).** The framing MUST assert payloads are
     JSON-safe (POJO) at the sidecar boundary — reject/log a Buffer / `Date` / `Map` / `bigint` /
     cyclic value rather than let `JSON.stringify` silently corrupt or throw it. Cheap today (no
     producer emits such values); if a real non-POJO producer ever appears, upgrade to a tagged
     codec (e.g. base64 for binary) rather than raw JSON. This is the one transport-contract
     change the review added; it does not touch the topology.
2. **Reuse the existing protocol vocabulary, drop the lossy hop.** The inbound client→engine
   messages (`app.submit` / `app.abort` / `permission.response` / `app.ping`) and their Zod
   schema (`src/web/appSessionProtocol.ts:13-48`) are transport-agnostic and stay. The
   `app.ready` handshake (`AppSessionWebSocketServer.ts:79-87`) is re-emitted over IPC on
   attach. Only the **outbound event mapping** changes: raw `SDKMessage`, not
   `{role, content: string}`.
3. **Permission round-trip is unchanged in shape** — `controller.respondToPermissionRequest`
   (`AppSessionController.ts:87`) with the response schema at
   `src/utils/permissions/PermissionPromptToolResultSchema.ts` (allow requires
   `{behavior:"allow", updatedInput}`; deny is `{behavior:"deny", message}` — a bare allow is
   rejected). Just carried over IPC.
4. **Supervisor as a window-independent host module** *(revised 2026-07-02, DIRECTION-REVIEW
   DR-1 / D6)* — the §2 spawn/restart logic, owning one Bun sidecar per session, with its own
   session registry (⚠️ *not* `concurrentSessions.ts`, which is ephemeral PID files only — that's
   P0-2/W2's problem, flagged here for continuity). **Two pins the direction review added, for a
   product reason, not a technical one:**
   - **IPC channel = a filesystem (Unix-domain) socket**, not stdio and not a child-IPC pipe.
     Rationale: Cat Code's stated identity is an **always-on** agent that "keeps working while the
     main Mac sleeps" and "must function independently on the server Mac" (`package.json:5`,
     `README.md:7-10`, `docs/vision/2026-04-30-GOAL_PLAN.md:16-22,75`) — i.e. the engine is meant
     to *outlive* its control surface. Stdio/child-IPC pipes are **parent-bound by construction**:
     they die with the Electron window, which would make session lifetime = window lifetime and
     turn every Phase-5 auto-update relaunch into a kill of all live agent work. A socket survives
     the parent. (An Electron `MessagePort` **cannot be handed to a non-Electron Bun child at
     all**, so despite the "MessageChannel" mention elsewhere in this doc, the socket is the choice,
     not a menu.) A socket *file* is not a listening network port, so P0-5's allowlist/threat model
     is unchanged.
   - **The supervisor is an Electron-free module** (own folder/package, zero `electron` imports)
     that Electron main *calls*; the window is client #1 of its spawn/attach/registry API, not its
     owner. This is what turns `GOAL_PLAN.md:75`'s durable-background-service milestone into an
     *attach* (point a daemon, or a phone, at the same host module) instead of a rewrite of the
     Phase-3 supervisor.
   - ✅ **D6 DECIDED (owner ruling 2026-07-02): sessions die with the window for v1** (parity with
     today's TUI). v1 does not build reattach/detached-daemon behavior. The socket +
     Electron-free-supervisor structure above is **still mandatory** — the ruling accepted
     die-with-window *behavior*, not welding the sidecars to the window — so the eventual always-on
     milestone stays an attach against the same host module, not a Phase-3 re-architecture. **The old "re-attach or re-spawn" phrasing (P0-4
     §Phase-3 implications) hid that these are opposite architectures — a parent-bound pipe makes
     re-attach impossible, silently degrading it to re-spawn-from-transcript, which loses in-flight
     work. The socket keeps re-attach on the table.**

The renderer then consumes **raw `SDKMessage`** and derives rows via the anti-corruption
projector (PROGRAM-PLAN §5, layer 2). No flatten anywhere on the path.

> Net: the "mapper fix before P1-3" that the stale backlog scoped is **not needed on (a)** —
> we don't rewrite `appSessionEventMapper`, we route around it with a raw-forwarding sidecar
> serializer. `appSessionEventMapper.ts` + `AppSessionWebSocketServer.ts` become **dead for the
> desktop app** (the browser `--web` mode may keep them; out of scope).

---

## 5. How the walking skeleton (Phase 1) connects on this topology

Electron main launches, spawns **one** Bun **sidecar** (`bun run <sidecar-entry>` in dev; the
`--compile`d binary in a package) with a hardcoded cwd; the sidecar builds a real
`AppSessionController` over the real `QueryEngine` and, on IPC attach, emits `app.ready`
(`AppSessionWebSocketServer.ts:79` equivalent, re-homed to IPC) → **P1-1**. The renderer (React
19 + Vite + Tailwind v4) sends one real `app.submit` over IPC; the sidecar's controller runs the
turn and the **raw-forwarding** serializer streams real `SDKMessage` events (assistant + partial
deltas + result) back to the renderer's `<pre>` dump → **P1-2**. The first adapter slice derives
a text row **and a `tool_use` card** from the raw stream — provable *because* the `tool_use`
block now survives the transport (§2), which is precisely the gate a text-only pass would have
hidden → **P1-3**. A tool that needs permission drives `permission.requested` → renderer
allow/deny → `permission.response` (`{behavior:"allow", updatedInput}` / `{behavior:"deny",
message}`) → `controller.respondToPermissionRequest` un-pauses the real engine → **P1-4**. The
seam walks on the packaged Electron+sidecar build, with rich content intact — retiring
make-or-break #1.

---

## 6. Post-decision review (adversarial falsification, 2026-07-02)

After the decision, a fresh agent ran an **adversarial falsification pass** — the brief was to
*break* the choice with runnable probes, not copy-edit the doc. All source facts below were
re-verified against commit `234da9e` before landing here. **The topology decision (Electron +
Bun sidecar) stands.** The review changed the *transport contract* and corrected two facts; it
did not reopen the shell choice.

**Union size (for the projector, PROGRAM-PLAN §5):** the generated `SDKMessage` union has **19
members / 15 discriminants**; the runtime schema expands to **~25 variants**. Discriminants:
`assistant`, `assistant_error`, `system`, `stream_event`, `permission_denial`, `result`,
`status`, `tool_progress`, `user`, `auth_status`, `rate_limit_event`, `tool_use_summary`,
`prompt_suggestion`, `streamlined_text`, `streamlined_tool_use_summary`. (An exhaustive adapter
fixture over these is a Phase-2 requirement, not P0-1.)

| # | Claim under attack | Verdict | Evidence |
|---|---|---|---|
| 1 | Raw JSON forwarding is lossless for real `SDKMessage` | **HOLE (contract tightened)** | 6 realistic variants (incl. real image `tool_result`, stream deltas, diagnostics, error results) crossed a real socket intact. **But** the seam's `unknown[]`/`unknown` typing *accepts* Buffer→object, `Date`/`Map`→lossy, sparse arrays, `bigint`/cycles→throw. No current producer emits these. → JSON-safe assertion at the serializer (§2 note, §4.1). |
| 2 | "Reuse the builders, swap the serializer" holds | **SURVIVES** (1 landmine) | Builders construct + run with no WS/mapper dependency. Landmine: `AppSessionController.emit()` (`AppSessionController.ts:192-195`) hands **the same mutable `event` reference** to every listener — a mutating first subscriber corrupts what a second serializes. Harmless at 1 subscriber; treat the raw event as immutable (clone-on-serialize or never mutate) once the app adds a second. |
| 3 | A packaging blocker kills Electron + Bun sidecar | **SURVIVES** | A real `--compile --bytecode --packages bundle` binary imported the real builder, constructed `QueryEngine`, and submitted through the controller with **no Bun on PATH** and **no external native addon loaded**. Binary ~159 MB / 5,312 modules (corrected into §2). |
| 4 | Doc anchors are accurate | **1 DRIFT (fixed)** | `state.ts:474` defines **`switchSession`**, not the `setActiveSession` the doc originally cited. Corrected in §3. All other anchors matched. |

**Ran (packaged):** real controller/socket round-trips, schema-adversarial payloads, the
subscriber-alias probe, a production-flag compiled binary, sanitized-runtime execution, native
linkage inspection. **Reasoned (not run):** a credentialed live model turn, the final Electron
IPC implementation, `electron-builder` packaging/signing/notarization.

**Net effect on Phase 1:** the weakest remaining point is a **live, tool-rich `QueryEngine` turn
through the final compiled sidecar + Electron IPC channel, with the JSON-safe payload assertion
enforced** — that is the one thing this spike could not package and the first thing Phase 1 must
prove. Two carry-forward landmines for implementers: **(2)** the `emit()` aliasing (immutability
discipline once >1 subscriber), and the JSON-safe contract from **(1)**.

---

## P0-4 — multi-session isolation

**Status: DECIDED 2026-07-02.** Probe on branch `migration` in `~/cat-code`, source re-verified
against engine commit `234da9e`, `bun 1.3.11`, `Darwin arm64`. This settles make-or-break #2:
**one engine process per session, or one process multiplexing N sessions?**

### VERDICT

**N-PROCESS. Each session gets its own engine process. A single-process multi-session engine is
impossible without an engine refactor that threads session identity through call-scoped context
instead of module-global singletons — and that refactor is out of scope for the migration.**
Confidence: **HIGH** — this is proven by a runnable probe driving the real desktop seam, and the
forcing state is a module-level singleton whose stomp is deterministic, not timing-luck.

### What the probe actually RAN

Test file: **`~/cat-code/src/app-runtime/multiSessionIsolation.probe.test.ts`** (committed to
`migration`). Reproduce: **`bun test src/app-runtime/multiSessionIsolation.probe.test.ts`**
(`bun test` auto-sets `NODE_ENV=test`, which `resetStateForTests()` requires). Result:
**4 pass / 0 fail, 17 assertions.**

The probe drives the **real `AppSessionController`** (`src/app-runtime/AppSessionController.ts` —
the exact class the sidecar builders wrap) with a minimal adapter whose `runTurn()` performs the
**exact process-global mutations a real turn performs**: `setCwd(cwd)` (identical to
`QueryEngine.ts:245`) and `switchSession(sessionId)`, then awaits a barrier so the other
concurrent session interleaves, then reads the globals back via `getCwdState()`/`getSessionId()`.
The controller's `submit()` loop, event emission, and the permission round-trip are all real
engine code. **Reasoned, not run:** no live credentialed model call — the stomp is a property of
the shared module singleton, not of the model, so a live turn adds nothing at this boundary. Stated
so the result is not overclaimed.

| Scenario | What ran | Result |
|---|---|---|
| **1-proc, two concurrent sessions, distinct cwds** | two real controllers in one process, both mutate the global cwd/sessionId then read back | **ISOLATION FAILS (as predicted).** Both sessions read the SAME global. Console captured the leak verbatim: session A wanted `…/p0-4-A-*` but **saw** `…/p0-4-B-*` — B's directory. `obsA.seenCwd === obsB.seenCwd` and `isolated === false` both hold. |
| **1-proc, simultaneous permission requests** | two real controllers, each raises a `permission.requested`; resolve A's request on B's controller | **PASSES / isolated.** `pendingPermissionRequests` is *instance* state on `AppSessionController`, so `ctrlB.respondToPermissionRequest('req-A', …)` returns `false` and only `ctrlA` resolves A. The permission plumbing is per-controller and fine; it is *not* what breaks 1-proc. |
| **2-proc, distinct cwds** (each session = fresh global namespace via `resetStateForTests()` = a new process's fresh module singleton) | each session owns its process's globals | **PASSES.** Each session saw exactly its own cwd + sessionId, zero cross-talk. |
| **2-proc, crash isolation + restart** | session A's turn throws mid-`runTurn` after mutating globals; session B (its own namespace) runs; then A "restarts" in a fresh namespace | **PASSES.** A's crash is caught, B completes seeing only its own cwd/sessionId, and restarted-A comes back clean. |

The headline row is the evidence: **the 1-proc cwd stomp is real and deterministic** — the model
of "two sessions, one process" collapses both onto one shared directory, so at least one session
runs tools in the *wrong* session's working directory. The permission row is a deliberate nuance:
not *everything* is shared (instance state is fine); it is specifically the **process-global
cwd + sessionId** that is fatal.

### The forcing state (src:line anchors, re-verified vs. 234da9e)

- `src/bootstrap/state.ts:435` — `const STATE: State = getInitialState()` — a single module-level
  singleton per process.
- `src/bootstrap/state.ts:69` — `STATE.cwd`; getter `getCwdState()` at **:533**, setter
  `setCwdState()` at **:537**.
- `src/bootstrap/state.ts:105` — `STATE.sessionId`; getter `getSessionId()` at **:437**; switched
  by `switchSession()` at **:474** (this is the correct name — the earlier `setActiveSession`
  citation was drift, already noted in §6).
- `src/QueryEngine.ts:245` — `setCwd(cwd)` at the top of every `submitMessage()`; `setCwd`
  (`src/utils/Shell.ts:447`) calls `setCwdState(physicalPath)` at **Shell.ts:464**. **This is the
  per-submit write that stomps.** Every turn from any session overwrites the one global cwd.

Because these are module-level (`STATE` is created once at import, before any session exists),
there is exactly **one** cwd and **one** sessionId per OS process. Two sessions in one process are
last-writer-wins on both. No amount of controller-level isolation fixes it — the controller is
above the global; the global is below the seam.

> NON-GOAL confirmed: `src/utils/concurrentSessions.ts` is **ephemeral PID files only**, not a
> durable session registry. It does not solve this and is not the fix (that's Phase-3/D1).

### Phase-3 shell implications (one paragraph)

The Electron main **supervisor must own an app-level session registry that maps each session to
its own Bun engine process** — exactly the "one Bun sidecar per session, its own registry"
scoped in §4.4 (and explicitly *not* `concurrentSessions.ts`). The registry keys sessions by an
app-owned id and holds the child handle + status; `app.submit` / permission responses are routed
to the *owning* sidecar by that id, and a session's cwd is fixed by *which process* it is, not by
a mutable global. This turns the §2 spawn/kill/restart supervision (already proven packaged) into
the isolation mechanism: spawn-per-session gives per-session cwd/sessionId for free, the §2 crash
test already shows one sidecar dying leaves the others alive, and restart re-spawns a clean
process (fresh `STATE` singleton) — matching the 2-proc probe rows here. The registry must also
survive supervisor churn (persist enough to re-attach or re-spawn), enforce a max-process bound,
and reap dead children. No engine change is required for isolation; the isolation boundary is the
**process**, provided by the supervisor.
