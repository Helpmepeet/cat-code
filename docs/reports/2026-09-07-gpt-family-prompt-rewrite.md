# GPT family prompt rewrite: implementation and evidence

Status: **implemented; family tests and engine build pass. The broader focused
battery has one failure from the concurrent Apply_patch rewrite, detailed below.**

The operator initially requested implementation, then redirected this session to
produce a plan and document whatever had already been applied. Source edits
stopped during planning and the subsequent deeper analysis. The operator then
authorized implementation and requested a GPT-5.6 Luna worker at max effort.
Luna was assigned family wiring and focused tests but its run stopped on an
account usage-limit error before delivering implementation. The parent finished
the wiring, tests, wording, review, and report locally. Nothing has been staged,
committed, or pushed by this session.

The operator subsequently requested deeper reading and analysis. That pass made
**no source edits**. The plan below incorporates its findings; the partial-edit
ledger records the earlier draft, including choices the deeper analysis rejected.
The implementation section below records their corrections.

## Implementation

The family axis follows the vendor's two shipped templates, with exact
`gpt-6-astra` identity and a GPT-5.6 baseline for other IDs. The owners
are the existing doing-tasks, actions, and tone builders. Shared policy constants,
tool routing, and the dynamic section cache retain their existing owners.

The final wording corrects the early draft in four places: sufficient evidence
for the requested analysis replaces a file-name stopping criterion; shell reads
count for patch-update evidence without overriding deletion or Edit/Write prerequisites; both
families retain light formatting; and requested workflows/output styles retain
their intentional pauses. Astra's file/skill applicability text belongs beside
instruction authority in Actions, independent of current Skill-tool availability.

### Final cut ledger

| Cut or compression | Structural basis | Retained instruction / boundary |
|---|---|---|
| Intro correctness/conflict reminder | Repeats shared outcome and retry rules | Both constants remain in the assembled prompt |
| Universal monospace-rendering claim | Contradicts desktop body typography in `app/renderer/src/theme.css` | GitHub Markdown/CommonMark contract |
| Existing-file preference and unused-code cleanup examples | No counterpart in either shipped family template | Requested scope and ownership protection; explicit craft coaching is removed |
| Recommendation-versus-survey prescription | No counterpart as a universal instruction; duplicates outcome-first communication | Respect requested coverage and prior user decisions |
| Stop investigating once files/changes can be named | No counterpart in either template; can truncate the explicitly requested analysis | Evidence sufficient for the requested scope, with material-gap retrieval |
| Prior Read-tool result required before every proposed edit | Contradicts patch validation and accepted shell-read routing; also imposed a prerequisite on merely proposing a change | Current-file evidence and concurrency reread; chosen mutation tool's prerequisites |
| Vulnerability examples | Restate the security invariant | Do not introduce vulnerabilities; correct insecure code introduced |
| Comment/docstring/type-annotation prohibition list | No counterpart in either shipped template | Operator's low-maintenance comment principle |
| “Do not verify small, low-risk changes” | Contradicts required project validation carried by durable instructions | Relevant checks and required validation; proportional discretionary checks |
| Repeated confirmation headings, warning about the cost of pausing, and repeated risk examples | Repeat the scoped action rule and encourage pauses already covered by the decision rule | One consent decision rule, concrete risk categories, publishing sensitivity, and authorized preparation |
| Extended disagreement, correction, and obstacle examples | Repeat evidence-first disagreement, truthful reporting, and ownership protection | Raise material concerns; respect informed decisions; preserve work and safety checks |
| Task completion/non-batching coaching in both tool branches | Restates the exposed TodoWrite/TaskCreate descriptions | Optional routing to the available task tool |
| Apply_patch working-directory sentence | Restates `FilePatchTool.prompt`'s exposed description, which also explains agent-thread differences | Tool description remains unchanged |
| Blanket brevity rules, cold-read elaboration, prose micro-rules, repeated no-restating and closing examples | Repeat tone, audience, milestone, and final-answer outcomes; 5.6 vendor guidance explicitly supports removing repeated brevity | Shared light formatting, self-contained final, requested artifact detail, no unrequested extra-work offers |
| Emoji, pre-tool colon, and time-estimate bans | No counterpart in either shipped template; history supplies no incident trace establishing a current-model need | No new blanket replacement bans; other tool/subagent instructions stay outside this scope |
| Caveats-at-the-end directive | No counterpart in either template; conflicts with retained outcome-first reporting when a caveat changes the result | Relevant evidence and unresolved limitations accompany the outcome |

These are structural justifications, not measured behavior improvements. The
absence of a Codex counterpart is used for optional coaching, never to remove
a Cat Code safety, authority, or tool contract.

