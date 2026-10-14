# claude-soma-lite roadmap: deferred scope

This records what v1 deliberately does not build, so nothing here is mistaken for an omission. v1 ships the fleet spine: promote a session, enqueue a backlog, fan out to opus/max planning-only leads that run agent teams, govern concurrency, and come back with draft PRs. Everything below is a named follow-on, not a gap in the spine.

Sources: the design spec §16 cut-line (`docs/superpowers/specs/2026-07-29-claude-soma-lite-design.md`) and the self-review in the v1 implementation plan (a working document that is not published).

## v1.x — completes the operator experience

These have a named seam in v1 (a CLI switch arm, a prompt directive, or a config key) but their full behavior lands later.

### Digest composer body
v1 emits `FLEET_DRAINED` / `FLEET_SETTLED` events and a `soma_digest` tool that returns per-task rows. The composer that renders `~/.soma/digests/<date>.md` with the done/failed/blocked sections, the blocked questions verbatim, the same-repo PR-conflict cross-reference over COMPLETED `paths[]`, and the coalesced "7 done, 1 failed, 2 need you" toast is v1.x. Until then the orchestrator LLM assembles the summary from `soma_inbox` on demand.

### Softer CLI subcommand bodies
`soma.mjs` dispatches these arms in v1 but their bodies are v1.x:
- `soma retry <task>` — re-queue a failed row through the idempotent worktree path (the worktree layer already supports `-r2` recreation; this wires it to the queue).
- `soma hold <task>` / `soma release <task>` — write/clear `leads/<id>/HOLD`; the watchdog then skips stall strikes, revival, and wall-clock while held (token caps stay live). Distinguishes a deliberate operator pause from a pathological stall.
- `soma gc` — remove worktrees whose draft PR is merged or closed (on confirm); GC terminal task rows after 7 days; delete `soma/<task>` branches after worktree removal (remote delete only behind an explicit `--remote` flag); age `logs/` and `digests/` past `gc_days` into `~/.soma/archive/`; sweep `~/.claude/tasks/*` for teams whose lead has been terminal > 7 days. Never touches `~/.claude/projects` transcripts (needed for `--resume`).
- `soma thaw` — **the clear is SHIPPED; only the ignore list is still v1.x.** The arm lifts an *org
  spend-cap* freeze: it clears `state/backpressure.json` through `clearBackpressure()`, prints the
  record it cleared, and refuses (exit 3) both a live `reason: storm` record — the watchdog re-writes
  that one on every tick it still corroborates the storm, so a clear here would be undone within a
  tick — and a record it cannot read. What is still deferred is the per-fleet **ignore list** for a
  *false* storm freeze, and it cannot exist before the evidence scraper does (`paneSignals` still
  returns `[]`). RUNBOOK §7 and §9.

### H5 babysitter follow-up
v1 registers H5 in the harness registry and the lead playbook attaches it after a draft PR opens, running as an in-session `/loop` while the lead is alive. The v1.x work is the teardown handoff: when a lead is reaped, its babysitter watchlist entry passes to the orchestrator so CI/review polling survives the lead's death, plus the early-exit accounting (≤ 5k tokens when nothing changed).

### Revival cooldown and storm-aware suspension
This entry said the whole of revival was "kept out of the v1 tick". **That is no longer true and the correction matters, because it understates what runs unattended.** The tick DOES revive: `revive()` is called from the tick, captures the death screen, emits `LEAD_DEAD`, kills the session, calls `resumeLead` or `spawnLead` per `planRevival`, records the new session uuid, and emits `REVIVED`. `MAX_ATTEMPTS = 3` and `giveup` are enforced.

**What is missing is the 1-hour backoff, and that is the half that made three attempts safe.** There is no cooldown constant anywhere: consecutive 30-second ticks burn all three attempts in about 90 seconds, so a lead dying for a persistent reason reaches `GAVE_UP` before an operator can look at it. Also still v1.x: the storm-aware suspension, and the TOCTOU re-check.

