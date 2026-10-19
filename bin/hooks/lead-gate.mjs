#!/usr/bin/env node
/**
 * `lead-gate.mjs` — the PreToolUse gate: the runtime half of "leads never code".
 *
 * Four bans and one delivery, one process, and it is launched once per tool call. Two of
 * the bans bind the lead only; the `.claude/` / `$SOMA_HOME/leads/` family binds every
 * session in the worktree, teammates included; the delivery is for the lead alone:
 *
 *   1. **The budget breaker.** Once `leads/<id>/BUDGET_TRIPPED` exists the lead may
 *      no longer act. That flag is written by the watchdog when the declared budget
 *      class is spent, and this is the only thing that makes it bite — everything
 *      else about a trip is a message asking a model to stop.
 *   2. **The bus belongs to the lead.** `mcp__soma__*` is allowed to the lead session
 *      and refused to everything else in the worktree: a teammate that mounted the
 *      user-scope bus would hold the role-less CANDIDATE surface, which carries
 *      `soma_adopt` — the orchestrator lease. Fails CLOSED on an unidentifiable
 *      session; arm (b2) below states why that is safe. The lead's other server,
 *      `sequential-thinking`, is held the same way (arm b3): the lead always, a teammate
 *      only when `teammate_mcp_allow` names it.
 *   3. **The lead's push/merge ban** — all that remains of the old lead-only
 *      write-idiom arm, now that a lead's shell-write surface matches a teammate's:
 *      `git push` and `git merge`, in every global-option spelling, lead only. One
 *      exception: the lead may push its own branch, `git push -u origin soma/<id>`,
 *      as a command of its own from its worktree root, when soma.json's
 *      `lead_branch_push` is on (`SOMA_LEAD_BRANCH_PUSH=1` in the lead's environment).
 *      See `ownBranchPush` and arm (d) for exactly what that admits, and what it cannot see.
 *      (Two retired arms once sat beside it: the session-discriminated edit ban,
 *      switched on by a `--session-guard` registration argument, and the full
 *      write-idiom ban whose `WRITE_IDIOMS`/`GIT_VERB` machinery stays below purely
 *      for the measurements its comments carry. Arm, flag and emits are gone;
 *      registrations written before the retirement may still pass the flag, and
 *      unknown argv is ignored.)
 *   4a. **Writes into `.claude/`, from anyone.** The worktree's
 *      `.claude/settings.local.json` is what denies a teammate the operator's MCP
 *      servers, database connections and authenticated connectors; a teammate that can
 *      blank it can lift every guard off itself. Claude Code's own `Edit(./.claude/**)`
 *      rule covers redirects and `sed -i` — verified — but not `tee`, `cp`, `dd of=` or
 *      `install`, each of which overwrote a real guard file in testing, nor `rsync`,
 *      `gzip`, `ex`, `patch`, `perl -i` or an `rm` reached through `xargs` or `find -exec`,
 *      each of which destroyed one in a later round — nor `view`, whose read-only mode is
 *      advice rather than permission, nor `tar -C`/`unzip -d`/`sort -o`, whose write target
 *      arrives as an option's value. See the `.claude/` section below for the measured A/B
 *      and the verb-by-verb evidence.
 *   4b. **Writes under `$SOMA_HOME/leads/`, from anyone.** The per-lead control directory
 *      holds `BUDGET_TRIPPED` and `HOLD` — the flags rule 1 reads — and `BUDGET_WARNED`, the
 *      one job 5 renames, plus the brief, the identity, and `settings.launch.json`, the
 *      `--settings` file whose registration is the only teammate enforcement that survives
 *      the worktree guard file being emptied.
 *      Measured before this rule existed: **all 12 vectors ALLOW as a teammate**, 10 of 12
 *      as a lead. Denied **by path prefix, never by filename**, and it binds every session
 *      because a teammate that empties the launch file disarms the gate for every teammate
 *      spawned after it. Carries one narrower companion: **the state root directory itself may
 *      not be a write target** (exact match, never a prefix — `worktrees/` lives under it), because
 *      `chmod 000 $SOMA_HOME` disarms the breaker by the identical mechanism. See the `leads/`
 *      section below for the ruling and its edge cases.
 *   5. **The 80% warning, delivered to the lead.** At 80% of the lead's allowance the watchdog
 *      writes `leads/<id>/BUDGET_WARNED` beside `BUDGET_TRIPPED`; the BUDGET event it also
 *      logs goes to the orchestrator's stream, which the lead never reads. This process runs
 *      on every tool call and is the one place that can tell the lead from a teammate, so it
 *      carries the note: on the lead's first call that nothing here denies, and only while
 *      the budget is not tripped, it claims the flag with one atomic `renameSync` to
 *      `BUDGET_WARNED.delivered` and, only if that rename won, prints the note as
 *      `additionalContext`. **That rename is the gate's one write, of a flag the watchdog
 *      wrote for it**; everything else here only reads. Teammates never see or consume the
 *      note. `budgetWarning` has the rules. The allowance is (1 + grants) times the budget class.
 *
 * **Fail-open is the design, not a concession.** Every path that is not a decided
 * deny exits 0 with nothing on stdout, which Claude Code reads as "this hook has no
 * opinion" — except the one call that delivers the 80% note (job 5), which still states
 * no opinion on the call and only adds context. A gate that crashes, times out, or
 * cannot parse its input lets the tool through, because an over-eager gate wedges a
 * lead — it cannot report, cannot wind down, and burns a slot until an operator
 * notices — while a missed idiom costs one stray write that the worktree's deny list,
 * the draft-only PR wrapper and the verifier all still stand behind. The residual hole
 * is declared in the spec: a lead can still write through a subprocess
 * (`python -c 'open(...,"w")'`); regexes narrow that, sealing it needs OS sandboxing.
 *
 * Allow is silence, never `permissionDecision: "allow"`. An explicit allow *bypasses*
 * the operator's own permission rules for that call, so a hook that answered "allow"
 * to everything it did not recognise would quietly promote the lead past every deny
 * in `settings.local.json`. The 80% note keeps that rule: its output carries
 * `additionalContext` and no `permissionDecision` key at all, so the call goes on to the
 * permission system exactly as it would after silence.
 *
 * Nothing is imported from `../lib/`. This is the most safety-critical of the four
 * hooks and the one that runs most often, so it depends on `node:` only: a typo in a
 * shared module cannot disarm the breaker, and the process does no I/O beyond one
 * `existsSync` (a lead's own calls pay a second, for `BUDGET_WARNED`; while a warning
 * waits, a third re-checks the trip, the call that delivers it pays one `renameSync`, and
 * the lead's own-branch push pays two `realpathSync`s, to find its worktree).
 */
import { existsSync, realpathSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * A lead id, and therefore a path segment: `leads/<id>/BUDGET_TRIPPED`.
 *
 * Mirrors `fleet.mjs`'s (unexported) `ID_RE` and `bus-tools.mjs`'s `LEAD_RE` rather
 * than importing either, because this module stays dependency-free. An id that is
 * not one of these never reaches the filesystem: `SOMA_LEAD_NAME=../../x` would
 * otherwise turn a hook that runs on every tool call into an existence probe for any
 * path on the machine.
 */
const LEAD_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * The soma bus, exempt from the breaker.
 *
 * "Denies everything once BUDGET_TRIPPED exists; the lead can still talk and
 * `soma_report`, not act" (spec §9). Without this carve-out the wind-down
 * instruction the watchdog sends is an instruction the lead is mechanically unable
 * to obey: it could not file COMPLETED or ERROR, and a lead that goes silent looks
 * exactly like a lead that died. None of the three bus tools touch a repo.
 */
const BUS_TOOL = /^mcp__soma__/;

/**
 * The lead's other MCP server, and its tools: `settings-gen.writeLeadMcpConfig` writes exactly two
 * servers into a lead's mcp.json, `soma` and this one. Spelled here rather than imported, because
 * this module stays dependency-free. Arm (b3) is its whole use.
 */
const REASONING_SERVER = 'sequential-thinking';
const REASONING_TOOL = /^mcp__sequential-thinking__/;

/**
 * Has the operator handed `server` back to teammates? `SOMA_TEAMMATE_MCP_ALLOW` is soma.json's
 * `teammate_mcp_allow`, comma-joined by `spawn.buildLeadEnv` and inherited by every teammate from
 * its lead. Exact names only, so `sequential-thinking-x` does not name `sequential-thinking`;
 * anything that is not a string names nothing.
 */
function teammateAllowed(env, server) {
  const list = env?.SOMA_TEAMMATE_MCP_ALLOW;
  return typeof list === 'string' && list.split(',').some((name) => name.trim() === server);
}

/**
 * Shell idioms that write without a redirect operator.
 *
 * Each is anchored at a command position — start of line, or after a separator,
 * optionally with a path prefix — so `cat notes-tee.txt` is a read and `/usr/bin/tee`
 * is still `tee`. `(?![-\w])` after the git subcommands is what keeps `git merge-base`
 * and `git commit-graph verify` (read-only plumbing a planning lead has real use for)
 * out of a ban aimed at `git merge` and `git commit`.
 *
 * These are matched against the **raw** command, unlike the redirect scan below,
 * which runs over a quote-masked copy. The asymmetry is deliberate and each half has
 * its own reason: a quoted `>` is nearly always a comparison or prose, while a quoted
 * `git commit` is nearly always `sh -c '…'` — the subprocess escape hatch the spec
 * declares as a residual hole, and the one wearing a disguise these three regexes can
 * still see through. The cost is that `echo "remember to git commit"` reads as a
 * write; the alternative is that `bash -c "git push"` does not.
 */
// Start of line, or after anything that can begin a command — a separator, a
// subshell, a backtick, or the opening quote of an `sh -c '…'` — then an optional
// path prefix, so `/usr/bin/tee` is `tee` and `cat notes-tee.txt` is not.
const CMD = String.raw`(?:^|[\s;&|("'\x60])(?:[\w.~/-]*\/)?`;

/**
 * One of git's **global** options — the ones that come *before* the subcommand.
 *
 * Without this, the verb list below only recognises a verb that is the first token
 * after `git`, and every global-option spelling walks straight through:
 * `git -C /repo commit -m x`, `git -c user.name=x commit`,
 * `git --git-dir=/r/.git --work-tree=/r commit` are all *exactly* `git commit`. That
 * is not the declared subprocess residual — it is the banned verb, unwrapped, in the
 * form a lead reaches by accident the moment its cwd has wandered out of the repo.
 *
 * One unit is one option token (`-p`, `--no-pager`, `--git-dir=/r/.git`) plus, when
 * present, the value the option eats as a *separate* token (`-C <path>`,
 * `-c <name>=<value>`, `--work-tree <path>`). Rather than enumerate git's option table
 * — which grows, and a missed entry is a hole — the shape is enumerated instead: an
 * option always begins with `-`, and a value never does.
 *
 * That last clause is also what makes the repetition safe. Because a value cannot
 * begin with `-`, no run of tokens can be split into units two different ways, so the
 * `*` has no ambiguity to backtrack through and the scan stays linear (see the ReDoS
 * note in the report). The `{0,20}` bound is belt-and-braces on top of that: no real
 * invocation carries twenty global options, and a bound means a future edit to this
 * line cannot cost more than a constant.
 */
const GIT_OPT = String.raw`-\S*(?:\s+[^\s-]\S*)?\s+`;

/**
 * The git subcommands a planning lead may not run, in two families.
 *
 * **Commit-producing** — `commit apply am cherry-pick revert merge rebase pull push`.
 * Spec §9 enumerates five (`commit|apply|merge|rebase|push`); the other four are the
 * same act under a different name. `revert`, `cherry-pick` and `am` each *write a
 * commit*, and `pull` is `merge` with a fetch in front of it. Banning `commit` while
 * allowing `git revert --no-edit HEAD` bans a word, not a behaviour.
 *
 * **Worktree-destroying** — `checkout switch restore reset clean rm mv stash`. These
 * create no commit, and the spec does not name them, so including them is a judgement
 * call. It is made on one fact: **the lead shares its worktree with its teammates.**
 * `git checkout -- .`, `git reset --hard` and `git clean -fdx` therefore delete the
 * uncommitted work of the only processes in the fleet that are allowed to write — a
 * strictly worse outcome than the `git commit` the rule already blocks, because a
 * commit is recoverable and a discarded working tree is not. A ban that stopped the
 * recoverable act and waved through the unrecoverable one would be incoherent.
 *
 * The line between "banned" and "left alone" is whether the verb has a read-only form
 * a *planning* lead plausibly uses. None of the sixteen do, with one exception carved
 * out inline: `git stash list` and `git stash show` are ordinary orientation. Verbs
 * that are mostly read — `branch` (`-a`, `--contains`, `--show-current`), `tag -l`,
 * `worktree list`, `config --get`, `fetch`, `log`, `diff`, `show`, `grep`,
 * `merge-base`, `commit-graph` — are deliberately *not* here; denying those teaches a
 * lead the gate is arbitrary, which is how a gate gets routed around. Their
 * destructive spellings (`git branch -D`, `git tag -d`, `git update-ref`) stay allowed
 * and are declared as residual: each is a ref edit that the reflog can undo, and none
 * is a command a lead reaches by accident.
 */
const GIT_VERB = 'am|apply|cherry-pick|checkout|clean|commit|merge|mv|pull|push'
  + '|rebase|reset|restore|revert|rm|stash(?!\\s+(?:list|show)\\b)|switch';

const WRITE_IDIOMS = [
  [new RegExp(CMD + String.raw`tee\b`), 'tee writes files'],
  // The gap between `sed` and its flag is bounded, and that bound is load-bearing.
  // Unbounded (`[^|;&]*`) the scan is quadratic: every `sed` in the string is a start
  // position, the class runs to the end of the command, and the engine then backtracks
  // over every space hunting for `-i`. A heredoc quoting a shell script that mentions
  // `sed` a few thousand times measured 2.4 s here, and 200 KB of `'sed '` took 12 s.
  // Real invocations put their flags in the first token or two, so 200 characters is
  // already far more slack than any of them need, and it turns the scan linear.
  [new RegExp(CMD + String.raw`sed\b[^|;&]{0,200}?\s(?:-i\b|--in-place)`), 'sed -i rewrites files in place'],
  [new RegExp(CMD + String.raw`git\s+(?:${GIT_OPT}){0,20}(?:${GIT_VERB})(?![-\w])`), 'this git subcommand writes the repo or discards a worktree'],
];

/**
 * The one part of the lead's shell-write surface that stays closed after the lead-only
 * write-idiom ban was lifted to match a teammate's: `git push` and `git merge`.
 *
 * The rest of arm (d)'s old `isLead` ban (`git commit` and the other commit-producing /
 * worktree-destroying verbs, `tee`, `sed -i`, and redirects outside `$SOMA_HOME`) is gone —
 * a lead's shell-write surface now equals a teammate's, who was never subject to arm (d) at
 * all. Only push and merge remain lead-denied here, and they are ALSO denied fleet-wide by
 * the worktree deny list (protected-branch push, `gh pr merge`), so this is defence in depth
 * on the one surface a lead keeps closed rather than the sole guard.
 *
 * Built from the same `CMD`/`GIT_OPT` machinery the full `WRITE_IDIOMS` git rule uses, so
 * `git -C /r push`, `git --no-pager -C /r push` and the `&&`-chained `… && git push …` forms
 * match exactly as before, and the trailing `(?![-\w])` keeps `git merge-base` (a read) out.
 */
const LEAD_PUSH_MERGE = new RegExp(CMD + String.raw`git\s+(?:${GIT_OPT}){0,20}(?:merge|push)(?![-\w])`);

/**
 * Is `cwd` the lead's own worktree root, `$SOMA_HOME/worktrees/<repo>/<id>`?
 *
 * Shape, not a lookup: the gate does not know the repo key, but `paths.worktreeDir` makes it one
 * path segment (`worktree.mjs` refuses anything else), so the root is any directory whose name is
 * the lead's id and whose grandparent is the state root's `worktrees/`. Both sides go through
 * `realpath`, because `$SOMA_HOME` may sit under a symlink (stock macOS `$TMPDIR` does) and the
 * hook's `cwd` may be spelled either way. Anything that cannot be resolved is not the root.
 */
function atWorktreeRoot(cwd, home, id, realpath) {
  if (typeof cwd !== 'string' || cwd === '' || !isAbsolute(cwd)) return false;
  let real;
  let worktrees;
  try {
    real = realpath(cwd);
    worktrees = join(realpath(home), 'worktrees');
  } catch {
    return false;
  }
  return typeof real === 'string' && basename(real) === id && dirname(dirname(real)) === worktrees
    && basename(dirname(real)) !== '' && dirname(real) !== worktrees;
}

/**
 * Is `cmd` the one push a lead may make: its own branch, `soma/<id>`, to `origin`, as a command
 * of its own?
 *
 * The shape is enumerated rather than parsed, because everything outside it stays refused and a
 * parser would have to be right about the shell to be safe. Accepted, after trimming ASCII
 * spaces, tabs and newlines from both ends (and nothing else: `String.prototype.trim` also strips
 * U+00A0, U+2028, U+3000 and the rest, which the shell keeps inside a word, so
 * `soma/<id><U+00A0>` would pass the check and name another branch):
 *
 *     git push [-u | --set-upstream]... origin <refspec>
 *
 * with exactly one refspec, which is `soma/<id>` or `refs/heads/soma/<id>`, optionally preceded
 * by a source that is `HEAD` or one of those two and a colon. Words are separated by spaces or
 * tabs and made only of letters, digits and `._/:-`, which rules out in one stroke every quote,
 * escape, expansion, glob, redirect, separator, newline, comment and the `+` of a forced refspec,
 * so a chained, piped, wrapped, substituted or forced push never reaches the word checks. `git`
 * must be the first word: `git -C`, `-c`, `--git-dir`, `env git`, `command git`, `/usr/bin/git`
 * and `bash -c` all stay refused. So do `--force-with-lease`, `-d`, `--delete`, `:ref`, `--all`,
 * `--mirror`, `--tags`, a tag refspec, any other option, any other remote spelling, and any other
 * branch, including `soma/<id>-r2` (a retry branch: hand that push to a teammate).
 *
 * `id` is `SOMA_LEAD_NAME`, the same value the breaker trusts, and this is only ever asked about
 * the lead's own session (`isLead`), whose environment is the one the spawner built under
 * `env -i`. Measured on Claude Code 2.1.299: a hook command runs under `/bin/sh -c` straight from
 * the `claude` process, so no shell startup file a teammate could write is read on the way, and
 * nothing the lead runs in its own Bash tool reaches this process's environment.
 *
 * What this judges is the COMMAND STRING. It cannot see git config set by an earlier command,
 * and that config widens what this exact command does: `push.followTags=true` also pushes the
 * annotated tags it reaches, and `remote.origin.pushurl` or `url.<x>.pushInsteadOf` send it to
 * another repository (measured with real git). Nor can it see a `.git` pointer rewritten to
 * another repository's git dir. Those are the subprocess residual in another form, declared
 * rather than chased: the class is closed by OS sandboxing, not by more string rules.
 */
function ownBranchPush(cmd, id) {
  if (typeof cmd !== 'string' || typeof id !== 'string' || !LEAD_RE.test(id)) return false;
  const line = cmd.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
  if (!/^[A-Za-z0-9._/:\t -]+$/.test(line)) return false;
  const words = line.split(/[ \t]+/);
  if (words[0] !== 'git' || words[1] !== 'push') return false;
  let at = 2;
  while (words[at] === '-u' || words[at] === '--set-upstream') at++;
  if (words.length !== at + 2 || words[at] !== 'origin') return false;
  const branch = `soma/${id}`;
  const target = (ref) => ref === branch || ref === `refs/heads/${branch}`;
  const refspec = words[at + 1];
  const colon = refspec.indexOf(':');
  if (colon === -1) return target(refspec);
  const [src, dst] = [refspec.slice(0, colon), refspec.slice(colon + 1)];
  return (src === 'HEAD' || target(src)) && target(dst);
}

/**
 * Every redirection that creates or truncates a file, with its target.
 *
 * Covers `>`, `>>`, `>|`, `1>`, `2>>`, `&>`. Deliberately not matched: `2>&1` and
 * `>&2`, where the target begins with `&` — those duplicate a descriptor and write no
 * file, and they appear in nearly every command a lead runs (`npm test 2>&1 | tail`).
 * The `d` flag is what lets the scan run over a masked copy of the command while the
 * target is read out of the real one.
 *
 * No leading separator is required, because bash does not require one either: it
 * tokenizes `cat a>b` as `cat a > b`, and an unquoted `>` is *always* the start of a
 * redirection. Quoting and escaping are the only things that make one ordinary, and
 * the mask has already accounted for both by the time this runs.
 */
const REDIRECT_RE = /(?:\d*|&)>{1,2}\|?\s*("[^"]*"|'[^']*'|[^\s;&|<>()]+)/dg;

/**
 * `cmd` with the *contents* of every quoted run replaced by `x`, character for
 * character, and every backslash escape blanked the same way.
 *
 * `>` is not only a redirection operator: it is a comparison in awk and in `[ ]`, and
 * it is ordinary prose inside an echo or a grep pattern. `awk '$1 > 5 {print}'` and
 * `grep -n "a > b" f` write nothing at all, and denying them would teach a lead that
 * the gate is arbitrary. Masking is the cheapest thing that tells those apart from a
 * real redirect without lexing the shell: quote characters and length are preserved,
 * so a genuinely quoted *target* (`> "sp ace.txt"`) is still recognised as one token
 * and can be read back out of the original string by index.
 */
function maskQuoted(cmd) {
  let out = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      // Inside single quotes nothing escapes, not even a backslash.
      if (quote === '"' && c === '\\' && i + 1 < cmd.length) { out += 'xx'; i++; continue; }
      if (c === quote) { quote = null; out += c; continue; }
      out += 'x';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (c === '\\' && i + 1 < cmd.length) { out += 'xx'; i++; continue; } // `\>` is a literal `>`
    out += c;
  }
  return out;
}