### Reviewed snapshot changes

Compared against the checked-in snapshots at
`e9fae3df354dba812b25b43ff969d23016354505`, after explicit regeneration and full
diff review:

| Configuration | Before, characters | GPT-5.6 after | Astra after |
|---|---:|---:|---:|
| Full tool fixture | 20,923 | 16,120 | 17,289 |
| Minimal tool fixture | 17,455 | 13,123 | 14,292 |

The full 5.6 assembly loses 4,803 characters (23%); Astra is 1,169 characters
longer than the new 5.6 assembly, including its different identity line. The
minimal snapshot also accepts the Bash/Read fallback guidance that already
existed before this session's edits. Its delta is not wholly attributable to
this rewrite. Neither fixture includes task tools, whose separate lifecycle
cut is covered by a focused fixture. These figures exclude tool schemas and
injected user context, and are not token counts or behavior measurements.

Both Astra snapshots differ from 5.6 only in the intended three sections and
model identity. The Claude snapshot is byte-identical to the baseline. Agent
Mode and its snapshot were removed by another session; this rewrite does not
restore them. Missing snapshots now fail unless the explicit update flag is
set, and snapshot tests fix the output style to the product default rather than
the operator's saved style.

### Change impact

Updated the prompt-system map's family owner and snapshot-test routes. There is
no new setting, registry entry, permission-engine behavior, model alias, schema,
SDK type, telemetry event, or desktop UI surface. Ordinary subagent and custom
replacement prompts retain their existing behavior. The family branch lives in
static sections rebuilt by `getSystemPrompt`, so no dynamic cache key or
invalidation code changed. No DONE.md entry was written.

## Recommendation

Use a **generation/template-family axis** beneath the existing provider switch:
one shared baseline for GPT-5.6 Sol, Terra and Luna, with targeted Astra variants.
Do not introduce a capability-tier split, an `isOpus` equivalent, or a rule that
automatically treats every future GPT-6 model as Astra.

The point is to remove redundant instruction load while retaining Cat Code's
actual contracts. There is no target character count. Nothing here establishes
that shorter prompts improve behavior: this repository has no eval harness, and
no ablation was run.

## Evidence read before editing

The following live official pages were fetched on 2026-09-07 through the OpenAI
documentation connector, after an official documentation search. The inventory's
transcription was not used as a substitute:

