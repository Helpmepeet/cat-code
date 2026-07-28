# ACCOUNTS-OWNERSHIP — who reads the account pool (RATIFIED: host-plane worker)

Status: **RATIFIED 2026-07-28**, implemented in the same change.
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
coarser (percent buckets on a 5-hour window) and the underlying engine fetch is
1-minute-cached anyway (`fetchPoolUsage`), so a shorter period would spend a
~189 MB engine boot to re-read a cached value.

### What does NOT change

The per-session `accounts.snapshot` frame and the `account.*` write verbs stay
exactly as they are. Sessions keep their own pool view for in-session surfaces
(the reauth banner, the composer's account chip), and every WRITE still crosses
the session plane where the T6 re-resolve/re-validate guarantees live. This
change adds a read path; it removes none.

## 3. Security posture (SECURITY-MINIMUM conformance)

- **Outbound-only.** `accounts-pool` is a read-only host event (C3 precedent).
  It introduces NO inbound vocabulary, so the inbound allowlist is untouched and
  no new sidecar boundary validation is required.
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
- **UDS transport** — untouched. This is a main → renderer host event, not a
  change to the sidecar↔supervisor socket.
- **Raw `AppSessionEvent` fidelity** — untouched. A read-only snapshot, never an
  event mapper.
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
