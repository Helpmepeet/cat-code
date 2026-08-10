/**
 * Child process for SendMessageTool.schemaGate.probe.test.ts. Prints the
 * JSON Schema for the `message` field of SendMessageTool's real inputSchema
 * (via the same zodToJsonSchema() the API request path uses) so the parent
 * can assert on what the model actually receives, not just on validateInput.
 *
 * The runtime imports beyond SendMessageTool.js/zodToJsonSchema.js mirror
 * SendMessageTool.test.ts's header. That is load-bearing, not decorative: a
 * narrower import list resolves this module graph in a different order and
 * trips an unrelated pre-existing circular-import TDZ in
 * services/compact/microCompact.ts (`GREP_TOOL_NAME` used before init),
 * independent of Agent Teams or anything this probe touches.
 */
import { test, expect } from 'bun:test'
import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../../bootstrap/state.js'
import { recipientNameKey } from '../../utils/recipientIdentity.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { clearDynamicTeamContext, setDynamicTeamContext } from '../../utils/teammate.js'
import * as teammateMailbox from '../../utils/teammateMailbox.js'
import {
  getInboxPath,
  MailboxWriteError,
  readMailbox,
} from '../../utils/teammateMailbox.js'
import { getTranscriptPathForSession } from '../../utils/sessionStorage.js'
import { createAgentId } from '../../utils/uuid.js'
import { isDeferredTool } from '../ToolSearchTool/prompt.js'
import * as resumeAgentModule from '../AgentTool/resumeAgent.js'
import * as resolveAgentTargetModule from '../AgentTool/resolveAgentTarget.js'
import { SendMessageTool } from './SendMessageTool.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { SCHEMA_MESSAGE_JSON_PREFIX } from './schemaGateProbeConstants.js'

test('dump the message field JSON Schema for the parent probe to assert on', () => {
  // Referenced only to preserve the working import order documented above.
  void [
    getSessionId,
    getSessionProjectDir,
    switchSession,
    recipientNameKey,
    TEAM_LEAD_NAME,
    clearDynamicTeamContext,
    setDynamicTeamContext,
    teammateMailbox,
    getInboxPath,
    MailboxWriteError,
    readMailbox,
    getTranscriptPathForSession,
    createAgentId,
    isDeferredTool,
    resumeAgentModule,
    resolveAgentTargetModule,
  ]

  const schema = zodToJsonSchema(SendMessageTool.inputSchema) as {
    properties: { message: unknown }
  }
  process.stdout.write(
    `${SCHEMA_MESSAGE_JSON_PREFIX}${JSON.stringify(schema.properties.message)}\n`,
  )
  expect(schema.properties.message).toBeDefined()
})
