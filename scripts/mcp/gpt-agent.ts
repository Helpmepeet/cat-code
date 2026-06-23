#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const CLI = process.env.CAT_CODE_CLI ?? '/Users/pt/cat-code/cli-dev'
const SUPPORTED_MODELS = ['gpt-5.5', 'gpt-5.4-mini'] as const
type Model = (typeof SUPPORTED_MODELS)[number]
const DEFAULT_MODEL: Model = 'gpt-5.5'

const STORE = process.env.GPT_AGENT_STORE ?? `${process.env.HOME}/.cat-code/mcp/conversations.json`
const JOBS_DIR = process.env.GPT_AGENT_BACKGROUND_DIR ?? `${process.env.HOME}/.cat-code/mcp/jobs`
const WORKER_PROMPT_FILE = process.env.GPT_AGENT_PROMPT ?? `${process.env.HOME}/.cat-code/mcp/worker-prompt.md`
const CONFIG_HOME = (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.cat-code')).normalize('NFC')
const AUDIT_LOG = process.env.GPT_AGENT_AUDIT_LOG ?? join(CONFIG_HOME, 'mcp', 'audit.jsonl')
const MAX_CAPTURE_BYTES = 1024 * 1024
const MAX_RESULT_CHARS = 80_000
const LOCK_RETRY_MS = 50
const MAX_SANITIZED_LENGTH = 200

function positiveEnvMs(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  return parsed
}

const CHILD_TIMEOUT_MS = positiveEnvMs('GPT_AGENT_TIMEOUT_MS', 1_800_000)
const KILL_GRACE_MS = positiveEnvMs('GPT_AGENT_KILL_GRACE_MS', 5_000)
const CONVERSATION_LOCK_MAX_AGE_MS = CHILD_TIMEOUT_MS + KILL_GRACE_MS + 60_000
const STORE_LOCK_MAX_AGE_MS = 30_000
const JOB_WAIT_DEFAULT_MS = 30_000
const JOB_WAIT_MAX_MS = 600_000
const JOB_WAIT_POLL_MS = 200

type RpcId = string | number | null
type JsonObject = Record<string, unknown>
type StoreEntry = { sessionId: string; model?: Model }
type ConversationStore = Record<string, StoreEntry>
type LockRecord = { pid: number; token: string; createdAt: number }
type PendingCommit = { conversation: string; entry: { sessionId: string; model: Model }; createdAt: number }
type AgentResult = { text: string; sessionId: string; isError: boolean; name?: string }
type AgentRunResult = AgentResult & { model: Model; process?: ChildProcessSummary }
type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelling' | 'cancelled'
type JobRequest = { args: ValidatedArguments; cwd: string; createdAt: string; audit?: AuditContext }
type JobRecord = {
  jobId: string
  status: JobStatus
  createdAt: string
  updatedAt: string
  cwd: string
  workerPid?: number
  conversation?: string
  description?: string
  sessionId?: string
  isError?: boolean
  error?: string
  paths: { request: string; status: string; result: string; stdout: string; stderr: string }
}
type GptRecord = {
  name: string
  status: JobStatus
  sessionId?: string
  activeJobId?: string
  lastJobId?: string
  model: Model
  description?: string
  error?: string
  createdAt: string
  updatedAt: string
}
type ChildOutcome = {
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  code: number | null
  signal: NodeJS.Signals | null
  termination?: 'timed out' | 'cancelled'
  terminationElapsedMs?: number
  spawnError?: string
}
type ChildProcessSummary = Pick<ChildOutcome, 'code' | 'signal' | 'termination' | 'terminationElapsedMs' | 'spawnError'>
type ValidatedArguments = {
  prompt: string
  conversation?: string
  description?: string
  explicitModel?: Model
  addDirs: string[]
  resumeSession?: string
  resetConversation: boolean
  replaceExisting: boolean
  runInBackground: boolean
}
type AuditContext = { requestId: RpcId; toolUseId?: string }
type SendMessageArguments = { to: string; message: string; runInBackground: boolean }

const gptRegistry = new Map<string, GptRecord>()
let generatedGptCounter = 0

class StoreCorruptError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message)
    this.name = 'StoreCorruptError'
  }
}

class MissingJobArtifactError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MissingJobArtifactError'
  }
}

class TailBuffer {
  private bytes: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  truncated = false

  append(chunk: Buffer | string): void {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (incoming.length >= MAX_CAPTURE_BYTES) {
      this.bytes = incoming.subarray(incoming.length - MAX_CAPTURE_BYTES)
      this.truncated = true
      return
    }
    const combined = Buffer.concat([this.bytes, incoming])
    if (combined.length > MAX_CAPTURE_BYTES) {
      this.bytes = combined.subarray(combined.length - MAX_CAPTURE_BYTES)
      this.truncated = true
    } else {
      this.bytes = combined
    }
  }

  text(): string {
    return this.bytes.toString('utf8')
  }
}

