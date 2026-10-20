import { describe, expect, test } from 'bun:test'
import type { Tool } from '../../Tool.js'
import { CreateGoalTool } from '../CreateGoalTool/CreateGoalTool.js'
import { GenerateImageTool } from '../GenerateImageTool/GenerateImageTool.js'
import { GetGoalTool } from '../GetGoalTool/GetGoalTool.js'
import { UpdateGoalTool } from '../UpdateGoalTool/UpdateGoalTool.js'
import { isDeferredTool } from './prompt.js'
import { ToolSearchTool } from './ToolSearchTool.js'

const goalTools = [CreateGoalTool, GetGoalTool, UpdateGoalTool] as unknown as Tool[]

function search(tools: Tool[], query: string) {
  return ToolSearchTool.call(
    { query, max_results: 5 },
    { options: { tools }, getAppState: () => ({ mcp: { clients: [] } }) } as never,
  )
}

describe('ToolSearchTool', () => {
  test('goal and image tools load through tool search', () => {
    for (const tool of [...goalTools, GenerateImageTool as unknown as Tool]) {
      expect(isDeferredTool(tool)).toBe(true)
    }
  })

  test('a bare alias resolves to its tool, as the goal prompts name it', async () => {
    expect((await search(goalTools, 'update_goal')).data.matches).toEqual(['UpdateGoal'])
    expect((await search(goalTools, 'CREATE_GOAL')).data.matches).toEqual(['CreateGoal'])
  })
})