/**
 * `<<WORD` at `j`, or null if what follows is not a heredoc delimiter.
 *
 * The delimiter may be quoted or backslash-escaped (`<<'EOF'`, `<<"EOF"`, `<<\EOF`) — that
 * only turns off expansion inside the body, it does not change where the body ends — and
 * `<<-` means the terminator may be indented with tabs. Returns the word with its quoting
 * removed, that `-`, and the index just past the delimiter.
 */
function heredocOpener(cmd, j) {
  let dash = false;
  if (cmd[j] === '-') { dash = true; j++; }
  while (cmd[j] === ' ' || cmd[j] === '\t') j++;
  let word = '';
  let quote = null;
  while (j < cmd.length) {
    const c = cmd[j];
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
      j++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; j++; continue; }
    if (c === '\\' && j + 1 < cmd.length) { word += cmd[j + 1]; j += 2; continue; }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r'
      || c === ';' || c === '&' || c === '|' || c === '<' || c === '>' || c === '(' || c === ')') break;
    word += c;
    j++;
  }
  return word === '' ? null : { word, dash, end: j };
}

/**
 * One heredoc body from `from` onward, blanked, plus where the shell resumes reading.
 *
 * Newlines are kept verbatim and every other character becomes `x`. Keeping them is the
 * point: the newline must stay a segment separator (deleting it from `segments()` is
 * a mutation, and it reddens), so the body is neutralized by having no content rather
 * than by being spliced out. An unterminated body runs to the end of the command, which is
 * what the shell would do with it too.
 */
function heredocBody(cmd, from, word, dash) {
  let i = from;
  let masked = '';
  while (i < cmd.length) {
    let end = i;
    while (end < cmd.length && cmd[end] !== '\n' && cmd[end] !== '\r') end++;
    const line = cmd.slice(i, end);
    const nl = cmd[end] === '\r' && cmd[end + 1] === '\n' ? '\r\n' : (end < cmd.length ? cmd[end] : '');
    masked += 'x'.repeat(line.length) + nl;
    i = end + nl.length;
    if ((dash ? line.replace(/^\t+/, '') : line) === word) break;
  }
  return { masked, next: i };
}

/**
 * `cmd` with the body of every heredoc blanked to `x`, character for character.
 *
 * **This is a false-denial fix and it has to not be a coverage regression.** Making `\n` a
 * segment separator was necessary — without it `echo probe`⏎`cp /dev/null <guard>` emptied a
 * real guard file — but it also meant the *body* of a heredoc was tokenized as though each
 * line were a command, so `cat <<'EOF'`⏎`rm .claude/settings.local.json`⏎`EOF`, which writes
 * nothing at all, was DENIED. A heredoc body is data; the shell never runs it. An over-broad
 * gate that refuses ordinary work costs a teammate the same as a missed idiom costs the
 * operator, so this is closed rather than declared.
 *
 * Blanked rather than removed, and exactly as long as what it replaces — but be precise about
 * why, because the obvious reason is not the true one. Both scans that consume this run over
 * the *masked* copy, so they stay mutually consistent whatever its length; dropping the
 * delimiter instead of blanking it is an equivalent mutant, measured. Length is preserved so
 * that `scan` and `command` remain index-comparable, because `evaluateGate` still matches the
 * lead's `WRITE_IDIOMS` against the raw `command` and the next reader will assume the two
 * correspond. A splice would make that assumption silently false.
 *
 * The masking applies to the `.claude/` rule only, and to *both* of its scans — the
 * tokenizer and the redirect scan, since a body line reading `echo x > .claude/…` is the
 * same false denial by the other route. The lead's own `WRITE_IDIOMS` keep matching the raw
 * command: they deliberately see inside quotes, because a quoted `git commit` is usually
 * `sh -c '…'`, and masking there would only ever loosen a ban that is not this finding.
 */
function maskHeredocs(cmd) {
  // No heredoc exists without `<<`, so the common command pays one `indexOf` and nothing else.
  if (cmd.indexOf('<<') === -1) return cmd;
  let out = '';
  let quote = null;
  let pending = [];
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (quote === '"' && c === '\\' && i + 1 < cmd.length) { out += c + cmd[++i]; continue; }
      if (c === quote) quote = null;
      out += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (c === '\\' && i + 1 < cmd.length) { out += c + cmd[++i]; continue; }
    // `<<<WORD` is a here-*string*: one word on this line, no body, nothing to blank. Belt
    // and braces rather than the only defence — `heredocOpener` breaks its delimiter scan on
    // `<` too, so it returns null for `<<<` even without this test (measured: the mutation
    // that deletes this clause is an equivalent mutant). Kept because the reader should not
    // have to derive that, and because the two guards fail independently.
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      const open = heredocOpener(cmd, i + 2);
      if (open) {
        pending.push(open);
        // The operator and its delimiter are copied through rather than blanked. That is a
        // legibility choice and not a safety one: blanking them is an equivalent mutant,
        // because `<<EOF` is only ever an operand and resolves to nothing either way.
        out += cmd.slice(i, open.end);
        i = open.end - 1;
        continue;
      }
    }
    if (c === '\n' || c === '\r') {
      // A CRLF is consumed as one line ending so the body starts on the next real line. Also
      // an equivalent mutant if dropped — the scan would count the stray `\n` as an empty
      // body line and then find the same terminator — so this is correctness for its own
      // sake, and the terminator match is what actually bounds the body.
      const crlf = c === '\r' && cmd[i + 1] === '\n';
      out += crlf ? '\r\n' : c;
      i += crlf ? 1 : 0;
      // Bodies begin on the next line and arrive in the order their operators did, so
      // `cat <<A <<B` reads A's body first.
      let j = i + 1;
      for (const { word, dash } of pending) {
        const body = heredocBody(cmd, j, word, dash);
        out += body.masked;
        j = body.next;
      }
      if (pending.length) { pending = []; i = j - 1; }
      continue;
    }
    out += c;
  }
  return out;
}

/** Sinks that consume bytes instead of storing them. Writing to these is not writing. */
const SINK_RE = /^(?:\/dev\/(?:null|zero|stdout|stderr|tty|fd\/\d+)|(?:NUL|nul))$/;

const deny = (reason) => ({ permissionDecision: 'deny', permissionDecisionReason: reason });

/**
 * `$SOMA_HOME`, resolved exactly the way `paths.mjs` resolves it — `||` so an empty
 * string falls back, `resolve` so the answer is absolute — but from a caller-supplied
 * env rather than `process.env`. A gate whose idea of the state root differed from
 * every other module's would allow writes nobody else considers inside it.
 */
function stateRoot(env) {
  return resolve(env?.SOMA_HOME || join(env?.HOME || homedir(), '.soma'));
}

/**
 * `target` with the prefixes a hook sees unexpanded turned back into paths.
 *
 * The shell expands `$SOMA_HOME` before it runs the command; a regex reading the
 * command string does not, so `echo x > $SOMA_HOME/scratch.md` would otherwise look
 * like a write to a relative path called `$SOMA_HOME/scratch.md` and be denied — the
 * one place a lead is *allowed* to write, refused.
 */
function expand(target, env, home) {
  let out = target;
  if (out.startsWith('"') || out.startsWith("'")) out = out.slice(1, -1);
  const userHome = env?.HOME || homedir();
  // Function replacements, never string ones: `$&`, `$'` and `$$` are substitution
  // patterns in a replacement string, and a home directory is allowed to contain a
  // dollar sign — which would otherwise rewrite the path into something else entirely.
  out = out.replace(/^\$\{?SOMA_HOME\}?/, () => home);
  out = out.replace(/^\$\{?HOME\}?/, () => userHome).replace(/^~(?=\/|$)/, () => userHome);
  return out;
}

/**
 * Is `target` inside the state root?
 *
 * `normalize` before the prefix test, so `$SOMA_HOME/../../etc/passwd` is judged by
 * where it lands rather than by how it starts; and the separator in the prefix, so
 * `/state/soma-not-mine` is not read as being under `/state/soma`.
 */
function insideRoot(target, home) {
  if (!isAbsolute(target)) return false;
  const n = normalize(target);
  return n === home || n.startsWith(home.endsWith(sep) ? home : home + sep);
}

/**
 * Every redirect target in `cmd`, as written (still quoted, still unexpanded), each with
 * the index of the operator that produced it.
 *
 * The index is what lets the `.claude/` rule below attribute a redirect to the command
 * segment it belongs to — and therefore to whatever `cd` was in effect by then — without
 * this scan having to run per segment. Running it per segment would be wrong: `>|` and
 * `&>` contain `|` and `&`, which are themselves segment separators, so a per-segment
 * scan would split the operator away from its target and stop matching them.
 */
function* redirectTargets(cmd) {
  const masked = maskQuoted(cmd);
  for (const match of masked.matchAll(REDIRECT_RE)) {
    // Found in the masked copy, read out of the real command: the two are the same
    // length by construction, so the capture group's indices address both.
    const [start, end] = match.indices[1];
    const raw = cmd.slice(start, end);
    // An unquoted `(( x > 3 ))` is arithmetic, not a redirect to a file named "3".
    // Nothing a lead writes lands in a bare number, so the whole class is skipped.
    if (/^\d+$/.test(raw)) continue;
    yield { raw, at: match.index };
  }
}

