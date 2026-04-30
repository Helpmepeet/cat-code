import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import type { SystemMessage } from '../../types/message.js'

type Props = {
  message: SystemMessage
}

export function SnipBoundaryMessage(_props: Props): React.ReactNode {
  const historyShortcut = useShortcutDisplay(
    'app:toggleTranscript',
    'Global',
    'ctrl+o',
  )

  return (
    <Box marginY={1}>
      <Text dimColor>
        ✻ Earlier conversation hidden ({historyShortcut} for history)
      </Text>
    </Box>
  )
}
