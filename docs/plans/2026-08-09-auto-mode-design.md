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

Supporting evidence:
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
  (already present in the fork, `yoloClassifier.ts:467-478`).
- **Prompt assembly** — module 2 (75,469 chars: Environment, Definitions, and
  the four substitution blocks) assembles from the vendored dump. Module 1
  (38,180 chars: Context, Threat Model, Input, Default Rule, Scope, User Intent
  Rule, Evaluation Rules, Classification Process, Output Format) comes from
  binary extraction, tracked per release.

## Delta list (exhaustive)

1. **Output contract** — the one prompt section we own. Replace upstream's XML
   verdict with the fork's schema-backed forced tool call:
   `{thinking, shouldBlock, category, reason}`, `category` a schema-level enum of
   the 66 rule ids. More reliable on the Codex/GPT path, reuses existing parse
   machinery, and enforces "unnameable block = no block" at the API layer rather
   than by instruction.
2. **Classifier model** — new `autoMode.model` settings key;
   `CLAUDE_CODE_AUTO_MODE_MODEL` honoured for all user types (closes B2).
   Sonnet-class default. Keep the existing Sol → Terra → Luna chain
   (`yoloClassifier.ts:629-639`) and add a cross-provider hop on Codex cap/auth
   errors — the failure upstream never faces, and the whole 58-denial no-verdict
   class. Fail closed only when every provider is exhausted.
3. **Thinking/effort plumbing** — keep `getClassifierThinkingConfig`
   (`yoloClassifier.ts:610`), extend for GPT-family effort. Upstream never runs
   this prompt on GPT models; our fallback path will.
4. **Config splice** — `$defaults` with upstream's exact semantics (closes B1),
   plus one fork-only guard: a loud startup warning when a config list omits
   `$defaults`. One operator, no review gate, one typo from silently deleting
   every rule.
5. **Machine facts via config, not prompt edits** — environment/allow/soft_deny
   entries for the shared tree with concurrent sessions, the scratchpad path,
   worktree roots, `~/.agents/skills/` and its mirrors as ordinary territory, and
   GUI driving under CLAUDE.md §8 per-run authorization. See amendment C: the
   session-rules slot may be the designed home for part of this.
   **SKILL.md contents never self-authorize; operator-signed config stays the
   only channel.**
6. **Server config pinned locally** — severity thresholds, stage mode, and retry
   counts become settings carrying upstream's compiled-in defaults. No GrowthBook
   dependency.
7. **Meta-injection staged by census value** — outcome codes first (addresses the
   46 repeat denials; carries "unavailable is NOT a policy decision"), then
   `gitStatus`, then `repoVisibility`. Each behind its own flag, each with a
   boundary test proving tool output can never reach the meta channel.
8. **Two-stage severity deferred** — lowest-confidence extraction, doubles cost,
   tunes a fleet we do not have. Revisit only if replay shows single-stage
   under-performing.

## Amendments from verification

Four checks run against the design before adopting it. The ruling stands; these
change scope, not direction.

### A — Module 1 has no ground truth, but is now well-verified

The CLI exposes module 2 only. Module 1 exists solely as binary extraction, and
the first pass at it missed its opening line. It was therefore verified
separately before being trusted as the spine of the classifier:

- Extracted from **all nine** installed versions with the same boundary walk.
  All nine: zero code tokens, exactly 9 `##` sections, identical closing
  sentence.
- Version-to-version diffs are coherent prose edits, each traceable to a feature
  (2.1.220 adds the `<cc_automode_session_rules>` wrapper; 2.1.221 adds
  "Synthetic Input Self Drive" to the adversarial-pattern list).
- Exactly one template interpolation in module 1, `${""}`, evaluating to empty.
  Module 2's single `${VAR}` is escaped literal prose inside a rule about
  deleting an unresolved shell variable, and appears in the CLI output too.
