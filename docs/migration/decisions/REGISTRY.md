# D1 — The desktop session registry (spawn / multiplex / persist / restore)

**Status: DECIDED 2026-07-03 (Phase-3 pre-work, parallel to Phases 1–2).** This settles
INVENTORY's D1 — the app-owned durable registry the Phase-3 gate requires ("two real sessions…
switchable, with the app's own registry persisting/restoring them") and that Phase-3 backlog
generation is blocked on. It is a design decision: the contract Phase 3 implements, not code.
All anchors verified against the working tree 2026-07-03; where doc and source disagree, source
wins. Companions: `SESSION-LIFETIME.md` (D6 — what "restore" may mean in v1),
`PROTOCOL-ENVELOPE.md` (F3 — the one wire addition the registry needs).

| # | Question | Verdict |
|---|---|---|
| **R1** | Who owns the registry | **The host module** (the Electron-free supervisor plane, D6 pin 2). Electron main and any future daemon are its clients. Storage dir is **injected** at construction; canonical default `<claude-config-home>/desktop/registry.json`. |
| **R2** | What persists | A **small durable index + advisory runtime fields in one JSON file** (§3). Durable: app-session identity, engine-session identity, cwd, timestamps, shutdown state. Advisory (rewritten every run, trusted never): enginePid, socketPath. **No secrets, ever.** |
| **R3** | Restore semantics | **v1 restore = re-SPAWN + engine-session resume** keyed by `engineSessionId` — through the engine's REAL resume machinery (`loadConversationForResume`, `src/utils/conversationRecovery.ts:465` + `processResumedConversation`, `src/utils/sessionRestore.ts:493`), which loads messages, interruption state, and session metadata into the new engine; `switchSession` alone only adopts the id and is NOT a resume. Re-ATTACH is v2 and the schema already carries what it needs (pid/socketPath). In-flight turns are not restored (D6 L1/L3). |
| **R4** | Crash recovery / liveness | PID-liveness is a **check, not state** (the `concurrentSessions.ts` lesson): on every launch the host sweeps rows, kills orphaned sidecars (D6 §2), marks `crashed`, and offers restore. Bounded rows; dead rows reaped. |
| **R5** | Write discipline | **Single writer by construction** (Electron single-instance lock) **plus** an advisory lockfile + atomic temp-file-rename writes — the DR-2 lesson applied to our own new shared file on day one. |
| **R6** | Identity model | **Two ids, one bridge.** `appSessionId` (supervisor-minted, the *address* on every frame) ↔ `engineSessionId` (engine-minted, the *durable* transcript key). The bridge crosses the wire once per attach via `ReadyFrame.engineSessionId` — the F3 addition (`PROTOCOL-ENVELOPE.md` E-5). |
| **R7** | `concurrentSessions.ts` | **Liveness idiom only** — reconfirmed ephemeral per-PID JSON (write `<pid>.json` at `src/utils/concurrentSessions.ts:64,77`; dead-PID sweep `:186-201`). Not reused, not extended. Desktop sidecars are today invisible to `claude ps` (registration is TUI-only, `src/main.tsx:2583`) — coexistence carry-forward §9, not a registry concern. |

---

## 1. Why the app needs its OWN registry (re-verified, not inherited)

`src/utils/concurrentSessions.ts` was re-read in full. It is *richer* than earlier docs said —
per-PID files carry kind/name/status/messaging-socket for `claude ps`, including `daemon` kinds
(`:18`) — but its architecture is exactly what the Phase-3 plan warned: one JSON file **per live
PID**, registered by the process itself, deleted on clean exit (`registerCleanup`, `:66-72`),
swept when the PID dies (`:192-201`). Nothing survives the process on purpose. It cannot say
"this window had these three sessions yesterday," cannot map a session to its transcript for
restore, and its writer is the *engine* process, not the host. Treat it as prior art for the
liveness *check* (R4) and nothing else.

