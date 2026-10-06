import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ToolUseContext } from '../../Tool.js'
import {
  createPermissionRequestMessage,
  createPermissionResponseMessage,
  PermissionRequestMessageSchema,
  PermissionResponseMessageSchema,
} from '../../utils/teammateMailbox.js'
import {
  attachTrustedSedEditToExecution,
  consumeTrustedSedEditApproval,
  getSedEditPreviewChallenge,
  isPreparedSedEditPreview,
  markSedEditApprovalExpected,
  registerTransferredTrustedSedEditApproval,
  registerTrustedSedEditApproval,
  type PreparedSedEditPreview,
} from './sedEditCapability.js'
import {
  createPermissionRequest,
  SwarmPermissionRequestSchema,
} from '../../utils/swarm/permissionSync.js'

const actualShell = await import('../../utils/Shell.js')
let mockedShellCalls = 0
mock.module('../../utils/Shell.js', () => ({
  ...actualShell,
  exec: async () => {
    mockedShellCalls++
    return {
      result: Promise.resolve({
        stdout: 'mocked shell result',
        stderr: '',
        code: 0,
        interrupted: false,
        exitAttribution: null,
      }),
      cleanup() {},
    }
  },
}))
const { BashTool } = await import('./BashTool.js')

const temporaryDirectories: string[] = []

afterEach(() => {
  mockedShellCalls = 0
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'sed-edit-capability-'))
  temporaryDirectories.push(directory)
  return directory
}

function shellContext(
  input: Record<string, unknown>,
  preview: PreparedSedEditPreview,
): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
    },
  }
  return {
    toolUseId: preview.toolUseID,
    abortController: new AbortController(),
    readFileState: new Map(),
    updateFileHistoryState: () => {},
    getAppState: () => appState,
    setAppState: () => {},
    preparedExecution: {
      toolName: BashTool.name,
      input,
      state: preview,
    },
  } as unknown as ToolUseContext
}

async function prepareApprovedCall(filePath: string) {
  const command = `sed -i '' 's/before/after/' ${filePath}`
  const input = BashTool.inputSchema.parse({ command })
  const toolUseID = `sed-use-${temporaryDirectories.length}`
  const baseContext = {
    toolUseId: toolUseID,
    abortController: new AbortController(),
    readFileState: new Map(),
    updateFileHistoryState: () => {},
  } as unknown as ToolUseContext
  const prepared = await BashTool.prepareExecution!(input as never, baseContext)
  if (!isPreparedSedEditPreview(prepared.state)) {
    await prepared.cleanup()
    throw new Error('Expected Bash to retain a prepared SedEdit target')
  }
  const preview: PreparedSedEditPreview = prepared.state
  markSedEditApprovalExpected(preview)
  await preview.loadPreview()
  registerTrustedSedEditApproval(
    input as Record<string, unknown>,
    toolUseID,
    getSedEditPreviewChallenge(preview),
  )
  const trusted = consumeTrustedSedEditApproval(
    input as Record<string, unknown>,
    toolUseID,
  )
  if (!trusted) {
    await prepared.cleanup()
    throw new Error('Expected an approval for the prepared SedEdit preview')
  }
  const executionContext = {
    ...baseContext,
    preparedExecution: {
      toolName: BashTool.name,
      input,
      state: preview,
    },
  }
  attachTrustedSedEditToExecution(
    executionContext,
    BashTool.name,
    toolUseID,
    trusted,
  )
  return {
    input,
    preview,
    executionContext: executionContext as ToolUseContext,
    cleanup: prepared.cleanup,
  }
}

