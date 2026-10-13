import { useEffect, useState } from 'react'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import { isActiveScheduledRun, type ScheduledTask, type ScheduledTaskCommand, type ScheduledTaskInput, type ScheduledTasksSnapshot, type TaskSchedule } from '../../shared/scheduledTasks.js'
import { getBridge } from './bridge.js'
import './scheduledTasks.css'

export function ScheduledTasksPage({ sessions, onOpenSession }: { sessions: readonly SessionDescriptor[]; onOpenSession: (id: string) => void }) {
  const [snapshot, setSnapshot] = useState<ScheduledTasksSnapshot>({ tasks: [], runs: [] })
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState<ScheduledTask | 'new' | null>(null)
  const [busy, setBusy] = useState(false)
  const [project, setProject] = useState('')
  const projects = sessions.filter(session => session.binding?.kind === 'project')
  useEffect(() => {
    let alive = true
    let pending = false
    const read = async () => {
      if (pending) return
      pending = true
      try { const value = await getBridge().readScheduledTasks(); if (alive) { setSnapshot(value); setLoaded(true) } }
      catch { if (alive) { setError('Scheduled tasks could not be loaded'); setLoaded(true) } }
      finally { pending = false }
    }
    void read()
    const timer = setInterval(() => void read(), 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  async function command(value: ScheduledTaskCommand): Promise<boolean> {
    setBusy(true); setError(null); setNotice(null)
    try {
      const result = await getBridge().scheduledTask(value)
      if (!result.ok) { setError(result.error); return false }
      setSnapshot(result.snapshot)
      if (value.type === 'workspace-maps') setNotice('The workspace-map task is paused. Pause its previous schedule before enabling it here.')
      return true
    } catch { setError('The scheduled task could not be saved'); return false }
    finally { setBusy(false) }
  }
  return <main className="scheduled-page">
    <div className="scheduled-content">
      <header className="scheduled-heading">
        <div><h1>Scheduled</h1><p>Tasks run in a new chat while a Cat Code window is open and this computer is awake.</p></div>
        <button className="scheduled-button scheduled-primary" disabled={busy || !loaded || !!snapshot.error} onClick={() => setEditing('new')}>New task</button>
      </header>
      {error || snapshot.error ? <p className="scheduled-error" role="alert">{error ?? snapshot.error}</p> : null}
      {notice ? <p className="scheduled-notice" role="status">{notice}</p> : null}
      {editing ? <TaskEditor key={typeof editing === 'string' ? editing : editing.id} task={editing === 'new' ? null : editing} projects={projects} busy={busy}
        onCancel={() => setEditing(null)} onSave={async task => { if (await command({ type: 'save', task })) setEditing(null) }} /> : null}
      {!loaded ? <p className="scheduled-empty">Loading scheduled tasks…</p> : snapshot.tasks.length === 0 && !editing ? <div className="scheduled-empty"><h2>No scheduled tasks</h2><p>Create a recurring task, or add the workspace-map refresh below.</p></div> : null}
      <section aria-label="Scheduled tasks" className="scheduled-list">
        {snapshot.tasks.map(task => {
          const runs = snapshot.runs.filter(run => run.taskId === task.id)
          const active = runs.some(isActiveScheduledRun)
          return <article key={task.id} className="scheduled-task">
            <div className="scheduled-task-heading"><div><h2>{task.name}</h2><p>{scheduleLabel(task.schedule)}{task.enabled ? ` · Next ${formatTime(task.nextRunAt)}` : ' · Paused'}</p><p className="scheduled-path">{task.cwd}</p></div>
              <div className="scheduled-actions">
                <button className="scheduled-button" disabled={busy || active} onClick={() => void command({ type: 'run', id: task.id })}>Run now</button>
                <button className="scheduled-button" disabled={busy} onClick={() => void command({ type: task.enabled ? 'pause' : 'resume', id: task.id })}>{task.enabled ? 'Pause' : 'Enable'}</button>
                <button className="scheduled-button" disabled={busy} onClick={() => setEditing(task)}>Edit</button>
                <button className="scheduled-button scheduled-danger" disabled={busy} onClick={() => { if (window.confirm(`Delete “${task.name}”? Its chats will remain available.`)) void command({ type: 'delete', id: task.id }) }}>Delete</button>
              </div>
            </div>
            {runs.length > 0 ? <details className="scheduled-runs" open={active}><summary>{runs.length} {runs.length === 1 ? 'run' : 'runs'} · Latest {statusLabel(runs[0]!.status)}</summary>
              {runs.slice(0, 20).map(run => <div className="scheduled-run" key={run.id}><div><span className={`scheduled-run-status scheduled-run-${run.status}`}>{statusLabel(run.status)}</span><span className="scheduled-run-time">{formatTime(run.startedAt)}</span>{run.summary ? <p>{run.summary}</p> : null}</div><button className="scheduled-button" onClick={() => onOpenSession(run.appSessionId)}>Open chat</button></div>)}
            </details> : null}
          </article>
        })}
      </section>
      <section className="scheduled-preset" aria-label="Workspace-map refresh"><div><h2>Workspace maps</h2><p>Keep this project’s routing maps current with the existing refresh helper.</p></div>
        <div className="scheduled-actions"><select aria-label="Workspace-map project" value={project} onChange={event => setProject(event.target.value)}><option value="">Choose project</option>{projects.map(row => <option key={row.appSessionId} value={row.appSessionId}>{row.cwd}</option>)}</select><button className="scheduled-button" disabled={busy || !project || !!snapshot.error} onClick={() => void command({ type: 'workspace-maps', workspaceSessionId: project })}>Add workspace-map task</button></div>
      </section>
    </div>
  </main>
}

function TaskEditor({ task, projects, busy, onSave, onCancel }: { task: ScheduledTask | null; projects: readonly SessionDescriptor[]; busy: boolean; onSave: (task: ScheduledTaskInput) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(task?.name ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? '')
  const [workspaceSessionId, setWorkspace] = useState('')
  const [cwdToken, setCwdToken] = useState<string | undefined>()
  const [kind, setKind] = useState<TaskSchedule['kind']>(task?.schedule.kind ?? 'daily')
  const [time, setTime] = useState(task?.schedule.kind !== 'interval' ? task?.schedule.time ?? '09:00' : '09:00')
  const [zone, setZone] = useState(task?.schedule.kind !== 'interval' ? task?.schedule.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [day, setDay] = useState(task?.schedule.kind !== 'interval' ? task?.schedule.day ?? 1 : 1)
  const [minutes, setMinutes] = useState(task?.schedule.kind === 'interval' ? task.schedule.minutes : 60)
  const [enabled, setEnabled] = useState(task?.enabled ?? true)
  const [model, setModel] = useState(task?.model ?? '')
  const [effort, setEffort] = useState<ScheduledTaskInput['effort']>(task?.effort ?? 'default')
  const [permissionMode, setPermissionMode] = useState<ScheduledTaskInput['permissionMode']>(task?.permissionMode ?? 'default')
  const [pickError, setPickError] = useState<string | null>(null)
  async function pick() {
    try { const token = await getBridge().pickDirectory(); if (token) { setCwdToken(token); setWorkspace(''); setPickError(null) } }
    catch { setPickError('The project folder could not be selected') }
  }
  return <form className="scheduled-editor" onSubmit={event => {
    event.preventDefault()
    void onSave({ ...(task ? { id: task.id } : {}), name, prompt, enabled, model, effort, permissionMode,
      ...(cwdToken ? { cwdToken } : workspaceSessionId ? { workspaceSessionId } : {}),
      schedule: kind === 'interval' ? { kind, minutes } : { kind, time, timeZone: zone, day } })
  }}>
    <h2>{task ? 'Edit task' : 'New task'}</h2>
    <label>Name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
    <label>Instructions<textarea required rows={6} maxLength={64000} value={prompt} onChange={event => setPrompt(event.target.value)} /></label>
    <div className="scheduled-fields"><label>Project<select value={workspaceSessionId} onChange={event => { setWorkspace(event.target.value); setCwdToken(undefined) }}><option value="">{cwdToken ? 'Selected folder' : task?.cwd ?? 'Choose project'}</option>{projects.map(row => <option key={row.appSessionId} value={row.appSessionId}>{row.cwd}</option>)}</select></label><button type="button" className="scheduled-button" onClick={() => void pick()}>Choose folder…</button></div>
    {pickError ? <p role="alert" className="scheduled-error">{pickError}</p> : null}
    <div className="scheduled-fields"><label>Repeat<select value={kind} onChange={event => setKind(event.target.value as TaskSchedule['kind'])}><option value="daily">Daily</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option><option value="interval">Every few minutes</option></select></label>
      {kind === 'interval' ? <label>Minutes<input type="number" required min={1} max={10080} value={minutes} onChange={event => setMinutes(Number(event.target.value))} /></label> : <><label>Time<input required type="time" value={time} onChange={event => setTime(event.target.value)} /></label><label>Timezone<input required value={zone} onChange={event => setZone(event.target.value)} /></label></>}
      {kind === 'weekly' ? <label>Day<select value={day} onChange={event => setDay(Number(event.target.value))}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((label, index) => <option key={label} value={index}>{label}</option>)}</select></label> : null}
    </div>
    <details><summary>Advanced</summary><div className="scheduled-fields"><label>Model<input placeholder="Use default model" value={model} onChange={event => setModel(event.target.value)} /></label><label>Effort<select value={effort} onChange={event => setEffort(event.target.value as ScheduledTaskInput['effort'])}>{['default', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => <option key={value} value={value}>{value === 'default' ? 'Use default effort' : value}</option>)}</select></label><label>Permissions<select value={permissionMode} onChange={event => setPermissionMode(event.target.value as ScheduledTaskInput['permissionMode'])}><option value="default">Ask when needed</option><option value="auto">Auto</option></select></label></div></details>
    <footer><label className="scheduled-checkbox"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Enabled</label><div className="scheduled-actions"><button type="button" className="scheduled-button" disabled={busy} onClick={onCancel}>Cancel</button><button className="scheduled-button scheduled-primary" disabled={busy || !name.trim() || !prompt.trim() || (!task && !workspaceSessionId && !cwdToken)}>{busy ? 'Saving…' : 'Save task'}</button></div></footer>
  </form>
}

function formatTime(time: number): string { return new Date(time).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }
function statusLabel(status: string): string { return ({ starting: 'Starting', submitted: 'Starting', running: 'Running', waiting: 'Needs attention', completed: 'Finished', failed: 'Failed', interrupted: 'Interrupted' } as Record<string, string>)[status] ?? status }
function scheduleLabel(schedule: TaskSchedule): string {
  if (schedule.kind === 'interval') return `Every ${schedule.minutes} ${schedule.minutes === 1 ? 'minute' : 'minutes'}`
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][schedule.day]
  return `${schedule.kind === 'daily' ? 'Daily' : schedule.kind === 'weekdays' ? 'Weekdays' : day} at ${schedule.time} (${schedule.timeZone})`
}