/** The first redirect in `cmd` that lands outside the state root, or null. */
function outsideWrite(cmd, env, home) {
  for (const { raw } of redirectTargets(cmd)) {
    const target = expand(raw, env, home);
    if (SINK_RE.test(target)) continue;
    if (!insideRoot(target, home)) return target;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The `.claude/` write ban — the one rule here that binds TEAMMATES, not the lead.
//
// `<worktree>/.claude/settings.local.json` is the file that denies a teammate the
// operator's brokerage MCP server, their database connections and their authenticated
// Slack / Microsoft 365 / Google Drive connectors. `settings-gen.mjs` has that file protect
// itself with `Edit(./.claude/**)` plus `Bash(rm*.claude*)` and `Bash(mv*.claude*)`,
// and those hold — but the coverage is partial, and the gap is not theoretical. Probed
// against a real Claude Code 2.1.220 with exactly those rules in place, `tee`, `tee -a`,
// `cp`, `dd of=` and `install` each **overwrote the guard file**, verified by md5. (`>`,
// `>>` and `sed -i` did not: the harness resolves those targets itself, symlinks
// included, and applies `Edit(...)` to them. The full A/B is in the report.)
//
// So this is the residue the harness cannot see, and it must bind every session: a
// teammate that can blank this file can lift every guard on itself, which makes the
// whole secrets boundary cosmetic. It is deliberately NOT session-discriminated — that
// discriminator exists so teammates keep their hands, and this is the one thing no hand
// in the fleet may touch.
//
// ⚠ **What this rule does NOT do, measured rather than assumed.** A hook is only "the one
// layer that cannot be deleted by the thing it protects" if its *registration* lives
// somewhere the thing it protects cannot reach. Today it does not: `writeWorktreeGuardrails`
// registers this hook's `PreToolUse` entry inside the same `.claude/settings.local.json`
// the rule defends, and Claude Code re-reads that file mid-session. A clean A/B on 2.1.220
// — populated guard file → hook registered → `tee <guard>` DENIED; the same file emptied →
// hook absent → the identical command RAN — shows the predicate below is only as durable as
// the registration above it. So every idiom this file closes narrows the window, and none of
// them closes it: the first uncovered write disarms the gate for the rest of the session.
// Making the claim true is a placement change in `settings-gen`/spawn (a user-scope,
// managed-policy or out-of-worktree registration), NOT a change to any predicate here, and
// it is left to that change rather than pretended away in this comment.
// ---------------------------------------------------------------------------

/** The directory that configures the harness itself. Matched as a whole path segment. */
const CLAUDE_DIR = '.claude';

// ---------------------------------------------------------------------------
// The `$SOMA_HOME/leads/**` write ban — the SECOND rule here that binds teammates.
//
// `leads/<id>/` is the per-lead control directory: `meta.json`, `mcp.json`, `settings.json`,
// `brief.md`, `HOLD`, `BUDGET_TRIPPED`, and `settings.launch.json` — the composed file that
// `--settings` points at, and the only teammate enforcement that survives the worktree guard
// file being emptied. `spawn.mjs` says of it that it "lives under the state root, so no state
// of any worktree can reach it". **That is true of the worktree and false of the worktree's
// shell**, and it was measured: 12 vectors at the real hook process, **all 12 ALLOW as a
// teammate**, 10 of 12 ALLOW as a lead — the two that denied (`tee`, `sed -i`) denying on the
// *verb*, anywhere on the filesystem, not on the path. Worst of them,
// `echo '{}' > $SOMA_HOME/leads/<id>/settings.launch.json` was ALLOW **precisely because**
// `outsideWrite` denies redirects *outside* `$SOMA_HOME` and its deny message invited
// redirects *under* it: the gate's own advertisement was the hole. That sentence is fixed
// where it is written.
//
// **This directory is POLICY, not state the fleet writes, and the ruling is the operator's.**
// The reasoning, so an edge case can be judged against it rather than against this list:
//
//   * **`BUDGET_TRIPPED` is the decisive one.** The watchdog writes it and arm (a) above reads
//     it to deny a tripped lead's every tool call. Post-trip that `rm` is already denied — the
//     breaker fires before this rule (measured, lead and teammate both). **The reachable form
//     is PRE-trip, and it is worse than deletion:** `chmod 000 $SOMA_HOME/leads/<id>` makes
//     `existsSync` on the flag inside it return **false** while the flag is still on disk, so a
//     lead can disarm its own future breaker and leave no trace of having done so (measured);
//     and `rm -rf $SOMA_HOME/leads` makes the watchdog's trip-write fail ENOENT outright, so
//     the trip never lands at all (measured). Either way the spend cap becomes advisory.
//     `HOLD` is the same shape with a smaller blast radius.
//   * Everything else there is the lead's instructions (`brief.md`), its identity
//     (`meta.json`), or its enforcement (`settings.json`, `settings.launch.json`, `mcp.json`).
//     None of it is a lead's to edit, and none of it is a teammate's.
//
// **Denied by path prefix, never by filename.** A list of four names is an enumeration the next
// rename silently defeats — the same failure mode as the verb list, which this build has been
// bitten by four times. There is deliberately **no by-name arm** for this rule, unlike the
// `.claude/` one: `settings.json` and `meta.json` are ordinary names in an ordinary repo, so a
// by-name arm would deny a teammate's real work. The cost is a declared residual — a *relative*
// target under an unfollowable `cd` into the leads directory is judged by name or not at all.
//
// **The container gets one exact-match rule of its own, and it was found by executing this
// rule's boundary rather than by reading it.** `chmod 000 $SOMA_HOME` makes `existsSync` on
// `BUDGET_TRIPPED` return **false while the flag is still on disk** — measured — and `rm -rf
// $SOMA_HOME` and `mv $SOMA_HOME …` were both ALLOW. So the parent defeated the breaker by exactly
// the mechanism above, one path segment short of the prefix. It is closed **exact-match only**:
// the state root may not *be* a write target, while writing anything *under* it is untouched,
// because `worktrees/` is where every teammate works and a prefix here would stop the fleet dead.
//
// Closing it reversed a ratified acceptance assertion that pinned `> $SOMA_HOME` as ALLOW, and the
// reason it was safe to reverse is in the test that now asserts the opposite: a redirect onto the
// state root path either **fails** ("Is a directory") when the root exists, or **replaces the state
// root with a regular file** when it does not, pointing every later `ensureTree()` and path helper
// at a file. The assertion was protecting a capability that does not exist while permitting the
// destructive case.
//
// **Denying the whole subtree costs the fleet nothing, and that is why the trade is cheap.**
// Its three legitimate writers are separate processes this gate never hooks: the spawner, the
// watchdog and the lead's Stop/PostToolUse hooks all write with Node's `fs`, not through a Bash
// tool call. So does the one write this gate makes itself, the rename of `BUDGET_WARNED` (job 5
// in the header), which is never a Bash command at all. The heartbeat lands in
// `$SOMA_HOME/heartbeats/`, a sibling of `leads/`, not inside it. And `soma doctor`, which
// really does write `leads/doctor-probe/`, reaches this hook as the
// command string `soma doctor` — no writer verb, no path — so a verb-and-path-keyed rule cannot
// see it. Every one of those is pinned as an ALLOW in the tests.
//
// ⚠ **This rule adds NO new source of write targets, and that is load-bearing rather than
// incidental.** It rides entirely on the three generators `claudeWrite` already drives, so it
// cannot be the fourth instance of the ordered-target-cap defect — there is no new `yield` in
// any generator and no new budget to get wrong. What it *does* add is a second verdict for the
// cap to stay neutral about, so the cliff is pinned for this verdict too (10/200/255/256/1000):
// past the cap a leads path spelled absolutely is still judged, because the answer is textual
// and free. Only a leads path reachable *solely through a symlink* from beyond position 256
// degrades to ALLOW, which is the same declared residual `.claude/` already carries.
// ---------------------------------------------------------------------------

/**
 * The one segment under the state root that the fleet may not write. A whole segment, so
 * `$SOMA_HOME/leadsnotes.md` and a sibling `leads-old/` are untouched.
 */
const LEADS_DIR = 'leads';

/** The two names that *are* the guard, so the deny can say why rather than just no. */
const GUARD_FILE_RE = /^settings(?:\.local)?\.json$/;

/**
 * Writer commands, split by which of their arguments is the thing written.
 *
 * `tee` writes *every* file it is given, and so — for this rule's purposes — do the
 * **deletion** verbs. `rm` used to be in neither set, which meant the gate allowed every
 * `rm`: the guard file's only deletion defence was the start-anchored `Bash(rm*.claude*)`
 * glob living inside the very file being deleted, and both `( rm ./.claude/settings.local.json )`
 * and `cd .claude && rm settings.local.json` deleted a real guard file outright. Deleting
 * the file that denies a teammate the operator's credentials is not a lesser act than
 * overwriting it — an absent settings file fails open exactly as an empty one does.
 *
 * **`mv` is in the every-arg set and `cp` is not, and that asymmetry is the point.**
 * `cp .claude/settings.local.json /tmp/x` copies the guard file *out*, which is a read and
 * stays allowed — that is why the last-operand rule exists. But `mv` leaves nothing
 * behind, so `mv .claude/settings.local.json /tmp/x` **is a delete**, and taking only its
 * last operand made it look like a read. Only `cp`, `install` and `ln`, which all leave
 * their source where it was, take the last operand alone.
 *
 * `sed` only writes with `-i`, and `dd` names its target in an `of=` operand rather than
 * positionally. `truncate` is here because `truncate -s0` is the shortest way to blank a
 * file without a redirect. `rmdir` is here because `rm` without `-r` cannot remove a
 * directory and `rmdir .claude` is the spelling that can.
 *
 * Over-collecting is safe by construction and under-collecting is not: a token that is
 * not a path simply fails to resolve into `.claude/`, so the resolution below is the
 * real filter and this list only has to be generous.
 *
 * **The second half of that sentence was tested and the list was not generous enough.**
 * Every verb on the lines below was measured ALLOW and then *executed* against a real
 * 2555-byte guard file generated by the merged `writeWorktreeGuardrails` (59 deny rules).
 * None of them is covered by any rule in that file — the only deletion rule it carries is
 * the start-anchored `Bash(rm*.claude*)`:
 *
 *   `rsync -a src <guard>` → **wrote** (2555 → 1 byte). The one that matters most: an
 *     ordinary tool a model reaches for unprompted, and its destination is the last operand,
 *     exactly like `cp`.
 *   `gzip -f <guard>` → **deleted**, replaced by `<guard>.gz`. `bzip2`, `xz` and
 *     `zstd --rm` behave identically — all three measured, all three deleted it. Their
 *     decompressors are here for the return leg: `gunzip <guard>.gz` *creates* a file inside
 *     `.claude/`.
 *   `ex -sc '%d|wq' <guard>` → **wrote** (2555 → 0). `ex` is `vi`'s line mode; `ed -s` and
 *     `vi -es` were measured emptying it the same way, and `vim` is the binary `vi` already
 *     is here. The rest of that binary's names are in `VIM_FAMILY` below, and the reason they
 *     are there is the correction of an error this comment used to contain — read it.
 *   `patch <guard> <diff>` and `patch -i <diff> <guard>` → **wrote** (2555 → 2). The
 *     re-review measured `patch` as harmless, but with an *empty* diff, which is a no-op
 *     whatever the file is; with a real diff it rewrites in either operand order, which is
 *     why `patch` is in the every-arg set rather than the last-arg one.
 *   `zip -m /tmp/a.zip <guard>` → **deleted** (`-m` moves into the archive).
 *   `chmod 000 <guard>` → left the file unreadable, and `chmod 000 .claude` left the whole
 *     directory unreachable. Listed on narrower grounds than the rest, stated plainly: a mode
 *     is part of what the harness config *does*, and this rule is "`.claude/` is not yours to
 *     write". Whether an unreadable guard file makes Claude Code fail open the way an emptied
 *     one does is **not** measured and is not the claim. `chown`/`chgrp` are NOT listed — they
 *     need root, which a teammate does not have, and measured they did nothing.
 *
 * **Three names came off the "measured intact" list because the measurement was a no-op**, and
 * that is worth more than the three names: `tar -C` and `cpio` were handed an archive with no
 * matching member, `sponge` is not installed here at all (`command -v` finds nothing; the run
 * exited 127). A tool handed nothing to do leaves every file intact, so those runs were
 * evidence about the archive and the `$PATH`, not about the verb. `tar` and `cpio` are now
 * covered by `OPTION_TARGET`/`EXTRACTS_INTO_CWD`/`WRITES_LAST_ARG` below; `sponge` is
 * **declared, not measured** — `cat src | sponge <guard>` is the canonical redirect-free way
 * to blank a file and it is ALLOW here, the same honest treatment `gawk -i inplace` gets.
 *
 * Still absent and this time genuinely measured with something to do: `touch` and `split`
 * (both left the guard file intact; both *create* new files inside `.claude/` and are ALLOW),
 * `tar --delete -f a.tar <guard>` (edits the archive, not the tree), `tar cf .claude/x.tar src`
 * (creates a new archive in `.claude/`, guard file intact), and `bunzip2` on a non-`.claude`
 * input. `chown`/`chgrp` need root, which a teammate does not have.
 */
const WRITES_EVERY_ARG = new Set([
  'tee', 'truncate', 'mv', 'rm', 'rmdir', 'unlink', 'shred',
  'gzip', 'gunzip', 'bzip2', 'bunzip2', 'xz', 'unxz', 'zstd', 'unzstd', 'zip',
  'ed', 'patch', 'chmod',
]);

/**
 * **The class: a tool whose read-only mode is advisory rather than enforced.**
 *
 * This set is one binary under eleven names, and it is here because the comment above used to
 * say *"`view` is deliberately NOT listed: measured, it is read-only and left the file
 * intact"* — and that measurement was a no-op. `view` **is** `vim`: `/usr/bin/view`,
 * `/usr/bin/rview`, `/usr/bin/rvim`, `/usr/bin/vimdiff`, `/usr/bin/ex` and `/usr/bin/vi` are
 * all symlinks to `/usr/bin/vim` here, verified with `realpath`. `-R` only *sets* `'readonly'`,
 * and `:w!` clears it, so read-only is advice to a human and not a permission. Handed a write
 * command, every spelling emptied a real 4798-byte guard file to 0:
 *
 *   `view -es -c '%d' -c 'wq!' <guard>`, the same through a pipe (`printf … | view -e`),
 *   `rview`, `rvim`, `vimdiff`, `/usr/bin/view`, `view` on line 2, through `xargs`, after a
 *   `cd` — nine spellings, all ALLOW, all **WROTE 4798 → 0**.
 *
 * **The control is the whole finding, and it was executed in both directions:** `vim -R` with
 * byte-identical arguments *also* wrote the file to 0 — so the DENY it already got was not a
 * no-op either. The identical binary with identical arguments was denied spelled `vim` and
 * allowed spelled `view`, because the gate keys on the token and not on the resolved program.
 *
 * The extent is taken from **vim's own man page**, which enumerates the personalities as
 * `ex view gvim gview evim eview rvim rview rgvim rgview` — not from guessing at prefixes —
 * plus `vi`, the diff personalities, and the `nvim`/`nview` pair by family. That man page is
 * also where the false claim came from: of `view` it says *"You will be protected from writing
 * the files."* It is describing a default, not a guarantee.
 *
 * **Resolving the program instead of the token is the fix this cannot have.** It would mean a
 * `$PATH` search plus a `realpath` per verb per tool call, in a hook that runs on every tool
 * call and whose whole budget is an `existsSync` or two, plus one `renameSync` per 80%
 * warning delivered; and the answer would be machine-specific, so the gate would be stricter
 * on this laptop than in CI. The token list is the cheap approximation, and the residual is
 * stated where it belongs — under `WRITES_WITH_IN_PLACE`.
 */
const VIM_FAMILY = [
  'vi', 'vim', 'ex', 'view', 'gvim', 'gview', 'evim', 'eview',
  'rvim', 'rview', 'rgvim', 'rgview', 'vimdiff', 'gvimdiff', 'nvim', 'nview', 'mvim',
];
for (const name of VIM_FAMILY) WRITES_EVERY_ARG.add(name);

/**
 * `cpio -p <dir>`, `pax -rw … <dir>` and `ditto <src> <dst>` all name their destination as the
 * **last operand**, exactly like `cp`. Each was measured writing a real guard file to 2 bytes
 * when that destination was `.claude`. They join `cp`/`install`/`ln`/`rsync` rather than the
 * every-arg set for the same reason those four are there: their earlier operands are sources,
 * and copying the guard file *out* is a read that stays allowed.
 */
const WRITES_LAST_ARG = new Set(['cp', 'install', 'ln', 'rsync', 'cpio', 'pax', 'ditto']);

/**
 * Verbs that rewrite their operands **only** with an in-place flag.
 *
 * `sed` was the whole set until `perl -i -pe` and `ruby -i -pe` blanking a line were each
 * measured rewriting a real guard file. They are not the declared `perl -e` subprocess
 * residual: `-i` names the act and the operand names the file, both in plain sight in the
 * command string, which is the same shape as `sed -i` and the same shape the residual
 * declaration calls its ceiling. `awk` is absent on purpose — BSD `awk` has no in-place
 * mode at all, and gawk spells it `-i inplace` while using bare `-i` for `--include`, so
 * neither could be measured here; it is declared instead of guessed at.
 *
 * ⚠ **Where the advisory-read-only class stops, and it is a boundary rather than a gap.** Two
 * shapes that also write without an in-place flag were measured destroying the guard file and
 * are deliberately NOT closed, because in both the destination is a path inside a *program the
 * tool interprets* rather than one of its operands:
 *
 *   `sed -n 'w ./<guard>' src.txt`  → **WROTE 4798 → 2**. `sed`'s `w` command names a file.
 *   `awk '{print "z" >> "./<guard>"}' src.txt` → **WROTE 4798 → 4800**.
 *
 * Both paths sit inside single quotes, so `maskQuoted` has blanked them by the time the
 * redirect scan runs — and un-blanking is not available: seeing `>` inside quotes is exactly
 * what denies `awk '$1 > 5 {print}'` and `grep -n "a > b" f`, which is the false-denial class
 * `maskQuoted` exists to prevent. That makes these the **declared subprocess residual under
 * two more names**, alongside `perl -e`, `python3 -c` and `bash -c`: the write is a program,
 * not an operand, and no token gate reaches it. The pagers behave the same way — `less` and
 * `more` write only by shelling out with `!cmd`, so their target is a command string too, and
 * neither could be made to write here even under a pty (both exit 0, file intact); `pico`
 * needs a terminal it does not get (exit 1). Declared, not claimed harmless.
 */
const WRITES_WITH_IN_PLACE = new Set(['sed', 'perl', 'ruby']);

/**
 * Tokens that sit in the command position without *being* the command.
 *
 * Every one of these was measured ALLOW before it was listed — `{ tee <guard>; }`,
 * `for f in a; do tee <guard>; done`, `if true; then tee <guard>; fi`, `time tee <guard>`,
 * `nohup tee <guard>` — because the scan below read the first token of the segment, found
 * `{` / `do` / `then` / `time`, and looked no further.
 *
 * Note the asymmetry that makes this cheap to be sure about: the regex-based
 * `WRITE_IDIOMS` above already catch every one of these forms, because `CMD` treats any
 * separator as a command position. It is only this tokenizer that has to be told, which
 * is why the gap was in the `.claude/` rule alone — the one rule that binds teammates.
 */
const VERB_PREFIX = new Set([
  'sudo', 'doas', 'command', 'env', 'time', 'nohup', 'nice', 'stdbuf', 'ionice', 'setsid',
  'timeout', 'xargs', '{', '}', '!', 'if', 'then', 'else', 'elif', 'while', 'until', 'do',
]);

/**
 * `cmd` split into command segments, with one layer of quoting removed.
 *
 * Not a shell parser and not trying to be — it is a tokenizer that knows the four things
 * that matter here: quotes group, backslashes escape, a backslash at end of line is a
 * *continuation*, and `;` `&` `|` `(` `)` **and a newline** each start a new command.
 * Single pass, no regex, so it is linear on any input.
 *
 * **The newline is load-bearing, and its absence was the first Critical of the re-review.**
 * It used to be a *token* separator rather than a segment separator, so in
 * `echo probe<newline>cp /dev/null <guard>` the verb position was taken by `echo`, `cp` was
 * read as just another of its operands, and the command yielded no write target at all.
 * That command emptied a real 3207-byte guard file to zero in a live teammate session, and
 * at this level the same shape also let through `tee`, `install -m644`, `truncate -s0`,
 * `mv`, `ln` and `sed -i` — none of which the platform's own rules cover, so there was no
 * second layer underneath. The shell starts a new command at a newline; so does Claude
 * Code's own rule matcher; so does this now.
 *
 * Each segment carries the index it starts at, which is what lets a redirect found by the
 * whole-command scan above be attributed to the segment — and the `cd` — it belongs to.
 *
 * **It also carries a `pipe` number, and that is a scope rather than a nicety.** Every
 * separator here ends a *segment*, but only some of them end a **pipeline**: `a | b` is one
 * command list item whose two halves exchange data, while `a ; b`, `a && b`, `a || b`, a
 * newline and a subshell boundary begin an unrelated one. `proxiedTargets` needs that
 * distinction because "the operands came from somewhere I cannot see" is only true of the
 * pipeline the proxied writer is *in* — see its own comment for the false denials that
 * conflating the two produced.
 *
 * A lone `&` is deliberately pipeline-*preserving* even though it is a list separator, and the
 * reason is a real vector rather than tidiness: `>&` and `<&` put a bare `&` in the middle of a
 * redirect, so `echo <guard> 2>&1 | xargs rm` would otherwise have its guard token land in one
 * pipeline and its `xargs rm` in the next, and a command that really does delete the file would
 * be allowed. Treating a single `&` as soft over-collects a genuine background `a & b` into one
 * pipeline, which errs towards a deny. `&&` and `||` are the doubled spellings and are hard.
 */
function segments(cmd) {
  const segs = [];
  let tokens = [];
  let start = 0;
  let pipe = 0;
  let cur = '';
  let started = false; // distinguishes a real empty token (`sed -i ''`) from no token
  let quote = null;
  const endToken = () => { if (started) { tokens.push(cur); cur = ''; started = false; } };
  const endSeg = (next, soft = false) => {
    endToken();
    // A segment with no tokens has nowhere for a target to hide: `;;` and `&&` are
    // punctuation, not commands. Dropping them here rather than filtering afterwards is
    // also what keeps a command of 200 000 semicolons from allocating 200 000 arrays.
    if (tokens.length) segs.push({ tokens, start, pipe });
    tokens = [];
    start = next;
    if (!soft) pipe++;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    // A backslash-newline is a line continuation: bash deletes both characters and the
    // command runs on. This has to come *before* the two escape branches below, which
    // would otherwise fold the newline into the token — turning the `\`+newline+`tee` of
    // `cd . && \<newline>tee <guard>` into a verb named "\ntee" that no set contains, and
    // that measured ALLOW. Handled inside double quotes too, because `tee ".clau\<nl>de/x"`
    // is one word naming `.claude/x`.
    if (c === '\\' && (cmd[i + 1] === '\n' || (cmd[i + 1] === '\r' && cmd[i + 2] === '\n'))) {
      i += cmd[i + 1] === '\r' ? 2 : 1;
      continue;
    }
    if (quote) {
      if (quote === '"' && c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; continue; }
      if (c === quote) { quote = null; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; started = true; continue; }
    if (c === ' ' || c === '\t') { endToken(); continue; }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || c === '\n' || c === '\r') {
      // Segment always; pipeline only when the separator really starts a new list item. A
      // doubled `&&`/`||` is hard — its first character sees its twin ahead and bumps, its
      // second sees a space and does not, so the pair bumps exactly once.
      const doubled = (c === '&' || c === '|') && cmd[i + 1] === c;
      endSeg(i + 1, (c === '&' || c === '|') && !doubled);
      continue;
    }
    cur += c;
    started = true;
  }
  endSeg(cmd.length);
  return segs;
}

/**
 * Where the real verb starts in `tokens`, past everything that only stands in front of
 * one, or -1 if the segment has no verb at all.
 *
 * The flag-and-number skip engages *only* after a wrapper word has been seen, so
 * `nice -n 5 tee f` and `stdbuf -o0 tee f` reach `tee` while `cp -r a b` is untouched. The
 * loop stops at the first token that is neither an assignment, a wrapper, nor a wrapper's
 * own option — which is what keeps `time ls -la .claude/` a read: `ls` ends the scan.
 */
function verbAt(tokens) {
  let i = 0;
  let wrapped = false;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[\w.]+=/.test(t)) { i++; continue; }                                // `FOO=bar tee x`
    if (VERB_PREFIX.has(t)) { i++; wrapped = true; continue; }
    if (wrapped && (t.startsWith('-') || /^\d+$/.test(t))) { i++; continue; }  // `nice -n 5`, `timeout 5`
    break;
  }
  return i < tokens.length ? i : -1;
}

