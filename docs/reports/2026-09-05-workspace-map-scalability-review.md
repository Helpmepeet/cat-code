# Workspace map scalability review

Reviewed: 2026-09-05. Implementation follow-up: 2026-09-05.

Verdict: **YELLOW for continued use at current scale. The highest-risk cursor, snapshot, and crash-consistency gaps now have a first safety slice, but structural routing and full path-audit automation remain follow-up work before calling the system scalable.**

The root-router-plus-focused-maps design is sound. The weaknesses are how maps grow, how changed paths are assigned to them, and how the refresh job proves and checkpoints completion. Increasing source-file count alone does not require replacing this design.

## Executive summary for readers who have not seen the refresh prompt

This review concerns a documentation-based navigation system for the Cat Code
repository. Its purpose is to help an agent find the likely source owner for a
task before the agent begins broad repository exploration.

The system has two layers:

1. `docs/maps/WORKSPACE_MAP.md` is a compact root router. It names the focused
   maps and gives broad area-to-owner routes.
2. The 17 focused maps under `docs/maps/` provide domain-specific starting
   files, tests, validation commands, and warnings about stale assumptions.

The intended reading path is:

```text
task → root router → one or two focused maps → current source → tests/validation
```

The maps are routing aids, not the source of truth. Source code and current
configuration decide behavior when they disagree with a map.

An active local automation named “Refresh workspace maps” runs daily at 03:00.
It uses a committed-source cursor and a diff-first workflow. A normal run is
supposed to capture one immutable repository target, inspect the committed
changes since the previous cursor, update only affected maps, run integrity
checks, save a recovery patch, and advance the cursor only after verification
and patch persistence succeed.

The review's conclusion is therefore conditional:

- The navigation concept is viable at the current repository size.
- The current maintenance protocol is not yet strong enough for substantially
  more domains, more daily churn, or more concurrent writers.
- The most important missing capability is durable state that distinguishes
  “this interval was attempted” from “this interval is completely accounted
  for.”
- A larger model, a more frequent schedule, or a single generated file would
  not fix lost state, ambiguous ownership, incomplete validation, or unsafe
  publication.

The first safety slice is now implemented in
[`scripts/workspaceMapRefreshState.ts`](../../scripts/workspaceMapRefreshState.ts)
and covered by
[`scripts/workspaceMapRefreshState.test.ts`](../../scripts/workspaceMapRefreshState.test.ts).
It adds a versioned refresh manifest, fail-closed cursor classification,
target-bound validation, exact map-byte snapshots, a small completion-audit
attestation, a cooperative refresh lock, and explicit recovery for interrupted
or published-but-not-memory-updated runs. The installed “Refresh workspace
maps” automation now invokes this protocol while retaining its existing active
schedule and project scope.

### Terms used in this document

| Term | Meaning |
|---|---|
| Incremental coverage | The committed source interval from a valid cursor through a captured target commit has been inspected and accounted for. |
| Baseline coverage | The maps have been audited against a known source tree without treating a short lookback as proof of all earlier history. |
| Structural coverage | Each relevant domain has an intentional route and the map hierarchy and index are internally consistent. |
| Semantic coverage | A route leads to the actual current owner and its claims describe the behavior accurately. |
| Pending work | A changed path, new domain, stale reference, or structural issue that has been identified but not yet verified and published. |
| Complete run | All selected source changes and required recovery work are accounted for; the cursor can safely advance. |
| Provisional route | A temporary route through an existing parent map that keeps a new area discoverable while a focused map is pending. |

These distinctions are important because a green validator result proves only
the checks implemented by that validator. It does not prove semantic
ownership, complete historical coverage, or successful execution of every
scheduled run.

## Operating model under review

The refresh prompt describes the following lifecycle:

```text
capture immutable target
        ↓
load and validate cursor
        ↓
choose exact range, merge-base range, or explicit fallback
        ↓
route changed paths through WORKSPACE_MAP.md
        ↓
inspect focused maps and committed source owners
        ↓
make the smallest supported map edits
        ↓
run map, link, whitespace, path, and orphan checks
        ↓
save the cumulative recovery patch
        ↓
advance memory cursor only after all required work passes
```

