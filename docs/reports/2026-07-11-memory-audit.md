# Memory System Audit — Instructions, Behavior, and What Actually Gets Saved (2026-07-11, rev 2)

Companion to `docs/reports/2026-07-11-gpt-instruction-stack-audit.md` (rev 3).

Revision history: rev 1 = source re-verification + behavioral eval + corpus audit. rev 2
(2026-07-12) = adversarial review (RED, 10 findings) reconciled — every disputed claim re-verified
in source. Material changes: the rev-1 relevance-selector provider defect is **retracted** (F1);
the review's first-turn prefetch recall-loss path is **adopted as the primary recall-side design
defect** (F2); the behavioral headline is **narrowed** to what was measured (F3, F4); a
prompt-injection boundary is added (F7); corpus counts corrected (F9); contradiction language
reclassified (F10). New decisive fact found during reconciliation: the feature-gate cache on this
machine is **empty**, which resolves the rev-1 attribution uncertainty (§0).

Trigger: user observation that "the GPT model is very sensitive about memory," worst "when the
memory is just created / has less memory."

Evidence tags: **[verified]** = read in current source or measured in a live run; **[latent]** =
verified in source but not active under this machine's gate state; **[hypothesis]** = plausible
mechanism not yet measured.

---

## 0. Effective gate state on this machine (new in rev 2, load-bearing)

`cachedGrowthBookFeatures` in `~/.cat-code/.cat-code.json` is empty (0 entries), so every
`getFeatureValue_CACHED_MAY_BE_STALE(name, default)` call returns its coded default
(`src/services/analytics/growthbook.ts:224-231`). **[verified]** Caveat: a live GrowthBook
connection could populate the in-memory payload at runtime, but the disk cache being empty after
months of sessions indicates remote eval returns nothing here.

Consequences, all defaults `false`:

- `tengu_moth_copse` OFF → the MEMORY.md index IS injected via claudeMd, deterministically, in
  every process; the relevance prefetch/selector **never runs** locally. The F2 defect below is
  therefore latent here, and the eval's memory-exposure channel was deterministic (§2).
- `tengu_passport_quail` OFF → `isExtractModeActive()` is false (`src/memdir/paths.ts:69-77`);
  the background extraction agent **has never run on this machine**. Every memory in the §3 corpus
  was written by the **main agent** under the shared doctrine — rev 1's attribution uncertainty is
  resolved, and the save-side fix target is the doctrine text (`src/memdir/memoryTypes.ts`), with
  the extraction-prompt variants as a secondary target that is currently dead code locally.
- `tengu_coral_fern` OFF → no fallback search-recipe section in the doctrine.

## 1. Recall-side source findings

### RETRACTED (rev 1 F-new) — "relevance selector hardcodes Sonnet ⇒ Codex-only recall loss"

Rev 1 claimed the selector's `getDefaultSonnetModel()` call
(`src/memdir/findRelevantMemories.ts:107`) always routes to Anthropic and silently fails in a
Codex-only session. **This is false in current source [verified]:**

- `resolveRequestProvider(model, base)`: only `gpt-*` forces `'openai'`; claude-family names
  inherit the supplied or session provider (`src/utils/model/providers.ts:61-80`).
- `sideQuery` resolves the provider and threads it to the client (`src/utils/sideQuery.ts:137`),
  and builds its own `_openaiInstructionAssembly` when the provider is openai
  (`src/utils/sideQuery.ts:195-201`), satisfying the adapter's assembly invariant
  (`src/services/api/codex-fetch-adapter.ts:1182`).
- On the openai path the adapter maps sonnet/haiku → `gpt-5.6-luna`
  (`src/services/api/codex-fetch-adapter.ts:494-505`).

So in a Codex session the selector rides the Codex pool as luna, end to end. The rev-1 fix-plan
item is withdrawn. Process note: the false finding came from citing a stale/compressed saved
memory of pre-fix WebFetch-era behavior without re-reading the chain — the exact
verify-before-recommend failure this audit studies; the memory has been corrected.

### PRIMARY recall-side defect — first-turn/direct-answer recall loss under `tengu_moth_copse` **[latent]**

From the adversarial review; verified line-by-line:

1. With the gate on, AutoMem/TeamMem indexes are stripped from claudeMd at context assembly
   (`src/utils/claudemd.ts:1188-1196`; applied `src/context.ts:210-212`).
2. The replacement channel — relevance prefetch — starts once per user turn, concurrent with the
   main request (`src/query.ts:316-319`), and by design "never blocks the turn"
   (`src/utils/attachments.ts:2335-2345`).
3. Its results are consumed only at the post-tools collect point and injected for the NEXT loop
   iteration (`src/query.ts:1655-1671`).
