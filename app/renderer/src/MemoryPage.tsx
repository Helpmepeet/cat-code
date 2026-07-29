import type { MemorySnapshot } from '../../shared/protocol.js'
import { AgentTypeChip } from './AgentChrome.js'
import { agentTypeMeta } from './agentIdentity.js'
import {
  selectInstructionFilesByType,
  selectMemoryInstructionCounts,
} from './goalMemoryState.js'
import { formatRelativeTime } from './sessionsCatalogState.js'

/**
 * `AutoMem` / `TeamMem` are the engine's own type tokens. They are readable as
 * code and not as English, so they are expanded wherever the page prints them —
 * both the summary counts and the group headings above the file lists.
 */
const INSTRUCTION_TYPE_LABEL: Record<string, string> = {
  Managed: 'Managed',
  User: 'User',
  Project: 'Project',
  Local: 'Local',
  AutoMem: 'Auto memory',
  TeamMem: 'Team memory',
}

function instructionTypeLabel(type: string): string {
  return INSTRUCTION_TYPE_LABEL[type] ?? type
}

export function MemoryPage({
  embedded = false,
  snapshot,
}: {
  embedded?: boolean
  snapshot: MemorySnapshot | null
}) {
  const body = (
    <>
      {!snapshot ? (
        <WaitingState />
      ) : (
        <>
          <MemorySummary snapshot={snapshot} />
          <InstructionFiles snapshot={snapshot} />
          <AutoMemories snapshot={snapshot} />
          <AgentMemories snapshot={snapshot} />
        </>
      )}
    </>
  )

  if (embedded) return body

  return (
    <main className="flex min-h-0 flex-1 overflow-auto px-8 py-7">
      <div className="mx-auto w-full max-w-[760px]">
        <MemoryHeader />
        {body}
      </div>
    </main>
  )
}

function MemoryHeader() {
  return (
    <header className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-text-primary">
          Memory
        </h1>
        <p className="mt-1 text-[13px] text-text-subtle">
          Real CLAUDE.md instruction files and auto-memory metadata.
        </p>
      </div>
      <span className="rounded-full border border-shell-seam bg-shell-hover px-2.5 py-1 text-[11px] font-medium text-text-subtle">
        Read-only
      </span>
    </header>
  )
}

/**
 * The read is session-keyed (`selectMemorySnapshot`), so this state is reached
 * with no session selected as often as it is mid-load, and a failed engine-side
 * read never sends a frame at all. The copy it replaced promised the panel
 * would fill as soon as the engine sent the data, which is untrue in both of
 * those cases, and it named internals the user should never read (CLAUDE.md §7).
 */
function WaitingState() {
  return (
    <section className="rounded-xl border border-dashed border-shell-seam bg-shell-hover/35 px-8 py-10 text-center">
      <div className="text-sm font-semibold text-text-muted">
        No memory loaded
      </div>
      <p className="mx-auto mt-2 max-w-[420px] text-[12.5px] leading-relaxed text-text-subtle">
        Open a session to see the instruction files and memories it uses.
      </p>
    </section>
  )
}

function MemorySummary({ snapshot }: { snapshot: MemorySnapshot }) {
  const counts = selectMemoryInstructionCounts(snapshot)
  return (
    <section className="mb-5 rounded-xl border border-shell-seam bg-shell-chrome p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">
            Memory sources
          </h3>
          <p className="mt-0.5 text-[12px] text-text-subtle">
            Auto-memory is {snapshot.autoMemoryEnabled ? 'enabled' : 'disabled'}.
          </p>
        </div>
        <div className="rounded-lg border border-shell-seam bg-shell-hover px-3 py-2 text-right">
          <div className="font-mono text-[14px] text-text-muted">
            {counts.total}
          </div>
          <div className="text-[10px] uppercase tracking-[0.08em] text-text-subtle">
            instruction files
          </div>
        </div>
      </div>
      <div className="grid gap-2 text-[12px] sm:grid-cols-3">
        <Count label={instructionTypeLabel('Managed')} value={counts.managed} />
        <Count label={instructionTypeLabel('User')} value={counts.user} />
        <Count label={instructionTypeLabel('Project')} value={counts.project} />
        <Count label={instructionTypeLabel('Local')} value={counts.local} />
        <Count label={instructionTypeLabel('AutoMem')} value={counts.autoMem} />
        <Count label={instructionTypeLabel('TeamMem')} value={counts.teamMem} />
      </div>
      <div className="mt-3 space-y-1 font-mono text-[11px] text-text-subtle">
        <div className="truncate">dir: {snapshot.autoMemoryDir}</div>
        <div className="truncate">entrypoint: {snapshot.autoMemoryEntrypoint}</div>
      </div>
    </section>
  )
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-shell-seam bg-shell-hover/35 px-2.5 py-2">
      <span className="text-text-subtle">{label}</span>
      <span className="float-right font-mono text-text-muted">{value}</span>
    </div>
  )
}

