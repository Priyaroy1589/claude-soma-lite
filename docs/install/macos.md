# Installing claude-soma-lite on macOS

This guide takes a Mac from nothing to a first supervised run. Each step says what to type and what
you should see. It ends with a checklist you fill in as you go, so that a test run produces a
report someone else can act on.

Read [`RUNBOOK.md`](../../RUNBOOK.md) before you point the fleet at a repository you care about.
soma runs Claude Code sessions with permission prompts bypassed, and §11 of the runbook says plainly
what its guardrails do not cover.

- [What you need](#what-you-need)
- [1. Install the prerequisites](#1-install-the-prerequisites)
- [2. Get claude-soma-lite](#2-get-claude-soma-lite)
- [3. Add the `soma` wrapper](#3-add-the-soma-wrapper)
- [4. `soma init`](#4-soma-init)
- [5. Write `soma.json`](#5-write-somajson)
- [6. `soma doctor`, and how to read it](#6-soma-doctor-and-how-to-read-it)
- [7. A first supervised run](#7-a-first-supervised-run)
- [macOS caveats](#macos-caveats)
- [Report what happened](#report-what-happened)

## What you need

| need | version | why |
|---|---|---|
| macOS | 13 or newer | Claude Code's own floor ([Claude Code setup](https://code.claude.com/docs/en/setup)) |
| Node.js | **24 or newer** | soma's hard floor (`engines.node` is `>=24`) |
| tmux | 3.2 or newer | every lead, and the watchdog, is a tmux session |
| git | 2.31 or newer | one git worktree per task |
| Claude Code (`claude`) | logged in | every lead is a `claude` process |
| GitHub CLI (`gh`) | logged in | draft pull requests are opened through it |

soma itself has no npm dependencies, so there is nothing to `npm install`. Each lead does start one
extra MCP server, `npx -y @modelcontextprotocol/server-sequential-thinking`, so leads need `npx` and
access to the npm registry whenever the package is not already cached.

## 1. Install the prerequisites

These commands use [Homebrew](https://brew.sh). Install it first if `brew --version` fails.

```bash
brew install tmux git gh
tmux -V            # must print 3.2 or newer
git --version      # must print 2.31 or newer
```

**Node 24, through nvm.** soma pins an absolute path to the node it should use (step 3), and nvm
makes that path easy to find. The install line below is the one in the
[nvm README](https://github.com/nvm-sh/nvm#install--update-script) at the time of writing; check it
for a newer version. On a new Mac there may be no `~/.zshrc` yet, and then the installer adds nvm
to no profile (nvm README, *Troubleshooting on macOS*), so create the file first; `touch` is
harmless if it exists.

```bash
touch ~/.zshrc
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
```

Open a new terminal so nvm loads, then:

```bash
nvm install 24
node -v            # must print v24.x or newer
```

**Claude Code.** Use the native installer, or the Homebrew cask. Both are documented in
[Claude Code setup](https://code.claude.com/docs/en/setup).

```bash
curl -fsSL https://claude.ai/install.sh | bash
# or: brew install --cask claude-code
claude --version
```

Log in by running `claude` once and following the browser prompts (`claude auth login` also works).
Claude Code needs a Pro, Max, Team, Enterprise or Console account.

**GitHub CLI.** Log in, and check that it works:

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
That failure is about your Claude Code version, not your install.

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

Add this to `~/.zshrc`. Replace the `SOMA_NODE_DIR` value with the path you just printed, and
`SOMA_REPO` with your clone if you put it elsewhere:

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
source ~/.zshrc
type soma          # should say: soma is a shell function
soma help          # prints the usage text
```

> **zsh:** if you already have an `alias soma=…`, delete it. zsh expands the alias inside the
> function definition and you get `parse error near '()'`.

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

**What a healthy fresh install looks like.** Run from a plain terminal before any lead has started,
expect **no `FAIL` rows** and these `????` rows:

| row | why it is unobserved |
|---|---|
| `workflows enabled` | always: no local file can answer it |
| `session id matches hook payload` | always on this build: nothing records a hook payload to compare with |
| `CLAUDE_CODE_SESSION_ID` | you are not inside a Claude Code session |
| `every worktree guard file carries rules` | no worktree exists yet |
| `guard file matches the generator` | no worktree exists yet |
| `lead mcp single-server` | no lead exists yet |

So the best verdict you will see is `INCOMPLETE`, never `PASS`. That is expected.

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
- `notifier`: `osascript` is missing from `PATH`, so you get no desktop notifications.
- `repo <name> base reachable`: the entry lacks `path` or `base_branch`, the path does not exist,
  or `git fetch` from `origin` fails without a prompt.

`repos readable — 0 repos configured` reads `ok`, but it only means there was nothing to probe.
Go back to step 5.

## 7. A first supervised run

Stay at the terminal for this. It is the use RUNBOOK §11 says the project is ready for.

1. **Queue one small task.**

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

2. **Open the queue.**

   ```bash
   soma up
   ```

   `up` prints a worst-case token projection and asks you to type `yes`. There is no `--yes` flag,
   and it refuses to run without a terminal. Do **not** use `--canary`: it cannot pass on this
   build.

3. **Watch.**

   ```bash
   soma status
   soma peek my-task-1 --lines 60
   soma digest --lines 40      # read-only: consumes nothing
   soma attach my-task-1       # your terminal on the lead's pane; detach with your tmux prefix, then d
   ```

4. **Start the orchestrator inside soma's own tmux server, and promote it.**

   ```bash
   tmux -L soma new-session -s orchestrator
   claude                      # in the new tmux window; then type /soma-promote
   ```

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

5. **Stop.** `soma down` stops the watchdog only. Running leads keep going, unsupervised, until you
   `soma kill <lead>` them.

Before you trust the fleet with more than this, establish the bring-up invariants by hand
(RUNBOOK §10). Most of them rest on undocumented Claude Code behaviour, so redo them after every
Claude Code upgrade.

## macOS caveats

- **OAuth lives in the Keychain.** Leads start with a scrubbed environment, and the Keychain
  lookup needs `USER`. soma forwards it. If a lead's pane shows `Not logged in` in its status line,
  read RUNBOOK §10 (`oauthUnderEnvI`): the pane can look normal while only that corner line says the
  lead cannot reach the API.
- **SSH keys and the agent.** Leads start under `env -i` with a short allow-list (`HOME`, `PATH`,
  `SHELL`, `TERM`, `LANG`, `TMPDIR`, `CLAUDE_CONFIG_DIR`, `USER`), so `SSH_AUTH_SOCK` does not reach
  them. A key that `ssh` can use without the agent works for a teammate's `git push`; a key that
  needs the agent or an interactive passphrase does not. `docs/ROADMAP.md` explains why the socket
  stays out.
- **Case-insensitive file system.** APFS is usually case-insensitive while permission rules match
  case-sensitively. RUNBOOK §11.4 explains why that lets a case-varied credential path past the
  deny rules.
- **Keep `SOMA_HOME` on a volume with hard links.** Every lock is published with `link(2)`. On
  exFAT, FAT, and some FUSE or cloud-sync mounts, `soma init` and `soma up` refuse with exit 2.
- **tmux-resurrect and tmux-continuum.** If your `~/.tmux.conf` loads them, they apply to soma's
  own tmux server too (`tmux -L soma`). After a reboot they can restore lead sessions as bare
  shells. `soma status` then shows `PANE shell`, and the event is `LEAD_DEAD_SHELL`.
- **No autostart.** Nothing restarts soma after a reboot or log-out. Run `soma up` again, then
  `soma status`.
- **Sleep.** While the Mac sleeps, the watchdog and the leads sleep with it.
- **Claude Code updates itself.** The native installer updates in the background; Homebrew
  installs do not ([Claude Code setup](https://code.claude.com/docs/en/setup)). The watchdog reads
  `claude --version` once per process and closes admission when the version leaves
  `tested_claude` (event `VERSION_GATE`). After an upgrade, restart it (`soma down`, then
  `soma up`) and re-check doctor and the RUNBOOK §10 invariants.
- **Notifications** come from `osascript`. If none ever appear, check the notification settings in
  System Settings for the app that posts them.

## Report what happened

Copy this into your notes or a bug report as you go. Redact home paths, account names and
repository names first: use `$HOME`, `~/.soma` and `my-repo` instead.

```text
Platform
- macOS version (sw_vers -productVersion):
- Chip (uname -m):
- node -v:
- tmux -V:
- git --version:
- claude --version:
- gh --version (first line):
- How Claude Code was installed (native installer / Homebrew):
- soma commit (git -C "$HOME/claude-soma-lite" rev-parse --short HEAD):

Install
- [ ] npm test: tests ___ pass ___ fail ___ (name any failing test)
- [ ] `type soma` says it is a shell function
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

First run
- [ ] soma enqueue printed: queued ___ skipped ___
- [ ] soma up showed the projection and asked for "yes"
- [ ] watchdog line after "yes" (copy it):
- [ ] the lead appeared in soma status (STATUS / LIVE / PANE columns):
- [ ] a desktop notification appeared (yes / no / which event):
- [ ] /soma-promote in a fresh claude session: adopted true / false
- [ ] soma_inbox, soma_send and the other control tools appeared after promotion (yes / no / next turn)
- [ ] the lead reported STARTED and HARNESS (check soma digest)
- [ ] a draft PR was opened (link, or "no")
- [ ] soma doctor after the first lead: the lead mcp single-server row read ___
- [ ] soma down printed "Running leads were NOT stopped"

Anything surprising (what you ran, what you expected, what happened):

How long each step took:
```