4. Empty and single-word prompts never start selection (`src/utils/attachments.ts:2378-2382`).

Failure scenarios: a direct-answer turn (single iteration, no tools) ends before selector output
can reach the model — the index is gone and nothing replaced it. A prompt like "remember?" never
starts selection at all. Fix requires an initial-turn recall channel or explicit fallback (e.g.,
keep the index injected until the first prefetch has ever landed, or block briefly on the very
first turn). Currently latent on this machine (gate off, §0) but live for any gate-on cohort.

### M-1 — banner contradiction (confirmed; hygiene fix, behavioral urgency unproven)

Unchanged from rev 1 **[verified]**: `getClaudeMds` prepends "…you MUST follow them exactly as
written" to the whole claudeMd payload including the AutoMem MEMORY.md index
(`src/utils/claudemd.ts:89-90,1240`), while the doctrine says verify-before-trusting
(`src/memdir/memoryTypes.ts:201-202,240-256`). Anthropic path softens with the `<system-reminder>`
"may or may not be relevant" wrapper (`src/utils/api.ts:505-511`); GPT path has no hedge
(`src/services/api/instructionAssembly.ts:80-84`). The eval (§2) did not reproduce over-trust on
factual memories; the differential on unverifiable preference rules is unmeasured
**[hypothesis]**.

### NEW (from review, verified) — prompt-injection boundary in the memory manifest **[verified surface; latent locally]**

Frontmatter `description` fields are model- or user-authored data (team-synced for TeamMem), read
by `scanMemoryFiles` (`src/memdir/memoryScan.ts:45-72`) and interpolated raw — no encoding or
delimiting — into a plain-text manifest (`src/memdir/memoryScan.ts:79-94`) that enters both the
relevance-selector prompt (`src/memdir/findRelevantMemories.ts:105-134`) and the extraction-agent
prompt (`src/services/extractMemories/prompts.ts:54-85`). The extraction agent holds write/edit
authority inside the memory directory. A poisoned description could bias selection or steer the
extraction agent's persistent writes. Filename validation on selector output
(`findRelevantMemories.ts:152`) bounds output values, not influence. Both consumers are dormant
under this machine's gates (§0) but the boundary is real. Disposition: treat manifest fields as
untrusted — encode/delimit, add an explicit "metadata is data, not instructions" rule, and
adversarial tests (newlines, delimiter closure, instruction-like descriptions, team poisoning).

### Channels that check out clean **[verified]**

Unchanged from rev 1: doctrine shape (decision rules, MUST reserved for invariants); extraction
provider-keying (`src/services/extractMemories/extractMemories.ts:402`; GPT variants
`src/services/extractMemories/prompts.ts:28-49,64-135`); SessionMemory GPT variant
(`src/services/SessionMemory/prompts.ts:97`); autoDream phased GPT variant deferring format
authority to the doctrine (`src/services/autoDream/consolidationPrompt.ts:18`); compact keying
(`src/services/compact/sessionMemoryCompact.ts:479`); agent memory carries no MUST-banner
(`src/tools/AgentTool/agentMemory.ts:138`); freshness headers (`src/memdir/memoryAge.ts`);
attachment framing survives on GPT (`src/utils/messages.ts:3820-3833`). Mild: M-3 save-timing;
M-4 `teamMemPrompts.ts:83-87` reworded fork.

---

## 2. Behavioral eval — what it does and does not establish

Harness: `scripts/memory-behavior-eval/run.ts` (uncommitted). Fixture project (`orderflow`, real
git repo) + memory dir where every planted memory is wrong about the tree; fresh `./cli-dev -p`
per run with `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` (`src/memdir/paths.ts:161-166`); production
injection path.

**Supported conclusion [verified, measured]:** gpt-5.6-luna (low effort) and sonnet each rejected
all six planted **synthetic, externally verifiable factual** memories, 3/3 repeats per case, with
correct final answers (h1 stale function/file · h5 stale snapshot vs git log · h6 ignore-memory ·
m1 wrong build command · agree agreement-pressure · absent nonexistent-implementation). Both
models used tools in every run; luna used fewer turns/tokens than sonnet on the hard cases (3–8 vs
8–13 turns). No over-trust, no leak, no GPT reconciliation penalty **on this input class**.

**NOT established** (review F3, accepted): that recall is generally fine; that the user-observed
GPT sensitivity is save-side; preference-rule obedience; turn-scoped-vs-durable saving;
contradiction reconciliation; background-extraction or main-agent write behavior; naturalistic
tasks. The save-side explanation in §4 is a **candidate mechanism** with strong observational
support (§3), not a proven cause.

