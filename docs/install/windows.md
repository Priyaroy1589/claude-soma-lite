# Installing claude-soma-lite on Windows (WSL2)

**claude-soma-lite does not run on native Windows. It runs inside WSL2, with every tool it uses
installed inside the Linux distribution:** Node.js, tmux, git, the GitHub CLI and Claude Code.

This guide takes a Windows machine from nothing to a first supervised run inside WSL2. Each step
says what to type and what you should see. It ends with a checklist you fill in as you go, so that
a test run produces a report someone else can act on.

Read [`RUNBOOK.md`](../../RUNBOOK.md) before you point the fleet at a repository you care about.
soma runs Claude Code sessions with permission prompts bypassed, and §11 of the runbook says plainly
what its guardrails do not cover.

- [Why native Windows does not work](#why-native-windows-does-not-work)
- [What you need](#what-you-need)
- [1. Install WSL2 and a distribution](#1-install-wsl2-and-a-distribution)
- [2. Install the prerequisites inside WSL](#2-install-the-prerequisites-inside-wsl)
- [3. Get claude-soma-lite](#3-get-claude-soma-lite)
- [4. Add the `soma` wrapper](#4-add-the-soma-wrapper)
- [5. `soma init`](#5-soma-init)
- [6. Write `soma.json`](#6-write-somajson)
- [7. `soma doctor`, and how to read it](#7-soma-doctor-and-how-to-read-it)
- [8. A first supervised run](#8-a-first-supervised-run)
- [WSL caveats](#wsl-caveats)
- [Report what happened](#report-what-happened)

## Why native Windows does not work

- **tmux is a hard dependency, and native Windows has no tmux.** Every lead and the watchdog is a
  tmux session. Without tmux there is no supervisor, no wake-up for the orchestrator, and no split
  panes for a lead's agent team. On native Windows, `soma up` would fail when it tries to start the
  watchdog's tmux session.
- **soma has no Windows code path.** Nothing in `bin/` branches for native Windows. The only
  Windows-specific code is the WSL notification path, which calls `powershell.exe` from inside
  Linux to show a Windows toast.
- **The test script needs a POSIX shell.** `npm test` uses shell syntax that `cmd.exe` cannot run.

Claude Code itself does run natively on Windows
([Claude Code setup](https://code.claude.com/docs/en/setup#set-up-on-windows)), but soma cannot use
that installation. soma's leads are started inside tmux, so the `claude` they run must be the Linux
build inside your WSL distribution.

## What you need

| need | version | why |
|---|---|---|
| Windows | Windows 10 version 2004 (build 19041) or newer, or Windows 11 | needed for `wsl --install` ([Microsoft: Install WSL](https://learn.microsoft.com/en-us/windows/wsl/install)) |
| WSL | **version 2** | this guide assumes it; Claude Code's native binary has a known `Exec format error` regression on WSL 1 ([Claude Code troubleshooting](https://code.claude.com/docs/en/troubleshoot-install)) |
| A Linux distribution | Ubuntu 22.04 or newer, or Debian 12 or newer | its packages must meet the tmux and git floors below |
| Node.js, inside WSL | **24 or newer** | soma's hard floor (`engines.node` is `>=24`) |
| tmux, inside WSL | 3.2 or newer | every lead, and the watchdog, is a tmux session |
| git, inside WSL | 2.31 or newer | one git worktree per task |
| Claude Code, inside WSL | logged in | every lead is a `claude` process |
| GitHub CLI, inside WSL | logged in | draft pull requests are opened through it |
| `npx`, inside WSL, with access to the npm registry | comes with Node | every lead starts `npx -y @modelcontextprotocol/server-sequential-thinking`, which downloads the package when it is not already cached |

The Linux guide's [distribution table](linux.md#which-distributions-are-new-enough) lists which
releases ship a new enough tmux and git. Ubuntu 22.04 and 24.04 do; Debian 11 does not.

## 1. Install WSL2 and a distribution

Open **PowerShell as administrator** and run:

```powershell
wsl --install
```

This enables WSL and installs Ubuntu, then asks you to restart. After the restart, open Ubuntu
from the Start menu and create your Linux user name and password. New installs use WSL 2 by default.
Check:

```powershell
wsl -l -v
```

The `VERSION` column must say `2`. If it says `1`, convert the distribution:

```powershell
wsl --set-version Ubuntu 2
```

To install a different distribution, `wsl --list --online` lists them and `wsl --install -d <name>`
installs one. Both commands are from [Microsoft's install guide](https://learn.microsoft.com/en-us/windows/wsl/install).

**Everything from here on runs inside the WSL terminal**, not in PowerShell or CMD. Windows
Terminal is a good host for it.

## 2. Install the prerequisites inside WSL

**Base packages** (Ubuntu or Debian):

```bash
sudo apt update
sudo apt install -y tmux git curl
tmux -V            # must print 3.2 or newer
git --version      # must print 2.31 or newer
```

You do not need `notify-send` on WSL. soma detects WSL and shows Windows toasts through
`powershell.exe` instead (see [WSL caveats](#wsl-caveats)).

**Node 24, through nvm, inside WSL.** WSL adds your Windows `PATH` to the Linux one by default, so a
Windows Node.js can shadow the Linux one. Claude Code's own WSL troubleshooting says to check this:
`which node` and `which npm` must print Linux paths, not paths under `/mnt/c/`. The install line
below is the one in the [nvm README](https://github.com/nvm-sh/nvm#install--update-script) at the
time of writing; check it for a newer version.

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
```

Open a new WSL terminal so nvm loads, then:

```bash
nvm install 24
nvm alias default 24   # otherwise a new terminal goes back to any older default
node -v            # must print v24.x or newer
which node         # must NOT start with /mnt/c/
```

**Claude Code, inside WSL.** Claude Code's docs say to run the Linux installer inside the WSL
terminal and to launch `claude` there, not from PowerShell or CMD
([Claude Code setup: install in WSL](https://code.claude.com/docs/en/setup#install-in-wsl)).

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude --version
which claude       # must NOT start with /mnt/c/
```

If you installed Claude Code earlier with `npm install -g`, the native installer migrates it and
removes the npm copy without asking. `which claude` must then print a path ending in
`.local/bin/claude`.

The Claude Code configuration inside WSL is separate from any native Windows installation, so log
in here even if you already use Claude Code on Windows. Run `claude` and follow the prompts. In
WSL2 the browser usually opens in Windows and cannot redirect back, so it shows a code after you
sign in: paste it at the `Paste code here if prompted` prompt. If no browser opens, or pasting does
nothing, run `claude auth login` instead
([troubleshooting login in WSL2](https://code.claude.com/docs/en/troubleshoot-install)). Claude
Code needs a Pro, Max, Team, Enterprise or Console account.

**GitHub CLI, inside WSL.** Use GitHub's own `apt` repository. The community `gh` package in
Debian and Ubuntu is not recommended by the GitHub CLI maintainers. These commands are from
[GitHub CLI's Linux install guide](https://github.com/cli/cli/blob/trunk/docs/install_linux.md);
check there for updates.

```bash
(type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \
  && sudo mkdir -p -m 755 /etc/apt/keyrings \
  && out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  && cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && rm -f $out \
  && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && sudo mkdir -p -m 755 /etc/apt/sources.list.d \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && sudo apt update \
  && sudo apt install gh -y
```

Then:

```bash
gh auth login
gh auth status
```

Finally, check that every tool resolves inside the distribution:

```bash
which node npm npx git gh tmux claude
```

None of those paths should start with `/mnt/c/`, and `node -v` in a new terminal must still print
v24.

## 3. Get claude-soma-lite

Clone it into the **Linux file system** (your WSL home directory), not under `/mnt/c`. Microsoft
recommends keeping files that Linux tools work on in the WSL file system
([Working across file systems](https://learn.microsoft.com/en-us/windows/wsl/filesystems)). The same
goes for the repositories the fleet works on, and for soma's state root.

```bash
git clone https://github.com/techfreakworm/claude-soma-lite.git "$HOME/claude-soma-lite"
```

Optionally, run the test suite. It is quick, uses a throwaway state directory, and proves your
Node 24 can run soma:

```bash
cd "$HOME/claude-soma-lite"
nvm use            # reads .nvmrc, which says 24
npm test
```

Look for the `ℹ pass` and `ℹ fail` lines at the end. If there are none at all, you are probably on
Node 20 or older, which finds no test files and prints no totals. On Node 22 the suite runs, and
`test/smoke.test.mjs` fails because it requires Node 24. One test reads your own recent Claude
Code transcripts and can fail on a machine whose Claude Code writes a token-usage field soma does
not know yet (*the operator's live transcripts carry no usage field this module does not know*).
That failure is about your Claude Code version, not your install.

On Linux, including WSL2, `npm test` currently has known failures that come from the test
fixtures, not from your install. Expect up to four more:

- *the leads root is matched with the state root symlinks resolved, not as configured* assumes
  macOS's symlinked `$TMPDIR`
  ([issue 31](https://github.com/techfreakworm/claude-soma-lite/issues/31)).
- *a holder whose lock was taken over does not delete its successor on the way out*, *the
  checkpoint lock releases the lock it published, not whatever holds that name* and *a takeover
  unlinks the file it judged, or nothing at all* assume a deleted file's inode number is not
  reused at once, and ext4 reuses it
  ([issue 30](https://github.com/techfreakworm/claude-soma-lite/issues/30)).

*the write-idiom scan stays linear on the shapes that made it quadratic* is a timing test and can
also fail on a busy machine
([issue 33](https://github.com/techfreakworm/claude-soma-lite/issues/33)).

## 4. Add the `soma` wrapper

Do not run `soma` bare. Two things must be pinned, and both have caused real failures:

- **The node.** `soma up` starts the watchdog with the node that ran it, and that watchdog then
  supervises the fleet for its whole life. A lead's environment is scrubbed down to a few
  variables, `PATH` among them, so the lead must see the same node on its `PATH`.
- **The state root.** Everything soma knows lives under `SOMA_HOME` (default `~/.soma`). It must be
  an absolute path, and every soma command must agree on it.

Find the absolute path of your Node 24:

```bash
dirname "$(nvm which 24)"
```

Add this to `~/.bashrc` inside WSL. Replace the `SOMA_NODE_DIR` value with the path you just
printed, and `SOMA_REPO` with your clone if you put it elsewhere:

```bash
# claude-soma-lite: pin the node and the state root
SOMA_NODE_DIR="$HOME/.nvm/versions/node/v24.x.y/bin"   # the output of: dirname "$(nvm which 24)"
SOMA_REPO="$HOME/claude-soma-lite"
soma() {
  PATH="$SOMA_NODE_DIR:$PATH" \
  SOMA_HOME="$HOME/.soma" \
  "$SOMA_NODE_DIR/node" "$SOMA_REPO/bin/soma.mjs" "$@"
}
```

Then load it and check:

```bash
source ~/.bashrc
type soma          # should say: soma is a function
soma help          # prints the usage text
```

The function lives in `~/.bashrc`, so only interactive shells see it. Ubuntu's `.bashrc` returns
early for a non-interactive shell, so a command run over `ssh`, a cron job or a script has no
`soma`. A script should call `"$SOMA_NODE_DIR/node" "$SOMA_REPO/bin/soma.mjs"` with the same
`PATH` and `SOMA_HOME` as the function.

> If you already have an `alias soma=…`, delete it first. A shell that expands the alias inside
> the function definition fails with a parse error.

**A second fleet for another Claude Code profile?** If you also use a second `CLAUDE_CONFIG_DIR`
(for example a work profile), give it its own wrapper. **Each fleet needs its own `SOMA_HOME`,
`CLAUDE_CONFIG_DIR` and `SOMA_TMUX_SOCKET`:**

```bash
soma2() {
  PATH="$SOMA_NODE_DIR:$PATH" \
  CLAUDE_CONFIG_DIR="$HOME/.claude-second" \
  SOMA_HOME="$HOME/.soma-second" \
  SOMA_TMUX_SOCKET=soma_second \
  "$SOMA_NODE_DIR/node" "$SOMA_REPO/bin/soma.mjs" "$@"
}
```

- The orchestrator lease and the fleet table are keyed only by `SOMA_HOME`, so two profiles that
  share a state root share one lease and one table.
- The watchdog's tmux session name is fixed, so a second fleet on the default `soma` socket finds
  the first fleet's watchdog live: `soma2 up` starts nothing, and the second queue never drains.
- Run `soma2 init` once, so the bus it registers in the second config root pins that socket, and
  drive the second fleet only through `soma2`. Start its orchestrator under the second config root
  (`CLAUDE_CONFIG_DIR="$HOME/.claude-second" claude`), inside that fleet's own tmux server
  (`tmux -L soma_second new-session -s orchestrator`); the warning in
  [A first supervised run](#8-a-first-supervised-run) says why.

## 5. `soma init`

```bash
soma init
```

`init` creates the state tree, installs the `/soma-promote` skill into your Claude Code config
(the one inside WSL), and registers the soma MCP server (the *bus*) at user scope, so that any
Claude Code session in this distribution can later be promoted to orchestrator. The skill and the
registration are read back, not assumed. It is safe to re-run.

`init` also checks that the state directory supports hard links, and refuses with exit 2 if it
does not, because every soma lock is published with `link(2)`. This is one more reason to keep
`SOMA_HOME` in the Linux file system. Whether `/mnt/c` supports hard links has not been checked for
this guide.

Read the output. These lines matter:

- `state root: …` should be your `$HOME/.soma`, spelled out.
- `bus: registered at user scope, candidate role, SOMA_HOME=…`: **check that this is the root you
  meant.** The registration pins it. A bus pinned to the wrong root makes a promoted session show
  an empty fleet while your real fleet runs out of sight.
- `inject hook: …` reports whether the optional prompt-inject hook is registered. `soma init` never
  installs it. The README explains how to add it by hand.
- The last line is ``soma initialized. Next: `soma doctor`, then `soma up`.``

## 6. Write `soma.json`

`soma.json` is optional for soma itself, but a fleet cannot start a task without a `repos` entry,
because a task's `repo` field is a **key** into that map, not a path.

```bash
mkdir -p "$HOME/.soma"
cat > "$HOME/.soma/soma.json" <<'JSON'
{
  "max_leads": 1,
  "repos": {
    "my-repo": {
      "path": "/absolute/path/to/my-repo",
      "base_branch": "main"
    }
  }
}
JSON
```

- Use a Linux path for `path`, inside the WSL file system.
- Give both `path` and `base_branch`. The base falls back to `develop` when omitted.
- The repository needs an `origin` remote that this machine can fetch without a prompt. Each
  worktree is cut from a fresh fetch of `origin/<base_branch>`.
- Start at `max_leads: 1`. The default is 10, and `soma up` will show you what 10 could cost.

The README has the full list of `soma.json` keys.

## 7. `soma doctor`, and how to read it

```bash
soma doctor; echo "exit=$?"
```

Doctor checks the machine and prints one row per check (48 named checks, plus one row per
configured repo). Each row starts with one of three labels:

| label | means |
|---|---|
| `ok  ` | the check ran, and it holds |
| `FAIL` | the check ran, and it does not hold |
| `????` | **unobserved**: the check could not be taken here. This is not a pass. |

The last line is the verdict: `doctor: PASS`, `doctor: INCOMPLETE — N of M checks hold, K
unobserved`, or `doctor: FAIL — N of M checks failed`. **Read the word, not only the exit code.**
Doctor exits 0 for both PASS and INCOMPLETE, and 3 for FAIL.

Each run makes two small, billed Claude calls (a `claude -p` ping and a short haiku probe), runs
`gh auth status`, and does one `git fetch --dry-run` per configured repo. It needs network access,
and each run costs a few cents.

**What a healthy fresh install looks like.** Once `claude` and `gh` are logged in (step 2), run
doctor from a plain terminal before any lead has started, and expect **no `FAIL` rows** and these
`????` rows:

| row | why it is unobserved |
|---|---|
| `workflows enabled` | always: no local file can answer it |
| `session id matches hook payload` | always on this build: nothing records a hook payload to compare with |
| `CLAUDE_CODE_SESSION_ID` | you are not inside a Claude Code session |
| `every worktree guard file carries rules` | no worktree exists yet |
| `guard file matches the generator` | no worktree exists yet |
| `lead mcp single-server` | no lead exists yet |

So the best verdict you will see is `INCOMPLETE`, never `PASS`. That is expected.

Before you log in, `claude auth` and `gh auth` read `FAIL`, and a seventh row is unobserved:
`claude cd-compound read runs` (*no Bash tool_use in the transcript*), because a Claude Code that
is not logged in never runs the probe's command. It reads `ok` once `claude` is logged in.

**Once a lead exists, expect one `FAIL`.** `lead mcp single-server` requires a lead's MCP config to
name exactly one server, `soma`. Leads have also been given the stateless sequential-thinking
server, and this doctor row was not updated to match. It then reads `FAIL`, and doctor exits 3.
Treat that row as known. Any other `FAIL` is real.

Rows that need action if they fail:

- `node>=24`, `tmux>=3.2`, `git>=2.31`, `claude auth`, `gh auth`: a prerequisite is missing inside
  WSL, or not logged in there.
- `claude cd-compound read runs`: your Claude Code build raises a permission prompt that bypass
  mode does not skip, on `cd <dir> && grep …`. **Do not spawn leads on that build.** Upgrade
  Claude Code, or see RUNBOOK §9 for the per-lead workaround.
- `lead PATH node vs engines.node`: the node a lead would find on its `PATH` is too old, or is the
  Windows one. Use the wrapper from step 4.
- `notifier`: `powershell.exe` is not on `PATH` inside WSL. See [WSL caveats](#wsl-caveats).
- `repo <name> base reachable`: the entry lacks `path` or `base_branch`, the path does not exist,
  or `git fetch` from `origin` fails without a prompt.

`repos readable — 0 repos configured` reads `ok`, but it only means there was nothing to probe.
Go back to step 6.

## 8. A first supervised run

Stay at the terminal for this. It is the use RUNBOOK §11 says the project is ready for.

Do all of it in a Windows Terminal Ubuntu tab, not over SSH (see [WSL caveats](#wsl-caveats)).

1. **Open the queue.**

   ```bash
   soma up
   ```

   `up` prints a worst-case token projection and asks you to type `yes`. There is no `--yes` flag,
   and it refuses to run without a terminal. Do **not** use `--canary`: it cannot pass on this
   build.

2. **Start the orchestrator inside soma's own tmux server, and promote it.** In the same
   Windows Terminal Ubuntu tab, run:

   ```bash
   tmux -L soma new-session -s orchestrator
   claude                      # in the new tmux window; then type /soma-promote
   ```

   Keep this order: the tmux session first, `claude` inside it, then `/soma-promote`. Promotion
   records where the session is at that moment. A session promoted outside tmux, then moved or
   resumed into the tmux window, keeps desktop-notification-only wake-ups. If that happened, run
   `/soma-promote` again inside the tmux window.

   Inside soma's tmux server, a lead's urgent report reaches this session as a live keystroke.
   Detach with your tmux prefix (Ctrl-b by default), then `d`; reattach with
   `tmux -L soma attach -t orchestrator`. Use the same Claude Code config that `soma init`
   registered the bus in (a session started before `soma init` will not have it). Promotion is
   one tool call, `soma_adopt`; there is no restart. The session then drains events with
   `soma_inbox` and answers leads with `soma_send`.

   **A finished lead keeps its admission slot until the orchestrator drains its `COMPLETED` (or
   `ERROR`) report with `soma_inbox`.** Without a promoted session draining the inbox, finished
   leads go on holding their slots and the next queued task waits.

> [!WARNING]
> **Other places to run the orchestrator.** Outside tmux also works, but a lead's wake-up then
> arrives only as a desktop notification, and the events wait for your next turn: safe, only
> slower. The same holds in your own tmux, on any server that is not soma's: the bus cannot prove
> your pane is on soma's server, so it adopts with `wake notify` (`degraded_wake: true`). Only a
> pane on soma's own server gets keystroke wake-ups. For a fleet on another socket, such as
> `soma2`'s, start the orchestrator inside that fleet's own tmux server
> (`tmux -L soma_second new-session -s orchestrator`): a lead types its wake-ups only on its own
> fleet's server.

3. **Check the promotion.** From a second Ubuntu tab, or after detaching:

   ```bash
   soma status
   ```

   The `orchestrator:` line, `orchestrator: <id> (seq N, wake tmux, heartbeat …)`, must say
   `wake tmux`. `wake notify` means the session was promoted outside soma's tmux server: run
   `/soma-promote` again from inside it.

4. **Queue one small task.**

   ```bash
   cat > /tmp/tasks.json <<'JSON'
   [
     { "id": "my-task-1",
       "title": "one sentence",
       "repo": "my-repo",
       "brief": "What done looks like, how to check it, and what to leave alone." }
   ]
   JSON
   soma enqueue --file /tmp/tasks.json
   ```

   Ids must match `^[a-z][a-z0-9-]{0,63}$`. Invalid and duplicate rows are skipped and counted, not
   fatal, so compare the printed count with what you sent. Put the verify command inside `brief`:
   a separate `verify_hint` field is dropped at enqueue.

5. **Watch.**

   ```bash
   soma status
   soma peek my-task-1 --lines 60
   soma digest --lines 40      # read-only: consumes nothing
   soma attach my-task-1       # your terminal on the lead's pane; detach with your tmux prefix, then d
   ```

   Lead sessions live on soma's tmux server, so a plain `tmux attach` to `lead-<id>` finds
   nothing. Use `soma attach <lead>`, or `tmux -L soma attach -t lead-<id>`.

6. **Stop.** `soma down` stops the watchdog only. Running leads keep going, unsupervised, until you
   `soma kill <lead>` them.

Before you trust the fleet with more than this, establish the bring-up invariants by hand
(RUNBOOK §10). Most of them rest on undocumented Claude Code behaviour, so redo them after every
Claude Code upgrade.

## WSL caveats

- **Notifications need Windows interop.** soma recognises WSL by `microsoft` in `/proc/version`
  and shows a toast by running `powershell.exe` (Windows PowerShell, not `pwsh`). That needs WSL
  interop and the Windows `PATH`, both on by default (`[interop] enabled` and `appendWindowsPath`
  in `/etc/wsl.conf`, see [Microsoft: WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)).
  If you turned `appendWindowsPath` off, `powershell.exe` is not found and doctor's `notifier` row
  fails. Claude Code's troubleshooting page also advises against turning it off.
- **Shells that arrive over SSH have no Windows `PATH`.** WSL appends it only to processes started
  through `wsl.exe` or Windows Terminal, not to an `sshd` session (plain SSH, VS Code Remote-SSH
  and the like), even though interop itself works there. In such a session `which powershell.exe`
  finds nothing, doctor's `notifier` row fails, and a watchdog started from it shows no toasts.
  Start `soma up` from a Windows Terminal tab, or append
  `/mnt/c/Windows/System32/WindowsPowerShell/v1.0` to `PATH` in the wrapper.
- **The Windows `PATH` can shadow Linux tools.** Because the Windows `PATH` is appended, a tool you
  forgot to install inside WSL can silently resolve to its Windows build. Re-run
  `which node npm npx git gh tmux claude` after any change.
- **WSL can stop an idle distribution, and the fleet with it.** Microsoft documents an idle
  shutdown for distributions (`instanceIdleTimeout`, default 15 seconds, `-1` disables it) and,
  on Windows 11, for the WSL 2 virtual machine (`vmIdleTimeout`), both in `%UserProfile%\.wslconfig`
  ([Microsoft: WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)).
  Whether a running tmux server keeps the distribution busy enough has **not** been tested with
  soma. Keep a WSL terminal open while a fleet runs. After closing your terminals, check from
  PowerShell with `wsl --list --running`. If the fleet stops when the last terminal closes, set
  this in `%UserProfile%\.wslconfig` and apply it with `wsl --shutdown`:

  ```ini
  [general]
  instanceIdleTimeout=-1
  ```

- **`wsl --shutdown`, a Windows restart or a WSL update stops everything.** There is no autostart.
  Open WSL and run `soma up` again, then `soma status`. State, worktrees and branches survive; the
  tmux sessions do not.
- **SSH keys and the agent.** Leads start under `env -i` with a short allow-list (`HOME`, `PATH`,
  `SHELL`, `TERM`, `LANG`, `TMPDIR`, `CLAUDE_CONFIG_DIR`, `USER`), so `SSH_AUTH_SOCK` does not reach
  them. A key that `ssh` finds through `HOME` works for a teammate's `git push`; a key that needs
  an agent or a passphrase does not. `docs/ROADMAP.md` explains why the socket stays out.
- **tmux-resurrect and tmux-continuum.** If your `~/.tmux.conf` inside WSL loads them, they apply to
  soma's own tmux server too (`tmux -L soma`). After a restart they can restore lead sessions as
  bare shells. `soma status` then shows `PANE shell`, and the event is `LEAD_DEAD_SHELL`.
- **Claude Code updates itself.** The native installer updates in the background
  ([Claude Code setup](https://code.claude.com/docs/en/setup)). The watchdog reads
  `claude --version` once per process and closes admission when the version leaves
  `tested_claude` (event `VERSION_GATE`). After an upgrade, restart it (`soma down`, then
  `soma up`) and re-check doctor and the RUNBOOK §10 invariants.

## Report what happened

Copy this into your notes or a bug report as you go. Redact home paths, account names and
repository names first: use `$HOME`, `~/.soma` and `my-repo` instead.

```text
Platform
- Windows version (winver, or `ver` in CMD):
- wsl --version (first lines):
- wsl -l -v (distribution name and VERSION column):
- Distribution and version inside WSL (cat /etc/os-release, PRETTY_NAME):
- node -v:
- tmux -V:
- git --version:
- claude --version:
- gh --version (first line):
- `which node npm npx git gh tmux claude` (any path under /mnt/c/?):
- soma commit (git -C "$HOME/claude-soma-lite" rev-parse --short HEAD):

Install
- [ ] npm test: tests ___ pass ___ fail ___ (name any failing test)
- [ ] `type soma` says it is a function
- [ ] soma init exit code: ___
- [ ] its "bus: registered … SOMA_HOME=" line shows the root I meant
- [ ] its "inject hook:" line said: registered / NOT installed / NOT OBSERVED
- [ ] soma.json written, with max_leads 1 and one repo (a Linux path)

Doctor
- [ ] summary line (copy it):
- [ ] exit code: ___
- [ ] FAIL rows (name each):
- [ ] ???? rows (name each, and say whether the table in step 7 explains it):
- [ ] claude cd-compound read runs: ok / FAIL / ????
- [ ] notifier: ok / FAIL (and the path it found for powershell.exe)

First run
- [ ] soma up showed the projection and asked for "yes"
- [ ] watchdog line after "yes" (copy it):
- [ ] /soma-promote in a fresh claude session inside tmux -L soma: adopted true / false
- [ ] soma_inbox, soma_send and the other control tools appeared after promotion (yes / no / next turn)
- [ ] soma status orchestrator line said: wake tmux / wake notify
- [ ] soma enqueue printed: queued ___ skipped ___
- [ ] the lead appeared in soma status (STATUS / LIVE / PANE columns):
- [ ] a Windows toast appeared (yes / no / which event):
- [ ] the lead reported STARTED and HARNESS (check soma digest)
- [ ] a teammate pushed the soma/<id> branch (yes / no / error)
- [ ] a draft PR was opened (link, or "no")
- [ ] soma doctor after the first lead: the lead mcp single-server row read ___
- [ ] closing every WSL terminal: did the fleet keep running? (wsl --list --running, then soma status)
- [ ] soma down printed "Running leads were NOT stopped"

Anything surprising (what you ran, what you expected, what happened):

How long each step took:
```
