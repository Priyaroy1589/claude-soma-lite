---
name: soma-promote
description: Promote this Claude Code session into the soma fleet orchestrator — adopt the lease, brief the fleet, drain the event inbox, then dispatch / veto / answer / writeback. Use when the operator types /soma:promote or says promote, promote this session, take over the fleet, adopt the running fleet, become the orchestrator, drive the soma leads from here, or asks to enqueue tickets to soma from this session.
---

# Promote this session to soma orchestrator

`soma init` mounted the bus at user scope in the read-only **candidate** role, so `soma_adopt` and
`soma_status` are already in this session. Promotion is therefore one tool call — **no restart, no
`claude mcp add`, no `/mcp` reconnect.** You are taking a *lease*, not starting a service: the
watchdog and any live leads are already running, and they keep running whoever holds it.

**Never promote a lead or a lead's teammate.** If `SOMA_LEAD_NAME` is set in this environment,
`soma_adopt` refuses by design — it would make a lead its own orchestrator. Say so and stop.

If `soma_adopt` is missing from this session entirely, `soma init` has not run (or ran after this
session started): run `soma init`, then promote from a fresh session. That is the one case a
restart fixes.

## 1. Adopt the lease

Call `soma_adopt` with no arguments.

**`adopted: false`** — someone else holds it. What the refusal proves depends on `holder_live`, so
read that field before you tell the operator anything. On **`holder_live: true`** the staleness check
ran and said no: a lease whose recorded pane is gone, or whose heartbeat is over 10 minutes old,
would have been granted without force, so this one is neither. On **`holder_live: null` — or with the
field absent entirely** — that check could not run, and the refusal proves only that a lease record
exists: the holder may already be a dead pane. Say which of the two you got, because it is the
difference between stealing from a live orchestrator and clearing a corpse. The reply carries
`holder: {session_id, tmux_socket, tmux_pane, wake, lease_seq, heartbeat_at}`. Tell the operator
**who** holds it — session id, pane, and how long since its heartbeat — and stop there. Offer
`soma_adopt({force: true})` and run it **only if the operator says yes**: a force-steal send-keys a
`DEMOTED` notice into the old holder's pane and cuts that session off
the event feed mid-flight.

