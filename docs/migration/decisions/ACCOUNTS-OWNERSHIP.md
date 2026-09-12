# ACCOUNTS-OWNERSHIP — who reads the account pool (RATIFIED: host-plane worker)

Status: **RATIFIED 2026-07-28**, implemented in the same change. Engine observation sharing amended 2026-09-12 below.
Sibling of `CATALOG-OWNERSHIP.md`; it is the SAME defect class with the same
resolution, so this doc is deliberately short and defers every shared argument
to that one.

## 1. Problem statement (verified mechanism)

The Accounts page exists to show account usage. It could not do that, because
the account pool read was built on the per-session transport.

The data has no session dependency. `SidecarAccountsDomain.getSnapshot()` reads
`getPoolStatus()` and `getClaudePoolStatus()` (`app/sidecar/accountsDomain.ts:56-70`)
— bare module singletons over the `~/.cat-code/` vault. Neither takes a session
argument. But the sidecar is **one process per session** (N-process, LOCKED), and
`HostApi` (`app/shared/hostApi.ts:203-229`) carried only session lifecycle
(`createSession`/`restoreSession`/`closeSession`/`listSessions`/`subscribe`) and
no read seam at all. P4-5 therefore used the only recipe that existed and shipped
a global read as a per-session domain, which the domain header itself named "the
CANONICAL W4 domain read-seam recipe... Later domains copy this shape."

Three consequences, in ascending severity:

1. **No session, no data.** `Accounts` is an unconditional sidebar item
   (`app/renderer/src/Sidebar.tsx:140`), but `App.tsx` passed
   `selectAccountsSnapshot(accounts, activeSessionId)`. With no active session the
   selector returns null and the page renders only its waiting state. This is what
   the operator hit.
2. **N sessions, N answers.** Each sidecar process loads its own copy of the pool
   singleton from the same vault, so two live sessions can display different usage
   numbers for the same account.
3. **The numbers are frozen at session spawn.** `refreshAccountsUsageOnce()` is
   guarded one-shot per sidecar (`app/sidecar/sidecarServer.ts:2569`), and after
   that the snapshot re-broadcasts only when *that* session drives a pool-mutating
   verb. The protocol header concedes the cause: the pool "exposes no `subscribe`",
   so "a live async-refresh push is not possible."

For a usage dashboard, (3) alone is disqualifying: the page shows the number its
session loaded at spawn, indefinitely.

## 2. Decision

Accounts is a **host-plane read seam**, delivered by a main-owned disposable
engine-graph worker on a timer — structurally identical to `CATALOG-OWNERSHIP`
shape (b), reusing its machinery rather than inventing any:

| Layer | Catalog (existing) | Accounts (this change) |
|---|---|---|
| Boundary contract | `app/shared/sessionsCatalogWorker.ts` | `app/shared/accountsPoolWorker.ts` |
| Disposable worker | `app/sidecar/sessionsCatalogWorker.ts` | `app/sidecar/accountsPoolWorker.ts` |
| Main-owned runner | `app/main/sessionsCatalogRunner.ts` | `app/main/accountsPoolRunner.ts` |
| Outbound host event | `sessions-catalog` | `accounts-pool` |
| Renderer state | `sessionsCatalogState.ts` | global slot in `accountsState.ts` |

Rationale for the worker (rather than reading in main): the vault read must
happen in the engine (Bun) plane, which is the plane allowed to derive the config
home — the same constraint `sessionsCatalogWorker.ts:10-16` records. Main stays
engine-free and never parses credential material.

The worker reuses the EXISTING redaction: it calls the already-exported pure
projection `buildAccountsSnapshot` (`app/sidecar/accountsDomain.ts:430`) rather
than re-deriving the shape (CLAUDE.md §8 rule 10).

**Cadence: 60 s.** Longer than the catalog's 30 s because usage headroom is
coarser (percent buckets on a 5-hour window).

