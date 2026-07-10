# Adversarial review — Codex `token_invalidated` recovery design

Date: 2026-07-10
Reviewed artifact: `docs/reports/2026-07-10-codex-token-invalidated-recovery.md`
Verdict: **RED — rework before implementation**

## Executive verdict

The report correctly identifies a real HTTP-classifier gap: the supplied
`token_invalidated` body does not match the current revoked-auth text heuristics.
However, the proposed design is not safe or sufficiently evidenced:

- Fix 0 leaves structured streaming and WebSocket error paths unclassified and
  activates an existing stale-response race in auth recovery.
- Fix A is based partly on a pool state current production loaders do not create
  and on a process-topology explanation that does not fit normal `Agent` or
  `Explore` workers after a same-process `/login`.
- Fix A does not inherit an inventory-wide lock or single-flight mechanism, and
  naïvely importing inventory through `appendAccount` can revive accounts whose
  vault records say `reauth_required`.
- Fix B changes routing policy without evidence that routing, rather than the
  classifier gap, remains defective after the primary repair.

The smallest defensible next design is: centralize structured auth-failure
classification across HTTP, `response.failed`, and WebSocket error events; bind
recovery to the credential/account that actually made the failed request; add
race and transport tests; and defer inventory reconciliation and ranking changes
until a process-identified reproduction proves they are still necessary.

## Contract and conformance

The reviewed file is a pre-implementation design, not completed work. Its
contract is therefore its own promise to explain both observed symptoms and
specify a bounded, safe repair. No session ID, transcript excerpt with request
transport/account identity, PID evidence, or separate acceptance document was
provided.

| Design item | Classification | Review result |
|---|---|---|
| Fix 0: classify `token_invalidated` | Partial | The HTTP gap is real, but the proposed coverage is incomplete and the existing recovery target is race-prone. |
| Fix A: reconcile pool inventory from vault | Unsafe / unsupported | The stated no-refresh-token state is not normally constructible; same-process login updates the live singleton; locking and freshness semantics are unspecified. |
| Fix B: change `spread` fallback/ranking | Exceeded scope | Existing auth failover already excludes the failed account; no post-Fix-0 failing case establishes a ranking defect. |
| `follow-main` mitigation | Partial | Valid for new leases, not a universal retroactive repair for existing leases. |
| Test plan | Partial | It omits transport-specific classification, visible-output replay safety, stale-response races, status preservation, and process-topology proof. |

## Findings

### F1 — High: auth recovery can refresh or dead-mark the wrong account after a lease moves

`CodexAccountAuthError` records the account that made the request
(`src/services/api/codex-fetch-adapter.ts:268-278`), and the adapter derives that
identity alongside the per-request token
(`src/services/api/codex-fetch-adapter.ts:3075-3089`). Recovery instead prefers
the lease's account at catch time over `error.accountId`
(`src/services/api/withRetry.ts:591-599`), then refreshes or marks that selected
account dead (`src/services/api/withRetry.ts:603-682`). Lease failover correctly
rejects an account/lease mismatch
(`src/services/api/codexAccountLeaseManager.ts:298-313`).

Failure scenario: a request leaves on account A; the owner's lease moves to B;
A's delayed `token_invalidated` arrives; recovery refreshes or dead-marks healthy
B and then attempts failover with inconsistent identities. Fix 0 makes this path
reachable for a new, observed server error.

Disposition: bind account recovery to `error.accountId`, mutate a lease only if
it still points to that account, and carry a non-secret attempted-credential
generation or fingerprint so a delayed response cannot condemn a newer token
for the same account. Add both account-movement and same-account-token-rotation
race tests.

### F2 — High: Fix 0 does not cover all live `token_invalidated` transports

HTTP classification is text-only and misses the supplied body
(`src/services/api/codex-fetch-adapter.ts:329-360`), at both HTTP call sites
(`src/services/api/codex-fetch-adapter.ts:3222-3236` and `:3334-3359`). But
`response.failed` recognizes account caps only and otherwise produces
`CodexResponseFailedError` (`src/services/api/codex-fetch-adapter.ts:363-426`),
including initial and streaming failures
(`src/services/api/codex-fetch-adapter.ts:2102-2120` and `:2604-2612`). WebSocket
`type: "error"` events recognize connection/usage limits but emit a generic
error for other codes (`src/services/api/codex-websocket-transport.ts:924-983`).

Failure scenario: HTTP tests pass, but the same structured code arriving as
`response.failed` or a WebSocket error still bypasses auth recovery. A mid-stream
classification must also avoid replaying already-visible output, matching the
existing cap invariant tested at
`src/services/api/codex-fetch-adapter.test.ts:1520-1553`.

Disposition: define one structured auth-failure classifier and apply it to each
transport shape. Test HTTP, initial `response.failed`, pre-visible streaming
`response.failed`, post-visible streaming failure, and WebSocket error events.

### F3 — High: Fix A's stated pre-login/no-refresh-token cause does not fit the normal live path

`PoolAccount.refreshToken` is required
(`src/services/api/codexAccountPool.ts:31-37`); vault loading skips records
without one (`src/services/api/codexAccountPool.ts:935-948`); and config loading
rejects incomplete credentials (`src/utils/auth.ts:1363-1379`). Same-process
login persists tokens and immediately calls `appendAccount(..., activate: true)`
(`src/components/ConsoleOAuthFlow.tsx:213-231`). Normal asynchronous Agent
workers register a lease and invoke `runAgent` in-process
(`src/tools/AgentTool/AgentTool.tsx:1063-1123`), while `runAgent` directly calls
the shared `query()` generator (`src/tools/AgentTool/runAgent.ts:834-845`).

