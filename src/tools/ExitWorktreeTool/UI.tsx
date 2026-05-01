import * as React from 'react';
import { Box, Text } from '../../ink.js';
import type { ToolProgressData } from '../../Tool.js';
import type { ProgressMessage } from '../../types/message.js';
import type { ThemeName } from '../../utils/theme.js';
import { getExitWorktreeActionCopy } from '../../utils/worktreeUxCopy.js';
import type { Output } from './ExitWorktreeTool.js';
export function renderToolUseMessage(): React.ReactNode {
  return 'Finishing isolated attempt…';
}
export function renderToolResultMessage(output: Output, _progressMessagesForMessage: ProgressMessage<ToolProgressData>[], _options: {
  theme: ThemeName;
}): React.ReactNode {
  const copy = getExitWorktreeActionCopy(output.action);
  return <Box flexDirection="column">
      <Text>{copy.title}</Text>
      <Text dimColor>{copy.detail}</Text>
    </Box>;
}