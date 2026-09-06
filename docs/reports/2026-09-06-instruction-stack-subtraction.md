# What Cat Code's instruction stack should stop saying

Date: 2026-09-06. Status: analysis only; no prompt edits authorized or applied.

## Decision and evidence standard

**Recommendation: remove redundant instruction and generic tutorials before removing behavioral constraints. Do not adopt a percentage-reduction target, replace the entire harness with a tiny prompt, or use another product's prompt length as permission to keep ours unchanged.**

**Thesis verdict:** the strong historical claim, “frontier coding harnesses get shorter as models improve,” is not supported by the inspected sources. There are real cuts, additions, and model-specific differences, not a general downward trend. The narrower design principle survives: stronger models should need less elementary coaching, while new tools and product constraints can legitimately require more instruction. The former is a plausible removal hypothesis, not an experimentally demonstrated fact in this report.

This report distinguishes two kinds of evidence throughout:

- **Verified** means a source passage, assembly relationship, revision, or measurement was inspected. A verified duplicate is not a verified improvement in model behavior after deletion.
- **Suspected** means an inference about behavior or a proposed removal's performance effect. In particular, “the frontier model no longer needs this” requires a controlled before/after task evaluation; prompt source alone cannot establish it. No such model evaluation was run here.

The operator's statement that most real sessions use `gpt-*` is accepted as supplied context, not independently measured usage. The GPT path therefore gets priority. The current session identifies itself as GPT-6 Astra; the committed model configuration at the audit baseline lists GPT-5.6 Sol, Terra, and Luna. This is not evidence that those models have identical prompt needs, nor that Claude-specific removals automatically transfer to them.

## Audit boundary and reproducibility

**Verified baseline:** `61b518944f1eedf507794843182274d63e25abe7`, branch `migration`. The working tree was already dirty. Committed source was used for dirty files, especially tool prompts and the implementor agent. Other sessions' code, tests, reports, and map changes were neither adopted nor reverted.

Only this report is a deliverable. The audit covers the runtime system-prompt builders, tool-description prompt files, `src/context.ts`, `src/utils/claudemd.ts`, built-in agent prompts, coordinator instructions, and `app/sidecar/desktopSystemPrompt.ts`. Provider and CLI code were read only to establish placement and what the dump measures. Repository instruction files, skills, and rules are a separate surface, not audited here. Application logic and the desktop UI are not proposed for modification.

### What the model actually receives

**Verified:** Cat Code maintains two full default assemblies, but does **not** concatenate both into one request. The provider choice selects one side at [prompts.ts:919](../../src/constants/prompts.ts:919). The GPT style gets its own restatements; Claude also gets `Delivering work` and `Corrections` as separate sections. Shared policy constants are interpolated into the appropriate containers, not automatically sent as a second independent prompt.

**Verified:** other branches replace the default. [systemPrompt.ts:63](../../src/utils/systemPrompt.ts:63) selects override, Agent Mode, coordinator, agent, custom, or default instructions. A custom or agent prompt may not carry a rule that exists in the default prompt. A deletion justified as “already said elsewhere” must prove both occurrences are present in the **same delivered configuration**. Two source definitions serving mutually exclusive modes are not runtime duplication.

**Verified:** on the OpenAI path, [instructionAssembly.ts:39](../../src/services/api/instructionAssembly.ts:39) places assembled system sections and user context, including `claudeMd` and `currentDate`, into `instructions`; git status and cache-breaker context get a separate developer-context fragment. [context.ts:127](../../src/context.ts:127) explicitly identifies git status as a start-of-conversation snapshot. That warning and the actual environment facts are not programming lessons: the model cannot infer them reliably.

### Local dump measurement

**Verified:** the installed `cli-dev --version` printed `2.1.87-dev.20260905.t191836.shaee1c8af7`. Its named source revision and the audit baseline have no diff in the inspected system builders, core policy, output styles, effective-prompt selector, or dump entrypoint. This cross-check is narrower than proving that every bundled dependency equals HEAD: the binary can have been built from a dirty tree.

The following commands completed without a model request:

```sh
cd /Users/pt/cat-code && ./cli-dev --dump-system-prompt --model gpt-6-astra --provider gpt
cd /Users/pt/cat-code && ./cli-dev --dump-system-prompt --model claude-opus-5 --provider anthropic
```

| Dump | Unicode characters | UTF-8 bytes |
|---|---:|---:|
| GPT-6 Astra selection | 24,680 | 24,812 |
| Claude Opus 5 selection | 24,734 | 24,750 |

These are local **section-only observations**, including stdout's trailing newline, not total request sizes or token counts. The GPT dump contains `Apply_patch`, the Agent/skill guidance, the decision checklist, the token-budget paragraph, and transcript-reading guidance. It does not include tool schemas, loaded instruction-file bodies, the desktop addendum, or final provider serialization. The fixed dump now passes the default preset tool pool at [cli.tsx:156](../../src/entrypoints/cli.tsx:156), not an empty list. It still does not reproduce arbitrary MCP connections or tool restrictions.

**Verified limitation:** do not subtract the August report's 18,100-character GPT dump from today's 24,680 and call the difference instruction growth. The older measurement used an empty tool pool; the dump's configuration changed. Likewise, adding both provider totals would count mutually exclusive prompts.

A separate static measurement parsed TypeScript syntax and summed decoded string/template-literal fragments, including imports, inactive branches, and non-prompt strings. This is an inventory indicator, **not emitted instruction volume**:

| Revision | `prompts.ts` literal characters | `gpt.ts` literal characters | `corePolicy.ts` literal characters |
|---|---:|---:|---:|
| Initial private snapshot `86051a8e` | 34,207 | 20,621 | file absent |
| August 23 apply `aff3a3fa` | 33,406 | 21,622 | 3,557 |
| Audit baseline `61b51894` | 34,396 | 22,868 | 3,557 |

