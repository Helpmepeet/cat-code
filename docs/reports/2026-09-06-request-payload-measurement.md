# Request payload measurement: live metadata and synthetic capture

Date: 2026-09-06

## Outcome

Exact outgoing request capture is feasible without changing shipped code. A
scratch-only experiment by GPT-5.6 Terra exercised two synthetic turns through
`QueryEngine` and the production Codex WebSocket serializer. The instruction
string remained identical; only the new input and prior-response reference
changed.

This is a completed **capture-feasibility experiment**, not a completed audit of
what Cat Code sends versus what durable state and declared configuration predict.
No unexplained drift was demonstrated in the synthetic pair. Normal sessions,
other assembly paths, and the cost of any unexplained divergence remain unsettled.

Separately, measurements from the real investigation session showed a warm
continuation followed by a cold full send. The exact real request bodies were
not captured, and the cause of that cold request was not established.

## Scope, authority, and repository state

The original question covered the derivation from transcript, settings,
instruction files, account state, and declared session configuration to the
provider-bound body, across terminal, print/headless, SDK, desktop sidecar,
subagents, and teammates. A qualifying finding had to both change that derivation
and leave no durable record of the change. The user required measurement before
an audit and authorized stopping if faithful measurement was not cheaply available.

The investigation was read-only except for an explicitly permitted throwaway
scratch experiment. No shipped files were changed, no commits or branch/worktree
operations were performed, and no new desktop session was started for the
experiment. The user subsequently authorized this report under `docs/`; the
original no-commit constraint remains in force.

The branch was `migration`, with HEAD
`99efd7ef95d5611e4818d4dc5317d8f6f5e448e8`, at the investigation's opening,
measurement close, scratch-cleanup check, and report preparation. The working
tree contained substantial preexisting changes, including the Codex adapter.
Source references describe the working tree inspected, not a clean checkout of
that commit. The exact source identity loaded by the live process was not
independently fingerprinted.

## Evidence retained locally

The real session was `2a98afa1-c614-4fc1-8679-d5ee00786a63`. Evidence is local and
may disappear under retention or cleanup; these are not portable repository
fixtures. Only bounded measurement excerpts were inspected, not wholesale dumps
of private diagnostic logs.

- Real session: `~/.cat-code/projects/-Users-pt-cat-code/2a98afa1-c614-4fc1-8679-d5ee00786a63.jsonl`.
  Relevant lines: 7 and 13 for main-model request starts; 10, 20, and 27 for
  completion measurements. Line 14 is a separate title-generation completion,
  excluded from the main-model comparison.
- Debug measurements: `~/.cat-code/debug/2a98afa1-c614-4fc1-8679-d5ee00786a63.txt`.
  Relevant lines: 151, 154, 191, 193, 237, and 239.
- Terra worker: `~/.cat-code/projects/-Users-pt-cat-code/2a98afa1-c614-4fc1-8679-d5ee00786a63/subagents/agent-a96a08f817da5283d.jsonl`.
  Line 165 records initial harness creation; lines 180, 186, 192, 231, 237, 243,
  and 256 record subsequent patches. Line 260 contains the successful measurement
  output; line 284 is the worker's report. Its adjacent `.meta.json` identifies
  the implementor assignment.

Kyanite checked Terra's harness and patch records, successful command output,
production continuation code, and removal of the scratch directory. The
experiment was not independently rerun after cleanup.

## Real requests: closest available observation

These are consecutive **main-model request/response rounds within one human
turn**, not two separate human submissions. The overlapping title-generation
request was distinguished by its model and conversation key and excluded.

| Measurement | First request | Second request |
|---|---:|---:|
| Dispatch time, UTC | 03:18:52.512 | 03:19:00.077 |
| Model | `gpt-6-astra` | `gpt-6-astra` |
| Effort | `high` | `high` |
| Transport/send mode | WebSocket, full | WebSocket, incremental |
| Instruction hash | `31a96da3` | `31a96da3` |
| Instruction string length, UTF-16 code units | 74,687 | 74,687 |
| Reconstructed full input items | 3 | 6 |
| Transmitted input items, per transport log | 3 | 1 |
| Provider-reported input tokens | 32,507 | 35,294 |
| Provider-reported cached tokens | 0 | 32,384 |
| Input tokens not reported cached | 32,507 | 2,910 |
| Time to first event | 886 ms | 821 ms |

The account and conversation-key prefixes remained the same. Approximately
91.8% of the second request's input tokens were reported cached. This supports
successful continuation and substantial reuse for that pair, not byte-for-byte
request equality or agreement with declared configuration.

### Two measurement-label problems outside the original candidate list

