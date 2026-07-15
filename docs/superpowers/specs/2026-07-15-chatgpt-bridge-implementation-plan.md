# ChatGPT Bridge — implementation plan

Status: PLAN. Executes `2026-07-15-chatgpt-bridge-design.md` (review-approved,
3 rounds). Deliberately lean: the design spec carries the detail; sessions
below cite its sections instead of restating them. Read the design before any
session.

## Fixed decisions for this plan

- **Code location: inside the existing `~/.agents/skills/chatgpt-review-pr/`
  skill directory**, alongside the v1 machinery it borrows (`lineageLock.ts`,
  `userscriptSource.ts`, `setup.ts`). Rationale: the bridge borrows v1's
  keypair/lock DB/userscript by import; colocating keeps those imports
  trivial and skill-publisher publishing atomic. Extracting a standalone
  `chatgpt-bridge` skill is deferred until profile #2 actually exists
  (no-premature-abstraction) and is a flagged step then, not now.
- All work happens in the skill directory (edit canonical
  `~/.agents/skills/`). **Publishing is serialized**: only B-3 and B-5 run
  `skill-publisher publish global` + `verify global`, at their exits — B-1
  and B-2 edit the canonical dir without publishing, so parallel sessions
  never race a publish of the same skill. Nothing in this plan touches
  `src/` or `app/`.