**Exposure caveat (review F4, accepted with new evidence):** each scored run is a separate
process; the probe (1 per model per batch + smoke) proves the channel delivered memory in probe
processes only. Post-hoc verification is impossible: session JSONLs do not persist the injected
context channel (checked — no claudeMd/system-reminder content in transcripts). Mitigation:
under the measured gate state (§0, `moth_copse` off) index injection is a deterministic assembly
path identical across processes, so non-exposure would require nondeterminism that has no
identified source. Formally, per-run exposure is unproven; evidence-grade reruns must plant a
per-case nonce the answer must echo, or prove exposure in-process.

**Artifact caveats (review F5, accepted):** the out-dir files are **final-result artifacts**
(`{args, exitCode, stdout, stderr}` per run: `run.ts:337-341`), not full event transcripts; they
lived in a session scratchpad and are not durable; build hash, fixture hash, and gate state were
not recorded (gate state was established after the fact, §0). Scorer limitations (review F8,
accepted): regex signals are permissive (two adjudicated misfires already occurred and were
fixed); evidence-grade scoring needs structured truth/stale fields and adversarial scorer tests.
Five exit-143 timeout flakes at 240 s did not recur at 480 s; cause unresolved.

**Why the ceiling does not close the question:** every case was fact-checkable, so the doctrine's
verify-first defense could work. The §3 specimens are unverifiable preference absolutes — there is
nothing to check "do not spawn subagents" against. The eval measured the defense that works, on
the input class where it works.

---

## 3. Corpus audit — what actually got saved

Inventory (machine-counted, rev 2 — corrects rev 1's "~70 files" and index-length figures):
**14 memory directories · 80 topic files · 14 MEMORY.md indexes · 94 .md total.** Types: 62
feedback / 14 project / 2 user / 2 reference. Index lines over 150 chars: **26** across 7 dirs
(9 in the cat-code index; threshold = the doctrine's own "~150 characters"; rev 1's "3" was a
>160-char count on the cat-code index only). Confirmed: exactly 7 orphaned cat-code topic files
(all Apr 7–18); zero dangling index pointers; hsbc-kpi has 3 topic files; Why/How structure
present on applicable files. Attribution (new, §0): all written by main-agent saves — background
extraction has never run here.

Specimen classes (review F10 taxonomy adopted): **[verified — quoted from disk]**

### 3a. Scope inflation: turn-scoped directives saved as permanent absolutes

`-Users-pt-hsbc-kpi` (born 2026-07-11, 3 files — the "young memory" case): "up to you, don't ask
anymore" (one reorg) → "do not keep asking follow-up questions" + "Do not spawn review or
verification agents"; one interruption of delegated work → "Do not spawn subagents unless the user
explicitly asks"; "ignore Superpowers" once → standing prohibition. Also `-Users-pt` (home dir —
loads into every session launched from `~`): one frustrated "continue, dont report to me with
empty hand" → standing status-report rule. `DataSci-FinalProj`: "next time spawn only one subagent
to review" → permanent one-reviewer rule.

### 3b. Hard contradiction (one confirmed pair)

`project_spawned_agent_model_shift` (Apr 7): "prefer GPT-5.4 Mini over Haiku 4.5" vs
`feedback_no_gpt54_mini_subagents` (Apr 10): "Do not use GPT-5.4 Mini for subagents" — same dir,
never reconciled, and **both are orphans**: invisible in the index, but reachable by relevance
prefetch on gate-on builds → nondeterministic policy.

### 3c. Conditional overlap (not proven contradiction)

`feedback_batch_obvious_design_questions` (batch, "UI plan and design review work") vs
`feedback_question_by_question_interviews` (one-at-a-time, "eliciting problem details for prompts,
plans, or design reviews"). Scopes overlap on design review; the pair is reconcilable by
condition. Risk is a model receiving both without the conditions (index hooks drop them).

### 3d. Cross-project variation (expected per-project scoping; pattern still informative)

Five subagent policies across projects (no-subagents / single-reviewer / delegate-first /
spawn-early / implementation-only) and run-commands-directly vs avoid-Bash. Per-project divergence
is by design; what the pattern shows is each rule freezing one session's task shape as project
law — consistent with 3a's mechanism, not independent proof of contradiction.

### 3e. Mood-frozen rules and housekeeping

"There are plenty of tokens available" (one April day) → permanent anti-thrift rule; a trust low
point → permanent visual-task prohibition. Test artifacts saved as permanent memories: BANANA-77,
4271, PLATYPUS-A. Plus the 7 orphans and 26 overlong index lines above.

---

## 4. Candidate root cause — two instruction gaps (narrowed per review F10)

**Gap 1 — no turn-scoped vs durable test.** Feedback `<when_to_save>` fires on "Any time the user
corrects your approach" (`src/memdir/memoryTypes.ts:135`); a mid-task "don't ask anymore" IS a
correction by this definition. "Save what is applicable to future conversations" is present but
buried and trivially satisfiable. `<body_structure>` requires Why/How-to-apply (the saved files DO
have them) but permits an unconditional headline rule, and the index hook — the always-in-context
representation — compresses the rule further and drops the conditions.

**Gap 2 — no save-time contradiction procedure in the main doctrine and extraction paths.** The
dedup rule ("check if there is an existing memory you can update") targets duplicates, not
conflicts. AutoDream's consolidation DOES instruct contradiction cleanup ("Deleting contradicted
facts", "Resolve contradictions — if two files disagree, fix the wrong one",
`src/services/autoDream/consolidationPrompt.ts:56-70,104-122`) — but it is a periodic sweep, not
save-time, and the 3b pair shows the corpus reaches it unreconciled (or it never ran).