### `PostCompact` hook installer
`bin/hooks/lead-postcompact.mjs` exists and works. **Nothing registers it** — `settings-gen.writeLeadSettings` writes `PostToolUse`, `Stop` and `PreToolUse`, and there is no `PostCompact` registration anywhere in `bin/lib/`. This is the *second* uninstalled hook, alongside the `UserPromptSubmit` inject hook, and unlike that one it was declared nowhere until now.

It is load-bearing in shipped code, not only in the spec: `bus-tools.mjs` justifies `soma_task`'s existence by "the PostCompact hook's injected line names this tool". Consequence: after an auto-compact — routine, measured on this build at a median prompt around 994k — a lead loses its HARNESS contract with nothing to restore it. v1.x is the installer; the hook itself needs no work.

### Clearing a tripped budget
`wd/budget.mjs` calls clearing a trip "an explicit operator/orchestrator action (unlink)" and **ships no affordance for it**: no CLI verb, no MCP tool, nothing in `bin/` unlinks `leads/<id>/BUDGET_TRIPPED`. Spec §11 promises the orchestrator can "clear a trip explicitly", and `lead-gate.mjs` tells the tripped lead *"Ask the orchestrator to clear the trip if you need more."* — an instruction the orchestrator cannot act on. A tripped lead is permanently alive-but-mute until killed.

v1.x: a `soma_clear_trip(lead)` MCP tool plus a `soma resume --clear-trip` CLI arm, both writing through the same guard the trip does. Until then the operator deletes the file by hand, which the runbook now says.

### `serialize_with` — withdrawn, not deferred
The design has `soma_enqueue` accept `serialize_with:<task>` for tickets known to touch one module. **Four layers drop it**: the `soma_enqueue` inputSchema sets `additionalProperties:false` and omits it, `fleet.enqueue`'s explicit field list drops it, `admit` is pure FIFO, and nothing reads it downstream. The orchestrator prompt used to instruct passing it, so an orchestrator would believe it had serialised two tickets when it had not — the precise outcome the field exists to prevent, arrived at by trusting the mechanism. **That instruction is removed as of this branch**; the prompt now tells the orchestrator to enqueue the second ticket after the first reports `COMPLETED`.

Restoring it needs all four layers at once, which is why it sits with queue priorities in v2 rather than here.

### Case- and quote-insensitive credential matching
Two credential-evasion classes are open and now declared at `settings-gen.CREDENTIAL_STORE_DENIES` and in RUNBOOK §11.4: **case variation on a path** (rules match case-sensitively, the volume is case-insensitive APFS, so `cat ~/.AWS/credentials` is ALLOW and reads the file) and **quote or backslash splitting inside a filename** (`cat ~/.ssh/id""_ed25519`). Class 1 is a one-keystroke bypass.

**Deliberately not closed by widening the deny list**, and the reasoning is the point: case is not enumerable (`~/.aws/credentials` alone has 2^15 spellings), so an added `Bash(*.AWS/credentials*)` closes one spelling while making the rule set look more complete — the same failure the block already rejects for `Bash(cat*credentials*)`. The fix belongs in `lead-gate.mjs`, as a predicate that lower-cases and unquotes the command string before comparing it against a credential-path set, in the same shape as the existing resolved-write-target predicate for `.claude/`. That is immune to the next spelling; a rule is not.

### Watchdog episode semantics and notification coalescing
v1 emits raw `BUDGET` and terminal events. There is no stall detector and no teammate monitoring yet, so `STALLED` and `TEAMMATE_DOWN` have no producer. The stall detector, the episode logic (stall fires once on entry, clears on heartbeat, one escalation at 3×), the 90-second terminal-toast coalescing window, and the `notify_policy: quiet` routing are v1.x. Until then notifications are per-event and can be chatty at ten leads. The pane census (added after leads stalled unseen on a permission prompt) already has episode semantics of its own — `LEAD_BLOCKED_ON_PROMPT` and `LEAD_DEAD_SHELL` fire once on entry and `LEAD_PANE_RECOVERED` on exit, deduped off the row's `pane_state` — but not coalescing: a tmux-resurrect restore recreates every saved session at once and produces one `LEAD_DEAD_SHELL` per row in the same tick, which is the truth and is also N toasts.