**`adopted: true`** — the fleet is yours. Note `lease_seq` (your generation) and `unread_count`. If
`degraded_wake: true`, warn the operator plainly: this session is not in a pane on soma's own tmux
server (it is outside tmux, or in another tmux server such as the operator's everyday one), so
pushes arrive as desktop toasts and on your next turn rather than as a live keystroke wake. Only a
pane on soma's own server gets keystroke wakes. The fleet still runs; only the latency changes.

## 2. Brief the fleet — `soma_status`

Summarize for a human, do not dump JSON: one line per lead (id, status, liveness, harness, turns /
est tokens / model, PR URL), then queue depth, backpressure, watchdog health. Lead with whatever
needs a decision now — `watchdog_alive: false` (tell them to run `soma up`; nothing spawns,
revives, or drains without it), a lead `spawned` but `absent`, anything held or budget-tripped.

## 3. Drain the inbox — `soma_inbox`

It returns unread events and advances your cursor, so treat them as work, not news. Order:
`NEEDS_INPUT` first — answer with `soma_send`, and never guess on a lead's behalf; escalate to the
operator instead. Then `ERROR` / `GAVE_UP`, then `COMPLETED` (writeback), then `HARNESS` (veto
within one turn if the budget class is wrong). Everything else is context.

**Then arm the watcher, so the next event wakes you** with no keystroke and no pane. Your Bash
environment carries none of the fleet's pins, so read them off the bus registration:

1. Run `claude mcp get soma`. Its `Command` is `<node>`, its `Args` is `<soma>/bin/soma-bus.mjs`,
   and its two `Environment` lines are `SOMA_HOME=<root>` and `SOMA_TMUX_SOCKET=<socket>`.
2. Fill all four into this call (`soma.mjs` sits beside `soma-bus.mjs`):

```
Monitor({ command: "SOMA_HOME=<root> SOMA_TMUX_SOCKET=<socket> <node> <soma>/bin/soma.mjs watch", description: "soma fleet events", timeout_ms: 1800000 })
```

Not `soma watch`: a `soma` wrapper function sets its own `SOMA_HOME`, which wins over a prefix, and
your Bash and Monitor shells load the operator's shell functions, so that watcher would silently
follow another root. A Monitor expires after 30 minutes at most: **re-arm it on every expiry.** Each
`[soma] …` line names who and what, never the payload, so a wake still means `soma_inbox`. The
watcher consumes nothing.

## 4. Run the orchestrator loop — `prompts/orchestrator.md`

That prompt is the contract; this skill is only the on-ramp. Read it before dispatching:

```bash
claude mcp get soma 2>/dev/null || grep -o '[^"]*soma-bus\.mjs' ~/.claude.json | head -1
# either way you get <soma>/bin/soma-bus.mjs; the prompt is <soma>/prompts/orchestrator.md
```

In one line: **intake** (parse the named backlog, author each task's brief yourself, then
`soma_enqueue`) → **veto** a wrong budget class → **answer** NEEDS_INPUT → **writeback** on
COMPLETED (Jira *comment* carrying the draft-PR link, `gh issue comment`; never a transition, never
a close, never a label). You dispatch; you do not implement. **Never merge a PR and never mark one
ready for review** — the deliverable is a draft PR plus a comment. Escalate anything you cannot
decide to the operator.

## 5. Keep the lease warm

The lease reads as **stale after 10 minutes** without a heartbeat, and a stale lease is adoptable
by the next session *without* `force` — so a live-but-idle orchestrator loses the fleet silently.
Every orchestrator tool call stamps the heartbeat: open each turn, and every wake, with
`soma_inbox` or `soma_status` instead of sitting quiet. Going quiet for a long stretch? Hand the
lease back with `soma_release` and re-adopt on return, so the next session takes it cleanly instead
of finding it stale. (The CLI's `soma release <lead>` is a different verb — it un-holds one lead; it
does not hand back the lease.) If you are told you are `DEMOTED`, or control tools start refusing
you as not the holder, stop acting on the fleet and either re-adopt deliberately or step aside —
never race the new holder.

## 6. Fallback — if the control tools did not surface

After a successful adopt the bus re-announces its tool list, but a mid-session role upgrade is not
guaranteed to be honored by every Claude Code build, and it is not necessarily instant. **Check
before you rely on it.** If `soma_spawn` / `soma_enqueue` / `soma_send` are not in your tool list,
look once more on your next turn — and meanwhile drive the fleet with the `soma` CLI over Bash: it
has parity on every verb that dispatches work, and the two it has no subcommand for at all are in
the table with what to do instead. Do **not** restart the session, re-register the bus, or report
the promotion as failed: the lease is already yours on disk, and the CLI honors it.

```bash
command -v soma || echo 'not on PATH — run it as: node <soma>/bin/soma.mjs'
cat "${SOMA_HOME:-$HOME/.soma}/state/orch.lease"   # your session_id, for --as
```

| instead of | run |
|---|---|
| `soma_status` | `soma status` |
| `soma_inbox` | no `inbox` subcommand in v1 — `tail -n 40 "${SOMA_HOME:-$HOME/.soma}/events/"*.ndjson`, or `soma digest` |
| `soma_enqueue` | `soma enqueue --file tasks.json` |
| `soma_send` | `soma send <lead> "<message>" --as <session_id>` |
| `soma_kill` / `soma_resume` | `soma kill <lead> "<reason>"` / `soma resume <lead>` |
| `soma_transcript` | `soma peek <lead>` |
| `soma_digest` | `soma digest` |
| `soma_release` | nothing — v1 has no CLI handback (below) |
| `soma_spawn` | not needed — the watchdog drains the queue itself (`soma up` if it is down) |

Only the **transport** changes. Every judgement gate in §1–§5 still holds: `soma kill <lead>` is
the same call `soma_kill` was, the writeback is still a comment, and a verb does not become freely
yours because it is now typed into a shell. Mutating subcommands take `--as <session_id>` and
re-check the lease; a bare human invocation says "acting as operator" instead of refusing.

Two of those rows are not substitutes, so know what you are short of.

**Draining events (§3):** the user-scope `UserPromptSubmit` inject hook, registered only if the
operator ran `soma init --inject-hook`, feeds the unread event *headers* into the lease-holder's
next turn and advances its own `orch-inject` cursor, never your `orch` one, so `soma_inbox` still
returns every event it showed you. When it fires for you, that injection, not the tool, is why you
are not blind here. Do not assume it does: a holder with no recorded pane, outside tmux or in a
tmux server that is not soma's (the `degraded_wake: true` case in §1), may not match the hook's
holder test, and then nothing is injected at all. Either way the payloads are what you lose, and
the tail in the row above is where they still are: it reads the files directly, so nothing is
consumed and re-reading is free.

**Handing the lease back (§5):** there is no CLI handback in v1, and `soma release <lead>` is the
other verb. So you cannot give the lease up by typing — it passes to the next session that adopts,
or becomes adoptable on its own once your heartbeat is 10 minutes old.

If a subcommand is not implemented in this build, run `soma attach <lead>` and type at the lead
directly — press **Esc** first if it is mid-turn, or the keystrokes get swallowed or interleaved
with its own output; detach with `C-b d`. Attaching is the intervention of last resort, and it
always works.
