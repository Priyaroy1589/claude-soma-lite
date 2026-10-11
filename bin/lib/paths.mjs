/**
 * Path helpers — the single place that knows where soma's state lives, and the single
 * place that knows where *Claude Code's own* state lives (`claudeConfigRoot`).
 *
 * Every runtime path derives from these functions, and every one is built with
 * `path.join` so the same layout works on macOS, Linux and WSL. The environment
 * is read lazily on each call, so retargeting the state root (as the tests do)
 * needs no module reload.
 *
 * The invariant that makes a fleet possible at all: the state root is a function of
 * `$SOMA_HOME` and nothing else. Never of the cwd — see `SOMA_HOME()`. Processes that
 * disagree about where state lives do not fail, they fork, and a forked root is what
 * turns a lock into a formality and a heartbeat into a file nobody reads.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';

/** The fixed subdir set `ensureTree()` guarantees under the state root. */
const SUBDIRS = ['state', 'events', 'heartbeats', 'leads', 'logs', 'worktrees', 'digests'];

/**
 * What an operator reads when `$SOMA_HOME` is relative. The whole diagnosis lives in
 * the message because the message is all that survives: this refusal is a backstop that
 * a correct launch never reaches, so when it does fire it fires somewhere inconvenient
 * (the first line of a stack trace from inside a watchdog tick), with no second chance
 * to explain itself. `soma up` and `ensureTree()` are where an operator is *meant* to
 * meet it, and they print this same sentence.
 *
 * `raw` is echoed back because recognising their own typo is the fastest route from
 * "something is wrong" to "I know what to change"; nothing else from the environment is
 * interpolated.
 */
const relativeHome = (raw) =>
  new Error(
    `SOMA_HOME must be an absolute path (got ${JSON.stringify(raw)}) — a relative one is ` +
    `resolved against each process's own cwd, so the watchdog, the gate hook and every ` +
    `soma command would agree on the spelling and silently disagree on the directory: ` +
    `heartbeats no reader looks at (every healthy lead reads as stalled), a BUDGET_TRIPPED ` +
    `flag the gate never finds, a fleet.lock that excludes nobody, and two orchestrators ` +
    `each holding "the" single-holder lease. Set an absolute path, or leave SOMA_HOME ` +
    `empty/unset for the default ${join(homedir(), '.soma')}. A leading "~" is expanded by ` +
    `your shell only when unquoted, and is not absolute on its own — spell the path out.`,
  );

/**
 * Absolute path of the state root: `$SOMA_HOME` when set, else `$HOME/.soma`.
 *
 * `||` rather than `??` is load-bearing: `soma up` hands the watchdog
 * `SOMA_HOME: process.env.SOMA_HOME || ''`, and an empty string has to fall back
 * to the default root instead of resolving every path relative to the cwd.
 *
 * The guard is therefore **reject non-empty non-absolute**, never "require absolute":
 * `raw &&` is the same truthiness test as the `||` below, so the one predicate that
 * decides "the operator set a root" is written once and the two cannot drift apart.
 * An `isAbsolute` precondition instead of this would refuse the shipped launch path.
 *
 * Refusing rather than resolving is the whole point. `resolve()` on a relative value
 * used to stand where the guard now does, and it was the bug, not the fix: it answers
 * with *an* absolute path — the caller's cwd joined to the fragment — so two processes
 * started from two directories both get a well-formed root, both are right by their own
 * lights, and the roots differ. Every downstream path then looks perfect and nothing
 * errors anywhere; the split only shows up as a fleet tearing down its own working
 * leads. Being visibly relative was strictly safer than being confidently wrong.
 *
 * `resolve()` stays, demoted to what it can honestly do: normalisation. Its input is
 * now always absolute (`homedir()` is), so it never consults the cwd, and it collapses
 * `//`, `/./`, `/../` and a trailing slash — which is what makes `/x/soma/` and
 * `/x/soma` the *same* root rather than two spellings of it.
 *
 * The refusal is total and early by design: every helper below funnels through here, so
 * a relative root cannot half-work. There is no interleaving in which some paths land
 * correctly and others throw, and the answer never depends on who called first.
 */
export const SOMA_HOME = () => {
  const raw = process.env.SOMA_HOME;
  if (raw && !isAbsolute(raw)) throw relativeHome(raw);
  return resolve(raw || join(homedir(), '.soma'));
};