### Claude Code version gate — mostly SHIPPED; this entry was stale
This section said "v1 ships `versionOk()` as a `true` stub in the tick". **That is false.** `versionGate()` reads `claude --version` (once per process, not cached 10 min), compares it against `tested_claude` from config through the exported `versionInRange`, and `admitNext` returns early while it is out of range — closing admission fleet-wide and emitting a `VERSION_GATE` event once per version. Measured: `2.1.220` in range for the shipped `2.1.178`–`2.1.999`; `2.1.177`, `2.2.0` and `3.0.0` all out; an unreadable version or an unparseable bound answers `null` and the gate fails **open**, deliberately, so a PATH problem does not silently stall a fleet.

What is genuinely left for v1.x: comparing against `last_canary_claude_version` rather than a static config range, the 10-minute cache, fresh-spawn revival on mismatch, and the `CLAUDE_UPDATED` event and toast. Those do depend on the live canary driver (below). **The operator-visible consequence of the shipped half is worth stating plainly: the first Claude Code minor bump closes the queue**, and the only signal is an absence of spawns plus one `VERSION_GATE` event.

### The bring-up measurement that turns four estimates into numbers
v1's budget caps are calibrated against 209 real sessions, but **no session in that corpus is a soma lead** — they are single sessions that did a ticket themselves, not planning-only leads with teams. Four figures are therefore provisional, and one run settles all of them: start one real lead on one real ticket with a real team, then report both its own transcript total and the total of every transcript in its slug directory. The ratio between those two *is* the team multiplier, which v1 ships as ~2.5x with a 1.5x–4x band from a single structural analogue (if it is really 4x, the `standard` cap should be 32M rather than 20M). While doing it, confirm the lead's slug directory contains exactly the lead and its teammates and nothing else; let one lead reach compaction to establish the context window that the resume fraction is derived against; and have the watchdog kill one lead so its transcript tail can be read, since revival decisions run on killed sessions and only finished or abandoned ones were measured. This belongs in the runbook as a procedure, not in a config default.

### Live canary driver
v1 ships `evaluateCanary(probe)` as pure invariant checks with full unit coverage. The driver that spawns the 2-minute synthetic lead and produces the probe result (teammate-can-edit, lead-cannot-write, teammate-user-MCP-denied, soma-pr draft, slot-freed-after-complete, RC URL, OAuth under `env -i`) is exercised by `soma up --canary` on a real machine during bring-up, not in the unit suite. Turning that manual bring-up procedure into an automated driver is v1.x.

### Jira/GitHub writeback ledger
v1's orchestrator prompt instructs comment-only Jira and `gh issue comment` GitHub writeback. The evented ledger (`WRITEBACK_OK` / `WRITEBACK_FAILED` appended per attempt, role-keyed cursors for idempotence so an adopted orchestrator never double-comments, the "re-auth needed: run /mcp" toast on auth-shaped failures with retry on later wakes) is v1.x. Until then writeback is best-effort prompt discipline, not a mechanically-tracked ledger.

### The `env_allow` escape hatch, and why it ships unread

`config.DEFAULTS` carries `env_allow: []` and **nothing in v1 reads it.** That is deliberate, not an
oversight, and the reason is worth stating because the obvious implementation is the one to avoid.

The spec designs it as a *logged, per-repo* escape hatch for forwarding an extra environment variable
into a lead. The shipped key is top-level and there is no per-repo one, so wiring it as-is would be an
unbounded secret-forwarding hole: environment values are world-readable via `ps`, and a lead's
environment is inherited by every teammate it spawns.

