# PTClove Bridge

cat-code exposes a local Unix-socket bridge for PTClove under:

```text
~/.cat-code/ptclove-bridge/
  token
  sessions/<session-id>.sock
```

Each cat-code session owns one socket and shares the user token. Session exit
removes only that session socket; the shared token remains for sibling sessions.

## Messages

cat-code sends line-delimited JSON:

- `session_hello`: identity, project label, cwd, pid, outbound-only flag.
- `heartbeat`: sent every 5 seconds.
- `session_state`: current status, cwd, status text, busy start, model, queue depth.
- `session_activity`: current activity snapshot.
- `session_todos`: compact todo list.
- `session_thread_goal`: active thread goal text.
- `session_result`: long-turn completion/failure/cancel result.
- `approval_request`, `approval_resolved`, `approval_cancelled`.

PTClove sends:

- `session_resync`
- `prompt_submit`
- `abort_turn`
- `queue_clear`
- `focus_session`
- `open_in_terminal`
- `approval_decision`

Every control message after `hello` carries `session_id`.

## Local Simulator

From the PTClove repo:

```bash
python3 scripts/cat-code-bridge-simulator.py --session-id sim-one --project-label "PTClove sim"
python3 scripts/cat-code-bridge-simulator.py --session-id sim-two --project-label "PTClove sim"
```

Then run PTClove. The app should discover both sockets, disambiguate duplicate
labels, show live activity, and surface all approval risk tiers.
