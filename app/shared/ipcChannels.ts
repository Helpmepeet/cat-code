/**
 * The fixed internal Electron IPC channel names, declared once for both ends.
 *
 * These are the whole renderer-to-main vocabulary (SECURITY-MINIMUM HC3). Every
 * name is a compile-time literal the renderer can neither see nor supply: the
 * preload exposes fixed per-method senders over them, and main listens on the
 * same names. That correspondence is the reason this file exists — the two
 * lists were previously hand-copied, so a one-character drift in either file
 * sent a renderer verb to a channel nobody listened on, with no error anywhere.
 * Importing the same identifier at both ends makes that a compile error.
 *
 * Adding a name here exposes nothing on its own: the preload's bridge is a
 * closed allowlist of methods, and main only handles a channel it registers.
 *
 * The dev-only debug-state channel is deliberately NOT here. It lives in
 * `debugState.ts` for main and as a literal inside the preload's
 * `__CATCODE_DEV_HARNESS__` block, so the packaged preload bundle carries no
 * `catcode:debug:` string at all (`preloadBundle.test.ts`).
 */

// --- Frame plane: renderer intents relayed to the session's sidecar, plus the
// window-local telemetry and appearance senders that terminate in main. ---
export const CH_SUBMIT = 'catcode:submit'
export const CH_ABORT = 'catcode:abort'
export const CH_PERMISSION = 'catcode:permission'
export const CH_ANSWER_QUESTIONS = 'catcode:answer-questions'
export const CH_SET_MODE = 'catcode:set-mode'
export const CH_ACCOUNT_VERB = 'catcode:account-verb'
export const CH_WORKSPACE_TRUST_VERB = 'catcode:workspace-trust-verb'
export const CH_TASK_CONTROL_VERB = 'catcode:task-control-verb'
export const CH_RUN_CONTROL_VERB = 'catcode:run-control-verb'
export const CH_PROMPT_FORCE = 'catcode:prompt-force'
export const CH_PROMPT_RECALL = 'catcode:prompt-recall'
export const CH_CONTEXT_BREAKDOWN_VERB = 'catcode:context-breakdown-verb'
export const CH_HISTORY_LOAD_EARLIER = 'catcode:history-load-earlier'
export const CH_SESSION_ACTION_VERB = 'catcode:session-action-verb'
export const CH_REMOTE_SETTINGS_VERB = 'catcode:remote-settings-verb'
export const CH_SETTINGS_VERB = 'catcode:settings-verb'
export const CH_STATS_QUERY = 'catcode:stats-query'
export const CH_PING = 'catcode:ping'
export const CH_RESTART = 'catcode:restart'
export const CH_SERVER_FRAME = 'catcode:server-frame'
export const CH_RENDERER_READY = 'catcode:renderer-ready'
export const CH_DELIVERY_ACK = 'catcode:delivery-ack'
export const CH_RENDERER_FAULT = 'catcode:renderer-fault'
export const CH_SET_APPEARANCE = 'catcode:set-appearance'
export const CH_SET_GLASS_MODE = 'catcode:set-glass-mode'
export const CH_OPEN_LOGS = 'catcode:open-logs'
export const CH_SAVE_DIAGNOSTICS = 'catcode:save-diagnostics'
export const CH_DELIVERY_HEALTH_PROBE = 'catcode:delivery-health-probe'
export const CH_DELIVERY_HEALTH_RESPONSE = 'catcode:delivery-health-response'
export const CH_REFRESH_ACCOUNTS_POOL = 'catcode:refresh-accounts-pool'

// --- Control plane (HC3 — fixed, per-method structured senders). `invoke`
// channels return a typed HostResult; `pick-directory` returns a one-time
// cwdToken or null (the native picker, HC1); the host-event channel is a
// one-way stream. ---
export const CH_HOST_CREATE = 'catcode:host:create'
export const CH_HOST_CREATE_IN_WORKSPACE = 'catcode:host:create-in-workspace'
export const CH_HOST_RESTORE = 'catcode:host:restore'
export const CH_HOST_CLOSE = 'catcode:host:close'
// PEER-SESSIONS §6 — the user's "don't let peers reopen this session" decision.
// Renderer-facing only: no frame carries it and no peer can clear it.
export const CH_HOST_SET_PEER_WAKE_BLOCKED = 'catcode:host:set-peer-wake-blocked'
export const CH_HOST_LIST = 'catcode:host:list'
export const CH_HOST_PICK_DIR = 'catcode:host:pick-directory'
export const CH_HOST_PICK_ATTACHMENT_FILE = 'catcode:host:pick-attachment-file'
export const CH_HOST_PREVIEW = 'catcode:host:preview'
export const CH_HOST_SESSIONS_CATALOG = 'catcode:host:sessions-catalog'
export const CH_HOST_OPEN_HISTORY = 'catcode:host:open-history'
// P4-35 — the file sink. Mirrors `pick-directory`: the renderer REQUESTS a
// native dialog it cannot answer, and main owns the destination (HC1).
export const CH_HOST_SAVE_TEXT = 'catcode:host:save-text'
export const CH_HOST_OPEN_WORKSPACE_FILE = 'catcode:host:open-workspace-file'
export const CH_HOST_ACCOUNT_DELETE = 'catcode:host:account-delete'
export const CH_HOST_EVENT = 'catcode:host:event'
export const CH_HOST_VISIBLE_SESSIONS = 'catcode:host:visible-sessions'
