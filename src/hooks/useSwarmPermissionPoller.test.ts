import { afterEach, describe, expect, test } from 'bun:test'

import {
  clearAllPendingCallbacks,
  hasPermissionCallback,
  processMailboxPermissionResponse,
  registerPermissionCallback,
  unregisterPermissionCallback,
} from './useSwarmPermissionPoller.js'
import { consumeTrustedSedEditApproval } from '../tools/BashTool/sedEditCapability.js'
import { clearUserApprovalReceipts } from '../services/tools/toolInputSecurity.js'

afterEach(() => {
  clearAllPendingCallbacks()
  clearUserApprovalReceipts('tool-use-1')
  clearUserApprovalReceipts('tool-use-sed-edit')
  clearUserApprovalReceipts('expected-tool-use')
})

describe('swarm permission callback registry', () => {
  test('removes an aborted worker request so a late leader reply cannot claim it', () => {
    const requestId = 'permission-aborted-before-response'
    registerPermissionCallback({
      requestId,
      toolName: 'Bash',
      toolUseId: 'tool-use-1',
      onAllow() {},
      onReject() {},
    })

    unregisterPermissionCallback(requestId)

    expect(hasPermissionCallback(requestId)).toBe(false)
  })

  test('binds transferred SedEdit authority to the pending tool-use identity', () => {
    const input = { command: 'sed -i s/a/b/ file' }
    let received: unknown
    const expectedPreview = {
      toolUseID: 'tool-use-sed-edit',
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
    let approvalExpected = false
    registerPermissionCallback({
      requestId: 'permission-sed-edit',
      toolName: 'Bash',
      toolUseId: 'tool-use-sed-edit',
      sedEditPreview: expectedPreview,
      expectSedEditApproval() {
        approvalExpected = true
        return true
      },
      onAllow(updatedInput) {
        received = updatedInput
          ? consumeTrustedSedEditApproval(updatedInput, 'tool-use-sed-edit')
          : undefined
      },
      onReject() {},
    })

    expect(
      processMailboxPermissionResponse({
        requestId: 'permission-sed-edit',
        decision: 'approved',
        updatedInput: input,
        trustedSedEditApproval: {
          toolUseID: 'tool-use-sed-edit',
          command: input.command,
          filePath: '/previewed/file',
          previewId: 'preview-1',
          identity: expectedPreview.identity,
        },
      }),
    ).toBe(true)
    expect(approvalExpected).toBe(true)
    expect(received).toEqual({
      filePath: '/previewed/file',
      toolUseID: 'tool-use-sed-edit',
      command: input.command,
      previewId: 'preview-1',
      identity: expectedPreview.identity,
    })
  })

  test('does not register transferred authority for another tool-use ID', () => {
    const input = { command: 'sed -i s/a/b/ file' }
    let received: unknown
    let rejected = false
    registerPermissionCallback({
      requestId: 'permission-sed-edit-wrong-id',
      toolName: 'Bash',
      toolUseId: 'expected-tool-use',
      expectSedEditApproval() {
        return true
      },
      sedEditPreview: {
        toolUseID: 'expected-tool-use',
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
      },
      onAllow(updatedInput) {
        received = updatedInput
          ? consumeTrustedSedEditApproval(updatedInput, 'expected-tool-use')
          : undefined
      },
      onReject() {
        rejected = true
      },
    })

    processMailboxPermissionResponse({
      requestId: 'permission-sed-edit-wrong-id',
      decision: 'approved',
      updatedInput: input,
      trustedSedEditApproval: {
        toolUseID: 'different-tool-use',
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
      },
    })
    expect(received).toBeUndefined()
    expect(rejected).toBe(true)
  })

  test('generic approval does not expect the special preview capability', () => {
    const input = { command: 'sed -i s/a/b/ file' }
    let specialApprovalExpected = false
    let allowedInput: Record<string, unknown> | undefined
    registerPermissionCallback({
      requestId: 'permission-generic-allow',
      toolName: 'Bash',
      toolUseId: 'generic-tool-use',
      sedEditPreview: {
        toolUseID: 'generic-tool-use',
        command: input.command,
        filePath: '/previewed/file',
        previewId: 'not-approved-specially',
        identity: {
          canonicalPath: '/previewed/file',
          device: 1,
          inode: 2,
          size: 10,
          modifiedAtMs: 3,
          changedAtMs: 4,
        },
      },
      expectSedEditApproval() {
        specialApprovalExpected = true
        return true
      },
      onAllow(updatedInput) {
        allowedInput = updatedInput
      },
      onReject() {},
    })
    processMailboxPermissionResponse({
      requestId: 'permission-generic-allow',
      decision: 'approved',
      updatedInput: input,
      sedEditPreviewApproved: false,
    })
    expect(specialApprovalExpected).toBe(false)
    expect(allowedInput).toBe(input)
  })
})
