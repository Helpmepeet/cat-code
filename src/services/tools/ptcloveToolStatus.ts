import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import type { ToolUseContext } from '../../Tool.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'

type PtcloveToolDescription = {
  name: string
  summary: string
  targetPath?: string
}

export type PtcloveToolStatusTracker = {
  start: (block: ToolUseBlock) => void
  complete: (toolUseID: string) => void
  clear: () => void
}

export function createPtcloveToolStatusTracker(
  toolUseContext: ToolUseContext,
): PtcloveToolStatusTracker {
  const activeTools = new Map<string, PtcloveToolDescription>()

  function latestActiveTool():
    | { toolUseID: string; description: PtcloveToolDescription }
    | null {
    let latest: { toolUseID: string; description: PtcloveToolDescription } | null =
      null
    for (const [toolUseID, description] of activeTools) {
      latest = { toolUseID, description }
    }
    return latest
  }

  return {
    start(block) {
      const description = describeToolForPtclove(block)
      activeTools.set(block.id, description)
      toolUseContext.setAppState(prev => ({
        ...prev,
        ptcloveCurrentTool: {
          ...description,
          toolUseID: block.id,
        },
      }))
    },
    complete(toolUseID) {
      activeTools.delete(toolUseID)
      toolUseContext.setAppState(prev => {
        if (prev.ptcloveCurrentTool?.toolUseID !== toolUseID) return prev
        const replacement = latestActiveTool()
        return {
          ...prev,
          ptcloveCurrentTool: replacement
            ? {
                ...replacement.description,
                toolUseID: replacement.toolUseID,
              }
            : null,
        }
      })
    },
    clear() {
      const activeToolIDs = new Set(activeTools.keys())
      activeTools.clear()
      toolUseContext.setAppState(prev =>
        prev.ptcloveCurrentTool &&
        activeToolIDs.has(prev.ptcloveCurrentTool.toolUseID)
          ? {
              ...prev,
              ptcloveCurrentTool: null,
            }
          : prev,
      )
    },
  }
}

function describeToolForPtclove(block: ToolUseBlock): PtcloveToolDescription {
  const input = isRecord(block.input) ? block.input : {}
  if (block.name === BASH_TOOL_NAME) {
    const command = stringField(input, 'command') ?? 'command'
    return {
      name: `Running ${command.split(/\s+/).slice(0, 3).join(' ')}`,
      summary: `Running ${command}`,
    }
  }

  const targetPath =
    stringField(input, 'file_path') ??
    stringField(input, 'path') ??
    stringField(input, 'notebook_path')
  if (targetPath) {
    const basename = targetPath.split('/').filter(Boolean).at(-1) ?? targetPath
    const verb = toolVerb(block.name)
    return {
      name: `${verb} ${basename}`,
      summary: `${verb} ${targetPath}`,
      targetPath,
    }
  }

  return {
    name: `Using ${block.name}`,
    summary: `Using ${block.name}`,
  }
}

function toolVerb(toolName: string): string {
  if (/write/i.test(toolName)) return 'Writing'
  if (/edit/i.test(toolName)) return 'Editing'
  if (/read/i.test(toolName)) return 'Reading'
  if (/grep|glob|search/i.test(toolName)) return 'Searching'
  return `Using ${toolName}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringField(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