`sent_items` in the durable completion record is populated from
`fullInputLength`, even after the transport replaces `requestBody.input` with a
delta. The second request therefore records six while its transport log says
one item was sent. See [delta substitution](../../src/services/api/codex-websocket-transport.ts:1063)
and [completion counter](../../src/services/api/codex-websocket-transport.ts:1465).

The diagnostic suffix `B` is attached to `instructions.length`, which measures
JavaScript UTF-16 code units, not UTF-8 or JSON-serialized bytes. The accompanying
hash is the first eight hexadecimal characters of SHA-1 over the instruction
string, not a full-request fingerprint. See
[request diagnostic construction](../../src/services/api/codex-fetch-adapter.ts:3653).

These are instrument limitations. They do not themselves demonstrate an
unrecorded payload divergence meeting the original two-part finding criterion.

### The next request was cold, but causation is unresolved

The next main-model request retained the instruction hash, effort, account
prefix, and conversation-key prefix. The transport logged
`full send input=13 items (non-input request fields changed)`. Its completion
reported **42,037 input tokens and zero cached tokens**. Evidence is real-session
JSONL line 27 and debug line 239.

The transport compares `JSON.stringify` of every body field except `input`;
a changed signature prevents continuation. See
[signature construction](../../src/services/api/codex-websocket-transport.ts:634)
and [continuation branch](../../src/services/api/codex-websocket-transport.ts:1045).
The diagnostic did not identify the changed field. No `prompt_cache_break`
entry was found in this session at inspection time.

A full send does not establish the cause of a provider cache miss. Neither the
avoidable uncached token count nor the monetary or behavioral cost was
established. This cold request is evidence to explain, not a proven silent bug.

## Why existing diagnostics were insufficient for exact live capture

The inspected boundaries serialize the request without retaining that string:

- HTTP sends `JSON.stringify(codexBody)` through `globalThis.fetch` at
  [codex-fetch-adapter.ts:3709](../../src/services/api/codex-fetch-adapter.ts:3709).
  The switch described as a cold-turn full dump logs metadata only at
  [codex-fetch-adapter.ts:3762](../../src/services/api/codex-fetch-adapter.ts:3762).
- WebSocket constructs the `response.create` envelope at
  [codex-websocket-transport.ts:1024](../../src/services/api/codex-websocket-transport.ts:1024)
  and sends its serialized form at
  [codex-websocket-transport.ts:1375](../../src/services/api/codex-websocket-transport.ts:1375).
- Durable request-start records are explicitly metadata-only at
  [sessionStorage.ts:587](../../src/utils/sessionStorage.ts:587).
- The cache-break diff representation includes model, system text, and sorted
  tool descriptions/schemas, not message history or the final envelope. See
  [promptCacheBreakDetection.ts:290](../../src/services/api/promptCacheBreakDetection.ts:290).
- The apparent `fetchOverride` seam is not a final Codex interception point:
  the OpenAI client branch replaces it with `createCodexFetch`. See
  [client.ts:455](../../src/services/api/client.ts:455) and
  [client.ts:484](../../src/services/api/client.ts:484).

No exposed switch for installing full capture in the already-running process
was found. This was not proof that startup instrumentation was impossible;
the subsequent scratch experiment established that it was feasible.

## Synthetic capture experiment

The user authorized a bounded experiment and requested GPT-5.6 Terra for the
implementation. The scratch harness constructed one real `QueryEngine` and
fully consumed two calls to `submitMessage`. It used real query processing,
provider assembly, Codex translation, continuation reconciliation, and final
serialization. It did not replace the model-call dependency with a canned
result before request assembly.

The existing WebSocket factory test seam supplied an in-memory socket. Its
`send` method captured the exact serialized string passed by the production
transport, then emitted synthetic provider events. Earlier attempts needed
configuration initialization, a build-macro stand-in, a semicolon correction,
and corrected synthetic response-event identifiers/indices. Only the final
successful run's measurements are reported below.

Controlled inputs included a custom synthetic system prompt, no tools or
commands, disabled thinking, fake credentials, and synthetic responses.
`DISABLE_PROMPT_CACHING=1` was set. Config/home/vault paths were redirected under
scratch, but the engine working directory remained the real repository.
Session persistence was disabled. This was not a hermetic fixture for the
entire instruction-file/configuration ancestry.

| Measurement | Turn 1 | Turn 2 |
|---|---:|---:|
| Final serialized UTF-8 bytes | 49,372 | 49,415 |
| Instruction UTF-8 bytes | 48,249 | 48,249 |
| Instruction string | Identical | Identical |
| Transmitted input items | 1 | 1 |
| Input content | First synthetic user turn | Second synthetic user turn |
| `previous_response_id` | Absent | `resp_synthetic_1` |