describe('Bash SedEdit object-bound publication', () => {
  test('a real retained preview passes the closed mailbox request and response schemas', async () => {
    const root = temporaryDirectory()
    const filePath = join(root, 'target.txt')
    writeFileSync(filePath, 'before\n')
    const prepared = await prepareApprovedCall(filePath)
    try {
      const challenge = getSedEditPreviewChallenge(prepared.preview)
      const request = createPermissionRequestMessage({
        request_id: 'preview-request',
        agent_id: 'worker',
        tool_name: BashTool.name,
        tool_use_id: prepared.preview.toolUseID,
        description: 'Edit the requested file',
        input: prepared.input,
        trusted_sed_edit_preview: challenge,
      })
      const response = createPermissionResponseMessage({
        request_id: 'preview-request',
        subtype: 'success',
        updated_input: prepared.input,
        trusted_sed_edit_approval: challenge,
      })
      expect(PermissionRequestMessageSchema().safeParse(request).success).toBe(true)
      expect(PermissionResponseMessageSchema().safeParse(response).success).toBe(true)
    } finally {
      await prepared.cleanup()
    }
  })

  test('mailbox preview identity preserves an exact Windows file ID', () => {
    const identity = {
      canonicalPath: 'C:\\workspace\\target.txt',
      device: 1,
      inode: 2,
      size: 10,
      modifiedAtMs: 3,
      changedAtMs: 4,
      nativeFileId: '1:0000000000000002',
    }
    const preview = {
      toolUseID: 'windows-preview',
      command: 'sed -i s/before/after/ target.txt',
      filePath: identity.canonicalPath,
      previewId: 'preview-1',
      identity,
    }
    const response = createPermissionResponseMessage({
      request_id: 'windows-preview-request',
      subtype: 'success',
      updated_input: { command: preview.command },
      trusted_sed_edit_approval: preview,
    })
    const parsed = PermissionResponseMessageSchema().safeParse(response)
    expect(parsed.success).toBe(true)
    if (parsed.success && parsed.data.subtype === 'success') {
      expect(
        parsed.data.response?.trusted_sed_edit_approval?.identity.nativeFileId,
      ).toBe(identity.nativeFileId)
    }
    const request = createPermissionRequest({
      toolName: 'Bash',
      toolUseId: preview.toolUseID,
      input: { command: preview.command },
      description: 'Approve the prepared edit',
      teamName: 'sed-edit-team',
      workerId: 'worker-id',
      workerName: 'worker',
      trustedSedEditPreview: preview,
    })
    const parsedRequest = SwarmPermissionRequestSchema().safeParse(request)
    expect(parsedRequest.success).toBe(true)
    if (parsedRequest.success) {
      expect(
        parsedRequest.data.trustedSedEditPreview?.identity.nativeFileId,
      ).toBe(identity.nativeFileId)
    }
  })

  test('an ordinary approval while preview is visible follows the mocked shell path', async () => {
    const input = BashTool.inputSchema.parse({
      command: "sed -i '' 's/before/after/' /not-opened",
    })
    const preview = {
      kind: 'sed-edit-preview',
      toolUseID: 'ordinary-allow',
      command: input.command,
      previewId: 'visible-only',
      approvalExpected: false,
    } as unknown as PreparedSedEditPreview
    const result = await BashTool.call(
      input as never,
      shellContext(input, preview),
      undefined,
      undefined,
    )
    expect(mockedShellCalls).toBe(1)
    expect((result.data as { stdout: string }).stdout).toBe('mocked shell result')
  })

  test('an explicit preview approval without matching authority never falls back to shell', async () => {
    const input = BashTool.inputSchema.parse({
      command: "sed -i '' 's/before/after/' /not-opened",
    })
    const preview = {
      kind: 'sed-edit-preview',
      toolUseID: 'missing-authority',
      command: input.command,
      previewId: 'preview-was-approved',
      approvalExpected: true,
    } as unknown as PreparedSedEditPreview
    await expect(
      BashTool.call(
        input as never,
        shellContext(input, preview),
        undefined,
        undefined,
      ),
    ).rejects.toThrow()
    expect(mockedShellCalls).toBe(0)
  })

  test('applies the exact prepared preview to its retained file object', async () => {
    const root = temporaryDirectory()
    const filePath = join(root, 'target.txt')
    writeFileSync(filePath, 'before\n')
    const prepared = await prepareApprovedCall(filePath)
    try {
      await BashTool.call(
        prepared.input as never,
        prepared.executionContext,
        undefined,
        undefined,
      )
    } finally {
      await prepared.cleanup()
    }
    expect(readFileSync(filePath, 'utf8')).toBe('after\n')
  })

  test('a parent-directory swap cannot redirect publication to an outside file', async () => {
    const root = temporaryDirectory()
    const originalDirectory = join(root, 'work')
    const movedDirectory = join(root, 'work-retained')
    const outsideDirectory = join(root, 'outside')
    mkdirSync(originalDirectory)
    mkdirSync(outsideDirectory)
    const filePath = join(originalDirectory, 'target.txt')
    const outsidePath = join(outsideDirectory, 'target.txt')
    writeFileSync(filePath, 'before\n')
    writeFileSync(outsidePath, 'outside bytes\n')

    const prepared = await prepareApprovedCall(filePath)
    renameSync(originalDirectory, movedDirectory)
    symlinkSync(outsideDirectory, originalDirectory)

    let executed = false
    try {
      await BashTool.call(
        prepared.input as never,
        prepared.executionContext,
        undefined,
        undefined,
      )
      executed = true
    } catch {
      // A changed path may be rejected; it must never retarget the prepared object.
    } finally {
      await prepared.cleanup()
    }

    expect(readFileSync(outsidePath, 'utf8')).toBe('outside bytes\n')
    const retainedContents = readFileSync(
      join(movedDirectory, 'target.txt'),
      'utf8',
    )
    expect(retainedContents).toBe(
      executed ? 'after\n' : 'before\n',
    )
  })

  test('a version change after preview refuses publication', async () => {
    const root = temporaryDirectory()
    const filePath = join(root, 'target.txt')
    writeFileSync(filePath, 'before\n')
    const prepared = await prepareApprovedCall(filePath)
    writeFileSync(filePath, 'changed outside preview\n')

    try {
      await expect(
        BashTool.call(
          prepared.input as never,
          prepared.executionContext,
          undefined,
          undefined,
        ),
      ).rejects.toThrow()
    } finally {
      await prepared.cleanup()
    }

    expect(readFileSync(filePath, 'utf8')).toBe('changed outside preview\n')
  })

  test('a capability for another preview identity cannot write the retained target', async () => {
    const root = temporaryDirectory()
    const filePath = join(root, 'target.txt')
    writeFileSync(filePath, 'before\n')
    const prepared = await prepareApprovedCall(filePath)
    const wrongIdentity = {
      ...getSedEditPreviewChallenge(prepared.preview),
      identity: {
        ...prepared.preview.identity,
        inode: prepared.preview.identity.inode + 1,
      },
    }
    attachTrustedSedEditToExecution(
      prepared.executionContext,
      BashTool.name,
      prepared.preview.toolUseID,
      wrongIdentity,
    )
    try {
      await expect(
        BashTool.call(
          prepared.input as never,
          prepared.executionContext,
          undefined,
          undefined,
        ),
      ).rejects.toThrow()
    } finally {
      await prepared.cleanup()
    }
    expect(readFileSync(filePath, 'utf8')).toBe('before\n')
  })

  test('ordinary preparation retains metadata without eagerly reading preview bytes', async () => {
    const root = temporaryDirectory()
    const filePath = join(root, 'target.txt')
    writeFileSync(filePath, 'before\n')
    const command = `sed -i '' 's/before/after/' ${filePath}`
    const input = BashTool.inputSchema.parse({ command })
    const prepared = await BashTool.prepareExecution!(
      input as never,
      {
        toolUseId: 'sed-lazy-preview',
        abortController: new AbortController(),
      } as never,
    )
    if (!isPreparedSedEditPreview(prepared.state)) {
      throw new Error('Expected a prepared SedEdit target')
    }
    writeFileSync(filePath, 'changed before preview load\n')
    try {
      await expect(prepared.state.loadPreview()).rejects.toThrow()
    } finally {
      await prepared.cleanup()
    }
    expect(readFileSync(filePath, 'utf8')).toBe('changed before preview load\n')
  })

  test('approval replay and wrong file identity do not grant SedEdit authority', () => {
    const input = {
      command: 'sed -i s/before/after/ /previewed/file',
    }
    const trusted = {
      toolUseID: 'sed-replay',
      command: input.command,
      filePath: '/previewed/file',
      previewId: 'preview-1',
      identity: {
        canonicalPath: '/previewed/file',
        device: 1,
        inode: 2,
        size: 10,
        modifiedAtMs: 3,
        changedAtMs: 4,
      },
    }
    registerTrustedSedEditApproval(input, 'sed-replay', trusted)
    expect(
      consumeTrustedSedEditApproval(input, 'different-tool-use'),
    ).toBeUndefined()
    expect(consumeTrustedSedEditApproval(input, 'sed-replay')).toBeUndefined()

    registerTransferredTrustedSedEditApproval(
      input,
      'sed-replay',
      trusted,
      {
        ...trusted,
        identity: { ...trusted.identity, inode: 99 },
      },
    )
    expect(consumeTrustedSedEditApproval(input, 'sed-replay')).toBeUndefined()
  })
})
