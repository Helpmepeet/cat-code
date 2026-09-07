import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'bun:test'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import {
  getFsImplementation,
  setFsImplementation,
} from '../../utils/fsOperations.js'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../FileEditTool/constants.js'
import { FilePatchTool } from './FilePatchTool.js'
import { FilePatchError } from './types.js'

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