The durable half already exists and is **not** this registry's job to duplicate: the engine
persists every session's transcript, keyed by engine session id
(`getTranscriptPathForSession`, `src/utils/sessionStorage.ts:238`), and already knows how to
resume one — `loadConversationForResume` (`src/utils/conversationRecovery.ts:465`) deserializes
messages/interruption-state/metadata and `processResumedConversation`
(`src/utils/sessionRestore.ts:493`) rebuilds session state around them; `switchSession`
(`src/bootstrap/state.ts:474`) is only the id-adoption step inside that flow. **The registry is
therefore an *index*, not a store**: it remembers *which engine sessions the desktop had open,
addressed how, rooted where* — the session *content* stays engine-owned. This is the
load-bearing simplification: registry loss is an inconvenience (workspace forgets its tabs), not
data loss.

## 2. The two-identity problem (the one genuinely new fact this pass found)

As built at P1-4, there are two session identities and **no bridge between them**:

- The supervisor mints `appSessionId` (`randomUUID`, `app/supervisor/supervisor.ts:128`), keys
  its in-memory `Map<SessionId, SidecarRecord>` with it (`:81`), hands it to the sidecar via
  `CATCODE_SIDECAR_SESSION_ID` (`:154`), and every protocol frame carries it
  (`app/shared/protocol.ts:59-124`). The sidecar *self-checks* this address
  (`app/sidecar/sidecarServer.ts:198-209`) — but never passes it into the engine.
- The engine mints its **own** `STATE.sessionId` during `init()` and keys all persistence with
  it. The ready handshake payload (`AppReadyPayload`, `src/web/appSessionProtocol.ts:157-165`)
  carries **no session identifier of either kind**.

So today the host cannot learn which engine transcript any running sidecar is writing — which
makes restore-by-resume unimplementable. Decision: keep both ids (they have different jobs —
the app id is a *routing address* that must exist before the engine boots and survives engine
restarts; the engine id is a *durable content key*), record the pair in the registry, and bridge
them once per attach with the additive `ReadyFrame.engineSessionId` field (owned by
`app/shared/protocol.ts`, filled by the sidecar post-init; decision + rationale in
`PROTOCOL-ENVELOPE.md` E-5 — the engine-owned `AppReadyPayload` is deliberately not widened,
same precedent as PERMISSION-BOUNDARY R6). A restarted engine process under the same
`appSessionId` re-announces its (possibly new) `engineSessionId` in its fresh ready frame; the
registry updates the pair on every attach.

## 3. What persists — the v1 schema

One JSON document. Every field is either **[D]**urable (meaningful across launches) or
**[A]**dvisory (a runtime hint, rewritten on attach, *verified before use, never trusted*):

```jsonc
{
  "registryVersion": 1,
  "hostPid": 84210,            // [A] who last wrote; liveness-checked by readers
  "updatedAt": 1783075044383,  // [A]
  "sessions": [
    {
      "appSessionId": "d5a3…",        // [D] the address (supervisor-minted UUID)
      "engineSessionId": "f42c…",     // [D] transcript key; null until first ready frame
      "cwd": "/Users/pt/cat-code",    // [D] session root — spawn input, not engine echo
      "title": "fix transcript spine",// [D] optional; app-owned display name
      "createdAt": 1783070000000,     // [D]
      "lastAttachedAt": 1783075040000,// [D] recency for restore-ordering / reaping
      "shutdown": "clean",            // [D] "clean" | "crashed" | null (=currently live)
      "enginePid": 84377,             // [A] for the crash sweep only
      "socketPath": "/tmp/catcode-84210/s0.sock", // [A] v2 re-attach seed; v1 cleanup hint
      "restartCount": 0               // [A] supervisor policy input
    }
  ]
}
```

Deliberate exclusions: **no tokens/credentials of any kind** (secret owner stays the engine —
SECURITY-MINIMUM); **no transcript content or message counts** (engine-owned; deriving them here
would rot); **no window/tab layout** (that is renderer/W2 state — it may *reference*
`appSessionId`s but lives with the UI, so a registry rewrite never destroys layout preferences
and vice versa); **no permission state** (session-scoped in the engine, C3 snapshot is its read
path).

Bounds: `MAX_REGISTRY_SESSIONS = 32` rows — beyond that, oldest `shutdown != null` rows are
reaped on write. Rows whose `engineSessionId` transcript no longer exists on disk are dropped
during the launch sweep (the index must never offer a restore it cannot perform).

## 4. Restore & crash recovery — the launch sequence

On host construction (every launch, before any spawn):

