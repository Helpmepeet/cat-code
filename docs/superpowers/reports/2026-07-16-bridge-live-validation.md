# ChatGPT Bridge live validation — 2026-07-16

Status: **In progress.** Gates 1, 2, 4, 5, 6, 8, 9 PASS; gate 3 resolved
ONE-CLICK (conservative). **Gate 7 is the only one outstanding.** The bridge
remains **disabled** (`enabled: false`); no `enable` until all nine pass.

Live validation earned its keep three times over:

1. It surfaced **four defects that no unit or loopback test could catch** (D1–D4
   below), because each only manifests against the real `openai-mcp` client or a
   realistically large payload — including **D4, which hung any large-diff review
   forever**.
2. A decorrelated review of *those fixes* surfaced **four more material defects
   plus two nits** (F1–F4, n1–n2), including a security regression the fixes
   themselves introduced.
3. Gate 4, once restated against source, immediately found D4 on its first run.

All are fixed. Canonical suite: **157 pass / 0 fail** (from 146).

## Environment

- Canonical bridge implementation: `~/.agents/skills/chatgpt-review-pr/`
- Tunnel: ngrok, edge-terminating TLS, reserved host
  `excogitable-madelynn-martyrly.ngrok-free.dev`; local port `8977`
- Transit parties disclosed in every brief: **OpenAI** and **ngrok**
- Capability secret: mode 0600, never copied into this report
- Fixture: private repo `Helpmepeet/Orbit-toolkit`, throwaway branch
  `bridge-live-validation`, PR #1 (adds `src/orbit_toolkit/retry.py` with two
  planted defects). Only the unified diff of the changed file crosses to OpenAI,
  never the rest of the repo. **Cleanup owed:** delete branch + close PR #1.

## Defects found by live validation

None of these are reachable by the existing unit/loopback tests; each requires
the real client and, for D3, a real model following the prose contract.

| # | Severity | File | Defect | Fix |
|---|---|---|---|---|
| D1 | Gate-2 blocker | `bridgeServer.ts:104` | `tools/call` params validation rejected the MCP-reserved `_meta` field, which `openai-mcp/1.0.0` always sends. Every ChatGPT tool call failed `invalid_arguments`; the model reported "TOOLS UNAVAILABLE". | Accept (and ignore) `_meta`; still reject other unknown keys. |
| D2 | Evidence / operator blocker | `launchTask.ts` (`launch`, `reconcile`, `abandon`) | The CLI awaited the result but never printed it. A `manual-fallback` silently discarded its fallback prompt **and** the reconciliation state (`lockToken`) the operator needs for `reconcile`/`abandon` → a timed-out run stranded its lineage lock with no recovery path. B-4 could not record per-gate evidence. | Print the result as JSON (matches `bridgeSetup.ts` idiom). |
| D4 | **Gate-4 blocker (severe)** | `bridgeServer.ts:275` (`writeControlLine`) | **Any large brief hung the launch forever.** `writeControlLine` called `socket.write()` and discarded its return value, and no `drain` handler existed. Bun's `socket.write()` performs a **partial write** once the buffer fills, so a large control line (a real 165 KB diff → ~200 KB register message, well under the 1 MB `CONTROL_LINE_CAP`) was silently truncated. The peer then buffered a line that never terminated, never replied, and the caller waited forever — no error, no timeout, no registration, and the lineage lock (acquired *before* register) stranded with no run record, putting it beyond `reconcile`/`abandon`, which require a `timed-out` record. In practice: **any pull request with a sufficiently large diff would hang silently.** | Re-send the unwritten remainder on `drain` (both control sockets); the client hello now uses the same safe writer. Regression test registers a >250 KB brief over a real control socket and fails (10 s hang) without the fix. |
| D3 | Gate-5 blocker | `taskRun.ts`, `profiles/prReview.ts` | The brief never served `resultSchema` (`post_task_result` advertises `result: {}`), so the model had to guess the closed shape. `prReviewResultJsonSchema` was dead data — only `resultSchema.validate` was consumed, `.schema` read by nothing. Worse, the `taskContract` prose said report "a concrete **explanation**" where the schema requires the key **`detail`**, and never mentioned the required `inspection` object at all. Every compliant post failed `schema_rejected`. | Serve `resultSchema.schema` in the brief; correct the contract prose to name the exact keys; add a coherence-guard test. |

