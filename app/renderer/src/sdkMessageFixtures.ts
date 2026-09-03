/**
 * Exhaustive `SDKMessage` fixture — the P2-0 acceptance artifact demanded by
 * PROGRAM-PLAN §5 ("require an exhaustive adapter fixture covering every real
 * variant before declaring the projector done").
 *
 * ── Union census (verified against source 2026-07-04) ──────────────────────
 *
 * TYPE union `SDKMessage` (src/entrypoints/sdk/coreTypes.generated.ts:760):
 * exactly 19 members over 15 top-level `type` discriminants — `system` covers
 * 3 members (SDKSystemMessage, SDKCompactBoundaryMessage,
 * SDKAccountDiagnosticMessage), `result` covers 2 (SDKResultMessage,
 * SDKResultSuccess), `user` covers 2 (SDKUserMessage, SDKUserMessageReplay).
 * The renderer's snapshot alias (shared/sdk-types.snapshot.d.ts, commit
 * 234da9e) was re-diffed against the live file 2026-07-04: byte-identical
 * union — no drift.
 *
 * RUNTIME schema `SDKMessageSchema` (src/entrypoints/sdk/coreSchemas.ts:1910):
 * exactly 25 entries. Reconciliation with the 19-member type union:
 *  - 13 entries map 1:1 onto type members (assistant, user, user-replay,
 *    result [internally success|error, covering both result-type members],
 *    stream_event, system-init, compact_boundary, account_diagnostic,
 *    tool_progress, auth_status, tool_use_summary, rate_limit_event,
 *    prompt_suggestion).
 *  - 12 entries EXPAND `system` subtypes the type union folds into
 *    SDKSystemMessage's optional-field bag: status, api_retry,
 *    local_command_output, hook_started, hook_progress, hook_response,
 *    files_persisted, task_notification, task_started, task_progress,
 *    session_state_changed, elicitation_complete.
 *  - 4 type members have NO runtime-union entry: SDKAssistantMessageError
 *    (top-level; the schema exists only as the embedded `error` field),
 *    SDKPermissionDenial (the same-named runtime schema is the
 *    `result.permission_denials` ENTRY object, not a message),
 *    SDKStreamlinedTextMessage + SDKStreamlinedToolUseSummaryMessage
 *    (schemas exist at coreSchemas.ts:1398/1413 but are not in the union —
 *    stdout-only transform).
 *  - Known drift inside the overlap: the runtime `SDKStatusMessageSchema`
 *    is `type:'system', subtype:'status'` while the TYPE `SDKStatusMessage`
 *    is `type:'status'` — same name, different discriminant; no
 *    `type:'status'` mint site exists in src/. Runtime
 *    `SDKCompactBoundaryMessageSchema` accepts only 'compact_boundary';
 *    the type NOMINALLY also allows 'microcompact_boundary' but the
 *    intersection with the base subtype union makes it uninhabitable — see
 *    the in-place proof in the `system` section below. `post_turn_summary`
 *    has a schema (coreSchemas.ts:1600) that is in NEITHER union.
 *
 * ── Sample realism ──────────────────────────────────────────────────────────
 *
 * Every sample mirrors a real mint site (anchor on the sample; line numbers
 * as of 2026-07-04 — re-grep the symbol if they drift). `reach` records how
 * the variant arrives today:
 *  - 'app-seam'        — flows through the in-proc QueryEngine →
 *                        AppSessionController seam the sidecar forwards.
 *  - 'sdk-stdout-only' — never crosses the app seam today: minted only by
 *                        the SDK stdout server (src/cli/print.ts) / its
 *                        streamlined transform, OR minted into the
 *                        headless-gated sdkEventQueue whose only drain is
 *                        print.ts (no drain wiring exists in
 *                        src/app-runtime/ or app/sidecar/) — P2-0 review
 *                        finding F1; wiring that drain is a §5
 *                        extend-engine decision P2-1 will hit if it wants
 *                        task/session-state rows.
 *  - 'type-only'       — no mint site found in src/ at all.
 * Coverage is intentionally total anyway: the wire tolerates drift, so the
 * projector must too.
 *
 * S1 traps baked into the samples (specs/2026-07-03-S1-streaming.md):
 * assistant frames carry `stop_reason: null` + message_start-era usage (the
 * engine's post-serialize write-back never reaches the renderer — read
 * stop_reason/usage from message_delta/result ONLY); one assistant frame per
 * content block (same message id); stream events are droppable garnish;
 * subagent stream deltas never arrive but subagent FULL frames do, carrying
 * non-null `parent_tool_use_id` (queryHelpers.ts:127-140).
 */

import type { SDKMessage } from '@cat-code/engine/session-events'

export type SdkMessageSampleReach = 'app-seam' | 'sdk-stdout-only' | 'type-only'

export type SdkMessageSample<M extends SDKMessage = SDKMessage> = {
  /** What this sample models. */
  name: string
  /** Mint-site anchor in src/ (or why none exists). */
  anchor: string
  /** How this variant arrives today (see header legend). */
  reach: SdkMessageSampleReach
  /**
   * Rows `projectMessage` must add when this sample is projected alone into a
   * fresh session. Anything other than this exact count is a defect: more =
   * phantom rows, fewer = the silent drop P2-0 forbids.
   */
  expectRows: number
  message: M
}

const SESSION = 'engine-session-1'

/**
 * One entry per top-level discriminant, ≥1 realistic sample per union member
 * (and per assistant content-block discriminant). The mapped type is the
 * fixture-side exhaustiveness tripwire: if the SDKMessage union grows a
 * discriminant this record fails to compile until a sample is added, and each
 * sample's `message` must satisfy that discriminant's union members.
 */