1. **Read + validate** the registry file. Unknown `registryVersion` or unparseable JSON → move
   the file aside (`registry.json.corrupt-<ts>`), start with an empty registry, log loudly. This
   is safe *because* the registry is an index (§1): the engine's transcript catalog is the
   recovery path, not a backup of this file.
2. **Liveness sweep** (the R4 check): for each row with `shutdown == null` (host died without
   marking it), probe `enginePid`. Alive → an **orphaned sidecar** from a crashed host: v1 policy
   is **kill it** (SIGTERM; die-with-window, D6 §2) — v2 flips this branch to attach. Dead or
   recycled-PID → nothing to do. Either way the row becomes `shutdown: "crashed"`. Best-effort
   unlink of its stale `socketPath`.
3. **Reap**: drop rows over the bound and rows whose transcript is gone (§3).
4. **Offer restore** (UI policy, Phase-3 shell): rows by `lastAttachedAt`, `crashed` flagged.
   Accepting a row = `spawnSession(appSessionId)` on the existing supervisor
   (`app/supervisor/supervisor.ts:128` — it already accepts a caller-supplied id) **plus** the
   spawn-config the control plane adds in Phase 3: `cwd` and `resumeEngineSessionId` handed to
   the sidecar (env, like `CATCODE_SIDECAR_SESSION_ID` at `:154`), which the sidecar feeds into
   session construction instead of the P1-1 hardcode (`P1_1_CWD`,
   `app/sidecar/sessionController.ts:14` — the flagged carry-forward this retires).
5. **Write points** thereafter: row upsert on spawn; `engineSessionId` fill on ready; `title` on
   rename; `lastAttachedAt` heartbeat on attach; `shutdown: "clean"` inside `killSession`/
   `shutdown()`. Every write is full-file atomic (§5). No write on frame traffic — the registry
   is not a log.

## 5. Write discipline — not repeating DR-2 against ourselves

N-process just taught us (the DR-2 probe, `src/codex-core/accountRefreshContention.probe.test.ts`)
what unserialized read-modify-write does to a shared file. The registry is a **new shared
mutable file**, so the discipline is decided now, not discovered in Phase 3:

- **Single writer by construction:** Electron main takes the OS single-instance lock
  (`app.requestSingleInstanceLock()`) before constructing the host; a second app instance defers
  to the first. The daemon (v2) inherits the same rule via its own pidfile.
- **Belt and braces:** writes still go through an advisory lockfile (the house pattern —
  `proper-lockfile` via `src/utils/lockfile.ts`, as `codexTokenRefresh.ts:290` does) and an
  atomic temp-file + `rename` write (the `atomicWriteJson` idiom,
  `src/services/api/codexTokenRefresh.ts:913-952`). Rationale: the single-instance lock is an
  Electron-layer guarantee, but the registry's owner is the Electron-*free* host module — it must
  not silently depend on a client's politeness.
- Readers tolerate a mid-write reader crash trivially (rename is atomic); writers tolerate a
  held lock by retrying briefly, then failing the *write* (never the session) and logging.

## 6. How it sits on the P1-0 supervisor

The supervisor stays a pure in-memory process manager — `Map<SessionId, SidecarRecord>`,
spawn/kill/restart/send/subscribe (`app/supervisor/supervisor.ts:81,128,207,221,231`), and its
`listSessions()` snapshot (`:258`) already anticipates exactly this consumer. The registry is a
**sibling module in the host plane** (`app/supervisor/registry.ts` or `app/host/`), wired by a
thin host composition layer that subscribes to supervisor events (`status`/`exit` → row updates)
and exposes the combined **host API** — `createSession(config)`, `closeSession`, `listSessions`
(live ∪ restorable), `restoreSession` — which is the same API surface DR-4 says the control
plane must be designed on *once*. Electron main becomes a caller of the host API instead of the
supervisor directly; the renderer reaches it only through main (no new preload surface beyond
what W2 needs to list/switch sessions — that is Phase-3 UI work under SECURITY-MINIMUM's
default-deny rules).

