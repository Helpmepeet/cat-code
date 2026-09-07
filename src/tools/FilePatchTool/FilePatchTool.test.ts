import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'bun:test'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { getFileIdentity } from '../../utils/file.js'
import {
  getFsImplementation,
  setFsImplementation,
} from '../../utils/fsOperations.js'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../FileEditTool/constants.js'
import { FilePatchTool } from './FilePatchTool.js'
import { getFilePatchToolDescription } from './prompt.js'
import { FilePatchError, type FilePatchOperation } from './types.js'

const tempDirs: string[] = []
const realBeforeFileEdited = diagnosticTracker.beforeFileEdited
const originalFsImplementation = getFsImplementation()

afterEach(() => {
  diagnosticTracker.beforeFileEdited = realBeforeFileEdited
  setFsImplementation(originalFsImplementation)
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'file-patch-tool-'))
  tempDirs.push(dir)
  return dir
}

function callPatch(
  patch: string,
  readFileState = createFileStateCacheWithSizeLimit(10),
) {
  return FilePatchTool.call(
    { input: patch },
    {
      readFileState,
      updateFileHistoryState: () => undefined,
    } as never,
    undefined as never,
    { uuid: 'test-parent' } as never,
  )
}

// prepareFileMutation awaits an IDE round trip, a mkdir and a file-history
// write before the tool touches disk. Standing in for the first of those
// awaits lands an external write in exactly the window a concurrent editor,
// formatter or agent session would hit, with no sleep and no IDE connection.
function externalWriteDuringMutationPrep(
  onNthCall: number,
  write: () => void,
): void {
  let calls = 0
  diagnosticTracker.beforeFileEdited = async () => {
    calls += 1
    if (calls === onNthCall) {
      write()
    }
  }
}

const FIRST_ORIGINAL = 'alpha\nbeta\ngamma\n'
const FIRST_PATCHED = 'alpha\nbeta patched\ngamma\n'
const SECOND_ORIGINAL = 'one\ntwo\nthree\n'

function updateFirst(path: string): string {
  return `*** Update File: ${path}
@@
 alpha
-beta
+beta patched
 gamma
`
}

function updateSecond(path: string): string {
  return `*** Update File: ${path}
@@
 one
-two
+two patched
 three
`
}

function seedFullRead(
  path: string,
  content: string,
  overrides: Record<string, unknown> = {},
) {
  const readFileState = createFileStateCacheWithSizeLimit(10)
  readFileState.set(path, {
    content,
    timestamp: Math.floor(Date.now()),
    offset: 1,
    limit: undefined,
    isWriteAuthorizedRead: true,
    fileIdentity: getFileIdentity(path),
    ...overrides,
  })
  return readFileState
}

function validationContext(readFileState = createFileStateCacheWithSizeLimit(10)) {
  return {
    readFileState,
    getAppState: () => ({
      toolPermissionContext: {
        mode: 'default',
        additionalWorkingDirectories: new Map(),
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
        isBypassPermissionsModeAvailable: true,
      },
    }),
  } as never
}

