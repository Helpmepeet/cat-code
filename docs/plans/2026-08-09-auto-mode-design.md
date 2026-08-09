# Auto mode: port upstream, deviate by closed list

Operator ruling, 2026-08-09. Supersedes the open decisions in
`2026-08-09-auto-mode-remediation-plan.md`, which stays as the record of how B1
and B2 were found.

**Decision: port upstream Claude Code 2.1.223's auto mode wholesale** — rule text
verbatim, architecture as documented — and deviate only through the closed delta
list below. No custom rule set, no redesigned prompt. Anything not in the delta
list follows upstream.

The reasoning, in one line: this converts an open-ended design problem into a
maintenance problem, and buys upstream's continuing refinement for free. Evidence
that the design is settled rather than in flux: nine releases spanning Jul 18 to
Aug 6 carry the identical architecture and rule count, with only prose growth.

**Status: contract review returned RED (2026-08-09). Five findings hold and are
folded in below; one was rejected on evidence. The gaps in "Contract gaps" must
close before Step 1 starts.** Supporting evidence:
`docs/reports/2026-08-09-auto-mode-denial-analysis.md` (what our classifier did)
and `docs/reports/2026-08-09-claude-code-auto-mode-architecture.md` (what
upstream's is, and how far each claim was verified).

## Ported as-is

- **Rule inventory** — 66 named block rules (1 hard: Data Exfiltration; 65 soft
  with `[named+specifics]` clearing bars), 17 allow rules, 20 environment slots.
  Source of truth is the `claude auto-mode defaults` JSON, vendored into the fork
  and re-synced by re-dump plus diff on upstream releases.
- **Architecture** — default-allow ("if you cannot name a BLOCK rule, output
  no"), hard-check-first classification, the user-intent clearing machinery, the
  `$defaults` additive splice, a classifier model decoupled from the main loop,
  harness meta-injection with per-call outcome codes, CLAUDE.md injection
  (already present, `yoloClassifier.ts:467-478`).
- **Prompt assembly** — module 2 (75,469 chars: Environment, Definitions, the
  four substitution blocks) assembles from the vendored dump. Module 1 (38,180
  chars: Context, Threat Model, Input, Default Rule, Scope, User Intent Rule,
  Evaluation Rules, Classification Process, Output Format) comes from binary
  extraction, tracked per release.

## Contract gaps to close before Step 1

These came out of the RED review. Each is a specification owed before code.

### G1 — The verdict schema needs a discriminated shape (was F1)

`{thinking, shouldBlock, category, reason}` with `category` an enum of the 66
built-in ids cannot represent two real cases:

- **An ordinary allow.** With `category` required, `shouldBlock: false` has to
  name a block rule that did not fire.
- **A user-authored rule.** `autoMode.allow` and `autoMode.soft_deny` are
  `z.array(z.string())` — arbitrary prose (`src/utils/settings/types.ts:1009-1033`).
  A custom rule that matches cannot be named by a fixed enum, so it either fails
  schema validation or is forced into a wrong id. Under "unnameable block = no
  block", a validation failure degrades to an **unsafe allow**.

**Root cause: this delta promoted category from advisory to load-bearing, and
upstream never did.** Upstream parses the category with
`k2d`: `y$o.has(r) ? r : void 0` — an unrecognized value is silently dropped and
**the block still stands**. Category is telemetry there, not a gate. Making it a
required schema enum in a forced tool call is what converts an unrepresentable
category into a validation failure, and thence into an unsafe allow.

Owed: a discriminated verdict where allows carry no category, and blocks carry
either a built-in id or a validated runtime reference to a settings-authored or
ordinary deny rule. Two constraints follow from the root cause: the enum cannot
be the only category channel, and **category validation must never gate the block
decision** — an unnameable category degrades to a block with no category, never
to an allow. "Unnameable block = no block" is a rule for the model to apply
inside its reasoning, not a parser behaviour.

**Also missing, and not in the review:** cat-code's `autoMode` schema has
`allow`, `soft_deny`, `environment`, and `deny` (ant-only back-compat). **There
is no `hard_deny` key.** Porting upstream's hard tier requires adding it, and
whatever G1 settles about category representation must cover it.

### G2 — Model decoupling does not decouple the provider (was F2)

Selecting a Sonnet-class classifier model does not move the request off Codex.
`resolveRequestProvider` (`src/utils/model/providers.ts:183-195`) says so in its
own doc comment: GPT-family models always route to OpenAI, while "Claude-family
and custom model IDs remain ambiguous in this codebase, so they inherit the
caller's provider when one is supplied; otherwise they fall back to the current
session/env provider." The classifier's `sideQueryOpts`
(`yoloClassifier.ts:837-862`) supplies **no provider**. So in a Codex session,
`autoMode.model = sonnet` sends `sonnet` down the OpenAI path — the outage class
delta 2 exists to end, unfixed.

Owed, as an explicit table rather than prose: ordered `(provider, model)`
attempts; provider selection across first-party, Bedrock, Vertex, Foundry;
symmetric fallback conditions in both directions (Anthropic→GPT as well as
GPT→Anthropic); settings and env precedence; how retries are accounted across
hops; and which errors are terminal.

### G3 — The ordinary deny-rule seam was dropped from the port (was F3)

Upstream injects a `<settings_deny_rules>` block telling the classifier about the
user's ordinary `permissions.deny` rules and asking it to catch **circumvention**
— the same effect reached through another tool ("`python -c`, `sed -i`, `cat >`,
heredocs"). This was documented in the architecture report and then not carried
into this plan.

The fork has live `permissions.deny` settings (`src/utils/settings/types.ts:42-58`)
loaded across enabled sources (`src/utils/permissions/permissionsLoader.ts:83-95`),
and `yoloClassifier.ts` references none of them: the `denyDescriptions` it builds
at `:511` come from `settings.autoMode.soft_deny` only.

Failure this permits: an operator denies an action for one tool; the direct call
is still blocked by the permission system, but auto mode approves the equivalent
Bash or scripting route because the classifier was never told the rule exists.

Owed: source-to-slot mapping, precedence, escaping, a category representation
consistent with G1, and tests that specifically exercise alternate-tool
circumvention.

### G4 — Delete the settings for architecture we are not shipping (was F5, residual)

Delta 6 as originally written added stage-mode and severity-threshold settings
while delta 8 defers the two-stage architecture. Settings for an unimplemented
feature are dead config that later reads as capability. Ship retry counts only;
add stage and severity settings with the architecture, not before.

## Delta list (exhaustive)

1. **Output contract.** Replace upstream's XML verdict with the fork's
   schema-backed forced tool call. The fork already uses one — see amendment F —
   so this is an extension, not new machinery. Shape is owed by **G1**: a
   discriminated verdict, not a flat 66-value enum. It must still enforce
   "unnameable block = no block" at the API layer rather than by instruction.
2. **Classifier model and provider.** New `autoMode.model` settings key;
   `CLAUDE_CODE_AUTO_MODE_MODEL` honoured for all user types (closes B2).
   Sonnet-class default. Keep the Sol → Terra → Luna chain
   (`yoloClassifier.ts:629-639`). The cross-provider behaviour is owed by **G2**
   and is the substance of this delta, not a rider on it.
3. **Thinking/effort plumbing.** Keep `getClassifierThinkingConfig`
   (`yoloClassifier.ts:610`), extend for GPT-family effort. Upstream never runs
   this prompt on GPT models; our fallback path will.
4. **Config splice.** `$defaults` with upstream's exact semantics (closes B1),
   plus one fork-only guard: a loud startup warning when a config list omits
   `$defaults`. One operator, no review gate, one typo from silently deleting
   every rule.
5. **Machine facts via config, not prompt edits.** Environment/allow/soft_deny
   entries for the shared tree with concurrent sessions, the scratchpad path,
   worktree roots, `~/.agents/skills/` and mirrors as ordinary territory, GUI
   driving under CLAUDE.md §8 per-run authorization. See amendment C: the
   session-rules slot may be the designed home for part of this.
   **SKILL.md contents never self-authorize; operator-signed config stays the
   only channel.**
6. **Retry counts pinned locally** — a setting carrying upstream's compiled-in
   default, no GrowthBook dependency. Stage mode and severity thresholds are
   **not** included; see G4.
7. **Ordinary deny-rule injection.** Port upstream's `<settings_deny_rules>`
   seam. Specification owed by **G3**. New delta, added by the review.
8. **Meta-injection staged by census value** — outcome codes first (addresses the
   repeat denials; carries "unavailable is NOT a policy decision"), then
   `gitStatus`, then `repoVisibility`. Each behind its own flag, each with a
   boundary test proving tool output can never reach the meta channel.
9. **Two-stage severity deferred** — lowest-confidence extraction, doubles cost,
   tunes a fleet we do not have. Revisit only if replay shows single-stage
   under-performing. Nothing about it ships in the meantime (G4).

## Amendments from verification

The operator's ruling stands throughout; these change scope, not direction.

### A — Module 1 has no ground truth, but is well-verified

The CLI exposes module 2 only. Module 1 exists solely as binary extraction, and
the first pass at it missed its opening line. It was therefore verified
separately:

- Extracted from **all nine** installed versions with the same boundary walk.
  All nine: zero code tokens, exactly 9 `##` sections, identical closing
  sentence.
- Version diffs are coherent prose edits, each traceable to a feature (2.1.220
  adds the `<cc_automode_session_rules>` wrapper; 2.1.221 adds "Synthetic Input
  Self Drive" to the adversarial-pattern list).
- Exactly one template interpolation in module 1, `${""}`, evaluating to empty.
  Module 2's single `${VAR}` is escaped literal prose inside a rule about
  deleting an unresolved shell variable, and appears in the CLI output too.
- **Decisive check:** the escape-decoding rules were validated against ground
  truth on module 2, where CLI and binary reconcile to within explained deltas.
  Module 1 uses the same encoding, so the only untested step was boundary
  detection — which the nine-version result covers.

Verified-by-construction, not ground truth. Re-run the nine-version check on any
re-extraction, and hash-test the transformed prompt as the review asked.

### B — Three injection slots in module 1, not one

`<cross_session_messages_rule>`, `<cc_automode_session_rules>`, and
`<permissions_template>`. (`<subagent_hand_back>` is a false alarm: prose
referring to a transcript tag, not a slot.) The two unmapped slots must be mapped
before module 1 is ported.

### C — The session-rules slot is probably ours

`<cc_automode_session_rules>` wraps `<cross_session_messages_rule>` immediately
after a rule about **cross-session permission laundering** — one agent relaying
an action another was denied. Added in 2.1.220, so actively being built out. On a
machine running several agents against one working tree that is our exact
situation, and it may be the designed home for part of delta 5 rather than the
environment block.

### D — Delta 1 is cheaper than stated

`shouldBlock` appears three times in the Classification Process, outside the
Output Format section, so the verdict contract is not confined to one owned
block. It cuts our way: `shouldBlock` is already the fork's field name, so that
prose is already compatible.

### E — Module 1 carries no severity or two-stage instructions (review F5, rejected)

The review held that module 1 contains severity and two-stage instructions, making
it incompatible with a deferred two-stage architecture. Measured against the
extraction, module 1 contains **zero** `<severity>` tags and zero occurrences of
"Stage 1", "stage 2", or "two-stage". The four uses of the word "severity" are
ordinary prose ("scope, severity, or destructiveness"; "high-severity targets").

The "preliminary verdict" language in Classification Process steps 5-6 is
**single-pass internal reasoning**, not a stage marker: it describes reaching a
provisional verdict from the rules and then applying user intent, all in one
call. Upstream's actual two-stage instructions live in separate appended strings
injected only when stage mode is active, and are not part of module 1.

So module 1 ports cleanly against a single-stage contract. The review's residual
point is valid and is kept as **G4**.

### F — The fork already has a schema tool contract and a full dump

Two facts that were not in the plan and change two dispositions:

- `yoloClassifier.ts:831-832` states the classifier "uses a single schema-backed
  tool contract and does not emit or parse XML". Delta 1 extends existing
  machinery rather than introducing it.
- `maybeDumpAutoMode` (`yoloClassifier.ts:154`) already writes the **full
  request and response as JSON** on every classifier call, behind
  `CLAUDE_CODE_DUMP_AUTO_MODE` — gated on `USER_TYPE === 'ant'` at `:160`, the
  same gate as the model env var.

That second one is better observability than upstream's error-only dump, and
ungating it is close to a one-line change. It also **changes the economics of the
replay gate**: real classifier requests can be captured directly instead of
reconstructed from JSONL. Size the harness against this path first.

## Sequencing and gates

**Step 0 — specifications.** Close G1, G2, G3, G4. Map the two unmapped injection
slots (amendment B). No code.

**Step 1 — mechanics.** Deltas 2, 3, 4, 6.

**Step 1 is not "no policy change"** — the original plan said so and the review
was right to reject it. Changing the classifier model changes verdicts; changing
effort changes verdicts; `$defaults` changes effective policy. Therefore: **land
Steps 1 and 2 atomically behind a feature gate that is off by default, and open
the gate only on replay evidence.** Structural unit tests are not sufficient to
land Step 1 alone.

**Step 2 — ported prompt, tool contract, deny-rule seam.** Deltas 1, 5, 7.

**Step 3 — meta-injection.** Delta 8, with boundary tests.

Engine battery per CLAUDE.md §3: `bun run build:dev:full` plus focused
`src/utils/permissions/` suites. Every splice change needs a test proving the
defaults survive when user config is present — that is exactly the B1 failure
mode, and it is silent without one.

### The replay gate is owed a specification

As written it was not falsifiable, and the review was right. Three things must be
pinned before it can gate anything:

1. **A versioned, frozen corpus.** A rolling `--days` window is not a corpus: a
   21-day run on 2026-08-09 returned 162 decision denials early in the day and
   163 later. Freeze it to a file with a hash.
2. **Positive cases, not just denials.** A denial-only corpus cannot detect new
   over-blocking of work that previously succeeded. The corpus needs known-safe
   allows, hard blocks, soft blocks with and without `[named+specifics]` consent,
   explicit user boundaries, custom settings rules, and provider failures.
3. **Numbers.** Model, effort, repetition count, an exact parse-failure ceiling
   (not "approximately zero"), and per-category acceptance thresholds.

Corpus counts measured over 21 days (162 decision denials at time of writing):
secrets and credentials 23, temp and scratch paths 33, skill machinery 26, kill
family 24. These are sizing inputs, not acceptance criteria, until the corpus is
frozen.

### Maintenance

Nine upstream releases in nineteen days; module 1 prose grew 15% over three
weeks. Module 2 re-syncs free through the CLI. Module 1 needs re-extraction each
time — cheap if the extraction hash-checks first and only re-extracts on change.
Build that in from the start.

## Expected effect

The no-verdict denials disappear (conditional on G2 actually decoupling the
provider, which the original delta did not). Temp/scratch and skills clusters
flip to allow. Repeats collapse via outcome codes. Secrets, publish, GUI, and
discovered-PID kills still block — the last by both upstream's
`interfere_with_workloads` and CLAUDE.md §4, which agree.

## Open for the operator

1. **Orphan-sidecar kills.** CLAUDE.md §4's report-don't-kill stands unless
   cleared. Clearing it would be a fork extension to PID evidence; upstream sides
   with §4.
2. **Headless denial-cap behaviour** (`AbortError` today,
   `permissions.ts:1041-1044`) — held by the operator, untouched here.
3. **Replay on Sonnet only, or also qualify Haiku as the floor.**
4. **New:** ungate `CLAUDE_CODE_DUMP_AUTO_MODE` from `USER_TYPE === 'ant'`
   (amendment F). Cheap, and it is the likely input path for the replay harness.
