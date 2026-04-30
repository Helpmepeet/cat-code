import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import { CHANNEL_ARROW } from '../../constants/figures.js'
import { CHANNEL_TAG } from '../../constants/xml.js'
import { Box, Text } from '../../ink.js'
import type { MessageOrigin } from '../../types/message.js'
import { truncateToWidth } from '../../utils/format.js'

type Props = {
  addMargin: boolean
  param: TextBlockParam
  origin?: MessageOrigin
}

// Legacy transcript fallback: <channel source="..." user="..." chat_id="...">content</channel>
// Source is always first in the legacy XML form; new messages use typed origin metadata.
const CHANNEL_RE = new RegExp(
  `<${CHANNEL_TAG}\\s+source="([^"]+)"([^>]*)>\\n?([\\s\\S]*?)\\n?</${CHANNEL_TAG}>`,
)
const USER_ATTR_RE = /\buser="([^"]+)"/

function displayServerName(name: string): string {
  const i = name.lastIndexOf(':')
  return i === -1 ? name : name.slice(i + 1)
}

const TRUNCATE_AT = 60

function getChannelDisplayData(
  text: string,
  origin?: MessageOrigin,
): {
  source: string
  user?: string
  body: string
} | null {
  if (origin?.kind === 'channel') {
    return {
      source: origin.server,
      user: origin.user,
      body: text.trim().replace(/\s+/g, ' '),
    }
  }

  const m = CHANNEL_RE.exec(text)
  if (!m) return null

  const [, source, attrs, content] = m
  return {
    source,
    user: USER_ATTR_RE.exec(attrs ?? '')?.[1],
    body: (content ?? '').trim().replace(/\s+/g, ' '),
  }
}

export function UserChannelMessage({
  addMargin,
  param: { text },
  origin,
}: Props): React.ReactNode {
  const channel = getChannelDisplayData(text, origin)
  if (!channel) return null

  const truncated = truncateToWidth(channel.body, TRUNCATE_AT)
  const userSuffix = channel.user ? ` · ${channel.user}` : ''

  return (
    <Box marginTop={addMargin ? 1 : 0}>
      <Text>
        <Text color="suggestion">{CHANNEL_ARROW}</Text>{' '}
        <Text dimColor>
          {displayServerName(channel.source)}
          {userSuffix}:
        </Text>{' '}
        {truncated}
      </Text>
    </Box>
  )
}