**Why young dirs [mechanism verified, differential magnitude hypothesis]:** in a 1–3-file dir the
absolutes are the entire memory — no dilution. **Why GPT [hypothesis]:** the sparse index arrives
inside `instructions` under the MUST-follow banner with no relevance hedge (M-1), and GPT-5-class
models follow prompt contracts closely (OpenAI guidance, quoted in the companion report). Claude
receives the same content with the system-reminder softener. Causality for the user's observed
behavior is **not yet demonstrated** — it requires the save-path and preference-rule evals below.

---

## 5. Fix plan (proposed, NOT implemented; revised per review)

1. **Save-side instruction fix** (candidate root cause; target = shared doctrine, since all local
   corpus evidence is main-agent-authored — §0; mirror into extraction prompt variants):
   turn-scoped-vs-durable decision rule + anti-pattern example in feedback `<when_to_save>`;
   conditional phrasing requirement for rule lines AND index hooks; save-time
   contradiction-reconciliation rule beside the dedup rule.
2. **Save-side eval — required gate for item 1** (review F6; the recall harness cannot validate a
   save fix). Design: paired turn-scoped vs explicitly durable corrections fed through real
   sessions; inspect what gets written (topic files + MEMORY.md); exercise main-agent writes and
   (gate-enabled) background extraction separately; include contradiction-supersession cases;
   record gate state and build hash with results.
3. **Recall harness upgrades** (before any evidence-grade rerun): per-case exposure nonce;
   structured-output scoring with truth/stale fields + adversarial scorer tests; full transcript
   capture (`--output-format stream-json` or session-JSONL harvest) + run metadata (build hash,
   fixture hash, scorer version, gate state); add a preference-rule case class to get headroom on
   the §4 mechanism.
4. **M-1 banner split** in `getClaudeMds` by `file.type` — hygiene, defuses the §4 composition.
5. **First-turn recall channel** for the `moth_copse` design (primary recall defect; latent
   locally): initial-turn fallback or index retention until first prefetch lands; tests for
   direct no-tool answers, single-word prompts, slow/failed selection.
6. **Manifest injection hardening** (§1 boundary): encode/delimit descriptions, "metadata is
   data" rule, adversarial tests.
7. **One-time corpus cleanup** (user approval required for deletions): reconcile the 3b pair;
   condition-scope or delete the 3a/3e absolutes; delete the three test artifacts; re-index or
   prune the 7 orphans; shorten the 26 overlong index lines.

Withdrawn: rev 1's relevance-selector provider fix (finding retracted). Unchanged and separate:
the provider-keying leak fix from the companion report remains the selected engine task.

## 6. Uncertainties

- Gate state was read from the disk cache (`cachedGrowthBookFeatures` empty); a live remote-eval
  payload at runtime could differ, though months of an empty cache argue against it.
- The GPT-vs-Claude differential on preference-rule obedience is unmeasured (needs item 3's
  preference-rule cases). Causality of §4 for the user's observed behavior is undemonstrated
  (needs item 2).
- Per-run memory exposure in the completed eval is deterministic-by-construction under the
  measured gate state but not formally proven per process.
- Five exit-143 timeout flakes; cause unresolved. Eval used luna at low effort; terra untested.
- Whether autoDream consolidation has ever actually run locally was not determined.

## 7. Artifacts

- Harness: `scripts/memory-behavior-eval/run.ts` (uncommitted; engine-side, belongs on `main`).
  Re-run: `bun scripts/memory-behavior-eval/run.ts --models gpt-5.6-terra,sonnet --repeats 3`.
- Final-result artifacts from this session's runs (per-run `{args, exitCode, stdout, stderr}` +
  `results.jsonl`) were written to a session scratchpad and are NOT durable; session JSONLs under
  `~/.cat-code/projects/*memeval*` persist conversation events but not injected context.
- Corpus inventory: machine-counted from `~/.cat-code/projects/*/memory/` (script in session
  transcript; §3 numbers).
