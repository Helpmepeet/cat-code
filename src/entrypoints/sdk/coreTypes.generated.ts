import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { UUID } from 'crypto'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'

export type ExitReason =
  | 'clear'
  | 'resume'
  | 'logout'
  | 'prompt_input_exit'
  | 'other'
  | 'bypass_permissions_disabled'

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'StopFailure'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'Setup'
  | 'TeammateIdle'
  | 'TaskCreated'
  | 'TaskCompleted'
  | 'Elicitation'
  | 'ElicitationResult'
  | 'ConfigChange'
  | 'WorktreeCreate'
  | 'WorktreeRemove'
  | 'InstructionsLoaded'
  | 'CwdChanged'
  | 'FileChanged'

export type ModelUsage = {
  costUSD?: number
  inputTokens?: number
  outputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  [key: string]: number | undefined
}

export type SDKStatus = 'compacting' | string | null

export type SDKAccountDiagnosticCode =
  | 'account.route.selected'
  | 'account.failover.succeeded'
  | 'account.transient_failure'
  | 'account.token_refresh.failed'
  | 'account.identity_mismatch'
  | 'account.manual_switch'
  | 'account.active.reroll'
  | 'account.lease.failover'
  | 'account.usage.cap'
  | 'account.usage.uncap'
  | 'account.usage.warning'
  | 'account.retry.exhausted'
  | 'account.pool.unavailable'
  | 'quota.exhausted'
  | 'auth.missing'
  | 'model.provider_mismatch'

export type SDKAccountDiagnosticSeverity = 'info' | 'warning' | 'error'

export type SDKAccountDiagnosticProvider = 'openai' | 'anthropic' | 'unknown'

export type SDKBaseMessage = {
  type: string
  subtype?: string
  uuid?: string
  session_id?: string
  [key: string]: unknown
}

export type SDKAssistantErrorCode =
  | 'authentication_failed'
  | 'billing_error'
  | 'rate_limit'
  | 'invalid_request'
  | 'server_error'
  | 'unknown'
  | 'max_output_tokens'

export type SDKAssistantMessage = SDKBaseMessage & {
  type: 'assistant'
  message: {
    id?: string
    model?: string
    role?: 'assistant'
    content: unknown[]
    [key: string]: unknown
  }
  parent_tool_use_id?: string | null
  agent_name?: string
  error?: SDKAssistantErrorCode
  requestId?: string | null
  timestamp?: string
}

export type SDKAssistantMessageError = SDKBaseMessage & {
  type: 'assistant_error'
  message?: string
  request_id?: string
  status?: number
  error?: string
  details?: unknown
}

export type SDKPartialAssistantMessage = SDKBaseMessage & {
  type: 'stream_event'
  event?: unknown
  parent_tool_use_id?: string | null
  session_id?: string
  uuid?: UUID
}

export type SDKResultMessage = SDKBaseMessage & {
  type: 'result'
  subtype?: 'success' | 'interrupted' | 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries' | 'error_auth_required'
  is_error?: boolean
  result?: string
  errors?: string[]
  duration_ms?: number
  duration_api_ms?: number
  total_cost_usd?: number
  num_turns?: number
  stop_reason?: string | null
  usage?: unknown
  modelUsage?: Record<string, ModelUsage>
  permission_denials?: Array<{
    tool_name: string
    tool_use_id: string
    tool_input: Record<string, unknown>
  }>
  fast_mode_state?: unknown
}

export type SDKResultSuccess = SDKBaseMessage & {
  type: 'result'
  subtype: 'success'
  duration_ms: number
  duration_api_ms: number
  is_error: boolean
  num_turns: number
  result: string
  stop_reason: string | null
  total_cost_usd: number
  usage: unknown
  modelUsage: Record<string, ModelUsage>
  permission_denials: Array<{
    tool_name: string
    tool_use_id: string
    tool_input: Record<string, unknown>
  }>
  structured_output?: unknown
  fast_mode_state?: unknown
  uuid: string
  session_id: string
}

export type SDKStatusMessage = SDKBaseMessage & {
  type: 'status'
  status: SDKStatus
}

