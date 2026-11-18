import { createTaskStateBase, generateTaskId, type SetAppState, type Task, type TaskStateBase } from '../Task.js'
import type { CodeModeResult } from '../tools/REPLTool/codeModeHost.js'
import { registerTask, updateTaskState } from '../utils/task/framework.js'
import { writeFileAtomicDurable } from '../utils/atomicFile.js'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { TaskState } from './types.js'

export type CodeModeOwner = Readonly<{ sessionId: string; agentId?: string; workerRunId?: string }>
export type CodeModeTaskState = TaskStateBase & {
  type: 'code_mode'
  readonly owner: CodeModeOwner
  readonly cellId: string
  readonly generation: string
  receipt?: CodeModeResult
  /** Delivered payloads live at outputFile; AppState retains only addressable metadata. */
  outputArchived?: boolean
  /** Computed from the engine's selected projection, never from artifact contents. */
  archiveIntegrity?: Readonly<{ sha256: string; bytes: number }>
  cancellationRequested: boolean
  settled: boolean
  delivery: 'pending' | 'delivering' | 'delivered' | 'failed'
  deliveryError?: string
  error?: string
}
export type CodeModeCompletion<T> = { result: CodeModeResult; value: T }

export const CODE_MODE_CONVERSATION_CHANGE_PENDING =
  'Finish or stop background Scripts before changing the conversation. Their results must be saved first.'

export function hasUndeliveredCodeModeTasks(tasks: Record<string, TaskState>, sessionId: string): boolean {
  return Object.values(tasks).some(task => task.type === 'code_mode' &&
    task.owner.sessionId === sessionId && task.delivery !== 'delivered')
}

/** Shared allowlist for live TaskOutput and its disk-backed terminal projection. */
export function projectCodeModeTaskOutput(task: CodeModeTaskState) {
  const receipt = task.receipt
  return {
    cellId: task.cellId,
    generation: task.generation,
    status: receipt?.status ?? task.status,
    output: receipt?.output ?? '',
    partial: !task.settled || receipt?.status !== 'completed',
    changedFiles: receipt?.changedFiles.map(file => ({
      path: file.path,
      ...(file.additions !== undefined ? { additions: file.additions } : {}),
      ...(file.deletions !== undefined ? { deletions: file.deletions } : {}),
    })) ?? [],
    settled: task.settled,
    cancellationRequested: task.cancellationRequested,
    delivery: task.delivery,
  }
}

const MAX_ARCHIVED_OUTPUT_READ_BYTES = 8 * 1024 * 1024

/** Fail closed before exposing any artifact bytes; task temp entries are guest-replaceable. */
export async function readArchivedCodeModeOutput(task: CodeModeTaskState): Promise<string | undefined> {
  const expected = task.archiveIntegrity
  if (!expected || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0 ||
    expected.bytes > MAX_ARCHIVED_OUTPUT_READ_BYTES || !fsConstants.O_NOFOLLOW) return undefined
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(task.outputFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expected.bytes) return undefined
    const buffer = Buffer.alloc(expected.bytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== expected.bytes) return undefined
    const content = buffer.subarray(0, offset)
    if (createHash('sha256').update(content).digest('hex') !== expected.sha256) return undefined
    return content.toString('utf8')
  } catch {
    return undefined
  } finally {
    await file?.close().catch(() => {})
  }
}

async function archiveSelectedOutput(path: string, output: string): Promise<NonNullable<CodeModeTaskState['archiveIntegrity']>> {
  const integrity = Object.freeze({ sha256: createHash('sha256').update(output, 'utf8').digest('hex'), bytes: Buffer.byteLength(output, 'utf8') })
  // Replace the directory entry, never open its existing inode for mutation:
  // guest Bash can substitute a symlink or hardlink at the task output path.
  await writeFileAtomicDurable(path, output, { encoding: 'utf8', mode: 0o600 })
  return integrity
}
export function sameCodeModeOwner(a: CodeModeOwner, b: CodeModeOwner): boolean {
  return a.sessionId === b.sessionId && a.agentId === b.agentId && a.workerRunId === b.workerRunId
}
export function assertCodeModeTaskAccess(task: TaskStateBase, sessionId: string, agentId?: string): void {
  if (task.type !== 'code_mode') return
  const owner = (task as CodeModeTaskState).owner
  if (owner.sessionId !== sessionId || (agentId !== undefined && owner.agentId !== agentId)) {
    throw new Error('Code Mode task belongs to another owner')
  }
}

type OwnedRun = { owner: CodeModeOwner; cellId: string; generation: string; cancel: () => void | Promise<void>; done: Promise<void>; deliver: (sink: (outcome: CodeModeCompletion<unknown>) => Promise<void>, failure?: (error: unknown) => Promise<void>) => Promise<void> }
const runs = new Map<string, OwnedRun>()
const closedOwners = new Set<string>()
const ownerKey = (owner: CodeModeOwner) => JSON.stringify([owner.sessionId, owner.agentId ?? null, owner.workerRunId ?? null])
export function closeCodeModeOwner(owner: CodeModeOwner): void {
  closedOwners.add(ownerKey(owner))
}