The external state artifacts are:

| Artifact | Intended role | Gap exposed by this review |
|---|---|---|
| `/Users/pt/.codex/automations/refresh-workspace-routing-map/memory.md` | Human-readable run history and the latest processed source SHA | It remains a five-entry prose log; the helper now writes it only after a complete, target-bound publish, but it is not the machine-readable work manifest. |
| `/Users/pt/.codex/automations/refresh-workspace-routing-map/last-run.patch` | Recovery copy of current uncommitted map changes | The helper writes an exact, checksummed current artifact and associates it with the run manifest; the patch is still a recovery artifact, not a complete semantic audit. |
| `manifest.json`, `last-run.snapshot.json`, and `last-run.patch` in the same state directory | Durable run identity, coverage mode, pending paths, validation result, exact map postimage, completion attestation, and recovery patch | This deliberately keeps one current transaction instead of maintaining a second immutable artifact history. It does not provide per-domain registry records or automatic semantic ownership proof. |

The safety boundary is equally important: uncommitted source changes belong to
other work and must not become durable map claims. A failed verification must
leave the cursor unchanged so the source interval can be retried.

## Evaluation criteria

The question is not merely whether the maps can hold more lines. The question
is whether an agent can still reach the correct source owner as file count,
domain count, daily changed paths, state loss, and concurrent editing all grow.

I evaluated five properties:

1. **Discoverability:** a task reaches its likely owner without loading the
   entire map set or beginning with a broad search.
2. **Integrity:** concrete paths, links, map-index rows, and refresh dates are
   valid against the intended source tree.
3. **Completeness:** a successful cursor means the selected committed interval
   was actually accounted for, including structural gaps and recovery work.
4. **Resumability:** an interrupted or oversized run can continue from
   verified partial progress instead of repeating the same interval.
5. **Publication safety:** concurrent edits and crashes cannot silently pair a
   cursor with an unverified map generation.

The design is scalable only if all five properties hold. A system that routes
well but loses state, or validates paths while topology decays, eventually
becomes a misleading routing layer.

## Scope and evidence

This is a structural review, not a line-by-line certification of every behavioral statement in every map. I inspected the [supplied prompt](/Users/pt/.codex/attachments/ebaf0c34-09f4-457b-9284-7f6c12ee1249/pasted-text.txt), installed automation configuration and five retained memory entries, map inventory and selected map contents, and the production map validator and its tests. The initial review did not execute a scheduled refresh or change existing map, source, automation prompt, or automation state. The implementation follow-up added the refresh helper and updated the automation prompt, but still did not execute the live refresh against the shared working tree.

The installed automation is active and is configured for every day at 03:00. At the time of the initial review its prompt matched the supplied attachment; the implementation follow-up updated that prompt with the durable refresh-state protocol. Configuration was inspected at `/Users/pt/.codex/automations/refresh-workspace-routing-map/automation.toml`. Schedule configuration does not prove that every scheduled run executed successfully. The retained memory entries are successful-run claims, not independently replayed execution evidence.

Repository inventory was measured at commit `d1787d916eee3de75d443b232a87db1d09c5fe6f`. Map measurements describe the working files inspected during this review; 11 map files already had uncommitted edits belonging to existing work.

| Measurement | Observed |
|---|---:|
| Tracked repository files | 3,809 |
| Tracked files under src and app | 3,039 |
| Main router | 89 lines, 961 whitespace-delimited words |
| Focused maps | 17 |
| Entire map set, including router | 3,570 lines, 41,394 words, about 372 KB |
| Largest focused map by words | codex-core.md: 3,404 |
| Desktop map | 145 lines, 3,016 words |
| Most recent recorded processed batch | 97 commits, 211 distinct changed paths |
| Current validator result | 18 maps, zero errors, seven warnings |