export const SDK_MESSAGE_FIXTURE: {
  readonly [K in SDKMessage['type']]: readonly SdkMessageSample<
    Extract<SDKMessage, { type: K }>
  >[]
} = {
  /* ── assistant — SDKAssistantMessage ──────────────────────────────────────
   * Per-block frames minted at content_block_stop (claude.ts:2371, yield
   * :2391), SDK-wrapped by queryHelpers.ts:104-119. Block discriminants
   * enumerated against the engine's own consumers: Message.tsx:497-634
   * (text/tool_use/thinking/redacted_thinking/server_tool_use + logged
   * default) and utils/messages.ts:3077-3148 (streaming block-start list). */
  assistant: [
    {
      name: 'assistant: text block (streamed per-block frame)',
      anchor: 'src/services/api/claude.ts:2371 → src/utils/queryHelpers.ts:110',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'assistant',
        message: {
          id: 'msg_01Fix001',
          model: 'claude-sonnet-5',
          role: 'assistant',
          content: [{ type: 'text', text: "I'll read the config first." }],
          // S1 §4 trap: assistant frames ALWAYS serialize stop_reason:null +
          // message_start-era usage; the engine's later write-back mutates
          // only its own copy. Renderers read message_delta/result instead.
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1200, output_tokens: 2, service_tier: null },
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000a001',
      },
    },
    {
      name: 'assistant: tool_use block',
      anchor: 'src/services/api/claude.ts:2371 → src/utils/queryHelpers.ts:110',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'assistant',
        message: {
          id: 'msg_01Fix001',
          model: 'claude-sonnet-5',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_01Fix001',
              name: 'Read',
              input: { file_path: '/repo/config.json' },
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1200, output_tokens: 2, service_tier: null },
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000a002',
      },
    },
    {
      name: 'assistant: thinking block',
      anchor:
        'src/components/Message.tsx:553 renders it; Codex adds reasoning_kind (claude.ts:2192)',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'assistant',
        message: {
          id: 'msg_01Fix002',
          model: 'claude-sonnet-5',
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'The user wants the config read before editing.',
              signature: 'EuYBCkQYAiJAoDgVvHRjqMEzZOB3PDco',
              reasoningKind: 'summary',
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1200, output_tokens: 9, service_tier: null },
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000a003',
      },
    },
    {
      name: 'assistant: redacted_thinking block',
      anchor: 'src/components/Message.tsx:538 (AssistantRedactedThinkingMessage)',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'assistant',
        message: {
          id: 'msg_01Fix003',
          model: 'claude-sonnet-5',
          role: 'assistant',
          content: [
            { type: 'redacted_thinking', data: 'EqQBCkYIBBgCKkBWvJduLuIA' },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 900, output_tokens: 4, service_tier: null },
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000a004',
      },
    },
    {
      name: 'assistant: server_tool_use block (P2-2 tool-card, pending — no matching result block yet)',
      anchor:
        'src/utils/messages.ts:3136 block-start family; src/utils/messages.ts:2766 normalize',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'assistant',
        message: {
          id: 'msg_01Fix004',
          model: 'claude-sonnet-5',
          role: 'assistant',
          content: [
            {
              type: 'server_tool_use',
              id: 'srvtoolu_01Fix001',
              name: 'web_search',
              input: { query: 'bun unix socket sun_path limit' },
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1300, output_tokens: 6, service_tier: null },
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000a005',
      },
    },
    {
      name: 'assistant: web_search_tool_result block (P2-2 server-tool result — resolves srvtoolu_01Fix001 inline, no user reply; content is web_search_result sources, no text part — flattenToolResultContent yields an empty tool-card content string, see F6 Phase-4 flag)',
      anchor:
        'src/utils/messages.ts:3137 block-start family; src/utils/messages.ts:1306-1328 (orphan-if-unresolved proves results ride inline); real content shape src/services/api/codex-fetch-adapter.ts:2061-2074 ({title,url} sources, no text block)',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'assistant',
        message: {
          id: 'msg_01Fix004',
          model: 'claude-sonnet-5',
          role: 'assistant',
          content: [
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srvtoolu_01Fix001',
              content: [
                {
                  type: 'web_search_result',
                  title: 'sun_path limit on macOS',
                  url: 'https://example.com/sun-path-limit',
                  encrypted_content: 'EuYBCkQYAiJAoDgVvHRjqMEzZOB3PDco',
                  page_age: null,
                },
              ],
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1300, output_tokens: 40, service_tier: null },
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000a00c',
      },
    },
    {
      name: 'assistant: FileEditTool diff result riding a user reply (P2-2 DiffView/MultiDiffCard scope)',
      anchor:
        'src/tools/FileEditTool/types.ts:63-80 (structuredPatch: StructuredPatchHunk[])',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'assistant',
        message: {
          id: 'msg_01Fix00d',
          model: 'claude-sonnet-5',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_01FixEdit1',
              name: 'Edit',
              input: {
                file_path: '/repo/src/config.ts',
                old_string: "port: 3000",
                new_string: "port: 4000",
              },
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 900, output_tokens: 30, service_tier: null },
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000a00e',
      },
    },
    {
      name: 'assistant: unknown/future content block (tolerated, no row)',
      anchor:
        "no renderer mapping — engine's own default logs+skips (Message.tsx:630)",
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'assistant',
        message: {
          id: 'msg_01Fix005',
          model: 'claude-sonnet-5',
          role: 'assistant',
          content: [
            { type: 'compaction', content: '…summarized tail…', budget: 4096 },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 800, output_tokens: 3, service_tier: null },
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000a006',
      },
    },
    {
      name: 'assistant: non-streaming fallback frame (multi-block, new msg id)',
      anchor: 'src/services/api/claude.ts:2532-2560 (idle-watchdog fallback)',
      reach: 'app-seam',
      expectRows: 3,
      message: {
        type: 'assistant',
        message: {
          id: 'msg_01Fix006',
          model: 'claude-sonnet-5',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Retry without streaming.', signature: 'Eq0B' },
            { type: 'text', text: 'Reading the file now.' },
            {
              type: 'tool_use',
              id: 'toolu_01Fix002',
              name: 'Read',
              input: { file_path: '/repo/README.md' },
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1500, output_tokens: 45, service_tier: null },
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000a007',
      },
    },
    {
      name: 'assistant: subagent frame (non-null parent_tool_use_id)',
      anchor: 'src/utils/queryHelpers.ts:127-140 (agent/skill progress re-emit)',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'assistant',
        message: {
          id: 'msg_01Fix007',
          model: 'claude-haiku-4-5-20251001',
          role: 'assistant',
          content: [{ type: 'text', text: 'Subagent: found 3 call sites.' }],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 400, output_tokens: 12, service_tier: null },
        },
        parent_tool_use_id: 'toolu_01FixTask1',
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000a008',
      },
    },
    {
      name: 'assistant: API-error frame (error field, empty content — P2-1 ApiErrorRow scope)',
      anchor: 'src/utils/queryHelpers.ts:115 (`error: _.error`)',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'assistant',
        message: {
          id: 'msg_01Fix008',
          model: 'claude-sonnet-5',
          role: 'assistant',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0, service_tier: null },
        },
        error: 'rate_limit',
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000a009',
      },
    },
  ],

  /* ── assistant_error — SDKAssistantMessageError (top-level) ──────────────
   * The thread-goal scheduler reads this top-level case; the populated reality
   * is the `error` FIELD on assistant / api_retry frames. Shape per
   * coreTypes.generated.ts:105. */
  assistant_error: [
    {
      name: 'assistant_error: top-level API error (type-only today)',
      anchor: 'handled by src/app-runtime/attachThreadGoalScheduler.ts:249',
      reach: 'type-only',
      expectRows: 0,
      message: {
        type: 'assistant_error',
        message: 'Internal server error',
        request_id: 'req_011Fix001',
        status: 500,
        error: 'api_error',
        details: { retryable: true },
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000ae01',
      },
    },
  ],

  /* ── stream_event — SDKPartialAssistantMessage ───────────────────────────
   * QueryEngine.ts:876-884 wrap; `event` is the Anthropic
   * RawMessageStreamEvent VERBATIM (S1 §1; runtime pin coreSchemas.ts:1525).
   * parent_tool_use_id is hardcoded null at this seam (QueryEngine.ts:881).
   * Individual samples expect 0 rows in isolation. In a real sequence, text
   * deltas may surface a live preview row, but stream events remain droppable
   * garnish: the full assistant frame and result boundary are authoritative. */
  stream_event: [
    {
      name: 'stream_event: message_start (+ engine ttftMs bolt-on)',
      anchor: 'src/services/api/claude.ts:2489-2494 re-yield; ttftMs :2493',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            id: 'msg_01Fix001',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1200, output_tokens: 1, service_tier: null },
          },
          ttftMs: 412,
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000se01',
      },
    },
    {
      name: 'stream_event: content_block_start (text)',
      anchor: 'src/services/api/claude.ts:2155',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000se02',
      },
    },
    {
      name: 'stream_event: content_block_delta (text_delta)',
      anchor: 'src/services/api/claude.ts:2229; accumulate from empty (S1 §4)',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: "I'll read" },
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000se03',
      },
    },
    {
      name: 'stream_event: content_block_start (tool_use, input reset to "")',
      anchor: 'src/services/api/claude.ts:2160-2163',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'tool_use',
            id: 'toolu_01Fix001',
            name: 'Read',
            input: '',
          },
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000se04',
      },
    },
    {
      name: 'stream_event: content_block_delta (input_json_delta, unparsed JSON)',
      anchor: 'src/services/api/claude.ts (input_json_delta case); P1-3 saw live',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"file_path":"/re' },
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000se05',
      },
    },
    {
      name: 'stream_event: content_block_start (thinking, Codex reasoning_kind)',
      anchor: 'src/services/api/claude.ts:2192-2214; codex-fetch-adapter.ts:1426',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'thinking',
            thinking: '',
            signature: '',
            reasoning_kind: 'summary',
          },
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000se06',
      },
    },
    {
      name: 'stream_event: content_block_delta (thinking_delta)',
      anchor: 'src/utils/messages.ts:3153-3195 consumer',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Check the config…' },
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000se07',
      },
    },
    {
      name: 'stream_event: content_block_delta (signature_delta — never display content)',
      anchor: 'src/utils/messages.ts:3189-3193 (REPL excludes from counters)',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'EuYBCkQYAiJA' },
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000se08',
      },
    },
    {
      name: 'stream_event: content_block_stop (assistant frame precedes it — S1 §3 rule 2)',
      anchor: 'src/services/api/claude.ts:2350; yield m at :2391 precedes :2489',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000se09',
      },
    },
    {
      name: 'stream_event: message_delta (the ONLY stop_reason/usage source — S1 §4)',
      anchor: 'src/services/api/claude.ts:2394-2436',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'stream_event',
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { input_tokens: 1200, output_tokens: 84, service_tier: null },
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000se10',
      },
    },
    {
      name: 'stream_event: message_stop (message end ≠ turn end — S1 §3 rule 3)',
      anchor: 'src/services/api/claude.ts:2486',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'stream_event',
        event: { type: 'message_stop' },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000se11',
      },
    },
    {
      name: 'stream_event: citations_delta (accepted-not-accumulated — documented no-op posture, S1 §7)',
      anchor: 'src/services/api/claude.ts:2261 (accepted, not accumulated)',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'citations_delta',
            citation: { type: 'char_location', cited_text: 'sun_path is 104 bytes' },
          },
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000se12',
      },
    },
  ],

  /* ── user — SDKUserMessage + SDKUserMessageReplay ────────────────────────
   * queryHelpers.ts:203-218 (normal + tool_result carrier + isSynthetic),
   * QueryEngine.ts:795-807 (replay). content is `string | ContentBlockParam[]`
   * (coreTypes.generated.ts:299-312) — image blocks ride USER messages
   * (Message.tsx:405), not assistant ones. */
  user: [
    {
      name: 'user: plain prompt (string content)',
      anchor: 'src/utils/queryHelpers.ts:203-218',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'user',
        message: { role: 'user', content: 'read the config file' },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000u001',
        timestamp: '2026-07-04T09:00:00.000Z',
      },
    },
    {
      name: 'user: tool_result carrier (P2-2 correlation scope)',
      anchor: 'src/utils/queryHelpers.ts:205-218 (tool_use_result field)',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01Fix001',
              content: [{ type: 'text', text: '{ "name": "cat-code" }' }],
              is_error: false,
            },
          ],
        },
        parent_tool_use_id: null,
        isSynthetic: true,
        tool_use_result: { durationMs: 12 },
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000u002',
        timestamp: '2026-07-04T09:00:04.000Z',
      },
    },
    {
      name: 'user: FileEditTool tool_result carrying structuredPatch (P2-2 DiffView/MultiDiffCard source data)',
      anchor:
        'src/tools/FileEditTool/types.ts output schema; src/tools/FileEditTool/utils.ts (diff npm structuredPatch shape); real mapper emits string content, no is_error field. The whole pre-edit file is no longer persisted, so this carries the compact firstLine instead of originalFile',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01FixEdit1',
              content: 'The file /repo/src/config.ts has been updated successfully.',
            },
          ],
        },
        parent_tool_use_id: null,
        isSynthetic: true,
        tool_use_result: {
          filePath: '/repo/src/config.ts',
          oldString: 'port: 3000',
          newString: 'port: 4000',
          firstLine: 'export const config = {',
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 3,
              newStart: 1,
              newLines: 3,
              lines: [
                ' export const config = {',
                '-  port: 3000,',
                '+  port: 4000,',
                ' }',
              ],
            },
          ],
          userModified: false,
          replaceAll: false,
        },
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000u006',
        timestamp: '2026-07-04T09:00:05.000Z',
      },
    },
    {
      name: 'user: tool_result error (P2-2 correlation — is_error true)',
      anchor: 'src/utils/queryHelpers.ts:478 (`content.is_error !== true` read pattern)',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01FixErr1',
              content: [{ type: 'text', text: 'ENOENT: /repo/missing.json not found' }],
              is_error: true,
            },
          ],
        },
        parent_tool_use_id: null,
        isSynthetic: true,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000u007',
        timestamp: '2026-07-04T09:00:06.000Z',
      },
    },
    {
      name: 'user: tool_result for a subagent-scoped tool_use (D2 nesting — parent_tool_use_id non-null)',
      anchor:
        'src/utils/queryHelpers.ts:141-153 (agent/skill progress re-emit — same subagent path P2-0 found for assistant frames, `parent_tool_use_id: message.parentToolUseID`); D2 decisions/AGENT-CHROME.md C4 nests, never interleaves',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01FixSubGrep1',
              content: [{ type: 'text', text: '3 matches in src/tools/' }],
              is_error: false,
            },
          ],
        },
        parent_tool_use_id: 'toolu_01FixTask1',
        isSynthetic: true,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000u008',
        timestamp: '2026-07-04T09:00:07.000Z',
      },
    },
    {
      name: 'user: text + image blocks (P2-1 UserImageRow scope)',
      anchor: 'src/components/Message.tsx:405 (user image block render)',
      reach: 'app-seam',
      expectRows: 2,
      message: {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'what is in this screenshot?' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUg',
              },
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000u003',
        timestamp: '2026-07-04T09:01:00.000Z',
      },
    },
    {
      name: 'user: command replay (SDKUserMessageReplay, isReplay)',
      anchor:
        'src/QueryEngine.ts:795-807 + src/utils/processUserInput/processSlashCommand.tsx:795 (formatSlashCommandLoadingMetadata mints all three tags)',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'user',
        message: {
          role: 'user',
          content:
            '<command-message>compact</command-message>\n<command-name>/compact</command-name>\n<command-args>focus on tests</command-args>',
        },
        parent_tool_use_id: null,
        isReplay: true,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000u004',
        timestamp: '2026-07-04T09:02:00.000Z',
      },
    },
    {
      name: 'user: synthetic/meta message (isSynthetic)',
      anchor: 'src/utils/queryHelpers.ts:214 (isMeta || isVisibleInTranscriptOnly)',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'user',
        message: { role: 'user', content: '<system-reminder>…</system-reminder>' },
        parent_tool_use_id: null,
        isSynthetic: true,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000u005',
        timestamp: '2026-07-04T09:02:01.000Z',
      },
    },

    /* ── engine-injected user turns (`origin`) ────────────────────────────────
     * Five of the six `MessageOrigin` kinds (src/types/message.ts:10) are NOT
     * the operator. They reach the app as ordinary `user` frames — live via the
     * mid-turn queue drain (QueryEngine.ts `queued_command` yield) and on resume
     * via `toSDKMessages` over a transcript the TUI wrote — and every one of
     * them rendered as the operator's own bubble until `origin` crossed the wire
     * (protocol.ts `EventFrame` §User-turn provenance). One sample per kind: a
     * gap here is a kind that silently regresses to a user bubble. */
    {
      name: 'user: task-notification origin (agent completion banner)',
      anchor:
        'src/utils/messageQueueManager.ts:143-155 (enqueuePendingNotification) → src/QueryEngine.ts queued_command yield',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'user',
        message: {
          role: 'user',
          content:
            'Task notification\nTask ID: task_01\nStatus: completed\nSummary: refactored the parser',
        },
        parent_tool_use_id: null,
        isReplay: true,
        // Carries the full narrowed origin. `toolUseId` names a card that is
        // absent from this one-message projection, so the row stays visible
        // here; the merge itself is covered in transcriptProjector.test.ts.
        origin: {
          kind: 'task-notification',
          status: 'completed',
          summary: 'refactored the parser',
          toolUseId: 'toolu_absent_here',
          result: 'The parser now reads the header in one pass.',
          usage: { totalTokens: 8200, toolUses: 5, durationMs: 31000 },
        },
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000u010',
        timestamp: '2026-07-04T09:03:00.000Z',
      },
    },
    {
      name: 'user: coordinator origin (orchestrator message to a worker)',
      anchor:
        'src/utils/attachments.ts:1107-1112 (getAgentPendingMessageAttachments)',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'user',
        message: { role: 'user', content: 'switch to the settings surface next' },
        parent_tool_use_id: null,
        isReplay: true,
        origin: { kind: 'coordinator' },
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000u011',
        timestamp: '2026-07-04T09:03:01.000Z',
      },
    },
    {
      name: 'user: channel origin (external MCP channel, server + user)',
      anchor:
        'src/services/mcp/useManageMCPConnections.ts:520-536; render precedent src/components/messages/UserChannelMessage.tsx:56-78',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'user',
        message: { role: 'user', content: 'can you look at the deploy failure?' },
        parent_tool_use_id: null,
        isReplay: true,
        origin: { kind: 'channel', server: 'slack', user: 'dana' },
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000u012',
        timestamp: '2026-07-04T09:03:02.000Z',
      },
    },
    {
      name: 'user: teammate origin (swarm peer message)',
      anchor:
        'src/utils/swarm/inProcessRunner.ts:1304,1670,1709; render precedent src/components/messages/UserTeammateMessage.tsx:98',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'user',
        message: { role: 'user', content: 'I finished the projector tests.' },
        parent_tool_use_id: null,
        isReplay: true,
        origin: { kind: 'teammate', from: 'scout' },
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000u013',
        timestamp: '2026-07-04T09:03:03.000Z',
      },
    },
    {
      name: 'user: deferred-continuation origin (resumed after a provider stall)',
      anchor: 'src/services/deferredContinuationRunner.ts:367-379 (isMeta:false)',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'user',
        message: { role: 'user', content: 'Continue where you left off.' },
        parent_tool_use_id: null,
        isReplay: true,
        origin: { kind: 'deferred-continuation' },
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000u014',
        timestamp: '2026-07-04T09:03:04.000Z',
      },
    },
    {
      name: 'user: peer origin (a named session messaging another)',
      anchor: 'src/types/message.ts ({ kind: "peer" }); PEER-SESSIONS §6',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'user',
        message: { role: 'user', content: 'ran the migration, all green' },
        parent_tool_use_id: null,
        isReplay: true,
        // The SDK projection carries the sender's NAME only: the internal
        // origin's `appSessionId` is deliberately not on this surface.
        origin: { kind: 'peer', name: 'Bear' },
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000u022',
        timestamp: '2026-07-04T09:03:04.500Z',
      },
    },
    {
      name: 'user: human origin (explicitly the operator — stays a user bubble)',
      anchor: 'src/types/message.ts:11 ({ kind: "human" })',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'user',
        message: { role: 'user', content: 'run the tests please' },
        parent_tool_use_id: null,
        origin: { kind: 'human' },
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000u015',
        timestamp: '2026-07-04T09:03:05.000Z',
      },
    },
    {
      name: 'user: legacy <task-notification> envelope, NO origin (pre-field transcript)',
      anchor:
        'src/utils/taskNotification.ts:119-137 (compatibility-only legacy parser)',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'user',
        message: {
          role: 'user',
          content:
            '<task-notification>\n<status>failed</status>\n<summary>build broke</summary>\n</task-notification>',
        },
        parent_tool_use_id: null,
        isReplay: true,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000u016',
        timestamp: '2026-07-04T09:03:06.000Z',
      },
    },

    /* ── local slash-command output ───────────────────────────────────────────
     * A terminal slash command's RESULT is persisted as a plain `user` message
     * whose whole content is the raw wrapper — no `origin`, no synthetic flag,
     * nothing else to tell it apart from an operator turn. The terminal branches
     * on the tag itself (UserTextMessage.tsx:76-81); the app did not, so the
     * operator was shown as the author of `/model`'s own output. */
    {
      name: 'user: local slash-command stdout (engine wrapper, no origin)',
      anchor: 'src/utils/processUserInput/processSlashCommand.tsx:625',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'user',
        message: {
          role: 'user',
          content: '<local-command-stdout>Set model to X</local-command-stdout>',
        },
        parent_tool_use_id: null,
        isReplay: true,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000u017',
        timestamp: '2026-07-04T09:03:07.000Z',
      },
    },
    {
      name: 'user: local slash-command stdout carrying live ANSI bytes',
      anchor:
        'src/utils/processUserInput/processSlashCommand.tsx:625 (chalk-formatted result); no stripAnsi on the restore path — src/utils/messages/mappers.ts:191-213 `case "user"`',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'user',
        message: {
          role: 'user',
          content:
            '<local-command-stdout>Set model to \u001B[1mGPT 5.6 Sol\u001B[22m · Provider \u001B[1mOpenAI\u001B[22m</local-command-stdout>',
        },
        parent_tool_use_id: null,
        isReplay: true,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000u018',
        timestamp: '2026-07-04T09:03:08.000Z',
      },
    },

    /* ── bash-mode (`!`) command output ───────────────────────────────────────
     * The same leak as the slash-command wrapper above, from the other engine
     * producer: a `!` command's RESULT is persisted as a plain `user` message
     * whose whole content is the raw wrapper. The terminal branches on it with
     * the identical anchored `startsWith` shape (UserTextMessage.tsx:69-74), one
     * line above the local-command branch, so both ride one projector branch.
     * `<bash-input>` is deliberately NOT here: that is the operator's own typed
     * command and the terminal routes it to UserBashInputMessage instead
     * (UserTextMessage.tsx:102). */
    {
      name: 'user: bash-mode command stdout (engine wrapper, no origin)',
      anchor: 'src/utils/processUserInput/processBashCommand.tsx:109',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'user',
        message: {
          role: 'user',
          content:
            '<bash-stdout>README.md\npackage.json</bash-stdout><bash-stderr></bash-stderr>',
        },
        parent_tool_use_id: null,
        isReplay: true,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000u019',
        timestamp: '2026-07-04T09:03:09.000Z',
      },
    },
    {
      name: 'user: bash-mode command stderr only (shell failure path)',
      anchor: 'src/utils/processUserInput/processBashCommand.tsx:132',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'user',
        message: {
          role: 'user',
          content: '<bash-stderr>ls: nope: No such file or directory</bash-stderr>',
        },
        parent_tool_use_id: null,
        isReplay: true,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000u020',
        timestamp: '2026-07-04T09:03:10.000Z',
      },
    },
    {
      // Large `!` output: the stdout payload carries a SECOND, inner wrapper.
      // processBashCommand.tsx:106 deliberately leaves
      // buildLargeToolResultMessage's `<persisted-output>` unescaped
      // (toolResultStorage.ts:189-199 builds it), so the terminal unwraps it
      // again at render time (UserBashOutputMessage.tsx:14-18).
      name: 'user: bash-mode command stdout wrapping large persisted output',
      anchor:
        'src/utils/processUserInput/processBashCommand.tsx:106 (inner wrapper kept unescaped) → src/utils/toolResultStorage.ts:189',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'user',
        message: {
          role: 'user',
          content:
            '<bash-stdout><persisted-output>\nOutput too large (1.4MB). Full output saved to: /tmp/cat-code/bash-9f2c.txt\n\nPreview (first 10.0KB):\nsrc/QueryEngine.ts\nsrc/main.tsx\n...\n</persisted-output></bash-stdout><bash-stderr></bash-stderr>',
        },
        parent_tool_use_id: null,
        isReplay: true,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000u021',
        timestamp: '2026-07-04T09:03:11.000Z',
      },
    },
  ],

  /* ── system — SDKSystemMessage + SDKCompactBoundaryMessage +
   *             SDKAccountDiagnosticMessage (one discriminant, 3 members) ──
   * One sample per subtype in the type union (coreTypes.generated.ts:173-189)
   * + the runtime schema's required fields (coreSchemas.ts per-subtype). */
  system: [
    {
      // P4-23 (operator, 2026-07-09): the init frame emits NO transcript row now
      // (the ✦ "Session started" banner was removed). It still runs `case 'init'`
      // to capture the P3-7 slash-command catalog — proven in the projector's
      // "captures the init frame slash_commands catalog" test — but adds 0 rows.
      name: 'system: init (first frame of first turn)',
      anchor: 'src/utils/messages/systemInit.ts:57-97',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'system',
        subtype: 'init',
        cwd: '/Users/pt/cat-code',
        session_id: SESSION,
        tools: ['Bash', 'Read', 'Edit', 'Write', 'Skill'],
        mcp_servers: [{ name: 'gpt-agent', status: 'connected' }],
        model: 'claude-sonnet-5',
        permissionMode: 'default',
        slash_commands: ['compact', 'clear'],
        apiKeySource: 'none',
        betas: [],
        claude_code_version: '3.0.0',
        output_style: 'default',
        agents: ['Explore', 'Plan'],
        skills: ['verify'],
        plugins: [{ name: 'ponytail', path: '/Users/pt/.claude/plugins/ponytail' }],
        fast_mode_state: 'off',
        uuid: '00000000-0000-4000-8000-00000000sy01',
      },
    },
    {
      name: 'system: status (runtime-schema status home; NB type-union also has type:"status")',
      anchor: 'src/cli/print.ts:1085/2217; schema coreSchemas.ts:1562',
      reach: 'sdk-stdout-only',
      expectRows: 0,
      message: {
        type: 'system',
        subtype: 'status',
        status: 'compacting',
        permissionMode: 'default',
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000sy02',
      },
    },
    {
      name: 'system: compact_boundary (SDKCompactBoundaryMessage)',
      anchor: 'src/QueryEngine.ts:993-999 (toSDKCompactMetadata)',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 167034 },
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000sy03',
      },
    },
    /* microcompact_boundary — NO SAMPLE, BY PROOF OF UNINHABITABILITY.
     * SDKCompactBoundaryMessage (coreTypes.generated.ts:234) intersects its
     * `subtype: 'compact_boundary' | 'microcompact_boundary'` with the base
     * SDKSystemMessage.subtype union (:173-189), which does NOT list
     * 'microcompact_boundary' — the intersection collapses to
     * 'compact_boundary' only, so a microcompact SDK frame cannot even be
     * TYPED (tsc rejects it; that rejection is this fixture's evidence).
     * Runtime agrees: SDKCompactBoundaryMessageSchema accepts only
     * 'compact_boundary' (coreSchemas.ts:1538) and QueryEngine forwards only
     * compact_boundary/api_retry from the internal system stream
     * (QueryEngine.ts:975-1015); the internal microcompact message
     * (src/utils/messages.ts:4685) never becomes an SDK frame. Confirms
     * INVENTORY W3: MicrocompactBoundaryRow has no real visible mapping. */
    {
      name: 'system: post_turn_summary (schema exists in neither union — rides the type\'s subtype bag)',
      anchor: 'schema src/entrypoints/sdk/coreSchemas.ts:1600 (not in SDKMessageSchema)',
      reach: 'type-only',
      expectRows: 0,
      message: {
        type: 'system',
        subtype: 'post_turn_summary',
        summarizes_uuid: '00000000-0000-4000-8000-00000000a001',
        status_category: 'completed',
        status_detail: 'Read config and reported contents',
        is_noteworthy: false,
        title: 'Config read',
        description: 'Read /repo/config.json and summarized it.',
        recent_action: 'Read /repo/config.json',
        needs_action: '',
        artifact_urls: [],
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000sy05',
      },
    },
    {
      name: 'system: api_retry',
      anchor: 'src/QueryEngine.ts:1097-1126',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'system',
        subtype: 'api_retry',
        attempt: 2,
        max_retries: 10,
        retry_delay_ms: 8000,
        error_status: 529,
        error: {
          type: 'assistant_error',
          message: 'Overloaded',
          status: 529,
          error: 'overloaded_error',
        },
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000sy06',
      },
    },
    {
      name: 'system: local_command_output (assistant-style text per schema note)',
      anchor:
        'schema src/entrypoints/sdk/coreSchemas.ts:1646; no literal mint site found in src/',
      reach: 'type-only',
      expectRows: 1,
      message: {
        type: 'system',
        subtype: 'local_command_output',
        content: 'Total cost: $0.42',
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000sy07',
      },
    },
    {
      name: 'system: hook_started',
      anchor: 'src/cli/print.ts:648',
      reach: 'sdk-stdout-only',
      expectRows: 0,
      message: {
        type: 'system',
        subtype: 'hook_started',
        hook_id: 'hook_01',
        hook_name: 'PreToolUse:Bash',
        hook_event: 'PreToolUse',
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000sy08',
      },
    },
    {
      name: 'system: hook_progress',
      anchor: 'src/cli/print.ts:658',
      reach: 'sdk-stdout-only',
      expectRows: 0,
      message: {
        type: 'system',
        subtype: 'hook_progress',
        hook_id: 'hook_01',
        hook_name: 'PreToolUse:Bash',
        hook_event: 'PreToolUse',
        stdout: 'checking…\n',
        stderr: '',
        output: 'checking…\n',
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000sy09',
      },
    },
    {
      name: 'system: hook_response',
      anchor: 'src/cli/print.ts:671',
      reach: 'sdk-stdout-only',
      expectRows: 0,
      message: {
        type: 'system',
        subtype: 'hook_response',
        hook_id: 'hook_01',
        hook_name: 'PreToolUse:Bash',
        hook_event: 'PreToolUse',
        output: 'OK',
        stdout: 'OK\n',
        stderr: '',
        exit_code: 0,
        outcome: 'success',
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000sy10',
      },
    },
    {
      name: 'system: files_persisted',
      anchor: 'src/cli/print.ts:2276',
      reach: 'sdk-stdout-only',
      expectRows: 0,
      message: {
        type: 'system',
        subtype: 'files_persisted',
        files: [{ filename: 'report.md', file_id: 'file_01' }],
        failed: [],
        processed_at: '2026-07-04T09:05:00.000Z',
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000sy11',
      },
    },
    {
      name: 'system: task_notification',
      anchor: 'src/utils/sdkEventQueue.ts:126 (queue-minted; drained only by cli/print.ts)',
      reach: 'sdk-stdout-only',
      expectRows: 0,
      message: {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task_01',
        tool_use_id: 'toolu_01FixTask1',
        status: 'completed',
        output_file: '/tmp/task_01/output.md',
        summary: 'Explore finished: 3 call sites found',
        usage: { total_tokens: 4200, tool_uses: 6, duration_ms: 48000 },
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000sy12',
      },
    },
    {
      name: 'system: task_started',
      anchor: 'src/utils/task/framework.ts:98 (via sdkEventQueue; drained only by cli/print.ts)',
      reach: 'sdk-stdout-only',
      expectRows: 0,
      message: {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task_01',
        tool_use_id: 'toolu_01FixTask1',
        description: 'Find call sites of projectServerFrame',
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000sy13',
      },
    },
    {
      name: 'system: task_progress',
      anchor: 'src/utils/task/sdkProgress.ts:23 (via sdkEventQueue; drained only by cli/print.ts)',
      reach: 'sdk-stdout-only',
      expectRows: 0,
      message: {
        type: 'system',
        subtype: 'task_progress',
        task_id: 'task_01',
        tool_use_id: 'toolu_01FixTask1',
        description: 'Find call sites of projectServerFrame',
        usage: { total_tokens: 1800, tool_uses: 2, duration_ms: 15000 },
        last_tool_name: 'Grep',
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000sy14',
      },
    },
    {
      name: 'system: session_state_changed (authoritative turn-over signal per schema note)',
      anchor: 'src/utils/sessionState.ts:130 (via sdkEventQueue; drained only by cli/print.ts)',
      reach: 'sdk-stdout-only',
      expectRows: 0,
      message: {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000sy15',
      },
    },
    {
      name: 'system: elicitation_complete',
      anchor: 'src/cli/print.ts:1385',
      reach: 'sdk-stdout-only',
      expectRows: 0,
      message: {
        type: 'system',
        subtype: 'elicitation_complete',
        mcp_server_name: 'linear',
        elicitation_id: 'elic_01',
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000sy16',
      },
    },
    {
      name: 'system: cat_code_account_diagnostic (SDKAccountDiagnosticMessage)',
      anchor: 'src/services/api/accountDiagnostics.ts:399-410',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'system',
        subtype: 'cat_code_account_diagnostic',
        version: 1,
        code: 'account.route.selected',
        severity: 'info',
        provider: 'openai',
        recoverable: true,
        pool: 'codex',
        requested_model: 'gpt-5.6-terra',
        resolved_provider: 'openai',
        resolved_model: 'gpt-5.6-terra',
        account_ref: 'acct_7',
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000sy17',
      },
    },
  ],

  /* ── result — SDKResultMessage + SDKResultSuccess ────────────────────────
   * The ONLY turn-end marker (S1 §3). Turn totals live here. */
  result: [
    {
      name: 'result: success (full SDKResultSuccess shape)',
      anchor: 'src/QueryEngine.ts:1142 (terminal success yield)',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'result',
        subtype: 'success',
        duration_ms: 5321,
        duration_api_ms: 4100,
        is_error: false,
        num_turns: 1,
        result: 'Read the config and summarized it.',
        stop_reason: 'end_turn',
        total_cost_usd: 0.0421,
        usage: {
          input_tokens: 1200,
          output_tokens: 96,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 800,
        },
        modelUsage: {
          'claude-sonnet-5': {
            costUSD: 0.0421,
            inputTokens: 1200,
            outputTokens: 96,
            cacheReadInputTokens: 800,
          },
        },
        permission_denials: [],
        fast_mode_state: 'off',
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000r001',
      },
    },
    {
      name: 'result: error_during_execution (+ permission_denials entry)',
      anchor: 'src/QueryEngine.ts:1143 (error yields share the shape)',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: 2100,
        duration_api_ms: 1900,
        is_error: true,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0.011,
        usage: { input_tokens: 900, output_tokens: 12 },
        modelUsage: {},
        permission_denials: [
          {
            tool_name: 'Bash',
            tool_use_id: 'toolu_01FixDeny1',
            tool_input: { command: 'rm -rf /tmp/x' },
          },
        ],
        errors: ['Tool execution failed'],
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000r002',
      },
    },
    {
      name: 'result: error_max_turns',
      anchor: 'src/QueryEngine.ts:910-930',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'result',
        subtype: 'error_max_turns',
        duration_ms: 60210,
        duration_api_ms: 51000,
        is_error: true,
        num_turns: 25,
        stop_reason: 'end_turn',
        total_cost_usd: 0.92,
        usage: { input_tokens: 40000, output_tokens: 9000 },
        modelUsage: {},
        permission_denials: [],
        errors: ['Reached maximum number of turns (25)'],
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000r003',
      },
    },
    {
      name: 'result: interrupted',
      anchor: 'src/QueryEngine.ts:1230 (terminal user-interrupted yield)',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'result',
        subtype: 'interrupted',
        duration_ms: 1800,
        duration_api_ms: 1500,
        is_error: false,
        num_turns: 1,
        stop_reason: 'interrupted',
        total_cost_usd: 0.001,
        usage: { input_tokens: 500, output_tokens: 20 },
        modelUsage: {},
        permission_denials: [],
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000r004',
      },
    },
    {
      name: 'result: error_auth_required',
      anchor: 'src/QueryEngine.ts:1280 (terminal authentication failure yield)',
      reach: 'app-seam',
      expectRows: 1,
      message: {
        type: 'result',
        subtype: 'error_auth_required',
        duration_ms: 2100,
        duration_api_ms: 2000,
        is_error: true,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        errors: ['OAuth access token has been revoked.'],
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000r005',
      },
    },
  ],

  /* ── status — SDKStatusMessage (type:'status') ───────────────────────────
   * Type-only: no mint site in src/; the runtime schema's same-named entry is
   * system/subtype:'status' (see header drift note). */
  status: [
    {
      name: "status: type:'status' (type-only member; SDKStatus = 'compacting'|string|null)",
      anchor: 'no mint site; type src/entrypoints/sdk/coreTypes.generated.ts:166',
      reach: 'type-only',
      expectRows: 0,
      message: {
        type: 'status',
        status: 'compacting',
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000st01',
      },
    },
  ],

  /* ── permission_denial — SDKPermissionDenial ─────────────────────────────
   * Type-only: never minted. Live permission flow is the control channel
   * (permission.requested/resolved AppSessionEvents → P2-4 domain), and
   * denial summaries ride result.permission_denials. */
  permission_denial: [
    {
      name: 'permission_denial: type-only member',
      anchor: 'no mint site; type src/entrypoints/sdk/coreTypes.generated.ts:268',
      reach: 'type-only',
      expectRows: 0,
      message: {
        type: 'permission_denial',
        mode: 'default',
        toolName: 'Bash',
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000pd01',
      },
    },
  ],

  /* ── tool_progress — SDKToolProgressMessage ──────────────────────────────
   * Engine-throttled (30s) long-tool heartbeat. */
  tool_progress: [
    {
      name: 'tool_progress: Bash heartbeat',
      anchor: 'src/utils/queryHelpers.ts:189-199',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'tool_progress',
        tool_use_id: 'toolu_01FixBash1',
        tool_name: 'Bash',
        parent_tool_use_id: null,
        elapsed_time_seconds: 30,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000tp01',
      },
    },
  ],

  /* ── tool_use_summary — SDKToolUseSummaryMessage ─────────────────────────*/
  tool_use_summary: [
    {
      name: 'tool_use_summary: post-hoc summary over preceding tool uses',
      anchor: 'src/QueryEngine.ts:1017-1026',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'tool_use_summary',
        summary: 'Read 2 files, searched the repo once',
        preceding_tool_use_ids: ['toolu_01Fix001', 'toolu_01Fix002'],
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000ts01',
      },
    },
  ],

  /* ── auth_status — SDKAuthStatusMessage ──────────────────────────────────*/
  auth_status: [
    {
      name: 'auth_status: AWS auth in progress (stdout SDK server opt-in)',
      anchor: 'src/cli/print.ts:1126-1136',
      reach: 'sdk-stdout-only',
      expectRows: 0,
      message: {
        type: 'auth_status',
        isAuthenticating: true,
        output: ['Refreshing SSO token…'],
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000au01',
      },
    },
  ],

  /* ── rate_limit_event — SDKRateLimitEventMessage ─────────────────────────*/
  rate_limit_event: [
    {
      name: 'rate_limit_event: five-hour window warning',
      anchor: 'src/cli/print.ts:1141-1152 (toSDKRateLimitInfo)',
      reach: 'sdk-stdout-only',
      expectRows: 0,
      message: {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed_warning',
          rateLimitType: 'five_hour',
          utilization: 0.87,
          resetsAt: 1783418400,
          isUsingOverage: false,
        },
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000rl01',
      },
    },
  ],

  /* ── prompt_suggestion — SDKPromptSuggestionMessage ──────────────────────*/
  prompt_suggestion: [
    {
      name: 'prompt_suggestion: predicted next prompt (opt-in)',
      anchor: 'src/cli/print.ts:2318-2326',
      reach: 'sdk-stdout-only',
      expectRows: 0,
      message: {
        type: 'prompt_suggestion',
        suggestion: 'run the tests to confirm',
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000ps01',
      },
    },
  ],

  /* ── streamlined_text / streamlined_tool_use_summary ─────────────────────
   * Streamlined-output transform REPLACES assistant frames on the stdout SDK
   * path only; the app seam receives the originals. */
  streamlined_text: [
    {
      name: 'streamlined_text: text-preserving assistant replacement',
      anchor: 'src/utils/streamlinedTransform.ts:150-156 (used only by cli/print.ts)',
      reach: 'sdk-stdout-only',
      expectRows: 0,
      message: {
        type: 'streamlined_text',
        text: 'Read the config and summarized it.',
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000sl01',
      },
    },
  ],
  streamlined_tool_use_summary: [
    {
      name: 'streamlined_tool_use_summary: cumulative tool summary',
      anchor: 'src/utils/streamlinedTransform.ts:164-170',
      reach: 'sdk-stdout-only',
      expectRows: 0,
      message: {
        type: 'streamlined_tool_use_summary',
        tool_summary: 'Read 2 files, wrote 1 file',
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000sl02',
      },
    },
  ],
}