The tempting guard — refuse variable *names* matching something like
`/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|_AUTH/i` — cannot work, and the counter-example is one line:
**`DATABASE_URL` carries a password in the userinfo of a connection string and matches none of those
patterns.** So do `SENTRY_DSN` and any `*_URI` holding basic-auth. More generally it is a *vocabulary
list*, and a vocabulary list that did not contain the hostile phrasing bit this build three separate
times during v1 (a permission canary blind to "implementation allowed"; a relational pin blind to the
direction it was entirely about; a hedge ban that closed the one word it was built from). Using that
mechanism to guard credentials would be the highest-stakes instance of it. The asymmetry is the point:
an allow-list of six names is enforceable because it is *closed*, and a denylist over "things that
look like secrets" is open by construction — which is what a hatch for unknown values must be.

**What makes it shippable in v1.x: per-repo, allow-listed by exact variable name, and logged at
spawn.** Not a pattern, not top-level, not silent.

**The candidate everyone reaches for first — `SSH_AUTH_SOCK` — was investigated and should stay out,
and the reasoning is evidence rather than principle.** The fleet's real targets do use SSH remotes,
there is no `url.*.insteadOf` HTTPS rewrite and no global `credential.helper`, and `gh`'s host file
holds zero OAuth tokens — so on paper a `git push` from a lead's worktree should fail. But
**`ssh-add -l` reports "The agent has no identities"**: the agent is empty, so the socket is carrying
nothing. The operator's live mechanism is the key *file* — `~/.ssh/config` sets
`IdentityFile ~/.ssh/id_ed25519`, present at mode `600` — and `ssh` finds it from **`HOME`**, which is
already on the allow-list. So forwarding the socket would hand a credential *capability* to every
teammate and buy nothing today. The one residual is a passphrase-protected key, which would prompt on
the pane's tty and hang rather than fail cleanly; an empty agent alongside working pushes makes that
unlikely, and it would be equally true of any non-agent invocation. **If a first run does fail on
`git push`, the fix is `HOME`-resolvable key material or an HTTPS `insteadOf` rewrite — not the
socket.**

Because `loadConfig` preserves unknown keys, deleting it from `DEFAULTS` would not stop an operator's
`soma.json` from carrying it and doing nothing — so `soma doctor` reports any declared-but-unimplemented
config key instead. A visible dead key beats an invisible one.

### RC URL capture on spawn

The spec spells this as "poll `capture-pane` 2 s × 30 s → `meta.json`". It is omitted from v1's
spawner and the cost is why: it is a **30-second blocking poll inside a synchronous function, on a
loop whose tick period is 30 seconds, while holding the per-repo mutex.** At ten leads that does not
degrade the fleet, it serialises it — one spawn consumes an entire watchdog tick, the next tick is
already due on arrival, and no other spawn in that repo can proceed for the duration. Against that,
`meta.json`'s RC URL has zero readers in v1 (grepped).

v1.x should capture it **outside** the repo lock, driven by the CLI on demand rather than by the
spawner.

`meta.json` itself is written on spawn; only the RC URL is missing from it. `spawnLead` writes
`leads/<id>/meta.json` inside the repo lock and before the launch, holding what the spawn fixed:
the task and repo, the base branch, `base_sha` (the commit the worktree was cut from), the branch,
the worktree, whether it was reused, the session uuid, the tmux target and the time. The same
`base_sha` goes onto the task row, which `fleet.enqueue` creates with `base_sha: null`; that is the
field a post-mortem needs to reproduce what a lead saw. On a reused worktree `ensureWorktree` can
report only the remote's current tip, so the spawner takes the base from `meta.json` when it
records the same branch, and from the row only when there is no `meta.json` to read; otherwise it
records null rather than that tip. A resume leaves the file alone.

## Declared out of scope by the account-rotation design (2026-09-15)