**Verified:** the maintained text inventory grew overall, while the Claude builder alone first shrank. **Suspected:** any causal connection between that growth and model quality. Extraction into shared constants, new modes, changed tool exposure, and new product contracts prevent interpreting the inventory as an apples-to-apples runtime trend.

## Comparators: six readable harnesses, not two anecdotes

Three Terra subagents extracted comparator sources and inventoried tool/agent text. Their results were used as leads. The main session re-read the load-bearing binary passages, public source, cut boundaries, and historical counts before making the recommendations. Two extractor errors mattered: Goose's February cut was **508 → 222** static words, not 222 → 176; and some generic Codex coding maxims were attributed to Sol although they belong to GPT-5.2. Both are corrected below. Catalog-string counts also exclude the newline that a shell JSON extraction can append.

### Claude Code: real replacement text, not proof of one current emitted prompt

**Verified:** the local fork-point artifact is `node_modules/@anthropic-ai/claude-agent-sdk/cli.js` (2.1.87), and the newer artifact is `/Users/pt/.local/share/claude/versions/2.1.239`. A raw `Buffer.indexOf(Buffer.from(phrase, encoding))` scan searched both UTF-8 and UTF-16LE, decoding only bounded matching slices rather than trying to convert the entire Mach-O into one string.

| Exact phrase | 2.1.87 | 2.1.239 |
|---|---|---|
| `# Harness` | absent | UTF-8 byte offset 301165276; UTF-16LE 143413156 |
| `# Delivering work` | absent | UTF-8 301178617; UTF-16LE 75358528 |
| `# Corrections` | absent | UTF-8 301180666; UTF-16LE 75362592 |
| `To read files use` | UTF-8 11453342 | absent in both encodings |
| `do not propose changes to code you ` | UTF-8 11448760 | absent in both encodings |
| `software engineering tasks` | present | present |

**Verified current literal:** “Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.” The surrounding `Harness` literals retain output rendering, denial handling, hook feedback, and clickable file references. The literal table includes allocation metadata between some fragments; it is not a clean contiguous serialized prompt.

**Verified addition:** `Delivering work` begins “Do ordinary work as asked, acting on the actual request rather than on speculation about what lies behind it.” `Corrections` begins “Avoid unnecessary or excessive self-correction.” This is not an upstream policy of deleting all generic behavioral coaching. Upstream retains some wording Cat Code already trimmed.

**Suspected, not established:** the active default 2.1.239 assembly uses precisely these blocks or has removed all semantics associated with the old strings. Binary presence proves availability, not selection; exact-string absence proves removal or rewording, not disappearance of the behavior. No whole-upstream-prompt size is asserted. The desktop `app.asar` was not inspected because no GUI parity claim is made; absence from the CLI is not used to reject the desktop file-link addendum.

### Codex CLI: historical counts hold; the “larger flagship floor” does not

