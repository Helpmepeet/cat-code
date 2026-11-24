import * as React from 'react';
import { Box, Text } from '../../ink.js';
import type { ToolProgressData } from '../../Tool.js';
import type { ProgressMessage } from '../../types/message.js';
import { getEnterWorktreeResultCopy } from '../../utils/worktreeUxCopy.js';
import type { ThemeName } from '../../utils/theme.js';
import type { Output } from './EnterWorktreeTool.js';
export function renderToolUseMessage(input: { path?: string }): React.ReactNode {
  return input.path ? 'Entering existing worktree…' : 'Starting isolated attempt…';
}
export function renderToolResultMessage(output: Output, _progressMessagesForMessage: ProgressMessage<ToolProgressData>[], _options: {
  theme: ThemeName;
}): React.ReactNode {
  if (output.borrowed) return <Text>Entered {output.worktreePath}</Text>;
  const copy = getEnterWorktreeResultCopy();
  return <Box flexDirection="column">
      <Text>{copy.title}</Text>
      <Text dimColor>{copy.detail}</Text>
    </Box>;
}
