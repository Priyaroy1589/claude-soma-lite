# Security policy

## Supported versions

claude-soma-lite is pre-release software. `package.json` says `0.1.0`, and no release has been
tagged yet.

| Version | Supported |
|---|---|
| 0.1.x, the current `main` | Yes. Fixes land on `main`. |
| An older checkout | No. Update to `main` and check again before you report. |

There are no backports and no maintained release branches.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub, using the **Report a vulnerability** form for this repository:

<https://github.com/techfreakworm/claude-soma-lite/security/advisories/new>

Only you and the maintainers can read a report filed there. This project does not take security
reports by email.

A useful report includes:

- the commit you ran (`git rev-parse --short HEAD` in your checkout);
- your platform (macOS, a Linux distribution, or Windows with WSL2), plus the output of `node -v`,
  `tmux -V`, `git --version`, `claude --version` and `gh --version`;
- which session crossed the boundary: the orchestrator session, a lead, or one of a lead's
  teammates;
- the exact tool call or command string, and what it reached;
- your `soma doctor` output, with home paths, account names and repository names redacted;
- the section of [RUNBOOK.md §11](RUNBOOK.md#11-what-is-not-guaranteed) you compared it with, and
  why you think it is something else (see
  [Declared residual or new vulnerability?](#declared-residual-or-new-vulnerability) below).

Never put a real credential, token, cookie or private repository content in a report. Reproduce
with synthetic files in a scratch directory. The credential residuals in RUNBOOK §11.4 were
measured that way.

### What happens next

Reports are handled on a best-effort basis. There is no fixed response time and no bug bounty.
The reply, the fix and the disclosure plan are all worked out on the report thread. If you want to
be credited in the published advisory, say so in the report.

## Why this project is security-sensitive

claude-soma-lite starts Claude Code sessions that run **unattended, with permission prompts
bypassed, inside your own repositories**:

- Every lead is a detached `claude` process in a tmux session, launched with
  `--dangerously-skip-permissions`. Its teammates are further `claude` processes, also running
  with permissions bypassed. Nobody is watching the panes.
- They edit and commit code in real git worktrees, push task branches, and open pull requests
  using your authenticated `gh`.
- They spend real money. `soma up` shows a worst-case token projection and makes you type `yes`
  before the queue opens.

With the prompts gone, these guardrails do the job:

1. **Deny rules** that soma writes into each worktree's `.claude/settings.local.json` (the *guard
   file*). They refuse:
   - pushes to `main` and `develop`, `--all` and `--mirror` pushes, force pushes, and branch
     deletes;
   - `gh pr merge`, `gh pr ready`, `gh pr edit` and raw `gh pr create`. The only route to a pull
     request is `bin/soma-pr.mjs`, which always passes `--draft`;
   - the `gh api` paths that reach pull requests, merges, refs and file contents;
   - the credential-store family: the macOS keychain CLI, keyring tools, SSH keys, cloud and `gh`
     credential files, Claude Code's own token file, and browser cookie and password stores,
     both as `Bash(...)` and as `Read(...)` rules;
   - every personal MCP server configured on the machine, plus claude.ai connectors and plugin
     MCP servers by prefix.
2. **A PreToolUse gate hook** (`bin/hooks/lead-gate.mjs`) that runs on every tool call in the
   worktree. It enforces the budget breaker, keeps the soma bus for the lead alone, keeps the
   lead's sequential-thinking server from teammates unless `teammate_mcp_allow` names it, refuses
   `git merge` and every `git push` to the lead itself except its own branch to `origin`
   (`git push -u origin soma/<id>`, as a command of its own from its worktree root;
   `lead_branch_push: false` in `soma.json` takes that one away too; the gate reads the command
   and the working directory, not git config, so config set by an earlier command, such as
   `push.followTags` or `remote.origin.pushurl`, can widen what that push sends or where it goes),
   and refuses writes into `.claude/` and under
   `$SOMA_HOME/leads/` from any session. The gate is also registered from a settings file outside
   the worktree, so emptying the guard file does not unregister it.
3. **A scrubbed environment.** Leads start under `env -i` with an allow-list of eight variables,
   plus the few that soma sets itself, so API keys and tokens exported in your shell do not reach
   them.
4. **A fixed MCP surface for leads.** `--strict-mcp-config` limits a lead to the soma bus and the
   stateless sequential-thinking server.
5. **`soma doctor`**, which re-checks most of the above on your machine.

These guardrails have a hard ceiling, and [RUNBOOK.md §11](RUNBOOK.md#11-what-is-not-guaranteed)
states it plainly: the gate and the deny rules read **command strings**, so a subprocess
(`python -c`, `node -e`, a script a teammate writes) gets past them. OS-level sandboxing is the
only real fix, and it is not built. That is why this project's own verdict is **supervised use
only**: you at the terminal, a small fleet, `soma status` within reach.

## Scope

**In scope.** Please report:

- A way past a boundary that the RUNBOOK says holds. For example: a single-command spelling of a
  protected-branch push, a force push, `gh pr merge`, `gh pr ready` or a named credential read
  that the deny rules should catch; a teammate that can use the soma bus or take the
  orchestrator lease; a write into `.claude/` or `$SOMA_HOME/leads/` that the gate is documented
  to refuse; a variable outside the allow-list reaching a lead's environment; a teammate reaching
  a personal MCP server that the guard file should deny; a non-draft pull request opened through
  soma's own path.
- A guardrail that is silently inert: a `soma doctor` row that reads `ok` while the thing it
  checks is broken, a hook that is registered but never runs, or a deny rule that can never match.
- A declared residual that is bigger than RUNBOOK §11 says. This has happened before: §11.3 once
  understated the number of deny rules an erased guard file loses, by 37.
- soma's own code leaking a secret into world-readable state (`$SOMA_HOME/leads/<id>/`, the event
  logs, the pane logs) or into a pull request.

**Out of scope.** These are not vulnerabilities in this project:

- An instance of a residual that RUNBOOK §11 already declares (see the table below).
- Vulnerabilities in Claude Code itself. Report those to Anthropic, following the policy at
  <https://github.com/anthropics/claude-code/security>. The same goes for tmux, git, `gh` and
  Node.js: report to those projects.
- Anything that needs an attacker to already control your shell, your `soma.json` or your Claude
  Code configuration.
- Token spend in itself. A large bill from a large fleet is a documented cost, and the spend gate
  in `soma up` is the control for it.

## Declared residual or new vulnerability?

RUNBOOK §11 lists what is **not** guaranteed. Every item was measured during the build and
shipped knowingly. Check your finding against it before you report:

| If your finding is... | It is | RUNBOOK |
|---|---|---|
| a write through an interpreter or subprocess (`python -c`, `node -e`, `eval`, a script) | declared | §11.1 |
| `xargs` acting on paths that arrive only on stdin | declared | §11.2 |
| a session emptying its own worktree guard file for the rest of that session | declared | §11.3 |
| a credential path reached through case variation, or through quotes or backslashes inside the filename | declared | §11.4 |
| writes into `state/`, `events/`, `logs/`, `digests/` or `heartbeats/` under `$SOMA_HOME` | declared | §11.5 |
| the lock takeover race (measured at 0.28 to 1.63 violations per 1,000 provoked takeovers) | declared | §11.6 |
| "the model refused when I tried it", offered as protection | not a layer at all | §11.8 |

Then ask four questions:

1. **Is it the same mechanism as a declared residual?** If so, it is known. An issue with a fix
   idea is still welcome, filed as an ordinary issue.
2. **Does it get past something that §11 or the deny rules say is closed?** That is new. For
   example, §11.4 says the *named* single-command credential paths are closed, so a plain spelling
   of one of them that gets through is a vulnerability.
3. **Is the residual larger than §11 says, or does it combine with another one into something
   worse?** Report it. A residual that under-alarms is worse than one that over-alarms, and §11.0
   explains why residuals that compose matter.
4. **Does `soma doctor` say `ok` about it?** Report it. In this project, a check that cannot fail
   counts as a defect.

If you are unsure, report it privately anyway. Closing a report as a known residual costs little;
a real bypass filed as a public issue costs a lot more.