describe('FilePatchTool concurrent write safety', () => {
  test('applies the patch when nothing else touches the file', async () => {
    const dir = makeTempDir()
    const filePath = join(dir, 'target.txt')
    writeFileSync(filePath, FIRST_ORIGINAL)

    await callPatch(
      `*** Begin Patch\n${updateFirst(filePath)}*** End Patch\n`,
    )

    expect(readFileSync(filePath, 'utf8')).toBe(FIRST_PATCHED)
  })

  test('uses the current snapshot when the read cache is stale', async () => {
    const dir = makeTempDir()
    const filePath = join(dir, 'stale-cache.txt')
    const current = 'alpha\nbeta from shell\ngamma\n'
    writeFileSync(filePath, current)

    const readFileState = createFileStateCacheWithSizeLimit(10)
    readFileState.set(filePath, {
      content: FIRST_ORIGINAL,
      timestamp: Math.floor(Date.now()) - 60_000,
      offset: 1,
      limit: undefined,
      isWriteAuthorizedRead: true,
      fileIdentity: getFileIdentity(filePath),
    })

    const validation = await FilePatchTool.validateInput(
      {
        ops: [
          {
            type: 'update',
            path: filePath,
            hunks: [
              {
                scopeHints: [],
                lines: [
                  { kind: 'context', text: 'alpha' },
                  { kind: 'delete', text: 'beta from shell' },
                  { kind: 'add', text: 'beta patched' },
                  { kind: 'context', text: 'gamma' },
                ],
                isEndOfFile: false,
                noNewlineAtEndOfFile: false,
              },
            ],
          },
        ],
      },
      validationContext(readFileState),
    )
    expect(validation.result).toBe(true)

    await callPatch(
      `*** Begin Patch
*** Update File: ${filePath}
@@
 alpha
-beta from shell
+beta patched
 gamma
*** End Patch
`,
      readFileState,
    )

    expect(readFileSync(filePath, 'utf8')).toBe(FIRST_PATCHED)
  })

  test('allows a current update after a same-session shell-style mutation', async () => {
    const dir = makeTempDir()
    const filePath = join(dir, 'shell-mutated.txt')
    writeFileSync(filePath, FIRST_ORIGINAL)
    const readFileState = seedFullRead(filePath, FIRST_ORIGINAL)

    writeFileSync(filePath, 'alpha\nbeta changed by shell\ngamma\n')
    await callPatch(
      `*** Begin Patch
*** Update File: ${filePath}
@@
 alpha
-beta changed by shell
+beta patched
 gamma
*** End Patch
`,
      readFileState,
    )

    expect(readFileSync(filePath, 'utf8')).toBe(FIRST_PATCHED)
  })

  test('fails when the current snapshot has no applicable anchor', async () => {
    const dir = makeTempDir()
    const filePath = join(dir, 'missing-anchor.txt')
    writeFileSync(filePath, 'alpha\nreplacement\ngamma\n')

    let error: unknown
    try {
      await callPatch(
        `*** Begin Patch
*** Update File: ${filePath}
@@
 alpha
-beta
+beta patched
 gamma
*** End Patch
`,
      )
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(FilePatchError)
    expect((error as FilePatchError).code).toBe('PATCH_ANCHOR_NOT_FOUND')
    expect((error as FilePatchError).message).toContain(
      'does not appear anywhere',
    )
    expect((error as FilePatchError).message).not.toContain('read cache')
    expect(readFileSync(filePath, 'utf8')).toBe('alpha\nreplacement\ngamma\n')
  })

  test('cache presence and eviction do not alter a current successful update', async () => {
    const dir = makeTempDir()
    const cachedPath = join(dir, 'cached.txt')
    const evictedPath = join(dir, 'evicted.txt')
    writeFileSync(cachedPath, FIRST_ORIGINAL)
    writeFileSync(evictedPath, FIRST_ORIGINAL)

    const cachedState = seedFullRead(cachedPath, FIRST_ORIGINAL)
    const evictedState = createFileStateCacheWithSizeLimit(1)
    evictedState.set(evictedPath, {
      content: 'unrelated cache entry',
      timestamp: Date.now(),
      offset: 1,
      limit: undefined,
      isWriteAuthorizedRead: true,
    })
    evictedState.set(join(dir, 'evicted-other.txt'), {
      content: 'another entry',
      timestamp: Date.now(),
      offset: 1,
      limit: undefined,
      isWriteAuthorizedRead: true,
    })

    const patchFor = (path: string) => `*** Begin Patch
*** Update File: ${path}
@@
 alpha
-beta
+beta patched
 gamma
*** End Patch
`
    await callPatch(patchFor(cachedPath), cachedState)
    await callPatch(patchFor(evictedPath), evictedState)

    expect(readFileSync(cachedPath, 'utf8')).toBe(FIRST_PATCHED)
    expect(readFileSync(evictedPath, 'utf8')).toBe(FIRST_PATCHED)
  })

  test('preserves the source line-ending style while publishing an update', async () => {
    const dir = makeTempDir()
    const filePath = join(dir, 'crlf.txt')
    writeFileSync(filePath, 'alpha\r\nbeta\r\ngamma\r\n')

    await callPatch(`*** Begin Patch
*** Update File: ${filePath}
@@
 alpha
-beta
+beta patched
 gamma
*** End Patch
`)

    expect(readFileSync(filePath, 'utf8')).toBe(
      'alpha\r\nbeta patched\r\ngamma\r\n',
    )
  })

  // The re-read compares against the read-only phase's snapshot, and these two
  // shapes have no snapshot entry (a move destination) or an absent one (an
  // add), so they are where a wrong comparison would reject valid work.
  test('still adds a new file and still moves one', async () => {
    const dir = makeTempDir()
    const sourcePath = join(dir, 'source.txt')
    const movedPath = join(dir, 'nested', 'moved.txt')
    const addedPath = join(dir, 'added.txt')
    writeFileSync(sourcePath, FIRST_ORIGINAL)

    await callPatch(`*** Begin Patch
*** Update File: ${sourcePath}
*** Move to: ${movedPath}
@@
 alpha
-beta
+beta patched
 gamma
*** Add File: ${addedPath}
+created
*** End Patch
`)

    expect(readFileSync(movedPath, 'utf8')).toBe(FIRST_PATCHED)
    expect(readFileSync(addedPath, 'utf8')).toBe('created\n')
    expect(() => readFileSync(sourcePath, 'utf8')).toThrow()
  })

  test('keeps a write that lands while the tool waits to mutate', async () => {
    const dir = makeTempDir()
    const filePath = join(dir, 'target.txt')
    writeFileSync(filePath, FIRST_ORIGINAL)

    const external = 'alpha\nbeta rewritten elsewhere\ngamma\n'
    externalWriteDuringMutationPrep(1, () => writeFileSync(filePath, external))

    await expect(
      callPatch(`*** Begin Patch\n${updateFirst(filePath)}*** End Patch\n`),
    ).rejects.toThrow(FILE_UNEXPECTEDLY_MODIFIED_ERROR)

    // The patch was computed from the pre-write content, so applying it would
    // have silently discarded the external change.
    expect(readFileSync(filePath, 'utf8')).toBe(external)
  })

  test('rolls the already-written file back when a later file changes', async () => {
    const dir = makeTempDir()
    const firstPath = join(dir, 'first.txt')
    const secondPath = join(dir, 'second.txt')
    writeFileSync(firstPath, FIRST_ORIGINAL)
    writeFileSync(secondPath, SECOND_ORIGINAL)

    const external = 'one\ntwo rewritten elsewhere\nthree\n'
    externalWriteDuringMutationPrep(2, () =>
      writeFileSync(secondPath, external),
    )

    let error: unknown
    try {
      await callPatch(
        `*** Begin Patch\n${updateFirst(firstPath)}${updateSecond(
          secondPath,
        )}*** End Patch\n`,
      )
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(FilePatchError)
    expect((error as Error).message).toContain(
      FILE_UNEXPECTEDLY_MODIFIED_ERROR,
    )
    expect((error as FilePatchError).mutationOutcome).toBe('complete-rollback')
    expect((error as Error).message).not.toContain('No files were changed')
    expect(
      ((error as Error).message.match(/Patch changes were rolled back completely\./g) ??
        []),
    ).toHaveLength(1)
    expect(readFileSync(firstPath, 'utf8')).toBe(FIRST_ORIGINAL)
    expect(readFileSync(secondPath, 'utf8')).toBe(external)
  })

  test('preserves an intervening edit when recovery sees a changed file', async () => {
    const dir = makeTempDir()
    const filePath = join(dir, 'target.txt')
    writeFileSync(filePath, FIRST_ORIGINAL)
    const external = 'alpha\nedited during recovery\ngamma\n'
    const readFileState = createFileStateCacheWithSizeLimit(10)
    const originalSet = readFileState.set.bind(readFileState)
    let observerFailed = false
    readFileState.set = ((path, state) => {
      if (!observerFailed) {
        observerFailed = true
        writeFileSync(path, external)
        throw new Error('observer failed after publication')
      }
      return originalSet(path, state)
    }) as typeof readFileState.set

    let error: unknown
    try {
      await callPatch(
        `*** Begin Patch\n${updateFirst(filePath)}*** End Patch\n`,
        readFileState,
      )
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(FilePatchError)
    expect((error as FilePatchError).mutationOutcome).toBe(
      'incomplete-recovery',
    )
    expect((error as Error).message).not.toContain('No files were changed')
    expect(readFileSync(filePath, 'utf8')).toBe(external)
  })

  test('records a publication before a post-write observer can fail', async () => {
    const dir = makeTempDir()
    const filePath = join(dir, 'observer.txt')
    writeFileSync(filePath, FIRST_ORIGINAL)
    const readFileState = createFileStateCacheWithSizeLimit(10)
    const originalSet = readFileState.set.bind(readFileState)
    let observerFailed = false
    readFileState.set = ((path, state) => {
      if (!observerFailed) {
        observerFailed = true
        throw new Error('observer failed after publication')
      }
      return originalSet(path, state)
    }) as typeof readFileState.set

    let error: unknown
    try {
      await callPatch(
        `*** Begin Patch\n${updateFirst(filePath)}*** End Patch\n`,
        readFileState,
      )
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(FilePatchError)
    expect((error as FilePatchError).mutationOutcome).toBe(
      'complete-rollback',
    )
    expect(readFileSync(filePath, 'utf8')).toBe(FIRST_ORIGINAL)
  })

  test('preserves a replacement at a newly created path during recovery', async () => {
    const dir = makeTempDir()
    const filePath = join(dir, 'created.txt')
    const external = 'replacement from another writer\n'
    const readFileState = createFileStateCacheWithSizeLimit(10)
    const originalSet = readFileState.set.bind(readFileState)
    let observerFailed = false
    readFileState.set = ((path, state) => {
      if (!observerFailed) {
        observerFailed = true
        writeFileSync(path, external)
        throw new Error('observer failed after publication')
      }
      return originalSet(path, state)
    }) as typeof readFileState.set

    let error: unknown
    try {
      await callPatch(
        `*** Begin Patch\n*** Add File: ${filePath}\n+created\n*** End Patch\n`,
        readFileState,
      )
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(FilePatchError)
    expect((error as FilePatchError).mutationOutcome).toBe(
      'incomplete-recovery',
    )
    expect(readFileSync(filePath, 'utf8')).toBe(external)
  })

  test('does not overwrite a file that reappears while restoring a deletion', async () => {
    const dir = makeTempDir()
    const filePath = join(dir, 'deleted.txt')
    writeFileSync(filePath, 'original\n')
    const external = 'replacement after deletion\n'
    const readFileState = createFileStateCacheWithSizeLimit(10)
    readFileState.set(filePath, {
      content: 'original\n',
      timestamp: Math.floor(Date.now()),
      offset: 1,
      limit: undefined,
      isWriteAuthorizedRead: true,
      fileIdentity: getFileIdentity(filePath),
    })
    const originalDelete = readFileState.delete.bind(readFileState)
    let observerFailed = false
    readFileState.delete = path => {
      if (!observerFailed) {
        observerFailed = true
        writeFileSync(path, external)
        throw new Error('observer failed after deletion')
      }
      return originalDelete(path)
    }

    let error: unknown
    try {
      await callPatch(
        `*** Begin Patch\n*** Delete File: ${filePath}\n*** End Patch\n`,
        readFileState,
      )
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(FilePatchError)
    expect((error as FilePatchError).mutationOutcome).toBe(
      'incomplete-recovery',
    )
    expect(readFileSync(filePath, 'utf8')).toBe(external)
  })

  test('requires a complete model-visible read for a bare delete', async () => {
    const dir = makeTempDir()
    const filePath = join(dir, 'unread.txt')
    writeFileSync(filePath, 'content\n')

    const result = await FilePatchTool.validateInput(
      { ops: [{ type: 'delete', path: filePath }] },
      validationContext(),
    )

    expect(result.result).toBe(false)
    expect((result as { meta?: { code?: string } }).meta?.code).toBe(
      'PATCH_DELETE_REQUIRES_FULL_READ',
    )
  })

  test('rejects partial and stale bare-delete read identities', async () => {
    const dir = makeTempDir()
    const partialPath = join(dir, 'partial.txt')
    const stalePath = join(dir, 'stale.txt')
    writeFileSync(partialPath, 'partial\n')
    writeFileSync(stalePath, 'before\n')

    const partialState = seedFullRead(partialPath, 'partial\n', {
      isPartialView: true,
    })
    const partialResult = await FilePatchTool.validateInput(
      { ops: [{ type: 'delete', path: partialPath }] },
      validationContext(partialState),
    )
    expect(partialResult.result).toBe(false)
    expect(
      (partialResult as { meta?: { code?: string } }).meta?.code,
    ).toBe('PATCH_DELETE_REQUIRES_FULL_READ')

    const staleState = seedFullRead(stalePath, 'before\n')
    writeFileSync(stalePath, 'after\n')
    const staleResult = await FilePatchTool.validateInput(
      { ops: [{ type: 'delete', path: stalePath }] },
      validationContext(staleState),
    )
    expect(staleResult.result).toBe(false)
    expect((staleResult as { meta?: { code?: string } }).meta?.code).toBe(
      'PATCH_SNAPSHOT_CONFLICT',
    )

    let error: unknown
    try {
      await callPatch(
        `*** Begin Patch
*** Delete File: ${stalePath}
*** End Patch
`,
        staleState,
      )
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(FilePatchError)
    expect((error as FilePatchError).code).toBe('PATCH_SNAPSHOT_CONFLICT')
    expect(existsSync(stalePath)).toBe(true)
  })

  test('deletes after an exact complete read and identity recheck', async () => {
    const dir = makeTempDir()
    const filePath = join(dir, 'delete.txt')
    writeFileSync(filePath, 'content\n')
    const readFileState = seedFullRead(filePath, 'content\n')

    await callPatch(
      `*** Begin Patch
*** Delete File: ${filePath}
*** End Patch
`,
      readFileState,
    )

    expect(existsSync(filePath)).toBe(false)
  })

  test('validates the actual resulting settings content before writing', async () => {
    const dir = makeTempDir()
    const settingsDir = join(dir, '.claude')
    mkdirSync(settingsDir)
    const filePath = join(settingsDir, 'settings.json')
    writeFileSync(filePath, '{}\n')

    let error: unknown
    try {
      await callPatch(`*** Begin Patch
*** Update File: ${filePath}
@@
-{}
+{"unknownSetting":true}
*** End Patch
`)
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(FilePatchError)
    expect((error as FilePatchError).code).toBe('SETTINGS_VALIDATION_FAILED')
    expect((error as FilePatchError).mutationOutcome).toBe('no-mutation')
    expect(readFileSync(filePath, 'utf8')).toBe('{}\n')
  })

  test('validates settings content at a new move destination', async () => {
    const dir = makeTempDir()
    const settingsDir = join(dir, '.claude')
    mkdirSync(settingsDir)
    const sourcePath = join(dir, 'source.txt')
    const destinationPath = join(settingsDir, 'settings.json')
    writeFileSync(sourcePath, '{"unknownSetting":true}\n')

    let error: unknown
    try {
      await callPatch(`*** Begin Patch
*** Update File: ${sourcePath}
*** Move to: ${destinationPath}
@@
-{"unknownSetting":true}
+{"unknownSetting":true}
*** End Patch
`)
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(FilePatchError)
    expect((error as FilePatchError).code).toBe('SETTINGS_VALIDATION_FAILED')
    expect(existsSync(destinationPath)).toBe(false)
    expect(readFileSync(sourcePath, 'utf8')).toBe('{"unknownSetting":true}\n')
  })

  test('validates the patched content before moving into settings', async () => {
    const dir = makeTempDir()
    const settingsDir = join(dir, '.claude')
    mkdirSync(settingsDir)
    const sourcePath = join(dir, 'source.txt')
    const destinationPath = join(settingsDir, 'settings.json')
    writeFileSync(sourcePath, '{}\n')

    const result = await FilePatchTool.validateInput(
      {
        input: `*** Begin Patch
*** Update File: ${sourcePath}
*** Move to: ${destinationPath}
@@
-{}
+{"unknownSetting":true}
*** End Patch
`,
      },
      validationContext(),
    )

    expect(result.result).toBe(false)
    expect(result.message).toContain('settings.json validation failed')
    expect(existsSync(destinationPath)).toBe(false)
  })

  test('checks a move destination before deleting its source', async () => {
    const dir = makeTempDir()
    const sourcePath = join(dir, 'source.txt')
    const destinationPath = join(dir, 'destination.txt')
    writeFileSync(sourcePath, FIRST_ORIGINAL)
    externalWriteDuringMutationPrep(1, () =>
      writeFileSync(destinationPath, 'appeared during move\n'),
    )

    await expect(
      callPatch(`*** Begin Patch
*** Update File: ${sourcePath}
*** Move to: ${destinationPath}
@@
 alpha
-beta
+beta patched
 gamma
*** End Patch
`),
    ).rejects.toThrow(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
    expect(readFileSync(sourcePath, 'utf8')).toBe(FIRST_ORIGINAL)
    expect(readFileSync(destinationPath, 'utf8')).toBe(
      'appeared during move\n',
    )
  })

  test('keeps the source when source deletion fails after destination publication', async () => {
    const dir = makeTempDir()
    const sourcePath = join(dir, 'source.txt')
    const destinationPath = join(dir, 'destination.txt')
    writeFileSync(sourcePath, FIRST_ORIGINAL)
    const originalFs = getFsImplementation()
    setFsImplementation({
      ...originalFs,
      async unlink(path) {
        if (path === sourcePath) {
          throw new Error('forced source deletion failure')
        }
        return originalFs.unlink(path)
      },
    })

    await expect(
      callPatch(`*** Begin Patch
*** Update File: ${sourcePath}
*** Move to: ${destinationPath}
@@
 alpha
-beta
+beta patched
 gamma
*** End Patch
`),
    ).rejects.toThrow('forced source deletion failure')
    expect(readFileSync(sourcePath, 'utf8')).toBe(FIRST_ORIGINAL)
    expect(() => readFileSync(destinationPath, 'utf8')).toThrow()
  })
})

describe('FilePatchTool operation independence', () => {
  function updateOperation(path: string): FilePatchOperation {
    return {
      type: 'update',
      path,
      hunks: [
        {
          scopeHints: [],
          lines: [
            { kind: 'context', text: 'old' },
            { kind: 'delete', text: 'old' },
            { kind: 'add', text: 'new' },
          ],
          isEndOfFile: false,
          noNewlineAtEndOfFile: false,
        },
      ],
    }
  }

  async function callError(
    ops: FilePatchOperation[],
  ): Promise<FilePatchError> {
    let error: unknown
    try {
      await FilePatchTool.call(
        { ops },
        {
          readFileState: createFileStateCacheWithSizeLimit(10),
          updateFileHistoryState: () => undefined,
        } as never,
        undefined,
        { uuid: 'test-parent' } as never,
      )
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(FilePatchError)
    return error as FilePatchError
  }

  test('rejects duplicate normalized paths and move chains', async () => {
    const dir = makeTempDir()
    const first = join(dir, 'first.txt')
    const second = join(dir, 'second.txt')
    const third = join(dir, 'third.txt')
    writeFileSync(first, 'old\n')
    writeFileSync(second, 'old\n')

    const duplicate = await callError([
      updateOperation(first),
      updateOperation(join(dir, '.', 'first.txt')),
    ])
    expect(duplicate.code).toBe('PATCH_OVERLAPPING_PATHS')

    const chain = await callError([
      { ...updateOperation(first), moveTo: second },
      { ...updateOperation(second), moveTo: third },
    ])
    expect(chain.code).toBe('PATCH_OVERLAPPING_PATHS')
    expect(readFileSync(first, 'utf8')).toBe('old\n')
    expect(readFileSync(second, 'utf8')).toBe('old\n')
  })

  test('rejects hard-link aliases to one existing filesystem object', async () => {
    const dir = makeTempDir()
    const first = join(dir, 'first.txt')
    const alias = join(dir, 'alias.txt')
    writeFileSync(first, 'old\n')
    linkSync(first, alias)

    const error = await callError([
      updateOperation(first),
      updateOperation(alias),
    ])
    expect(error.code).toBe('PATCH_ALIASED_PATHS')
    expect(readFileSync(first, 'utf8')).toBe('old\n')
    expect(readFileSync(alias, 'utf8')).toBe('old\n')
  })

  test('rejects symlinked routes and duplicate move destinations', async () => {
    const dir = makeTempDir()
    const realDir = join(dir, 'real')
    const linkedDir = join(dir, 'linked')
    const first = join(realDir, 'new.txt')
    const second = join(linkedDir, 'new.txt')
    const sourceA = join(dir, 'a.txt')
    const sourceB = join(dir, 'b.txt')
    const destination = join(dir, 'destination.txt')
    writeFileSync(sourceA, 'old\n')
    writeFileSync(sourceB, 'old\n')
    writeFileSync(join(dir, 'route-marker.txt'), 'marker\n')
    mkdirSync(realDir)
    symlinkSync(realDir, linkedDir, 'dir')

    const routeError = await callError([
      {
        type: 'add',
        path: first,
        lines: ['one'],
        noNewlineAtEndOfFile: false,
      },
      {
        type: 'add',
        path: second,
        lines: ['two'],
        noNewlineAtEndOfFile: false,
      },
    ])
    expect(routeError.code).toBe('PATCH_OVERLAPPING_PATHS')

    const destinationError = await callError([
      { ...updateOperation(sourceA), moveTo: destination },
      { ...updateOperation(sourceB), moveTo: destination },
    ])
    expect(destinationError.code).toBe('PATCH_OVERLAPPING_PATHS')
  })

  test('rejects case-equivalent targets on a case-insensitive filesystem', async () => {
    const dir = makeTempDir()
    const first = join(dir, 'case-target.txt')
    const equivalent = join(dir, 'CASE-TARGET.TXT')
    writeFileSync(first, 'probe\n')
    const caseInsensitive = existsSync(equivalent)
    rmSync(first)
    if (!caseInsensitive) return

    const error = await callError([
      {
        type: 'add',
        path: first,
        lines: ['one'],
        noNewlineAtEndOfFile: false,
      },
      {
        type: 'add',
        path: equivalent,
        lines: ['two'],
        noNewlineAtEndOfFile: false,
      },
    ])
    expect(error.code).toBe('PATCH_OVERLAPPING_PATHS')
  })

  test('aggregates independent invalid files and writes nothing', async () => {
    const dir = makeTempDir()
    const paths = [0, 1, 2].map(index => join(dir, `invalid-${index}.txt`))
    for (const path of paths) {
      writeFileSync(path, 'actual\n')
    }

    const error = await callError(
      paths.map(
        (path): FilePatchOperation => ({
          type: 'update',
          path,
          hunks: [
            {
              scopeHints: [],
              lines: [
                { kind: 'context', text: 'missing' },
                { kind: 'add', text: 'replacement' },
              ],
              isEndOfFile: false,
              noNewlineAtEndOfFile: false,
            },
          ],
        }),
      ),
    )

    expect(error.code).toBe('PATCH_PREFLIGHT_FAILED')
    expect(error.details).toHaveLength(3)
    expect(error.details?.map(detail => detail.path)).toEqual(paths)
    for (const path of paths) {
      expect(readFileSync(path, 'utf8')).toBe('actual\n')
    }
  })

  test('does not publish a valid operation beside an invalid one', async () => {
    const dir = makeTempDir()
    const validPath = join(dir, 'valid.txt')
    const invalidPath = join(dir, 'invalid.txt')
    writeFileSync(validPath, 'old\n')
    writeFileSync(invalidPath, 'actual\n')

    const error = await callError([
      updateOperation(validPath),
      {
        ...updateOperation(invalidPath),
        hunks: [
          {
            ...updateOperation(invalidPath).hunks[0]!,
            lines: [{ kind: 'context', text: 'missing' }],
          },
        ],
      },
    ])

    expect(error.code).toBe('PATCH_PREFLIGHT_FAILED')
    expect(readFileSync(validPath, 'utf8')).toBe('old\n')
    expect(readFileSync(invalidPath, 'utf8')).toBe('actual\n')
  })
})

describe('FilePatchTool model contract', () => {
  test('states current placement and preflight rules', () => {
    const description = getFilePatchToolDescription()
    expect(description).toContain('exactly one operation for each affected source path')
    expect(description).toContain('move destinations disjoint')
    expect(description).toContain('Put update hunks in file order')
    expect(description).toContain('mandatory textual scope constraint')
    expect(description).toContain('exactly one eligible consecutive ordered run')
    expect(description).toContain('preflights every independent operation in memory')
    expect(description).toContain('writes nothing')
    expect(description).toContain('current file snapshot at execution time')
    expect(description).toContain('complete, unbounded model-visible Read')
    expect(description).toContain('does not make multi-file writes crash-atomic')
  })
})