Failure scenario: a parent session starts before `/login`, `/login` runs in that
same process, and an Agent/Explore worker spawns afterward. It sees the updated
module-level pool; it does not hold a valid pooled account with a missing refresh
token. A different already-running process can have stale inventory, but that
specific topology is not established by the report.

Disposition: remove the no-in-memory-refresh-token production claim. Before
retaining Fix A, reproduce with parent/login/worker PIDs, pool initialization
time, selected account ID, request transport, and whether login occurred in a
different process. A same-process post-login agent failure supports stale
credentials selected by `spread`, not missing inventory.

### F4 — High: the claimed inventory lock and single-flight reuse do not exist

The available single-flight is per-account refresh within one process
(`src/codex-core/accounts.ts:218-255` and
`src/services/api/codexTokenRefresh.ts:262-276`). Stateful refresh locks one
vault file (`src/services/api/codexTokenRefresh.ts:281-309`); raw refresh uses a
separate global lock (`src/codex-core/accounts.ts:398-459`). Inventory loading is
an unlocked directory/file scan (`src/services/api/codexAccountPool.ts:918-1009`),
and `appendAccount` is an unlocked memory mutation
(`src/services/api/codexAccountPool.ts:323-410`). Login persistence performs an
unlocked read-modify-rename (`src/services/api/codexAccountPool.ts:700-749`).

Failure scenario: reconciliation scans while login or refresh is writing and
observes a mixed snapshot. It is not serialized by either refresh single-flight
or either refresh lock, contrary to the design's safety table.

Disposition: delete the lock/single-flight claim. If inventory reconciliation is
proven necessary, specify its race semantics and bound it to once per retry
chain. If writers require serialization, first define a single per-vault-file
persistence primitive used by login and refresh rather than assuming one exists.

### F5 — High: naïve reconciliation can resurrect blocked credentials

Vault loading preserves `reauth_required` as dead and ambiguous refresh state as
quarantined (`src/services/api/codexAccountPool.ts:1114-1151`). In contrast,
`appendAccount` turns every updated non-capped account healthy
(`src/services/api/codexAccountPool.ts:341-355`) and creates every imported
account healthy (`:375-387`). The existing same-account recovery only treats a
vault refresh token as newer when it differs from the exact stale token while
holding that account's refresh lock
(`src/services/api/codexTokenRefresh.ts:309-323`, `:437-455`). There is no general
ordering relation for opaque token strings or whole inventory snapshots.

Failure scenario: an inventory scan loads an old `reauth_required` account and
passes it through `appendAccount`; the pool revives it as healthy, `spread`
selects it again, and the retry loop repeats 401 → dead → reconcile → healthy.

Disposition: do not update known account identities through inventory
`appendAccount`. If a later reproduction requires discovery, import only
previously unknown IDs while preserving their loaded health state. Keep
same-account token rotation in the existing locked refresh path.

### F6 — Medium: the report's universal “no lease failover” consequence is false

At the first HTTP site, an unclassified 401 is wrapped as
`APIConnectionError` (`src/services/api/codex-fetch-adapter.ts:3222-3236`, using
`:429-432`). Generic Codex connection-error handling can rotate accounts after
two attempts (`src/services/api/withRetry.ts:763-900`). The second HTTP site
returns a raw 401 response instead (`src/services/api/codex-fetch-adapter.ts:3334-3359`).

Failure scenario: behavior depends on transport/call site; one path can perform
delayed generic failover while another terminates. The classifier gap still
exists, but “no lease failover” is not a source-verified universal consequence.

Disposition: describe behavior per transport and call site. The invariant that
is supported is “no forced auth refresh/vault recovery through the
`CodexAccountAuthError` branch.”

### F7 — Medium: Fix B changes intentional routing without a demonstrated defect

`spread` ranks clean/selectable accounts first, then lease count and recent
errors; the main-account penalty is only a later tie-breaker
(`src/services/api/codexAccountLeaseManager.ts:465-527`). Auth failover already
excludes the failed account (`src/services/api/codexAccountLeaseManager.ts:323-350`).
Neither vault presence nor alias `main` proves token liveness in another process.

Failure scenario: preferring main merely concentrates failures on a stale main
account and changes deliberate load-spreading semantics without fixing
classification or inventory evidence.

Disposition: remove Fix B from the implementation scope. First implement safe,
complete classification and test one stale spread-selected account failing over
to main. Revisit ranking only if that test still fails for a ranking-specific
reason.

### F8 — Medium: the causal reconstruction is not reproducible from the report

The report provides symptom prose but no session/transcript ID, transport,
request account ID, lease owner, PID boundary, pool snapshot, or timing evidence.
It also states that `token_invalidated` means a token was superseded by another
login without a local or authoritative source establishing that taxonomy.

Failure scenario: implementation solves an inferred cross-process inventory
problem while the observed failure was same-process selection of a different
invalid account, a structured streaming error, or a stale existing lease.

Disposition: mark those claims as hypotheses. Preserve the classifier unit test
as the proven proximate defect, and require a process/account/transport-aware
reproduction before secondary fixes.

## Nits and anchor drift

- The report's `codexAccountLeaseManager.ts:509-517` citation covers recent-error
  ranking; the main-account penalty is at `:520-527`.
- The forced-refresh gate begins at `src/services/api/withRetry.ts:603`, not
  `:604`.
- `claude.ts:2747` and `:2858` refer to owner IDs in current source; their owner
  type is on the following lines.
- `follow-main` is captured when a lease is registered
  (`src/services/api/codexAccountLeaseManager.ts:122-155`); describe the
  mitigation as applying to new/recreated leases rather than all existing ones.

## Verification performed

This was a read-only source review. No implementation or pass-count claims exist
to rerun: the reviewed document's verification battery is explicitly future
tense. No live vault, credential, network-auth, or GUI action was performed.
The reviewed document was not modified.