/** `/usr/bin/tee` is `tee`. */
const verbOf = (token) => token.slice(token.lastIndexOf('/') + 1);

/**
 * **One mechanism, not a list: a verb whose write target arrives as an option's argument — and
 * that argument is a path.** The second half is a boundary, not padding; it is stated at the
 * bottom of this comment with the measurement that found it.
 *
 * This began as `HAS_TARGET_DIR` — four coreutils verbs and GNU's `--target-directory`, which
 * inverts the operand order so that `cp -t .claude src` names the destination *first* and the
 * last-operand rule takes `src`. The generalisation is the fix for the archivers, which are
 * structurally identical: `tar xf a.tar -C .claude` and `unzip -o a.zip -d .claude` name the
 * directory they will unpack into, in plain sight, as an option value. Each was measured ALLOW
 * and then **wrote a real 4798-byte guard file down to 2 bytes** — with an archive that
 * actually contains a `settings.local.json` member, which is the measurement the "measured
 * intact" list did not make.
 *
 * Generalising it caught three verbs nobody had named, which is the argument for doing it as a
 * mechanism rather than as a list of archivers. All three measured ALLOW → **WROTE**:
 *
 *   `sort -o <guard> src.txt` / `--output=` → 2b.  A *read* verb whose destination is an option.
 *   `curl -s -o <guard> file://…` / `--output` → 1b.
 *   `wget -q -O <guard> file://…` → 0b.
 *
 * **The table is per-verb and must stay per-verb**, which is the narrowing this round's
 * predecessor made for exactly the same reason: the same letter is a different option
 * elsewhere. `-t` is `--times` for `rsync` and `--test` for `gzip`; read blindly it returned
 * rsync's *source* as a destination and denied a read. `-o` is `--output` for `sort` and `curl`
 * but `--stdout` has no argument at all for `gzip`, and `-d` is `--decompress` for `gzip` while
 * being `--exdir` for `unzip`. A single global option set would reintroduce that bug five times
 * over. Each entry is one verb and the options that verb really spells this way.
 *
 * The counterargument, stated because it is a fair one: `tar -C dir` writes *whatever the
 * archive contains*, so the file it lands on is not a token in the command string. That is
 * closer to the declared subprocess residual than `rsync` is. It is graded as the same class
 * anyway, on the test the whole rule uses: `-C .claude` names the directory in plain sight,
 * and this rule is "`.claude/` is not yours to write" — not "you may not write these exact
 * bytes". The verdict a directory earns is `CLAUDE_DENY`, which says precisely that.
 *
 * ---
 * ⚠ **Where "an option's argument" stops: a RENAME EXPRESSION, and it is measured, not
 * theorised.** These same archivers take an option whose value is an ed-style substitution that
 * *rewrites member names*, so the destination is produced by the rewrite rather than named by
 * the option. Three spellings, each ALLOW at the real hook process and each **WROTE a real
 * 4315-byte guard file down to 2 bytes**:
 *
 *   `pax -r -f a.tar -s ',^,.claude/,'`                              → **WROTE 4315 → 2**
 *   `pax -r -f a.tar -s ',^settings.local.json$,.claude/settings…,'` → **WROTE 4315 → 2**
 *   `tar xf a.tar -s ',^,.claude/,'`   *(bsdtar's spelling of the same)* → **WROTE 4315 → 2**
 *
 * The tokenizer *does* hand this rule the token — quoting is not the obstacle, `segments`
 * strips quotes. The obstacle is that `,^,.claude/,` is not a path: `claudeVerdict` tests whole
 * `/`-separated segments, and `.claude` is not one of this string's. Reaching it would mean
 * parsing the expression — split on its own delimiter, strip GNU's leading `s`, judge each
 * field — which is a *second* mechanism (an interpreter for a rewrite language) rather than a
 * generalisation of this one, and it lands the rule on the far side of the line already drawn
 * under `WRITES_WITH_IN_PLACE`: **the destination is a path inside a program the tool
 * interprets, not one of its operands.** So it is declared with `sed -n 'w f'`,
 * `awk '{print > "f"}'`, `perl -e`, `python3 -c` and `bash -c`, and pinned as the ALLOW it is
 * so the boundary stays a decision. `tar --transform` (GNU's spelling) could not be measured
 * here — bsdtar rejects the option and left the file intact, which is a fact about this
 * `$PATH` and not about the verb.
 */
const OPTION_TARGET = new Map([
  // GNU coreutils' destination-first spelling.
  ['cp', ['-t', '--target-directory']],
  ['install', ['-t', '--target-directory']],
  ['ln', ['-t', '--target-directory']],
  ['mv', ['-t', '--target-directory']],
  // Unpack-into-a-directory. `-C` is `--directory` for tar and its two aliases; `unzip`
  // spells the same idea `-d`, and `cpio` spells it `-D`.
  ['tar', ['-C', '--directory']],
  ['bsdtar', ['-C', '--directory']],
  ['gtar', ['-C', '--directory']],
  ['unzip', ['-d', '--exdir']],
  ['cpio', ['-D', '--directory']],
  // Read verbs whose *output* is an option value.
  ['sort', ['-o', '--output']],
  ['curl', ['-o', '--output']],
  ['wget', ['-O', '--output-document']],
]);

/**
 * Every value of `verb`'s destination options in `args`, in all four spellings a shell user
 * reaches for: `-C dir`, `-Cdir`, `--directory dir` and `--directory=dir`.
 *
 * A generator rather than a single return, because a command may carry the option twice
 * (`tar xf a.tar -C /tmp -C .claude`) and only the last one wins in most tools — but which one
 * wins is per-tool, and judging all of them is the safe direction: an extra value costs one
 * failed resolution, a missed one costs the guard file.
 */
function* optionTargets(verb, args) {
  const opts = OPTION_TARGET.get(verb);
  if (!opts) return;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    for (const opt of opts) {
      if (a === opt) { yield args[k + 1]; break; }
      if (opt.startsWith('--') && a.startsWith(`${opt}=`)) { yield a.slice(opt.length + 1); break; }
      // A short option with its value glued on (`-t.claude`, `-C.claude`). Guarded against
      // `--`, so `--target-directory` is never mistaken for a glued `-t`.
      if (!opt.startsWith('--') && !a.startsWith('--') && a.startsWith(opt) && a.length > opt.length) {
        yield a.slice(opt.length);
        break;
      }
    }
  }
}

/**
 * Verbs whose destination, absent any option, is **the working directory they run in**.
 *
 * `cd .claude && tar xf a.tar` needs no option handling at all — it needs `tar` to be a writer
 * whose target is its cwd. Measured ALLOW and **WROTE 4798 → 2** for `tar`, `unzip` and
 * `pax -r`; `cd <dir> && <cmd>` is an idiom a model emits unprompted, so this is an accident
 * path as much as an attack path.
 *
 * Emitted as a synthetic `mustExist` target, like `git clean`'s, because the command names no
 * file: `judge` resolves the segment's cwd and refuses to judge it textually, since "as
 * written" carries no information about a directory that was never spelled out.
 *
 * **Deliberately not mode-aware, and the cost is stated.** Distinguishing `tar x` from `tar c`
 * would need a mode table (`xf`, `xzf`, `--extract`, `-i` vs `-o` for cpio, `-r` vs `-w` for
 * pax) that is easy to get wrong in the unsafe direction. Treating the verb as a cwd-writer
 * regardless over-collects only for a command run *from inside* `.claude/` — `cd .claude &&
 * tar tf a.tar` is now denied — which is a place no teammate has business writing from anyway,
 * and every such command is one `cd` away from being allowed.
 */
const EXTRACTS_INTO_CWD = new Set(['tar', 'bsdtar', 'gtar', 'unzip', 'cpio', 'pax']);

/** No cwd this process can compute is longer than this; past it, tracking gives up. */
const CWD_MAX = 4096;

/**
 * Where a `cd` in this segment leaves the shell, or null for "no longer knowable".
 *
 * `resolveTarget` joins a relative target onto the *session* cwd, which is right until a
 * `cd` in an earlier segment has moved it. `cd .claude && cp /dev/null settings.local.json`
 * emptied a real guard file for exactly that reason: no subshell, no symlink, no unusual
 * syntax at all. `cd <dir> && <cmd>` is an idiom a model emits spontaneously, so this is an
 * accident path as much as an attack path — the plainest of the four the re-review found.
 *
 * null is deliberately distinct from "unchanged". `cd -`, `cd $SOMEDIR` and `popd` land
 * somewhere only the shell knows, and carrying a *wrong* cwd forward would silently
 * un-resolve every later target; the caller falls back to a textual judgement instead. The
 * length bound is not decoration: `cd a` repeated fifty thousand times would otherwise
 * normalize a path that grows by two characters each time, which is quadratic.
 */
function cdDestination(args, cwd, env, home) {
  const operands = args.filter((a) => !(a.startsWith('-') && a !== '-') && !a.includes('>') && !a.includes('<'));
  const first = operands[0];
  if (first === undefined) return env?.HOME || homedir(); // a bare `cd` is $HOME
  const t = expand(first, env, home);
  if (t === '' || t === '-' || t.includes('$') || t.includes('`')) return null;
  const next = isAbsolute(t) ? normalize(t) : (cwd === null ? null : normalize(join(cwd, t)));
  return next !== null && next.length > CWD_MAX ? null : next;
}

/**
 * Every segment of `cmd` paired with the working directory in effect when it runs.
 *
 * A subshell's `cd` is not undone at its `)`, which over-approximates on purpose: for a
 * target that names `.claude` itself the verdict is identical either way, and for one that
 * does not, keeping the inner cwd errs towards a deny. Modelling subshell scope exactly
 * would mean a second shell parser bought with no safety.
 */
