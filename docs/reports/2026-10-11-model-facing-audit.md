# Cat Code model-facing audit

Date: 2026-10-11. Initial source snapshot: `b05de039b5935e0360f9476ae4fbdabccad99b35`. Independent verification checked the current working tree through HEAD `eee500463cfa24a3f91c8989458d64353e24eec4`.

This audit covers surfaces that change what the model sees, how it acts, and how much work a request performs. Five subagents audited independent lanes, with at most three subagents running concurrently because of the session limit. The parent checked production call chains and independently reran probes from every lane. This audit changed no repository code or tests. Existing untracked files were preserved.

Another session committed two research documents during the audit, moving HEAD to `870b7630e650c2f515f604c8404d277d551fbe94`, and edited `app/sidecar/sidecarServer.test.ts` and `app/sidecar/workerOutcomeRestore.integration.test.ts`. These changes were left intact. The audited runtime source did not change between the initial snapshot and the final check.

Result: **13 confirmed findings: 4 P1 and 9 P2.** P1 means a supported operation fails or silently loses essential information. P2 means a conditional correctness or performance defect. These priorities describe the demonstrated consequence, not measured incident frequency. Findings 10 and 13 require runtime features whose defaults are disabled; this audit did not inspect live remote flag values.

Three additional subagents independently verified every finding in parallel, splitting findings 1–5, 6–10, and 11–13. All findings remained supported. This revision incorporates stronger production-path evidence and clarifies the exposure of findings 6, 7, 12, and 13. The verification made no runtime or repository-test edits and preserved other sessions' work.

## Confirmed findings

### 1. P1: Claude workers under a GPT parent lose their selected provider

**Trigger:** An OpenAI session explicitly spawns a worker with `model: claude-opus-5-5`.

