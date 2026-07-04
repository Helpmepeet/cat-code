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
      name: 'assistant: thinking block (P2-1 row scope — no row yet)',
      anchor:
        'src/components/Message.tsx:553 renders it; Codex adds reasoning_kind (claude.ts:2192)',
      reach: 'app-seam',
      expectRows: 0,
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
      name: 'assistant: redacted_thinking block (P2-1 row scope — no row yet)',
      anchor: 'src/components/Message.tsx:538 (AssistantRedactedThinkingMessage)',
      reach: 'app-seam',
      expectRows: 0,
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
      name: 'assistant: server_tool_use block (P2-2 tool-card scope — no row yet)',
      anchor:
        'src/utils/messages.ts:3136 block-start family; src/utils/messages.ts:2766 normalize',
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
      expectRows: 2,
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
        error: {
          type: 'assistant_error',
          message: 'Overloaded',
          status: 529,
          error: 'overloaded_error',
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-00000000a009',
      },
    },
  ],

  /* ── assistant_error — SDKAssistantMessageError (top-level) ──────────────
   * Never minted top-level in src/ (only appSessionEventMapper.ts:68 READS
   * the case); the populated reality is the `error` FIELD on assistant /
   * api_retry frames. Shape per coreTypes.generated.ts:105. */
  assistant_error: [
    {
      name: 'assistant_error: top-level API error (type-only today)',
      anchor: 'no mint site; read at src/web/appSessionEventMapper.ts:68',
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
      expectRows: 0,
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
      name: 'user: text + image blocks (P2-1 UserImageRow scope)',
      anchor: 'src/components/Message.tsx:405 (user image block render)',
      reach: 'app-seam',
      expectRows: 0,
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
      name: 'user: replay (SDKUserMessageReplay, isReplay)',
      anchor: 'src/QueryEngine.ts:795-807 (queued-command ack replay)',
      reach: 'app-seam',
      expectRows: 0,
      message: {
        type: 'user',
        message: { role: 'user', content: 'also check the tests' },
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
  ],

  /* ── system — SDKSystemMessage + SDKCompactBoundaryMessage +
   *             SDKAccountDiagnosticMessage (one discriminant, 3 members) ──
   * One sample per subtype in the type union (coreTypes.generated.ts:173-189)
   * + the runtime schema's required fields (coreSchemas.ts per-subtype). */
  system: [
    {
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
      expectRows: 0,
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
      anchor: 'src/QueryEngine.ts:1001-1013',
      reach: 'app-seam',
      expectRows: 0,
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
      expectRows: 0,
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
        requested_model: 'gpt-5.5',
        resolved_provider: 'openai',
        resolved_model: 'gpt-5.5',
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
      expectRows: 0,
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
      expectRows: 0,
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
      expectRows: 0,
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
  expectFinalRows: 1,
  messages: [
    {
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg_01S1Text' } },
      uuid: '00000000-0000-4000-8000-00000000s101',
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      uuid: '00000000-0000-4000-8000-00000000s102',
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Streaming preview' },
      },
      uuid: '00000000-0000-4000-8000-00000000s103',
    },
    {
      type: 'assistant',
      message: {
        id: 'msg_01S1Text',
        role: 'assistant',
        content: [{ type: 'text', text: 'Streaming preview final.' }],
        stop_reason: null,
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: '00000000-0000-4000-8000-00000000s104',
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
      uuid: '00000000-0000-4000-8000-00000000s105',
    },
    {
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 12 },
      },
      uuid: '00000000-0000-4000-8000-00000000s106',
    },
    {
      type: 'stream_event',
      event: { type: 'message_stop' },
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