function now(): string {
  return new Date().toISOString()
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isModel(value: unknown): value is Model {
  return typeof value === 'string' && (SUPPORTED_MODELS as readonly string[]).includes(value)
}

function diagnosticValue(value: unknown): string {
  try { return JSON.stringify(value) } catch { return String(value) }
}

function simpleHash(str: string): string {
  let hash = 5381
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0
  return Math.abs(hash).toString(36)
}

function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized
  const hash = typeof Bun !== 'undefined' ? Bun.hash(name).toString(36) : simpleHash(name)
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`
}

function appendAuditRecord(record: JsonObject): void {
  try {
    mkdirSync(dirname(AUDIT_LOG), { recursive: true, mode: 0o700 })
    const fd = openSync(AUDIT_LOG, 'a', 0o600)
    try {
      writeSync(fd, JSON.stringify({ timestamp: now(), ...record }) + '\n')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(AUDIT_LOG, 0o600)
  } catch {
    // Audit is best-effort; never fail the MCP tool because local logging failed.
  }
}

function auditContextFromParams(requestId: RpcId, params: unknown): AuditContext {
  const meta = isPlainObject(params) && isPlainObject(params._meta) ? params._meta : undefined
  const toolUseId = typeof meta?.['claudecode/toolUseId'] === 'string' && meta['claudecode/toolUseId'] ? meta['claudecode/toolUseId'] : undefined
  return { requestId, toolUseId }
}

function auditBase(args: ValidatedArguments, context: AuditContext, mode: 'foreground' | 'background', jobId?: string, cwd = process.cwd()): JsonObject {
  return {
    mcp_tool: SPAWN_TOOL.name,
    mcp_request_id: context.requestId,
    mcp_tool_use_id: context.toolUseId,
    job_id: jobId,
    mode,
    status: mode === 'background' ? 'queued' : 'running',
    cwd,
    conversation: args.conversation,
    resume_session_id: args.resumeSession,
    model: args.explicitModel ?? DEFAULT_MODEL,
    run_in_background: args.runInBackground,
    timeout_ms: CHILD_TIMEOUT_MS,
    kill_grace_ms: KILL_GRACE_MS,
  }
}

function childProcessSummary(outcome: ChildOutcome): ChildProcessSummary {
  return {
    code: outcome.code,
    signal: outcome.signal,
    termination: outcome.termination,
    terminationElapsedMs: outcome.terminationElapsedMs,
    spawnError: outcome.spawnError,
  }
}

function sessionTranscriptPath(sessionId: string, cwd: string): string {
  return join(CONFIG_HOME, 'projects', sanitizePath(cwd), `${sessionId}.jsonl`)
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readSessionAuditSummary(sessionId: string, cwd: string): JsonObject {
  const transcriptPath = sessionTranscriptPath(sessionId, cwd)
  const summary: JsonObject = { session_jsonl: transcriptPath }
  if (!existsSync(transcriptPath)) return summary

  let accountIdPrefix: string | undefined
  let model: string | undefined
  let effort: string | undefined
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  let cachedTokens: number | undefined

  for (const line of readLimited(transcriptPath, 1024 * 1024).trim().split('\n')) {
    if (!line) continue
    let entry: unknown
    try { entry = JSON.parse(line) } catch { continue }
    if (!isPlainObject(entry) || entry.type !== 'system') continue
    if (entry.subtype === 'codex_send_path') {
      if (typeof entry.account_id_prefix === 'string') accountIdPrefix = entry.account_id_prefix
      if (typeof entry.effort === 'string') effort = entry.effort
      inputTokens = numberValue(entry.input_tokens) ?? inputTokens
      cachedTokens = numberValue(entry.cached_tokens) ?? cachedTokens
    } else if (entry.subtype === 'codex_stream_surface') {
      if (typeof entry.account_id_prefix === 'string') accountIdPrefix = entry.account_id_prefix
      if (typeof entry.model === 'string') model = entry.model
      inputTokens = numberValue(entry.input_tokens) ?? inputTokens
      outputTokens = numberValue(entry.output_tokens) ?? outputTokens
      cachedTokens = numberValue(entry.cached_tokens) ?? cachedTokens
    }
  }

  const tokenSummary: JsonObject = {}
  if (inputTokens !== undefined) tokenSummary.input_tokens = inputTokens
  if (outputTokens !== undefined) tokenSummary.output_tokens = outputTokens
  if (cachedTokens !== undefined) tokenSummary.cached_tokens = cachedTokens
  if (accountIdPrefix) summary.account_id_prefix = accountIdPrefix
  if (model) summary.model = model
  if (effort) summary.effort = effort
  if (Object.keys(tokenSummary).length > 0) summary.token_summary = tokenSummary
  return summary
}

function auditStatus(result: AgentRunResult, status?: JobStatus): string {
  if (result.process?.termination === 'timed out') return 'timed_out'
  if (status) return status
  if (result.process?.termination === 'cancelled') return 'cancelled'
  return result.isError ? 'failed' : 'completed'
}

function appendTerminalAudit(args: ValidatedArguments, context: AuditContext, mode: 'foreground' | 'background', startedAtMs: number, result: AgentRunResult, jobId?: string, status?: JobStatus, cwd = process.cwd()): void {
  const transcriptSummary = result.sessionId ? readSessionAuditSummary(result.sessionId, cwd) : {}
  appendAuditRecord({
    ...auditBase(args, context, mode, jobId, cwd),
    ...transcriptSummary,
    event: 'terminal',
    status: auditStatus(result, status),
    duration_ms: Date.now() - startedAtMs,
    session_id: result.sessionId || undefined,
    model: typeof transcriptSummary.model === 'string' ? transcriptSummary.model : result.model,
    is_error: result.isError,
    process: result.process,
  })
}

function loadWorkerPrompt(): string | undefined {
  try {
    return existsSync(WORKER_PROMPT_FILE) ? readFileSync(WORKER_PROMPT_FILE, 'utf8').trim() || undefined : undefined
  } catch {
    return undefined
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${process.pid}.${randomUUID()}.tmp`)
  const data = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    let offset = 0
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd) } catch {}
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function parseStore(raw: string): ConversationStore {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new StoreCorruptError('conversation store contains invalid JSON', cause instanceof Error ? cause.message : String(cause))
  }
  if (!isPlainObject(parsed)) throw new StoreCorruptError('conversation store root must be an object', 'root is not an object')

  const store: ConversationStore = {}
  for (const [conversation, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && value.length > 0) {
      store[conversation] = { sessionId: value }
      continue
    }
    if (!isPlainObject(value) || typeof value.sessionId !== 'string' || value.sessionId.length === 0) {
      throw new StoreCorruptError(`invalid record for conversation ${JSON.stringify(conversation)}`, 'record must contain a non-empty sessionId')
    }
    if (value.model !== undefined && !isModel(value.model)) {
      throw new StoreCorruptError(`invalid model for conversation ${JSON.stringify(conversation)}`, `unsupported stored model ${JSON.stringify(value.model)}`)
    }
    store[conversation] = { sessionId: value.sessionId, model: value.model as Model | undefined }
  }
  return store
}

function readStoreUnlocked(): ConversationStore {
  if (!existsSync(STORE)) return {}
  return parseStore(readFileSync(STORE, 'utf8'))
}

function readLockRecord(path: string): LockRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isPlainObject(parsed) || typeof parsed.pid !== 'number' || typeof parsed.token !== 'string' || typeof parsed.createdAt !== 'number') return undefined
    return { pid: parsed.pid, token: parsed.token, createdAt: parsed.createdAt }
  } catch {
    return undefined
  }
}

function shouldBreakStaleLock(path: string, maxAgeMs: number): boolean {
  let ageFromMtime = 0
  try { ageFromMtime = Date.now() - statSync(path).mtimeMs } catch { return false }
  const record = readLockRecord(path)
  if (!record) return ageFromMtime > maxAgeMs
  const age = Math.max(ageFromMtime, Date.now() - record.createdAt)
  return !pidIsAlive(record.pid) || age > maxAgeMs
}

function breakStaleLock(path: string, expectedContents: string): boolean {
  try {
    if (readFileSync(path, 'utf8') !== expectedContents) return false
    unlinkSync(path)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason
  return new Error(typeof reason === 'string' && reason ? reason : 'request cancelled')
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      signal?.removeEventListener('abort', cancelled)
      resolve()
    }
    function cancelled(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancelled)
      reject(abortError(signal))
    }
    signal?.addEventListener('abort', cancelled, { once: true })
  })
}