export const S1_STREAMING_TEXT_TURN: {
  readonly name: string
  readonly expectFinalRows: number
  readonly messages: readonly SDKMessage[]
} = {
  name: 'S1 streaming text turn: stream garnish reconciles to full assistant frame',
  expectFinalRows: 2,
  messages: [
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg_01S1Text',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1200, output_tokens: 1, service_tier: null },
        },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000s101',
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000s102',
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Streaming preview' },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000s103',
    },
    {
      type: 'assistant',
      message: {
        id: 'msg_01S1Text',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'Streaming preview final.' }],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 12, service_tier: null },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000s104',
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000s105',
    },
    {
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 12 },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000s106',
    },
    {
      type: 'stream_event',
      event: { type: 'message_stop' },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000s107',
    },
    {
      type: 'result',
      subtype: 'success',
      duration_ms: 10,
      duration_api_ms: 8,
      is_error: false,
      num_turns: 1,
      result: 'done',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 12 },
      modelUsage: {},
      permission_denials: [],
      fast_mode_state: 'off',
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000s108',
    },
  ],
}

/**
 * Codex's reasoning frames use the same producer ordering as text: a completed
 * assistant block arrives before the corresponding `content_block_stop`.
 */
export const S1_STREAMING_REASONING_TURN: {
  readonly name: string
  readonly expectFinalRows: number
  readonly messages: readonly SDKMessage[]
} = {
  name: 'S1 streaming reasoning turn: live thinking reconciles before block stop',
  expectFinalRows: 3,
  messages: [
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg_01S1Reasoning',
          type: 'message',
          role: 'assistant',
          model: 'gpt-5.6-terra',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1200, output_tokens: 1, service_tier: null },
        },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sr01',
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'thinking',
          thinking: '',
          reasoning_kind: 'summary',
        },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sr02',
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Inspect configuration' },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sr03',
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '\n\nCheck dependencies' },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sr04',
    },
    {
      type: 'assistant',
      message: {
        id: 'msg_01S1Reasoning',
        model: 'gpt-5.6-terra',
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'Inspect configuration\n\nCheck dependencies',
            signature: 'reasoning-signature',
            reasoningKind: 'summary',
          },
        ],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 12, service_tier: null },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sr05',
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sr06',
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sr07',
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'I found the issue.' },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sr08',
    },
    {
      type: 'assistant',
      message: {
        id: 'msg_01S1Reasoning',
        model: 'gpt-5.6-terra',
        role: 'assistant',
        content: [{ type: 'text', text: 'I found the issue.' }],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 17, service_tier: null },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sr09',
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 1 },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sr10',
    },
    {
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 17 },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sr11',
    },
    {
      type: 'stream_event',
      event: { type: 'message_stop' },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sr12',
    },
    {
      type: 'result',
      subtype: 'success',
      duration_ms: 10,
      duration_api_ms: 8,
      is_error: false,
      num_turns: 1,
      result: 'done',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 17 },
      modelUsage: {},
      permission_denials: [],
      fast_mode_state: 'off',
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sr13',
    },
  ],
}