function segmentPlan(cmd, cwd0, env, home) {
  let cwd = cwd0;
  const plan = [];
  for (const seg of segments(cmd)) {
    plan.push({ tokens: seg.tokens, start: seg.start, pipe: seg.pipe, cwd });
    const at = verbAt(seg.tokens);
    if (at === -1) continue;
    const verb = verbOf(seg.tokens[at]);
    if (verb === 'cd' || verb === 'pushd') cwd = cdDestination(seg.tokens.slice(at + 1), cwd, env, home);
    else if (verb === 'popd') cwd = null;
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Arm (e): the cd-compound LIVENESS lever, for leads stalled on a prompt nobody saw. Inert
// unless the operator arms it.
//
// Claude Code 2.1.259 shipped a bypass-immune safety check (`deniedPathInsideDirectory`) that
// raised a permission prompt whenever `grep|egrep|fgrep|rg|diff|git|cp|mv` took a RELATIVE operand
// after a `cd` in a compound command AND any `Read()` deny rule existed. Leads carry 13 such rules
// (the credential boundary) and run `--dangerously-skip-permissions`, so that prompt was the one
// thing bypass mode still showed — and nobody is at a lead's pane. MEASURED over 179 fleet
// transcripts (10,813 Bash calls): 79 stalls summing 214 hours, 43 leads and 36 teammates, the
// worst 40.3 h; 70 of the 79 were newline-joined (`cd /abs⏎…⏎grep -n x file`), 9 used `&&`; 53
// targeted the lead's own worktree, 26 other directories. 2.1.263 removed the check — the same
// command RUNS there — and `tested_claude` cannot catch a patch-level regression by design.
//
// MEASURED on the real 2.1.259 binary, which is what licenses this arm's existence and its shape:
//   - a PreToolUse DENY pre-empts the prompt: the model received the deny reason, no ask occurred;
//   - an explicit hook `allow` did NOT suppress the bypass-immune ask (and it would have bypassed
//     every rule for that call, `Bash(*.ssh/id_*)` and the 13 `Read()` denies included);
//   - a `permissions.allow` rule for grep/cd did NOT suppress it either.
// So a deny is the only lever this hook has — and it is the WRONG thing to ship armed: on 2.1.263
// it would tax 14–31% of Bash calls for a prompt that no longer exists, and the hook cannot tell
// which build is calling it (the hook env carries CLAUDECODE=1 and CLAUDE_CODE_ENTRYPOINT, and no
// CLAUDE_CODE_VERSION). Hence the flag: `leads/<id>/CD_COMPOUND_ASKS`, beside BUDGET_TRIPPED and
// HOLD, written by the operator (`touch`) when `soma doctor`'s `claude cd-compound read runs` check
// FAILs on a build the fleet must nevertheless keep running on, and removed when it is cycled off.
//
// **Fail-OPEN, and that is the opposite of arms (b2)/(c) on purpose.** Those guard the lease and
// the credential boundary, where a wrong silence is a breach; this guards liveness, where a wrong
// deny costs the model one retry turn and a wrong silence costs what it costs today. No usable
// lead id, no flag, an unparseable command, a flag read that throws → silence.
//
// The predicate MIRRORS 2.1.259's, over-approximating operands on purpose (its per-verb path
// extraction was never decoded): a `cd`/`pushd` segment, then a LATER segment whose verb is in the
// set with a free operand that is not a flag, not absolute and not `~`-prefixed. A `$`-prefixed
// operand FIRES — §5.4 of the investigation listed `$` beside `~` as a skip, but the 2.1.259 branch
// it quotes tests only `isAbsolute(operand) || operand.startsWith("~")`, so `grep x $F` after a cd
// asked on that build, and when this arm is armed a miss is a 40-hour stall while a false deny is
// one turn. grep's pattern and `git grep`'s are not paths; an option's value (`-A 3`, `-e PAT`,
// `git -C dir`) is not a path; a bare number is not a path; a heredoc body is data; a quoted
// `"cd x && grep y z"` is one token. The reason names no path and says exactly what to type.
//
// Cost: armed, one retry turn per matching call (~14% of Bash calls on a 2.1.259-class build until
// the model adapts in-session); unarmed, one `existsSync` — and only for a command that already
// matched the predicate, so the 69% of Bash calls with no `cd` in them never pay even that.
// ---------------------------------------------------------------------------

/** The lever: `<SOMA_HOME>/leads/<id>/CD_COMPOUND_ASKS`. Read here, written only by the operator. */
const CD_COMPOUND_FLAG = 'CD_COMPOUND_ASKS';

/** The verbs 2.1.259's check applied to — its own set, verbatim. */
const CD_COMPOUND_VERBS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'diff', 'git', 'cp', 'mv']);
const GREP_FAMILY = new Set(['grep', 'egrep', 'fgrep', 'rg']);

/**
 * grep/rg options that consume the NEXT token, so that token is neither the pattern nor a path.
 * Only spellings that take a value in BOTH tools (or exist in one only) are listed: `-E` is
 * extended-regex for grep and `--encoding <enc>` for rg, and consuming `grep -E 'a|b' file`'s
 * pattern as a value would make `file` the pattern and MISS the path — the wrong direction here.
 */
const GREP_VALUE_OPTS = new Set([
  '-e', '-f', '-A', '-B', '-C', '-m', '-g', '-t', '-j', '-M',
  '--regexp', '--file', '--after-context', '--before-context', '--context', '--max-count',
  '--include', '--exclude', '--exclude-dir', '--glob', '--iglob', '--type', '--type-not',
  '--max-depth', '--threads', '--max-columns', '--encoding', '--color', '--sort', '--sortr',
]);

/** git GLOBAL options that consume the next token (`git -C <dir> log`); the subcommand follows them. */
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path',
  '--super-prefix', '--config-env', '--attr-source', '--list-cmds']);

/**
 * Does this `verb` invocation carry a free operand 2.1.259's text checker could not resolve — one
 * that is not a flag, not an option's value, not a redirect token, not a bare number, not the
 * grep pattern, not absolute and not `~`-prefixed?
 */
function relativeReadOperand(verb, args) {
  const grepish = GREP_FAMILY.has(verb);
  let i = 0;
  let sub = null;
  if (verb === 'git') {
    while (i < args.length && args[i].startsWith('-')) {
      const a = args[i++];
      if (GIT_VALUE_OPTS.has(a)) i++;             // `-C <dir>`, `-c <k=v>`, `--git-dir <d>` …
    }
    sub = args[i++];                               // the subcommand; undefined for a bare `git`
  }
  const patternFirst = grepish || sub === 'grep';
  let pattern = patternFirst;                      // the first free operand is the PATTERN, not a path
  let dashdash = false;
  for (; i < args.length; i++) {
    const a = args[i];
    if (!dashdash && a === '--') { dashdash = true; continue; }
    if (!dashdash && a.startsWith('-') && a !== '-') {
      if (patternFirst && GREP_VALUE_OPTS.has(a)) {
        if (a === '-e' || a === '-f' || a === '--regexp' || a === '--file') pattern = false;
        i++;                                       // the option's value is neither pattern nor path
      } else if (patternFirst && /^--(?:regexp|file)=/.test(a)) {
        pattern = false;
      }
      continue;
    }
    if (a.includes('>') || a.includes('<')) continue;        // a redirect token the tokenizer left in place
    if (a === '' || a === '-' || /^\d+$/.test(a)) continue;  // stdin, or a number that is an option's value
    if (pattern) { pattern = false; continue; }
    if (isAbsolute(a) || a.startsWith('~')) continue;        // 2.1.259 resolved these and moved on
    return true;                                             // `x`, `./x`, `../x`, `$VAR`: unresolvable after a cd
  }
  return false;
}

/**
 * The 2.1.259 asking shape: a `cd`/`pushd` segment, then a LATER segment whose verb is in the set
 * with an operand `relativeReadOperand` cannot clear. Pure, never throws for a string, and cheap
 * for the common command: no `cd`/`pushd` anywhere in the text means no tokenization at all.
 */
function cdCompoundAsks(cmd) {
  if (typeof cmd !== 'string' || !/\b(?:cd|pushd)\b/.test(cmd)) return false;
  let seenCd = false;
  for (const seg of segments(maskHeredocs(cmd))) {
    const at = verbAt(seg.tokens);
    if (at === -1) continue;
    const verb = verbOf(seg.tokens[at]);
    if (!seenCd) {
      if (verb === 'cd' || verb === 'pushd') seenCd = true;
      continue;
    }
    if (CD_COMPOUND_VERBS.has(verb) && relativeReadOperand(verb, seg.tokens.slice(at + 1))) return true;
  }
  return false;
}

/** Is `verb` one whose operands are files it writes or deletes? */
const isWriter = (verb) => WRITES_EVERY_ARG.has(verb) || WRITES_LAST_ARG.has(verb);

/**
 * Does this `find` invocation run a writer over the files it matches?
 *
 * `-delete` always does. `-exec`/`-execdir` (and their `-ok` prompting twins) do only when
 * the verb they name is one of ours, which is what keeps `find .claude -exec cat {} \;` and
 * `find . -exec grep -l x {} +` reads rather than denials.
 */
function findWrites(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '-delete') return true;
    if ((a === '-exec' || a === '-execdir' || a === '-ok' || a === '-okdir')
      && typeof args[k + 1] === 'string' && isWriter(verbOf(args[k + 1]))) return true;
  }
  return false;
}

/**
 * The **pipelines** of `plan` that run a writer whose operands are not in its own argument
 * list — empty when there are none.
 *
 * Two shapes, and they are the same structure with a different supplier. `xargs` is in
 * `VERB_PREFIX`, so `verbAt` skips past it and resolves the verb of `echo <guard> | xargs rm`
 * to `rm` — which then has **zero** operands, so `writerTargets` yields nothing at all.
 * `find … -exec rm {} \;` and `find … -delete` put the operands in find's argument list
 * instead of on a pipe.
 *
 * Measured as a real hook process and then executed against a real guard file: `echo <guard> |
 * xargs rm`, `xargs -I{} rm {}`, `printf … | xargs -0 rm`, `xargs truncate -s0`,
 * `xargs -I{} mv {} /tmp`, `find .claude -name settings.local.json -exec rm {} \;` and
 * `find . -name settings.local.json -delete` were each ALLOW and each **destroyed the file**.
 * No rule in the generated guard file mentions `xargs` or `find`.
 *
 * **Why `xargs` stays in `VERB_PREFIX` rather than being treated as a writer itself.** Making
 * `xargs` the verb and its arguments the targets would deny `xargs ls .claude/`,
 * `echo <guard> | xargs cat` and `xargs grep -c deny <guard>` — reads, and the kind of read
 * this rule allows on purpose everywhere else. Keeping the skip is also what makes
 * `xargs -I{} tee <guard>` and `xargs -I{} cp {} <guard>` deny *today*: there the real verb
 * has a real `.claude` operand, and only `verbAt` seeing past `xargs` finds it. So the skip is
 * load-bearing in both directions and the gap is narrowly the no-resolvable-operand case.
 */
function proxiedPipelines(plan) {
  const pipes = new Set();
  for (const seg of plan) {
    const at = verbAt(seg.tokens);
    if (at === -1) continue;
    const verb = verbOf(seg.tokens[at]);
    if (isWriter(verb)) {
      if (seg.tokens.slice(0, at).some((t) => verbOf(t) === 'xargs')) pipes.add(seg.pipe);
    } else if (verb === 'find' && findWrites(seg.tokens.slice(at + 1))) pipes.add(seg.pipe);
  }
  return pipes;
}

/**
 * Every token of the **pipelines that contain a proxied writer**, each with its own segment's
 * cwd — and nothing at all when no writer's operands come from outside its own argument list.
 *
 * The reasoning is that the operands came from *somewhere*, and a token that resolves into
 * `.claude/` is that somewhere. Judging a token that is not a path costs one failed
 * `realpath` and yields nothing, so this is over-collection of exactly the harmless kind the
 * verb lists above already rely on.
 *
 * ⚠ **The scope is the pipeline, and it used to be the whole command — which denied reads.**
 * Yielding every token of every segment meant a command pairing an ordinary cleanup with a
 * plain **read** of the guard file in an unrelated segment was refused. Measured at the real
 * hook process, eight shapes, every one of them ALLOW on its own and every one writing nothing
 * at all: `find . -name '*.log' -delete ; cat <guard>`,
 * `find … | xargs rm ; jq . <guard>`, `cat <guard> ; find … | xargs rm`,
 * `grep -q deny <guard> && find . -delete`, `find … | xargs rm ; ls .claude`,
 * `… ; cp <guard> /tmp/b.json`, `… ; wc -c <guard>`, `… -delete ; diff <guard> <guard>`.
 *
 * That was the wrong cost to pay, and the argument against it is one this rule already made:
 * the first of the three reasons for keeping `xargs` in `VERB_PREFIX` rather than treating it
 * as a writer was **"the other shape denies reads"**. Reads are what this rule permits on
 * purpose everywhere else, and the comment justifying the over-collection above covers only
 * tokens that are *not* paths — these are paths into `.claude/`, belonging to a read.
 *
 * The narrowing is to the pipeline, because a pipeline is exactly the unit in which "the
 * operands came from somewhere I cannot see" is true: `echo <guard> | xargs rm` passes the path
 * across the `|`, while `find … | xargs rm ; cat <guard>` shares nothing but a command string.
 * Every acceptance vector survives it — including `cd .claude && echo settings.local.json |
 * xargs rm`, where `&&` ends the pipeline and the guard name is caught by the by-name arm
 * inside the writer's own pipeline rather than by the `cd`'s token.
 *
 * **The residual, narrowed rather than removed:** a `.claude` *read* that shares a **pipeline**
 * with a proxied writer is still denied — `wc -c <guard> | xargs rm` writes nothing and is
 * refused. That is kept deliberately, because the shapes on the other side of that line really
 * do destroy the file: `cat <guard> | xargs rm`, `ls .claude | xargs rm` and
 * `grep -l deny <guard> | xargs rm` all feed a path across the pipe, and all were measured
 * deleting it. Erring towards the deny inside one pipeline is the safe direction; erring
 * towards it across a whole command string was not.
 *
 * **This is its own generator, and that is not a stylistic choice.** Folded into
 * `writerTargets` it shared one `TARGET_CAP` budget with the real writer targets, and 255
 * junk tokens in front of it consumed the whole budget:
 * `echo <255 tokens> | xargs rm ; tee <guard>` measured pad=200 → DENY, pad=**255 → ALLOW**.
 * That is the same ordered-cap defect the 256-target comment below records, reintroduced by a
 * new generator sharing an old budget. A generator per source is what stops it.
 *
 * ⚠ **What this does not reach, and it is a real hole rather than a technicality.** An `xargs`
 * whose paths arrive only on stdin from a file or from another command's output —
 * `xargs rm < list.txt`, `cat list.txt | xargs rm` — names no path in the command string at
 * all. Measured ALLOW, and it deleted the file. That one genuinely is outside a
 * command-string gate. `ls .claude | xargs rm` *is* caught, but only because `ls`'s own
 * operand is the directory.
 *
 * **The declaration was one spelling short, and the missing one is worse than the two above
 * because the path IS in the command string.** Process substitution —
 * `xargs rm < <(echo <guard>)` — reaches the same hole through a redirect from a subshell
 * instead of from a file. Measured ALLOW at the real predicate, in four spellings:
 * `< <(echo ./<guard>)`, `< <(echo <guard>)`, `< <(find .claude -name settings.local.json)`
 * and `xargs -0 rm < <(printf %s\0 ./<guard>)`. **Pre-existing, and not a regression from the
 * pipeline narrowing above:** measured identical under the old and the new gate, all four
 * readings.
 *
 * It is not reached for a reason that is the *pipeline scope working as designed*, which is
 * why widening the declaration is the honest move and a patch is not. `(` and `)` are hard
 * separators in `segments()` — they bump `pipe` — so `< <(echo <guard>)` puts the guard token
 * in a pipeline of its own, and the writer's pipeline holds only `xargs rm < <`, which names
 * no path. That same hardness is what keeps `( echo ./<guard> | xargs rm )` a DENY (the `|`
 * inside the parens is soft, so both halves share one pipeline) and what stops
 * `find … | xargs rm ; cat <guard>` from denying a read. Making the parens soft to catch this
 * would put every subshell's tokens back into the writer's scope — the whole-command scope the
 * ⚠ above was narrowed away from, and the false read-denials would come straight back.
 *
 * **Nothing here is closable syntactically, and that is the finding rather than a caveat.** A
 * source of targets is a semantic judgement, not a syntactic one: `<(…)` can hold any command,
 * so recognising it means deciding what an arbitrary subshell will print. This is the same
 * ruling this build took on the credential boundary and on the ordered-cap defect below — **a
 * false sense of closure is worse than a declared hole.** So it is declared, and a maintainer
 * who reads the two spellings above and concludes "only stdin from a file" would be wrong.
 * One variant *is* caught, for the `ls .claude` reason and not a better one:
 * `cd .claude && xargs rm < <(echo settings.local.json)` denies on the `cd`'s own operand.
 */
function* proxiedTargets(plan) {
  const pipes = proxiedPipelines(plan);
  if (pipes.size === 0) return;
  for (const seg of plan) {
    if (!pipes.has(seg.pipe)) continue;
    for (const raw of seg.tokens) {
      yield { raw, cwd: seg.cwd };
      // A token that *is* the guard file's own name, judged with no anchor at all.
      //
      // `judge(name, null)` is the arm an unfollowable `cd` already uses, and it is here for
      // the same reason: the operands came from somewhere this scan cannot see, so how the
      // path is written is all the evidence there is. Without it,
      // `find . -name settings.local.json -delete` and `-exec rm {} \;` are ALLOW — measured,
      // and both **deleted a real guard file** — because `.` is find's only path operand and
      // `.` is the worktree, not `.claude/`.
      //
      // The cost, stated rather than discovered later: `find packages -name settings.json
      // -delete` in a monorepo is now denied, and it writes nothing of ours. The trade is
      // taken on asymmetry — that teammate can spell the same intent another way
      // (`-path './packages/*/settings.json'`), while a deleted guard file has no second
      // layer beneath it — and it is narrow, because this only runs for a writer whose
      // operands are not in its own argument list.
      //
      // The `GUARD_FILE_RE` test is a budget filter, not a safety condition: the arm it feeds
      // can only return a verdict for those two names anyway, so yielding every basename is an
      // equivalent mutant — it just spends the cap twice as fast.
      const name = basename(raw);
      if (GUARD_FILE_RE.test(name)) yield { raw: name, cwd: null };
    }
  }
}

