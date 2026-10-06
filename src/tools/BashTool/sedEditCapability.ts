import { isDeepStrictEqual } from 'util'
import type { ToolUseContext } from '../../Tool.js'
import type { LineEndingType } from '../../utils/fileRead.js'
import type { FileIdentity } from '../../utils/file.js'
import type { PreparedFileMutation } from '../../utils/fileAuthorization.js'
import type { SedEditInfo } from './sedEditParser.js'

export type TrustedSedEdit = {
  toolUseID: string
  command: string
  filePath: string
  previewId: string
  identity: FileIdentity
}

type Approval = {
  toolUseID: string
  command: string
  input: Record<string, unknown>
  edit: TrustedSedEdit
}

export type TrustedSedEditApprovalPayload = {
  toolUseID: string
  command: string
  filePath: string
  previewId: string
  identity: FileIdentity
}

export type TrustedSedEditPreviewChallenge = {
  toolUseID: string
  command: string
  filePath: string
  previewId: string
  identity: FileIdentity
}

export type PreparedSedEditPreview = {
  kind: 'sed-edit-preview'
  toolUseID: string
  command: string
  sedInfo: SedEditInfo
  filePath: string
  previewId: string
  identity: FileIdentity
  preparedMutation: PreparedFileMutation
  approvalExpected: boolean
  loadPreview(): Promise<{
    originalContent: string
    newContent: string
    encoding: BufferEncoding
    lineEndings: LineEndingType
  }>
  uiPreviewPromise?: Promise<SedEditPreviewForUI>
}

export type SedEditPreviewForUI = {
  kind: 'sed-edit-preview'
  toolUseID: string
  command: string
  sedInfo: SedEditInfo
  filePath: string
  previewId: string
  identity: FileIdentity
  originalContent: string
  newContent: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
  fileExists: true
}

function copyPreviewIdentity(identity: FileIdentity): FileIdentity {
  return {
    canonicalPath: identity.canonicalPath,
    device: identity.device,
    inode: identity.inode,
    size: identity.size,
    modifiedAtMs: identity.modifiedAtMs,
    changedAtMs: identity.changedAtMs,
    ...(identity.nativeFileId === undefined
      ? {}
      : { nativeFileId: identity.nativeFileId }),
  }
}

export function getSedEditPreviewChallenge(
  preview: PreparedSedEditPreview,
): TrustedSedEditPreviewChallenge {
  return {
    toolUseID: preview.toolUseID,
    command: preview.command,
    filePath: preview.filePath,
    previewId: preview.previewId,
    identity: copyPreviewIdentity(preview.identity),
  }
}

export function getSedEditPreviewForUI(
  preview: PreparedSedEditPreview,
): Promise<SedEditPreviewForUI> {
  return (preview.uiPreviewPromise ??= preview.loadPreview().then(content => ({
    kind: preview.kind,
    toolUseID: preview.toolUseID,
    command: preview.command,
    sedInfo: preview.sedInfo,
    filePath: preview.filePath,
    previewId: preview.previewId,
    identity: copyPreviewIdentity(preview.identity),
    ...content,
    fileExists: true,
  })))
}

export function isPreparedSedEditPreview(
  value: unknown,
): value is PreparedSedEditPreview {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'sed-edit-preview'
  )
}

export function markSedEditApprovalExpected(
  preview: PreparedSedEditPreview,
): void {
  preview.approvalExpected = true
}

const approvedInputs = new WeakMap<object, Approval>()
const approvalsByToolUseID = new Map<string, Set<object>>()
const previewApprovalIntents = new Map<
  string,
  { input: Record<string, unknown>; payload?: TrustedSedEdit }
>()
const executionCapabilities = new WeakMap<
  object,
  { toolName: string; toolUseID: string; edit: TrustedSedEdit }
>()