Shared leading serialized UTF-8 bytes: **49,151**.
Only top-level fields `input` and `previous_response_id` changed. The model,
reasoning configuration, instruction string, tool settings, and prompt-cache
key were stable within the run.

SHA-256 values retained from the successful command output:

```text
turn 1 body: f38370a5d3372c8bc3712bd632bb7faeb459a9c6c944d6e2339db993a0f35b75
turn 2 body: 339c266ea2596fb9599d0335ee358a7fb721d82d5b6c9ae7c9dfa2638ba0a98c
instructions: f4e6d1e3a5aec063279f694eef6ae816919b5208aaed0ee5a3d1e1141a0d2b47
```

These hashes identify this run's captures, not reproducible golden fixtures.
The full body strings were held in memory; raw payloads were not retained as
files. The surviving output contains measurements and structural excerpts,
not enough data to reconstruct the complete bodies.

### Interpretation and important limits

The second body refers to the first completed response and transmits only the
new input. This is consistent with production continuation behavior, not
proof that a real server preserved or cached anything. A common JSON byte
prefix is not a provider-cache-prefix measurement.

The run demonstrates byte-identical instructions between these two requests.
It does **not** explain the provenance of the entire 48,249-byte instruction
string or compare that string against an independently derived disk/config
prediction. A small custom prompt alone does not explain that total.

The harness's throwing `globalThis.fetch` replacement observed zero calls during
the measured execution. However, it was installed **after module imports**, so
that counter does not prove network isolation during startup. The in-memory
WebSocket captures themselves did not reach a provider. The stronger claim
that all network access was blocked before engine code loaded is unsupported.

Unexercised paths include default-prompt/tool-rich sessions, real disk transcript
restore, interactive terminal startup, the desktop sidecar's own configuration
and instructions, subagent/teammate assembly, HTTP fallback, actual account
rotation/refresh, and provider-side cache/token accounting. Synthetic usage
counts cannot price the user's real requests.

## Searches and source inspection performed

Routing began at [WORKSPACE_MAP.md](../maps/WORKSPACE_MAP.md), then selected
[query-provider-runtime.md](../maps/query-provider-runtime.md). Maps were used
for navigation, not as evidence of behavior.

The main session searched the API paths for dump/trace/body logging,
serialization, request signatures, fetch overrides, and capture callbacks;
searched `src/` for `CODEX_CACHE_COLD_DIAG` and `codex_send_path`; and checked
sidecar sources for inspector/preload/debug-entry routes. It read targeted
ranges in:

- `src/services/api/client.ts`
- `src/services/api/codex-fetch-adapter.ts`
- `src/services/api/codex-websocket-transport.ts`
- `src/services/api/promptCacheBreakDetection.ts`
- `src/utils/debug.ts`
- `src/utils/sessionStorage.ts`
- `app/main/mainDecisions.ts`

Representative searches actually run included:

```text
CODEX_CACHE_COLD_DIAG|cold.*[Dd]iag|cold.*[Dd]ump|dumpCold
recordCodexSendPath|codex_send_path|CodexSendPath
createRequestSignature|recordPromptState\(|fetchOverride
"subtype":"codex_(request_start|send_path|stream_surface)"
"subtype":"prompt_cache_break"
```

The existing `session-analysis` inspector identified the real session and
extracted individual worker records. Targeted diagnostic searches selected
`[codex-cache] request`, WebSocket send/continuation decisions, and
`[PROMPT CACHE BREAK]` entries. No custom transcript parser was written.

This was a capture investigation, not an exhaustive search across the original
five divergence dimensions. The original named candidates were neither all
accepted nor all rejected; the broad audit did not take place.

## Execution, cleanup, and remaining work

Terra's final command was
`bun /Users/pt/cat-code/scratchpad/payload-assembly-20260906-5f2c/run.ts`.
Its output reported success, two serialized WebSocket bodies, and zero
intercepted global fetch calls. The command is historical and no longer runnable
at that path: all experiment artifacts under that directory were removed.
Kyanite independently confirmed the directory's absence and unchanged branch/tip.

The implemented capture path is recoverable from the worker's local tool records,
not a retained or supported repository instrument. No code changes are pending
from this investigation. The report is the only requested persistent artifact.

The original end-to-end investigation remains unfinished. In particular, this
work does not settle whether normal requests match durable state/configuration,
what caused the observed real cold request, or what any divergence cost the user.
Closing this session is not a clean bill of health for those questions.
