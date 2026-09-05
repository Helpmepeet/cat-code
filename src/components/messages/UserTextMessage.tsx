import { feature } from 'bun:bundle'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import {
  COMMAND_MESSAGE_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  TICK_TAG,
} from '../../constants/xml.js'
import type { MessageOrigin } from '../../types/message.js'
import type { TeammateMessageContract } from '../../utils/teammateMessage.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { isTaskNotificationText } from '../../utils/taskNotification.js'
import {
  extractTag,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
} from '../../utils/messages.js'
import { InterruptedByUser } from '../InterruptedByUser.js'
import { MessageResponse } from '../MessageResponse.js'
import { UserAgentNotificationMessage } from './UserAgentNotificationMessage.js'
import { UserBashInputMessage } from './UserBashInputMessage.js'
import { UserBashOutputMessage } from './UserBashOutputMessage.js'
import { UserCommandMessage } from './UserCommandMessage.js'
import { UserLocalCommandOutputMessage } from './UserLocalCommandOutputMessage.js'
import { UserMemoryInputMessage } from './UserMemoryInputMessage.js'
import { getPeerDisplay, UserPeerMessage } from './UserPeerMessage.js'
import { UserPlanMessage } from './UserPlanMessage.js'
import { UserPromptMessage } from './UserPromptMessage.js'
import { UserResourceUpdateMessage } from './UserResourceUpdateMessage.js'
import { UserTeammateMessage } from './UserTeammateMessage.js'

type Props = {
  addMargin: boolean
  param: TextBlockParam
  verbose: boolean
  planContent?: string
  isTranscriptMode?: boolean
  timestamp?: string
  teammateMessages?: TeammateMessageContract[]
  origin?: MessageOrigin
}

export function UserTextMessage({
  addMargin,
  param,
  verbose,
  planContent,
  isTranscriptMode,
  timestamp,
  teammateMessages,
  origin,
}: Props): React.ReactNode {
  if (param.text.trim() === NO_CONTENT_MESSAGE) {
    return null
  }

  if (planContent) {
    return <UserPlanMessage addMargin={addMargin} planContent={planContent} />
  }

  if (extractTag(param.text, TICK_TAG)) {
    return null
  }

  if (param.text.includes(`<${LOCAL_COMMAND_CAVEAT_TAG}>`)) {
    return null
  }

  if (
    param.text.startsWith('<bash-stdout') ||
    param.text.startsWith('<bash-stderr')
  ) {
    return <UserBashOutputMessage content={param.text} verbose={verbose} />
  }

  if (
    param.text.startsWith('<local-command-stdout') ||
    param.text.startsWith('<local-command-stderr')
  ) {
    return <UserLocalCommandOutputMessage content={param.text} />
  }

  if (
    param.text === INTERRUPT_MESSAGE ||
    param.text === INTERRUPT_MESSAGE_FOR_TOOL_USE
  ) {
    return (
      <MessageResponse height={1}>
        <InterruptedByUser />
      </MessageResponse>
    )
  }

  // Provenance decides this row, and it is decided before the body-shape
  // branches below because a peer body may quote any of the tags they match on.
  // Until this existed the only peer-aware branch sat behind
  // feature('UDS_INBOX'), which is in neither list in scripts/build.ts and so
  // is false in every build: every peer message fell through to
  // UserPromptMessage, and an exported transcript showed one as the operator's
  // own prompt with the model-facing envelope printed verbatim.
  const peer = getPeerDisplay(param.text, origin)
  if (peer) {
    return <UserPeerMessage addMargin={addMargin} peer={peer} />
  }

  if (feature('KAIROS_GITHUB_WEBHOOKS')) {
    if (param.text.startsWith('<github-webhook-activity>')) {
      const { UserGitHubWebhookMessage } =
        require('./UserGitHubWebhookMessage.js') as typeof import('./UserGitHubWebhookMessage.js')
      return <UserGitHubWebhookMessage addMargin={addMargin} param={param} />
    }
  }

  if (param.text.includes('<bash-input>')) {
    return <UserBashInputMessage addMargin={addMargin} param={param} />
  }

  if (param.text.includes(`<${COMMAND_MESSAGE_TAG}>`)) {
    return <UserCommandMessage addMargin={addMargin} param={param} />
  }

  if (param.text.includes('<user-memory-input>')) {
    return <UserMemoryInputMessage addMargin={addMargin} text={param.text} />
  }

  if (isAgentSwarmsEnabled() && teammateMessages) {
    return (
      <UserTeammateMessage
        addMargin={addMargin}
        param={param}
        isTranscriptMode={isTranscriptMode}
        messages={teammateMessages}
      />
    )
  }

  if (origin?.kind === 'task-notification' || isTaskNotificationText(param.text)) {
    return <UserAgentNotificationMessage addMargin={addMargin} param={param} origin={origin} />
  }

  if (
    param.text.includes('<mcp-resource-update') ||
    param.text.includes('<mcp-polling-update')
  ) {
    return <UserResourceUpdateMessage addMargin={addMargin} param={param} />
  }

  if (feature('FORK_SUBAGENT')) {
    if (param.text.includes('<fork-boilerplate>')) {
      const { UserForkBoilerplateMessage } =
        require('./UserForkBoilerplateMessage.js') as typeof import('./UserForkBoilerplateMessage.js')
      return <UserForkBoilerplateMessage addMargin={addMargin} param={param} />
    }
  }

  if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
    const isLegacyXmlChannelMessage = param.text.includes('<channel source="')
    if (origin?.kind === 'channel' || isLegacyXmlChannelMessage) {
      const { UserChannelMessage } =
        require('./UserChannelMessage.js') as typeof import('./UserChannelMessage.js')
      return (
        <UserChannelMessage addMargin={addMargin} param={param} origin={origin} />
      )
    }
  }

  return (
    <UserPromptMessage
      addMargin={addMargin}
      param={param}
      isTranscriptMode={isTranscriptMode}
      timestamp={timestamp}
    />
  )
}