export type SDKSystemMessage = SDKBaseMessage & {
  type: 'system'
  subtype?:
    | 'init'
    | 'status'
    | 'compact_boundary'
    | 'post_turn_summary'
    | 'api_retry'
    | 'local_command_output'
    | 'hook_started'
    | 'hook_progress'
    | 'hook_response'
    | 'files_persisted'
    | 'task_notification'
    | 'task_started'
    | 'task_progress'
    | 'session_state_changed'
    | 'elicitation_complete'
    | 'cat_code_account_diagnostic'
  content?: string
  model?: string
  status?: SDKStatus
  compact_metadata?: {
    trigger: 'manual' | 'auto'
    pre_tokens: number
    messages_summarized?: number
    preserved_segment?: {
      head_uuid: string
      anchor_uuid: string
      tail_uuid: string
    }
  }
  permissionMode?: PermissionMode
  tool_use_id?: string
  task_id?: string
  description?: string
  summary?: string
  usage?: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  output_file?: string
  files?: Array<{ filename: string; file_id: string }>
  failed?: Array<{ filename: string; error: string }>
  processed_at?: string
  state?: 'idle' | 'running' | 'requires_action'
  error?: SDKAssistantErrorCode | SDKAssistantMessageError
  error_status?: number | null
  attempt?: number
  max_retries?: number
  retry_delay_ms?: number
  hook_id?: string
  hook_name?: string
  hook_event?: string
  stdout?: string
  stderr?: string
  output?: string
  exit_code?: number
  outcome?: 'success' | 'error' | 'cancelled'
  mcp_server_name?: string
  elicitation_id?: string
}

export type SDKCompactBoundaryMessage = SDKSystemMessage & {
  subtype: 'compact_boundary' | 'microcompact_boundary'
}

export type SDKAccountDiagnosticMessage = SDKSystemMessage & {
  subtype: 'cat_code_account_diagnostic'
  version: 1
  code: SDKAccountDiagnosticCode
  severity: SDKAccountDiagnosticSeverity
  provider: SDKAccountDiagnosticProvider
  recoverable: boolean
  pool?: string
  requested_model?: string
  resolved_provider?: SDKAccountDiagnosticProvider
  resolved_model?: string
  counts?: Record<string, number>
  from_account_ref?: string
  account_ref?: string
  reason?: string
  user_message?: string
  uuid: string
  session_id: string
}

export type SDKToolProgressMessage = SDKBaseMessage & {
  type: 'tool_progress'
  data?: Record<string, unknown>
  tool_use_id?: string
  tool_name?: string
  parent_tool_use_id?: string | null
  elapsed_time_seconds?: number
  task_id?: string
}

export type SDKPermissionDenial = SDKBaseMessage & {
  type: 'permission_denial'
  mode?: PermissionMode
  toolName?: string
}

export type SDKRateLimitInfo = {
  status?: 'allowed' | 'allowed_warning' | 'rejected'
  resetsAt?: number
  rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage'
  utilization?: number
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected'
  overageResetsAt?: number
  overageDisabledReason?:
    | 'overage_not_provisioned'
    | 'org_level_disabled'
    | 'org_level_disabled_until'
    | 'out_of_credits'
    | 'seat_tier_level_disabled'
    | 'member_level_disabled'
    | 'seat_tier_zero_credit_limit'
    | 'group_zero_credit_limit'
    | 'member_zero_credit_limit'
    | 'org_service_level_disabled'
    | 'org_service_zero_credit_limit'
    | 'no_limits_configured'
    | 'unknown'
  isUsingOverage?: boolean
  surpassedThreshold?: number
}

/**
 * Display-safe projection of the internal `MessageOrigin` (`src/types/message.ts`)
 * — see `SDKMessageOriginSchema` in coreSchemas.ts for why each member is
 * narrowed. Five of the six kinds are engine-injected turns that still carry
 * `role: 'user'`; a consumer without this discriminant renders them as the
 * operator's own message.
 */
export type SDKMessageOrigin =
  | { kind: 'human' }
  | { kind: 'interruption' }
  | {
      kind: 'task-notification'
      status?: 'completed' | 'failed' | 'killed' | 'running' | 'pending'
      summary?: string
      /** Join key back to the spawning `tool_use` block. */
      toolUseId?: string
      result?: string
      usage?: { totalTokens: number; toolUses: number; durationMs: number }
    }
  | { kind: 'coordinator' }
  | { kind: 'channel'; server: string; user?: string }
  | { kind: 'teammate'; from?: string }
  | { kind: 'deferred-continuation' }
  | { kind: 'peer'; name: string }