The recorded batch spans `24b4027c37977f1307116c0d7a71d89af3f1b3f0..8a20b7254e0a6ed6e1038c97ce4f4d82c8cfefef`. It demonstrates a nontrivial batch size, not measured runtime or model-context headroom.

## Implemented safety slice

The review recommended starting with durable state and conservative
publication. That slice is now present and is intentionally smaller than a
full routing-registry redesign.

### Simplification decision

The first implementation carried a history of immutable manifests, snapshots,
and patches in parallel with the current files. That was unnecessary for this
single scheduled job: the current manifest already binds one exact snapshot
and one recovery patch, while `memory.md` retains the five human-readable run
entries. The helper now keeps only those current transaction files and uses
the manifest's checksums for recovery. It also removed separate baseline and
divergence boolean flags; a complete publish requires one audit input whose
run ID, target, coverage mode, path set, and clean path/orphan results are
validated and then stored in the manifest.

### State machine

Each run is identified by a run ID and a captured target commit. The helper
stores the following lifecycle in the current `manifest.json`:

```text
in-progress → blocked
in-progress → published → complete
                       ↘ blocked
```

`complete` is the only state that writes a new `Processed source SHA:` entry
to `memory.md`. `blocked` preserves pending paths, structural work, validator
output, and the exact map snapshot without moving the cursor. `published` is a
crash boundary: it means the snapshot and patch are durable, but memory still
needs to be completed or recovered.

### Cursor policy

The cursor classifier has three important outcomes:

| State evidence | Coverage mode | Normal cursor advance |
|---|---|---:|
| Valid commit and ancestor of the captured target | `incremental` | Allowed after complete publication |
| Valid commit but divergent history | `divergence-pending` | Refused until explicit reconciliation |
| Missing, malformed, or invalid cursor | `baseline-partial` | Refused until a full-tree audit attestation |

The old timestamp/lookback idea is retained only as a way to prioritize model
inspection. It cannot establish a trusted normal cursor.

### Exact publication protocol

The helper performs these mechanical checks before completing a run:

1. It records repository identity, branch, target SHA, cursor basis, initial
   map digests, and validation-input fingerprints.
2. It validates current map files while resolving source citations against an
   extracted copy of the captured target tree.
3. It captures the final map files as base64 postimages with per-file hashes
   and a snapshot hash.
4. It reconstructs those postimages in an isolated directory and compares
   every path and byte with the captured working tree.
5. It rechecks the target, branch, repository identity, validator inputs, and
   map stability before writing durable artifacts.
6. It writes the exact snapshot and a checksummed recovery patch, then
   publishes the manifest. Only a complete result updates memory.

The helper rejects symlinked map files, symlinked state directories, unsafe
artifact paths, target drift, validation-input drift, snapshot drift, and
artifact checksum mismatches. Recovery refuses to advance memory if current
map bytes no longer match the published snapshot; a matching refresh date is
not treated as proof that substantive edits survived.

### Scope of the slice

This implementation closes the most dangerous state-management paths, but it
does not claim to solve every scalability finding. The full path audit remains
a model-assisted check described by the automation prompt, and there is not
yet a declarative domain registry, automatic shared-contract fan-out, bounded
per-domain queue, or structural split/merge workflow. Those remain visible
follow-up items rather than being silently represented as complete coverage.

The scheduled automation was updated through the Codex app's automation
control and remains active with its existing daily schedule, model, project,
and working directories. A live refresh was deliberately not executed during
this implementation pass because the repository currently contains active
uncommitted map and source edits from other work; running it would turn those
edits into a real external run record rather than a test fixture.

### What the current green validator result does and does not prove

The existing validator is useful, but its guarantee is narrower than the
refresh prompt's full path-integrity requirement:

| Check | It currently establishes | It does not establish |
|---|---|---|
| Map index | Focused maps are indexed and index links point to existing map files | That the route is semantically correct or that nested maps were discovered |
| Refresh dates | Focused-map dates agree with their index rows | That the map received a complete domain review |
| Local links | Referenced link targets exist | That a heading fragment exists; fragments are currently stripped before validation |
| Backticked repository paths | Many literal paths under `app/`, `docs/`, `scripts/`, and `src/` are checked | Shell brace/glob expansion, every possible repository root, or ownership |
| Canonical sections | Missing sections are reported as warnings | A warning is a failure, a backlog item, or evidence that the section content is useful |
| Source ownership | Nothing beyond path existence | That a file owns the behavior described by the map |