**Verified:** local `codex --version` reports 0.149.0. Public source is [openai/codex at rust-v0.149.0](https://github.com/openai/codex/tree/rust-v0.149.0), resolved by the extractor to commit `758ef40f50c1a458425c7cfbf1eb12cbc07af0b0`. The main session fetched the tagged prompt sources and counted decoded Unicode characters and UTF-8 bytes.

| Tag | Prompt file under `codex-rs/` | Characters |
|---|---|---:|
| `rust-v0.1.0-alpha.3` | `core/prompt.md` | 5,698 |
| `rust-v0.20.0` | `core/prompt.md` | 23,430 |
| `rust-v0.40.0` | `core/gpt_5_codex_prompt.md` | 10,432 |
| `rust-v0.80.0` | `core/gpt-5.1-codex-max_prompt.md` | 11,693 |
| `rust-v0.148.0` | `models-manager/prompt.md` | 20,751 |
| `rust-v0.149.0` | `models-manager/prompt.md` | 20,751 |

**Verified:** these reproduce the August report's five static counts. **Limitation:** different model/file selections make this a non-monotonic inventory series, not a controlled same-model delivered-prompt series.

**Verified same-lineage deletion:** `core/gpt_5_codex_prompt.md` goes from 10,777 bytes at v0.80 to 6,647 at v0.148. A common-prefix/common-suffix comparison leaves exactly **4,130 removed bytes and zero added bytes**, beginning `Codex CLI harness, sandboxing, and approvals`. The surrounding text is unchanged. This verifies the old report's block-removal claim, not its separately rendered 4,027-byte permission-fragment measurement, which was not rerun.

**Verified current model-specific counterevidence:** [models-manager/models.json](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/models-manager/models.json) contains these decoded `model_messages.instructions_template` values:

| Catalog model | Priority | Characters | UTF-8 bytes |
|---|---:|---:|---:|
| `gpt-5.6-sol` | 1 | 17,730 | 17,766 |
| `gpt-5.2` | 29 | 21,544 | 21,672 |

The Sol count is also 17,730 at v0.148. Therefore the earlier report's claim that the newer Sol override is larger, making the GPT-5.2 delivered total a flagship floor, is **not supported by the bundled catalog**. It could differ with a refreshed remote catalog or active configuration; neither was exercised. No total request-size ordering follows from these templates.

**Verified distinction useful for this task:** GPT-5.2 retains “Fix the problem at the root cause,” “Avoid unneeded complexity,” and “Do not attempt to fix unrelated bugs or broken tests.” Those exact maxims do not appear in the inspected Sol template. Sol instead carries extensive personality/communication prose, compaction continuity, skills guidance, and explicit editing/authorization rules, including “Use `apply_patch` for local file edits” and preservation of a dirty worktree. Newer-model specialization can replace **which** guidance is emphasized without simply deleting instruction wholesale.

### Beyond the named floor

**Verified from pinned source:** four additional products were examined. These are static source/template measurements, excluding tool schemas and dynamic instructions; none is presented as a delivered total.

| Harness | Inspected source/revision | What changed or remains |
|---|---|---|
| OpenCode | [`gpt.txt` at `7c2199d8`](https://github.com/anomalyco/opencode/blob/7c2199d84a5830f70a8250731a42ff958145b4d6/packages/opencode/src/session/prompt/gpt.txt) | The same GPT template fell from 2,176 words at `da1d3727` to 1,492 at `72cb9dfa`, and remains 1,492 at the inspected revision. The March 29 commit explicitly says “adjust gpt prompt to be more minimal.” |
| Gemini CLI | [`snippets.ts` at `85aca163`](https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/packages/core/src/prompts/snippets.ts#L214-L260) | The modern-model branch still teaches context economics, search/read examples, engineering standards, inquiry-versus-directive behavior, and persistence. It is not merely a minimal wrapper. |
| Cline | [`system.ts` at `dac3b35b`](https://github.com/cline/cline/blob/dac3b35ba485dbab3b5a73aca239b0d07ce071cf/sdk/packages/shared/src/prompt/system.ts) | This module, containing default and YOLO templates, grew from 813 words at `b641c7f1` to 1,065 at `299a4a95` and remains 1,065. The June 19 patch added detailed independent-call guidance and examples to both templates. |
| Goose | [`system.md` at `5e909259`](https://github.com/block/goose/blob/5e90925962f05acf8e255032de44d16c4a7768a2/crates/goose/src/prompts/system.md) | [February 11's “Make the system prompt smaller”](https://github.com/block/goose/commit/12a346fec1bc1d31268b95440b7a1f38e5f3b4a9) cut its template from 508 to 222 words. The inspected later template is 176. The February patch deleted model-cutoff exposition, detailed extension procedures, and a Markdown tutorial. |

**Verified OpenCode qualification:** [system.ts:27](https://github.com/anomalyco/opencode/blob/7c2199d84a5830f70a8250731a42ff958145b4d6/packages/opencode/src/session/system.ts#L27-L48) selects different GPT, Codex, Gemini, Claude, and other model templates. The smaller GPT text still explicitly teaches `apply_patch`, shared-worktree preservation, non-interactive Git, autonomy, and output channels. Its history is a real cut, not proof that a particular new model caused it.

**Verified Gemini qualification:** [promptProvider.ts:81](https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/packages/core/src/prompts/promptProvider.ts#L73-L83) selects modern versus legacy snippets; [models.ts:486](https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/packages/core/src/config/models.ts#L486-L496) includes Gemini 3 and custom models in “modern.” Modern source still explains its non-inferable `wait_for_previous` sequencing mechanism and forbids same-file parallel edits at [snippets.ts:415](https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/packages/core/src/prompts/snippets.ts#L415-L432). It does omit the legacy final reminder in the assembly. Modern is a selection boundary, not a synonym for universally shorter.

**Verified Cline qualification:** [cline.ts:158](https://github.com/cline/cline/blob/dac3b35ba485dbab3b5a73aca239b0d07ce071cf/sdk/packages/shared/src/prompt/cline.ts#L158-L218) adds mode-tag and plan/act contracts plus workspace metadata to the chosen base. Its added parallelism examples directly disconfirm the notion that harness authors uniformly stop giving examples as models improve. They do not establish that Cat Code should copy them.

**Verified Goose qualification:** [prompt_manager.rs:110](https://github.com/block/goose/blob/5e90925962f05acf8e255032de44d16c4a7768a2/crates/goose/src/agents/prompt_manager.rs#L110-L178) renders extension instructions and appends additional instructions; lines 232–244 add operation-specific parts and project hints. Its 176-word source file is not a 176-word coding harness. Its deleted Markdown tutorial is nevertheless a concrete comparator for S4: keep the desired format, stop teaching basic composition.

**Suspected causal conclusion:** improvements in model capability made these cuts safe. None of the inspected source revisions supplies a controlled evaluation establishing that cause. The verified result is narrower and still useful: generic text is neither universally necessary nor universally being retired; product-specific contracts persist even in the lean examples.

## Earlier reports: what still holds

### August 20 Codex trend report

**Verified from the report itself:** [the Codex trend report](2026-08-20-codex-cli-harness-prompt-trend.md) explicitly labels its Codex measurements delegated rather than independently reproduced. Its table switches between generic fallback prompts and model-specific selected prompts. Its own conclusion that the series is non-monotonic is materially different from “every new release should be shorter.”

**Rejected inference:** section 7's “Settled: the GPT-targeted prompt needs no cut.” Even if Cat Code were 69% of a correctly comparable Codex prompt, relative length cannot establish the marginal usefulness of any Cat Code sentence. A larger comparator is not a clean bill of health. Conversely, a shorter comparator does not license deleting our authorization rules. The report's distinction between relocation and actual delivered savings remains important.

### August 23 removal audit

**Verified:** its opening “Nothing applied” describes that session, not today's source. Commit `aff3a3fa2039e4ca092922abac2e5222089c38d3` subsequently changed the builders. Current source confirms:

- F1's broken help/feedback interpolation is gone from both default prompt builders. The build macro still exists; it is not evidence that the bad sentence is emitted.
- F2's `This is CRITICAL` emphasis, F3's `not a suggestion`, and F4's `try to identify root causes` are gone from their identified core-prompt locations.
- F5/F6's shorter capability and time-estimate wording landed. The capability compliment itself survives and remains a candidate below.
- G1–G4's unwanted import wording is absent; the trimmed delivery and correction text is now present. Those are not pending imports.
- F7's four-bullet TaskStop description still exists at [TaskStopTool/prompt.ts:3](../../src/tools/TaskStopTool/prompt.ts:3). It remains under-specified about lifecycle, but this pass did not independently establish the runtime stop behavior, so the old proposed additions remain suspected and must not be applied blindly.
- F8's tool-description teaching material remains a real audit target, but its old source-file sizes were not runtime sizes.
- F9 concerns the separately loaded repository instructions and is outside this pass.

**Disagreement with the earlier rationale:** “a current model reads a hedge literally,” “bulk inflates adaptive-thinking spend,” and “current models are proactive by default” are behavioral claims, not conclusions established by matching words in source. Their status here is **suspected**, not verified. The removal case is strongest when it survives without those claims: duplicated semantics, irrelevant teaching examples, or a false runtime description.

### August 23 upstream delta

**Verified:** the proposed Claude `Delivering work` and `Corrections` sections landed at [prompts.ts:290](../../src/constants/prompts.ts:290), with corresponding GPT amendments at [gpt.ts:151](../../src/constants/promptStyles/gpt.ts:151), [gpt.ts:351](../../src/constants/promptStyles/gpt.ts:351), and [gpt.ts:468](../../src/constants/promptStyles/gpt.ts:468). Cyber-policy clarification, skipped-step reporting, and compaction continuity also exist in current source.

**Correction to its applicability:** the claim that Cat Code lacks the imported delivery prose is no longer current. Its B7 comparison also predates the GPT path allowing targeted `rg`, `sed -n`, and git inspection through Bash. Its blanket “keep” disposition on all communication/coding material is not a reason to retain generic examples indefinitely. Its caution about GUI-specific text and absence from a single upstream assembly remains valid.

### September 5 GPT-stack audit

**Verified:** [that report's status section](2026-09-05-gpt-instruction-stack-audit.md#status-2026-09-05-after-fixes), not its opening findings list, records fixes for 1–7, 9–11, 13, and A1. Narrow source checks agree: ambiguity-first plan-mode wording, optional rather than required background execution, `cell_id`, `.cat-code` cron/team paths, enabled-tool-pool selection in Bash, the real-tool-pool dump, and the Claude wrapper's explicit instruction-file exception.

**Verified still present:** finding 8's tension between a mandatory prior `Read` result at `gpt.ts:154` and permitted shell reads at `gpt.ts:441`; finding 12's “user-invocable skills section” label at `gpt.ts:399,484`. No new runtime exploit or failure claim is made for either. The read-policy inconsistency needs a separate semantic decision, not deletion of read-before-edit discipline under a model-strength pretext. The skill label is a low-impact wording defect, not a major subtraction opportunity. Dirty excluded files remain other sessions' work.

## Core-system cuts and retained boundaries

The actions below are recommendations for a separate apply decision. Every listed location is verified in the baseline. The stated original guards are inferred from the instruction's content unless an incident or decision is explicitly cited; historical motivation is otherwise suspected. Behavioral effects after any removal, even duplication removal, remain suspected.

### S1. Delete the second GPT action-decision checklist

**Verified text:** [gpt.ts:197–201](../../src/constants/promptStyles/gpt.ts:197), from `DECISION CHECKLIST before any action:` through `stop, diagnose the root cause instead.` The five source lines contain 347 characters, including the closing source delimiter.

**Original guard:** classify local versus risky work, require appropriately scoped permission, and prohibit bypassing safety mechanisms.

**Recommendation:** delete this checklist, not the action policy. All four decisions are already stated immediately above it: the priority rule at 181–185, instruction authority at 187, concrete action categories at 189–193, and obstacle rule at 195. This is same-request duplication, not a claim that GPT has learned our permission policy. No replacement text is needed.

**Why now:** maintaining two formulations creates another place for authorization exceptions to drift. The current model gets one complete contract without being made to rehearse it twice. **Suspected:** reduced friction or fewer unnecessary confirmations; no behavioral saving is measured.

### S2. Delete elementary task-interpretation and capability coaching

**Verified text:** the `TASK DOMAIN` example about changing `methodName` to `method_name` at [gpt.ts:149](../../src/constants/promptStyles/gpt.ts:149), and its longer counterpart at [prompts.ts:253](../../src/constants/prompts.ts:253). The first sentence of the next rule in each builder says `You are highly capable and can handle ambitious tasks.`

**Original guard:** answering a requested code edit as a string-manipulation question, or refusing a task because it looks ambitious.

**Recommendation:** remove the snake-case worked example and the capability compliment. Retain a short contextual instruction to interpret coding requests in the working repository, and retain the user-authority clause about task size. The existing role declaration, actual user task, tools, scope rule, and completion/reporting contract already explain the job.

**Why now:** these passages teach ordinary coding-assistant intent rather than Cat Code behavior. **Suspected:** the frontier GPT models in use can infer the example without it. This is a better ablation candidate than removing the deference or completion requirement; neither of those is merely intelligence coaching.

### S3. Remove repeated programming maxims, not the coding preferences

**Verified text:** [gpt.ts:138–142](../../src/constants/promptStyles/gpt.ts:138) and [prompts.ts:243–248](../../src/constants/prompts.ts:243). Specific expendable clauses include `These are real failure points. The rule is: no defensive code for hypothetical internal failures; yes to error handling at real external boundaries.`, `The right complexity level is exactly what the task requires.`, and `Three similar lines of code is better than a premature abstraction.`

**Original guard:** defensive over-engineering, speculative abstractions, and comments that merely narrate code.

**Recommendation:** retain the explicit policies: do only the requested scope; validate real external boundaries; do not add hypothetical compatibility or abstraction machinery; comment non-obvious constraints and preserve valid existing comments. Delete the restatements and the three-lines maxim. Keep one owner for the comment policy rather than describing its quantity in both scope and comment rules.

**Why now:** the surviving rules state the operator's non-inferable preferences. The removed sentences illustrate or repeat them; they do not supply a tool contract. **Suspected:** a frontier model needs fewer such illustrations. Do not turn “models are stronger” into “the model shares our taste,” or change this into a ban on all helpers.

### S4. Replace the writing lesson with the actual output contract

**Verified text:** [gpt.ts:341–345](../../src/constants/promptStyles/gpt.ts:341) and [prompts.ts:507–511](../../src/constants/prompts.ts:507). The paragraphs teach complete grammar, acronym expansion, expertise matching, table composition, semantic backtracking, inverted pyramid structure, avoidance of filler, and avoidance of overselling.

**Original guard:** cryptic progress logs, overlong reports, table abuse, and repetitive status narration.

**Recommendation:** keep the product-specific output requirements and the operator's style choices in concise form: a brief preamble and meaningful milestone updates, understandable explanations, concise prose, tables only for compact facts, no unsolicited follow-on offers, accurate completion and correction reporting. Remove the generic composition tutorial, such as `each sentence should build meaning linearly so the reader never needs to re-parse`, and the repeated injunctions to be brief already owned by tone and output rules.

**Why now:** a writing-capable model can choose sentence structure from an output goal; it cannot infer that this UI hides most tool calls, that the operator dislikes open endings, or which link syntax opens a file. **Suspected:** compression preserves clarity. Do not delete the entire output section on faith. The `Remove this section when we launch numbat` comment at [prompts.ts:502](../../src/constants/prompts.ts:502) is a historical intent marker, not verified proof that the release condition has occurred or an evaluation passed.

### S5. Stop carrying a transcript-query cookbook in every default prompt

**Verified text:** [prompts.ts:1250–1303](../../src/constants/prompts.ts:1250). Both default providers unconditionally register `session_transcripts` at [prompts.ts:707](../../src/constants/prompts.ts:707). The observed rendered section was 1,939 Unicode characters. Lines 1285–1301 alone contain 633 source characters: four sample queries and a sample `.meta.json` object.

**Original guard:** expensive transcript reconstruction, wrong-directory prefix searches, confusing a parent with its subagent, and writing custom parsers unnecessarily.

**Recommendation:** delete the query examples and specimen metadata object; keep the source paths, JSONL format, unambiguous prefix resolution, preference for the available session-reading tool, raw-event fallback, and instruction to inspect the sidecar metadata for lineage. These are the facts a model cannot derive from the user's request. A model can inspect an actual JSONL row to learn field structure without carrying four sample greps on unrelated tasks.

**Why now:** this is ordinary data inspection wrapped around genuinely Cat-specific path information. **Suspected:** frontier models can do the inspection from a compact contract. Moving the entire block to an already existing session-analysis workflow is a separate reachability decision, not counted here as a deletion or promised saving.

### S6. Delete temporary-file examples and Learning-mode examples

**Verified text:** the six-line temporary-file enumeration at [prompts.ts:1205–1210](../../src/constants/prompts.ts:1205) is 321 source characters. Learning mode's three example requests at [outputStyles.ts:96–129](../../src/constants/outputStyles.ts:96) occupy 2,364 source characters.

**Original guard:** placing scratch files in the user's project, and explaining the intended human-contribution teaching style.

**Recommendation:** delete the scratchpad enumeration but keep the actual directory, isolation fact, `/tmp` exception, and applicable permission semantics. Delete the Sudoku, file-upload, and calculator worked examples but keep Learning mode's request template, contribution criteria, `TODO(human)` invariant, and stop-and-wait behavior at [outputStyles.ts:68–94](../../src/constants/outputStyles.ts:68).

**Why now:** examples of an intermediate file and examples of a pedagogical request are inferable from the retained instructions. The session-specific directory and unusual hands-on waiting protocol are not. **Suspected:** examples add no useful behavior on current models. **Verified limitation:** these blocks are conditional; the measured default dumps did not include either scratchpad instructions or Learning style. Do not add their savings to a default-session total.

### S7. Shorten the instruction-file wrapper without deleting provenance

**Verified text:** [claudemd.ts:93–96](../../src/utils/claudemd.ts:93) puts `Be sure to adhere to these instructions. IMPORTANT: these instructions OVERRIDE any default behavior and you MUST follow them exactly as written.` before the shared, more precisely scoped `INSTRUCTION_AUTHORITY_RULE`.

**Original guard:** treating loaded instruction files as ordinary file data rather than durable user instructions.

**Recommendation:** keep the source labels, the shared authority rule, and the separate “recalled memory is background, not instructions” framing. Delete the redundant exhortation and broad `OVERRIDE any default behavior` preface. The shared rule already identifies the authority, permitted actions, and safety limit. This cut removes an overbroad restatement; it does not ask the model to invent an authority hierarchy.

**Verified caution:** the wrapper serves a separate container, including the Claude user-context route. Do not delete the authority rule from the wrapper merely because the default system action section also contains it. [claudemd.ts:1205](../../src/utils/claudemd.ts:1205) separates loaded instructions from recalled memory; that distinction must survive.

## Tool descriptions and agent instructions: where the larger cuts are

**Verified inventory:** all 40 `src/tools/*/prompt.ts` files total 153,641 Unicode source characters at the baseline. The inventory includes eight built-in-agent source modules plus the routing helper/test distinction and the coordinator module. Source counts include code, imports, comments, inactive variants, and literal delimiters. SkillTool's 271 source lines, for example, include description-list budgeting and caching; the GPT-emitted instruction body is only lines 178–198. File line count is a poor priority metric.

The complete tool-file inventory was: Agent, AskOrchestrator, AskUserQuestion, Bash, Brief, ClaudeCli, Config, EnterPlanMode, EnterWorktree, ExitPlanMode, ExitWorktree, FileEdit, FilePatch, FileRead, FileWrite, Glob, Grep, LSP, ListMcpResources, MCP, NotebookEdit, PowerShell, ReadMcpResource, RemoteTrigger, ResumeAgent, ScheduleCron, SendMessage, Skill, Sleep, TaskCreate, TaskGet, TaskList, TaskStop, TaskUpdate, TeamCreate, TeamDelete, TodoWrite, ToolSearch, WebFetch, and WebSearch. The names correspond to their `<Name>Tool/prompt.ts` directories, including the `AgentTool` directory. This is inventory coverage, not a claim to have tested every described tool.

### T1. Delete the prime-function → test-runner demonstration

**Verified text:** [AgentTool/prompt.ts:214–237](../../src/tools/AgentTool/prompt.ts:214), 734 source characters excluding the final line break. It writes a prime-checking function, invents a `test-runner` role, and says “Since a significant piece of code was written and the task was completed, now use the test-runner agent to run the tests.”

**Original guard, inferred:** teaching how a task-specific agent description can trigger delegation.

**Recommendation:** delete the whole `currentExamples` body and its normal-path append, preserving the live agent roster, selection criteria, fresh-context requirement, and asynchronous lifecycle rules. The body is appended on the non-fork, non-coordinator, non-Agent-Mode path at [AgentTool/prompt.ts:435](../../src/tools/AgentTool/prompt.ts:435), including GPT.

**Why now:** it supplies no API fact and competes with the current policy that file count or simply having written code is not sufficient reason to spawn a reviewer. Its toy algorithm and fictional agent roster are needless context. **Suspected:** the example actively over-triggers delegation; that behavioral outcome was not measured. The contradiction in emphasis and lack of unique contract content are visible without an evaluation.

### T2. Remove duplicate task examples and motivational TodoWrite prose

**Verified text:** [TodoWriteTool/prompt.ts:30–145](../../src/tools/TodoWriteTool/prompt.ts:30), 5,841 source characters excluding the final line break, contains **eight** narrated use/non-use scenarios, not five. It includes dark mode, multi-file renaming, e-commerce, React optimization, Hello World, `git status`, one comment, and `npm install`. The introduction says task tracking helps “demonstrate thoroughness”; line 183 says it “demonstrates attentiveness.”

**Recommendation:** delete those scenarios and the performative motivation, retaining purpose, activation criteria, state transitions, `content`/`activeForm`, immediate updates, and truthful completion rules. Also remove the GPT branch's final `DEFAULT BEHAVIOR` recap at 226–228, which restates the positive and negative trigger lists.

**Why now:** the task-state contract can teach a frontier model this tool without eight examples of ordinary task complexity. **Suspected:** no quality loss. **Verified limit:** [TodoWriteTool/prompt.ts:231](../../src/tools/TodoWriteTool/prompt.ts:231) already selects a compact GPT variant, so the large example cut benefits the Claude path, not the main GPT workload. Do not claim 5.8k of GPT savings.

### T3. Let one live surface own shell mechanics

**Verified duplication:** [BashTool/prompt.ts:319–325](../../src/tools/BashTool/prompt.ts:319) repeats the GPT system's file-mutation, show-the-diff, read/search, and tool-routing text at [gpt.ts:236–288](../../src/constants/promptStyles/gpt.ts:236). Bash's independent-command example at 239 is also pedagogical material atop the system's independent/dependent-call rule. Its live working-directory behavior at 270–272 is different: that is a contract.

**Recommendation:** in a future apply, retain these mechanics in the Bash description and remove the duplicate **system** copies only when Bash is actually enabled and carries the same rule. Do not delete the Bash copies globally: custom/agent prompts can replace the system while still exposing Bash. Retain the system's cross-tool parallelism rule; delete only Bash's “git status and git diff” illustration, not `&&`, `;`, or command-string constraints.

**Why now:** two copies do not teach a stronger model anything new, and duplicate owner text has already required provider-specific repairs. **Verified caveat:** this is a configuration-aware deduplication, not an unconditional text-only delete. It is lower priority than T1 because it needs assembly coverage tests. No change to application logic is authorized by this report.

### T4. Delete redundant invocation and plan-selection examples

**Verified text:** [SkillTool/prompt.ts:186–190](../../src/tools/SkillTool/prompt.ts:186) and 209–213 list four invocations; [EnterPlanModeTool/prompt.ts:58–78](../../src/tools/EnterPlanModeTool/prompt.ts:58) repeats good/bad cases already illustrated at 33–54.

**Recommendation:** for Skill, remove the bare `pdf`, `commit`, and `review-pr` demonstrations; retain one fully qualified name example because namespace syntax is product-specific. Keep invocation order, list location, no reinjection while instructions remain visible, and built-in-command exclusions. For EnterPlanMode, remove the second example family beginning `## Examples`, **not** the interpolated `whatHappens` block on the same source line, and retain the explicit user-approval note.

**Why now:** names-plus-arguments and the difference between a typo and an architectural choice are basic inferences. **Suspected:** no loss in selection quality. A future apply must preserve the approval transition and its source interpolation, not delete a range mechanically because the heading shares a line.

### T5. Remove verifier persuasion and cross-domain test recipes

**Verified text:** [verificationAgent.ts:17–20](../../src/tools/AgentTool/built-in/verificationAgent.ts:17), 34–44, 53–60; Claude equivalents at 100, 118–128, 141–149, and the 718-character bad/good report example at 181–203.

**Original guards, explicit in the text:** verification avoidance, mistaking a happy path for correctness, and reporting a pass without command evidence.

**Recommendation:** delete “Your value is in finding the last 20%, not praising the first 80%,” threats about the caller rejecting the report, the catalogue of imagined excuses, the example registration endpoint, and the ten-domain testing cookbook. Keep the general requirement to exercise the changed behavior against expected output, reproduce bug fixes, run applicable repository checks, select a realistically adversarial probe, distinguish environmental limitations, and supply exact commands/results with the verdict. Keep tool-availability checks and all project-write/install/Git restrictions.

**Why now:** a strong coding model can choose tests from the actual change and repository better than from a standing list spanning mobile simulators, database up/down migrations, ML pipelines, and Terraform. Generic recipes such as “Start dev server” and “kill and relaunch” cannot substitute for authorization or the target's own verification battery. **Suspected:** this improves judgment and avoids irrelevant work; not benchmarked. The permission gate is not removed, and this recommendation is not authorization to run those recipes.

### T6. Stop prescribing how a planner thinks; retain what it must return

**Verified text:** [planAgent.ts:38–62](../../src/tools/AgentTool/built-in/planAgent.ts:38) forces four phases and “Read at least 3 real examples before moving to Phase 3.” Lines 55 and 57 independently say to follow repository conventions. Explore's `Strengths` list at [exploreAgent.ts:39–42](../../src/tools/AgentTool/built-in/exploreAgent.ts:39) and 71–74 praises globbing, regex search, and reading.

**Recommendation:** delete the generic phase narration, duplicate conventions clause, and strengths list. Replace the planner's unconditional three-example quota with “Inspect the relevant existing patterns before proposing the approach.” Retain read-only restrictions, no temporary-file writes, available-tool facts, scope, routing, actual file evidence, dependencies/tradeoffs, and the required final output contract.

**Why now:** the task determines whether one canonical implementation or several examples are needed; three is not evidence quality. **Suspected:** the numerical quota buys no useful calibration on current models. Its removal changes a search policy, unlike deleting a duplicate, so it needs a focused plan-quality comparison. Explore is pinned to Luna in the inspected source; do not evaluate only the main frontier model and assume the worker path is covered.

### T7. Delete the implementor's second tool-routing paragraph

**Verified text:** committed [implementorAgent.ts:56](../../src/tools/AgentTool/built-in/implementorAgent.ts:56) repeats the build/edit/search routing already given at 38–40. The working file is dirty and may no longer share those line numbers.

**Recommendation:** delete only that repeated GPT paragraph. Retain the local-check obligation, narrow scope, handoff status, read-before-work context, safety boundaries, and explicit statement that the main agent owns overall completion. **Why now:** exact same-role repetition, not a presumed upgrade in worker intelligence. **Suspected:** any runtime improvement beyond fewer characters.

### T8. Retire coordinator stories only if that mode is being maintained

**Verified text:** [coordinatorMode.ts:175–199](../../src/coordinator/coordinatorMode.ts:175), 270–277, 281–287, 306–315, 317–332, and 346–377 contain narrated lifecycle, good/bad briefs, correction examples, and an end-to-end auth story. Some examples tell a worker to change assertions after a failed check or create/push a branch and draft PR.

**Recommendation:** remove these stories; retain actual notification shape, stopped-versus-running continuation routes, worker context limits, synthesis responsibility, and the mode's actual output/lifecycle requirements. Do not infer the right test behavior from “update the assertions” in a made-up story. Preserve the lead sentence explaining continuation context at 306 if deleting the sample below it.

**Verified priority limit:** coordinator selection requires `COORDINATOR_MODE`, which is absent from the inspected `build:dev:full` feature list. This is latent source cleanup, **zero claimed default GPT savings**. It should not displace the live-path cuts above. `KAIROS_BRIEF`/`KAIROS_CHANNELS` are not proof that the separate `KAIROS` or `PROACTIVE` prompt branches ship either.

### Deliberately not nominated

**Verified content, retained recommendation:** Apply_patch's grammar and contextual-hunk examples describe a bespoke parser, not ordinary unified diff. Statusline's stdin fields are a product schema; replacing them with “you know JSON” would make the model guess keys. Cron examples are entangled with local-time, jitter, one-shot, durability, and idle-firing behavior. Resume/Send/Stop distinctions are actual lifecycle facts. General-purpose and implementor boundaries state who owns the task and its result. None is a safe bulk deletion merely because it has an example or a long source file.

## What must not be cut on the strength of this thesis

**Verified contracts; recommendation to retain:**

- [corePolicy.ts:25–68](../../src/constants/corePolicy.ts:25): security-assistance boundaries; tool-output versus durable-instruction authority; runtime metadata provenance; hook limits; scoped durable authorization; honest results; retry budgets and the prohibition on forcing tests to pass. Model capability does not identify who authorized a risky action.
- Actual editing, shell, search, and asynchronous-tool semantics. A trained model cannot know this fork's working-directory persistence, patch path base, resumed-agent lifecycle, result delivery, or tool aliases without being told.
- Actual environment facts, instruction-file origin labels, and the git-snapshot warning. Do not replace those with “inspect the environment yourself” and claim a token saving while requiring more tool calls.
- Compaction and result-clearing facts at [prompts.ts:154](../../src/constants/prompts.ts:154) and [prompts.ts:1217](../../src/constants/prompts.ts:1217). They describe harness behavior, not a request for private chain-of-thought or a generic instruction to think harder.
- Explicit token-target mechanics at [prompts.ts:688](../../src/constants/prompts.ts:688). The normal build includes `TOKEN_BUDGET`; the paragraph states unusual continuation semantics. The comment explains why a naive tail-attachment relocation misses first-response and continuation paths. A smaller rewrite could be considered later, but deleting it because most turns have no target would trade away a contract.
- The desktop file-link sentence at [desktopSystemPrompt.ts:25](../../app/sidecar/desktopSystemPrompt.ts:25). It deliberately supersedes the terminal convention. One model serving two renderers cannot infer which link format is active.
- The peer doctrine at [desktopSystemPrompt.ts:51](../../app/sidecar/desktopSystemPrompt.ts:51), including its one worked example. [PEER-SESSIONS:436](../migration/decisions/PEER-SESSIONS.md:436) records the operator's September 6 decision to use a guideline with one example, rather than a procedural rule list. The example teaches peer versus subagent ownership and reporting, not how to search a file. Creation permission, different permission modes, no denial laundering, and quoted-data boundaries remain essential. This audit does not reopen that decision.

**Scope boundary:** the repository's locked architectural decisions, shared-tree rules, live-state protections, and desktop security baseline are separately loaded constraints. They were noted, not audited for removal. Having one human does not eliminate concurrency, publishing risk, or private data. No wire contract, security gate, or locked decision is proposed for change.

## Apply decision: what to authorize first, and what remains unproved

**Recommended first tranche:** S1, S2, the explicitly quoted redundant clauses in S3, T1, T4, and T7. These have named boundaries, modest reach, and leave the meaningful contract in place. S7 should accompany an authority-container test because of where it is injected. The larger, judgment-sensitive tranche is S4–S6 and T5–T6; T3 needs tool-presence-aware assembly work. T2's large saving is Claude-only; T8 is not a normal-build saving.

This is **not** a proposal to move deleted tutorials into new always-loaded skills. That would preserve the same instruction tax and add discovery machinery. Nor should the fork collapse its two provider assemblies solely to reduce source lines: source deduplication and delivered prompt subtraction are different decisions.

**Verified evidence gap:** no controlled removal experiment was run. To establish “why now” behaviorally, compare the unchanged baseline with one cut group at a time using identical tasks, enabled tools, project context, model, and effort. Evaluate the actual model/role affected, including Luna workers, not only Astra. Relevant observable checks are:

- A small edit stays small, modifies the requested code rather than answering abstractly, and avoids unnecessary planning/delegation.
- A multi-step task finishes its requested scope, reports failed/skipped checks honestly, and does not manufacture activity to fill a checklist.
- A permission-sensitive operation, denied call, misleading tool result, or dirty shared file preserves the same boundary as the baseline.
- A transcript lookup finds the correct session and distinguishes partial work from completed results without a cookbook.
- The reduced output guidance produces understandable progress and an accurate final report; learning mode still stops for the human contribution.
- A verifier chooses a relevant executable probe without unauthorized GUI/database/infrastructure actions, and a planner produces an evidence-grounded approach without a fixed file quota.

Measure success, scope errors, boundary violations, unnecessary tool/agent calls, instruction tokens, total turn count, and delivered-output quality. Smaller input is not a success if it causes extra searches or worse decisions. Static string-presence tests can protect contracts and selection; they cannot prove a model no longer needs coaching. No universal percentage saving is asserted, and the source-range counts above must not be summed across mutually exclusive modes.

**Final judgment:** stop teaching the model elementary coding-assistant behavior, stop repeating contracts in the same request, and stop supplying universal workflow stories where the actual task supplies a better plan. Keep telling it how this particular harness works and what the operator permits. The evidence supports that targeted subtraction today, not a law that all harness instructions should shrink monotonically with model capability.

## Search record and verification

**Verified discovery method, bounded as of 2026-09-06:** the comparator worker found `/Users/pt/opencode` in a bounded local source search, then read public repository trees, prompt files, and same-file commits for OpenCode, Gemini CLI, Cline, and Goose. These four are the evidence discovered beyond the operator's named floor. The corpus is a readable-source sample, not an exhaustive census of all coding harnesses.

Actual public-source query families were GitHub `git/trees/<branch>?recursive=1`, `contents/<path>?ref=<sha>`, and `commits?path=<path>&sha=<branch>&per_page=20`; main-session checks used pinned `raw.githubusercontent.com/<owner>/<repo>/<sha-or-tag>/<path>` fetches and `gh api repos/<owner>/<repo>/commits/<sha>`. No private source was uploaded. Current comparator snapshots are pinned above rather than described as perpetually “latest.”

Local investigation used `git show <baseline>:<path>`, targeted `Read`/`rg`/`git grep`, `git log`/`git diff`, the two dump commands above, a raw dual-encoding binary scan, and TypeScript AST literal counts. No provider requests were made to evaluate candidate cuts. Delegated research itself used the operator-authorized Terra subagents.

**Execution errors, not hidden evidence:** an initial inline Bun command failed because the shell escaped `!`; it was corrected by using a truthy exit-code check. Two later inline source-fetch expressions had an extra closing brace and were replaced with simple `curl` pipelines. No failed extraction supplied a measurement. The comparator worker's first whole-binary decoder failed; bounded raw-byte scans succeeded. A worker's unsupported GitHub-search JSON field was not used; public tree/content/commit endpoints supplied its evidence. Follow-up messages to already completed subagents returned “stopped”; results were retrieved with TaskOutput without restarting them.

The documentation battery and final link/stale-reference checks are recorded below. Only the new report is intended for staging. `DONE.md`, migration STATUS, prompt sources, and other sessions' changes are untouched.

**Verified stale-reference sweep:** a tracked-repository `git grep` over the audit baseline covered code, imports, configuration, tests, YAML, and Markdown, excluding vendored source and the lockfile. The eight quoted old/current anchors matched 17 files: six historical reports/plans; five build/type/config macro locations; three intended live candidates (`gpt.ts`, Plan, TodoWrite); one unrelated LSP comment; one out-of-scope role instruction; and the guide agent's third-party-service feedback-macro consumer. That last consumer explains why F1's removed core-prompt interpolation does not imply the macro is unused. No name or interface was removed by this documentation-only pass, so historical quotations and live candidates are expected hits, not leftover implementation edits. No audited core/addendum source differed from the pinned baseline at the final drift check.

```text
VERIFICATION
- git diff --check → clean.
- bun run maps:lint → passed: 18 maps, 7 warnings.
- Report link-target check → 47 local links resolve; 13 public source links.
- Local dual-encoding Claude scan → completed; presence/absence claims limited to exact literals.
- Codex tagged-source recount → all five historical character counts reproduced.
- Same-file source counts → OpenCode 2176→1492; Cline module 813→1065;
  Goose February commit 508→222, inspected later template 176 words.
- ./cli-dev --version → 2.1.87-dev.20260905.t191836.shaee1c8af7.
- Two --dump-system-prompt commands → completed; section-only results above.
Stale-reference sweep: 17 matching files, classified above; no prompt edits applied.
Not run: engine build/test or desktop battery, because only this report changed.
Not run: behavioral prompt ablations, real model comparison sessions, GUI automation,
  Claude desktop asar extraction, or final outbound-request capture.
```

The seven map warnings concern missing recommended sections in existing maps (`build-release-testing`, `ide-lsp`, `native-client-integrations`, `plugins-skills-commands`, and `proactive-assistant-services`). They were present before this report and remain unfixed; the map lint exit status is zero.