- [GPT-5.6 prompting guidance](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6): outcome-first contracts, removal of repeated instructions and examples, fewer blanket brevity rules, one approval-policy owner, decision rules for judgment calls, and preservation of evidence, tool routing and validation requirements.
- [Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra): establishes the model identity and supported capabilities; it is not a detailed prompting guide.
- [Astra model guide](https://developers.openai.com/api/docs/guides/latest-model): identifies excess clarification, sensitivity to skill instructions, formatted prose, comparatively low delegation, and excessive testing of small changes as behaviors to calibrate.
- [Prompting](https://developers.openai.com/api/docs/guides/prompting): code-managed prompts, typed dynamic inputs and repeatable checks.
- [Prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering): role, tool and validation contracts; its generic examples are less specific than the family guidance and shipped templates.

No Astra-specific `prompt-guidance-gpt-6-astra` page was assumed to exist. The
operator explicitly told this session to ignore the stale Cat Code GPT Prompting
skill; it is not a source for the proposed decisions.

### Shipped-template comparison

Read `~/.codex/models_cache.json`, extracting only each selected model's
`model_messages.instructions_template`. The observed values match the operator's
figures:

| Models | Characters | SHA-256 of UTF-8 template |
|---|---:|---|
| GPT-6 Astra | 21,261 | `152dfaeeb552876190962be1c12c93d426840ff12691f648261554a7675a6698` |
| GPT-5.6 Sol, Terra, Luna; gpt-reserve; codex-auto-review | 17,730 each | `a91357a1cd2727a0be06d461248d6e3a7274746e38108f548a3adf2cc2430415` |

A unified line diff was inspected. Astra is 3,531 characters longer, but that
net difference hides replacements and deletions, not just additions:

| Area | 5.6 template | Astra template | Proposed Cat Code treatment |
|---|---|---|---|
| Permission and autonomy | Request-type taxonomy and scoped authority; later in the template | Opens with persistent authorization, completing preparation, implied action intent and avoiding unnecessary pauses | Shared authority boundary; Astra-specific follow-through calibration |
| Writing | Light formatting restraint and outcome-first communication | Much more explicit connected prose, paragraph structure, jargon and stock-phrase guidance | Keep one shared light-formatting preference; remove repeated brevity instructions; add targeted prose guidance for Astra |
| Skills | Detailed mandatory trigger/procedure list, including explanation when a skill blocks work | More explicit relevance judgment, user priority, and exact-instruction explanation | Shared authority boundary; Astra elaboration about applicability and the exact file instruction behind a pause |
| Verification | General proportional verification in autonomy guidance | Explicit restraint on repetitive checks and tests that mirror implementation | Common required-check contract; Astra-only stop/broaden criteria |
| Steering and compaction | Evaluate whether a new request replaces or supplements work; older requests described as stale after summary | Preserve unfinished objectives by default; incorporate steering and side questions | Keep a shared task-continuity outcome, grounded in the user's request |
| Execution mechanics | Dedicated file-edit and destructive-action blocks | Those blocks removed; adds shell-quoting, multiline-body and tool batching details | Retain Cat Code's tool and destructive-action contracts; borrow no tool names or app-specific APIs |
| Visuals and integrations | More restrictive visual criteria | Different visual guidance plus connector/plugin instructions | Leave outside this rewrite: those depend on the host's capabilities |

This is strong evidence for a generation split, and **no evidence for different
Sol/Terra/Luna system text**. The cache records what the vendor shipped; it is not
a controlled experiment and does not prove every difference is a necessary
model adaptation. The live guide independently supports the proposed Astra
permission, writing, skill and verification differences.

## Findings from the deeper source and history review (planning record)

The findings below describe the evidence used to revise the early draft. Their
proposed corrections are now applied. One source contract moved during resumed
implementation: the concurrent Apply_patch rewrite now permits a unique current
match for updates even after a stale/absent Read, but requires a complete,
unbounded recorded Read for bare deletion. The final prompt explicitly limits
its shell-read allowance to updates and defers all recorded-read prerequisites
to the chosen tool. No FilePatchTool source was edited by this session.

### The first draft's stopping criterion is still too shallow

The pre-edit investigation rule treats being able to name files and changes as
the point to act. The draft replaces that with evidence identifying a change,
but still does not clearly distinguish a plausible edit from enough evidence to
complete the requested analysis. In this task, locating `gpt.ts` and finding
vendor support for a generation split did not settle each cut's justification.

The revised criterion should be **sufficient evidence for the requested scope**,
including analysis the user explicitly requested. Keep a material-gap stopping
rule so this does not become an instruction to search endlessly. Do not claim
this prompt caused this session's premature edits; the structural problem is
that it permits stopping before the task's evidence requirements are satisfied.

### Read prerequisites differ by editing tool

The draft says a shell read counts before modifying a file. That is too broad:

| Operation | Source-enforced prerequisite | Consequence for prompt wording |
|---|---|---|
| Apply_patch update/delete | `FilePatchTool.validateInput` checks staleness if read state exists; `validateFileNotModifiedSinceRead` returns no error when no record exists | Shell evidence can support a patch, but does not bypass an existing stale-read rejection |
| Edit of an existing nonempty file | `FileEditTool.validateInput` calls `validateFileWasRead`, which requires usable recorded read state | Keep the tool's Read prerequisite; do not promise a Bash read satisfies it |
| Write over an existing file | `FileWriteTool.validateInput` requires `isCompleteUnboundedRead` and matching file identity | A partial or shell read does not authorize whole-file replacement |

Owners: `src/tools/FilePatchTool/FilePatchTool.tsx`,
`src/tools/FileEditTool/shared.ts`, `src/tools/FileEditTool/FileEditTool.ts`,
`src/tools/FileWriteTool/FileWriteTool.ts`. The Bash read-state update found in
`src/tools/BashTool/BashTool.tsx` belongs to simulated **sed edits**, not generic
shell reads. The Write description already states its stricter contract.

**Decision:** keep a short general current-evidence requirement, scope the shell
allowance specifically to Apply_patch, and defer tool-enforced read requirements
to the corresponding descriptions. Preserve the existing enabled-tool branches.
The already-applied generic shell allowance needs revision before acceptance.

### Prompt classification must agree with transport classification

`translateToCodexBody` uses `mapClaudeModelToCodex` in
`src/services/api/codex-fetch-adapter.ts`. That function accepts registered Codex
IDs by exact match. Otherwise it maps Claude tier names or falls back to Terra.
`parseUserSpecifiedModel` preserves the case of non-alias IDs.

The drafted resolver lowercases its input, so an OpenAI-routed `GPT-6-ASTRA`
would receive the Astra profile while the transport maps that spelling to
Terra. Broad canonicalization would create a related problem: `getCanonicalName`
recognizes names containing `gpt-6-astra`, whereas the transport does not accept
arbitrary suffixes as Astra.

**Decision:** use exact supported-model identity for this split. On the current
transport, only exact `gpt-6-astra` maps to Astra; every other accepted/mapped
target uses the shared profile. Do not broaden transport model support in this
task. Test the resolver against transport mapping, including uppercase and
unregistered suffixed inputs, instead of independently normalizing them.

The registry also lists older GPT models. The 5.6 profile is a fallback for those
IDs, not a claim that they were evaluated or optimized here. `gpt-reserve` and
`codex-auto-review` provide template-comparison evidence but are not entries in
this runtime's `CODEX_MODELS`; this work does not add them to the picker.

### Skill authority is not the same as Skill-tool availability

`getSkillToolCommands` excludes commands with `disableModelInvocation`, while
user-invocable skills can still appear through the separate slash-command path.
Already-loaded instructions also remain in the conversation after loading.
Therefore `hasSkills && enabledTools.has('Skill')` describes what can be invoked
now, not whether skill/file guidance can influence the model.

The 5.6 vendor template already asks for an explanation when a skill blocks
continuation. Astra adds more explicit instruction applicability, user priority,
and quoting of the exact instruction. Calling all skill-pause transparency an
Astra-only behavior would overstate the diff.

**Decision:** put Astra's file/skill applicability elaboration under Acting and
Asking, next to the common authority rule. Apply it conditionally in prose when
such instructions affect the task, not conditionally on a tool-list boolean.
Keep skill invocation and discovery mechanics in Session-Specific Guidance.
This removes the proposed family-dependent session-guidance cache entry.

### Autonomy must preserve intentional collaboration

`src/constants/outputStyles.ts` defines Learning mode, which deliberately asks
the user to contribute code and then waits. Explanatory mode intentionally adds
structured educational output. `getOutputStyleSection` inserts their text; it
does not make the actions and tone sections disappear. Only coding instructions
can be omitted through `keepCodingInstructions`.

**Decision:** describe autonomous defaults as subject to the user's requested
workflow and selected output style. A user choosing learning, planning, review,
or a decision checkpoint has defined the task's completion behavior. Do not
classify every pause as an approval failure, and do not infer implementation
authority from the words “help me” without interpreting the request.

### Less brevity prompting does not mean no formatting preference

Both cached templates discourage excessive formatting. Astra adds detailed
prose instructions; 5.6 still carries a shorter explicit preference. My draft
removed the shared prose/formatting owner and restored one only for Astra.

**Decision:** retain one shared light-formatting default, with requested artifact
format taking precedence. Add only Astra's connected-prose and jargon calibration.
Remove repeated instructions to be concise and the blanket rule placing caveats
at the end. A caveat that changes the conclusion belongs next to it.

The removed universal monospace claim is now source-verified: the desktop
`app/renderer/src/theme.css` sets the body to `--font-sans`, while code-specific
surfaces use `--font-mono`. The renderer is evidence for this cut, not a file to
change.

### Some earlier justifications were assertions, not measurements

The history search distinguishes reachable current history from older objects
available through `git log --all`:

- The current branch records emoji and colon guidance at the private snapshot
  `86051a8e`. Older retained history contains the same rules in `0b62c362`, whose
  message explains provider-aware prompt parity but no specific incident.
- Older `60e5c968` added no-restating and closed-ending instructions. On current
  history, `7e8ae0d8` explicitly added the self-contained-final-answer exception.
  Preserve that outcome, regardless of shortening the rest.
- `aff3a3fa` deliberately expanded disagreement/correction handling;
  `6c1bb696` relocated it and preserved the evidence-first principle.
- `6c1bb696` deliberately retained existing-file preference and cleanup examples,
  and moved the time-estimate ban. Its accompanying report says GPT produces the
  named mistakes, but supplies no trace, task set or ablation supporting that
  behavioral claim. This is recorded intent, not measured necessity on 5.6.
- The maintenance principle for comments is an explicit operator ruling and
  survives. The extra shape-based prohibitions do not become invariants merely
  because they were adjacent to it.

The relevant historical report is
[the earlier rebuild record](2026-09-07-gpt-prompt-rebuild.md). Its “actually
produces” claim must not be repeated as proven evidence. The newer operator
request expressly authorizes cuts based on absence from the shipped templates;
that supports removing those craft examples while honestly recording the lost
explicit coaching. No behavioral improvement follows from the absence alone.

### Main-prompt coverage is narrower than all GPT traffic

| Path | How the prompt is selected | Planned family behavior |
|---|---|---|
| Default CLI and desktop/SDK work | REPL or QueryEngine calls `getSystemPrompt` | Family-specific default sections |
| Model change during input processing | QueryEngine rebuilds prompt parts using `modelFromUserInput` | Recompute family for the new request; verify without clearing the section cache |
| Side-question fallback | `buildSideQuestionFallbackParams` calls `fetchSystemPromptParts` | Uses the same default assembly unless a replacement prompt is selected |
| Custom, override or main-thread agent prompt | `buildEffectiveSystemPrompt` replaces the default | Respect replacement; do not append a new global family layer |
| Ordinary subagent | `runAgent` builds its agent definition plus environment details | Unchanged; it does not assemble the main `gpt.ts` sections |
| Fork subagent | Inherits rendered parent bytes and model | Inherits family text; fork feature is not in dev-full |
| Simple mode | Early return before GPT-style selection | Preserve intentionally minimal prompt |
| Proactive mode | Separate compact branch including actions | Pass the family to its actions builder if this branch is built; not in dev-full |

Source owners are `src/screens/REPL.tsx`, `src/QueryEngine.ts`,
`src/utils/queryContext.ts`, `src/utils/systemPrompt.ts`, and
`src/tools/AgentTool/runAgent.ts` / `forkSubagent.ts`. Feature membership was read
from `scripts/build.ts`. Do not count dormant branch rewrites as improvements to
the prompt normally served by this fork.

### Existing snapshots do not exercise every conditional

The `FULL_TOOLS` comment overstates its coverage. Its list omits TodoWrite and
TaskCreate; including both Edit and Apply_patch only exercises the preferred
Apply_patch branch. Feature-gated Explore, fork, discovery and proactive paths
also cannot be inferred from a normal snapshot run. The helper clears the cache
before every assembly, so those snapshots cannot catch family-switch staleness.

They also stop before the final request envelope. In
`src/services/api/instructionAssembly.ts`, `buildProviderInstructionAssembly`
appends stable system context and user context to OpenAI instructions, removes
the dynamic boundary marker, and emits volatile session context separately.
Tool descriptions are another request surface. A shorter main-prompt snapshot
therefore does not establish total request size or request-wide deduplication.
Existing tests in `src/utils/providerPromptRegressions.test.ts` cover this
envelope with synthetic base text, not the real family assemblies. One focused
integration assertion should establish that the intended family text survives
this seam; the envelope itself needs no redesign.

**Decision:** retain the whole-prompt snapshots, supplement them with focused
branch and model-switch assertions, and identify dormant branches as source-only
coverage. Do not expand this into an exhaustive Cartesian product of all flags.

## Approved implementation plan (historical)

### 1. Re-establish the shared-tree baseline

Re-read `src/constants/promptStyles/gpt.ts`, `src/constants/prompts.ts`, the prompt
tests and their diffs immediately before editing. The overlapping tool-routing
work was already present when this session began; preserve it. Agent Mode removal
is concurrent work and changes which assembly entry points exist.

Capture assembled text for both generations with full and minimal tools before
the next edit, distinguishing the original checked-in snapshots, this session's
partial rewrite and unrelated concurrent changes. Do not use a stale installed
binary as evidence for current source.

### 2. Complete the axis through existing builders

- Keep `isGPTPromptStyle` as the provider decision. Resolve the prompt family
  from the **effective request model**, not the session's provider or a picker
  tier. Match the transport's exact accepted Astra ID; do not lowercase or
  broaden names through `getCanonicalName` independently of the transport.
- Finish `getGPTPromptFamily` in `src/constants/promptStyle.ts`. Sol, Terra and
  Luna share a baseline. Unrecognized IDs keep that baseline until separate
  guidance justifies another branch; document this fallback.
- In `getSystemPrompt`, pass the family to doing-tasks, actions and tone.
  Make these family parameters explicit at call sites rather than relying on
  default arguments that can conceal missing wiring. Apply it to surviving
  alternate assemblies that use these
  builders, including the proactive actions path. Do not restore APIs removed
  by the Agent Mode session.
- Put Astra's file/skill judgment in actions, removing that family dependency
  from the drafted session-guidance builder. No dynamic section then reads
  family, so no new cache key is needed. Still test 5.6 → Astra → 5.6 without
  clearing caches to prove the assembled result changes correctly. Keep the
  existing dynamic boundary in place. If later implementation instead leaves
  family-dependent text in a cached section, family must be in that cache key.
- Leave dedicated subagent/custom/override prompts alone unless source tracing
  shows they assemble these same default sections. Document that boundary rather
  than silently promising every auxiliary prompt is rewritten.

### 3. Finish the content pass with a cut ledger

Review every changed sentence against four permitted structural reasons:
contradicts current code, repeats another instruction, restates a tool
description, or lacks a counterpart in the templates these models receive.
Absence from Codex does not justify deleting a Cat Code harness or safety
contract. Loaded user configuration is not a reason to cut product text.

The proposed ownership remains:

| Section | Job |
|---|---|
| Intro and system | Identity, security and harness contracts |
| Getting Work Done | Requested outcome, evidence sufficiency, relevant validation and truthful completion |
| Acting and Asking | Request scope, authorization, file/skill applicability and material uncertainty |
| Using Your Tools | Available-tool routing and delegation semantics |
| Tone and Style | Shared light-formatting default and the Astra prose elaboration |
| Communicating with the User | Progress, final-answer completeness, corrections and task continuity |
| Session-Specific Guidance | Skill invocation/discovery and session affordances |

Deduplicate the drafted Astra preparation clause against the common preparation
rule: adding a family variant must not recreate the repetition this rewrite
removes. Preserve the common analysis-versus-implementation boundary and prior
operator decision to finish authorized preparation before asking approval.

Additional decisions for the content pass:

- Replace the file-name-based investigation stop rule with sufficient evidence
  for the user's requested scope. Keep material-gap and requested-coverage
  criteria for additional retrieval.
- Preserve one compact shared formatting preference. Distinguish that from
  repeated brevity rules. Requested output style and artifact shape win over
  default prose preferences.
- Keep required validation for both families. Astra gets the additional
  restraint on repeated or broader discretionary checks after completion.
- Do not add Astra's generic delegation encouragement. Its guide says to tune
  delegation to the host, and Cat Code already supplies Agent/Explore criteria,
  review restrictions and ownership rules. A second encouragement could conflict
  with those rules; no observed under-delegation trace was supplied for this
  current prompt.

Tool-related cuts remain narrower than a wholesale tool rewrite:

- Remove the main prompt's repeated task-state lifecycle coaching. TodoWrite's
  emitted GPT description owns immediate completion and non-batching;
  TaskCreate's description already routes updates to TaskUpdate. Preserve at most
  the routing choice between task tools, without universal task creation.
- Remove the Apply_patch working-directory sentence: `FilePatchTool.prompt`
  directly returns `getFilePatchToolDescription`, which already owns that fact
  and distinguishes main-session and agent-thread paths. This duplication is
  verified through the exposed tool, not just a disconnected string constant.
- Keep provider-aware editing, shell-read permission, post-command diff review,
  bounded search, delegation eligibility and background ownership. These encode
  Cat Code mechanics and documented fixes, not generic coding advice.

### 4. Record intended divergence in tests

Keep the family-equivalence check, narrowing its equality assertion to
Sol/Terra/Luna and separately asserting Astra's intended differences. Test at the
assembled-prompt entry point so an unused resolver cannot pass as a feature.

Acceptance coverage:

- Full/minimal tool assemblies for 5.6 and Astra, with snapshots for Astra.
- Exact same shared safety, provenance, scope, retry and outcome contracts in
  both generations; Claude stays distinct and unchanged by our edits.
- Astra-only follow-through, prose elaboration and verification restraint.
  File/skill applicability is conditional on the situation, not on whether the
  Skill tool happens to be in the current pool. The common authority policy is
  unchanged between families.
- Model switching without manual cache invalidation; tool removal must also
  remove the corresponding guidance.
- Read-before-patch accepts shell evidence while Edit/Write keep their own
  stronger prerequisites. Cover Edit without Apply_patch, and patch without Read.
- Surviving alternate paths and output styles retain the core invariants.

Keep equality checks for all sections outside the intended family owners
(doing-tasks, actions, tone), after normalizing model identity. Separately assert
the content of each allowed divergence. Add a case comparing prompt-family
selection to `mapClaudeModelToCodex`; model display normalization is not enough.

Use focused fixtures for TodoWrite/TaskCreate, selected output styles, and tool
presence. Existing full/minimal snapshots are not proof of those branches.

Do not delete obsolete Agent Mode assertions merely to make this rewrite green.
Separate concurrent removal updates from family changes. Existing assertions
that pin rewritten text need semantic replacements, especially permission
content, not merely checks for labels.

Only after reviewing the intended assembly changes, run:

```sh
UPDATE_PROMPT_SNAPSHOTS=1 bun test src/constants/promptAssembly.snapshot.test.ts
git diff -- src/constants/__prompt_snapshots__ src/constants/promptAssembly.snapshot.test.ts
bun test src/constants/promptAssembly.snapshot.test.ts
```

Read the complete diff before accepting the snapshots. Follow with relevant
prompt, policy, tool-routing and cache tests and `bun run build:dev:full`. The
focused paths are recorded in the verification section below. Stage only owned
paths or owned hunks; no stash, revert, clean, push or broad staging.

## Edits already applied before the pause (historical)

Only `src/constants/promptStyle.ts` and `src/constants/promptStyles/gpt.ts` were
edited by this session. `prompts.ts`, tests, snapshots and shared policy constants
were **not** edited by this session.

At the pause, the resolver and family parameters existed, but assembly did not
call the resolver or pass a family. All GPT models then got the edited common
baseline; the Astra additions were unreachable. The resumed implementation
wires those call sites and tests their emitted text.

| Applied draft change | Structural justification / limitation |
|---|---|
| Removed intro's correctness/conflict admonition | Duplicates the retained shared outcome and retry rules |
| Removed monospace-rendering claim | Now verified against desktop `theme.css`: body uses sans, with mono for code surfaces |
| Shortened scope and investigation | Retains scope and evidence stop condition; removes repeated elaboration and unrequested recommendation-versus-survey prescription |
| Removed preference for existing files and unused-code cleanup examples | Generic craft prescriptions without a counterpart in either inspected template; no tool semantics removed |
| Replaced required prior `Read` result with current-file evidence via available readers | Draft is too broad: valid for patch evidence, not Edit/Write prerequisites. Revise as specified in deeper analysis |
| Kept secure-change requirement, removed vulnerability enumeration | Examples restated the retained security invariant |
| Kept low-maintenance comment principle, removed the surrounding prohibition list | The principle is an operator requirement; the added bans have no counterpart in either template |
| Replaced “do not verify small, low-risk changes” | Conflicted with loaded required validation and with proportional verification; required checks now remain required |
| Compressed approval, risky-action examples, uncertainty, disagreement and obstacle prose | Repeated confirmation framing removed; scoped authorization, analysis-only boundary, preparation, publishing sensitivity and protection of other work retained |
| Removed blanket brevity, repeated prose coaching and repeated closing examples | Repetition supports compression, but removing all shared formatting preference went too far. Restore one compact default for both families |
| Removed emoji, pre-tool colon and time-estimate bans | No counterpart in either template. History records parity/retention, not a specific incident proving necessity. Keep these as proposed style cuts; no behavioral benefit is claimed, and other tool/subagent surfaces retain their own emoji instructions |
| Added task continuity and requested-artifact preservation | Supported by vendor continuity guidance and 5.6 artifact-preservation guidance; these are additions, not cuts |
| Added Astra follow-through, prose, verification and skill branches | Supported direction, but unwired. Revise exact-ID matching, move file/skill judgment into actions, remove repeated preparation text, and respect intentional Learning-mode pauses |

The existing Agent Mode self-direction gate and unused Agent Mode section
builders were left in place by this session; their lifecycle belongs to the
concurrent removal. The new Astra follow-through branch also needs review against
whatever alternate paths survive that removal.

## What remains deliberately unchanged

Shared `corePolicy.ts` text: cyber safety, tool-data authority, runtime metadata,
prompt injection, hooks, durable instruction authority, retries and honest
reporting. Keep these semantics for every family even where vendor templates
omit them. Do not change permission-engine enforcement as part of a prose pass.

Also unchanged: URL boundaries, model/effort defaults, providers, authentication,
tool schemas and tool pool, Agent/Explore routing and background ownership,
provider-aware edit/diff rules, environment and transcript instructions, memory,
language, MCP guidance, custom/output-style replacement behavior, desktop peer
doctrine, and Claude prompt text. No new settings, migrations, telemetry, UI or
generated SDK types are needed for the proposed family axis. No DONE.md entry was
written.

## Earlier verification evidence and limits (historical)

Before this session's first code edit,
`bun test src/constants/promptAssembly.snapshot.test.ts` returned **5 pass / 2
fail**. The failures were existing drift: the minimal-tool snapshot lacked newly
added Bash/Read guidance, and the Agent Mode snapshot no longer matched the
concurrently changed assembly. The full 5.6 and Claude snapshots and the old
family-equivalence assertion passed.

At the operator's suggestion, GPT-5.6 Terra performed mechanical checks without
editing source. Its build ran while this session's draft was changing, so it is
not final verification of the completed rewrite:

- `bun run build:dev:full`: passed; maps lint reported 17 maps and seven existing
  recommendation warnings; undefined-name gate reported zero. The generated
  `./cli-dev --version` printed `2.1.87-dev.20260907.t063101.shaeeb38fc3`.
- `bun run lint:undefined-names`: passed, zero undefined names.
- `bun test src/constants/prompts.test.ts`: **0 pass / 1 fail / 1 error**, before
  tests ran, because it imports the concurrently removed
  `getAgentModeSystemPromptSections` export.

The two initial reported tree failures were no longer present at that check:
the map citation gate passed, and `analyzeContext.ts` had its `isEnvTruthy` import.
This session did not fix either. Other stale Agent Mode consumers may also block
policy/provider tests; reconcile them with the removal's owner when implementation
resumes.

Planned focused suites, after reconciling that concurrent change:

```sh
bun test src/constants/prompts.test.ts src/constants/promptAssembly.snapshot.test.ts src/constants/corePolicy.test.ts src/constants/systemPromptSections.test.ts
bun test src/utils/model/providers.test.ts src/utils/api.requestProvider.test.ts src/utils/providerPromptRegressions.test.ts src/tools/BashTool/prompt.test.ts src/services/api/claude-cache-scope.test.ts
bun run build:dev:full
```

Snapshots and source checks can establish emitted text, routing, cache behavior
and contract retention. They cannot establish task quality, reduced unnecessary
questions, better autonomy, or fewer tokens in actual model runs. No live-model
evaluation or ablation was run or is claimed.

```text
EARLIER VERIFICATION
- Pre-edit snapshot suite -> 5 pass / 2 existing snapshot failures
- Terra build:dev:full -> pass during partial edits, not final rewrite acceptance
- Terra lint:undefined-names -> pass, 0 undefined names
- Terra prompts.test.ts -> blocked at import: removed Agent Mode API
- git diff --check on this session's source paths -> clean
Stale-reference sweep: partial; family resolver has no assembly consumer yet, and old text assertions/snapshots remain intentionally unupdated at the pause.
Not run: post-rewrite snapshot acceptance, final focused suites and final build; implementation paused for planning. No eval harness or ablation.
```

## Final verification

`UPDATE_PROMPT_SNAPSHOTS=1 bun test src/constants/promptAssembly.snapshot.test.ts`
passed **15/15**. Both existing 5.6 diffs were read completely, both new Astra
snapshots were compared against 5.6, and Claude remained byte-identical. The
ordinary, non-update test run also passed all 15 tests.

The following combined run returned **113 pass / 1 fail**:

```sh
bun test src/constants/promptAssembly.snapshot.test.ts src/constants/prompts.test.ts src/constants/corePolicy.test.ts src/constants/systemPromptSections.test.ts src/utils/providerPromptRegressions.test.ts src/utils/model/providers.test.ts src/utils/api.requestProvider.test.ts src/tools/BashTool/prompt.test.ts src/services/api/claude-cache-scope.test.ts
```

The remaining failure is `FilePatchTool prompt refers to Apply_patch as a tool,
not a shell command` in `providerPromptRegressions.test.ts`. It expects
`Use the \`Apply_patch\` tool to edit files`, present in the fixed baseline
`e9fae3df354dba812b25b43ff969d23016354505:src/tools/FilePatchTool/prompt.ts`.
The concurrently dirty tool description now begins `Apply file edits with this
envelope:` instead. This session did not change that tool description or the
failing assertion. This is recorded as a concurrent failure, not a green suite.
The separate assertion affected by our intentional path-rule deduplication was
updated to read the exposed `FilePatchTool.prompt()` and still requires the
working-directory contract there; that test passes.

`bun run build:dev:full` passed: 17 maps / 7 recommendation warnings, zero
undefined names, and a successful bundle/compile. The version printed was
`2.1.87-dev.20260907.t153914.shae9fae3df`. The two failures reported at the start
of the original request and the later transient Agent Mode import failure were
absent; this session did not fix them.

The stale-call-site sweep finds every family-sensitive builder called with an
explicit family, including proactive source wiring; there is no family-dependent
session-guidance cache. The proactive feature is off in normal tests and
dev-full, so its branch is source-asserted rather than runtime-exercised. Output
style, model-switch, tool-presence, scoped authorization, shared policy retention,
and final OpenAI instruction-envelope checks run through actual assembly.
No live-model evaluation, ablation, or GUI verification was run. No behavioral
improvement is established.

```text
VERIFICATION
- Explicit snapshot regeneration -> 15 pass / 0 fail; full diffs reviewed
- Final focused battery (9 files, command above) -> 113 pass / 1 concurrent Apply_patch description failure
- bun run build:dev:full -> pass; 17 maps, 7 map warnings, 0 undefined names; version printed
- git diff --check on owned source/test/map paths -> clean
Stale-reference sweep: family builder call sites updated; default assembly and proactive source wiring covered. Historical dated reports preserve old text intentionally.
Not run: live-model eval/ablation (no harness); proactive runtime branch (feature off); GUI (no UI changes).
```
