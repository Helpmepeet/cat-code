import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'bun:test'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../FileEditTool/constants.js'
import { FilePatchTool } from './FilePatchTool.js'

const tempDirs: string[] = []
const realBeforeFileEdited = diagnosticTracker.beforeFileEdited

afterEach(() => {
  diagnosticTracker.beforeFileEdited = realBeforeFileEdited
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'file-patch-tool-'))
  tempDirs.push(dir)
  return dir
}

function callPatch(patch: string) {
  return FilePatchTool.call(
    { input: patch },
    {
      readFileState: createFileStateCacheWithSizeLimit(10),
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

    await expect(
      callPatch(
        `*** Begin Patch\n${updateFirst(firstPath)}${updateSecond(
          secondPath,
        )}*** End Patch\n`,
      ),
    ).rejects.toThrow(FILE_UNEXPECTEDLY_MODIFIED_ERROR)

    expect(readFileSync(firstPath, 'utf8')).toBe(FIRST_ORIGINAL)
    expect(readFileSync(secondPath, 'utf8')).toBe(external)
  })
})