function InstructionFiles({ snapshot }: { snapshot: MemorySnapshot }) {
  const groups = selectInstructionFilesByType(snapshot)
  return (
    <section className="mb-5 rounded-xl border border-shell-seam bg-shell-chrome p-4">
      <h3 className="mb-3 text-sm font-semibold text-text-primary">
        Instruction files
      </h3>
      {groups.length === 0 ? (
        <p className="text-[12.5px] text-text-subtle">
          No CLAUDE.md or instruction-rule files were loaded.
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map(group => (
            <div key={group.type}>
              <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-text-subtle">
                {instructionTypeLabel(group.type)}
              </div>
              <div className="space-y-1.5">
                {group.files.map(file => (
                  <div
                    className="rounded-lg border border-shell-seam bg-shell-hover/30 px-3 py-2"
                    key={`${file.type}:${file.path}`}
                  >
                    <div className="truncate font-mono text-[11px] text-text-muted">
                      {file.path}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1.5 text-[10.5px] text-text-subtle">
                      {file.parent ? <Pill label="included" /> : <Pill label="direct" />}
                      {file.globs?.length ? (
                        <Pill label={`${file.globs.length} path rule${file.globs.length === 1 ? '' : 's'}`} />
                      ) : null}
                      {file.contentDiffersFromDisk ? <Pill label="truncated" /> : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// Auto-memory `type` → color-coded chip. Hexes verified vs prototype MemoryPage.jsx:19-24
// (MEM_TYPE): user #a1a1aa, feedback #f472b6, project #60a5fa, reference #5eead4.
const MEM_TYPE_CLASS: Record<string, string> = {
  user: 'text-source-user bg-source-user/10 border-source-user/25',
  feedback: 'text-accent bg-accent/10 border-accent/25',
  project: 'text-source-project bg-source-project/10 border-source-project/25',
  reference: 'text-teal-300 bg-teal-300/10 border-teal-300/25',
}

function MemTypeChip({ type }: { type: string }) {
  return (
    <span
      className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
        MEM_TYPE_CLASS[type] ?? 'border-shell-seam bg-shell-hover text-text-subtle'
      }`}
    >
      {type}
    </span>
  )
}

function AutoMemories({ snapshot }: { snapshot: MemorySnapshot }) {
  const now = Date.now()
  return (
    <section className="mb-5 rounded-xl border border-shell-seam bg-shell-chrome p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-text-primary">
          Auto memories
        </h3>
        <span className="font-mono text-[11px] text-text-subtle">
          {snapshot.autoMemories.length} rows
        </span>
      </div>
      {snapshot.autoMemories.length === 0 ? (
        <p className="text-[12.5px] text-text-subtle">
          No auto-memory files found.
        </p>
      ) : (
        <div className="space-y-1.5">
          {snapshot.autoMemories.map(memory => (
            <div
              className="rounded-lg border border-shell-seam bg-shell-hover/30 px-3 py-2"
              key={memory.filePath}
            >
              <div className="flex items-center gap-2">
                {memory.type ? <MemTypeChip type={memory.type} /> : <Pill label="untyped" />}
                <span className="truncate font-mono text-[11px] text-text-muted">
                  {memory.filename}
                </span>
              </div>
              {memory.description ? (
                <p className="mt-1 text-[12px] leading-relaxed text-text-subtle">
                  {memory.description}
                </p>
              ) : null}
              <div className="mt-1 text-[10.5px] text-text-subtle">
                {formatRelativeTime(memory.mtimeMs, now)}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * Per-agent memory directories (prototype `MemoryPage.jsx:199-210`).
 *
 * Absent rather than empty when no agent declares a memory scope, which is what
 * the prototype does (`agentMem.length > 0 &&`) and is also the honest reading:
 * most workspaces define no memory-carrying agent, and a permanent "none" row
 * would report a missing feature rather than an empty list.
 *
 * `AgentTypeChip` renders nothing for a role outside the known palette
 * (`AgentChrome.tsx:66`), so the name falls back to plain text exactly as the
 * prototype's own `window.AgentTypeChip` guard does.
 */
function AgentMemories({ snapshot }: { snapshot: MemorySnapshot }) {
  if (snapshot.agentMemories.length === 0) return null
  const count = snapshot.agentMemories.length
  return (
    <section className="mb-5 rounded-xl border border-shell-seam bg-shell-chrome p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-text-primary">Agent memory</h3>
        <span className="font-mono text-[11px] text-text-subtle">
          {count} {count === 1 ? 'agent' : 'agents'}
        </span>
      </div>
      <div>
        {snapshot.agentMemories.map(agent => (
          <div
            className="flex items-center gap-3 border-b border-shell-seam py-2.5 last:border-b-0 last:pb-0"
            key={`${agent.agentType}:${agent.scope}`}
          >
            {agentTypeMeta(agent.agentType) ? (
              <AgentTypeChip role={agent.agentType} />
            ) : (
              <span className="shrink-0 text-[12px] text-text-muted">
                {agent.agentType}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-subtle">
              {agent.directory}
            </span>
            <span className="shrink-0 text-[11px] text-text-faint">
              {agent.fileCount} {agent.fileCount === 1 ? 'file' : 'files'}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function Pill({ label }: { label: string }) {
  return (
    <span className="rounded-full border border-shell-seam bg-shell-hover px-1.5 py-0.5 text-[10px] font-medium text-text-subtle">
      {label}
    </span>
  )
}