/**
 * Codex can expose summary and raw reasoning concurrently. It closes raw first,
 * so the second authoritative assistant frame must recover the still-live
 * summary block's index instead of reusing raw's most recent index.
 */
export const S1_CONCURRENT_REASONING_TURN: {
  readonly name: string
  readonly expectFinalRows: number
  readonly messages: readonly SDKMessage[]
} = {
  name: 'S1 concurrent reasoning turn: raw closes before summary',
  expectFinalRows: 3,
  messages: [
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg_01S1ConcurrentReasoning',
          type: 'message',
          role: 'assistant',
          model: 'gpt-5.6-terra',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1200, output_tokens: 1, service_tier: null },
        },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sc01',
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'thinking',
          thinking: '',
          reasoning_kind: 'summary',
        },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sc02',
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Summary' },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sc03',
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'thinking',
          thinking: '',
          reasoning_kind: 'raw',
        },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sc04',
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'thinking_delta', thinking: 'Raw' },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sc05',
    },
    {
      type: 'assistant',
      message: {
        id: 'msg_01S1ConcurrentReasoning',
        model: 'gpt-5.6-terra',
        role: 'assistant',
        content: [{
          type: 'thinking',
          thinking: 'Raw',
          signature: 'raw-signature',
          reasoningKind: 'raw',
        }],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 4, service_tier: null },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sc06',
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 1 },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sc07',
    },
    {
      type: 'assistant',
      message: {
        id: 'msg_01S1ConcurrentReasoning',
        model: 'gpt-5.6-terra',
        role: 'assistant',
        content: [{
          type: 'thinking',
          thinking: 'Summary',
          signature: 'summary-signature',
          reasoningKind: 'summary',
        }],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 8, service_tier: null },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sc08',
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sc09',
    },
    {
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 8 },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sc10',
    },
    {
      type: 'stream_event',
      event: { type: 'message_stop' },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sc11',
    },
    {
      type: 'result',
      subtype: 'success',
      duration_ms: 10,
      duration_api_ms: 8,
      is_error: false,
      num_turns: 1,
      result: 'done',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 8 },
      modelUsage: {},
      permission_denials: [],
      fast_mode_state: 'off',
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000sc12',
    },
  ],
}