async function acquireLock(path: string, maxAgeMs: number, signal?: AbortSignal): Promise<() => void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const record: LockRecord = { pid: process.pid, token: randomUUID(), createdAt: Date.now() }
  const contents = JSON.stringify(record)

  while (true) {
    if (signal?.aborted) throw abortError(signal)
    try {
      const fd = openSync(path, 'wx', 0o600)
      try {
        writeSync(fd, contents)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      let released = false
      return () => {
        if (released) return
        released = true
        try {
          const current = readLockRecord(path)
          if (current?.token === record.token) unlinkSync(path)
        } catch {}
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (shouldBreakStaleLock(path, maxAgeMs)) {
        let expected = ''
        try { expected = readFileSync(path, 'utf8') } catch {}
        if (expected && breakStaleLock(path, expected)) continue
      }
      await wait(LOCK_RETRY_MS, signal)
    }
  }
}

const storeLockPath = `${STORE}.lock`
const lockDirectory = `${STORE}.locks`

function conversationLockPath(conversation: string): string {
  return join(lockDirectory, `conversation-${encodeURIComponent(conversation)}.lock`)
}

function pendingCommitPath(conversation: string): string {
  return join(lockDirectory, `pending-${encodeURIComponent(conversation)}.json`)
}

async function withStoreLock<T>(operation: () => T): Promise<T> {
  const release = await acquireLock(storeLockPath, STORE_LOCK_MAX_AGE_MS)
  try { return operation() } finally { release() }
}

async function quarantineCorruptStore(): Promise<string> {
  return withStoreLock(() => {
    try {
      readStoreUnlocked()
      return ''
    } catch (error) {
      if (!(error instanceof StoreCorruptError)) throw error
      throw quarantineCorruptStoreUnlocked(error)
    }
  })
}

function quarantineCorruptStoreUnlocked(error: StoreCorruptError): Error {
  const backup = `${STORE}.corrupt.${new Date().toISOString().replaceAll(':', '-')}.${process.pid}`
  renameSync(STORE, backup)
  chmodSync(backup, 0o600)
  return new Error(`conversation store was corrupt and was moved to ${backup}: ${error.message} (${error.reason})`)
}

function writePendingCommit(path: string, commit: PendingCommit): void {
  atomicWriteJson(path, commit)
}

async function flushPendingCommit(path: string): Promise<void> {
  await withStoreLock(() => {
    if (!existsSync(path)) return
    let commit: PendingCommit
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (!isPlainObject(parsed) || typeof parsed.conversation !== 'string' || !isPlainObject(parsed.entry) || typeof parsed.entry.sessionId !== 'string' || !isModel(parsed.entry.model)) {
        throw new Error('invalid pending conversation commit')
      }
      commit = {
        conversation: parsed.conversation,
        entry: { sessionId: parsed.entry.sessionId, model: parsed.entry.model },
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
      }
    } catch (error) {
      throw new Error(`cannot read pending conversation commit ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    let store: ConversationStore
    try {
      store = readStoreUnlocked()
    } catch (error) {
      if (error instanceof StoreCorruptError) throw quarantineCorruptStoreUnlocked(error)
      throw error
    }
    store[commit.conversation] = commit.entry
    atomicWriteJson(STORE, Object.fromEntries(Object.entries(store).map(([name, entry]) => [name, { sessionId: entry.sessionId, model: entry.model ?? DEFAULT_MODEL }])))
    unlinkSync(path)
  })
}

function send(message: JsonObject): void {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function sendResult(id: RpcId, value: unknown): void {
  send({ jsonrpc: '2.0', id, result: value })
}

function sendError(id: RpcId, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function isTerminalStatus(status: JobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

const SPAWN_TOOL = {
  name: 'spawn_gpt_agent',
  description:
    'Create a named GPT (cat-code on a Codex/ChatGPT account). Cost is billed to the Codex subscription pool, NOT your Claude usage. The GPT runs cat-code headless in the current working directory and has no access to your conversation.\n\n' +
    'This tool creates a new named GPT. Names are unique in the current MCP server process; if a name already exists, use send_gpt_agent_message to continue that GPT or choose a different name. With `run_in_background: true`, the GPT works in a detached job and can be continued after it finishes.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The self-contained first task/message for the GPT.' },
      name: { type: 'string', description: 'Optional unique visible name for the GPT. If omitted, a simple name such as "GPT 1" is generated.' },
      description: { type: 'string', description: 'Optional short display label shown in list/status output. It is not used as the GPT name.' },
      model: { type: 'string', enum: SUPPORTED_MODELS, description: `Codex model slug. Default ${DEFAULT_MODEL}.`, default: DEFAULT_MODEL },
      add_dirs: { type: 'array', items: { type: 'string' }, description: 'Existing directories outside cwd the agent may access. Leading ~ is expanded to the user home directory.' },
      replace_existing: { type: 'boolean', description: 'Replace an existing terminal/non-running named GPT with a fresh session. Busy GPTs cannot be replaced.', default: false },
      run_in_background: { type: 'boolean', description: 'Start the GPT in a detached job and return immediately. Send follow-ups after it finishes with send_gpt_agent_message.', default: false },
    },
    required: ['prompt'],
  },
}

const JOB_ID_SCHEMA = { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] }
const SEND_GPT_MESSAGE_TOOL = {
  name: 'send_gpt_agent_message',
  description: 'Send a follow-up message to an existing named GPT after it finishes its current work.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'The visible name of the GPT to message.' },
      message: { type: 'string', description: 'The follow-up message for that GPT.' },
      run_in_background: { type: 'boolean', description: 'Run the follow-up as a detached job. Defaults to false.', default: false },
    },
    required: ['to', 'message'],
  },
}
const LIST_GPT_AGENTS_TOOL = {
  name: 'list_gpt_agents',
  description: 'List named GPTs known in this MCP server process.',
  inputSchema: { type: 'object', properties: {} },
}
const WAIT_JOB_SCHEMA = {
  type: 'object',
  properties: {
    job_id: { type: 'string' },
    timeout_ms: { type: 'number', default: JOB_WAIT_DEFAULT_MS, description: `Maximum time to wait, capped at ${JOB_WAIT_MAX_MS}ms.` },
  },
  required: ['job_id'],
}
const NORMAL_TOOLS = [
  SPAWN_TOOL,
  SEND_GPT_MESSAGE_TOOL,
  LIST_GPT_AGENTS_TOOL,
]
const DEBUG_TOOLS = [
  { name: 'get_gpt_agent_job_status', description: 'Return status and artifact paths for a detached GPT job.', inputSchema: JOB_ID_SCHEMA },
  { name: 'get_gpt_agent_job_result', description: 'Return status, ready, is_error, has_result, and text for a detached GPT job.', inputSchema: JOB_ID_SCHEMA },
  { name: 'wait_for_gpt_agent_job', description: 'Wait briefly for a detached GPT job, then return the same fields as get_gpt_agent_job_result.', inputSchema: WAIT_JOB_SCHEMA },
  {
    name: 'tail_gpt_agent_job_log',
    description: 'Return the tail of a detached GPT job stdout or stderr log.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' }, stream: { type: 'string', enum: ['stdout', 'stderr'], default: 'stdout' }, lines: { type: 'number', default: 80 } },
      required: ['job_id'],
    },
  },
  { name: 'cancel_gpt_agent_job', description: 'Request cancellation of a running detached GPT job.', inputSchema: JOB_ID_SCHEMA },
  { name: 'list_gpt_agent_jobs', description: 'List known detached GPT jobs.', inputSchema: { type: 'object', properties: {} } },
  { name: 'cleanup_gpt_agent_job', description: 'Delete artifacts for a completed, failed, or cancelled detached GPT job.', inputSchema: JOB_ID_SCHEMA },
]
const DEBUG_TOOLS_ENABLED = process.env.GPT_AGENT_DEBUG_TOOLS === '1'
const DEBUG_TOOL_NAMES = new Set(DEBUG_TOOLS.map(tool => tool.name))
const TOOLS = DEBUG_TOOLS_ENABLED ? [...NORMAL_TOOLS, ...DEBUG_TOOLS] : NORMAL_TOOLS

function runCatCode(args: { prompt: string; model: Model; addDirs: string[]; resume?: string; signal: AbortSignal; logs?: { stdout: string; stderr: string } }): Promise<ChildOutcome> {
  const argv = ['--model', args.model, '-p', args.prompt, '--output-format', 'json', '--permission-mode', 'auto', '--debug-to-stderr']
  const workerPrompt = loadWorkerPrompt()
  if (workerPrompt) argv.push('--append-system-prompt', workerPrompt)
  if (args.resume) argv.push('--resume', args.resume)
  for (const directory of args.addDirs) argv.push('--add-dir', directory)

  return new Promise(resolve => {
    const stdout = new TailBuffer()
    const stderr = new TailBuffer()
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(CLI, argv, { cwd: process.cwd(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, code: null, signal: null, spawnError: error instanceof Error ? error.message : String(error) })
      return
    }

    let settled = false
    const startedAtMs = Date.now()
    let termination: ChildOutcome['termination']
    let terminationElapsedMs: number | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const killChild = (signal: NodeJS.Signals): void => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal)
          return
        } catch {}
      }
      try { child.kill(signal) } catch {}
    }
    const terminate = (why: NonNullable<ChildOutcome['termination']>): void => {
      if (settled || termination) return
      termination = why
      terminationElapsedMs = Date.now() - startedAtMs
      killChild('SIGTERM')
      killTimer = setTimeout(() => { if (!settled) killChild('SIGKILL') }, KILL_GRACE_MS)
    }

    const timeout = setTimeout(() => terminate('timed out'), CHILD_TIMEOUT_MS)
    const cancelled = (): void => terminate('cancelled')
    args.signal.addEventListener('abort', cancelled, { once: true })
    if (args.signal.aborted) cancelled()

    child.stdout?.on('data', chunk => {
      stdout.append(chunk)
      if (args.logs) appendFileSync(args.logs.stdout, chunk)
    })
    child.stderr?.on('data', chunk => {
      stderr.append(chunk)
      if (args.logs) appendFileSync(args.logs.stderr, chunk)
    })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      args.signal.removeEventListener('abort', cancelled)
      resolve({ stdout: stdout.text(), stderr: stderr.text(), stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated, code: null, signal: null, termination, terminationElapsedMs, spawnError: error.message })
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      args.signal.removeEventListener('abort', cancelled)
      resolve({ stdout: stdout.text(), stderr: stderr.text(), stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated, code, signal, termination, terminationElapsedMs })
    })
  })
}

function parseChildOutcome(outcome: ChildOutcome): AgentResult {
  const processDetails: string[] = []
  if (outcome.termination === 'timed out') {
    const elapsed = outcome.terminationElapsedMs ?? CHILD_TIMEOUT_MS
    processDetails.push(`cat-code timed out after ${Math.floor(elapsed / 1000)}s (limit ${Math.floor(CHILD_TIMEOUT_MS / 1000)}s); sent SIGTERM, then SIGKILL after ${Math.floor(KILL_GRACE_MS / 1000)}s if still running`)
  } else if (outcome.termination) {
    const elapsed = outcome.terminationElapsedMs
    processDetails.push(`cat-code ${outcome.termination}${elapsed === undefined ? '' : ` after ${Math.floor(elapsed / 1000)}s`}`)
  }
  if (outcome.spawnError) processDetails.push(`spawn error: ${outcome.spawnError}`)
  if (outcome.code !== null && outcome.code !== 0) processDetails.push(`exit code ${outcome.code}`)
  if (outcome.signal) processDetails.push(`signal ${outcome.signal}`)
  if (outcome.stderr.trim()) processDetails.push(`stderr${outcome.stderrTruncated ? ' (truncated)' : ''}:\n${outcome.stderr.trim()}`)
  if (outcome.stdoutTruncated) processDetails.push('stdout was truncated to its final 1 MiB')
  if (outcome.termination || outcome.spawnError) return { text: processDetails.join('\n\n'), sessionId: '', isError: true }

  const finalLine = outcome.stdout.trim().split('\n').filter(Boolean).at(-1) ?? ''
  let value: unknown
  try { value = JSON.parse(finalLine) } catch {
    const detail = finalLine ? `final stdout line:\n${finalLine}` : 'stdout contained no result line'
    return { text: [`cat-code returned invalid JSON`, detail, ...processDetails].join('\n\n'), sessionId: '', isError: true }
  }
  if (!isPlainObject(value)) return { text: [`cat-code returned an invalid result object: expected an object`, ...processDetails].join('\n\n'), sessionId: '', isError: true }

  const resultText = typeof value.result === 'string' ? value.result : undefined
  const sessionId = typeof value.session_id === 'string' ? value.session_id : ''
  const shapeErrors: string[] = []
  if (resultText === undefined) shapeErrors.push('result must be a string')
  if (typeof value.is_error !== 'boolean') shapeErrors.push('is_error must be a boolean')
  const childReportedError = value.is_error === true
  if (!childReportedError && !sessionId) shapeErrors.push('session_id must be a non-empty string on success')

  const details = [...processDetails]
  if (value.subtype !== undefined) details.push(`subtype: ${diagnosticValue(value.subtype)}`)
  if (Array.isArray(value.errors) && value.errors.length > 0) details.push(`errors: ${diagnosticValue(value.errors)}`)
  else if (value.errors !== undefined && !Array.isArray(value.errors)) shapeErrors.push('errors must be an array when present')
  if (Array.isArray(value.permission_denials) && value.permission_denials.length > 0) details.push(`permission_denials: ${diagnosticValue(value.permission_denials)}`)
  else if (value.permission_denials !== undefined && !Array.isArray(value.permission_denials)) shapeErrors.push('permission_denials must be an array when present')

  const structuredFailure = childReportedError || outcome.code !== 0 || outcome.signal !== null || (Array.isArray(value.errors) && value.errors.length > 0) || (Array.isArray(value.permission_denials) && value.permission_denials.length > 0)
  if (shapeErrors.length > 0) return { text: [`cat-code returned an invalid result object: ${shapeErrors.join('; ')}`, resultText ? `result: ${resultText}` : '', ...details].filter(Boolean).join('\n\n'), sessionId, isError: true }
  if (structuredFailure) return { text: [`cat-code failed${resultText ? `: ${resultText}` : ''}`, ...details].join('\n\n'), sessionId, isError: true }
  return { text: resultText!, sessionId, isError: false }
}

function validateSpawnArguments(params: unknown): ValidatedArguments {
  if (!isPlainObject(params) || params.name !== SPAWN_TOOL.name) throw new Error(`unknown tool: ${isPlainObject(params) && typeof params.name === 'string' ? params.name : diagnosticValue(isPlainObject(params) ? params.name : undefined)}`)
  if (!isPlainObject(params.arguments)) throw new Error('params.arguments must be an object')
  const args = params.arguments
  if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('prompt is required and must be a non-empty string')
	  if (args.conversation !== undefined) throw new Error('conversation is deprecated for spawn_gpt_agent; use name')
	  if (args.reset_conversation !== undefined) throw new Error('reset_conversation is deprecated; spawn_gpt_agent is create-only')

  let conversation: string | undefined
	  if (args.name !== undefined) {
	    if (typeof args.name !== 'string' || !args.name.trim()) throw new Error('name must be a non-empty string when provided')
	    conversation = args.name.trim()
  }
  let description: string | undefined
  if (args.description !== undefined) {
    if (typeof args.description !== 'string' || !args.description.trim()) throw new Error('description must be a non-empty string when provided')
    description = args.description.trim()
  }
  let resumeSession: string | undefined
  if (args.resume_session !== undefined) {
    throw new Error('spawn_gpt_agent is create-only; use send_gpt_agent_message to continue an existing GPT')
  }

  let explicitModel: Model | undefined
  if (Object.prototype.hasOwnProperty.call(args, 'model')) {
    if (!isModel(args.model)) throw new Error(`model must be one of: ${SUPPORTED_MODELS.join(', ')}`)
    explicitModel = args.model
  }

  let addDirs: string[] = []
  if (args.add_dirs !== undefined) {
    if (!Array.isArray(args.add_dirs)) throw new Error('add_dirs must be an array')
    addDirs = args.add_dirs.map((value, index) => {
      if (typeof value !== 'string') throw new Error(`add_dirs[${index}] must be a string`)
      const directory = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
      let stats
      try { stats = statSync(directory) } catch { throw new Error(`add_dirs[${index}] must be an existing directory: ${value}`) }
      if (!stats.isDirectory()) throw new Error(`add_dirs[${index}] must be an existing directory: ${value}`)
      return directory
    })
  }

  if (args.replace_existing !== undefined && typeof args.replace_existing !== 'boolean') throw new Error('replace_existing must be a boolean')
  if (args.run_in_background !== undefined && typeof args.run_in_background !== 'boolean') throw new Error('run_in_background must be a boolean')
	  return { prompt: args.prompt, conversation, description, explicitModel, addDirs, resumeSession, resetConversation: false, replaceExisting: args.replace_existing === true, runInBackground: args.run_in_background === true }
}

function validateJobIdArguments(params: unknown): string {
  if (!isPlainObject(params) || !isPlainObject(params.arguments)) throw new Error('params.arguments must be an object')
  const jobId = params.arguments.job_id
  if (typeof jobId !== 'string' || !/^job_[0-9a-f-]+$/.test(jobId)) throw new Error('job_id must be a valid job id')
  return jobId
}

function validateWaitArguments(params: unknown): { jobId: string; timeoutMs: number } {
  const jobId = validateJobIdArguments(params)
  const args = isPlainObject(params) && isPlainObject(params.arguments) ? params.arguments : {}
  const rawTimeout = args.timeout_ms
  if (rawTimeout === undefined) return { jobId, timeoutMs: JOB_WAIT_DEFAULT_MS }
  if (typeof rawTimeout !== 'number' || !Number.isSafeInteger(rawTimeout) || rawTimeout <= 0) throw new Error('timeout_ms must be a positive integer')
  return { jobId, timeoutMs: Math.min(rawTimeout, JOB_WAIT_MAX_MS) }
}

function validateSendMessageArguments(params: unknown): SendMessageArguments {
  if (!isPlainObject(params) || params.name !== SEND_GPT_MESSAGE_TOOL.name) throw new Error(`unknown tool: ${isPlainObject(params) && typeof params.name === 'string' ? params.name : diagnosticValue(isPlainObject(params) ? params.name : undefined)}`)
  if (!isPlainObject(params.arguments)) throw new Error('params.arguments must be an object')
  const args = params.arguments
  if (typeof args.to !== 'string' || !args.to.trim()) throw new Error('to is required and must be a non-empty string')
  if (typeof args.message !== 'string' || !args.message.trim()) throw new Error('message is required and must be a non-empty string')
  if (args.run_in_background !== undefined && typeof args.run_in_background !== 'boolean') throw new Error('run_in_background must be a boolean')
  return { to: args.to.trim(), message: args.message, runInBackground: args.run_in_background === true }
}

function chooseGptName(args: ValidatedArguments): string {
  if (args.conversation) return args.conversation
  let candidate = generatedGptCounter + 1
  while (gptRegistry.has(`GPT ${candidate}`)) candidate += 1
  return `GPT ${candidate}`
}

function rollbackGptReservation(name: string): void {
  const record = gptRegistry.get(name)
  if (record?.status === 'queued' && !record.sessionId && !record.activeJobId && !record.lastJobId) gptRegistry.delete(name)
}

function failReservedGpt(name: string, text: string): void {
  upsertGptRecord(name, { status: 'failed', sessionId: undefined, activeJobId: undefined, error: text })
}

function duplicateNamedGptResult(name: string): AgentResult {
  return {
    text: `A GPT named "${name}" already exists. Use send_gpt_agent_message with to: "${name}" to continue it, or choose a different name for a new GPT.`,
    sessionId: '',
    isError: true,
    name,
  }
}

function busyReplaceResult(name: string, status: JobStatus): AgentResult {
  return {
    text: `GPT "${name}" is busy (${status}) and cannot be replaced. Use list_gpt_agents to check when it finishes, then retry replace_existing: true or choose another name.`,
    sessionId: '',
    isError: true,
    name,
  }
}

function reserveNamedGpt(args: ValidatedArguments): ValidatedArguments | AgentResult {
  const name = chooseGptName(args)
  const existing = gptRegistry.get(name)
  if (existing) {
    const record = reconcileGptRecord(existing)
    if (args.replaceExisting && isBusyStatus(record.status)) return busyReplaceResult(name, record.status)
    if (!args.replaceExisting) return duplicateNamedGptResult(name)
  }
  if (name.startsWith('GPT ')) {
    const generatedNumber = Number(name.slice(4))
    if (Number.isSafeInteger(generatedNumber) && generatedNumber > generatedGptCounter) generatedGptCounter = generatedNumber
  }
  const createdAt = now()
  gptRegistry.set(name, {
    name,
    status: 'queued',
    model: args.explicitModel ?? DEFAULT_MODEL,
    description: args.description,
    createdAt,
    updatedAt: createdAt,
  })
  return { ...args, conversation: name, resumeSession: undefined, resetConversation: false }
}

function upsertGptRecord(name: string, patch: Partial<GptRecord>): GptRecord {
  const existing = gptRegistry.get(name)
  const updatedAt = patch.updatedAt ?? now()
  const record: GptRecord = {
    name,
    status: existing?.status ?? 'queued',
    model: existing?.model ?? DEFAULT_MODEL,
    createdAt: existing?.createdAt ?? now(),
    updatedAt,
    ...existing,
    ...patch,
    updatedAt,
  }
  gptRegistry.set(name, record)
  return record
}

function isBusyStatus(status: JobStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'cancelling'
}

function reconcileGptRecord(record: GptRecord): GptRecord {
  const jobId = record.activeJobId
  if (!jobId) return record
  try {
    const job = readJobStatus(jobId)
    return upsertGptRecord(record.name, {
      status: job.status,
      sessionId: job.sessionId ?? record.sessionId,
      activeJobId: isTerminalStatus(job.status) ? undefined : job.jobId,
      lastJobId: job.jobId,
      description: job.description ?? record.description,
      error: job.error ?? record.error,
      updatedAt: job.updatedAt,
    })
  } catch (error) {
    if (error instanceof MissingJobArtifactError && isBusyStatus(record.status)) {
      return upsertGptRecord(record.name, {
        status: 'failed',
        sessionId: undefined,
        activeJobId: undefined,
        lastJobId: jobId,
        error: `job artifacts for ${jobId} are missing; this GPT cannot be continued`,
      })
    }
    return record
  }
}

function getKnownGptNames(): string {
  const names = [...gptRegistry.keys()]
  return names.length ? names.map(name => JSON.stringify(name)).join(', ') : 'none'
}

function toolResult(result: AgentResult, name?: string): JsonObject {
  const content: JsonObject[] = [{ type: 'text', text: result.text }]
  const displayName = name ?? result.name
  if (displayName) content.push({ type: 'text', text: `\n\n[name: ${displayName}]` })
  return { content, isError: result.isError }
}

async function runNamedConversation(args: ValidatedArguments, signal: AbortSignal, logs?: { stdout: string; stderr: string }): Promise<AgentRunResult> {
  const conversation = args.conversation!
  const lockPath = conversationLockPath(conversation)
  const pendingPath = pendingCommitPath(conversation)
  let release = await acquireLock(lockPath, CONVERSATION_LOCK_MAX_AGE_MS, signal)
  try {
    while (existsSync(pendingPath)) {
      release()
      await flushPendingCommit(pendingPath)
      release = await acquireLock(lockPath, CONVERSATION_LOCK_MAX_AGE_MS, signal)
    }

    let store: ConversationStore
    try { store = readStoreUnlocked() } catch (error) {
      if (!(error instanceof StoreCorruptError)) throw error
      await quarantineCorruptStore()
      throw error
    }

    const stored = store[conversation]
    const model = args.explicitModel ?? stored?.model ?? DEFAULT_MODEL
    const resume = args.resetConversation ? undefined : stored?.sessionId
    const outcome = await runCatCode({ prompt: args.prompt, model, addDirs: args.addDirs, resume, signal, logs })
    const parsed = parseChildOutcome(outcome)
    if (parsed.isError) {
      if (resume) parsed.text = `Failed to resume stored name ${JSON.stringify(conversation)}. The mapping was preserved. Retry if the failure is transient, or pass reset_conversation: true to deliberately start fresh.\n\n${parsed.text}`
      return { ...parsed, model, process: childProcessSummary(outcome) }
    }

    writePendingCommit(pendingPath, { conversation, entry: { sessionId: parsed.sessionId, model }, createdAt: Date.now() })
    return { ...parsed, model, process: childProcessSummary(outcome) }
  } finally {
    release()
    if (existsSync(pendingPath)) await flushPendingCommit(pendingPath)
  }
}

function runForegroundToolCall(args: ValidatedArguments, signal: AbortSignal, logs?: { stdout: string; stderr: string }): Promise<AgentRunResult> {
  const model = args.explicitModel ?? DEFAULT_MODEL
  return runCatCode({ prompt: args.prompt, model, addDirs: args.addDirs, resume: args.resumeSession, signal, logs }).then(outcome => ({ ...parseChildOutcome(outcome), model, process: childProcessSummary(outcome) }))
}

async function runAuditedForegroundToolCall(args: ValidatedArguments, signal: AbortSignal, context: AuditContext): Promise<AgentRunResult> {
  const startedAtMs = Date.now()
  appendAuditRecord({ ...auditBase(args, context, 'foreground'), event: 'started' })
  try {
    const result = await runForegroundToolCall(args, signal)
    appendTerminalAudit(args, context, 'foreground', startedAtMs, result)
    return result
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    const result: AgentRunResult = { text, sessionId: '', isError: true, model: args.explicitModel ?? DEFAULT_MODEL }
    appendTerminalAudit(args, context, 'foreground', startedAtMs, result)
    throw error
  }
}

function jobDir(jobId: string): string {
  return join(JOBS_DIR, jobId)
}

function jobPaths(jobId: string): JobRecord['paths'] {
  const dir = jobDir(jobId)
  return { request: join(dir, 'request.json'), status: join(dir, 'status.json'), result: join(dir, 'result.json'), stdout: join(dir, 'stdout.log'), stderr: join(dir, 'stderr.log') }
}

function writeJobResult(jobId: string, result: AgentResult & { status: JobStatus; completedAt?: string }): void {
  atomicWriteJson(jobPaths(jobId).result, { ...result, completedAt: result.completedAt ?? now() })
}

function writeJobStatus(jobId: string, patch: Partial<JobRecord>): JobRecord {
  const paths = jobPaths(jobId)
  const existing = existsSync(paths.status) ? readJson(paths.status) as JobRecord : undefined
  const defaults: JobRecord = {
    jobId,
    status: 'queued',
    createdAt: existing?.createdAt ?? now(),
    updatedAt: now(),
    cwd: existing?.cwd ?? process.cwd(),
    paths,
  }
  const record: JobRecord = {
    ...defaults,
    ...existing,
    ...patch,
    paths,
    updatedAt: now(),
  }
  atomicWriteJson(paths.status, record)
  return record
}

function readJobStatus(jobId: string): JobRecord {
  const paths = jobPaths(jobId)
  if (!existsSync(paths.status)) throw new MissingJobArtifactError(`unknown job_id: ${jobId}`)
  const record = readJson(paths.status) as JobRecord
  if (!isTerminalStatus(record.status) && existsSync(paths.result)) {
    const result = readJson(paths.result) as Partial<AgentResult> & { status?: JobStatus }
    const status = result.status && isTerminalStatus(result.status) ? result.status : result.isError ? 'failed' : 'completed'
    const updated = writeJobStatus(jobId, {
      status,
      sessionId: typeof result.sessionId === 'string' ? result.sessionId : undefined,
      isError: result.isError === true,
      error: result.isError === true && typeof result.text === 'string' ? result.text.slice(0, 4000) : undefined,
    })
    if (!record.workerPid || !pidIsAlive(record.workerPid)) {
      appendReconciledJobAudit(jobId, status, typeof result.text === 'string' ? result.text : '', typeof result.sessionId === 'string' ? result.sessionId : '', result.isError === true)
    }
    return updated
  }
  if (!isTerminalStatus(record.status) && record.workerPid && !pidIsAlive(record.workerPid) && !existsSync(paths.result)) {
    const status: JobStatus = record.status === 'cancelling' ? 'cancelled' : 'failed'
    const text = status === 'cancelled' ? `job ${jobId} was cancelled before it wrote a result` : `worker process ${record.workerPid} is no longer running`
    writeJobResult(jobId, { text, sessionId: '', isError: status !== 'cancelled', status })
    const updated = writeJobStatus(jobId, { status, isError: status !== 'cancelled', error: status === 'failed' ? text : undefined })
    appendReconciledJobAudit(jobId, status, text, '', status !== 'cancelled')
    return updated
  }
  return record
}

function readJobRequest(jobId: string): JobRequest | undefined {
  try {
    const request = readJson(jobPaths(jobId).request) as JobRequest
    return isPlainObject(request) && isPlainObject(request.args) ? request : undefined
  } catch {
    return undefined
  }
}

function appendReconciledJobAudit(jobId: string, status: JobStatus, text: string, sessionId: string, isError: boolean): void {
  const request = readJobRequest(jobId)
  if (!request) return
  const startedAtMs = Number.isFinite(Date.parse(request.createdAt)) ? Date.parse(request.createdAt) : Date.now()
  appendTerminalAudit(
    request.args,
    request.audit ?? { requestId: null },
    'background',
    startedAtMs,
    { text, sessionId, isError, model: request.args.explicitModel ?? DEFAULT_MODEL },
    jobId,
    status,
    request.cwd,
  )
}

function appendValidationFailureAudit(context: AuditContext, startedAtMs: number): void {
  appendAuditRecord({
    mcp_tool: SPAWN_TOOL.name,
    mcp_request_id: context.requestId,
    mcp_tool_use_id: context.toolUseId,
    event: 'terminal',
    status: 'failed',
    error_type: 'validation',
    duration_ms: Date.now() - startedAtMs,
  })
}

function startBackgroundJob(args: ValidatedArguments, context: AuditContext): AgentResult {
  const jobId = `job_${randomUUID()}`
  const backgroundArgs = args
  const gptName = backgroundArgs.conversation
  const paths = jobPaths(jobId)
  const startedAtMs = Date.now()
  mkdirSync(jobDir(jobId), { recursive: true, mode: 0o700 })
  writeFileSync(paths.stdout, '')
  writeFileSync(paths.stderr, '')
  const request: JobRequest = { args: backgroundArgs, cwd: process.cwd(), createdAt: now(), audit: context }
  atomicWriteJson(paths.request, request)
  writeJobStatus(jobId, { status: 'queued', cwd: request.cwd, conversation: backgroundArgs.conversation, description: backgroundArgs.description })
  appendAuditRecord({ ...auditBase(backgroundArgs, context, 'background', jobId), event: 'started', paths })

  let stdoutFd: number | undefined
  let stderrFd: number | undefined
  try {
    stdoutFd = openSync(paths.stdout, 'a')
    stderrFd = openSync(paths.stderr, 'a')
    const child = spawn(process.execPath, [SELF, '--run-job', jobId], {
      cwd: process.cwd(),
      env: { ...process.env, CAT_CODE_CLI: CLI, GPT_AGENT_STORE: STORE, GPT_AGENT_BACKGROUND_DIR: JOBS_DIR, GPT_AGENT_PROMPT: WORKER_PROMPT_FILE, GPT_AGENT_TIMEOUT_MS: String(CHILD_TIMEOUT_MS), GPT_AGENT_KILL_GRACE_MS: String(KILL_GRACE_MS) },
      detached: true,
      stdio: ['ignore', stdoutFd, stderrFd],
    })
    if (!child.pid) throw new Error('worker did not report a pid')
    writeJobStatus(jobId, { status: 'queued', workerPid: child.pid })
    child.unref()
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    writeJobResult(jobId, { text, sessionId: '', isError: true, status: 'failed' })
    writeJobStatus(jobId, { status: 'failed', error: text })
    if (gptName) {
      upsertGptRecord(gptName, {
        status: 'failed',
        sessionId: undefined,
        activeJobId: undefined,
        lastJobId: jobId,
        error: text,
      })
    }
    appendTerminalAudit(backgroundArgs, context, 'background', startedAtMs, { text, sessionId: '', isError: true, model: backgroundArgs.explicitModel ?? DEFAULT_MODEL }, jobId, 'failed')
    return { text: `failed to start background job ${jobId}: ${text}`, sessionId: '', isError: true }
  } finally {
    if (stdoutFd !== undefined) try { closeSync(stdoutFd) } catch {}
    if (stderrFd !== undefined) try { closeSync(stderrFd) } catch {}
  }

  const descriptionLine = args.description ? `\ndescription: ${args.description}` : ''
  const debugAffordances = DEBUG_TOOLS_ENABLED
    ? `\nstatus_tool: get_gpt_agent_job_status\nresult_tool: get_gpt_agent_job_result\nwait_tool: wait_for_gpt_agent_job\nlog_tool: tail_gpt_agent_job_log\ncancel_tool: cancel_gpt_agent_job`
    : ''
  if (gptName) {
    upsertGptRecord(gptName, {
      status: 'queued',
      activeJobId: jobId,
      lastJobId: jobId,
      model: backgroundArgs.explicitModel ?? DEFAULT_MODEL,
      description: backgroundArgs.description,
    })
  }
  return {
    text: gptName
      ? `Started GPT "${gptName}" in the background.${descriptionLine}\nTo continue after it finishes, use send_gpt_agent_message with to: "${gptName}".\nDebug job_id: ${jobId}${debugAffordances}`
      : `spawn_gpt_agent started a detached GPT job\njob_id: ${jobId}${descriptionLine}${debugAffordances}`,
    sessionId: '',
    isError: false,
    name: gptName,
  }
}

function readLimited(path: string, maxChars = MAX_RESULT_CHARS): string {
  if (!existsSync(path)) return ''
  const size = statSync(path).size
  const length = Math.min(size, maxChars)
  const buffer = Buffer.alloc(length)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buffer, 0, length, size - length)
  } finally {
    closeSync(fd)
  }
  return buffer.toString('utf8')
}

function formatStatus(record: JobRecord): string {
  return JSON.stringify({ job_id: record.jobId, status: record.status, worker_pid: record.workerPid, name: record.conversation, description: record.description, error: record.error, paths: record.paths, updated_at: record.updatedAt }, null, 2)
}

function getJobStatus(params: unknown): AgentResult {
  return { text: formatStatus(readJobStatus(validateJobIdArguments(params))), sessionId: '', isError: false }
}

function formatJobResult(record: JobRecord): AgentResult {
  const jobId = record.jobId
  if (!existsSync(record.paths.result)) {
    if (isTerminalStatus(record.status)) {
      const stderr = readLimited(record.paths.stderr).trim()
      const stdout = readLimited(record.paths.stdout).trim()
      const text = record.error ?? (stderr || stdout || `job ${jobId} ended with status ${record.status} but no result artifact was written`)
      return { text: JSON.stringify({ job_id: jobId, status: record.status, ready: true, has_result: false, name: record.conversation, description: record.description, is_error: record.status === 'failed', text }, null, 2), sessionId: record.sessionId ?? '', isError: record.status === 'failed', name: record.conversation }
    }
    return { text: JSON.stringify({ job_id: jobId, status: record.status, ready: false, has_result: false, name: record.conversation, description: record.description, message: 'Job result is not ready yet. Call wait_for_gpt_agent_job, get_gpt_agent_job_status, or tail_gpt_agent_job_log.' }, null, 2), sessionId: '', isError: false, name: record.conversation }
  }
  const result = readJson(record.paths.result) as AgentResult & { completedAt?: string; status?: JobStatus }
  const body = result.text.length > MAX_RESULT_CHARS ? `${result.text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated; full result at ${record.paths.result}]` : result.text
  return { text: JSON.stringify({ job_id: jobId, status: result.status ?? record.status, ready: true, has_result: true, name: record.conversation, description: record.description, is_error: result.isError, completed_at: result.completedAt, text: body }, null, 2), sessionId: result.sessionId, isError: result.isError, name: record.conversation }
}

function getJobResult(params: unknown): AgentResult {
  return formatJobResult(readJobStatus(validateJobIdArguments(params)))
}

async function waitForJob(params: unknown, signal: AbortSignal): Promise<AgentResult> {
  const { jobId, timeoutMs } = validateWaitArguments(params)
  const deadline = Date.now() + timeoutMs
  let record = readJobStatus(jobId)
  while (!isTerminalStatus(record.status) && !existsSync(record.paths.result)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return { text: JSON.stringify({ job_id: jobId, status: record.status, ready: false, has_result: false, name: record.conversation, description: record.description, timeout_ms: timeoutMs, message: 'Job did not finish before timeout_ms.' }, null, 2), sessionId: '', isError: false, name: record.conversation }
    }
    if (signal.aborted) throw new Error(typeof signal.reason === 'string' ? signal.reason : 'request cancelled')
    await Bun.sleep(Math.min(JOB_WAIT_POLL_MS, remaining))
    record = readJobStatus(jobId)
  }
  return formatJobResult(record)
}

function tailJobLog(params: unknown): AgentResult {
  const jobId = validateJobIdArguments(params)
  const args = isPlainObject(params) && isPlainObject(params.arguments) ? params.arguments : {}
  const stream = args.stream === 'stderr' ? 'stderr' : 'stdout'
  const lines = typeof args.lines === 'number' && Number.isFinite(args.lines) && args.lines > 0 ? Math.min(Math.floor(args.lines), 500) : 80
  const record = readJobStatus(jobId)
  const path = stream === 'stderr' ? record.paths.stderr : record.paths.stdout
  const text = readLimited(path).replace(/\r?\n$/, '').split('\n').slice(-lines).join('\n')
  return { text: text || `[${stream} log is empty]`, sessionId: '', isError: false }
}

function cancelJob(params: unknown): AgentResult {
  const jobId = validateJobIdArguments(params)
  const record = readJobStatus(jobId)
  if (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled') return { text: formatStatus(record), sessionId: '', isError: false }
  writeJobStatus(jobId, { status: 'cancelling' })
  if (record.workerPid && pidIsAlive(record.workerPid)) {
    try { process.kill(-record.workerPid, 'SIGTERM') } catch { try { process.kill(record.workerPid, 'SIGTERM') } catch {} }
  }
  return { text: formatStatus(readJobStatus(jobId)), sessionId: '', isError: false }
}

function listJobs(): AgentResult {
  if (!existsSync(JOBS_DIR)) return { text: '[]', sessionId: '', isError: false }
  const jobs = readdirSync(JOBS_DIR).filter(name => name.startsWith('job_')).map(jobId => {
    try { return readJobStatus(jobId) } catch { return null }
  }).filter((record): record is JobRecord => record !== null)
  return { text: JSON.stringify(jobs.map(record => ({ job_id: record.jobId, status: record.status, name: record.conversation, description: record.description, updated_at: record.updatedAt })), null, 2), sessionId: '', isError: false }
}

function updateGptRecordsForJobCleanup(record: JobRecord): void {
  for (const gpt of gptRegistry.values()) {
    if (gpt.activeJobId !== record.jobId && gpt.lastJobId !== record.jobId) continue
    upsertGptRecord(gpt.name, {
      status: record.status,
      sessionId: undefined,
      activeJobId: undefined,
      lastJobId: record.jobId,
      description: record.description ?? gpt.description,
      error: `debug job artifacts for ${record.jobId} were cleaned up; this GPT cannot be continued`,
      updatedAt: record.updatedAt,
    })
  }
}

function cleanupJob(params: unknown): AgentResult {
  const jobId = validateJobIdArguments(params)
  const record = readJobStatus(jobId)
  if (record.status === 'queued' || record.status === 'running' || record.status === 'cancelling') return { text: `cannot cleanup ${jobId} while status is ${record.status}; cancel it first`, sessionId: '', isError: true }
  updateGptRecordsForJobCleanup(record)
  rmSync(jobDir(jobId), { recursive: true, force: true })
  return { text: `cleaned up ${jobId}`, sessionId: '', isError: false }
}

async function createGpt(args: ValidatedArguments, signal: AbortSignal, context: AuditContext): Promise<AgentResult> | AgentResult {
  const prepared = reserveNamedGpt(args)
  if ('isError' in prepared) return prepared
  const name = prepared.conversation!
  if (prepared.runInBackground) {
    try {
      return startBackgroundJob(prepared, context)
    } catch (error) {
      rollbackGptReservation(name)
      throw error
    }
  }

  try {
    upsertGptRecord(name, { status: 'running', model: prepared.explicitModel ?? DEFAULT_MODEL, description: prepared.description })
    const result = await runAuditedForegroundToolCall(prepared, signal, context)
    upsertGptRecord(name, {
      status: result.isError ? 'failed' : 'completed',
      sessionId: result.sessionId || undefined,
      activeJobId: undefined,
      model: result.model,
      description: prepared.description,
      error: result.isError ? result.text.slice(0, 4000) : undefined,
    })
    return {
      text: `GPT "${name}" ${result.isError ? 'failed' : 'replied'}.\nTo continue, use send_gpt_agent_message with to: "${name}".\n\n${result.text}`,
      sessionId: result.sessionId,
      isError: result.isError,
      name,
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    failReservedGpt(name, text)
    throw error
  }
}

function listGpts(): AgentResult {
  const records = [...gptRegistry.values()].map(reconcileGptRecord)
  const list = records.map(record => ({
    name: record.name,
    status: record.status,
    ...(record.lastJobId ? { last_job_id: record.lastJobId } : {}),
    ...(record.description ? { description: record.description } : {}),
  }))
  return { text: JSON.stringify(list, null, 2), sessionId: '', isError: false }
}

function promptCacheFreshness(record: GptRecord): { warning?: string; decline?: string } {
  const updatedAtMs = Date.parse(record.updatedAt)
  if (!Number.isFinite(updatedAtMs)) return {}
  const ageMs = Date.now() - updatedAtMs
  const longCache = record.model === 'gpt-5.5'
  const warnMs = longCache ? 2 * 60 * 60 * 1000 : 10 * 60 * 1000
  const declineMs = longCache ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000
  if (ageMs >= declineMs) {
    return {
      decline: `GPT "${record.name}" last ran at ${record.updatedAt}, so its prompt cache is too stale to continue safely with ${record.model}. Start a fresh GPT with spawn_gpt_agent instead.`,
    }
  }
  if (ageMs >= warnMs) {
    return {
      warning: `Warning: GPT "${record.name}" last ran at ${record.updatedAt}; prompt-cache context may be stale for ${record.model}.`,
    }
  }
  return {}
}

async function sendGptMessage(args: SendMessageArguments, signal: AbortSignal, context: AuditContext): Promise<AgentResult> | AgentResult {
  const existing = gptRegistry.get(args.to)
  if (!existing) {
    return { text: `Unknown GPT "${args.to}". Known GPTs: ${getKnownGptNames()}.`, sessionId: '', isError: true }
  }
  const record = reconcileGptRecord(existing)
  if (isBusyStatus(record.status)) {
    return { text: `GPT "${record.name}" is still running. Check list_gpt_agents and send the message after it finishes.`, sessionId: '', isError: true, name: record.name }
  }
  if (!record.sessionId) {
    return { text: `GPT "${record.name}" cannot be continued because it has no completed session yet. Check list_gpt_agents for status. Debug job_id: ${record.lastJobId ?? '(unknown)'}.`, sessionId: '', isError: true, name: record.name }
  }
  const freshness = promptCacheFreshness(record)
  if (freshness.decline) return { text: freshness.decline, sessionId: '', isError: true, name: record.name }

  const followup: ValidatedArguments = {
    prompt: args.message,
    conversation: record.name,
    description: record.description,
    explicitModel: record.model,
    addDirs: [],
    resumeSession: record.sessionId,
    resetConversation: false,
    replaceExisting: false,
    runInBackground: args.runInBackground,
  }
  if (args.runInBackground) {
    const started = startBackgroundJob(followup, context)
    if (freshness.warning && !started.isError) started.text = `${freshness.warning}\n\n${started.text}`
    return started
  }

  upsertGptRecord(record.name, { status: 'running', activeJobId: undefined })
  try {
    const result = await runAuditedForegroundToolCall(followup, signal, context)
    upsertGptRecord(record.name, {
      status: result.isError ? 'failed' : 'completed',
      sessionId: result.sessionId || record.sessionId,
      activeJobId: undefined,
      model: result.model,
      description: record.description,
      error: result.isError ? result.text.slice(0, 4000) : undefined,
    })
    return {
      text: `${freshness.warning ? `${freshness.warning}\n\n` : ''}GPT "${record.name}" ${result.isError ? 'failed' : 'replied'}.\nTo continue, use send_gpt_agent_message with to: "${record.name}".\n\n${result.text}`,
      sessionId: result.sessionId,
      isError: result.isError,
      name: record.name,
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    upsertGptRecord(record.name, { status: 'failed', activeJobId: undefined, error: text })
    throw error
  }
}

async function runJobWorker(jobId: string): Promise<void> {
  const paths = jobPaths(jobId)
  const controller = new AbortController()
  let cancelled = false
  const cancel = (): void => {
    cancelled = true
    writeJobStatus(jobId, { status: 'cancelling', workerPid: process.pid })
    controller.abort('cancelled')
  }
  process.on('SIGTERM', cancel)
  process.on('SIGINT', cancel)
  try {
    const request = readJson(paths.request) as JobRequest
    const audit = request.audit ?? { requestId: null }
    const startedAtMs = Number.isFinite(Date.parse(request.createdAt)) ? Date.parse(request.createdAt) : Date.now()
    process.chdir(request.cwd)
    writeJobStatus(jobId, { status: 'running', workerPid: process.pid, cwd: request.cwd, conversation: request.args.conversation, description: request.args.description })
    const result = await runForegroundToolCall(request.args, controller.signal, { stdout: paths.stdout, stderr: paths.stderr })
    const status: JobStatus = cancelled ? 'cancelled' : result.isError ? 'failed' : 'completed'
    writeJobResult(jobId, { ...result, status })
    writeJobStatus(jobId, { status, sessionId: result.sessionId, isError: result.isError, error: result.isError ? result.text.slice(0, 4000) : undefined })
    appendTerminalAudit(request.args, audit, 'background', startedAtMs, result, jobId, status)
  } catch (error) {
    const status: JobStatus = cancelled ? 'cancelled' : 'failed'
    const text = error instanceof Error ? error.message : String(error)
    const request = existsSync(paths.request) ? readJson(paths.request) as JobRequest : undefined
    const args = request?.args
    writeJobResult(jobId, { text, sessionId: '', isError: status !== 'cancelled', status })
    writeJobStatus(jobId, { status, isError: status !== 'cancelled', error: status === 'failed' ? text : undefined })
    if (args) {
      const audit = request?.audit ?? { requestId: null }
      const startedAtMs = Number.isFinite(Date.parse(request.createdAt)) ? Date.parse(request.createdAt) : Date.now()
      appendTerminalAudit(args, audit, 'background', startedAtMs, { text, sessionId: '', isError: status !== 'cancelled', model: args.explicitModel ?? DEFAULT_MODEL }, jobId, status)
    }
  } finally {
    process.off('SIGTERM', cancel)
    process.off('SIGINT', cancel)
  }
}

function runToolCall(params: unknown, signal: AbortSignal, context: AuditContext): Promise<AgentResult> | AgentResult {
  if (!isPlainObject(params) || typeof params.name !== 'string') throw new Error('params.name is required')
  if (DEBUG_TOOL_NAMES.has(params.name) && !DEBUG_TOOLS_ENABLED) throw new Error(`${params.name} is only available when GPT_AGENT_DEBUG_TOOLS=1`)
  switch (params.name) {
    case 'spawn_gpt_agent': {
      const startedAtMs = Date.now()
      let args: ValidatedArguments
      try {
        args = validateSpawnArguments(params)
      } catch (error) {
        appendValidationFailureAudit(context, startedAtMs)
        throw error
      }
      return createGpt(args, signal, context)
    }
    case 'send_gpt_agent_message': return sendGptMessage(validateSendMessageArguments(params), signal, context)
    case 'list_gpt_agents': return listGpts()
    case 'get_gpt_agent_job_status': return getJobStatus(params)
    case 'get_gpt_agent_job_result': return getJobResult(params)
    case 'wait_for_gpt_agent_job': return waitForJob(params, signal)
    case 'tail_gpt_agent_job_log': return tailJobLog(params)
    case 'cancel_gpt_agent_job': return cancelJob(params)
    case 'list_gpt_agent_jobs': return listJobs()
    case 'cleanup_gpt_agent_job': return cleanupJob(params)
    default: throw new Error(`unknown tool: ${params.name}`)
  }
}

type ActiveRequest = { controller: AbortController }
const activeRequests = new Map<string, ActiveRequest>()

function requestKey(id: RpcId): string {
  return id === null ? 'null' : `${typeof id}:${String(id)}`
}

function validRpcId(value: unknown): value is RpcId {
  return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

function handleCancellation(params: unknown): void {
  if (!isPlainObject(params) || !validRpcId(params.requestId)) return
  const active = activeRequests.get(requestKey(params.requestId))
  if (!active) return
  const reason = typeof params.reason === 'string' && params.reason ? `request cancelled: ${params.reason}` : 'request cancelled'
  active.controller.abort(reason)
}

async function handleToolCall(id: RpcId, params: unknown): Promise<void> {
  const key = requestKey(id)
  if (activeRequests.has(key)) {
    sendError(id, -32600, `request id is already active: ${String(id)}`)
    return
  }
  const active: ActiveRequest = { controller: new AbortController() }
  const auditContext = auditContextFromParams(id, params)
  activeRequests.set(key, active)
  try {
    const agentResult = await runToolCall(params, active.controller.signal, auditContext)
    const args = isPlainObject(params) && isPlainObject(params.arguments) ? params.arguments : {}
    const name = typeof args.name === 'string' ? args.name : typeof args.conversation === 'string' ? args.conversation : undefined
    sendResult(id, toolResult(agentResult, name))
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    const cancelled = active.controller.signal.aborted
    sendResult(id, toolResult({ text: cancelled ? `cat-code cancelled: ${text}` : text, sessionId: '', isError: true }))
  } finally {
    activeRequests.delete(key)
  }
}

function handleLine(rawLine: string): void {
  const raw = rawLine.trim()
  if (!raw) return

  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    sendError(null, -32700, 'parse error')
    return
  }

  const request = isPlainObject(parsed) ? parsed : undefined
  const hasId = request !== undefined && Object.prototype.hasOwnProperty.call(request, 'id')
  const responseId: RpcId = hasId && validRpcId(request.id) ? request.id : null
  if (request === undefined || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || !request.method || (hasId && !validRpcId(request.id)) || (request.params !== undefined && (typeof request.params !== 'object' || request.params === null))) {
    sendError(responseId, -32600, 'invalid request')
    return
  }

  if (request.method === 'notifications/cancelled') {
    handleCancellation(request.params)
    return
  }
  if (request.method === 'notifications/initialized') return
  if (request.method === 'initialize') {
    if (hasId) sendResult(responseId, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'gpt-agent', version: '1.0.0' } })
    return
  }
  if (request.method === 'tools/list') {
    if (hasId) sendResult(responseId, { tools: TOOLS })
    return
  }
  if (request.method === 'tools/call') {
    if (hasId) void handleToolCall(responseId, request.params)
    return
  }
  if (hasId) sendError(responseId, -32601, `method not found: ${request.method}`)
}

async function runServer(): Promise<void> {
  const decoder = new TextDecoder()
  let inputBuffer = ''
  for await (const chunk of Bun.stdin.stream()) {
    inputBuffer += decoder.decode(chunk as Uint8Array, { stream: true })
    let newline: number
    while ((newline = inputBuffer.indexOf('\n')) !== -1) {
      handleLine(inputBuffer.slice(0, newline))
      inputBuffer = inputBuffer.slice(newline + 1)
    }
  }
  inputBuffer += decoder.decode()
  if (inputBuffer.trim()) handleLine(inputBuffer)
}

if (process.argv[2] === '--run-job') {
  const jobId = process.argv[3]
  if (!jobId) process.exit(2)
  await runJobWorker(jobId)
} else {
  await runServer()
}