export function registerTrustedSedEditApproval(
  input: Record<string, unknown>,
  toolUseID: string,
  edit: TrustedSedEdit,
): void {
  let inputSnapshot: Record<string, unknown>
  try {
    inputSnapshot = structuredClone(input)
  } catch {
    return
  }
  previewApprovalIntents.set(toolUseID, { input: inputSnapshot })
  if (
    typeof input.command !== 'string' ||
    edit.toolUseID !== toolUseID ||
    edit.command !== input.command ||
    edit.previewId.length === 0 ||
    edit.identity.canonicalPath !== edit.filePath
  ) {
    return
  }
  const existing = approvedInputs.get(input)
  if (existing) forgetApproval(input, existing.toolUseID)
  approvedInputs.set(input, {
    toolUseID,
    command: input.command,
    input: structuredClone(input),
    edit: structuredClone(edit),
  })
  previewApprovalIntents.set(toolUseID, {
    input: inputSnapshot,
    payload: structuredClone(edit),
  })
  const inputs = approvalsByToolUseID.get(toolUseID) ?? new Set<object>()
  inputs.add(input)
  approvalsByToolUseID.set(toolUseID, inputs)
}

function forgetApproval(input: object, toolUseID: string): void {
  approvedInputs.delete(input)
  const inputs = approvalsByToolUseID.get(toolUseID)
  inputs?.delete(input)
  if (inputs?.size === 0) approvalsByToolUseID.delete(toolUseID)
}

export function consumeTrustedSedEditApproval(
  input: Record<string, unknown>,
  toolUseID: string,
): TrustedSedEdit | undefined {
  const approval = approvedInputs.get(input)
  if (approval) forgetApproval(input, approval.toolUseID)
  if (
    !approval ||
    approval.toolUseID !== toolUseID ||
    approval.command !== input.command ||
    !isDeepStrictEqual(approval.input, input)
  ) {
    return undefined
  }
  return { ...approval.edit }
}

export function clearTrustedSedEditApprovals(toolUseID: string): void {
  const inputs = approvalsByToolUseID.get(toolUseID)
  if (inputs) {
    for (const input of inputs) approvedInputs.delete(input)
    approvalsByToolUseID.delete(toolUseID)
  }
  previewApprovalIntents.delete(toolUseID)
}

export type TransferredSedEditApproval = {
  previewApproved: boolean
  payload?: TrustedSedEditApprovalPayload
}

export function takeTrustedSedEditApprovalForTransfer(
  input: Record<string, unknown>,
  toolUseID: string,
): TransferredSedEditApproval {
  const intent = previewApprovalIntents.get(toolUseID)
  previewApprovalIntents.delete(toolUseID)
  const approval = approvedInputs.get(input)
  if (approval) forgetApproval(input, approval.toolUseID)
  if (!intent) return { previewApproved: false }
  if (!isDeepStrictEqual(intent.input, input)) {
    return { previewApproved: true }
  }
  return {
    previewApproved: true,
    ...(intent.payload ? { payload: { ...intent.payload } } : {}),
  }
}

export function registerTransferredTrustedSedEditApproval(
  input: Record<string, unknown>,
  expectedToolUseID: string,
  payload: TrustedSedEditApprovalPayload,
  expectedPreview: TrustedSedEditPreviewChallenge | undefined,
): boolean {
  if (
    payload.toolUseID !== expectedToolUseID ||
    payload.command !== input.command ||
    expectedPreview === undefined ||
    payload.toolUseID !== expectedPreview.toolUseID ||
    payload.command !== expectedPreview.command ||
    payload.filePath !== expectedPreview.filePath ||
    payload.previewId !== expectedPreview.previewId ||
    !isDeepStrictEqual(payload.identity, expectedPreview.identity)
  ) {
    return false
  }
  registerTrustedSedEditApproval(input, expectedToolUseID, payload)
  return approvedInputs.has(input)
}

export function attachTrustedSedEditToExecution(
  context: ToolUseContext,
  toolName: string,
  toolUseID: string,
  edit: TrustedSedEdit,
): void {
  executionCapabilities.set(context, {
    toolName,
    toolUseID,
    edit: { ...edit },
  })
}

export function consumeTrustedSedEditForExecution(
  context: ToolUseContext,
): TrustedSedEdit | undefined {
  const capability = executionCapabilities.get(context)
  executionCapabilities.delete(context)
  if (
    capability?.toolName !== 'Bash' ||
    capability.toolUseID !== context.toolUseId
  ) {
    return undefined
  }
  return { ...capability.edit }
}

export function clearTrustedSedEditExecutionCapability(
  context: ToolUseContext,
): void {
  executionCapabilities.delete(context)
}
