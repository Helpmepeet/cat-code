import { feature } from 'bun:bundle'
import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { homedir } from 'os'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { ensureParserInitialized, getParserModule } from '../../utils/bash/bashParser.js'
import * as actualParser from '../../utils/bash/parser.js'
import { _resetForTesting } from '../../utils/permissions/autoModeState.js'
import { isCriticalRemovalPath, isDangerousRemovalPath } from '../../utils/permissions/pathValidation.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import * as yoloClassifier from '../../utils/permissions/yoloClassifier.js'
import { BashTool } from './BashTool.js'
import { bashToolHasPermission } from './bashPermissions.js'

// Run the shipped tree-sitter path as well as the legacy shell-quote path that
// dev builds still use to decide.
let legacyParse = false
beforeEach(async () => {
  _resetForTesting()
  await ensureParserInitialized()
  const parserModule = getParserModule()
  if (!parserModule) throw new Error('tree-sitter bash parser failed to load')
  await mock.module('src/utils/bash/parser.js', () => ({
    ...actualParser,
    parseCommandRaw: async (command: string) => command && !legacyParse ? parserModule.parse(command) : null,
  }))
})
afterEach(() => { legacyParse = false })
beforeAll(() => {
  ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??= { VERSION: 'test-version' }
})

function context(mode: ToolPermissionContext['mode'], allowRules: string[] = []): ToolUseContext {
  const toolPermissionContext: ToolPermissionContext = {
    mode,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: allowRules.length > 0 ? { localSettings: allowRules } : {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  }
  return {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext }),
    setAppState: () => {},
    options: { tools: [BashTool] },
    messages: [],
  } as unknown as ToolUseContext
}

const assistantMessage = { message: { id: 'fixture-message' } } as never
const critical = ['rm -rf /', 'rm -rf ~', 'rm -rf ~/*', 'rm -rf /*', 'rm -rf /usr', 'rmdir /etc']

describe('critical removal paths', () => {
  test('separates critical directories from ordinary glob removals', () => {
    const home = homedir()
    for (const path of ['/', '/*', home, `${home}/*`, '/usr', '/usr/', 'C:\\', 'C:\\Windows', 'C:\\*']) {
      expect(isCriticalRemovalPath(path)).toBe(true)
    }
    for (const path of ['/usr/local', `${home}/project/dist/*`, `${home}/project`, '/usr/local/*']) {
      expect(isCriticalRemovalPath(path)).toBe(false)
    }
    // The broader prompt-only check is unchanged.
    expect(isDangerousRemovalPath(`${home}/project/dist/*`)).toBe(true)
  })
})

describe('Auto refuses critical removals', () => {
  for (const legacy of [false, true]) {
    describe(legacy ? 'legacy parser' : 'tree-sitter parser', () => {
      beforeEach(() => { legacyParse = legacy })

      test('critical targets are denied in Auto, even with a matching allow rule', async () => {
        for (const command of critical) {
          for (const rules of [[], ['Bash(rm:*)', 'Bash(rmdir:*)']]) {
            const decision = await bashToolHasPermission({ command }, context('auto', rules))
            expect({ command, behavior: decision.behavior }).toEqual({ command, behavior: 'deny' })
          }
        }
      })

      test('other modes keep the explicit approval prompt', async () => {
        for (const mode of ['default', 'acceptEdits'] as const) {
          const decision = await bashToolHasPermission({ command: 'rm -rf /' }, context(mode))
          expect(decision.behavior).toBe('ask')
        }
      })

      test('a project glob removal stays reviewable in Auto', async () => {
        const decision = await bashToolHasPermission({ command: 'rm -rf dist/*' }, context('auto'))
        expect(decision.behavior).toBe('ask')
      })
    })
  }
})

// The classifier route exists only in builds with the auto-mode classifier.
const classifierBuild = feature('TRANSCRIPT_CLASSIFIER') ? true : false
describe.if(classifierBuild)('an allowing classifier cannot release a critical removal', () => {
  test('the classifier is never asked and the call is denied', async () => {
    const classify = spyOn(yoloClassifier, 'classifyYoloAction').mockResolvedValue({
      shouldBlock: false,
      reason: 'fixture allows everything',
      model: 'fixture',
    })
    try {
      const control = await hasPermissionsToUseTool(
        BashTool as never, { command: 'rm -rf /usr/local' }, context('auto'), assistantMessage, 'control',
      )
      // The control proves this fixture reaches the classifier and that it allows.
      expect(classify).toHaveBeenCalledTimes(1)
      expect(control.behavior).toBe('allow')

      for (const command of critical) {
        const decision = await hasPermissionsToUseTool(
          BashTool as never, { command }, context('auto'), assistantMessage, `critical-${command}`,
        )
        expect({ command, behavior: decision.behavior }).toEqual({ command, behavior: 'deny' })
      }
      expect(classify).toHaveBeenCalledTimes(1)
    } finally {
      classify.mockRestore()
    }
  })
})