/**
 * D2/C4 nested-subagent turn (P4-8c AgentToolCard fixture): a top-level Agent
 * tool_use (`subagent_type`/`description`/`prompt` — the real Agent-tool input
 * keys) whose subagent re-emits a full frame UNDER it (non-null
 * `parent_tool_use_id`, `src/utils/queryHelpers.ts:127-140`) plus that
 * subagent's own `tool_result`. Feeds the card's identity/state derivation and
 * the C4 collapsed child nesting.
 */
export const AGENT_WITH_NESTED_SUBAGENT_TURN: {
  readonly name: string
  readonly parentToolUseId: string
  readonly childToolUseId: string
  readonly messages: readonly SDKMessage[]
} = {
  name: 'Agent tool_use with a nested subagent tool_use + result (C4)',
  parentToolUseId: 'toolu_agent8c_parent',
  childToolUseId: 'toolu_agent8c_child',
  messages: [
    {
      type: 'assistant',
      message: {
        id: 'msg_agent8c_1',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_agent8c_parent',
            name: 'Agent',
            input: {
              subagent_type: 'Explore',
              description: 'Map the transcript projector',
              prompt: 'Find every call site of projectServerFrame and summarize.',
            },
          },
        ],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1400, output_tokens: 22, service_tier: null },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-0000008c0001',
    },
    {
      type: 'assistant',
      message: {
        id: 'msg_agent8c_2',
        model: 'claude-haiku-4-5-20251001',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_agent8c_child',
            name: 'Grep',
            input: { pattern: 'projectServerFrame' },
          },
        ],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 300, output_tokens: 8, service_tier: null },
      },
      parent_tool_use_id: 'toolu_agent8c_parent',
      agent_name: ' @Ada ',
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-0000008c0002',
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_agent8c_child',
            content: [{ type: 'text', text: '3 matches in app/renderer/src/' }],
            is_error: false,
          },
        ],
      },
      parent_tool_use_id: 'toolu_agent8c_parent',
      isSynthetic: true,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-0000008c0003',
    },
  ],
}