**Why unit tests missed D3:** loopback/unit tests construct a result object
*from the schema, in code*, so they always conform. Only a real model following
the *prose* exposes prose-vs-schema drift. B-3's required loopback test passed
for exactly this reason.

### Fixes and tests

Canonical files touched under `~/.agents/skills/chatgpt-review-pr/`:

- `bridgeServer.ts` — accept `_meta`; serve `resultSchema` in the brief output schema
- `taskRun.ts` — `TaskBrief.resultSchema` field; populate it in both the register and restore paths
- `launchTask.ts` — print `launch`/`reconcile`/`abandon` results
- `profiles/prReview.ts` — `taskContract` prose names the exact schema keys (`inspection`, `detail`, closed key set)
- `bridgeServer.test.ts`, `launchTask.test.ts`, `profiles/prReview.test.ts` — +4 tests

Suite: **150 pass / 0 fail** (from 146). Each new test was verified to fail with
its fix reverted, then pass with it restored. The prose/schema **coherence
guard** (`prReview.test.ts`) asserts the contract names every key the schema
requires, so this class of drift now fails a test instead of a live post.

## Decorrelated review of the D1–D3 fixes (2026-07-16)

A skeptical reviewer with read access, given the four fixes and the security
invariants but **not** the author's own open finding, returned `VERDICT: REVISE`
with four material findings and two nits. All were verified against source before
acceptance; all are fixed. Crucially, **two were regressions the D1–D3 fixes
themselves introduced** — the rest were pre-existing bugs the `print` change
merely made visible.

| # | Finding | Origin | Fix |
|---|---|---|---|
| F1 | The launch/reconcile results printed a live **lineage lock token** (128-bit, proof-of-ownership for `validateLineageLock`/`releaseLineageLock`) to stdout, where any console/log transcript captures it — a direct violation of the secrets invariant. | **D2 fix** | Results now emit only a token-free `recovery: { runId }` handle; `reconcile`/`abandon` take `--run-id` and re-read the token from the mode-0600 run record. Token never transits stdin/stdout. |
| F2 | The post-browser catch emitted reconciliation state for records in **any** state, but `reconcile`/`abandon` accept only `timed-out` — so a control failure mid-run produced a handle both recovery commands reject, stranding the lineage lock. | Pre-existing | Extracted `browserFailureRecovery`: emits a handle only when the run is recoverable; for lock-holding states it attempts a fresh-control `timeoutRun`, and if that fails returns a lock-retained warning with **no** rejectable handle. |
| F3 | Reconcile called `openReconcile` (flipping `timed-out` → `registered`) **before** probing the endpoint; a failed probe then left the record in a state no recovery command accepts *and* a non-idle runtime that would not shut down. | Pre-existing | Probe moved before `openReconcile`. Verified to fail before the fix (record left `registered`) and pass after. |
| F4 | The served `resultSchema` marked `headSha` optional for both scopes, while the validator **requires** it for commit scope and **forbids** it for worktree — a result could satisfy the advertised schema and still be rejected, defeating the point of serving it. | **D3 fix** (prose) + pre-existing (schema) | Added `ProfileResultSchema.schemaFor(brief)`; pr-review serves a commit variant (requires `headSha`) or worktree variant (omits it, so `additionalProperties:false` rejects it). Contract prose now defers to the served schema. |
| n1 | The contract-coherence guard used substring matching, so `line` was satisfied by `inlineMaterial`. | D3 test | Word-boundary regex. |
| n2 | Control `register` cast `message.run` after only an `isRecord` check, while the sibling `restore` path closed-validates. | Pre-existing | Mirrors `restore`: `isControlRegisterTaskRun` + `controlRefused`. |