/**
 * Absolute path of *Claude Code's* config root: `$CLAUDE_CONFIG_DIR` when set, else
 * `$HOME/.claude`.
 *
 * **This function is canonical.** Every soma module that reads or writes Claude Code's
 * own state — session transcripts under `projects/<slug>/<uuid>.jsonl`, the trust marks
 * and MCP server list in `.claude.json` — must resolve through here and must not
 * re-derive `~/.claude` for itself. Two modules (`pretrust.mjs`, `settings-gen.mjs`)
 * were written against a hard-coded `~/.claude` and carry temporary local copies of this
 * rule; they collapse onto this function.
 *
 * Getting it wrong is not a crash, it is *silence*, and that is why the rule lives in one
 * place. On a machine where `CLAUDE_CONFIG_DIR` is set, a stale `~/.claude/projects`
 * usually still exists from before it was set — so `join(homedir(), '.claude')` finds a
 * real directory, throws no ENOENT, finds no matching session uuid inside it, and reports
 * zero tokens for every lead. The watchdog's budget breaker then never trips and the
 * fleet has no spend control at all, with nothing in any log to say so.
 *
 * Verified behaviourally against claude 2.1.220 on 2026-07-30: a run under
 * `CLAUDE_CONFIG_DIR=<tmp>` wrote its transcript to `<tmp>/projects/<slug>/<uuid>.jsonl`
 * and created `<tmp>/.claude.json`, while neither `~/.claude/projects` nor
 * `~/.claude-work/projects` gained anything for that cwd.
 *
 * `||` rather than `??` for the same reason as `SOMA_HOME()` above: an env var forwarded
 * as `''` has to fall back to the default root instead of resolving against the cwd.
 * `resolve()` for the same reason too — a relative `$CLAUDE_CONFIG_DIR` would make every
 * transcript lookup depend on the cwd of whoever asked, and the watchdog's cwd is not the
 * lead's. A relative value is resolved rather than refused because the one caller that
 * matters is a watchdog tick, which must degrade rather than throw.
 *
 * `env` is a parameter, not a closure over `process.env`, so a caller can resolve paths
 * for the environment it is about to *hand a lead* rather than the one it is running in.
 *
 * ---
 * THE TWO ROOT RESOLVERS IN THIS FILE TAKE OPPOSITE POLICIES ON A RELATIVE VALUE, AND
 * THAT IS DELIBERATE. DO NOT UNIFY THEM.
 *
 * `SOMA_HOME()` above **refuses** a relative value. `claudeConfigRoot()` **resolves** one.
 * The asymmetry is not an oversight, it is a blast-radius judgement:
 *
 *   - A forked *soma* state root splits TEN paths at once, including `state/fleet.json`
 *     **and the lock beside it** — so two processes take the mutex on different files and
 *     mutual exclusion simply stops existing — plus the orchestrator lease, so two sessions
 *     each believe they hold a single-holder lease. Every one of those paths comes out
 *     absolute and plausible, so nothing errors; the only symptom is a fleet tearing down
 *     its own working leads. Refusing is the only thing that closes that class.
 *   - A forked *Claude Code* config root costs the reader a wrong answer on one lookup, and
 *     its one caller that matters is a watchdog tick that must degrade rather than throw.
 *
 * `bin/lib/pretrust.mjs` carries the third instance of this decision and states the same
 * contrast; if you change one of the three, read all three first.
 */
export const claudeConfigRoot = (env = process.env) =>
  resolve(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));

/** Join `segments` under the state root. */
export const p = (...segments) => join(SOMA_HOME(), ...segments);

/**
 * Create the state root and its fixed subdirs. Idempotent — safe on every run.
 *
 * The root is read once, up front, and that is deliberate on two counts. It is the
 * earliest point any soma process touches this module — `soma up` and `soma init` both
 * call it before anything else — so it is where a relative `$SOMA_HOME` gets reported:
 * once, with a clean stack, before the first `mkdir`, instead of nine frames deep in a
 * later tick. And pinning the root for the whole loop means a concurrent mutation of
 * `process.env` cannot scatter the seven subdirs across two roots.
 *
 * It throws rather than exiting: a library that killed the process would be untestable
 * and would take the test runner with it. Turning that throw into one stderr line and a
 * non-zero exit is the CLI's job — see `soma up`.
 */
export const ensureTree = () => {
  const root = SOMA_HOME();
  for (const d of SUBDIRS) mkdirSync(join(root, d), { recursive: true });
};

/**
 * Per-lead control dir: meta.json, mcp.json, settings.json, brief.md, HOLD, BUDGET_TRIPPED.
 * `meta.json` is the spawner's record of a launch (the commit the worktree was cut from, its
 * branch and path, the session uuid), written by each spawn and never by a resume.
 */
export const leadDir = (id) => p('leads', id);

/** Worktree checkout for one task: `worktrees/<repo>/<id>`. */
export const worktreeDir = (repo, id) => p('worktrees', repo, id);

/** pipe-pane transcript for one lead: `logs/<id>.log`. */
export const logPath = (id) => p('logs', `${id}.log`);