export type SDKUserMessage = SDKBaseMessage & {
  type: 'user'
  message?: {
    role?: 'user'
    content?: string | ContentBlockParam[]
    [key: string]: unknown
  }
  parent_tool_use_id?: string | null
  agent_name?: string
  isSynthetic?: boolean
  tool_use_result?: unknown
  tool_result_status?: 'cancelled'
  priority?: 'now' | 'next' | 'later'
  timestamp?: string
  uuid?: UUID
  /**
   * Provenance of a user-role turn. Absent = typed by the operator (also the
   * value for every emitter that predates the field), so consumers that ignore
   * it keep their current behaviour. A present non-human kind means the ENGINE
   * injected this turn and it must not be attributed to the operator.
   */
  origin?: SDKMessageOrigin
}

export type SDKUserMessageReplay = SDKUserMessage & {
  isReplay?: boolean
}

export type SDKSessionInfo = {
  sessionId: string
  summary?: string
  cwd?: string
  createdAt?: string
  updatedAt?: string
}

export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg'

export type PermissionRuleValue = {
  toolName: string
  ruleContent?: string
}

export type PermissionUpdate =
  | {
      type: 'addRules' | 'replaceRules' | 'removeRules'
      rules: PermissionRuleValue[]
      behavior: 'allow' | 'deny' | 'ask'
      destination: PermissionUpdateDestination
    }
  | {
      type: 'setMode'
      mode: PermissionMode
      destination: PermissionUpdateDestination
    }
  | {
      type: 'addDirectories' | 'removeDirectories'
      directories: string[]
      destination: PermissionUpdateDestination
    }

export type PermissionResult =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: PermissionUpdate[]
      toolUseID?: string
      decisionClassification?: 'user_temporary' | 'user_permanent' | 'user_reject'
    }
  | {
      behavior: 'deny'
      message?: string
      interrupt?: boolean
      toolUseID?: string
      decisionClassification?: 'user_temporary' | 'user_permanent' | 'user_reject'
    }

export type HookInput = {
  session_id?: string
  event?: HookEvent
  [key: string]: unknown
}

export type HookJSONOutput = {
  continue?: boolean
  stopReason?: string
  message?: string
  decision?: 'allow' | 'deny' | 'ask'
  [key: string]: unknown
}

export type SyncHookJSONOutput = HookJSONOutput

export type AsyncHookJSONOutput = HookJSONOutput & {
  waitMs?: number
}

export type ModelInfo = {
  value: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: Array<'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'>
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
  supportsAutoMode?: boolean
}

export type McpSdkServerConfig = {
  type: 'sdk'
  name: string
  [key: string]: unknown
}

export type McpServerConfigForProcessTransport =
  | McpSdkServerConfig
  | {
      type: string
      [key: string]: unknown
    }

export type McpServerStatus = {
  name: string
  status?: string
  config?: McpServerConfigForProcessTransport
  [key: string]: unknown
}

