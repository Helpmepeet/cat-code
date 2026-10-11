# Model-facing audit fixes and validation

Date: 2026-10-11. Implements all 13 confirmed findings in the [independently verified audit](2026-10-11-model-facing-audit.md). Implementation began at `69e8d179e6046f34fb144936851f001919ff6864`. The final isolated integration snapshot uses `b931b030873df0677abaacc0ca6566612decae66` plus only the owned fixes and regression files.

Three subagents handled provider/PDF/effort, MCP contracts, and plugin skills/hooks/memory in parallel. The parent handled tool-aware prompts, side-question context, and shrink accounting, inspected the integrated changes, and ran broader verification. Existing renderer/sidecar edits and another session's background-worker commit were preserved. Nothing was installed, launched in the GUI, or pushed.

## Resolutions

| Finding | Resulting behavior | Primary regression evidence |
|---|---|---|
| 1. Worker provider loss | Both streaming and nonstreaming recovery pass the resolved request provider to client creation. A Claude worker remains on Anthropic under a GPT process. | [Provider delivery](../../src/services/api/claude-provider-delivery.test.ts): real SDK client selection and local streaming/fallback responses under an OpenAI parent. |
| 2. PDF content loss | GPT Read returns bounded rendered pages according to the invoking worker's provider. Restored native PDF attachments and PDF tool results are projected into images from their saved bytes at the asynchronous transport boundary. Saved history remains intact. | [PDF delivery](../../src/tools/FileReadTool/pdfReadDelivery.test.ts): real prepared Read, Poppler rendering, normalization and wire delivery; restored HTTP requests after the original file disappears; repeated input stability; native Claude control; explicit invalid/unsupported/missing-renderer/limit failures. |
| 3. Corrupted MCP argument names | Reverse mapping applies only aliases introduced by the actual tool schema and request provider. Natural names survive; generated aliases avoid collisions. | [MCP contracts](../../src/services/mcp/modelContracts.test.ts): SDK-valid discovery through decoding and generated call execution, including natural keys, alias collisions and differing parent/request providers. |
| 4. Lost mixed MCP content | Distinct text, images and resources accompany structured data. Semantically equal JSON compatibility text appears once. | MCP contracts: generated wrapper and result mapping with real image/resource transformation, redundant JSON and content-only controls. |
| 5. Stale MCP descriptions | Authoritative rediscovery refreshes emitted descriptions and keyword search while retaining cached schema feature flags. The context-overhead memo also distinguishes replacement tool definitions. | MCP contracts plus [overhead measurement](../../src/services/compact/autoCompact.test.ts): same name/schema, changed description, new search matches and current schema size. The additional caller probe changed from 22,057 stale tokens to the actual 22,732 tokens. |
| 6. Lost disabled-thinking signal | Explicit disabled thinking reaches the Codex adapter and overrides inherited effort with the model minimum. Enabled thinking retains selected effort. | Provider delivery: actual regular compaction path, SDK request and adapter translation; adaptive-thinking control retains maximum effort. |
| 7. Instructions name unavailable tools | Claude file/clarification guidance and shared transcript guidance use the exposed tool pool. Transcript section caching includes tool availability. | [Assembled prompts](../../src/constants/prompts.test.ts): real CLI Bash-only restriction for both providers, positive dedicated-tool guidance and embedded-search controls. |
| 8. Citation URL contradiction | Claude may use exact URLs returned by searches or read with a tool while retaining the restriction on inventing deeper paths. | Assembled prompts: search-enabled prompt agrees with the WebSearch citation requirement and retains the path boundary. |
| 9. Duplicate fallback instructions | Side-question cache-safe snapshots retain raw history. The fork query assembles Claude context once. | [Side-question query](../../src/utils/queryContext.test.ts): real fallback/fork/query path in a production-mode child with isolated instruction discovery; fallback, saved-history and OpenAI controls contain one instruction marker. |
| 10. Repeated shrink subtraction | Time-based clearing retains the response identity that still prices each removed result. New usage records and rough projected estimates receive no second subtraction; interleaved estimated tails receive none. Autocompact and blocking checks share the same estimator. | [Microcompact](../../src/services/compact/microCompact.test.ts), overhead/threshold tests and [token accounting](../../src/utils/tokens.test.ts): stale/new anchors, later idle triggers, tail clearing, rough fallback, compact boundaries, split responses, zero seeds and provider switches. |
| 11. Dropped plugin execution fields | Plugin loading preserves context, agent, hooks, paths and skill root using the shared frontmatter parser. Fork declarations reach both invocation routes. | [Plugin invocation](../../src/utils/plugins/loadPluginCommands.test.ts): real default/direct plugin discovery, slash and Skill invocation, worker selection and hook-root matching. |
| 12. Worker hook ownership | Skill hooks register under the invoking worker identity in the root store, including forked skills. Source trust checks remain enforced. Worker/fork finalization clears only owned hooks. | [Worker lifecycle](../../src/tools/AgentTool/runAgent.skillHooks.test.ts), plugin invocation and [fork cleanup](../../src/utils/forkedAgent.test.ts): foreground/background completion and failure preserve unrelated hooks. |
| 13. GPT memory cannot update notes | Extraction names the available provider edit tool. Exact-file Update patches are allowed; destructive, malformed, moved and mixed-target operations are denied. The restriction remains mandatory despite hook approval. Checkpoints advance only after a successful mutation receipt and changed persisted notes. | [Session memory](../../src/services/SessionMemory/sessionMemory.test.ts): automatic enabled post-sampling path and manual real fork/query/tool/filesystem paths; GPT patch and Claude Edit controls; no-op, wrong-target and hook-approval denial; durable notes before cursor advancement. |