/**
 * Every argument in `plan` that names a file its command will write or delete, each with
 * the cwd it has to be resolved against.
 */
function* writerTargets(plan) {
  for (const seg of plan) {
    const at = verbAt(seg.tokens);
    if (at === -1) continue;
    const verb = verbOf(seg.tokens[at]);
    const args = seg.tokens.slice(at + 1);
    const operands = args.filter((a) => !a.startsWith('-'));
    const emit = (raw) => ({ raw, cwd: seg.cwd });
    let dir;
    for (const t of optionTargets(verb, args)) { dir = t; yield emit(t); }
    // The destination is the cwd only when no option moved it. `tar xf a.tar -C /tmp` run
    // from inside `.claude/` writes to `/tmp`, and denying it would be a plain false denial.
    //
    // `mustExist` is a **measured equivalent mutant** here, kept for legibility rather than
    // for safety: dropping it changed nothing across a 208-command differential corpus,
    // because a cwd always exists and `'.'` carries no textual meaning to lose. It stays
    // because it says what this target is — synthetic, invented from a command that named no
    // file — which is the same reason `git clean`'s carries it.
    if (dir === undefined && EXTRACTS_INTO_CWD.has(verb)) {
      yield { raw: '.', cwd: seg.cwd, mustExist: true };
    }
    if (WRITES_EVERY_ARG.has(verb)) {
      for (const o of operands) yield emit(o);
    } else if (WRITES_LAST_ARG.has(verb)) {
      // With `-t` the destination is already yielded above and every operand is a source,
      // which for these three verbs is a read.
      if (dir === undefined && operands.length) yield emit(operands[operands.length - 1]);
    } else if (WRITES_WITH_IN_PLACE.has(verb) && args.some((a) => a.startsWith('-i') || a.startsWith('--in-place'))) {
      // `--in-place=.bak` is the same flag: the old test for `a === '--in-place'` exactly
      // missed every spelling that carries its suffix inline. `a.startsWith('-i')` already
      // covers a bare `-i`, so the redundant first arm the test used to carry is gone.
      for (const o of operands) yield emit(o);
    } else if (verb === 'dd') {
      for (const a of args) if (a.startsWith('of=')) yield emit(a.slice(3));
    } else if (verb === 'git' && args.includes('clean') && args.some(isCleanIgnored)) {
      // **`git clean -fdx` deletes the guard file, and nothing else stops a teammate.**
      // Found and measured in a review, a critical hole under a verb the gate leaves
      // open on purpose. Three facts line up: the gate's `GIT_VERB` ban is lead-only (a
      // teammate's git is how work is delivered), `git` is in no writer set here, and the
      // generated deny list contains **zero** rules mentioning `clean`. Meanwhile `worktree.mjs`
      // writes `.claude/.gitignore` = `*`, so every file in `.claude/` is *ignored* — which
      // is exactly what `-x` and `-X` add to what `git clean` removes. Measured in a real
      // repo: `git clean -fd` leaves the guard file intact, `git clean -fdX` and
      // `git clean -fdx` delete it **and the whole `.claude/` directory**.
      //
      // So only the flags that reach ignored files are treated as a delete, which keeps the
      // idiom's common intent available — the deny reason names `git clean -fd` as the
      // spelling that still works. Consistent with the ratified decision on the lead's side,
      // `-n`/`--dry-run` is NOT carved out: the flag can appear anywhere in the argument
      // list, and a carve-out that got it wrong would wave through a destructive clean.
      //
      // The target is synthetic — `git clean` names no file — so it is emitted with
      // `mustExist`, and `judge` drops it unless that `.claude` directory is really there.
      // Without that, `cd src && git clean -fdx` would deny on a `src/.claude` that does not
      // exist and cannot be reached.
      const pathspecs = args.slice(args.indexOf('clean') + 1).filter((a) => !a.startsWith('-'));
      for (const p of pathspecs.length ? pathspecs : ['.']) yield { raw: join(p, CLAUDE_DIR), cwd: seg.cwd, mustExist: true };
    }
  }
}

/**
 * A `git clean` short-option cluster that reaches **ignored** files: `-x` or `-X`, in any
 * combination (`-fdx`, `-xfd`, `-fdX`). Long options are excluded deliberately — `git clean`
 * has no long spelling for either, while `--exclude=x` contains an `x` and means the opposite.
 */
const isCleanIgnored = (a) => /^-[a-zA-Z]+$/.test(a) && /[xX]/.test(a);

/**
 * The redirect targets of `cmd`, each attributed to the cwd of the segment its operator
 * sits in. Matches arrive in index order, so the segment pointer only ever moves forward.
 */
function* redirectTargetsInPlan(cmd, plan, cwd0) {
  let k = -1;
  for (const { raw, at } of redirectTargets(cmd)) {
    while (k + 1 < plan.length && plan[k + 1].start <= at) k++;
    yield { raw, cwd: k >= 0 ? plan[k].cwd : cwd0 };
  }
}

/**
 * `raw` as an absolute path with every symlink resolved, or null if it cannot be one.
 *
 * The symlink resolution is the whole point and is not inherited from `insideRoot`,
 * whose textual prefix test `ln -s <real file> decoy.json` walks straight through. A
 * rule that says "you may not write into `.claude/`" *invites* exactly that evasion, so
 * the comparison has to be on where the path lands, not on how it is spelled.
 *
 * The target usually does not exist yet (`> .claude/newfile`), which `realpath` refuses,
 * so the deepest **existing** ancestor is resolved and the missing tail re-joined onto
 * it. That is what catches `tee linkdir/settings.local.json` where `linkdir` is a
 * symlink to `.claude` — the parent is real even when the child is not.
 */
function resolveTarget(raw, cwd, env, home, realpath) {
  let t = expand(raw, env, home);
  if (typeof t !== 'string' || t === '') return null;
  if (!isAbsolute(t)) t = join(typeof cwd === 'string' && cwd ? cwd : '.', t);
  t = normalize(t);
  let head = t;
  const tail = [];
  // Bounded, so a 200 KB path of `/a/a/a/…` cannot turn one tool call into a hundred
  // thousand `realpath` syscalls. Running out of budget degrades to judging the path as
  // written — which still catches a literal `.claude` segment, just not a symlinked one,
  // and no real path is sixty-four levels deep.
  for (let depth = 0; depth < 64; depth++) {
    try {
      return tail.length ? join(realpath(head), ...tail) : realpath(head);
    } catch {
      const parent = dirname(head);
      if (parent === head) break; // nothing on this path exists at all
      tail.unshift(basename(head));
      head = parent;
    }
  }
  return t;
}

/**
 * How many targets of each kind are worth a **syscall**. No real command approaches it.
 *
 * ⚠ **Read the loop in `claudeWrite` before changing this.** The cap used to end a generator's
 * scan outright, and that made it an *ordered* budget: whichever targets came first spent it,
 * and padding the front of a command with junk starved whatever came after into an ALLOW. That
 * defect has now been created twice by two different mechanisms — 256 harmless redirect targets
 * ahead of a `tee`, then 255 junk `xargs` tokens ahead of one — and its own reviewer's verdict
 * was that it had been "fixed twice, not made structurally impossible", because the invariant
 * *one budget per source of targets* is enforced by nothing but the next author remembering it.
 *
 * It is now enforced by the shape of the loop instead, and the invariant is weaker but
 * structural: **exceeding a budget may cost symlink resolution, and may never cost the verdict
 * on a path this process can name without a syscall.** Past the cap the scan keeps going and
 * judges textually, which needs no syscall — the same degradation `resolveTarget` already
 * applies when *its* depth budget runs out. So a starved budget can no longer turn a deny into
 * an allow for any target spelled with a visible `.claude` segment or a guard-file basename.
 *
 * ⚠ **That invariant was asserted one round before it was true, and the gap was a third
 * instance of this very defect.** The first attempt kept the blanket "a synthetic `mustExist`
 * target cannot be judged textually" bail-out inside the degraded path, which meant the two
 * sources whose target is a *directory* rather than a named file — `EXTRACTS_INTO_CWD` (added
 * in the same round) and `git clean -fdx` — were judged not at all past position 256. Measured:
 * `rm <256 paths> ; cd .claude && tar xf a.tar` and `rm <256 paths> ; git clean -fdx` both
 * flipped DENY at pad 255 to **ALLOW at pad 256**, and both **destroyed a real guard file**. It
 * is fixed in `judge`, where the discriminator is now whether the target has a knowable anchor
 * rather than whether it is synthetic; the tests pin both shapes at 255/256/257/300/1000.
 *
 * What a fourth source folded into an existing generator can still lose is a target reached
 * only *through a symlink* past position 256 — a hole that needs a deliberately padded command
 * and a decoy symlink together, and that fails towards the textual answer rather than towards
 * silence. The cost of the fix, in the other direction and equally bounded: past the cap a
 * synthetic target skips its existence check, so a padded `cd src && git clean -fdx` is denied
 * for a `src/.claude` that is not there. Over 256 writer targets in one command, erring towards
 * the deny — the trade this whole rule is built on.
 */
const TARGET_CAP = 256;

/**
 * The `.claude/` verdict for one already-resolved path, or null if it names nothing under
 * one. A whole-segment test, so `.claudex/` and `notclaude/` are not `.claude`.
 */
function claudeVerdict(p) {
  const parts = p.split(sep);
  const at = parts.indexOf(CLAUDE_DIR);
  if (at === -1) return null;
  const rest = parts.slice(at + 1);
  return { guardFile: rest.length === 1 && GUARD_FILE_RE.test(rest[0]) };
}

/**
 * Does `p` name `<root>/leads` itself, or anything beneath it, for any of `roots`?
 *
 * The directory itself counts, not only its contents: `rm -rf $SOMA_HOME/leads` was one of the
 * measured vectors, and it names the parent. The separator in the prefix is what keeps a
 * sibling `leads-old/` — or the `leadsnotes.md` the false-denial set pins — out of the rule,
 * exactly as `insideRoot` does it for the state root one level up.
 */
function leadsVerdict(p, prot) {
  for (const root of prot.leads) {
    if (p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)) return { leads: true };
  }
  // ⚠ **The container itself, and this is EXACT-MATCH ONLY — never a prefix.** Sealing or
  // destroying `$SOMA_HOME` defeats the breaker by exactly the mechanism the leads rule above
  // closes, without ever naming a file inside it: measured, `chmod 000 $SOMA_HOME` makes
  // `existsSync` on `BUDGET_TRIPPED` return false while the flag is still on disk, and
  // `rm -rf $SOMA_HOME` / `mv $SOMA_HOME …` were both ALLOW. A prefix here would be catastrophic
  // — it would deny `worktrees/`, which is where every teammate does its work — so the rule is
  // "the directory may not be a write TARGET", and a write to anything *under* it is untouched.
  for (const root of prot.roots) if (p === root) return { stateRoot: true };
  return null;
}

/**
 * Both spellings of `<stateRoot>/leads`: as configured, and with the state root's own symlinks
 * resolved.
 *
 * ⚠ **The second spelling is what stops this rule being a no-op on the machine it ships to.**
 * `stateRoot` only `resolve`s, so `$SOMA_HOME` keeps whatever symlinks the operator's path
 * contains — and on macOS that is the common case, not the exotic one: a state root under
 * `$TMPDIR` is `/var/folders/…` while `resolveTarget` hands back every target as
 * `/private/var/folders/…`, and `/tmp` → `/private/tmp` the same way. A prefix test against the
 * configured spelling alone therefore matches **nothing** for exactly the paths the rule exists
 * to catch, while still passing any test whose fixture happens to use an unsymlinked root.
 *
 * Deliberately lazy and memoized by the caller: `claudeWrite` performs zero syscalls for a
 * command that names no write target, and this must not change that. A state root that does not
 * exist yet cannot be resolved, which costs nothing — with nothing on disk `resolveTarget` also
 * degrades to the textual path, and that matches the configured spelling.
 */
function leadsRootsFor(home, realpath) {
  const roots = [home];
  try {
    const real = realpath(home);
    if (real !== home) roots.push(real);
  } catch { /* the state root need not exist; the configured spelling still stands */ }
  return { roots, leads: roots.map((r) => join(r, LEADS_DIR)) };
}

/**
 * Does `command` write anything inside a `.claude/` directory?
 *
 * Returns `null`, or `{ guardFile }` — `true` when the target is `settings.json` /
 * `settings.local.json` directly, which earns the deny reason that explains *why* the
 * file matters rather than merely refusing.
 *
 * Exported so the rule can be driven from a test, a canary or `doctor` without spawning
 * the hook. `realpath` is injectable for the same reason `flagExists` is, but unlike
 * `flagExists` it is **defaulted** rather than required: a caller who forgets the flag
 * predicate gets a gate with no breaker, which must fail loudly, while a caller who
 * forgets this one gets exactly the production behaviour.
 */