**Author's own finding (missed by the reviewer, fixed anyway):** the self-contained
fallback prompt is built from `ComposedPrReviewBrief`, which never carried
`resultSchema` — and the F4 prose fix made that load-bearing, since the prose now
instructs the model to match a served schema the fallback lane did not include.
The fallback material now carries the scope-specific schema. **Not done:** the
versioned **disclosure digest** still does not enumerate the served schema.
That is a non-issue for data disclosure (the schema is derived, non-sensitive
structural metadata) but changing it would alter the digest and persisted-snapshot
shape — a deliberate version decision, deferred to B-5.

### Incident (disclosed)

While diagnosing D1 via the ngrok request inspector, ~39 of the ~43 characters of
the capability secret were printed into the session transcript (a truncated
request URI). The secret was **rotated** (which also exercised gate 8),
invalidating the exposed value; the new endpoint was verified live. This was an
inbound capability path only — no outbound/secret data left the machine.

Note: inbound `_meta` from `openai-mcp` carries the user's `userAgent`,
`locale`, and `userLocation` (city/region/country/lat-long). Inbound only.

## Gate evidence

| Gate | Status | Observation |
|---|---|---|
| 1. App creation + four tools | **PASS** | App created; lists exactly `get_task_brief`, `get_brief_attachment`, `post_task_result`, `report_blocked`; `noauth` (capability in URL path). `post_task_result` shows "Unclear Arguments" — expected, since `result: {}` carries no static shape (the shape is delivered at runtime via the brief's `resultSchema` + `taskContract`). |
| 2. Tool invocation across ≥3 fresh chats | **PASS (3 of 3)** | After the D1 fix, three separate fresh `?q=` conversations each drove `get_task_brief` → `get_brief_attachment` → `post_task_result` unprompted and reached `received`: `orbitpr1-r1-c3zz` (14:01), `orbitpr1-r2-d4ww` (14:27), `orbitpr1-r1-e5xx` (14:50). **Measured requirement:** the app needs no manual pinning or per-conversation enabling — the `?q=` launch prompt naming the app ("Use the Cat Code Bridge app") was sufficient in 3/3. |
| 3. Write-action confirmation | **ONE-CLICK (conservative)** | Machine evidence leans zero-click: the write lands untouched, the attachment→post gap was a tight 28–45 s across three runs, and no run stalled to timeout. But no confirmed dialog-*absent* observation was obtained (app deletion to reset approval state was not possible), so per the design's honesty rule the burden is on zero-click and it is documented as one-click. Upgradable to zero-click with one clean dialog-absent observation on a virgin approval state. |
| 4. Inline/attachment size behavior | **PASS (restated)** — and it caught D4 | **Premise restated against source first:** the designed gate assumes material is inlined up to `INLINE_CAP` and falls back to attachment fetch above `ATTACHMENT_CAP`. Neither holds in the built system — **`ATTACHMENT_CAP` does not exist**, and attachment fetch is not a fallback: `taskRun.ts` strips `content` from every served attachment unconditionally, so `get_brief_attachment` is the *only* content path at any size. `INLINE_CAP` (60 KB, `launchTask.ts:38`) governs only the manual fallback-prompt tier. Restated as "a large attachment survives end-to-end, and the inbound body cap holds": **165 KB unified diff (≈2.75× `INLINE_CAP`, 5,406 added lines)** — first attempt **hung forever** (defect D4 below); after the fix, run `orbitbig-r1-h8bb` registered, ChatGPT fetched the full attachment and posted a schema-valid result (`received`, APPROVED). Inbound cap verified: a >1 MB `post_task_result` returns **HTTP 413**. |
| 5. Happy path + re-review | **PASS** | Round 1 (`orbitpr1-r1-c3zz`): REVISE, 2 findings — major bare-`except` (`retry.py:18`), minor first-retry-delay (`retry.py:21`); `inspection` correct; `verdictInconsistent: false`; persisted `round-1.json` + `.md`. Round 2 (`orbitpr1-r2-d4ww`, same lineage, round-1 result fed as `previousResults`): APPROVED, 0 findings; correctly retired both round-1 findings without restarting an unrestricted review. Both defects were real and both were caught. |
| 6. Failure drills | **PASS** | All drilled against the real server (2026-07-17). **Wrong runId** → `run_not_found`. **Oversized inbound post** (>1 MB) → HTTP 413. **Differing second post voids settlement** → run `drill-differing-j1`: post#1 `settling`, differing post#2 → **`rejected`**, both candidates retained for audit. **`report_blocked`** → run `drill-blocked-k2` → `blocked`. **Timeout → `abandon`** exercised twice (lock released, status printed — validates the D2 fix on the real CLI). **Timeout → `reconcile`** covered by a real-server test plus the live probe-failure case (F3). **Watch item answered:** across five real ChatGPT runs no duplicate or differing post ever occurred — notably in `orbitpr1-r1-b2xk` the post was *rejected* (`schema_rejected`) and the model did **not** re-post with regenerated prose. The contract's "post once" wording holds; no tuning needed. |
| 7. Tunnel/server/LaunchAgent recovery | PENDING | Tunnel-restart sub-test is security-gated (re-opening a public ingress tunnel needs explicit, specific operator consent). Server-crash + lock-recovery and LaunchAgent recovery not yet run. |
| 8. Capability rotation | **PASS (procedural defect)** | rotate → setup-serve → app **recreate** → next run succeeded end-to-end. **Defect:** `rotate` instructs the operator to "replace the ChatGPT app endpoint," but ChatGPT does not allow editing a created app's Server URL — because the secret lives in the URL path, every rotation forces **delete + recreate** of the app. B-5 must document this; `rotate`'s output string should be corrected. |
| 9. Endpoint dormancy | **PASS** | Measured over ~20 h of idleness (last run 2026-07-16 14:51:28 → 2026-07-17 ~11:00). The tunnel request log buffered 60 requests spanning 01:39–14:51 and recorded **zero inbound requests after the final run**. ChatGPT does **not** re-probe a dormant endpoint, so it cannot degrade or disable an app based on idle endpoint health. **Consequence: the standing handshake-only listener contingency is unnecessary** — the per-run server model stands. (Caveat: a setup-serve listener happened to remain up overnight, so the endpoint would have answered 200 if probed; since nothing probed at all, idle endpoint state is moot.) |

## B-5 implications (locked by these results)

- Document the workflow as **one-click** (gate 3). Drop "zero-click" claims
  unless a clean dialog-absent observation later upgrades it.
- Document capability rotation as **delete + recreate the ChatGPT app**, not an
  endpoint edit (gate 8).

## Remaining before `enable`

**Gate 7 only.** Its three sub-drills:

- *Server crash mid-run + lock recovery* — **partially observed, unplanned**: the
  D4 hang was killed mid-run (pid 4395), which stranded its lineage lock exactly
  as F2 predicts. Because register never completed there was no run record, so
  `reconcile`/`abandon` could not reach it and it required a manual
  `releaseLineageLock`. Locks verified back to 0. This wants a *deliberate*
  re-run now that D4 is fixed, since the crash path differs when a record exists.
- *LaunchAgent recovery* and *tunnel restart mid-run* — **security-gated.**
  Re-opening a public ingress tunnel requires explicit operator consent that
  names that action; a general "continue"/"control the browser" does not.

`enable` = `bun bridgeSetup.ts enable --acknowledge-live-validation`,
operator-run, only after all nine pass. Gate 3 remains recorded as one-click; it
is upgradable to zero-click with one clean dialog-absent observation on a virgin
approval state.

## Cleanup owed

- Delete fixture branch `bridge-live-validation` and close PR #1 on
  `Helpmepeet/Orbit-toolkit`.
- Fixture run/pending records under `~/.cat-code/chatgpt-bridge/{runs,pending}/`
  (`orbitpr1-*`) are validation leftovers.
- A setup-serve listener from 2026-07-16 is still bound to port 8977.
