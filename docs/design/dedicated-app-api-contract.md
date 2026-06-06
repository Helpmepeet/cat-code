# Dedicated App API / State Contract

## Status

Draft only.

Do not implement real backend wiring in the current task.

This document describes the state domains the dedicated app will likely need after the Claude Design visual productionization step.

## Current source

Current placeholder state lives in:

- `src/app-runtime/dedicatedAppState.ts`
- `src/dedicated-app/placeholderState.ts`

Current shell lives in:

- `src/dedicated-app/DedicatedAppShell.tsx`
- `src/dedicated-app/renderDocument.ts`
- `src/dedicated-app/host.ts`

## Current runtime honesty rule

Placeholder state means placeholder state.

The dedicated app must not claim that live runtime behavior exists until the app-runtime layer actually provides it.

## Future state domains

### Workspace

Likely fields:

- workspace name
- local path
- trust/status
- active focus/mode
- repo status
- current branch
- server/runtime location

### Sessions

Likely fields:

- session id
- title
- summary
- status
- selected session
- last event
- unread count
- attention count
- created time
- updated time

Possible statuses:

- active
- idle
- blocked
- waiting_permission
- running
- completed
- error

### Chat/messages

Likely fields:

- message id
- role/speaker
- text or structured payload
- timestamp
- status
- tool-call references
- permission references
- error references

### Runtime

Likely fields:

- runtime status
- actions ready
- current goal
- current progress
- diagnostics
- local host status
- transport status
- abort status

### Permissions

Likely fields:

- permission id
- tool/action name
- scope
- reason
- urgency/risk
- pending/resolved status
- approve/deny/later actions
- created time
- resolved time
- resulting decision

### Files/diffs

Likely fields:

- changed files
- file status
- additions
- deletions
- diff preview
- review state
- staged/unstaged state

### Agents/workers

Likely fields:

- worker id
- role/name
- status
- assigned task
- latest event
- owner session
- last activity
- blocked reason

### Settings/accounts

Likely fields:

- provider/account state
- runtime settings
- permission settings
- local server/app settings
- model route
- account pool state

## Controller actions

The shell may eventually need controller actions like:

- open session
- select panel
- submit message
- approve permission
- deny permission
- defer permission
- abort run
- open agents
- open accounts
- open settings
- focus goal
- inspect file change

Do not wire these to real behavior until runtime integration is explicitly requested.

## Do not implement yet

- real command execution
- filesystem writes
- live terminal bridge
- real auth/account mutation
- background task queue
- provider account mutation
- settings mutation
- remote server control
