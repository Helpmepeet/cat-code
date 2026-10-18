import { z } from '../../node_modules/zod/v4'
import { buildTool, type ToolDef } from '../../src/Tool.js'
import { lazySchema } from '../../src/utils/lazySchema.js'
import { getEffectiveAutoMode } from '../../src/utils/permissions/permissions.js'
import { parsePeerNoticeInput } from '../shared/peerNotice.js'
import { MAX_PEER_NOTICE_TOUCHES } from '../shared/limits.js'
import { describeHostRequestError, requestPeerHost, type PeerHostRequester } from './peerHostRequester.js'

const inputSchema = lazySchema(() => z.strictObject({
  doing: z.string().min(1).describe('One line: the task, and whether it may edit files.'),
  touches: z.array(z.string().min(1)).max(MAX_PEER_NOTICE_TOUCHES).optional().describe('Areas you expect to work in, such as folders or subsystems, plus shared files you already know you will edit. Include areas your subagents edit.'),
  note: z.string().optional().describe('Anything else that stays true for this whole task and that a peer working nearby should know.'),
}).refine(value => parsePeerNoticeInput(value) !== null, {
  message: 'Use one doing line and at most 1 KiB for the whole notice.',
}))

type InputSchema = ReturnType<typeof inputSchema>
type Output = { ok: true; postedAt: string; saved?: false; warning?: string } | { ok: false; message: string }

/** Main stores the conversational agent's aggregate scope, never a worker's slice. */
export function createAnnounceTool(requestHost: PeerHostRequester = requestPeerHost) {
  return buildTool({
    name: 'Announce',
    searchHint: 'post your scope on the peer roster',
    maxResultSizeChars: 2000,
    userFacingName: () => 'Announce',
    get inputSchema(): InputSchema { return inputSchema() },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async checkPermissions(input, context) {
      return getEffectiveAutoMode(context.getAppState().toolPermissionContext) !== null
        ? { behavior: 'ask' as const, message: 'Publish this scope notice?' }
        : { behavior: 'allow' as const, updatedInput: input }
    },
    toAutoClassifierInput: input => JSON.stringify(input),
    async description() { return 'Post or replace your scope notice on the peer roster' },
    async prompt() {
      return 'Post your notice on the peer roster when it would save peers asking what you are doing. Other sessions in this workspace see it when they call ListPeers; posting notifies no one. Describe the whole task, not your progress: post it once you know the task, and replace it only when you are given a different one. Only the main conversational agent may call this tool; subagents report their scope to it instead. The whole notice must fit in 1 KiB, with up to 16 entries in touches.'
    },
    async call(input, context): Promise<{ data: Output }> {
      if (context.agentId) return { data: { ok: false, message: 'Only the main conversational agent may post the session’s notice. Report your scope to it instead.' } }
      const notice = parsePeerNoticeInput(input)
      if (!notice) return { data: { ok: false, message: 'Use one non-empty doing line and at most 1 KiB for the whole notice.' } }
      const result = await requestHost('peer.announce', notice)
      return { data: result.ok
        ? { ok: true, postedAt: new Date(result.value.postedAt).toISOString(),
            ...(result.value.saved === false ? {
              saved: false as const,
              warning: 'Your notice is visible for this run but could not be saved. It may be lost if the app exits.',
            } : {}) }
        : { ok: false, message: describeHostRequestError(result.error) } }
    },
    mapToolResultToToolResultBlockParam(data, toolUseID) {
      return { type: 'tool_result', tool_use_id: toolUseID, content: JSON.stringify(data), ...(data.ok ? {} : { is_error: true }) }
    },
    renderToolUseMessage() { return null },
  } satisfies ToolDef<InputSchema, Output>)
}