`resolveAgentModel()` correctly selects the Claude model and, in the tested Anthropic configuration, the `firstParty` provider. The worker carries that provider into the query, and the shared request builder resolves it at [claude.ts:1250](../../src/services/api/claude.ts#L1250). However, [streaming client creation](../../src/services/api/claude.ts#L2091) omits the provider. [Nonstreaming fallback](../../src/services/api/claude.ts#L1015) has the same omission. [getAnthropicClient()](../../src/services/api/client.ts#L435) then resolves against the process-global OpenAI provider.

**Observed:** Independent verification used unmocked native client selection and `queryModelWithStreaming()`. In empty isolated state, omitted client provider returned `No healthy Codex account is available for this request`; explicit `firstParty` constructed an Anthropic client. An actual Claude streaming query with `options.provider: firstParty` under an OpenAI process yielded an API error and zero SDK fetches. Changing only the process provider to `firstParty` succeeded with one local SDK SSE response. This strengthens the original capture, which mocked client construction. The full AgentTool lifecycle, nonstreaming omission, and credential-bearing adapter rejection for missing OpenAI instruction assembly remain source-traced. The confirmed consequence is worker failure; no silent model substitution was observed.

**Repair direction:** Carry the resolved request provider through both concrete client creation paths. Validate beyond AgentTool's mocked query boundary.

### 2. P1: GPT full-PDF reads report success but drop the document

**Trigger:** GPT reads a PDF without an explicit `pages` range, within the full-document read limits.

[isPDFSupported()](../../src/utils/pdfUtils.ts#L59) accepts GPT models. [FileReadTool's PDF result](../../src/tools/FileReadTool/FileReadTool.ts#L1041) contains only file metadata; the actual bytes are emitted in a [supplemental base64 document block](../../src/tools/FileReadTool/FileReadTool.ts#L1765). The [Codex user-message translator](../../src/services/api/codex-fetch-adapter.ts#L1224) handles text, tool results, and images, but has no document branch.

**Observed:** Independent verification performed a real prepared Read of a valid 607-byte PDF. It returned success metadata and a supplemental base64 document; production normalization preserved the document, but adapter translation retained only the request, function call, and `PDF file read... (607 bytes)` result without PDF contents. A real `pages: "1"` control returned one page and delivered one `input_image`. The assembled history used actual Read results; the whole query loop and OpenAI backend were not exercised.

**Repair direction:** Make advertised PDF support agree with the actual adapter delivery contract; ensure accepted reads deliver content or return an explicit failure.

### 3. P1: OpenAI normalization corrupts valid MCP argument names

**Trigger:** An MCP tool legitimately declares `context_lines`, `case_insensitive`, `lines_after`, `lines_before`, or `show_line_numbers`.

[normalizeToolInput()](../../src/utils/api.ts#L652) applies [Grep's reverse property mapping](../../src/utils/openaiSchemaCompat.ts#L70) to every tool under the OpenAI session provider, without checking whether the original schema had dash-prefixed fields.

**Observed:** Independent verification used installed-SDK-valid tools/list metadata declaring all five legitimate names. The production schema preserved them, while model-response normalization and the generated MCP wrapper sent `-C`, `-i`, `-A`, `-B`, and `-n` instead. A `firstParty` control preserved every original key and value. Only external list/call boundaries were stubbed; normalization was real. Servers can reject the call or silently apply defaults, but those remote consequences were not executed.

**Repair direction:** Reverse only property aliases actually introduced for that tool, using the request's provider rather than unrelated process-global state.

### 4. P1: Mixed MCP results discard distinct content

**Trigger:** An MCP result contains both `structuredContent` and `content`, with distinct text, images, or resources in the latter.

[transformMCPResult()](../../src/services/mcp/client.ts#L2849) returns immediately after serializing `structuredContent`, so the `content` array never reaches its transformation path. The installed SDK permits both fields. Keeping structured data in SDK metadata does not restore the model-facing content.

**Observed:** The installed SDK accepted a mixed result with `structuredContent:{status:"ok"}` plus distinct text and an image in `content`. The production generated wrapper emitted only `{"status":"ok"}` as model-facing content; the distinct content was absent. The same wrapper preserved a content-only text response. The image fixture was type-valid and its transformation branch was skipped; it was not rendered. Distinct text loss independently establishes the defect.

**Repair direction:** Preserve distinct/multimodal content while avoiding duplicate JSON when the text is only a compatibility copy of the structured data.

### 5. P2: Updated MCP descriptions stay stale in schemas and search

**Trigger:** MCP tools/list_changed refresh or reload/reconnect changes a tool's description while preserving its name and parameter schema.

[toolToAPISchema()](../../src/utils/api.ts#L181) caches by provider/name/schema, omitting description. [ToolSearch's description cache](../../src/tools/ToolSearchTool/ToolSearchTool.ts#L55) keys by name and invalidates only when the name set changes. [MCP notification refresh](../../src/services/mcp/useManageMCPConnections.ts#L586) clears fetched tools, but neither description cache. [Schema-byte stability](../../src/utils/toolSchemaCache.ts#L3) across reconnects is intentional; it also retains superseded authoritative tool semantics in this case.

**Observed:** Independent verification warmed production schema/search caches, changed only the external description from numeric identifiers to exact slugs, and re-fetched through production discovery. The live tool had the new description; emitted schema still described numeric identifiers, and `slug` search returned zero matches. Clearing both real caches restored the new description and one search match. The mounted notification handler was source-traced; its discovery invalidation/refetch boundary was executed locally.

**Repair direction:** Keep intentional feature-flag byte stability while invalidating caches for authoritative external tool-definition changes.

### 6. P2: GPT compaction loses the disabled-thinking signal

**Trigger:** A GPT session using expensive parent reasoning effort, such as Sol `max`, enters the streaming compaction fallback after the default-enabled cache-sharing fork fails or returns no usable summary, or when `tengu_compact_cache_prefix` is disabled.

[streamCompactSummary()](../../src/services/compact/compact.ts#L1465) requests disabled thinking but [passes the parent's effort](../../src/services/compact/compact.ts#L1485). The [shared request builder](../../src/services/api/claude.ts#L1874) represents disabled thinking as an absent wire field. The adapter's [intended minimal-effort override](../../src/services/api/codex-fetch-adapter.ts#L1464) consequently never activates.

**Observed:** Independent execution of actual `streamCompactSummary()` forced only the cache-sharing gate off and used a local SDK transport response. Its captured request omitted `thinking` and retained effort `max`; production adapter translation produced `reasoning:{effort:"max",summary:"auto"}`. Adding an explicit disabled-thinking wire field to the identical request produced Sol's minimum supported effort `low` without a summary. This defeats the explicitly documented pure-output mode. The normal cache-sharing compaction fork intentionally preserves the parent's thinking settings; this finding concerns the path that explicitly requests disabled thinking.

**Impact:** Avoidable reasoning work, summaries, latency, and token consumption. No backend timing or cost magnitude was measured.

**Repair direction:** Preserve the semantic disabled-thinking signal into adapter translation, or explicitly set the intended provider-specific effort for these callers.

### 7. P2: Restricted Claude sessions are instructed to use absent tools

**Trigger:** A Claude session uses the normal default prompt with a restricted pool, such as `--tools Bash`, or deny rules excluding file tools. Simple-mode and alternate REPL-mode prompt branches are outside this demonstrated file-guidance mismatch.

The narrowed pool reaches the prompt builder, but [Claude's tool guidance](../../src/constants/prompts.ts#L334) always names Read, Edit, Write, Glob, and Grep. [Task guidance](../../src/constants/prompts.ts#L256) also names AskUserQuestion unconditionally. A shared transcript section can name absent Glob/Grep in restricted GPT sessions as well.

**Observed:** Independent verification used real CLI permission initialization and production `getTools()` to create a Bash-only pool. Production `getSystemPrompt()` emitted directions to all five absent file tools and AskUserQuestion, including instructions to use dedicated file tools instead of available shell alternatives. A GPT control with the same pool omitted those bullets. The model cannot carry out the Claude directions with its actual tool pool, even though other general guidance permits Bash when dedicated tools are absent.

**Impact:** Invalid tool attempts, hesitation, or needless escalation are plausible consequences; their live frequency was not measured. Tool-availability work was previously deferred generally, but this concrete mismatch remains present.

**Repair direction:** Gate tool-specific instructions on the actual exposed tool set and provide viable guidance for restricted pools.

### 8. P2: Claude's URL rule conflicts with WebSearch citations

**Trigger:** Claude does general web research that returns new nonprogramming source URLs not supplied by the user or local files.

[The default Claude URL rule](../../src/constants/prompts.ts#L222) permits only user/local-file URLs after its exact-root-homepage exception. [WebSearch's description](../../src/tools/WebSearchTool/prompt.ts#L16) requires relevant returned URLs as Markdown citations. GPT's corresponding rule explicitly permits web-search-returned URLs.

**Observed:** An isolated production prompt-builder probe emitted both incompatible requirements. Claude cannot satisfy both for a new deeper nonprogramming source URL. The conflict can also inhibit following returned links.

**Repair direction:** Explicitly recognize tool-returned/read URLs while retaining the prohibition on invented links.

### 9. P2: SDK side-question fallback duplicates Claude instruction context

**Trigger:** A Claude-style SDK session handles a `side_question` before its first completed main turn, including immediately after resume, so there is no saved cache-safe snapshot.

[The fallback builder](../../src/utils/queryContext.ts#L203) assembles provider context and [returns the already-prepended messages](../../src/utils/queryContext.ts#L222) as `forkContextMessages`. [runForkedAgent()](../../src/utils/forkedAgent.ts#L555) passes those messages and the original `userContext` to query. [The query loop](../../src/query.ts#L874) assembles again, prepending the same context a second time. The ordinary saved post-turn snapshot carries raw messages and avoids this defect; OpenAI's assembly also does not prepend a user-role context message.

**Observed:** Independent verification used an isolated real CLAUDE fixture under production mode. The actual fallback converted one raw main message into two history messages; actual `runForkedAgent()` and the query loop then emitted four outgoing messages including the side question, with the instruction marker twice. A raw-history control through the same owner emitted three messages with the marker once; an OpenAI assembly control also retained one marker. Only the model response was stubbed, with transcript writes skipped. `prependUserContext()` is disabled under `NODE_ENV=test`, so ordinary test execution can hide the mismatch. The full SDK control-request lifecycle was source-traced rather than executed.

**Impact:** Duplicate instructions consume extra context and break the intended main-request prefix match for cache reuse. Exact backend cache loss was not measured.

**Repair direction:** Keep raw history in cache-safe parameters and perform provider instruction assembly exactly once at the delivery boundary.

### 10. P2: Compaction accounting subtracts context savings twice

**Trigger:** Time-based microcompaction is enabled for terminal main-loop requests. Its runtime configuration defaults to disabled; it requires an explicit `repl_main_thread*` query source, so this particular clearing path does not run for desktop SDK turns.

[Sticky reapplication](../../src/services/compact/microCompact.ts#L307) rebuilds cleared tool results from the durable history and reports the full removed-token amount again. [query.ts](../../src/query.ts#L600) forwards it, and [shouldAutoCompact()](../../src/services/compact/autoCompact.ts#L505) subtracts it from `tokenCountWithEstimation()`. A newer server usage anchor already reflects the prior cleared request, so the repeated savings are counted twice. The pure rough-estimate fallback already measures the shrunk message array and also needs no second subtraction. Blocking-limit accounting has the same unconditional subtraction.

**Observed in a controlled fixture:** With a 67,000-token threshold, a post-clear usage anchor of 67,600 and 40,000 repeated savings changed the compaction decision from true to false. With no usage anchor, the already-shrunk rough estimate was 95,037; subtracting the same 40,000 again also changed true to false. The probe directly imported production microcompaction, token estimation, and compaction decision helpers, mocking only the time-config getter and using the actual `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000` setting. This was not a whole-query transport run.

Independent controls produced zero repeated savings for an already-projected array, demonstrated that a genuinely stale pre-clear anchor legitimately needs compensation, and left SDK/undefined-source arrays unchanged. The defect is unconditional compensation.

**Impact:** Context is understated, delaying compaction or blocking protection and risking oversized requests or avoidable reactive recovery. Backend overflow frequency was not measured.

**Repair direction:** Make shrink compensation depend on what the chosen usage anchor actually includes, and never subtract it again from a fresh estimate of the projected array.

### 11. P2: Plugin skills lose their declared execution controls

**Trigger:** A plugin `SKILL.md` declares `context: fork`, a worker `agent`, or skill `hooks`.

[createPluginCommand()](../../src/utils/plugins/loadPluginCommands.ts#L300) omits `context`, `agent`, `hooks`, `paths`, and `skillRoot`. Both plugin skill loading branches use it. The [shared command contract](../../src/types/command.ts#L39) supports these fields, and [filesystem skill loading](../../src/skills/loadSkillsDir.ts#L268) preserves them. [SkillTool](../../src/tools/SkillTool/SkillTool.ts#L622) and [slash-command invocation](../../src/utils/processUserInput/processSlashCommand.tsx#L772) branch on the missing `context` field.

**Observed:** Independent verification used real plugin manifests, inline-plugin loading, and `getPluginSkills()` for both child and direct skill directories, without module mocks. Both skills lost all five fields. A filesystem-skill control preserved the declared Explore fork, valid PreToolUse hook, paths, and skill root. Actual slash-command and SkillTool invocation injected the plugin skill inline and registered zero hooks.

**Impact:** Intended forked work runs inline in the parent conversation and declared skill hooks never register. This changes execution behavior and can omit intended guards or verification.

**Repair direction:** Preserve and validate the shared skill execution fields in plugin discovery, then exercise both invocation paths.

### 12. P2: Worker-invoked skill hooks use the parent's identity or disappear

**Trigger:** A foreground or background worker invokes an inline skill with hooks. A skill whose own `context: fork` takes an earlier return path is outside this registration claim.

[Skill-hook registration](../../src/utils/processUserInput/processSlashCommand.tsx#L921) always uses global `getSessionId()` and `context.setAppState`. [Hook execution](../../src/utils/hooks.ts#L2003) uses the worker's `agentId`. [Background worker isolation](../../src/utils/forkedAgent.ts#L419) makes `setAppState` a no-op, while retaining a separate root-store setter.

**Observed:** Independent verification used real `createSubagentContext()`, slash-command processing, hook storage, and hook matching without module mocks. Foreground invocation produced one parent hook and zero worker hooks; background invocation registered none. Actual matching selected the misplaced parent hook and no worker hook. Registering the same valid hook under the worker identity through the root store produced one worker hook in both controls.

**Impact:** Foreground skill hooks can constrain later parent actions while leaving the intended worker unconstrained; background workers lose the hooks entirely. A direct [worker-key cleanup](../../src/utils/hooks/sessionHooks.ts#L437) left the parent hook intact. Existing [worker final cleanup](../../src/tools/AgentTool/runAgent.ts#L1371) is conditional on agent frontmatter hooks, so this does not assert that cleanup always runs. Hook commands were not executed.

**Repair direction:** Register under the invoking session/agent identity using the available root store, and align registration, lookup, and cleanup ownership.

### 13. P2: Enabled GPT session-memory extraction cannot mutate its notes

**Trigger:** A non-bare, nonremote OpenAI terminal session has auto-compaction enabled, has the `tengu_session_memory` gate enabled, and meets extraction thresholds. The gate defaults to false and the updater only runs for `repl_main_thread`; this finding does not assert a desktop trigger. `/summary` is a disabled stub and is not a trigger.

[Default session-memory instructions](../../src/services/SessionMemory/prompts.ts#L20) demand Edit and prohibit other tools. A private prompt override can replace these instructions; the tool-permission mismatch remains. [The permission predicate](../../src/services/SessionMemory/sessionMemory.ts#L472) permits only Edit with the exact notes `file_path`. [The OpenAI tool pool](../../src/tools.ts#L206) replaces Edit with apply_patch. [Terminal setup](../../src/setup.ts#L309) calls initialization; [initialization guards](../../src/services/SessionMemory/sessionMemory.ts#L361) register the hook only in nonremote sessions with auto-compaction enabled. The gate check occurs lazily.

**Observed:** The production OpenAI tool inventory had no Edit and did have apply_patch and Write. The default production prompt demanded Edit. The production predicate denied both a patch and Write targeting the exact notes file. A Claude inventory control exposed Edit; the same predicate allowed exact-file Edit and denied wrong-file Edit. Thus the GPT model has no exposed, permitted mutation tool for the task. The automatic extraction lifecycle was source-traced, not executed.

**Impact:** Failed memory updates and possible denied attempts within the five-turn cap. The caller also ignores the fork result before advancing the summary cursor, but downstream stale-summary loss was not separately reproduced and is not counted as another finding.

**Repair direction:** Align the updater's mutation contract with the provider tool pool while preserving exact-file restrictions, and verify a durable notes update before advancing completion state.

## Validation and limits

### Independent verification

All three verifiers read the current production owners and challenged the original probes. Seven fresh diagnostic commands completed with exit 0, with controls that distinguish the reported failures from invalid fixtures, provider-independent denials, and intentional stale-anchor compensation. No finding was rejected or left unresolved.

| Parallel verification lane | Coverage and verdict | Independent evidence |
|---|---|---|
| Provider and MCP | Findings 1–5 confirmed; priorities retained | Unmocked native client/stream failure and success control; real PDF Read and page control; SDK-valid MCP argument/result contracts; description cache-clear controls. |
| Prompts and compaction | Findings 6–10 confirmed; triggers 6 and 7 clarified | Actual compaction owner capture; real CLI-restricted tool pool; conflicting production URL rules; actual fallback/fork/query capture; sticky/rough/stale-anchor and excluded-source controls. |
| Skills, hooks, and memory | Findings 11–13 confirmed; triggers 12 and 13 clarified | Real plugin loading and both invocation entrypoints; real worker context, hook storage/matching/cleanup and positive registration controls; actual provider tool inventories and exact-file permission controls. |

Temporary command paths below identify the verification runs. The report preserves their observations and controls above; these scripts were not shipped as repository tests.

```sh
bun --tsconfig-override /Users/pt/cat-code/tsconfig.json /private/tmp/cat-code-verify-provider-mcp-20261011/native-provider-pdf.ts
bun --tsconfig-override /Users/pt/cat-code/tsconfig.json /private/tmp/cat-code-verify-provider-mcp-20261011/mcp-contracts.ts
bun /private/tmp/cat-code-verify-prompt-compaction-20261011/compact-owner.ts
bun /private/tmp/cat-code-verify-prompt-compaction-20261011/prompt-owner.ts
bun /private/tmp/cat-code-verify-prompt-compaction-20261011/side-question-owner.ts
bun /private/tmp/cat-code-verify-prompt-compaction-20261011/budget-controls.ts
bun /private/tmp/cat-code-verify-skills-memory-20261011a/verify.ts
```

The provider/MCP and skills verification imported production owners without module mocks. Prompt/context verification supplied local SDK/model responses, forced the compaction cache-sharing gate off for its fallback capture, and mocked only the time-config getter for budget fixtures. All lanes used isolated configuration/fixtures and blocked live network requests. Bun's tsconfig directory-mismatch warning in the provider/MCP commands was nonfatal. The checked owner files had no source drift between the initial snapshot and verification; unrelated shared-tree changes were preserved.

### Original audit probes

The audit used the following isolated probes. Their temporary paths record the original execution evidence; the finding descriptions above preserve the observations without requiring those files:

- Tool-contract probe (`/private/tmp/cat-code-tool-audit-probe.ts`): production schema rendering, model-response normalization, generated MCP wrapper execution/result mapping, and ToolSearch. Independently rerun, exit 0, all three observed failures reproduced.
- Provider probe (`/private/tmp/cat-code-provider-audit-20261011/provider-probe.test.ts`): local SDK stream capture, native client-selection control, and production adapter translation. Independently rerun in a fresh isolated config/fixture namespace; two observation probes completed, exit 0. These are diagnostic captures, not shipped regression tests.
- Prompt probe (`/private/tmp/cat-code-prompt-audit.ts`): production Claude prompt builders and instruction discovery under synthetic configuration. Independently rerun, exit 0. Bun printed a nonfatal tsconfig directory-mismatch warning.
- Compaction-budget probe (`/private/tmp/cat-code-context-audit/budget-probe.ts`): direct production imports with only the time-config getter mocked. Independently rerun, exit 0; both erroneous threshold decisions reproduced.
- Side-question probe (`/private/tmp/cat-code-context-audit/side-question-direct-probe.ts`): parent-authored direct fallback/assembly probe with isolated real CLAUDE configuration under production mode. Exit 0; the instruction marker appeared twice. The original source-body probe (`/private/tmp/cat-code-context-audit/source-probes.ts`) was also rerun, then superseded by these stronger direct-import probes.
- Memory-capability probe (`/private/tmp/cat-code-context-audit/memory-capability-probe.ts`): production tool inventory, prompt builder, and exact-file permission predicate. Independently rerun, exit 0; required Edit absent and available patch tool denied.
- Plugin-skill probe (`/private/tmp/catcode-model-audit-fifth/plugin-skills.test.ts`) and worker-hook probe (`/private/tmp/catcode-model-audit-fifth/worker-skill-hooks.test.ts`): independently rerun in separate processes, with network blocked and isolated fixture configuration. Three expected-contract assertions failed, directly reproducing the two skill findings. These failing audit probes were retained in temporary storage, not added to the repository.

Provider/tool probes blocked network fetch. Configuration and provider credential namespaces were isolated; no live models or accounts were exercised. This establishes emitted payload and local execution behavior. It does not measure model-response frequency, backend latency/cost, or GUI behavior.

Scope: base/provider-specific prompts, instruction precedence/discovery, output styles and desktop append; built-in/MCP tool exposure/schema/input/result/search/cache; provider/model/catalog/effort/output/multimodal/stream/retry shaping; history/context/compaction/memory; worker/skill/plugin/command/hook behavior.

Not promoted to findings: prompt size or craft-coaching preferences; intentional session-stable language/feature caching; deliberate root-to-CWD CLAUDE-vs-AGENTS fallback; excluded CLAUDE claiming an AGENTS fallback (requires a semantics decision); intentional unknown-model mapping; unsupported assumptions about Codex output limits; worker resume effort persistence without a clear independent requirement; suspected unbounded summary/suggestion tool loops, which are turn-limited; unmeasured live frequency.