Therefore “18 maps, zero errors” means the implemented structural checks passed
for the working tree. It does not mean that all map routes are current, that
all changed paths were semantically assigned, or that the scheduled job has
successfully run every day.

## What already works

- Progressive reading: [WORKSPACE_MAP.md](../maps/WORKSPACE_MAP.md) tells an agent to select a focused map and then verify source. Ordinary tasks need not load all 41,394 words.
- The prompt captures an immutable source commit, processes a commit range, excludes uncommitted behavior from new claims, and checks cursor ancestry.
- It explicitly handles renames, deletions, previous uncommitted map edits, verification failures, and recovery-patch persistence before advancing the cursor.
- A source change is not automatically a reason to expand documentation. Small, source-supported route edits are the right default.
- Canonical sections, small initial entry lists, and synchronized index dates are useful navigation conventions.

Keep these properties. More frequent execution or a larger model would not close the structural gaps below.

## Findings

### F1 — High: the job can maintain existing buckets but cannot complete structural growth

**Evidence:** supplied prompt, lines 93 and 99–101, requires a routing entry for an unmapped subsystem but leaves its focused map for manual creation; it otherwise preserves map structure and makes the smallest edit. [WORKSPACE_MAP.md:73](../maps/WORKSPACE_MAP.md#maintenance-rules) permits creating sub-maps, so the automation is narrower than the map design. There is no explicit split/merge rule or durable unresolved-subsystem queue.

**Failure scenario:** several new desktop domains appear. They are classified under the broad existing desktop map, which grows by dense table rows, or flagged once for manual work and then left behind when the cursor advances. A broad parent route is useful provisional coverage, but does not establish a sufficiently focused owner route.

This pressure is already visible in [web-app-runtime.md](../maps/web-app-runtime.md): one map covers host registry, peer sessions, IPC/security, sidecar lifecycle, history/cache, catalog workers, renderer shell, transcript/composer, and rendering preferences. Its five initial bullets expand to 14 files. Line count and row count alone understate reading cost.

**Disposition:** map-maintenance owner should allow creating and splitting focused maps within the existing maps scope, with explicit index updates and validation. Add a domain layer when needed: root router → desktop router → lifecycle, session-history, transcript/composer, and related leaf maps. Logical hierarchy can initially use flat filenames. Nested directories require changing both the prompt's allowed file scope and validator discovery. Remove the fixed “17 focused maps” count in [CLAUDE.md:61](../../CLAUDE.md) when changing the map set.

### F2 — High: recovery can declare a complete cursor without establishing a complete baseline

**Evidence:** the initial supplied prompt, lines 53–57, compared a divergent cursor through a merge base and fell back to a timestamp or 30-hour lookback when the cursor was absent or invalid. Line 161 defined the eventual cursor as committed source through the target having been processed.

**Failure scenarios:**

- Lost state plus a stale route to an existing file changed a week ago: a 30-hour scan and path-existence checks cannot establish that route's correctness. Advancing the cursor can leave the older drift unexamined indefinitely.
- A previous branch moved ownership from file X to existing file Y, and the target branch still uses X. A merge-base-to-target diff can omit this branch-only change, even though working maps still describe Y. Both paths exist, so orphan detection does not help.

These are logical counterexamples to the prompt's coverage claim, not observed failures in the retained runs.

**Disposition:** the first safety slice now distinguishes `incremental`,
`baseline-partial`, and `divergence-pending` in a durable manifest. Missing
state cannot advance the normal cursor without an audit attestation covering
the full pending path set, and divergence cannot advance without an explicit
reconciliation attestation. Branch-specific tree reconciliation and a
resumable per-domain baseline queue remain follow-up work.

### F3 — Medium: one all-or-nothing cursor creates repeated work and accumulating backlog

**Evidence:** prompt lines 123–145 gate all persistence on global path verification and retain only five prose memory entries. There is no saved pending-path list, completed-domain list, batch limit, or partial-progress checkpoint. The historical batch above already contained 211 changed paths.

**Failure scenario:** a large merge, long outage, or unrelated map conflict prevents final success. The next run repeats the same source interval and recovery reasoning, now with more changes added. An unchanged pre-existing orphan can hold up every domain. Keeping the final cursor unchanged is correct; failing to retain verified partial progress is the avoidable cost.

**Disposition:** the first safety slice now persists fixed base and target
SHAs, changed and pending paths, structural blockers, validation output, exact
map postimages, and recovery artifacts. A blocked run leaves the global cursor
unchanged and is recoverable as a durable checkpoint. An audit attestation
must cover the exact pending path set before completion. Completed domains and
bounded batch scheduling are not yet modeled separately, so this
is resumable at the run/checkpoint boundary rather than a full per-domain
queue.

### F4 — Medium: essential audit behavior is prose-defined and not covered by the reusable validator

**Evidence:** [workspaceMapLint.ts](../../scripts/workspaceMapLint.ts) recognizes four directory roots and four root files (lines 17–18), skips command-like spans and brace/glob forms (lines 70–75), validates existence in the live working tree (line 138), and discovers only top-level map files (lines 97–100). Link fragments are stripped rather than checked (line 37). Required section names produce warnings, not errors (lines 151–154).

Isolated fixtures exercised the exported production validator:

| Fixture | Actual result |
|---|---|
| Missing literal src path | Rejected |
| Missing test path inside a shell command | Passed |
| Missing paths in a brace expression | Passed |
| Missing path under a new packages root | Passed |
| Link to a nonexistent heading | Passed |
| Unindexed nested map containing a missing path | Ignored; passed |
| False ownership prose referring to an existing file | Passed |

These were temporary examples, not discovered missing production paths. Existence lint cannot prove behavioral ownership; source inspection remains necessary. The prompt correctly requests a separate path audit. The first safety slice adds target-tree input to the reusable validator and requires a completion attestation, but it does not yet implement the prompt's complete extraction and routing audit. The retained memory claims different candidate counts without enough detail to reproduce the extraction rules.

**Disposition:** the validator now accepts an immutable `sourceRoot`, and the
refresh helper validates map citations against an extracted target tree while
returning machine-readable results in the manifest. The broader path audit
still needs a reusable extractor for shell forms, repository-root categories,
heading fragments, and nested-map discovery. Retain source review for
semantic claims; do not interpret the current green result as complete path or
ownership coverage.

### F5 — Medium: concurrent edits and recovery are not an atomic publication protocol

**Evidence:** prompt steps 6–8 verify live map files, then overwrite one cumulative patch containing even other sessions' map changes, then append memory. They require caution but specify no content hashes, final compare-and-swap check, generation identity, or crash-safe association between patch and cursor.

**Failure scenario:** another session edits a map between verification and patch capture. The saved patch can contain content that did not pass the checks. Or interruption between replacing the patch and writing memory leaves two state files describing different generations. Larger batches and more writers increase exposure; this review did not reproduce a race.

**Disposition:** the first safety slice now records source SHA, validation-input
fingerprints, map postimage hashes, and patch/snapshot artifact hashes in the
current manifest. It uses a cooperative refresh lock, rechecks
target and map stability, and fails closed on drift. The lock still does not
coordinate unrelated editor sessions; concurrent map edits are detected and
must be manually reconciled rather than automatically merged.

### F6 — Medium: structural debt can persist indefinitely while every run passes

**Evidence:** current lint reports seven missing-section warnings across five maps; the same warning count is recorded from August 25 through September 5. [ide-lsp.md](../maps/ide-lsp.md#first-files-to-inspect) has 12 initial routing rows, and [config-persistence.md](../maps/config-persistence.md#first-files-to-inspect) has eight. [build-release-testing.md:17](../maps/build-release-testing.md#refresh-checklist) still tells readers to read CLAUDE.md first, despite the prompt forbidding adding that instruction. Its presence is existing cleanup debt, not proof the latest run introduced it.

**Failure scenario:** diff-only refreshing keeps file references current while maps become increasingly broad, repetitive, and inconsistent. Old dates alone are not evidence of staleness, but current dates alone do not establish a complete review either.

**Disposition:** map-maintenance owner should add a bounded structural audit, alongside the daily change refresh, for unmapped domains, overlapping ownership, oversized leaf maps, navigation loops, and canonical-section debt. Track baseline warnings explicitly so they have a resolution path. Distinguish “updated through source SHA” from “last complete domain review.”

## Recommended design and order

Use three cooperating mechanisms: the **existing daily schedule** triggers maintenance; **deterministic repository tooling** inventories, routes, validates, and checkpoints; a **versioned refresh procedure** guides the model's source review and concise edits. Adding a skill alone would not guarantee the mechanical checks.

### Target operating model

#### 1. Declarative routing registry

Introduce a small registry of stable domain records. The exact file location
can follow existing repository conventions, but each record should define:

| Field | Purpose |
|---|---|
| Domain ID | Stable identity that survives a focused-map filename change. |
| Path prefixes and overrides | Deterministic changed-path-to-domain lookup, including shared contracts. |
| Map path | The current focused map or domain-router location. |
| Parent domain | Optional third navigation level without requiring nested files immediately. |
| Important shared contracts | Files whose changes should notify more than one domain. |
| Explicit exclusions | Generated, vendored, historical, or otherwise non-routable paths. |
| Review status | Structural debt, manual follow-up, or suppression state. |

Do not put every repository file into a hand-maintained registry. Prefixes and
small explicit overrides are enough for routing; source inspection remains the
authority for exact ownership. The registry should drive both changed-path
routing and map-index consistency so the prompt, index, and validator do not
silently develop three different inventories.

#### 2. Resumable refresh manifest

Keep the five-entry prose memory log for humans, but add a machine-readable
manifest for work that must survive interruption. At minimum it should record:

| Field | Required meaning |
|---|---|
| Schema version | State-format changes are explicit and rejectable. |
| Repository identity | A cursor cannot be reused for another checkout or repository. |
| Branch and target SHA | Identifies the immutable target of the run. |
| Cursor before the run | States the source position before any work began. |
| Coverage mode | `incremental`, `baseline-complete`, `baseline-partial`, or `divergence-reconciled`. |
| Comparison basis | Exact range, merge-base range, or fallback reason. |
| Changed paths | Normalized additions, modifications, deletions, and renames. |
| Per-domain status | `pending`, `verified`, `blocked`, or `not-applicable`, with evidence. |
| Structural queue | New domains, split/merge work, warnings, and unresolved orphans. |
| Map snapshot hashes | Hashes of maps read and maps produced. |
| Patch generation/hash | Identifies the recovery snapshot associated with the manifest. |
| Verification result | Commands, counts, and timestamp for the completed checks. |

The global cursor remains conservative: it advances only when no required
domain or structural item is still pending. A `baseline-partial` manifest can
be resumed, but it cannot be treated as an ordinary incremental cursor.

#### 3. Coherent publication

The refresh should behave like a small transaction over documentation state:

```text
capture target → load/create manifest → process bounded batch
    → validate against target SHA → recheck touched-map hashes
    → write immutable patch generation → write manifest for that generation
    → advance cursor only if the manifest is complete
```

If a touched map changes during the run, re-read and re-validate that domain.
If publication is interrupted, the previous generation must remain recoverable
until the new manifest and patch are both durable. A lock around refresh runs
alone is insufficient because unrelated editor sessions can still change a
map.

#### 4. Topology and split policy

Use a third navigation level only when it reduces reading cost:

```text
root router → domain router → leaf map or source owner
```

The existing five-to-seven-row guidance for `First Files To Inspect` is a good
starting constraint, but not a universal law. Split a map when several signals
agree: its starting files repeatedly exceed the intended set, it mixes
multiple lifecycle or trust-boundary concerns, tasks in one part rarely need
the rest, or route overlap makes ownership ambiguous. Merge maps when they have
the same owner and validation boundary and consistently co-occur in real task
samples. Record the reason for either decision.

#### 5. Separate daily refresh from structural review

| Mode | Frequency | Primary question | Cursor effect |
|---|---|---|---|
| Incremental | Daily | Did committed changes receive accurate routes? | May advance the normal cursor when complete. |
| Recovery/baseline | When state is missing or divergent | Is the map set grounded in a known source tree? | Creates or completes a baseline manifest. |
| Structural | Bounded periodic run | Is the topology still useful and internally consistent? | Must not hide pending structural debt. |

This separation keeps the daily job small while ensuring that topology is not
checked only when a changed file happens to expose it.

### Operational decision rules

| Situation | Required action | Cursor may advance? |
|---|---|---:|
| Valid cursor is an ancestor of the captured target | Process the exact cursor-to-target range | Yes, if all work completes |
| Cursor is missing or invalid | Start a baseline or explicitly partial-baseline manifest | Not from a short lookback alone |
| Cursor is valid but divergent | Compare the merge base and branch-specific tree differences | Only after reconciliation |
| Changed path maps to an existing domain | Inspect the focused map and source owner; make the smallest supported edit | Yes, if the domain verifies |
| Changed path introduces a new domain | Create a focused route if allowed; otherwise retain a provisional route plus durable pending item | Not while silently unresolved |
| Path was renamed or deleted | Search all maps and remove or label historical references | Only after references are accounted for |
| Validator or path audit fails | Fix the issue or stop without publishing the new cursor | No |
| Touched map changes during the run | Re-read, re-validate, and retry that domain | Not from the stale read |
| One domain is blocked while others verify | Persist verified partial progress and the blocker | No global advance until complete |

### Acceptance criteria for the proposed changes

The maintenance system should not be called scalable until it can demonstrate
all of the following:

- a new subsystem produces either a focused map or a durable pending item with
  its provisional route, candidate owners, and reason for deferral;
- missing state is labeled as baseline work rather than silently promoted from
  a recent lookback to full coverage;
- an interrupted run resumes verified domains without advancing the global
  cursor early;
- identical committed-tree and map inputs produce identical machine-readable
  path-audit results;
- a concurrent edit causes a hash mismatch and re-read rather than stale
  publication;
- a crash between patch and state writes leaves either the previous coherent
  generation or the new coherent generation recoverable; and
- every structural warning is resolved, explicitly suppressed with an owner
  and reason, or present in a durable backlog.

1. Extend the validator and introduce a small declarative registry of stable domain IDs, path prefixes/overrides, map locations, important shared contracts, and explicit exclusions. Derive changed-path-to-map lookup and map index consistency from this registry. Avoid a prose inventory of every file.
2. Add baseline state, resumable work manifests, and coherent patch publication. Report completion, pending work, and unresolved coverage separately.
3. Normalize the seven existing section warnings and split the broad desktop map into appropriate leaf maps when editing the structure. Keep the main router compact and allow a useful third navigation level.
4. Add a bounded periodic structural review. Use map word count, expanded initial-file count, route overlap, unresolved domains, and actual navigation success to decide when to split. Establish budgets from representative tasks rather than asserting an unmeasured universal limit.

Validate future changes with realistic cases: new subsystem, new top-level package, large rename, shared contract change, missing cursor, branch divergence with both paths still existing, interrupted large batch, concurrent map edit, and crash between patch and state publication. For navigation, sample real tasks and measure whether an agent reaches the correct owner through the intended route without broad searching.

The cases should have observable pass conditions, not only prose review:

| Scenario | Expected result | Evidence |
|---|---|---|
| New file in an existing domain | The correct focused map is selected and only supported route text changes | Registry route result and source-backed diff |
| New subsystem or top-level package | A route and durable structural item are created | Machine-readable pending/complete status |
| Large rename | Old references are found, classified, and removed or marked historical | Repository-wide stale-reference scan |
| Shared contract change | Every declared consumer domain is considered | Registry fan-out report |
| Missing cursor | Baseline mode is recorded; no silent lookback-to-complete promotion occurs | Manifest coverage mode |
| Branch divergence with both paths existing | Branch-specific ownership differences are compared | Merge-base and tree-difference evidence |
| Interrupted large batch | The next run resumes at the first pending batch | Manifest before/after interruption |
| Concurrent map edit | A changed hash causes a re-read and prevents stale publication | Hash-mismatch test |
| Crash between patch and state writes | A coherent old or new generation is recoverable | Crash-boundary replay |
| Broken heading or shell path form | The validator reports the candidate and why it was checked or skipped | Machine-readable validator output |
| Representative navigation task | The agent reaches the correct owner through the intended route | Task sample with route trace |

The first nine cases test maintenance correctness. The last two test whether
the documentation is useful to a reader rather than merely well-formed.

At ten times today's file count but similar daily change volume and domain structure, a diff-first workflow could remain practical. At ten times the domains or daily churn, the current flat buckets and all-or-nothing model pass are the limiting factors. This review did not benchmark either scenario, so no exact capacity or runtime claim is justified. A multi-repository workspace would additionally need repository-scoped cursors and identities; the installed prompt is explicitly single-repository.

The practical capacity metric is not “how many files exist.” It is whether the
system can keep this inequality true over time:

```text
verified work per refresh interval
    >=
new changed-path work + recovery work + structural-debt work
```

If the right side exceeds the left side for long enough, the durable queue
must make the backlog visible. The operator can then increase refresh capacity,
reduce scope, or explicitly accept that the maps are no longer a reliable
routing layer.

## Verification

### Initial review evidence

The original review established the baseline with the following evidence:

```text
VERIFICATION
- bun run maps:lint -> passed: 18 maps, 7 pre-existing warnings.
- bun test scripts/workspaceMapLint.test.ts -> 5 pass, 0 fail, 10 assertions.
- Isolated production-validator fixtures -> missing literal rejected; six broader cases passed or were ignored as described above.
- git -c core.fsmonitor=false diff HEAD --check -- docs/maps -> clean.
- git -c core.fsmonitor=false diff --check -> clean.
- New report whitespace check -> no diagnostics; no-index status 1 reflects the added file.
- Report link/heading validation -> eight relative links passed; supplied prompt attachment exists.
Stale-reference sweep: no renames/removals were made; report references checked separately.
Not run in the initial review: a full scheduled refresh, all-map semantic certification, large-repository benchmark, and concurrency/crash replay.
```

The initial report was a dated historical review. Future refresh work should
re-measure the inventory and rerun the verification commands rather than
copying these counts forward.

### Implementation follow-up evidence

```text
VERIFICATION
- bun test scripts/workspaceMapLint.test.ts scripts/workspaceMapRefreshState.test.ts -> 20 pass, 0 fail, 56 assertions.
- bun run lint:undefined-names -> passed: 0 undefined names.
- bun run build:dev:full -> passed; map lint reported the same 7 existing warnings, and the dev bundle/version command completed.
- Refresh-state fixtures -> covered missing/divergent cursors, newest-cursor selection, exact snapshot reconstruction, map/state symlink rejection, audit-gated publication, blocked checkpoints, published-run recovery, and interrupted-run recovery.
- Target-bound validator fixture -> passed; a missing source path in an immutable source root was rejected.
- Automation update -> existing “Refresh workspace maps” job updated successfully and remains ACTIVE with its prior schedule, model, project, and working directories.
- Live refresh -> intentionally not run against the shared working tree; current map and source edits belong to concurrent work and were preserved.
```

The implementation follow-up validates the safety slice, not the entire
scalability proposal. The declarative routing registry, full path extractor,
automatic shared-contract fan-out, bounded per-domain queue, structural
backlog, and realistic multi-process crash/race replay remain unverified and
are explicitly deferred.
