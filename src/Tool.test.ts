import { describe, expect, test } from 'bun:test'
import { buildTool, findToolByName } from './Tool.js'
import { FilePatchTool } from './tools/FilePatchTool/FilePatchTool.js'
import {
  FILE_PATCH_TOOL_NAME,
  LEGACY_FILE_PATCH_TOOL_NAME,
} from './tools/FilePatchTool/constants.js'

describe('buildTool', () => {
  test('does not evaluate accessor properties at build time', () => {
    let schemaReads = 0
    const def = {
      name: 'AccessorProbe',
      get inputSchema() {
        schemaReads++
        return { probe: true }
      },
    }

    const tool = buildTool(def as never) as unknown as {
      inputSchema: { probe: boolean }
    }

    // The regression: spreading `def` reads this accessor during buildTool.
    // Tools call buildTool at module scope, so that means schema factories run
    // at import time — defeating lazySchema and crashing on import cycles when
    // a factory reads a feature gate whose module is still initializing.
    expect(schemaReads).toBe(0)

    expect(tool.inputSchema).toEqual({ probe: true })
    expect(schemaReads).toBe(1)
  })

  test('def overrides defaults, and omitted defaults still fill in', () => {
    const tool = buildTool({
      name: 'PrecedenceProbe',
      isReadOnly: () => true,
    } as never) as unknown as {
      isReadOnly: () => boolean
      isEnabled: () => boolean
      userFacingName: () => string
    }

    // Precedence must survive the switch from spread to defineProperties:
    // def wins over TOOL_DEFAULTS, and unset keys fall back to the default.
    expect(tool.isReadOnly()).toBe(true)
    expect(tool.isEnabled()).toBe(true)
    expect(tool.userFacingName()).toBe('PrecedenceProbe')
  })
})

describe('findToolByName', () => {
  test('resolves the historical patch name through the canonical tool alias', () => {
    expect(FilePatchTool.name).toBe(FILE_PATCH_TOOL_NAME)
    expect(FilePatchTool.aliases).toEqual([LEGACY_FILE_PATCH_TOOL_NAME])
    expect(findToolByName([FilePatchTool], LEGACY_FILE_PATCH_TOOL_NAME)).toBe(
      FilePatchTool,
    )
    expect(findToolByName([FilePatchTool], FILE_PATCH_TOOL_NAME)).toBe(
      FilePatchTool,
    )
  })
})
