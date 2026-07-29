import { readdir } from 'node:fs/promises'
import { scanMemoryFiles, type MemoryHeader } from '../../src/memdir/memoryScan.js'
import {
  getAutoMemEntrypoint,
  getAutoMemPath,
  isAutoMemoryEnabled,
} from '../../src/memdir/paths.js'
import { getMemoryFiles, type MemoryFileInfo } from '../../src/utils/claudemd.js'
import {
  getAgentMemoryDir,
  type AgentMemoryScope,
} from '../../src/tools/AgentTool/agentMemory.js'
import type {
  AgentMemorySnapshot,
  AutoMemoryHeader,
  MemoryInstructionFile,
  MemorySnapshot,
} from '../shared/protocol.js'

export type SidecarMemoryDomain = {
  /** Read-only snapshot. null while loading or when the read failed. */
  getSnapshot(): MemorySnapshot | null
  subscribe(listener: () => void): () => void
}

/**
 * The subset of an agent definition this domain reads. Structural rather than
 * the whole `AgentConfig`, so the caller passes the engine's OWN active-agent
 * list (`agentDefinitions.activeAgents`, `app/sidecar/sessionController.ts`)
 * without this module importing the loader's shape.
 */
export type AgentMemorySource = {
  agentType: string
  memory?: AgentMemoryScope | undefined
}

export function createSidecarMemoryDomain(
  agents: readonly AgentMemorySource[],
): SidecarMemoryDomain {
  let snapshot: MemorySnapshot | null = null
  const listeners = new Set<() => void>()
  void readMemorySnapshotOnce(agents).then(value => {
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
  agentMemories = [],
}: {
  autoMemoryEnabled: boolean
  autoMemoryDir: string
  autoMemoryEntrypoint: string
  instructionFiles: readonly MemoryFileInfo[]
  autoMemories: readonly MemoryHeader[]
  agentMemories?: readonly AgentMemorySnapshot[]
}): MemorySnapshot {
  return {
    autoMemoryEnabled,
    autoMemoryDir,
    autoMemoryEntrypoint,
    instructionFiles: instructionFiles.map(instructionFileSnapshot),
    autoMemories: autoMemories.map(autoMemoryHeaderSnapshot),
    agentMemories: agentMemories.map(memory => ({ ...memory })),
    // Empty, not removed: `notes` is a required field of the wire contract
    // (`app/shared/protocol.ts` MemorySnapshot) and that file is versioned. The
    // three sentences that used to sit here described our own build — what the
    // read withholds and which writers are undesigned — and the Memory panel
    // rendered them verbatim under a heading called "Scope" (CLAUDE.md §7).
    notes: [],
  }
}

async function readMemorySnapshotOnce(
  agents: readonly AgentMemorySource[],
): Promise<MemorySnapshot | null> {
  try {
    const autoMemoryEnabled = isAutoMemoryEnabled()
    const autoMemoryDir = getAutoMemPath()
    const autoMemoryEntrypoint = getAutoMemEntrypoint()
    const [instructionFiles, autoMemories, agentMemories] = await Promise.all([
      getMemoryFiles(),
      autoMemoryEnabled
        ? scanMemoryFiles(autoMemoryDir, new AbortController().signal)
        : Promise.resolve([]),
      // Gated on the same condition the engine gates the FEATURE on: agent
      // memory tools are only injected when `isAutoMemoryEnabled() &&
      // parsed.memory` (`src/tools/AgentTool/loadAgentsDir.ts:456`), so with
      // auto-memory off there is no live agent memory to report.
      autoMemoryEnabled ? readAgentMemories(agents) : Promise.resolve([]),
    ])
    return buildMemorySnapshot({
      autoMemoryEnabled,
      autoMemoryDir,
      autoMemoryEntrypoint,
      instructionFiles,
      autoMemories,
      agentMemories,
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

/**
 * One row per agent definition that DECLARES a memory scope — the engine's own
 * active-agent list decides membership, so an agent with no `memory:` front
 * matter never appears. `getAgentMemoryDir` is the engine's own resolver
 * (`src/tools/AgentTool/agentMemory.ts:52`), which is why a project/local scope
 * lands in the session's cwd exactly as the running agent's would.
 *
 * A directory that does not exist yet is a real state (the agent has run, or has
 * not, and either way its scope is declared), so it reports zero files rather
 * than dropping the row. Any other read error fails the whole snapshot to the
 * caller's catch — a partially-read count would understate memory silently.
 */
export async function readAgentMemories(
  agents: readonly AgentMemorySource[],
): Promise<AgentMemorySnapshot[]> {
  const withMemory = agents.filter(
    (agent): agent is { agentType: string; memory: AgentMemoryScope } =>
      agent.memory !== undefined,
  )
  return Promise.all(
    withMemory.map(async agent => {
      const directory = getAgentMemoryDir(agent.agentType, agent.memory)
      return {
        agentType: agent.agentType,
        scope: agent.memory,
        directory,
        fileCount: await countFiles(directory),
      }
    }),
  )
}

async function countFiles(directory: string): Promise<number> {
  try {
    const entries = await readdir(directory, {
      recursive: true,
      withFileTypes: true,
    })
    return entries.filter(entry => entry.isFile()).length
  } catch (error) {
    if (isMissingDirectory(error)) return 0
    throw error
  }
}

function isMissingDirectory(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false
  return error.code === 'ENOENT' || error.code === 'ENOTDIR'
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
