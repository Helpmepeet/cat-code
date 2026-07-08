import { scanMemoryFiles, type MemoryHeader } from '../../src/memdir/memoryScan.js'
import {
  getAutoMemEntrypoint,
  getAutoMemPath,
  isAutoMemoryEnabled,
} from '../../src/memdir/paths.js'
import { getMemoryFiles, type MemoryFileInfo } from '../../src/utils/claudemd.js'
import type {
  AutoMemoryHeader,
  MemoryInstructionFile,
  MemorySnapshot,
} from '../shared/protocol.js'

export type SidecarMemoryDomain = {
  /** Read-only snapshot. null while loading or when the read failed. */
  getSnapshot(): MemorySnapshot | null
  subscribe(listener: () => void): () => void
}

export function createSidecarMemoryDomain(): SidecarMemoryDomain {
  let snapshot: MemorySnapshot | null = null
  const listeners = new Set<() => void>()
  void readMemorySnapshotOnce().then(value => {
    snapshot = value
    for (const listener of listeners) listener()
  })
  return {
    getSnapshot() {
      return snapshot
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export function buildMemorySnapshot({
  autoMemoryEnabled,
  autoMemoryDir,
  autoMemoryEntrypoint,
  instructionFiles,
  autoMemories,
}: {
  autoMemoryEnabled: boolean
  autoMemoryDir: string
  autoMemoryEntrypoint: string
  instructionFiles: readonly MemoryFileInfo[]
  autoMemories: readonly MemoryHeader[]
}): MemorySnapshot {
  return {
    autoMemoryEnabled,
    autoMemoryDir,
    autoMemoryEntrypoint,
    instructionFiles: instructionFiles.map(instructionFileSnapshot),
    autoMemories: autoMemories.map(autoMemoryHeaderSnapshot),
    notes: [
      'Instruction file contents are withheld; the renderer receives paths, types, and include metadata only.',
      'Auto-memory rows are frontmatter headers from the real memdir scan; memory bodies stay engine-side.',
      'Goals and memory writes remain deferred until a safe desktop writer boundary is designed.',
    ],
  }
}

async function readMemorySnapshotOnce(): Promise<MemorySnapshot | null> {
  try {
    const autoMemoryEnabled = isAutoMemoryEnabled()
    const autoMemoryDir = getAutoMemPath()
    const autoMemoryEntrypoint = getAutoMemEntrypoint()
    const [instructionFiles, autoMemories] = await Promise.all([
      getMemoryFiles(),
      autoMemoryEnabled
        ? scanMemoryFiles(autoMemoryDir, new AbortController().signal)
        : Promise.resolve([]),
    ])
    return buildMemorySnapshot({
      autoMemoryEnabled,
      autoMemoryDir,
      autoMemoryEntrypoint,
      instructionFiles,
      autoMemories,
    })
  } catch (error) {
    process.stderr.write(
      `[sidecar] memory snapshot read failed (session runs without a memory snapshot): ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return null
  }
}

function instructionFileSnapshot(file: MemoryFileInfo): MemoryInstructionFile {
  return {
    path: file.path,
    type: file.type,
    ...(file.parent ? { parent: file.parent } : {}),
    ...(file.globs ? { globs: [...file.globs] } : {}),
    contentDiffersFromDisk: file.contentDiffersFromDisk === true,
  }
}

function autoMemoryHeaderSnapshot(header: MemoryHeader): AutoMemoryHeader {
  return {
    filename: header.filename,
    filePath: header.filePath,
    mtimeMs: header.mtimeMs,
    description: header.description,
    ...(header.type ? { type: header.type } : {}),
  }
}
