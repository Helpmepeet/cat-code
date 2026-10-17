import { expect, test } from 'bun:test'
// Loads the engine tool registry first, as the session controller does; the
// tool modules below form an import cycle when entered from AgentTool alone.
import '../../src/tools.js'
import { resolveAgentTools } from '../../src/tools/AgentTool/agentToolUtils.js'
import { GENERAL_PURPOSE_AGENT } from '../../src/tools/AgentTool/built-in/generalPurposeAgent.js'
import { FileReadTool } from '../../src/tools/FileReadTool/FileReadTool.js'
import { createAnnounceTool } from './announceTool.js'
import { createCreatePeerTool } from './createPeerTool.js'
import { createListPeersTool } from './listPeersTool.js'
import type { PeerHostRequester } from './peerHostRequester.js'
import { createReadPeerTool } from './readPeerTool.js'
import { createSendToPeerTool } from './sendToPeerTool.js'
import { createWorkspaceJumpTools } from './workspaceJumpTools.js'

// Subagents that inherit the parent's list (forked skills and commands,
// in-process teammates) resolve it through resolveAgentTools. Session-level
// tools belong to the conversational agent, which passes peer knowledge on.
test('subagents never receive the desktop session tools from an inherited pool', () => {
  const requestHost = (async () => { throw new Error('no host in this test') }) as PeerHostRequester
  const sessionTools = [
    createListPeersTool(requestHost),
    createAnnounceTool(requestHost),
    createCreatePeerTool(requestHost),
    createSendToPeerTool(requestHost, { name: null, createdByName: null, createdById: null }),
    createReadPeerTool(requestHost),
    ...createWorkspaceJumpTools(requestHost, () => null).tools,
  ]
  const sessionNames = sessionTools.map(tool => tool.name)
  expect(sessionNames.sort()).toEqual([
    'Announce', 'CreatePeer', 'JumpWorkspace', 'ListPeers', 'ListWorkspaces', 'ReadPeer', 'SendToPeer',
  ])
  const parentPool = [FileReadTool, ...sessionTools]
  const customAgent = { tools: undefined, disallowedTools: undefined, source: 'userSettings' as const, permissionMode: undefined }
  const resolutions = [
    resolveAgentTools(GENERAL_PURPOSE_AGENT, parentPool, false),
    resolveAgentTools(GENERAL_PURPOSE_AGENT, parentPool, true),
    resolveAgentTools(customAgent, parentPool, false),
    resolveAgentTools(GENERAL_PURPOSE_AGENT, parentPool, true, 'in-process-teammate'),
  ]
  for (const { resolvedTools } of resolutions) {
    const names = resolvedTools.map(tool => tool.name)
    expect(names).toContain(FileReadTool.name)
    expect(names.filter(name => sessionNames.includes(name))).toEqual([])
  }
})