**Correction (2026-08-22).** This paragraph originally also argued that the
underlying engine fetch is 1-minute-cached (`fetchPoolUsage`), so a shorter
period would spend a ~189 MB engine boot to re-read a cached value. That is
wrong, and the runner says so at the definition
(`app/main/accountsPoolRunner.ts`): the cache is module-level inside the
DISPOSABLE worker this driver spawns fresh every run, so it never survives
between runs and every run performs a live authenticated fetch. Polling faster
multiplies real network calls against the account's usage endpoint. The 60 s
choice stands; only its second reason was false.

**Event-driven addition (2026-08-22, CC-74).** The timer is no longer the only
trigger: `AccountsPoolDriver.refreshNow()` performs one out-of-band run when a
frame reports that the pool actually changed (a completed sign-in, or an account
verb the sidecar applied — `frameMutatedAccountsPool`, `app/main/mainDecisions.ts`).
This is a read on the same path, not a second owner: main still owns the read and
the session snapshot is still not promoted. It exists because both the Accounts
page and the account-health bar read the host-plane pool, so the sidecar's own
`accounts.snapshot` re-broadcast cannot move them, and a mutation would otherwise
sit invisible for up to a full interval. Cost per trigger is one worker boot plus
one live usage fetch (see the correction above); it is bounded by the driver's
single-flight guard, by coalescing concurrent requests into one re-run, and by
the triggers being human-paced.

### Write-owner amendment (2026-08-23)

Codex profile deletion is global durable state and has no session input. Routing
it through the active chat sidecar made the Accounts page require an unrelated
open session and left a parked/dead sidecar unable to return the correlated
result.

`account.delete` from the Accounts page now uses a fixed HC3 preload method.
Electron main validates the exact confirmed delete shape, starts the same
disposable engine worker in one-shot delete mode, and writes the bounded request
over stdin. The worker freshly loads the vault, dispatches through
`accountsDomain.runVerb()` so the engine's target/vault checks remain
authoritative, emits one secret-screened result plus the redacted fresh pool,
and exits. Deletion and token refresh acquire the same per-profile
`proper-lockfile` lock; a refresh waiting behind deletion sees the missing
profile and cannot recreate it. Main rejects mismatched or semantically
inconsistent worker results before publishing anything.

After a successful durable delete, main returns the correlated `account.result`,
publishes the pool through the existing `accounts-pool` host event, and sends a
host-originated `account.profileDeleted` notice to every ready sidecar. Notices
for sidecars still starting are queued until their `ready` frame. Each sidecar
then removes the process-local account, repairs/releases affected leases, resets
Codex/auth caches, and re-broadcasts its redacted snapshots. A profile re-added
before a delayed notice is preserved.

The per-session `accounts.snapshot` frame and session-local `account.*` route
remain for composer account switching and the long-lived OAuth flow. This
amendment moves only destructive global profile deletion off the session plane.

### Observation-cache amendment (2026-09-12)

Ordinary Codex usage reads now share a private, disposable engine-owned
observation through `src/services/api/codexUsageSharedCache.ts`. The existing
`fetchPoolUsage` entry point checks a 60-second TTL and coalesces overlapping
unforced requests across processes using the existing lock helper. Inventory,
credential fingerprints, backend, durable credential-file revisions, and an
invalidation epoch scope the record. Credentials themselves are never persisted
in this cache. The normalized usage record retains account identity fields
needed by the existing engine Reset flow; it is private data, not the redacted
host-plane payload. The directory is 0700, the bounded validated file is 0600,
and failed reads/error strings are not persisted.

This supersedes the 2026-08-22 correction's statement that every disposable
worker necessarily performs a usage HTTP request. Worker startup and account
inventory loading still happen at each run. A recent compatible observation can
avoid its usage GETs; a miss or failed cache/lock falls back to the live read.
Main remains engine-free, and the same disposable worker and redacted host
boundary continue to own publication. No session-routing authority moves.