/**
 * D2/§3 DelegateGroup turn (P4-8c grouping fixture): TWO Agent tool_use blocks
 * the orchestrator launched in parallel. The streaming producer emits one frame
 * per stopped block, so both carry the SAME `message.id` (`msg_delegate8c`) —
 * the seam's only "co-spawned" signal (`src/utils/groupToolUses.ts:76`, groups
 * by `${message.id}:${tool_name}` when 2+). `groupAgentDelegates` coalesces them
 * into one `agent-group` display item; no new frame or message type is minted.
 */
export const PARALLEL_AGENTS_TURN: {
  readonly name: string
  readonly sharedMessageId: string
  readonly toolUseIds: readonly [string, string]
  readonly messages: readonly SDKMessage[]
} = {
  name: 'two parallel Agent tool_uses sharing one message.id (DelegateGroup)',
  sharedMessageId: 'msg_delegate8c',
  toolUseIds: ['toolu_delegate8c_a', 'toolu_delegate8c_b'],
  messages: [
    {
      type: 'assistant',
      message: {
        id: 'msg_delegate8c',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_delegate8c_a',
            name: 'Agent',
            input: {
              subagent_type: 'Explore',
              description: 'Audit the sidecar boundary',
            },
          },
        ],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1500, output_tokens: 20, service_tier: null },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-0000008cd001',
    },
    {
      type: 'assistant',
      message: {
        id: 'msg_delegate8c',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_delegate8c_b',
            name: 'Agent',
            input: {
              subagent_type: 'Explore',
              description: 'Audit the renderer projector',
            },
          },
        ],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1500, output_tokens: 20, service_tier: null },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-0000008cd002',
    },
  ],
}

/** Flat view over every sample, for coverage-loop tests. */
export function allSdkMessageSamples(): readonly SdkMessageSample[] {
  return Object.values(SDK_MESSAGE_FIXTURE).flat()
}

/**
 * Schema-drift wire sample: a frame body whose `type` is outside today's
 * union, exactly as the socket would deliver it (frames arrive as parsed
 * JSON, not as compile-time SDKMessage values). The projector must treat it
 * as a tolerated no-op — never a crash (the runtime half of the projector's
 * `never`-tripwire default branch).
 */
export const DRIFT_WIRE_SAMPLE_JSON =
  '{"type":"future_variant_v2","payload":{"answer":42},"session_id":"engine-session-1","uuid":"00000000-0000-4000-8000-00000000ff01"}'