export function claudeWrite(command, { cwd = process.cwd(), env = process.env, realpath = realpathSync } = {}) {
  if (typeof command !== 'string' || command === '') return null;
  const home = stateRoot(env);
  const cwd0 = typeof cwd === 'string' && cwd !== '' ? cwd : null;
  // Both scans run over the same heredoc-masked copy, and it is exactly as long as the
  // original, so `plan[].start` still indexes either string.
  const scan = maskHeredocs(command);
  const plan = segmentPlan(scan, cwd0, env, home);
  let hit = null;

  // Resolved at most once per call, and only once a target actually needs judging — see
  // `leadsRootsFor` for why the resolved spelling is required and why this must stay lazy.
  let roots = null;
  const leadsRoots = () => (roots ??= leadsRootsFor(home, realpath));

  const judge = (raw, dir, mustExist = false, textOnly = false) => {
    if (typeof raw !== 'string' || raw === '') return null;
    const t = expand(raw, env, home);
    if (t === '') return null;
    // Two ways to arrive at a textual judgement. Either a `cd` this process could not follow
    // left a relative target with no knowable anchor, or the generator's syscall budget is
    // spent and the loop below has asked for the free half of the answer. Judged as written —
    // which still catches an explicit `.claude/` in the target — plus one extra arm: a target
    // whose *name* is the guard file. Without that, `cd $SOMEDIR && rm settings.local.json` is
    // a deny that depends on a variable only the shell can expand. Narrow on purpose: the
    // by-name arm applies ONLY here, so a teammate writing `packages/app/settings.json` from a
    // knowable cwd is untouched.
    //
    // ⚠ **The two ways do NOT degrade to the same answer, and treating them as if they did
    // reopened the ordered-cap defect a third time.** A `mustExist` target is synthetic — the
    // command named no file — so `basename` is meaningless for it and it used to be dropped
    // here outright. That is right for the *unknowable-cd* case, where there is no anchor and
    // "as written" carries no information. It is wrong for the *spent-budget* case, where the
    // anchor is a cwd this process computed and the answer is free. Measured before the fix,
    // against a real guard file, at exactly the cap's cliff:
    //
    //   `rm <256 paths> ; cd .claude && tar xf a.tar`  pad 255 → DENY, pad 256 → **ALLOW**,
    //                                                  and the ALLOW **wrote 4315b → 2b**.
    //   `rm <256 paths> ; git clean -fdx`              pad 255 → DENY, pad 256 → **ALLOW**,
    //                                                  and the ALLOW **DELETED the file**.
    //
    // So the anchor is the discriminator, not the syntheticness.
    if (textOnly || (dir === null && !isAbsolute(t))) {
      const anchored = isAbsolute(t) || (typeof dir === 'string' && dir !== '');
      if (mustExist && !anchored) return null;
      const asWritten = isAbsolute(t) ? t : join(typeof dir === 'string' && dir ? dir : '.', t);
      const textual = claudeVerdict(normalize(asWritten));
      if (textual) return textual;
      // The leads rule's free half. A target under the state root is spelled absolutely by the
      // time it reaches here — `expand` has already turned `$SOMA_HOME`, `$HOME` and `~` into
      // paths — so this needs no syscall and must therefore survive a spent budget, which is
      // the cap's verdict-neutrality invariant applied to the second verdict. A still-relative
      // target simply cannot prefix-match an absolute root, so there is no false positive here.
      const underLeads = leadsVerdict(normalize(asWritten), leadsRoots());
      if (underLeads) return underLeads;
      // A synthetic target has no name of its own, so the by-name arm has nothing to test.
      // Belt and braces rather than load-bearing, and provably so: the only two synthetic
      // `raw`s are `'.'` and `join(p, '.claude')`, whose basenames are `.` and `.claude`, and
      // `GUARD_FILE_RE` matches neither. Removing this line is an equivalent mutant by
      // construction — recorded here so the next reader does not have to re-derive it.
      if (mustExist) return null;
      return GUARD_FILE_RE.test(basename(t)) ? { guardFile: true } : null;
    }
    const resolved = resolveTarget(raw, dir, env, home, realpath);
    if (!resolved) return null;
    // A synthetic target counts only if the directory it names is really there. `git clean`
    // names no file, so the `.claude` it might delete is inferred — and inferring one that
    // does not exist would deny `cd src && git clean -fdx` for a `src/.claude` that is not
    // there and could not be reached.
    if (mustExist) { try { realpath(resolved); } catch { return null; } }
    // `.claude/` first, so a `.claude` inside a lead directory still earns the reason that
    // explains the credentials rather than the one that explains the state root.
    return claudeVerdict(resolved) ?? leadsVerdict(resolved, leadsRoots());
  };

  // No textual `command.includes('.claude')` shortcut, however tempting: `> decoy.json`
  // where `decoy.json` is a symlink into `.claude/` never mentions the directory at all,
  // and a prefilter like that would reintroduce the exact weakness `resolveTarget`
  // exists to remove. Only commands that actually name a write target pay for a syscall
  // — a plain `git status` yields nothing here and never touches the filesystem — and
  // the count is capped so ten thousand redirects cannot become ten thousand syscalls.
  //
  // **The cap is per generator, not over the concatenation.** As
  // `[...redirects, ...writers].slice(0, 256)` it was *ordered*, so 256 harmless redirect
  // targets consumed the entire budget before a single writer target was examined:
  // `true >/tmp/p0 … >/tmp/p255 ; tee <guard>` measured pad=255 → DENY, pad=**256 → ALLOW**,
  // pad=1000 → ALLOW. Each generator gets its own budget, so padding one cannot starve
  // another, and the ceiling on syscalls is 3×256 rather than 256.
  //
  // The third generator learned that lesson the hard way: `proxiedTargets` began life inside
  // `writerTargets`, sharing its budget, and `echo <255 tokens> | xargs rm ; tee <guard>`
  // measured pad=200 → DENY, pad=**255 → ALLOW**. A new source of targets needs a new
  // budget, not a share of an old one.
  //
  // **And the budget no longer ends the scan, which is what stops a fourth instance.** Two
  // rounds fixed this defect by adding a budget; neither made it unrepeatable, because "one
  // budget per source" is a rule about how the next author writes a generator and nothing
  // checks it. What is checked now is weaker and structural: past the cap the loop keeps
  // going with `textOnly`, so an exhausted budget costs only the `realpath` — never the
  // verdict on a path that spells `.claude` or a guard-file name outright. A source folded
  // into an existing generator can therefore no longer starve another into an ALLOW for any
  // vector in the acceptance set; the most it can lose is a target reached *only* through a
  // symlink from beyond position 256. Textual judging is pure string work over tokens the
  // tokenizer has already produced, so the scan stays linear in the command's length.
  //
  // That claim held for named targets and NOT for synthetic ones on the first attempt, which
  // is how this round produced the third instance of the defect it was closing — see the
  // ⚠ block on `TARGET_CAP` and the anchor test in `judge`.
  for (const gen of [redirectTargetsInPlan(scan, plan, cwd0), writerTargets(plan), proxiedTargets(plan)]) {
    let seen = 0;
    for (const { raw, cwd: dir, mustExist } of gen) {
      const verdict = judge(raw, dir, mustExist, ++seen > TARGET_CAP);
      if (!verdict) continue;
      // The guard file wins over anything else in the tree, so a command that touches
      // both gets the reason that explains the stakes. Returning here also saves the
      // remaining syscalls, which is why it is a `return` and not a rank.
      if (verdict.guardFile) return verdict;
      // Below the guard file, a leads hit outranks a plain `.claude/` one. Ranked rather than
      // last-wins so a command touching both does not take its message from generator order:
      // the state-root file is the OUTER layer — losing `settings.launch.json` is what disarms
      // the `.claude/` rule's own registration for every teammate spawned afterwards — so its
      // sentence is the more important of the two to put in front of the model. For two hits of
      // equal rank the verdict is identical, so which one is kept is unobservable. A state-root
      // hit ranks with a leads hit: both are the fleet's own machinery rather than a worktree's.
      const stateful = (x) => x.leads === true || x.stateRoot === true;
      if (hit === null || (stateful(verdict) && !stateful(hit))) hit = verdict;
    }
  }
  return hit;
}

/**
 * The two reasons, kept apart because a teammate that hits this rule should be able to
 * tell that it is not arbitrary. Neither names a path: they are rendered into the
 * model's context verbatim and the worktree is under the operator's home.
 */
/**
 * The third reason. Names no path, like the other two — it is rendered into the model's context
 * verbatim and `$SOMA_HOME` is usually the operator's home directory — and it says what the
 * directory *is* rather than merely refusing, because a lead or teammate that hits this rule
 * should be able to tell it is not arbitrary.
 *
 * It deliberately does not offer an alternative place to write. The other two reasons can point
 * somewhere useful ("ask the orchestrator", "`git clean -fd` does what you want"); here there is
 * nothing to redirect *to*, because the whole point is that this subtree has no writer in the
 * fleet other than the two processes that are not this session.
 */
const LEADS_DENY = 'soma: that path is under the fleet\'s per-lead control directory in the soma state root — the briefs, identities, budget and hold flags, and the settings and hook registrations every session in this fleet runs under. It is written by the spawner and the watchdog, never by a lead or a teammate: editing it changes the rules you are running under, and deleting a flag from it would clear a budget trip or a hold. If your task genuinely needs something changed there, ask the orchestrator.';

/**
 * The fourth reason: the state root directory named as a write target.
 *
 * It says what the act *does* rather than naming a rule, because the two commands that reach it
 * (`rm -rf $SOMA_HOME`, `chmod 000 $SOMA_HOME`) are almost never typed on purpose — and the one
 * spelling a model reaches by accident, `> $SOMA_HOME`, is a mistake for a path *inside* it, so
 * the sentence points there.
 */
const ROOT_DENY = 'soma: that is the soma state root directory itself — the whole fleet\'s task table, event bus, transcripts, lead control files and every teammate worktree live inside it. Deleting it, moving it or changing its mode takes the fleet down and disarms the budget breaker with it, and a redirect ONTO it either fails because it is a directory or replaces it with a regular file. You almost certainly meant a path inside it: write to a file at the top level of $SOMA_HOME instead.';

const GUARD_DENY = 'soma: .claude/settings.local.json is the file that keeps the operator\'s credentials — their MCP servers, database connections and authenticated connectors — out of reach of unattended agents. Rewriting it is never a step in a task. If you need a tool it denies, ask the orchestrator to allow it.';

/**
 * The fifth reason — arm (e), the cd-compound lever. Rendered to the model verbatim: no path, the
 * cause, what the build does with it, the two things to type instead, and the one shape of `cd`
 * that is fine, so the retry it costs is the LAST retry rather than the first of several.
 */
const CD_COMPOUND_DENY = 'soma: this Claude Code build stops on an unanswerable permission prompt when a `cd` is followed by grep/rg/diff/git/cp/mv on a relative path — leads have sat on that prompt for 40 hours. Your shell is already in your worktree. Re-run without the `cd`, or spell the operands as absolute paths (`grep -n x /abs/dir/file`, `git -C /abs/dir …`); a lone `cd <dir>` on its own is fine.';
const CLAUDE_DENY = 'soma: .claude/ configures the agent harness itself — the settings, hooks and permissions every session in this worktree runs under. Changing it changes the rules you are running under, so it is not yours to write. If your task genuinely needs a change there, ask the orchestrator. (If you were cleaning the worktree: .claude/ is git-ignored, so `git clean -fd` does what you want and `-x`/`-X` would delete the harness config with it.)';

/**
 * Is this call the lead's own? The one discriminator between a lead and its teammates, asked by
 * `evaluateGate` (arms b2, b3 and d) and by `budgetWarning` through this one function, so no two arms
 * can ever disagree about who the lead is. Its shape is argued in full by the comment inside, which
 * stays with the expression it explains.
 */
function isLeadSession(input, env) {
  // Who is calling. **The session id is the only answer, under either registration.**
  //
  // ⚠ THIS LINE USED TO READ `!sessionGuard || (…)`, AND THAT WAS THE BUILD'S SECOND
  // CRITICAL. The premise printed here was: "Without `--session-guard` this hook is
  // bound to the lead process alone (its own `--settings` file, which teammates do not
  // load), so everything it sees is the lead." **That sentence is false**, and it is the
  // same false sentence this build already measured three times and corrected at
  // `settings-gen.mjs` — `--settings` IS inherited by every split-pane teammate (see
  // `spawn.writeLaunchSettings`, and four real teammates' argv). Everywhere else it was
  // a comment; here it was the expression the discriminator was computed from, so
  // `isLead` was **constantly true** under the unflagged registration and arm (d) below
  // denied every teammate's `git commit`, `git push`, `tee`, `sed -i` and redirect —
  // the delivery path (MILESTONE per teammate commit, then the draft PR).
  //
  // It is fixed *here*, in the predicate, rather than by adding `sessionGuard &&` to the
  // one arm that consumed it, for three reasons. The flag says which registration is
  // running, never which process — so a flag-dependent `isLead` is a category error
  // whichever arm reads it, and the next arm added would inherit the same trap. The
  // lead's shell ban now rides every registration of the gate — the launch file's single
  // entry and the worktree file's — instead of only the flagged one. (The launch file
  // carried two byte-identical entries until `withTeammateGuard` learned to skip a twin
  // the base already has; the wording "BOTH registrations" dates from then.) And the
  // corpus below can go on driving the
  // unflagged path, which is the path that hid this.
  //
  // **Unknowable is not the lead.** Both ids must be present, non-empty and equal.
  // With `SOMA_LEAD_SESSION_UUID` unset nothing here bites — the gate fails open in the
  // direction of the lead writing code, silently, which `spawn.buildLeadEnv` declares
  // and arm (b) below already took. Guessing "lead" is the other direction, and that
  // guess is exactly what wedged the fleet.
  //
  // ⚠ **`sid !== ''` and `uuid !== ''` are each individually redundant, and the suite cannot
  // see you delete one.** Read as a pair, not as two checks: `sid === uuid` at the end means
  // the two ids are the same string, so ONE non-empty test already forces BOTH non-empty.
  // Delete either alone and the surviving one still does the whole job — measured over every
  // combination of `undefined`/`null`/`42`/`''`/`' '`/`'LEAD'`/`'OTHER'`/`0`/`false`/`{}`/`[]`
  // in both positions, **0 differing verdicts** for `-sid`, **0** for `-uuid`, and over 8064
  // whole-gate inputs likewise 0 apiece. The mutation harness is right to report those two as
  // SKIPPED (equivalent mutants) rather than SURVIVED; no test is missing and none can be
  // written, because the two variants and this line are the same function.
  //
  // Delete BOTH and `sid === uuid` is the only guard left, so `sid === '' && uuid === ''`
  // makes `isLead` **true**: a session that arrives with no `session_id` at all, in an
  // environment with no `SOMA_LEAD_SESSION_UUID`, is judged the lead — arm (b) takes its
  // Edit/Write/NotebookEdit and arm (d) takes its `git commit`, `git push`, `tee`, `sed -i`
  // and redirects. That is the two-registration wedge again, arriving through unknowability
  // instead of through a flag. Measured: 13 differing verdicts for the both-removed variant, the
  // only input class that differs being `['', '']`.
  //
  // So the hazard here is not a weak test, it is an **invisible half-step**: a maintainer who
  // tidies one of the two away gets a fully green suite and leaves a predicate ONE edit from
  // calling `['', '']` the lead, with nothing left to red when that edit lands. Both stay, and
  // they stay as a pair — if you ever have a reason to touch one, the other is not optional.
  const uuid = env?.SOMA_LEAD_SESSION_UUID;
  const sid = input?.session_id;
  return typeof sid === 'string' && sid !== '' && typeof uuid === 'string' && uuid !== '' && sid === uuid;
}

/**
 * The gate's whole decision, as data: `{}` to stay out of the way, or a deny with a
 * reason the model will read verbatim.
 *
 * Two injected windows onto the filesystem and no others: `flagExists`, which is the
 * only way it can learn that a budget is tripped, and `realpath`, which the `.claude/`
 * rule needs to see through a symlink. `flagExists` is **required** on the same grounds
 * as `leaseStale`'s `hasPane` — a caller that forgets it gets a TypeError (which the
 * runner turns into fail-open) rather than a gate that silently has no breaker —
 * while `realpath` is defaulted, because its default *is* the production behaviour and
 * forgetting it disables nothing.
 *
 * Reasons never carry a path. They are rendered into the lead's context exactly as
 * written, and `$SOMA_HOME` is the operator's home directory more often than not.
 */
