# Installing claude-soma-lite on Linux

This guide takes a Linux machine from nothing to a first supervised run, with commands for
Ubuntu and Debian (`apt`) and for Fedora (`dnf`). Each step says what to type and what you should
see. It ends with a checklist you fill in as you go, so that a test run produces a report someone
else can act on.

Read [`RUNBOOK.md`](../../RUNBOOK.md) before you point the fleet at a repository you care about.
soma runs Claude Code sessions with permission prompts bypassed, and §11 of the runbook says plainly
what its guardrails do not cover.

- [What you need](#what-you-need)
- [Which distributions are new enough](#which-distributions-are-new-enough)
- [1. Install the prerequisites](#1-install-the-prerequisites)
- [2. Get claude-soma-lite](#2-get-claude-soma-lite)
- [3. Add the `soma` wrapper](#3-add-the-soma-wrapper)
- [4. `soma init`](#4-soma-init)
- [5. Write `soma.json`](#5-write-somajson)
- [6. `soma doctor`, and how to read it](#6-soma-doctor-and-how-to-read-it)
- [7. A first supervised run](#7-a-first-supervised-run)
- [Linux caveats](#linux-caveats)
- [Report what happened](#report-what-happened)

## What you need

| need | version | why |
|---|---|---|
| Node.js | **24 or newer** | soma's hard floor (`engines.node` is `>=24`) |
| tmux | 3.2 or newer | every lead, and the watchdog, is a tmux session |
| git | 2.31 or newer | one git worktree per task |
| Claude Code (`claude`) | logged in | every lead is a `claude` process |
| GitHub CLI (`gh`) | logged in | draft pull requests are opened through it |
| `notify-send` | any | desktop notifications (optional, but `soma doctor` checks for it) |

soma itself has no npm dependencies, so there is nothing to `npm install`. Each lead does start one
extra MCP server, `npx -y @modelcontextprotocol/server-sequential-thinking`, so leads need `npx` and
access to the npm registry whenever the package is not already cached.

## Which distributions are new enough

The tmux and git floors decide this. The versions below are what each release's own repositories
ship, as listed by [packages.ubuntu.com](https://packages.ubuntu.com/search?keywords=tmux&searchon=names&exact=1&suite=all&section=all),
[packages.debian.org](https://packages.debian.org/search?keywords=tmux&searchon=names&exact=1&suite=all&section=all)
and [packages.fedoraproject.org](https://packages.fedoraproject.org/pkgs/tmux/tmux/) when this guide
was written.

| release | tmux | git | new enough? |
|---|---|---|---|
| Ubuntu 22.04 LTS (jammy) | 3.2a | 2.34.1 | yes |
| Ubuntu 24.04 LTS (noble) | 3.4 | 2.43.0 | yes |
| Ubuntu 25.10 (questing) | 3.5a | 2.51.0 | yes |
| Ubuntu 26.04 LTS (resolute) | 3.6a | 2.53.0 | yes |
| Debian 11 (bullseye) | 3.1c | 2.30.2 | **no**: both are below the floor |
| Debian 12 (bookworm) | 3.3a | 2.39.5 | yes |
| Debian 13 (trixie) | 3.5a | 2.47.3 | yes |
| Fedora 43, 44, 45 | 3.7c | 2.55 or 2.56 | yes |

Whatever your distribution, `tmux -V` and `git --version` are the real test. `soma doctor` checks
both.

## 1. Install the prerequisites

**Base packages.** On Ubuntu or Debian:

```bash
sudo apt update
sudo apt install -y tmux git curl libnotify-bin
```

On Fedora:

```bash
sudo dnf install -y tmux git curl libnotify
```

`libnotify-bin` (Ubuntu, Debian) and `libnotify` (Fedora) provide `notify-send`. Then check:

```bash
tmux -V            # must print 3.2 or newer
git --version      # must print 2.31 or newer
```

**Node 24, through nvm.** Distribution Node packages are often older than 24, and soma pins an
absolute path to the node it should use (step 3), which nvm makes easy to find. The install line
below is the one in the [nvm README](https://github.com/nvm-sh/nvm#install--update-script) at the
time of writing; check it for a newer version.

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
```

Open a new terminal so nvm loads, then:

```bash
nvm install 24
nvm alias default 24   # otherwise a new terminal goes back to any older default
node -v            # must print v24.x or newer
```

**Claude Code.** The native installer works on both families. Claude Code also publishes signed
`apt` and `dnf` repositories; see
[Claude Code setup](https://code.claude.com/docs/en/setup#install-with-linux-package-managers).

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude --version
```

If you installed Claude Code earlier with `npm install -g`, the native installer migrates it and
removes the npm copy without asking. `which claude` must then print a path ending in
`.local/bin/claude`.

Log in by running `claude` once and following the prompts. On a machine without a browser (over
SSH, for example), the browser on your own computer shows a code after you sign in; paste it at
the `Paste code here if prompted` prompt, or use `claude auth login`
([troubleshooting login](https://code.claude.com/docs/en/troubleshoot-install)). Claude Code needs a
Pro, Max, Team, Enterprise or Console account.

**GitHub CLI.** On Ubuntu or Debian, use GitHub's own `apt` repository. The community `gh` package
in Debian and Ubuntu is not recommended by the GitHub CLI maintainers. These commands are from
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

On Fedora, the packaged `gh` is maintained by the Fedora community:

```bash
sudo dnf install -y gh
```

Then, on either:

```bash
gh auth login
gh auth status
```

## 2. Get claude-soma-lite

Clone it anywhere. This guide uses `$HOME/claude-soma-lite`.

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
That failure is about your Claude Code version, not your install. Tests that need tmux or git skip
themselves when the tool is missing.

On Linux, `npm test` currently has known failures that come from the test fixtures, not from your
install. Expect up to four more:

- *the leads root is matched with the state root symlinks resolved, not as configured* assumes
  macOS's symlinked `$TMPDIR`
  ([issue 31](https://github.com/techfreakworm/claude-soma-lite/issues/31)).
- *a holder whose lock was taken over does not delete its successor on the way out*, *the
  checkpoint lock releases the lock it published, not whatever holds that name* and *a takeover
  unlinks the file it judged, or nothing at all* assume a deleted file's inode number is not
  reused at once. ext4 reuses it, so they fail there
  ([issue 30](https://github.com/techfreakworm/claude-soma-lite/issues/30)).

*the write-idiom scan stays linear on the shapes that made it quadratic* is a timing test and can
also fail on a busy machine
([issue 33](https://github.com/techfreakworm/claude-soma-lite/issues/33)).

## 3. Add the `soma` wrapper

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

Add this to `~/.bashrc` (or `~/.zshrc` if you use zsh). Replace the `SOMA_NODE_DIR` value with the
path you just printed, and `SOMA_REPO` with your clone if you put it elsewhere:

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

The function lives in your shell rc file, so only interactive shells see it. Ubuntu's `.bashrc`
returns early for a non-interactive shell, so a command run over `ssh`, a cron job or a script has
no `soma`. A script should call `"$SOMA_NODE_DIR/node" "$SOMA_REPO/bin/soma.mjs"` with the same
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
  (`CLAUDE_CONFIG_DIR="$HOME/.claude-second" claude`) and outside tmux; the warning in
  [A first supervised run](#7-a-first-supervised-run) says why.

## 4. `soma init`

```bash
soma init
```

`init` creates the state tree, installs the `/soma-promote` skill into your Claude Code config, and
registers the soma MCP server (the *bus*) at user scope, so that any Claude Code session can later be
promoted to orchestrator. The skill and the registration are read back, not assumed. It is safe to
re-run.

Read the output. These lines matter:

- `state root: …` should be your `$HOME/.soma`, spelled out.
- `bus: registered at user scope, candidate role, SOMA_HOME=…`: **check that this is the root you
  meant.** The registration pins it. A bus pinned to the wrong root makes a promoted session show
  an empty fleet while your real fleet runs out of sight.
- `inject hook: …` reports whether the optional prompt-inject hook is registered. `soma init` never
  installs it. The README explains how to add it by hand.
- The last line is ``soma initialized. Next: `soma doctor`, then `soma up`.``

Exit codes: 0 means everything was set up. 2 means something could not be established, and the line
above it says what.

## 5. Write `soma.json`

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

- Give both `path` and `base_branch`. The base falls back to `develop` when omitted.
- The repository needs an `origin` remote that this machine can fetch without a prompt. Each
  worktree is cut from a fresh fetch of `origin/<base_branch>`.
- Start at `max_leads: 1`. The default is 10, and `soma up` will show you what 10 could cost.

The README has the full list of `soma.json` keys.

## 6. `soma doctor`, and how to read it

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

**What a healthy fresh install looks like.** Once `claude` and `gh` are logged in (step 1), run
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

**Once a lead exists, `lead mcp single-server` reads `ok`.** Despite its name, it checks that a
lead's MCP config names exactly the two servers soma writes there: `soma` and the stateless
sequential-thinking server. Any `FAIL` on it, as on every other row, is real.

Rows that need action if they fail:

- `node>=24`, `tmux>=3.2`, `git>=2.31`, `claude auth`, `gh auth`: a prerequisite is missing or not
  logged in.
- `claude cd-compound read runs`: your Claude Code build raises a permission prompt that bypass
  mode does not skip, on `cd <dir> && grep …`. **Do not spawn leads on that build.** Upgrade
  Claude Code, or see RUNBOOK §9 for the per-lead workaround.
- `lead PATH node vs engines.node`: the node a lead would find on its `PATH` is too old. Use the
  wrapper from step 3.
- `notifier`: `notify-send` is not on `PATH`. Install `libnotify-bin` (Ubuntu, Debian) or
  `libnotify` (Fedora).
- `repo <name> base reachable`: the entry lacks `path` or `base_branch`, the path does not exist,
  or `git fetch` from `origin` fails without a prompt.

`repos readable — 0 repos configured` reads `ok`, but it only means there was nothing to probe.
Go back to step 5.

## 7. A first supervised run

Stay at the terminal for this. It is the use RUNBOOK §11 says the project is ready for.

1. **Open the queue.**

   ```bash
   soma up
   ```

   `up` prints a worst-case token projection and asks you to type `yes`. There is no `--yes` flag,
   and it refuses to run without a terminal. Do **not** use `--canary`: it cannot pass on this
   build.

2. **Start the orchestrator inside soma's own tmux server, and promote it.**

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
> slower. **Never start the orchestrator in your own tmux while leads are running:** the bus
> records your pane's id without checking which tmux server it is on, and a wake-up is typed into
> the pane with that id on soma's server, which can be a lead's or a teammate's. For a fleet on
> another socket, such as `soma2`'s, start the orchestrator outside tmux: on this build, leads
> send every wake-up to the default `soma` server ([issue #1](https://github.com/techfreakworm/claude-soma-lite/issues/1)).

3. **Check the promotion.** From a second terminal, or after detaching:

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

## Linux caveats

- **Headless machines.** `notify-send` needs a desktop notification daemon. On a server it may be
  installed and still show nothing, and `soma doctor` only checks that it is on `PATH`. When the
  watchdog has no session-bus address in its environment, soma points `notify-send` at the
  standard per-user socket (`$XDG_RUNTIME_DIR/bus`, or `/run/user/<uid>/bus`).
- **Logging out.** soma expects its tmux server to keep running after you close the terminal. On a
  system where `KillUserProcesses=yes` is set in `logind.conf`, logging out kills the session's
  processes, and the [`logind.conf` man page](https://man7.org/linux/man-pages/man5/logind.conf.5.html)
  warns that this breaks tmux. If the fleet dies when you log out, check that setting.
- **SSH keys and the agent.** Leads start under `env -i` with a short allow-list (`HOME`, `PATH`,
  `SHELL`, `TERM`, `LANG`, `TMPDIR`, `CLAUDE_CONFIG_DIR`, `USER`), so `SSH_AUTH_SOCK` does not reach
  them. A key that `ssh` finds through `HOME` works for a teammate's `git push`; a key that needs
  an agent or a passphrase does not. `docs/ROADMAP.md` explains why the socket stays out.
- **Keep `SOMA_HOME` on a volume with hard links.** Every lock is published with `link(2)`. On
  exFAT, FAT, and some FUSE or network mounts, `soma init` and `soma up` refuse with exit 2.
- **tmux-resurrect and tmux-continuum.** If your `~/.tmux.conf` loads them, they apply to soma's
  own tmux server too (`tmux -L soma`). After a reboot they can restore lead sessions as bare
  shells. `soma status` then shows `PANE shell`, and the event is `LEAD_DEAD_SHELL`.
- **No autostart.** There is no systemd unit. After a reboot, run `soma up` again, then
  `soma status`.
- **Claude Code updates itself.** The native installer updates in the background; `apt` and `dnf`
  installs do not ([Claude Code setup](https://code.claude.com/docs/en/setup)). The watchdog reads
  `claude --version` once per process and closes admission when the version leaves
  `tested_claude` (event `VERSION_GATE`). After an upgrade, restart it (`soma down`, then
  `soma up`) and re-check doctor and the RUNBOOK §10 invariants.

## Report what happened

Copy this into your notes or a bug report as you go. Redact home paths, account names and
repository names first: use `$HOME`, `~/.soma` and `my-repo` instead.

```text
Platform
- Distribution and version (cat /etc/os-release, PRETTY_NAME):
- Architecture (uname -m):
- Desktop session, or headless:
- node -v:
- tmux -V:
- git --version:
- claude --version:
- gh --version (first line):
- How Claude Code was installed (native installer / apt / dnf):
- How gh was installed (GitHub's repository / distribution package):
- soma commit (git -C "$HOME/claude-soma-lite" rev-parse --short HEAD):

Install
- [ ] npm test: tests ___ pass ___ fail ___ (name any failing test)
- [ ] `type soma` says it is a function
- [ ] soma init exit code: ___
- [ ] its "bus: registered … SOMA_HOME=" line shows the root I meant
- [ ] its "inject hook:" line said: registered / NOT installed / NOT OBSERVED
- [ ] soma.json written, with max_leads 1 and one repo

Doctor
- [ ] summary line (copy it):
- [ ] exit code: ___
- [ ] FAIL rows (name each):
- [ ] ???? rows (name each, and say whether the table in step 6 explains it):
- [ ] claude cd-compound read runs: ok / FAIL / ????
- [ ] notifier: ok / FAIL

First run
- [ ] soma up showed the projection and asked for "yes"
- [ ] watchdog line after "yes" (copy it):
- [ ] /soma-promote in a fresh claude session inside tmux -L soma: adopted true / false
- [ ] soma_inbox, soma_send and the other control tools appeared after promotion (yes / no / next turn)
- [ ] soma status orchestrator line said: wake tmux / wake notify
- [ ] soma enqueue printed: queued ___ skipped ___
- [ ] the lead appeared in soma status (STATUS / LIVE / PANE columns):
- [ ] a desktop notification appeared (yes / no / which event):
- [ ] the lead reported STARTED and HARNESS (check soma digest)
- [ ] a teammate pushed the soma/<id> branch (yes / no / error)
- [ ] a draft PR was opened (link, or "no")
- [ ] soma doctor after the first lead: the lead mcp single-server row read ___
- [ ] soma down printed "Running leads were NOT stopped"

Anything surprising (what you ran, what you expected, what happened):

How long each step took:
```
