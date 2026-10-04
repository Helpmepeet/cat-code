import { describe, expect, test } from 'bun:test'
import {
  canExecuteDesktopNewChat,
  isDesktopNewChatCommand,
  mergeDesktopSlashCatalog,
} from './desktopChatCommands.js'

describe('desktop chat commands', () => {
  test('recognizes only a standalone clear or new draft', () => {
    expect(isDesktopNewChatCommand(' /clear\n')).toBe(true)
    expect(isDesktopNewChatCommand('/new')).toBe(true)
    expect(isDesktopNewChatCommand('/clear foo')).toBe(false)
    expect(isDesktopNewChatCommand('explain /clear')).toBe(false)
    expect(isDesktopNewChatCommand('/CLEAR')).toBe(false)
  })

  test('admits local chat creation independently of engine readiness', () => {
    const ready = {
      hasOrigin: true,
      hasQueuedPrompt: false,
      hasProjectRoute: false,
      workspaceBusy: false,
      preparingAttachment: false,
      managedFolderUnavailable: false,
      creationPending: false,
    }
    expect(canExecuteDesktopNewChat(ready)).toBe(true)
    expect(canExecuteDesktopNewChat({ ...ready, hasOrigin: false })).toBe(false)
    expect(canExecuteDesktopNewChat({ ...ready, hasQueuedPrompt: true })).toBe(false)
    expect(canExecuteDesktopNewChat({ ...ready, hasProjectRoute: true })).toBe(false)
    expect(canExecuteDesktopNewChat({ ...ready, workspaceBusy: true })).toBe(false)
    expect(canExecuteDesktopNewChat({ ...ready, preparingAttachment: true })).toBe(false)
    expect(canExecuteDesktopNewChat({ ...ready, managedFolderUnavailable: true })).toBe(false)
    expect(canExecuteDesktopNewChat({ ...ready, creationPending: true })).toBe(false)
  })

  test('adds desktop commands to rich and names-only catalogs without losing metadata', () => {
    const catalog = mergeDesktopSlashCatalog(
      [
        { name: 'help', description: 'Help text', argumentHint: '<topic>' },
        { name: 'clear', description: 'Engine description', argumentHint: '<old>' },
        { name: 'help', description: 'duplicate' },
      ],
      ['new', 'compact'],
    )
    expect(catalog).toEqual([
      { name: 'help', description: 'Help text', argumentHint: '<topic>' },
      { name: 'clear', description: 'Start a new chat.' },
      { name: 'new', description: 'Start a new chat.' },
    ])

    expect(mergeDesktopSlashCatalog([], ['help', 'compact'])).toEqual([
      { name: 'help', description: '' },
      { name: 'compact', description: '' },
      { name: 'clear', description: 'Start a new chat.' },
      { name: 'new', description: 'Start a new chat.' },
    ])
  })
})