- **The decisive check:** the escape-decoding rules were validated against ground
  truth on module 2, where CLI and binary reconcile to within explained deltas.
  Module 1 uses the same encoding, so the only untested step was boundary
  detection — which the nine-version result covers.

This is strong evidence, not ground truth. Treat module 1 as verified-by-
construction and re-run the nine-version check on any re-extraction.

### B — There are three injection slots in module 1, not one

The pre-step named `<cross_session_messages_rule>`. There are also
`<cc_automode_session_rules>` and `<permissions_template>`.
(`<subagent_hand_back>` is a false alarm: prose referring to a transcript tag,
not a slot.) Both unknown slots are blank in the default assembly and must be
mapped before module 1 is ported.

### C — The session-rules slot is probably ours

`<cc_automode_session_rules>` wraps `<cross_session_messages_rule>` immediately
after a rule about **cross-session permission laundering** — one agent relaying
an action another was denied. It was added in 2.1.220, so it is actively being
built out. On a machine running several agents against one working tree, that is
our exact situation, and it may be the designed home for part of delta 5 rather
than the environment block. Map it before deciding where our shared-tree facts go.

### D — Delta 1 is cheaper than stated, and slightly mis-scoped

`shouldBlock` appears three times in the Classification Process, outside the
Output Format section, so the verdict contract is not confined to one owned
block. It cuts our way: `shouldBlock` is already the fork's field name, so that
prose is already compatible. Real edit surface is small, but it is not zero and
"the one section we own" should not be read as "one contiguous edit".

## Sequencing and gates

**Step 1 — mechanics, no policy change.** Deltas 2, 3, 4, 6. Model decoupling
ends the no-verdict class; the splice closes B1. Pre-step: map the two unmapped
injection slots (amendment B).

**Step 2 — the ported prompt and tool contract.** Deltas 1, 5. Gated on replaying
the denial corpus: temp-path and skills denials must flip to allow, secrets
denials must still block, parse failures at approximately zero. Prompt wording
changes only on replay evidence.

**Step 3 — meta-injection.** Delta 7, with boundary tests.

Each step measured by `scripts/auto-mode-denials.ts`, which gains a rule-id
column for free once verdicts carry categories.

Engine battery per CLAUDE.md §3: `bun run build:dev:full` plus focused
`src/utils/permissions/` suites. Every splice change needs a test proving the
defaults survive when user config is present — that is exactly the B1 failure
mode, and it is silent without one.

### Unsized: the replay harness

The step-2 gate assumes a corpus replay that **does not exist yet**. What exists
is single-denial replay (reconstruct one denial's exact inputs from JSONL, re-run
it). Scaling to roughly 150 denials, likely twice for before-and-after, is real
work and real quota. Size it before committing to it as a gate; if it proves too
expensive, the gate needs redefining rather than quietly skipping.

Corpus counts for the gate, measured over 21 days (162 decision denials; the
14-day window in the analysis is 151): secrets and credentials 23, temp and
scratch paths 33, skill machinery 26, kill family 24. Pin the window before
using these as pass criteria.

### Maintenance

Nine upstream releases in nineteen days; module 1 prose grew 15% over three
weeks. Module 2 re-syncs free through the CLI. Module 1 needs re-extraction each
time — cheap if the extraction hash-checks first and only re-extracts on change.
Build that in from the start.

## Expected effect

The 58 no-verdict denials disappear. Temp/scratch and skills clusters flip to
allow. Repeats collapse via outcome codes. Secrets, publish, GUI, and
discovered-PID kills still block — the last by both upstream's
`interfere_with_workloads` and CLAUDE.md §4, which agree.

## Open for the operator

1. **Orphan-sidecar kills.** CLAUDE.md §4's report-don't-kill stands unless
   cleared. Clearing it would be a fork extension to PID evidence; upstream sides
   with §4.
2. **Headless denial-cap behaviour** (`AbortError` today,
   `permissions.ts:1041-1044`) — held by the operator, untouched here.
3. **Replay on Sonnet only, or also qualify Haiku as the floor.**