export type RewindFilesResult = {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

export type SDKHookCallbackMatcher = {
  matcher?: string
  hookCallbackIds: string[]
  timeout?: number
}

export type SDKControlInitializeRequest = {
  subtype: 'initialize'
  hooks?: Partial<Record<HookEvent, SDKHookCallbackMatcher[]>>
  sdkMcpServers?: string[]
  jsonSchema?: Record<string, unknown>
  systemPrompt?: string
  appendSystemPrompt?: string
  agents?: Record<string, unknown>
  promptSuggestions?: boolean
  agentProgressSummaries?: boolean
}

export type SDKControlInitializeResponse = {
  commands: unknown[]
  agents: unknown[]
  output_style: string
  available_output_styles: string[]
  models: ModelInfo[]
  account: Record<string, unknown>
  pid?: number
  fast_mode_state?: unknown
}

export type SDKControlMcpSetServersResponse = {
  added: string[]
  removed: string[]
  errors: Record<string, string>
}

export type SDKControlReloadPluginsResponse = {
  commands: unknown[]
  agents: unknown[]
  plugins: Array<{ name: string; path: string; source?: string }>
  mcpServers: McpServerStatus[]
  error_count: number
}

export type SDKControlInterruptRequest = {
  subtype: 'interrupt'
}

export type SDKControlPermissionRequest = {
  subtype: 'can_use_tool'
  tool_name: string
  input: Record<string, unknown>
  permission_suggestions?: PermissionUpdate[]
  blocked_path?: string
  decision_reason?: string
  title?: string
  display_name?: string
  tool_use_id: string
  agent_id?: string
  description?: string
}

export type SDKControlSetPermissionModeRequest = {
  subtype: 'set_permission_mode'
  mode: PermissionMode
  ultraplan?: boolean
}

export type SDKControlSetModelRequest = {
  subtype: 'set_model'
  model?: string
}

export type SDKControlSetMaxThinkingTokensRequest = {
  subtype: 'set_max_thinking_tokens'
  max_thinking_tokens: number | null
}

export type SDKControlMcpStatusRequest = {
  subtype: 'mcp_status'
}

export type SDKControlGetContextUsageRequest = {
  subtype: 'get_context_usage'
}

export type SDKHookCallbackRequest = {
  subtype: 'hook_callback'
  callback_id: string
  input: HookInput
  tool_use_id?: string
}

export type SDKControlMcpMessageRequest = {
  subtype: 'mcp_message'
  server_name: string
  message: JSONRPCMessage
}

export type SDKControlRewindFilesRequest = {
  subtype: 'rewind_files'
  user_message_id: string
  dry_run?: boolean
}

export type SDKControlCancelAsyncMessageRequest = {
  subtype: 'cancel_async_message'
  message_uuid: string
}

export type SDKControlSeedReadStateRequest = {
  subtype: 'seed_read_state'
  path: string
  mtime: number
}

export type SDKControlMcpSetServersRequest = {
  subtype: 'mcp_set_servers'
  servers: Record<string, McpSdkServerConfig | McpServerConfigForProcessTransport>
}

export type SDKControlReloadPluginsRequest = {
  subtype: 'reload_plugins'
}

export type SDKControlMcpReconnectRequest = {
  subtype: 'mcp_reconnect'
  serverName: string
}

export type SDKControlMcpToggleRequest = {
  subtype: 'mcp_toggle'
  serverName: string
  enabled: boolean
}

export type SDKControlStopTaskRequest = {
  subtype: 'stop_task'
  task_id: string
}

export type SDKControlApplyFlagSettingsRequest = {
  subtype: 'apply_flag_settings'
  settings: Record<string, unknown>
}

export type SDKControlGetSettingsRequest = {
  subtype: 'get_settings'
}

export type SDKControlElicitationRequest = {
  subtype: 'elicitation'
  mcp_server_name: string
  message: string
  mode?: 'form' | 'url'
  url?: string
  elicitation_id?: string
  requested_schema?: Record<string, unknown>
}

export type SDKControlEndSessionRequest = {
  subtype: 'end_session'
  reason?: string
  [key: string]: unknown
}

export type SDKControlMcpAuthenticateRequest = {
  subtype: 'mcp_authenticate'
  serverName: string
}

export type SDKControlMcpOauthCallbackUrlRequest = {
  subtype: 'mcp_oauth_callback_url'
  serverName: string
  callbackUrl: string
}

export type SDKControlClaudeAuthenticateRequest = {
  subtype: 'claude_authenticate'
  loginWithClaudeAi?: boolean
}

export type SDKControlClaudeOauthCallbackRequest = {
  subtype: 'claude_oauth_callback'
  authorizationCode: string
  state: string
}

export type SDKControlClaudeOauthWaitForCompletionRequest = {
  subtype: 'claude_oauth_wait_for_completion'
}

export type SDKControlMcpClearAuthRequest = {
  subtype: 'mcp_clear_auth'
  serverName: string
}

export type SDKControlGenerateSessionTitleRequest = {
  subtype: 'generate_session_title'
  description: string
  persist?: boolean
}

export type SDKControlSideQuestionRequest = {
  subtype: 'side_question'
  question: string
}

export type SDKControlSetProactiveRequest = {
  subtype: 'set_proactive'
  enabled: boolean
}

export type SDKControlRemoteControlRequest = {
  subtype: 'remote_control'
  enabled: boolean
}

export type SDKControlChannelEnableRequest = {
  subtype: 'channel_enable'
  serverName: string
}

export type SDKControlRequestInner =
  | SDKControlInterruptRequest
  | SDKControlPermissionRequest
  | SDKControlInitializeRequest
  | SDKControlSetPermissionModeRequest
  | SDKControlSetModelRequest
  | SDKControlSetMaxThinkingTokensRequest
  | SDKControlMcpStatusRequest
  | SDKControlGetContextUsageRequest
  | SDKHookCallbackRequest
  | SDKControlMcpMessageRequest
  | SDKControlRewindFilesRequest
  | SDKControlCancelAsyncMessageRequest
  | SDKControlSeedReadStateRequest
  | SDKControlMcpSetServersRequest
  | SDKControlReloadPluginsRequest
  | SDKControlMcpReconnectRequest
  | SDKControlMcpToggleRequest
  | SDKControlStopTaskRequest
  | SDKControlApplyFlagSettingsRequest
  | SDKControlGetSettingsRequest
  | SDKControlElicitationRequest
  | SDKControlEndSessionRequest
  | SDKControlMcpAuthenticateRequest
  | SDKControlMcpOauthCallbackUrlRequest
  | SDKControlClaudeAuthenticateRequest
  | SDKControlClaudeOauthCallbackRequest
  | SDKControlClaudeOauthWaitForCompletionRequest
  | SDKControlMcpClearAuthRequest
  | SDKControlGenerateSessionTitleRequest
  | SDKControlSideQuestionRequest
  | SDKControlSetProactiveRequest
  | SDKControlRemoteControlRequest
  | SDKControlChannelEnableRequest

export type SDKControlRequest = {
  type: 'control_request'
  request_id: string
  request: SDKControlRequestInner
}

export type SDKControlResponse = {
  type: 'control_response'
  response:
    | { subtype: 'success'; request_id: string; response?: Record<string, unknown> }
    | {
        subtype: 'error'
        request_id: string
        error: string
        pending_permission_requests?: SDKControlRequest[]
      }
}

export type SDKAuthStatusMessage = SDKBaseMessage & {
  type: 'auth_status'
  isAuthenticating?: boolean
  output?: string[]
  error?: string
}

export type SDKRateLimitEventMessage = SDKBaseMessage & {
  type: 'rate_limit_event'
  rate_limit_info: SDKRateLimitInfo
}

export type SDKToolUseSummaryMessage = SDKBaseMessage & {
  type: 'tool_use_summary'
  summary: string
  preceding_tool_use_ids: string[]
}

export type SDKPromptSuggestionMessage = SDKBaseMessage & {
  type: 'prompt_suggestion'
  suggestion: string
}

export type SDKStreamlinedTextMessage = SDKBaseMessage & {
  type: 'streamlined_text'
  text: string
}

export type SDKStreamlinedToolUseSummaryMessage = SDKBaseMessage & {
  type: 'streamlined_tool_use_summary'
  tool_summary: string
}

export type SDKUpdateEnvironmentVariablesMessage = {
  type: 'update_environment_variables'
  variables: Record<string, string>
}

export type StdinMessage =
  | SDKUserMessage
  | SDKControlRequest
  | SDKControlResponse
  | { type: 'keep_alive' }
  | SDKUpdateEnvironmentVariablesMessage

export type StdoutMessage =
  | SDKMessage
  | SDKStreamlinedTextMessage
  | SDKStreamlinedToolUseSummaryMessage
  | SDKControlRequest
  | SDKControlResponse
  | { type: 'control_cancel_request'; request_id: string }
  | { type: 'keep_alive' }

export type SDKMessage =
  | SDKAssistantMessage
  | SDKAssistantMessageError
  | SDKCompactBoundaryMessage
  | SDKPartialAssistantMessage
  | SDKPermissionDenial
  | SDKResultMessage
  | SDKResultSuccess
  | SDKStatusMessage
  | SDKAccountDiagnosticMessage
  | SDKSystemMessage
  | SDKToolProgressMessage
  | SDKUserMessage
  | SDKUserMessageReplay
  | SDKAuthStatusMessage
  | SDKRateLimitEventMessage
  | SDKToolUseSummaryMessage
  | SDKPromptSuggestionMessage
  | SDKStreamlinedTextMessage
  | SDKStreamlinedToolUseSummaryMessage