export function evaluateGate(input, env, flagExists, realpath = realpathSync) {
  if (typeof flagExists !== 'function') {
    throw new TypeError('evaluateGate: flagExists must be a (path) => boolean predicate');
  }
  const tool = typeof input?.tool_name === 'string' ? input.tool_name : '';
  const home = stateRoot(env);
  const id = env?.SOMA_LEAD_NAME;

  // (a) The breaker, first and above every other rule — including the session
  // discriminator. In a worktree this reaches teammates too, and that is deliberate:
  // a lead's three teammates are most of what the budget was spent on, so a trip that
  // stopped only the lead would be a breaker with no teeth. The orchestrator
  // (`soma_clear_trip`) or the operator (`soma clear-trip`) can clear the flag, through
  // `wd/budget.clearTrip`, which grants one more allowance of the class in the same
  // transaction; the model cannot. So the reason asks for a clear the only way a tripped
  // lead still can, with a report: a NEEDS_INPUT that says how much more and why.
  if (typeof id === 'string' && LEAD_RE.test(id) && flagExists(join(home, 'leads', id, 'BUDGET_TRIPPED'))) {
    if (!BUS_TOOL.test(tool)) {
      return deny('soma: this task\'s budget is spent (BUDGET_TRIPPED). You may still talk and call soma_report — wind down now and file COMPLETED or ERROR with what exists. If the work needs more, file NEEDS_INPUT saying how much and why: the orchestrator or the operator can clear the trip, which grants one more allowance of this task\'s budget class.');
    }
    return {};
  }

  // Who is calling: `isLeadSession`, above, whose comment is the whole argument for its shape.
  // `budgetWarning` asks the same function, so the two can never disagree about the lead.
  const isLead = isLeadSession(input, env);

  // (b) — RETIRED. The session-discriminated edit ban lived here, switched on by a
  // `--session-guard` argument on the worktree registration. When the lead's edit surface
  // was lifted to match a teammate's, the arm decayed to `return {}` — byte-for-byte what
  // an edit tool gets by falling through to the end of this function — so the arm, its
  // `EDIT_TOOLS` set, the flag, and both emits (spawn's twin, settings-gen's worktree
  // registration) are gone. Registrations written before the retirement may still pass the
  // flag; unknown argv is ignored, which is also what keeps this hook forward-compatible
  // with its own past.

  /**
   * (b2) **The bus belongs to the lead, and to nothing else in the worktree.**
   *
   * MEASURED on the first real fleet: every lead reported
   * `No such tool available: mcp__soma__soma_task`. The bus was healthy — a direct
   * `tools/list` under the lead's exact env returned all three lead tools — and the cause was
   * `settings-gen`'s teammate-MCP deny list, which enumerates every server discoverable at
   * user scope and denies it by prefix. **`soma init` registers `soma` at user scope**, so the
   * generated `mcp__soma` rule denied soma's own bus, and the worktree's guard file is loaded
   * by the LEAD as well as by its teammates. The fleet could not report, checkpoint, or
   * re-orient. Neither half was wrong alone; nobody had connected them.
   *
   * The static deny could not be the answer, because **it cannot discriminate**: the lead and
   * its teammates share one cwd, so one file binds both. That is the same wall arm (d) hit for
   * Bash, and the same answer applies — the session id is the only discriminator, and this
   * hook is the only place that has it.
   *
   * **And the exposure this replaces is real, not theoretical.** Measured during the build on
   * claude 2.1.220, a teammate did not inherit `--mcp-config`/`--strict-mcp-config`, fell back
   * to normal discovery and mounted the *user-scope* bus, which carries no `SOMA_ROLE` and is
   * therefore a **candidate**: `soma_adopt` and `soma_status`, so a teammate could take the
   * orchestrator lease. On Claude Code 2.1.299 a teammate is launched with the lead's
   * `--mcp-config`, `--strict-mcp-config` and `--settings` instead, so it mounts the lead's own
   * bus, in the lead role, and could report as the lead. Either way the deny stays; it just
   * moves to where roles are distinguishable.
   *
   * Placed AFTER arm (a), which deliberately carves bus tools OUT of the budget breaker so a
   * tripped lead can still file COMPLETED or ERROR. A tripped lead returns `{}` there and
   * never reaches this arm, which is correct: the carve-out is for the lead, and the lead is
   * exactly who this arm allows.
   *
   * **It fails CLOSED, and that is the opposite of arm (d) on purpose.** Where the ids are
   * unusable, arm (d) allows — it exists so teammates keep their hands, and guessing "lead"
   * would take them. Here the tool under discussion can hand away the orchestrator lease, so an
   * unidentifiable caller is refused. That is safe rather than merely cautious: a real lead's
   * `SOMA_LEAD_SESSION_UUID` cannot be missing, because `buildLeadArgv` calls
   * `required(sessionUuid, …)` inside the same `launch()` that built the env, so an empty uuid
   * throws before `claude` starts.
   *
   * Both registrations evaluate this identically — with the `--session-guard` flag retired
   * there is nothing left for a registration argument to vary — so `deny(reg[0]) =
   * deny(reg[1])` holds by construction rather than by assertion.
   */
  if (BUS_TOOL.test(tool)) {
    return isLead
      ? {}
      : deny('soma: the soma bus belongs to the lead session. A teammate reaching it through user'
        + ' scope gets the CANDIDATE tool set, which carries soma_adopt — it could take the'
        + ' orchestrator lease out from under the operator. Report through the lead: finish your'
        + ' work, and the lead files soma_report.');
  }

  /**
   * (b3) **The lead's reasoning server belongs to the lead, and to a teammate only when the
   * operator hands it over.**
   *
   * MEASURED on a live fleet: the operator also had a `sequential-thinking` server at user
   * scope, so `settings-gen` wrote a bare `mcp__sequential-thinking` deny into every worktree
   * guard file, the lead loads that file, and a bare server deny matches by name — so every lead
   * lost the tool its standing orders make mandatory before a hard call. Same mechanism as the
   * bus in (b2), same fix: the enumeration no longer emits a deny for any server the lead's own
   * mcp.json serves, and the teammate half moves here, where the session id tells them apart.
   *
   * What a teammate would call is soma's own server: on Claude Code 2.1.299 a teammate is
   * launched with every `--mcp-config` the lead has, plus `--strict-mcp-config`, and the lead's
   * `--settings` (an in-process teammate shares the lead's connection outright). So this arm's
   * job is to keep that server lead-only, as the static deny did for every teammate before, and
   * to hand it to teammates exactly when it was handed before: when `teammate_mcp_allow` names
   * `sequential-thinking`. The spawner passes that list to every lead as
   * `SOMA_TEAMMATE_MCP_ALLOW` (`spawn.buildLeadEnv`), and teammates inherit the lead's
   * environment. Fails CLOSED on an unidentifiable session, as (b2) does, and never touches any
   * other server: those stay the settings file's business.
   *
   * "Teammate" here means a teammate in its own session. An in-process teammate (Claude Code's
   * built-in default `teammateMode`) carries the lead's session id, as the lead's subagents do,
   * so to this arm it is the lead and keeps the tool; the session id is all the gate can see.
   */
  if (REASONING_TOOL.test(tool) && !isLead && !teammateAllowed(env, REASONING_SERVER)) {
    return deny('soma: the sequential-thinking server in this worktree belongs to the lead session.'
      + ' A teammate gets it only when the operator lists sequential-thinking in teammate_mcp_allow.'
      + ' Reason the step through in your own words instead, or ask the lead to take the hard call.');
  }

  if (tool === 'Bash') {
    const cmd = typeof input?.tool_input?.command === 'string' ? input.tool_input.command : '';

    // (c) The `.claude/` ban, for EVERY session — the lead, its teammates, and anything
    // else that loads the worktree's guard file. Deliberately outside the `isLead`
    // discriminator below: that one exists so teammates keep their hands, and this is
    // the one file no hand in the fleet may touch, because writing it is how a teammate
    // lifts every other guard off itself.
    const guarded = claudeWrite(cmd, { cwd: typeof input?.cwd === 'string' ? input.cwd : undefined, env, realpath });
    if (guarded) {
      return deny(guarded.guardFile ? GUARD_DENY
        : guarded.leads ? LEADS_DENY
          : guarded.stateRoot ? ROOT_DENY : CLAUDE_DENY);
    }

    // (d) The lead's push/merge guard — all that remains of the old lead-only write-idiom
    // ban, now that a lead's shell-write surface has been lifted to match a teammate's.
    //
    // The rest of the arm is GONE on purpose: `git commit` and the other commit-producing /
    // worktree-destroying verbs, `tee`, `sed -i`, and redirects (inside OR outside
    // `$SOMA_HOME`) are how a teammate delivers, and a teammate was never subject to this
    // arm at all — so lifting them for the lead is exactly what makes lead == teammate. The
    // `.claude/`, `leads/` and state-root guards in arm (c) above still bind BOTH roles, so
    // the sensitive redirect targets stay closed regardless of this change.
    //
    // Only `git push` and `git merge` stay lead-denied, and `isLead` is still the whole
    // discriminator under BOTH registrations (a teammate is unaffected). Push/merge are also
    // denied fleet-wide by the worktree deny list (protected-branch push, `gh pr merge`), so
    // this is deliberately redundant defence on the one surface a lead keeps closed.
    //
    // ONE EXCEPTION, by the operator's ruling: the lead pushes its own branch. `soma-pr` needs
    // `soma/<id>` on `origin` and does not push it, and a lead that had to hand that one push to
    // a teammate mostly handed it to the operator instead. `ownBranchPush` is the whole of what
    // the command may be — one spelling family, one branch, one remote, no options beyond setting
    // the upstream — and three more conditions must hold, each checked only for a command that
    // already has that shape, so every other command costs nothing:
    //
    //   - The switch is on: `SOMA_LEAD_BRANCH_PUSH` is exactly `'1'`. `spawn.buildLeadEnv` sets it
    //     only when soma.json's `lead_branch_push` is exactly `true`, so its ABSENCE means off: a
    //     lead spawned before this existed, a fleet that set the key to `false`, and a typo all
    //     keep "the lead never pushes". It lives in the lead's environment, the same place and
    //     trust as `SOMA_LEAD_NAME`: the lead's own Bash cannot change what this hook inherits.
    //     (A flag FILE was tried first and refused in review: a subprocess, a `cd` before an
    //     `rm`, or a `chmod` on the directory removed or hid it, and a missing file read as on.)
    //   - The session's cwd is the lead's worktree root, `$SOMA_HOME/worktrees/<repo>/<id>`,
    //     compared by realpath (`atWorktreeRoot`). The command names `origin`, and `origin` is
    //     whatever repository the cwd belongs to: from a repository cloned inside the worktree,
    //     or any other the shell reaches, the same words push `soma/<id>` somewhere else.
    //     Measured on Claude Code 2.1.299: the hook's `cwd` follows a `cd` the lead ran in an
    //     earlier call, and a `cd` out of the project is reset before the next call. A
    //     subdirectory is refused too, since it may hold a repository of its own.
    //   - The id does not end in `-d` or `-f`. The worktree deny list's force and delete rules
    //     (`Bash(git push*-d)`, `Bash(git push*-f)`) refuse every push whose command ends that
    //     way, for every session — a declared over-reach — so no spelling of such a branch gets
    //     through, and saying so beats a bare "permission denied" after this gate let it pass.
    //
    // The settings deny list still binds this push like any other: protected branches, force and
    // delete stay refused for every session. What none of this sees is git config set by an
    // earlier command (`ownBranchPush` lists it): that is declared, not closed.
    if (isLead && LEAD_PUSH_MERGE.test(cmd)) {
      const branch = typeof id === 'string' && LEAD_RE.test(id) ? `soma/${id}` : 'soma/<id>';
      if (ownBranchPush(cmd, id)) {
        if (env?.SOMA_LEAD_BRANCH_PUSH !== '1') {
          return deny(`soma: leads may not push or merge through the shell, and this fleet has also turned off the lead's own-branch push (lead_branch_push is not true in soma.json, or this lead started before it was). Hand the push of ${branch} to a teammate.`);
        }
        if (!atWorktreeRoot(input?.cwd, home, id, realpath)) {
          return deny(`soma: leads may not push or merge through the shell, except ${branch} from the root of the lead's own worktree, where origin is the task's repository. Run the same command again from there, with no cd in front of it.`);
        }
        if (/-[df]$/.test(id)) {
          return deny(`soma: leads may not push or merge through the shell, and ${branch} cannot be pushed by anyone: the task id ends in -${id.slice(-1)}, and the worktree deny list refuses every git push whose command ends that way (its force and delete rules). File NEEDS_INPUT so the operator pushes it.`);
        }
        return {};
      }
      return deny(`soma: leads may not push or merge through the shell, with one exception: your own branch to origin, as a command of its own, from your worktree root, exactly \`git push -u origin ${branch}\`. Any other branch, remote, force, delete, tag refspec or chained push is refused, and so is every merge. Hand those to a teammate.`);
    }

    // (e) The cd-compound liveness lever — see the block above `cdCompoundAsks` for the
    // measurements. INERT unless `leads/<id>/CD_COMPOUND_ASKS` exists, for the lead AND its
    // teammates (36 of the 79 stalls were teammates), and LAST: the breaker, the bus and the
    // `.claude/`/`leads/` guards have all had their say by the time a command reaches here, so
    // this arm can only ever ADD a deny and never changes the reason those give. The predicate
    // runs before the flag is read, so a command with no `cd` in it never pays the syscall.
    // Everything here fails OPEN — no usable id, a throwing read, a mistyped (non-boolean) flag
    // reading — because a wrong deny costs a turn and a wrong silence costs what it costs today.
    if (typeof id === 'string' && LEAD_RE.test(id)) {
      let pulled = false;
      try {
        pulled = cdCompoundAsks(cmd) && flagExists(join(home, 'leads', id, CD_COMPOUND_FLAG)) === true;
      } catch {
        pulled = false;
      }
      if (pulled) return deny(CD_COMPOUND_DENY);
    }
  }

  return {};
}

/**
 * The 80% note, exactly as the lead will read it. Exported so the tests assert on the string
 * the lead sees rather than a paraphrase of it, as `lead-postcompact.mjs` does with `REORIENT`.
 *
 * It repeats the lead playbook's own instruction for this moment (stop starting work, land what
 * is verifiable, file NEEDS_INPUT or COMPLETED, say plainly what is unfinished), so the warning
 * and the rule it points at use the same words. No path, like every reason in this file.
 */
export const BUDGET_WARNING = 'soma: this task has used 80% of its budget (BUDGET at 80%). Stop starting new work: land what is verifiable, then file COMPLETED, or NEEDS_INPUT for what remains, and say plainly what is unfinished. At 100% the breaker trips and every tool except the soma bus is denied.';

/** The flag the watchdog writes at 80% (`wd/budget.mjs`'s `warnPath`), beside `BUDGET_TRIPPED`. */
const WARN_FLAG = 'BUDGET_WARNED';

/**
 * Job 5's decision: should this call carry the 80% note? `null`, or `{ flag, note }`, meaning
 * the flag the runner must claim and the note it prints only if that claim wins.
 *
 * Asked only about a call `evaluateGate` did not deny. A deny is emitted exactly as it always
 * was and carries no note, so the note never rides a refusal and a refused call never consumes
 * it. Beyond that it claims for one caller only: the LEAD, by the same `isLeadSession` the arms
 * above use (teammates never see or consume it), while `leads/<id>/BUDGET_WARNED` exists and
 * `BUDGET_TRIPPED` does not. A tripped lead's bus calls are allowed, so the trip is checked
 * again here: the breaker's reason has already told that lead more than this note would.
 *
 * The gate's discipline holds. `flagExists` is injected and required, a usable lead id is the
 * only thing that reaches the filesystem, and the note carries no path. Everything else fails
 * toward silence: a teammate is never probed, a warn reading that is truthy but not `true` is
 * no flag (`existsSync` answers a boolean), a truthy trip reading is a trip (arm a's own test),
 * and a probe that throws is no note. A missed note leaves the lead where it was before this
 * existed; a note nobody earned is noise. The warn flag is probed first because it is almost
 * always absent, so a lead's ordinary call pays one extra `existsSync` and a teammate's none.
 */
export function budgetWarning(input, env, flagExists) {
  if (typeof flagExists !== 'function') {
    throw new TypeError('budgetWarning: flagExists must be a (path) => boolean predicate');
  }
  const id = env?.SOMA_LEAD_NAME;
  if (typeof id !== 'string' || !LEAD_RE.test(id) || !isLeadSession(input, env)) return null;
  const dir = join(stateRoot(env), 'leads', id);
  const flag = join(dir, WARN_FLAG);
  try {
    if (flagExists(flag) !== true) return null;
    if (flagExists(join(dir, 'BUDGET_TRIPPED'))) return null;
  } catch {
    return null;
  }
  return { flag, note: BUDGET_WARNING };
}

// ---------------------------------------------------------------------------
// The standalone hook. Everything below is I/O; everything above is the decision.
// ---------------------------------------------------------------------------

/** How long to wait for a stdin that may never end. Overridable so a test can prove the deadline exists. */
const DEADLINE_MS = 5000;
const deadline = (env) => {
  const ms = Number(env?.SOMA_HOOK_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 60_000) : DEADLINE_MS;
};

/** Is this file the process entry point? `realpath` first, so a symlinked or relative argv still matches. */
function isMain(url) {
  try {
    return typeof process.argv[1] === 'string' && url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

/**
 * Read the hook JSON, hand it to `handle`, print whatever comes back, exit 0.
 *
 * Deliberately not shared between the four hooks. Each is an independent enforcement
 * surface launched by a different event, and a common helper would mean one bad edit
 * disarms all four at once — the plumbing is eight lines, the coupling is not worth it.
 *
 * Three details are load-bearing:
 * - **A deadline.** If the pipe is never closed, `end` never fires and the hook waits
 *   forever, freezing the tool call it was asked about. The timer is *not* unref'd:
 *   it firing is the point.
 * - **`process.exitCode`, never `process.exit()`.** stdout to a pipe is asynchronous,
 *   and `exit()` discards whatever has not drained — the documented deny JSON would be
 *   truncated into an unparseable fragment exactly when it mattered. Setting the code
 *   and letting the loop empty flushes it.
 * - **Nothing throws.** A parse failure is an empty input, a handler failure is no
 *   output, and an EPIPE from a reader that has already gone is not this hook's
 *   problem to report.
 */
function runHook(handle) {
  let raw = '';
  let settled = false;
  const finish = (payload) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    process.exitCode = 0;
    try {
      if (payload) process.stdout.write(JSON.stringify(payload));
    } catch { /* the reader is gone; the exit code is the rest of the answer */ }
    // Only does anything on the deadline path, where stdin is still open and would
    // otherwise hold the event loop past the answer we just gave.
    try { process.stdin.destroy(); } catch { /* already gone */ }
  };
  const timer = setTimeout(() => finish(null), deadline(process.env));
  process.stdout.on('error', () => {});
  process.stdin.on('error', () => finish(null));
  process.stdin.setEncoding('utf8'); // a StringDecoder, so a multi-byte char split across chunks survives
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      input = {};
    }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) input = {};
    let payload = null;
    try {
      payload = handle(input);
    } catch {
      payload = null; // fail-open
    }
    finish(payload);
  });
}

/**
 * Claim the 80% flag: true for the one process whose rename moved it, false for every other.
 *
 * The rename IS the claim, and it is atomic. More than one registration of this gate can fire
 * on the same call, and only one of them can move a file that exists once; the others get
 * ENOENT and print nothing, as today. It is renamed rather than unlinked so the delivery leaves
 * a record, `BUDGET_WARNED.delivered`, for whoever reads `leads/<id>/` later. Any other error
 * is the same silence: the gate never fails a call over a note.
 */
function claimWarning(flag) {
  try {
    renameSync(flag, `${flag}.delivered`);
    return true;
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  runHook((input) => {
    const decision = evaluateGate(input, process.env, existsSync);
    if (decision?.permissionDecision === 'deny') {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision } };
    }
    // Not denied, so this call may carry the 80% note: `additionalContext` alone, and NO
    // `permissionDecision` key, because an allow would bypass the operator's permission rules.
    const claim = budgetWarning(input, process.env, existsSync);
    return claim && claimWarning(claim.flag)
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: claim.note } }
      : null;
  });
}