- **Profile interface ownership**: B-1's first micro-step lands the
  `Profile` registry-entry type (the design's `{ taskType, brief builder,
  result schema, contract text, disclosure specifics, triage rules }` as a
  code contract) in `taskRun.ts` and stops for nothing else; B-2 conforms to
  that type and never invents its own. This is the one ordering point inside
  the B-1 ∥ B-2 parallelism.
- Test runner: `bun test` file-isolated in the skill dir, matching v1's
  existing suites. Every session's exit requires its suites green plus the
  pre-existing v1 suites still green (they share the directory).
- Sessions are sized for one focused agent session each. B-1/B-2 may run in
  parallel; everything else serializes as listed.

## Sessions

### B-0 — transport spike (design §M1.0) · operator-in-the-loop

Prereqs: operator picks the tunnel (cloudflared w/ owned domain vs Tailscale
Funnel) and stands it up; scratch dev-mode app with a throwaway secret. This
pick **is** the design's open-Q6 decision (moved here from M2 because the
spike needs a public endpoint): binding, recorded in the spike report with
its party-disclosure consequence spelled out, and consumed by B-3's config
and disclosure text.
Build: single-file throwaway `spikeServer.ts` (echo tool, streamable HTTP +
SSE, capability-path check). Not kept; never imported.
Exit artifact: `docs/superpowers/reports/2026-MM-DD-bridge-transport-spike.md`
recording: SSE framing ChatGPT actually needs, session persistence across
calls, `initialize.instructions` honored or not, whether tool calls showed
any confirmation UI, prefill→app-invocation observations. B-1 consumes this;
if hand-rolled MCP is insufficient, STOP — SDK adoption is a flagged
user decision before B-1 starts.

### B-1 — bridge core · headless

Files: `taskRun.ts` + `taskRun.test.ts`, `bridgeServer.ts` +
`bridgeServer.test.ts`.
Scope: design §Run identity, §Tool contracts (generic layer only — profile
schemas injected as fixtures), §Receive flow/settlement, §Architecture
(registry, control socket, build-hash handshake, bind-race, setup-serve).
Persistence of run records at registration; ID_RE at every boundary;
lineageHash for paths.
Done when: both suites green covering the design's §Testing lists; a
loopback end-to-end test drives register → brief → post → settle with a
fixture profile.

### B-2 — pr-review profile + scope builder · headless, parallel with B-1

Files: `profiles/prReview.ts` + test, `scopeBuilder.ts` + test.
Scope: design Part II — canonical worktree manifest entries, both scope
kinds, `scopeDigest`/`headSha` rules, result schema with
findings⊆manifest / verdictInconsistent flags, local `.md` renderer with
labeled untrusted narrative, contract text (rewritten untrusted-content
instruction + report_blocked teaching).
Done when: suites green on fixture repos incl. rename/delete/mode/symlink/
submodule/binary cases (every manifest `kind` and `status` the design
defines) and the staleness set-equality check.

### B-3 — launcher + setup · depends on B-1 + B-2

Files: `launchTask.ts` + test, `bridgeSetup.ts` + test, probe tests for
cross-process lock/removal behavior. **Also owns registry wiring**: compiling
`profiles/prReview.ts` into the server's closed registry (B-1 built the
registry against fixtures; B-2 built the profile standalone; joining them is
this session's work, not B-4's).
Scope: design §Launch flow (disclosure preconditions as code-enforced
gates), §Receive flow (reconcile/abandon CLI on stdin state, as v1),
fallback tiers, §Setup (install requires active v1 installation; remove
touches only bridge-owned artifacts; serve mode; rotate). Reuses v1
`validateInstallation` patterns.
Done when: suites + probes green; every fallback tier exercised with fakes;
`--live-validation` flag semantics match v1's (bypasses only activation
flags, mutates nothing); **a loopback end-to-end test drives the real
pr-review profile through the real server** (register → brief → attachment →
post → settle → rendered record) — B-4 must not be the first time the real
profile meets the real registry.

### B-4 — live validation (design gates 1–9) · operator-bound

Run the nine gates via `launchTask.ts --live-validation` on a real trivial
lineage. Evidence: one row per gate (pass/fail + observation) appended to the
B-0 report or a sibling dated report. Gates 2 and 3 (app selection,
write-confirmation) decide the zero-click vs one-click wording for B-5.
No `enable` until all nine pass; enable = operator runs
`bridgeSetup.ts enable --acknowledge-live-validation`.

### B-5 — SKILL.md v2 + publish (design §M3) · after B-4

Rewrite `chatgpt-review-pr/SKILL.md`: bridge as primary workflow; complete
v1 procedure preserved as "Legacy GitHub-connector lane" section; v1-removal
warning (bricks bridge); zero-click/one-click wording per gate 3. Update
`skillContract.test.ts` in the same commit — it pins SKILL.md byte-level
(exact phrases, exactly two `bun launchReview.ts` command lines), so the
rewrite necessarily touches it; extend it to pin the new bridge invariants
too. Publish via skill-publisher to all three runtimes;
`verify global chatgpt-review-pr`.
Done when: published hashes verify; a dry read of the new SKILL.md can drive
both lanes without consulting the design doc.

## Implementation notes (session-derived detail, verified against v1 source 2026-07-15)

### v1 reuse map — import these, never reimplement

| From | Exports the bridge consumes |
|---|---|
| `lineageLock.ts` | `lineageHash` (results-dir keys), `acquireLineageLock` / `validateLineageLock` / `releaseLineageLock`, `countActiveLineageLocks` (remove refusal), `assertInstallationActive`, `withInstallationMutation` (bridge-config mutations under the same guard) |
| `setup.ts` | `statePaths` (v1 root discovery — locks live there), `publicKeyFingerprint` |
| `automationCore.ts` | `isValidReviewRunId` (the ID_RE — apply to lineageId too), `digestCommitScope`, `hashPrompt`, `createLaunchPayload` / `signLaunchPayload` (launch capability, unchanged) |
| `userscriptSource.ts` | `buildCapabilityFragment`. The installed userscript needs **no regeneration**: its capability validation is prompt-generic (verifies signature + prompt hash, no prompt-shape assumptions), so the one-line bridge prompt works with the existing install. |
| `launchReview.ts` | `ordinaryPrefillUrl`, `defaultRunner`, `defaultOpenBrowser`, `validateInstallation` (call it, then layer bridge-config checks on top); `ReconciliationState` as the shape template for bridge run records |

### State layout and knobs

- Bridge root `~/.cat-code/chatgpt-bridge/` (mode 0700): `config.json`
  (version, enabled, liveValidatedAt, tunnelKind, tunnelHost, port),
  `capability-secret` (0600, separate file so config can be read/printed
  safely), `runs/<runId>.json`, `results/<lineageHash>/round-<n>.{json,md}`,
  `control.sock`. Lineage locks stay in the v1 root's SQLite DB — do not
  create a second lock DB.
- Test-root override env var `CHATGPT_BRIDGE_HOME`, mirroring v1's
  `CHATGPT_REVIEW_HOME` (`statePaths` takes a root param; every bridge
  module should too — that is how all v1 suites isolate).
- Numbers (design defaults, restated once): fixed loopback port recorded in
  config at install (suggest 8977); watch timeout 5 min + 60 s grace (v1's);
  settlement 15 s; reconcile window 10 min; `INLINE_CAP` 60 KB;
  `ATTACHMENT_CAP` 200 KB.
- Control socket: JSON-lines over the Unix socket; message kinds
  `hello{buildHash}` / `register{run}` / `await{runId}` / `terminal{state}` /
  `reconcile-open{runId}` / `shutdown-if-idle`. Build hash = SHA-256 of the
  server's own source files at spawn, computed by the launcher the same way;
  mismatch at `hello` → refuse.

### MCP wire crib — from Apps SDK docs, CONFIRM ALL AT B-0

- POST `/mcp` with `Accept: application/json, text/event-stream`; server may
  answer plain JSON or an SSE stream (`event: message`, `data: <json-rpc>`)
  — expect ChatGPT to require the SSE form; keep responses single-message
  streams that then close.
- `initialize` → `{ protocolVersion, capabilities: { tools: {} },
  serverInfo, instructions? }`; expect a follow-up
  `notifications/initialized`; protocolVersion negotiation (client offers,
  server echoes a supported one — implement tolerant echo).
- Possible `Mcp-Session-Id` response header with client echo on subsequent
  calls — implement as optional passthrough; the spike decides if it is
  load-bearing.
- `tools/list` entries: `{ name, title, description, inputSchema,
  outputSchema, annotations, securitySchemes }`. `tools/call` result:
  `{ content: [{ type: "text", text }], structuredContent, isError? }` —
  serve results in BOTH `structuredContent` and a JSON-stringified `content`
  text block (clients differ in which they surface to the model).
- Also handle: GET `/mcp` (some clients probe it — 405 cleanly), unknown
  methods (JSON-RPC -32601, never a crash), batch arrays (reject politely).

### Disclosure gate as code (B-3)

Two-step launcher so disclosure is structurally unskippable:
`launchTask.ts compose <profile> …` builds the snapshot, prints the complete
disclosure block (prompt, contract, context, manifest+diffstat, transit
parties), persists the pending brief, and prints its SHA-256
`disclosureDigest`. `launchTask.ts launch --disclosed <digest>` refuses any
digest that does not match the pending brief. The agent cannot obtain the
digest without the disclosure block having been rendered into the
conversation. (v1 relies on SKILL.md discipline alone; this closes that gap
and is cheap.)

### Operational notes

- **B-4 runs against a scratch fixture repo**, never cat-code — gate runs
  disclose real diffs to OpenAI (and the tunnel party); validation content
  should be throwaway.
- Permission-mode footprint changes per lane: the bridge lane needs `open`
  and loopback networking only (**no `gh`, no `git push`** — nothing goes to
  GitHub); `gh`/`git` remain required only for the legacy v1 lane. B-5's
  SKILL.md states this per lane.
- Style: match v1's dense single-line Bun TS, `bun:test`
  `describe/test/expect`, colocated `*.test.ts`, `*.probe.test.ts` for
  multi-process; every module accepts an injectable root/clock/runner like
  v1 does — that is what keeps the suites hermetic.

## Sequencing and risk

```text
B-0 ──► B-1 ──┬──► B-3 ──► B-4 ──► B-5
        B-2 ──┘        (operator)  (operator ack)
```

- The only discovery risk left is B-0 (protocol shape) and B-4 gates 2/3
  (product behavior). Everything between is transcription from the design.
- STOP conditions: B-0 hand-rolled-MCP failure (SDK = new dependency,
  user decision); any B-4 gate that cannot pass without widening the
  four-tool vocabulary or the security layers (design §Security is not
  negotiable at implementation level — report instead).
- v1 stays untouched and green throughout; the first commit that modifies a
  v1 file is B-5's SKILL.md rewrite.
- Estimated effort: B-0 ≈ half day incl. operator; B-1, B-2, B-3 ≈ one
  session each; B-4 ≈ 2–4 operator hours across days; B-5 ≈ half session.