/** Owns the actual host completion, not merely the VM return or launch receipt. */
export function registerCodeModeTask<T>(options: {
  owner: CodeModeOwner
  cellId: string
  generation: string
  description: string
  toolUseId?: string
  setAppState: SetAppState
  completion: Promise<CodeModeCompletion<T>>
  cancel: () => void | Promise<void>
}) {
  const { setAppState, owner: inputOwner, cellId, generation, description, toolUseId, completion } = options
  let cancelAction: (() => void | Promise<void>) | undefined = options.cancel
  if (closedOwners.has(ownerKey(inputOwner))) throw new Error('Code Mode owner is closed')
  if (inputOwner.agentId && !inputOwner.workerRunId) throw new Error('Worker Code Mode tasks require a worker incarnation')
  if ([...runs.values()].some(run => sameCodeModeOwner(run.owner, inputOwner) && run.cellId === cellId && run.generation === generation)) throw new Error('Code Mode cell is already owned')
  const id = generateTaskId('code_mode')
  const owner = Object.freeze({ ...inputOwner })
  let outcome: CodeModeCompletion<T> | undefined
  let failure: unknown
  let delivery: Promise<void> | undefined
  let cancellation: Promise<void> | undefined
  let settled = false
  let cancellationRequested = false
  let delivered = false
  let deliveryAccepted = false
  const update = (f: (state: CodeModeTaskState) => CodeModeTaskState) => updateTaskState(id, setAppState, f)
  const initialTask: CodeModeTaskState = { ...createTaskStateBase(id, 'code_mode', description, toolUseId), type: 'code_mode', status: 'running', owner, cellId, generation, cancellationRequested: false, settled: false, delivery: 'pending' }
  registerTask(initialTask, setAppState)
  const done = completion.then(value => {
    if (value.result.cellId !== cellId || value.result.generation !== generation) throw new Error('Code Mode completion identity mismatch')
    if (value.result.status === 'running') throw new Error('Host completion must be settled')
    outcome = { result: structuredClone(value.result), value: value.value }
    const receipt = structuredClone(value.result)
    update(state => ({ ...state, receipt, settled: true, endTime: Date.now(), status: receipt.status === 'completed' || receipt.status === 'yielded' ? 'completed' : receipt.status === 'cancelled' ? 'killed' : 'failed' }))
  }).catch(error => {
    failure = error
    update(state => ({ ...state, settled: true, status: 'failed', endTime: Date.now(), error: String(error) }))
  }).finally(() => {
    settled = true
  })
  const cancel = async () => {
    if (settled) return
    if (cancellation) return cancellation
    update(state => state.settled || state.cancellationRequested ? state : { ...state, cancellationRequested: true })
    cancellationRequested = true
    cancellation = Promise.resolve().then(() => cancelAction?.())
    await cancellation
  }
  const handle = {
    taskId: id,
    settled: done,
    updateReceipt(receipt: CodeModeResult) {
      if (receipt.cellId !== cellId || receipt.generation !== generation) throw new Error('Code Mode receipt identity mismatch')
      if (settled) return
      const snapshot = structuredClone(receipt)
      update(state => state.settled ? state : { ...state, receipt: snapshot })
    },
    /** Retry-scoped: successful delivery archives selected output and releases this payload. */
    getOutcome: () => outcome && { ...outcome, result: structuredClone(outcome.result) },
    getFailure: () => failure,
    cancel,
    /** Delivery must resolve only after the caller durably records the exact outcome. Failure is retryable without executing the cell again. */
    deliver(deliver: (outcome: CodeModeCompletion<T>) => Promise<void>, deliverFailure?: (error: unknown) => Promise<void>): Promise<void> {
      if (delivered) return Promise.resolve()
      if (delivery) return delivery
      delivery = done.then(async () => {
        update(state => ({ ...state, delivery: 'delivering', deliveryError: undefined }))
        // Persist only selected model output. Full audit belongs to the durable host
        // sink, not an indefinitely retained task row or the TaskOutput artifact.
        const selected = projectCodeModeTaskOutput({
          ...initialTask, receipt: outcome?.result, status: 'failed',
          settled: true, cancellationRequested, delivery: 'delivered',
        })
        if (!deliveryAccepted) {
          if (outcome) await deliver({ ...outcome, result: structuredClone(outcome.result) })
          else if (deliverFailure) await deliverFailure(failure)
          else throw new Error('Host did not produce a final receipt; a durable failure sink is required', { cause: failure })
          deliveryAccepted = true
        }
        const archiveIntegrity = await archiveSelectedOutput(initialTask.outputFile, JSON.stringify(selected))
        // Eager compaction gives all worker incarnations the same bound: zero
        // full delivered payloads in AppState, regardless of task count.
        update(state => ({ ...state, delivery: 'delivered', outputArchived: true, archiveIntegrity, receipt: undefined, deliveryError: undefined, error: state.error ? 'Code Mode host execution failed.' : undefined }))
        runs.delete(id)
        delivered = true
        outcome = undefined
        failure = undefined
        cancelAction = undefined
        cancellation = undefined
      }).catch(error => {
        update(state => ({ ...state, delivery: 'failed', deliveryError: String(error) }))
        delivery = undefined
        throw error
      })
      return delivery
    },
  }
  runs.set(id, { owner, cellId, generation, cancel, done, deliver: (sink, failureSink) => handle.deliver(sink, failureSink) })
  return handle
}

/** Finalizers must await settlement AND invoke durable delivery before releasing the host. */
export async function drainCodeModeTasks(owner: CodeModeOwner, deliver: (taskId: string, outcome: CodeModeCompletion<unknown>) => Promise<void>, cancel = false, deliverFailure?: (taskId: string, error: unknown) => Promise<void>): Promise<void> {
  closeCodeModeOwner(owner)
  const owned = [...runs.entries()].filter(([, run]) => sameCodeModeOwner(run.owner, owner))
  await Promise.all(owned.map(async ([id, run]) => {
    if (cancel) await run.cancel()
    await run.done
    await run.deliver(outcome => deliver(id, outcome), deliverFailure && (error => deliverFailure(id, error)))
  }))
}

export const CodeModeTask: Task = {
  name: 'Code Mode', type: 'code_mode',
  async kill(taskId) {
    const run = runs.get(taskId)
    if (!run) throw new Error(`No owned Code Mode run: ${taskId}`)
    await run.cancel()
  },
}