## Regression and integration checks

The new regressions were demonstrated failing before their owner repairs. Provider tests failed on omitted routing and inherited reasoning; PDF tests showed metadata without content; MCP tests showed renamed natural keys, lost mixed content and stale descriptions. Prompt/context tests showed unavailable tool names, contradictory URLs and duplicate context. Accounting tests reproduced skipped compaction after double subtraction. Skill/memory tests showed dropped execution fields, absent or retained worker hooks, denied GPT mutation and false success without durable notes. The restored-PDF tests also rejected the intermediate guard that would have blocked continued use of saved history. The overhead follow-up failed before its memo repair.

Focused checks passed **394 tests** across these groups, using separate processes where module mocks would otherwise contaminate real owners:

| Group | Passed |
|---|---:|
| Provider delivery, PDF/replay, adapter, Read, streaming recovery and Claude 5.5 | 213 |
| Prompt assembly, provider prompt regressions and side-question query | 57 |
| Microcompact, autocompact/overhead and token accounting | 79 |
| MCP contracts and existing MCP/API/search siblings | 26 |
| Plugin invocation, worker hooks, fork cleanup and memory extraction | 19 |

The final `bun run build:dev:full` passed map lint, the undefined-name gate, branch lint, bundling and the dev CLI version check. Explicit ESLint covered all changed runtime/test paths, including working-tree changes that branch lint may omit. Whitespace and report links were checked.

Desktop package typecheck and scoped sidecar typecheck passed in the clean integration snapshot. Root engine typecheck retains existing repository errors; normalized comparison with the kickoff snapshot found **zero new diagnostics in owned paths**. The baseline headless desktop suite passed **5,772 tests**, with three preexisting skips. The final integration desktop suite passed **5,776 tests**, with the same three skips and zero failures, across 388 files. The final snapshot includes the other session's committed background-worker checks; their four additional tests account for the count difference.

Verification snapshots and raw logs are temporary supporting evidence; the results and permanent regression files above do not depend on keeping them. The kickoff archive and final integration archive exclude unrelated uncommitted work and symlink existing dependencies. Headless desktop socket tests required permission outside the filesystem sandbox; no Electron GUI was opened.

## Limits

No live provider responses, latency/cost benchmarks or GUI acceptance were measured. Local SDK/HTTP responses and synthetic credential state establish emitted requests and execution/persistence behavior. Feature defaults and exposure guards for time-based microcompact and automatic session memory remain unchanged.

PDF rendering requires Poppler. Ordinary automatic GPT reads accept up to ten pages; explicit ranges accept up to twenty. Restored native PDFs are rendered locally for each request, with a twenty-page per-document limit, twenty-megabyte total PDF byte limit and the existing request media limit. Unsupported or over-limit content fails explicitly. The saved document bytes are never rewritten.