Explicit non-goals for the registry module: it does not talk to sockets, does not parse frames
(it consumes supervisor events + the ready frame's `engineSessionId` relayed by the host layer),
and does not import `electron` (R1).

### 6.1 The typed control-plane contract (DR-4 executed, not just cited)

This subsection IS the "design the control plane once" deliverable. The host API from §6 is a
typed contract, not a convention. Types live beside the wire protocol in `app/shared/` (they
cross the main↔renderer boundary via preload, same as protocol frames cross main↔sidecar).

**Requests / responses:**

```ts
type CreateSessionRequest = {
  cwd: string                       // host re-validates; see HC1 below
  resumeEngineSessionId?: string    // present ⇒ this is a restore, not a fresh spawn
  title?: string                    // display only; length-capped
}

type SessionDescriptor = {
  appSessionId: string
  engineSessionId: string | null    // null until the ready frame arrives
  cwd: string
  title: string | null
  status: 'spawning' | 'ready' | 'disconnected' | 'exited'  // live view
  restorable: boolean               // registry row + transcript both present
  createdAt: number
  lastAttachedAt: number
}

type HostErrorCode =
  | 'invalid_cwd'          // HC1 validation failed (not a dir / not absolute / vanished)
  | 'session_not_found'    // id not in live map ∪ registry
  | 'session_limit'        // MAX_REGISTRY_SESSIONS or spawn rate cap hit (HC4)
  | 'spawn_failed'         // sidecar process failed to start / never sent ready
  | 'registry_unavailable' // registry file unwritable — sessions still work, persistence doesn't
```

**Methods** (all return typed results or a typed `HostError` — never a bare thrown string):

- `createSession(req: CreateSessionRequest) → SessionDescriptor`
- `restoreSession(appSessionId) → SessionDescriptor` — sugar over `createSession` with the row's
  `cwd` + `engineSessionId`; fails `session_not_found` if the row or transcript is gone (§9-A4).
- `closeSession(appSessionId) → void` — graceful sidecar shutdown, row kept (restorable).
- `listSessions() → SessionDescriptor[]` — live ∪ restorable, the union §6 already names.
- `subscribe(cb: (e: HostEvent) => void)` — `HostEvent` = row-level change notifications
  (`session-status`, `session-added`, `session-removed`) derived from supervisor events; the
  renderer's session list is a projection of this stream, never a poll loop.

**Security rules** are normative in `SECURITY-MINIMUM.md` (Addendum 2026-07-04, threat T8, rules
HC1–HC4) and summarized here for locality:

- **HC1** — the renderer never authors filesystem paths. `cwd` comes from a native directory
  picker (main-process dialog) or an existing registry row; the host re-validates
  (realpath, exists, isDirectory) before spawn and answers `invalid_cwd` otherwise.
- **HC2** — session ids from the renderer are validated (UUID shape + membership) before any
  map/registry lookup; unknown → `session_not_found`, never an exception with internal state.
- **HC3** — preload exposes these five methods as fixed, structured senders (extends R1);
  no generic `invoke(channel, args)` escape hatch.
- **HC4** — `createSession` enforces `MAX_REGISTRY_SESSIONS` and a spawn rate cap (extends T7);
  breach → `session_limit`.

## 7. What Phase 3 implements (backlog fodder, in dependency order)

1. `ReadyFrame.engineSessionId` (sidecar fill + type) — `PROTOCOL-ENVELOPE.md` E-5, trivially
   small, unblocks everything else.
2. Spawn-config plumbing: `cwd` + `resumeEngineSessionId` supervisor→sidecar env; sidecar
   session construction honors them (retires `P1_1_CWD`, `app/sidecar/sessionController.ts:14`).
3. `registry.ts` in the host plane: schema (§3), atomic persistence (§5), launch sequence (§4).
4. Host API composition implementing the §6.1 typed contract (methods, `HostErrorCode`,
   `HostEvent` stream, HC1–HC4 enforcement) + Electron single-instance lock in main.
5. Shell UI: session list/switcher consuming the host API (W2 rows: TabBar/Sidebar), restore
   offer surface.
6. Gate: the `SESSION-LIFETIME.md` §4 lifetime gate line (quit/relaunch restore ×2 sessions +
   crash-sim reap) — this is the registry's acceptance test.

## 8. Rejected alternatives

- **R-a: extend `concurrentSessions.ts` into the registry.** Wrong writer (engine registers
  itself; the host must know about sessions that are *not running*), wrong lifetime (per-PID,
  swept), wrong home (engine graph — the host module must not import the engine). Liveness idiom
  is borrowed; nothing else.
- **R-b: engine-side registry (engine records "desktop opened me").** Inverts ownership — the
  engine would need host concepts (windows, addresses) it rightly knows nothing about; and a
  crashed host could never trust engine-written rows about *host* state.
- **R-c: Electron `userData` / renderer `localStorage`.** Welds host state to the chrome — the
  exact fusion DR-1 unpicked. The daemon (v2) could never read it; renderer storage additionally
  puts host state on the wrong side of the trust boundary.
- **R-d: one file per session (the vault idiom).** Right when there are N independent *writers*
  (the vault's case); wrong here — one writer, small N, and restore wants an atomic *snapshot*
  of the whole workspace. Directory-of-files buys sync complexity and torn multi-row states for
  nothing.
- **R-e: SQLite.** A dependency + migration story for ≤32 rows of index data rebuildable from
  transcripts. Revisit only if the registry ever becomes a query surface (it should not — the
  Sessions page (W4/S4) reads the engine's transcript catalog, not this file).

## 9. Adversarial self-review

- **A1 — Two app instances race the file.** Defused twice (R5): OS single-instance lock at the
  client layer, advisory lockfile at the module layer. Worst case (both bypassed — e.g. two
  *different* builds): atomic rename means last-writer-wins on a *consistent* snapshot; rows are
  re-derivable; no torn JSON.
- **A2 — Registry corruption bricks startup.** It cannot (§4.1): unparseable → move aside +
  empty registry + loud log. The engine transcript catalog remains the ground truth for "what
  sessions exist"; only desktop-side associations (which were open, titles) are lost.
- **A3 — PID recycling makes the sweep kill an innocent process.** The sweep matches
  pid liveness **and** identity before SIGTERM: the row's `socketPath` must still exist and the
  process's command line must be the sidecar binary (both checks cheap on darwin). If either
  fails, treat as dead — never kill on pid match alone. (This is stricter than
  `concurrentSessions.ts:192`, which only probes liveness — acceptable there because it never
  kills, only counts.)
- **A4 — Stale `engineSessionId` (transcript pruned by engine housekeeping).** Sweep step 3 drops
  the row; restore is never offered on a missing transcript. The inverse (transcript exists,
  registry forgot) degrades to the Sessions page's normal resume path — the registry is an index,
  not a gatekeeper.
- **A5 — macOS `activate` mints a fresh session per dock reopen** (D6 §8-A5): without hygiene the
  registry accretes one-turn-old rows. Handled by the bound + reap (§3) and by `shutdown:"clean"`
  rows with `engineSessionId: null` (never got a ready frame / never ran a turn) being reaped
  immediately — an address that never acquired content is not restorable and not worth a row.
- **A6 — Secrets creep.** The schema has no secret-shaped field and the doc forbids adding one
  (§3). Registry writes go nowhere near the outbound frame path, so the F6 secret scan is not the
  (only) line of defense — exclusion by construction is.
- **A7 — "The registry duplicates the engine's session catalog and will drift."** It stores only
  what the engine *cannot* know: the app-side address pairing, the desktop's notion of "open,"
  cwd-as-spawn-input, and app titles. Everything shared (does the transcript exist, its content)
  is read from the engine at use time, never cached here.

## 10. Carry-forwards (flagged, deliberately not solved here)

- **`claude ps` coexistence:** desktop sidecars don't `registerSession()` (TUI-only,
  `src/main.tsx:2583`), so the operator's TUI tooling can't see desktop sessions. Cheap to add
  from the sidecar later (it *is* an engine process); decide at the dogfood gate whether it's
  wanted — do not silently couple the two registries before then.
- **DR-4 control plane on the wire:** v1 keeps create/close/list as host-API *calls* (window =
  client #1). If/when a remote client exists, those calls become versioned frames; design them
  off the host API surface (§6), not ad hoc — that is the standing DR-4 watch-item.
- **v2 re-attach:** the schema's advisory fields (`socketPath`, `enginePid`) are the seed; the
  sweep's kill-branch (§4.2) is the single place whose policy flips.
- **Registry UI naming** (`title`): app-owned now; if the engine's AI-generated titles
  (sessionStorage metadata) should seed it, wire read-only at Phase-3 shell time.