`docs/superpowers/specs/2026-09-15-account-rotation-design.md` §8 names four things so nobody reads
them as gaps in the seat pool. Three of those are deferred work and have entries below; none has a
seam in the shipped code, and each is its own spec → plan cycle if it is ever wanted. The fourth —
copying transcripts between config dirs — is a rejected alternative (approach C), not deferred work,
and has no entry: the shared `projects/` tree removes the copy step and its torn-file failure mode.
**A fourth entry, *A seat with no soma bus*, is not from §8**: the build found it after the spec was
written and it is recorded here for the same reason — so it reads as declared rather than missed.

### The orchestrator's own usage limit
Rotation covers leads only. The orchestrator is a promoted human session under one seat, and a limit
hit there is not detected: the only proxy is the lease going stale after ten minutes, at which point
leads keep running and the digest keeps accumulating with nobody reading it. Recovery is a human act —
start a session under an open seat and adopt the stale lease (`/soma:promote`). Detecting it would
mean classifying the orchestrator's own transcript, which the watchdog has no fleet row for; acting on
it would mean a machine stealing a lease from a human.

### Two fleets sharing a seat
The pool is per `SOMA_HOME`: `state/seats.json` lives inside one fleet's state root and there is no
state location outside a fleet, so fleet A cannot see that fleet B just closed a seat, and both may
rotate onto the same open seat and exhaust it together. Sharing would need a machine-wide pool file
with its own lock — a state root outside every fleet — and RUNBOOK §3 explains what forked roots cost.

### Cross-organisation seats
A seat is a config dir logged into the **same** Team or Enterprise organisation. The operator's
personal Max profile is a different organisation and stays outside the pool. Mixing organisations
costs a prompt-cache miss on the first post-rotation turn (measured same-organisation: a partial hit)
and raises a terms-of-use question the design does not take on. `every seat logged in` reads
`oauthAccount` presence, not the organisation — so this is a provisioning rule (RUNBOOK §7 step 1:
compare `orgId` from `claude auth status --json`), not a doctor check.

### A seat with no soma bus
Found in a review during the build and not implemented: **no doctor check verifies that a seat has the soma
bus registered.** `soma init --seat <dir>` and adding the seat to `soma.json.seats` are independent
acts, and only the second is observable from config, so a seat can pass all five seat checks while
`claude mcp list` under its root names no `soma` server — and the first anyone learns of it is a
rotated lead with no `soma_task`, no writeback and no `/soma-promote` skill. A check would have to run
`claude mcp list` under each seat root (a subprocess per seat, which no other doctor check does) or
read each seat's `.claude.json` for the server entry, which is the cheaper shape and the likely one.
Until it exists, RUNBOOK §7's *What no check covers* is the whole of the guard.

## v2 — infrastructure and scale

Deferred with no v1 seam; these are new subsystems, each its own spec → plan cycle.