Forced refreshes bypass cached observations and older in-flight network reads.
The existing post-request refresh path still invalidates and force-fetches in
each process; it is not deduplicated by this change. Normal invalidation fences
old publications across processes. If writing the epoch fails, the engine
attempts to evict the old observation and disables sharing locally. If storage
also prevents eviction, another process may reuse the old record until its TTL
expires. Usage remains advisory; authenticated request results still govern
actual account availability.

A shared observation is less than 60 seconds old when accepted. The existing
60-second host polling interval can then leave that displayed observation
approaching two minutes old before the next successful run, plus execution
delay; offline last-good display can be older as before. Explicit fresh reads
continue to bypass this tradeoff. No model-generation request is saved by this
cache: its savings are usage-status HTTP reads.

Analytics in the same worker now compute the 7-day and 30-day ranges from one
discovery/read pass. Independent range accumulators retain the existing counting
rules. The five-run analytics cadence and failed-read last-good display policy
remain unchanged. See the
[implementation evidence](../../reports/2026-09-12-multi-session-compute-implementation.md).

## 3. Security posture (SECURITY-MINIMUM conformance)

- **Fixed inbound command.** `deleteAccount` is a dedicated preload method, not a
  generic invoke. Preload applies the byte/rate guard; main and the worker both
  require the exact `{type, requestId, accountId, confirm:true}` shape before an
  engine module can perform the write. Main also permits only one delete worker
  at a time, owns its abort controller through teardown, force-kills that child
  on teardown before `app.exit` can destroy an escalation timer, and suppresses
  any pool read that began before the mutation.
- **Host-originated invalidation.** `account.profileDeleted` has no preload
  method. The sidecar still validates its exact bounded shape before applying
  process-local cleanup, but untrusted renderer content has no route to originate
  it.
- **Redaction proven twice, as before.** The projection omits `accessToken` /
  `refreshToken` / `vaultFilePath` / `idToken` by construction, and the record is
  `scanForSecrets`-checked in the worker before emit AND again at main's parse
  boundary — the same double gate the catalog worker holds.
- **Parse-DoS bounded.** One NDJSON record, size-capped before parse, validated
  fail-closed field-by-field with no `as` cast on untrusted child output.
- **Main never sees credentials.** It receives an already-redacted snapshot; it
  does not read the vault and does not import the engine.

## 4. Locked-decision conformance (reopens nothing)

- **N-process** — untouched. The accounts worker holds no session, no socket, and
  no turn; it is disposable, exactly as the catalog worker and the PL-B backfill
  worker are not session processes.
- **UDS transport** — untouched. The delete worker uses bounded stdin/stdout
  owned by main and is not a session sidecar or a new socket transport.
- **Raw `AppSessionEvent` fidelity** — untouched. The account result and host
  pool snapshot are control-plane records, never an event mapper.
- **Die-with-window v1** — untouched. The driver is main-supervised and stops
  with the app, like the catalog driver.
- **Two-id model** — untouched. The pool is session-agnostic and keys on neither
  id.

## 5. Known remaining gap (NOT closed by this change)

The prototype's usage-analytics region — the 4-column stat grid, the "Tokens by
Account" / "Daily Tokens by Model" series with the 7d/30d toggle, and the
By-Account / By-Model / Main-vs-Subagents / Cache breakdowns (`Pages.jsx:589-704`)
— remains unbuilt and is NOT faked. `AccountStatus` carries current-window
used-percent only; there is no per-account token history anywhere on the wire,
and the prototype's own comments mark that region DEMO-ONLY. Closing it needs an
engine-side usage-history source, which is a separate session. This change makes
the page a live pool + headroom view; it does not make it the full analytics
dashboard.

## 6. Cross-references

- `CATALOG-OWNERSHIP.md` — the parent decision this mirrors; read it for the
  shape comparison, the boot-cost accounting, and the single-flight driver
  rationale.
- `SECURITY-MINIMUM.md` — the baseline §3 conforms to.
- `PER-SESSION-COST.md` — the ~189 MB per-process engine-import figure the
  cadence choice prices against.
