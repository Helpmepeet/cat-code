import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<null> {
  if (!context.enterAgentModeSession) {
    onDone('Agent mode is not available in this session.')
    return null
  }

  const trimmedArgs = args.trim()

  try {
    await context.enterAgentModeSession()
    onDone('Started a fresh Agent mode session.', {
      display: 'system',
      nextInput: trimmedArgs || undefined,
      submitNextInput: trimmedArgs.length > 0,
    })
  } catch (error) {
    onDone(
      `Failed to start Agent mode: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  return null
}