- **OS autostart** — a launchd agent (macOS), systemd-user unit (Linux), or logon task (WSL) that re-runs `soma up` after reboot. v1's contract is the manual `soma up` after login.
- **Detached H5 babysitter cron** — the follow-up loop as an OS-scheduled job that survives even the orchestrator being down, rather than living inside a lead session.
- **Queue priorities and inter-task dependencies** — v1 drains strict FIFO with **no** ordering hint of any kind (the `serialize_with:<task>` hint this line used to claim is accepted by nothing — see the v1.x entry above). Priority ordering, a real dependency graph, and a working `serialize_with` are v2.
- **`soma top`** — a live TUI over the fleet (leads, budgets, backpressure, teammate panes) instead of the one-shot `soma status` table.
- **iTerm2 `it2` teammate mode polish** — first-class support for operators who prefer iTerm2 split panes over raw tmux on macOS.
- **OS-sandbox hardening of the shell boundary** — the declared residual is that a subprocess names an interpreter rather than a file, so `python -c 'open(...,"w")'`, `node -e`, and any agent-authored script reach the filesystem regardless of what the permission rules say. The command string is the ceiling for both Claude Code's own rules and soma's PreToolUse gate, so nothing at that layer closes it; sealing it needs OS sandboxing (a read-only bind mount, seatbelt, or bubblewrap), which is a v2 capability rather than "lite". v1 narrows the reachable idioms and declares the rest.

  Two cases found during the build make this the highest-value v2 item rather than a theoretical one. **The guard file can be rewritten through the shell.** `tee`, `cp /dev/null`, `dd of=` and `install -m644` all overwrote a real `.claude/settings.local.json` in a real permission-bypassed session; an emptied guard file does not fail safe, it means *no restrictions at all*; and because Claude Code re-reads that file mid-session, one uncovered idiom uncovers the rest — the rule protecting the file lives *in* the file. v1's answer is a PreToolUse predicate over the resolved write target, which works precisely because a hook is the only layer that cannot be deleted by the thing it protects. **And credential stores are reachable.** A review agent read the operator's live Claude OAuth tokens by running `security find-generic-password`; nothing in the guard file stopped it. v1 adds a deny family and a doctor assertion, but a deny list over command strings has the same ceiling here as it does for `python -c`.

- **A real mutual-exclusion primitive for the file locks** — three independent measurements put the residual takeover race at 0.28, 0.74 and 1.63 violations per thousand *provoked* takeovers depending on how aggressively it is provoked, and zero across tens of thousands of critical sections with no crashed holder. It cannot be closed in pure POSIX: there is no "unlink only if this inode", so taking over a dead holder's lock always leaves a two-syscall window. Three separate attempts narrowed it and none closed it. Recorded here because two ideas that look like fixes are not: serialising takeovers behind a second lock reintroduces a smaller wedge via that lock's own stale state, and a **symlink lock does not help** — a symlink makes *publication* atomic, which `link(2)` already does, while takeover is still `unlink` by name. Only `flock`/`fcntl` on a held descriptor genuinely closes it, because the kernel drops the lock on process death and no takeover logic is needed at all; there is no synchronous zero-dependency Node API for that, and shelling out costs milliseconds against a sub-millisecond budget on a lock every soma process takes. So: measure a spike, or document the bound honestly.

- **A fleet-wide token ceiling** — v1 caps each lead and caps the number of leads, so worst-case exposure is the product. The operator saw that figure (a full run at `max_leads: 10` is ~19.5% of their entire recorded Claude Code history, ~37% for the largest budget class) and chose to keep `max_leads: 10` with a confirmation prompt at `soma up` rather than a new mechanism. A ceiling that stops *admitting* new leads once the run crosses a total would bound it properly and is the right shape if the confirmation proves too blunt. Deliberately not built in v1: it is a new admission input, and the per-lead caps cannot substitute for it — every comparable session in the operator's history exceeds the original caps, so any cap low enough to bound exposure guarantees no lead ever finishes.
- **Official usage-metering surface** — if a supported programmatic read of the Max plan's 5-hour / weekly windows ever ships, it replaces v1's heuristic pane-regex backpressure with real quota accounting. As of the account-rotation design the limit *signal* is no longer a pane regex at all: it is the synthetic `rate_limit` assistant row in the lead's transcript (`bin/lib/wd/limit-state.mjs`), and `state/backpressure.json` finally has writers — the watchdog's storm branch and the org spend cap, the latter lifted by `soma thaw`. An official surface would replace the transcript read and add the one thing it cannot see — how much window is *left* before the hit.

## Never (in scope for this project)

Stated for completeness so they are not re-litigated: native Windows (no tmux → no supervisor, wake, or split panes; WSL2 is the Windows story), a web dashboard, chat channels (Telegram/Discord), voice, social posting, a file dropper, and multi-VPS. These are the parts of full claude-soma that soma-lite exists to leave out.
