/**
 * tmux wrappers — every OS call soma makes, in one place.
 *
 * tmux is three things at once here: the supervisor that owns each lead
 * process, the display `soma attach` connects to, and the wake channel the bus
 * types into. Keeping every invocation in this module means the socket name,
 * the argument shapes and the two-call send-keys dance are decided once.
 *
 * Every function takes an optional `run` — `(args) => ({ stdout, code })`,
 * where `args` follows `tmux -L soma` — so tests record argument vectors
 * without a tmux server, and a future transport (ssh, a remote host) can be
 * dropped in without touching the callers. The default `run` adds a `stderr`
 * field. Two readers look at it — `newSession`'s refusal and `serverAbsent` —
 * and a stub that omits it still works everywhere: `serverAbsent` then never
 * reads "no server", which is its safe answer.
 */
import { execFileSync } from 'node:child_process';

/**
 * Private server: soma's sessions never mix with the operator's own tmux.
 *
 * ⚠ **THE SENTENCE THAT USED TO END THIS COMMENT — "nothing in production sets it" — IS FALSE.**
 * It was true when written and stopped being true the first time one operator ran two fleets:
 * a work fleet on the default socket and a personal fleet on `soma_pers`, separated by exactly
 * this variable. The override is a production mechanism, not only a test seam, and reading it
 * as a test seam is what let `soma init` ship without pinning it into the bus registration —
 * so a re-run of `init` dropped the personal fleet's socket and its wake keystrokes would have
 * landed on a WORK lead's pane, addressed by a pane id from another server.
 */
const SOCKET = process.env.SOMA_TMUX_SOCKET || 'soma';

/**
 * The socket this process talks to, exported so callers pin the SAME value rather than
 * re-deriving it.
 *
 * There were already two spellings of this resolution (here, and `bus-tools`' `socket()`,
 * which reads an injected `env` because a bus is handed its context rather than owning it).
 * A third, in `soma.mjs`, is what this export exists to prevent: the value `init` writes into
 * the registration has to be the value this module's own `tmuxArgs` will use, or the pin
 * records a socket nobody talks to.
 */
export const socketName = () => SOCKET;

/** The full argv tmux is invoked with — exported so the socket is assertable. */
export const tmuxArgs = (args) => ['-L', SOCKET, ...args];

/** A wedged tmux must not block the synchronous watchdog loop forever. */
const TIMEOUT_MS = 5000;

/**
 * Run `tmux -L soma <args>`, reporting the exit code instead of throwing.
 *
 * A nonzero exit is ordinary control flow here — `has-session` on a lead that
 * died is the fleet's main liveness probe — so execFileSync's throw is mapped
 * back to `{ code }`. stderr is captured rather than inherited: the watchdog
 * probes every tick, and tmux's "can't find session" would otherwise scroll
 * past the operator forever. Callers that need the reason (newSession,
 * serverAbsent) read it off the returned object.
 *
 * `timeout` is a parameter only so the tests can prove the hang path cheaply;
 * every caller takes the default.
 */
export const defaultRun = (args, { timeout = TIMEOUT_MS } = {}) => {
  try {
    const stdout = execFileSync('tmux', tmuxArgs(args), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      killSignal: 'SIGKILL',
    });
    return { stdout, stderr: '', code: 0 };
  } catch (e) {
    // `status` is null when a signal killed tmux — which is how the timeout
    // above surfaces — and undefined when the binary is missing altogether;
    // both are failures, so they collapse to 1. A signal leaves no stderr, so
    // say what happened instead of throwing an empty reason at the operator.
    const stderr = e.stderr?.toString() || (e.signal ? `tmux killed by ${e.signal} after ${timeout}ms` : '');
    return { stdout: e.stdout?.toString() || '', stderr, code: e.status ?? 1 };
  }
};

/**
 * Target builders. tmux resolves a bare `-t <name>` by exact match, then
 * *unambiguous prefix*, then fnmatch — so with leads `lead-cr-1` … `lead-cr-10`
 * a bare `-t lead-cr-1` still resolves to `lead-cr-10` once cr-1 has died, and
 * the fleet kills, wakes and liveness-checks the wrong lead. An `=` prefix
 * forces exact matching, but the three target *kinds* need different forms
 * (verified on tmux 3.6a):
 *
 *   session  `=name`   has-session, kill-session, list-panes -s
 *   window   `=name:`  set-option            (`=name` -> "no such window")
 *   pane     `=name:`  send-keys, capture-pane, pipe-pane
 *                      (`=name` -> "can't find pane"; `=name:` is the window's
 *                       active pane, which is the lead's only pane)
 */
const sessionTarget = (name) => `=${name}`;
const windowTarget = (name) => `=${name}:`;
const paneTarget = (target) =>
  // `%12` is already a unique pane id (this is what $TMUX_PANE, and so the
  // lease's tmux_pane, holds) and an explicit `session:window.pane` spec only
  // needs the `=`; a session name needs the `:` to mean "its active pane".
  target.startsWith('%') ? target : target.includes(':') ? `=${target}` : `=${target}:`;

/**
 * Quote one word for the `/bin/sh` tmux runs a pipe-pane command in.
 *
 * Single quotes, so nothing in a path is expanded, and an embedded quote is
 * closed-escaped-reopened the POSIX way (`'` -> `'\''`). Without this a
 * SOMA_HOME containing a space turns the redirect into "ambiguous redirect"
 * and the lead runs with no transcript at all — silently, since pipe-pane
 * itself still succeeds.
 */
const shQuote = (word) => `'${word.replaceAll("'", "'\\''")}'`;

/**
 * Escape a word against tmux's own expansion, which runs *before* anything
 * else sees it. Two variants, because the two places soma hands tmux a path
 * expand differently — both verified on 3.6a, and both failing silently with
 * exit 0:
 *
 *   pipe-pane's shell command — full format + strftime. `#H` becomes the
 *   hostname and `%Y` the year, so the transcript lands somewhere else.
 *   Double both.
 *
 *   `new-session -c <cwd>` — `#` sequences only, no strftime. An unescaped `#`
 *   sends the lead to $HOME instead of its worktree; doubling `%` there is
 *   *worse* than leaving it alone, because `%%` is not collapsed back, the
 *   path stops existing, and the lead lands in $HOME anyway. Double `#` alone.
 *
 * (The command argv itself is not expanded — verified — so a brief full of
 * markdown `#` headings passes through untouched.)
 */
const tmuxFormatEscape = (word) => word.replaceAll('#', '##').replaceAll('%', '%%');
const tmuxHashEscape = (word) => word.replaceAll('#', '##');

/** True when a session by exactly this name exists on the soma server. */
export const hasSession = (name, run = defaultRun) => run(['has-session', '-t', sessionTarget(name)]).code === 0;

/** Every live session name — exact strings. See `liveSessions` before using this as liveness. */
export const listSessions = (run = defaultRun) =>
  run(['list-sessions', '-F', '#{session_name}']).stdout.split('\n').filter(Boolean);

/**
 * Sessions with at least one **live pane** — the watchdog's `aliveSessions` — or `null` when
 * tmux could not be read at all.
 *
 * **A session name is not liveness in soma, and that is by design.** `setRemainOnExit` keeps a
 * dead lead's pane and its session alive on purpose: that pane *is* the death scene the
 * watchdog reads and `soma peek` shows. So `hasSession('lead-cr-1')` and `listSessions()` both
 * report a lead that died in its first minute as present, and a reconciler built on either
 * finds no dead leads *ever* — no LEAD_DEAD, no revival, and the slot held until a human
 * notices. The pane's `#{pane_dead}` is the only thing that distinguishes the two states.
 *
 * One round trip per tick, not one per lead: `list-panes -a` enumerates every pane on the
 * server, which is also the form `soma-bus.mjs`'s `hasPane` established as correct for pane
 * questions (an exit code cannot answer them — `display-message -p -t '%99999'` exits 0 by
 * falling back to the default target, and `has-session -t '=%0'` exits 1 for a *live* pane).
 *
 * **Two failure directions, and they are not symmetric.**
 *
 * - Reading a live lead as *dead* makes the tick emit LEAD_DEAD, kill its session and respawn
 *   over work in progress. Unrecoverable.
 * - Reading a dead lead as *alive* costs one tick of revival latency.
 *
 * So every ambiguity resolves toward alive: only the exact string `1` counts as dead, a row
 * with no separator is skipped rather than attributed to a session named after its whole text,
 * and **a non-zero exit answers `null` rather than an empty Set.** That last one is the
 * important one. A wedged tmux hits the 5 s timeout in `defaultRun`, which reports
 * `{stdout: '', code: 1}` — byte-identical to a healthy server with nothing on it. Read as "no
 * sessions", one hiccup makes all ten spawned rows look dead in the same tick. `null` means
 * "not measured", and the tick's answer to that is to skip reconcile and revival for one tick.
 *
 * A live tick that genuinely sees no tmux server is close to a contradiction — the watchdog
 * itself runs in a tmux session, so it would have died with the server — which is why "no
 * server running" is folded into the same `null` rather than sniffed out of stderr. There is no
 * string matching here on purpose: the timeout message is one soma synthesises and the
 * no-server message is tmux's, and a predicate that told them apart by wording would be one
 * release away from being wrong in the destructive direction.
 *
 * The CLI's human reports do tell "no server" apart — a machine that has never run `soma up`
 * should read as having no watchdog, not as an unreadable tmux — and they do it by asking
 * `serverAbsent` about this function's `null`. Outside it, on purpose: neither of tmux's two
 * no-server sentences proves that no server exists (see there), and in here the wrong answer is
 * the destructive one.
 *
 * A `Set`, never an object keyed by session name: `reconcile` requires `.has` for exactly the
 * reason its own header gives — an object registry answers truthy for every `Object.prototype`
 * key, and task ids may legally be `constructor`.
 */
export function liveSessions(run = defaultRun) {
  const r = run(['list-panes', '-a', '-F', '#{session_name}\t#{pane_dead}']);
  if (r.code !== 0) return null;
  const live = new Set();
  for (const line of String(r.stdout ?? '').split('\n')) {
    if (line === '') continue;
    // The LAST tab separates the fields: a session name may contain one, and truncating at
    // the first would name a session nobody has *and* drop the real one from the live set —
    // which reads as a dead lead. Same rejoin-rather-than-truncate rule as `listPanes`.
    const cut = line.lastIndexOf('\t');
    if (cut === -1) continue;   // unattributable to any session, so it corroborates nothing
    if (line.slice(cut + 1) !== '1') live.add(line.slice(0, cut));
  }
  return live;
}

/** The listing `paneStates` reads. Title LAST, because it may contain tabs and is rejoined. */
export const PANE_STATES_FORMAT = '#{session_name}\t#{pane_id}\t#{pane_active}\t#{pane_dead}\t#{pane_pid}\t#{pane_current_command}\t#{pane_title}';

/**
 * What every session's pane is RUNNING — the pane census's read — or `null` when tmux could not
 * be read at all. `Map<sessionName, {dead, cmd, pid, title, pane_id, active, panes}>`.
 *
 * Beside `liveSessions`, never instead of it: that one answers "is any pane in this session
 * live?" for reconcile, and its Set-of-names contract is read at six call sites. This one answers
 * the question `liveSessions` cannot — a pane whose `claude` exited into a shell has
 * `pane_dead=0`, so it is *alive* to `liveSessions` and invisible to reconcile, which is how two
 * leads sat unseen as bare `zsh` panes for five days after tmux-resurrect restored them.
 * `pane_current_command` is what tells them apart, and it is worth knowing what it says (measured,
 * tmux 3.6a): a live Claude Code reads its VERSION STRING (`2.1.263`, the basename of the symlink
 * target — not `claude`); a bare shell reads `zsh`; a dead pane reads `env` (argv[0] of the spawn
 * command) with `pane_dead=1`. So the consumer (`wd/pane-state.mjs`) matches shells positively and
 * treats everything else unknown as unrecognised rather than dead.
 *
 * One round trip per tick (measured p50 3.9 ms), and the same failure contract as `liveSessions`,
 * for the same reason: a non-zero exit answers `null`, never an empty Map, because a wedged
 * server's 5 s timeout is byte-identical to an idle one and an empty Map read as "every lead
 * absent" would let one hiccup mark ten live leads dead in a tick. Only the literal `1` is dead.
 *
 * A session with several panes (a teammate split into the lead's window) is collapsed to its
 * ACTIVE pane for the top-level fields, because `capturePane('=name:')` reads the active pane —
 * so the metadata and the frame a classifier is handed describe the same pane by construction.
 * Every pane still rides along in `panes`, so a `%N` pane id (the orchestrator's lease records
 * one) can be found whether or not it is active. Session name FIRST and split on the first tab:
 * soma's own names (`lead-<id>`, `orch`, `soma-watchdog`) cannot carry a tab, and a foreign one
 * that does misparses into an entry nobody looks up; a row with too few fields is skipped.
 */
export function paneStates(run = defaultRun) {
  const r = run(['list-panes', '-a', '-F', PANE_STATES_FORMAT]);
  if (r.code !== 0) return null;
  const out = new Map();
  for (const line of String(r.stdout ?? '').split('\n')) {
    if (line === '') continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;                // unattributable: corroborates nothing
    const [session, pane_id, active, dead, pid, cmd, ...title] = parts;
    const pane = {
      pane_id,
      active: active === '1',
      dead: dead === '1',
      cmd,
      pid: /^\d+$/.test(pid) ? Number(pid) : null,
      title: title.join('\t'),
    };
    const rec = out.get(session);
    if (rec === undefined) {
      out.set(session, { dead: pane.dead, cmd: pane.cmd, pid: pane.pid, title: pane.title, pane_id, active: pane.active, panes: [pane] });
    } else {
      rec.panes.push(pane);
      // The first row stands in until an active pane is seen; tmux always flags one.
      if (pane.active && !rec.active) {
        Object.assign(rec, { dead: pane.dead, cmd: pane.cmd, pid: pane.pid, title: pane.title, pane_id, active: true });
      }
    }
  }
  return out;
}

/**
 * tmux's own two sentences for "no server answers on this socket", as its client prints them
 * (measured, tmux 3.6a, both exit 1). A connect to a socket FILE that does not exist is ENOENT:
 * `error connecting to <path> (No such file or directory)` — the machine that never started the
 * server. A connect to a socket file nobody accepts on is ECONNREFUSED: `no server running on
 * <path>` — the server that kill-server or its last session's exit took away, because neither
 * unlinks the file. Anchored at both ends against the whole trimmed stderr, so a second line, or
 * any other errno (`(Permission denied)`), is not a match.
 */
const NO_SERVER = [/^no server running on .+$/, /^error connecting to .+ \(No such file or directory\)$/];

/**
 * True when tmux could not be read BECAUSE, in tmux's own words, no server answers on soma's
 * socket — asked with a probe that cannot start one (`list-sessions`; never `new-session`, which
 * would bring up the very server it was asked about). False for everything else, a server that
 * answered included: the timeout `defaultRun` synthesises, the empty stderr of a missing binary, a
 * permission error, any other text. The words must arrive on stderr, with a non-zero exit.
 *
 * **Beside `liveSessions` and `paneStates`, never inside them, and never in reconcile.** Their
 * `null` is the watchdog's "skip this tick", and that is the right answer to both sentences there,
 * because neither one proves that no server exists:
 *
 * - ENOENT says only that the socket FILE is missing, which is also what a LIVE server looks like
 *   after a /tmp cleaner has deleted its socket. Measured: the server and its sessions stay alive,
 *   unreachable, until SIGUSR1 makes it recreate the socket (as tmux(1) documents).
 * - ECONNREFUSED is also what a LIVE but wedged server answers on macOS once its accept queue
 *   overflows. Measured: a stopped server and a few hundred timed-out clients, and the next probe
 *   read `no server running on …` with the server still alive behind it.
 *
 * Read as an empty Set, either one makes every live lead dead in one tick: LEAD_DEAD, a respawn
 * whose `new-session` starts a FRESH server on the same path, and two leads on one worktree.
 * Skipping the tick costs one tick.
 *
 * The CLI's human reports may ask, and only about a `null`: `soma status` reads "no server" as an
 * absent watchdog and an empty server, and `soma down` as "no session was running", exit 0 — where
 * a machine that had never run `soma up` used to read `unverified`, and `down` exited 3 on it.
 * Neither writes anything on the answer, and in either state above both are simply wrong — a
 * declared residual, RUNBOOK §11.10. `soma kill` does not ask: its answer to an absence is a
 * `failed` row, and over a live lead in either state that is the destructive case `stopper` in
 * soma.mjs exists to refuse.
 *
 * Matching tmux's wording is what `liveSessions`' header refuses to do, and the refusal stands
 * there. Here a tmux release that rewords either sentence only turns this answer false, and the
 * CLI falls back to `unverified`, which is where it was before.
 */
export function serverAbsent(run = defaultRun) {
  const r = run(['list-sessions', '-F', '#{session_name}']);
  if (r.code === 0) return false;
  const said = String(r.stderr ?? '').trim();
  return NO_SERVER.some((re) => re.test(said));
}

/**
 * Create a detached session running `argv`, transcript piped to `logPath`.
 *
 * Two load-bearing choices. The command is prefixed with `env -i` plus an
 * explicit allowlist rather than passed through tmux's `-e`: `-e` adds to
 * whatever environment the tmux *server* was born with, so a lead would
 * inherit the operator's exported API keys; `env -i` starts from nothing and
 * the caller says exactly what survives. And pipe-pane rides the same
 * invocation behind tmux's `;` command separator, so the transcript starts at
 * the session's first byte instead of a race later.
 */
export function newSession({ name, cwd, env, argv, logPath }, run = defaultRun) {
  // `env -i` clears PATH too, so without one in the allowlist env(1) cannot
  // resolve `claude` — and tmux still exits 0, leaving a session whose pane
  // died instantly: the lead reads as alive and never starts. Refuse early.
  if (!env?.PATH) throw new Error(`tmux new-session refused for ${name}: env.PATH is required, or env -i leaves ${argv?.[0] ?? 'the command'} unresolvable`);
  const envPrefix = ['env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`)];
  const args = ['new-session', '-d', '-s', name, '-c', tmuxHashEscape(cwd), ...envPrefix, ...argv,
    ';', 'pipe-pane', '-O', '-o', '-t', paneTarget(name), `cat >> ${shQuote(tmuxFormatEscape(logPath))}`];
  const r = run(args);
  if (r.code !== 0) throw new Error(`tmux new-session failed (${r.code}): ${(r.stderr || r.stdout || '').trim()}`);
}

/**
 * Type `text` into a pane and submit it. Returns whether the wake landed.
 *
 * Two calls, never one: `-l` sends the text literally, so a message like
 * `[soma] ping` cannot be parsed as key names, and Enter is a separate
 * keypress — `send-keys -l 'text' Enter` would type the word "Enter". `--`
 * ends the flags, or a message that happens to start with `-` is read as one
 * ("unknown flag -h") and the wake is silently dropped. The Enter is withheld
 * when the literal send failed, because a bare Enter into a live pane submits
 * whatever is already sitting in its composer.
 */
export function sendKeys(target, text, run = defaultRun) {
  // The lease records `tmux_pane: null` for a notify-mode holder and the bus
  // forwards it straight here, so a missing target is a routine state, not a
  // programming error: report "not delivered" instead of taking the
  // orchestrator down with a TypeError inside paneTarget.
  if (!target) return false;
  const pane = paneTarget(target);
  if (run(['send-keys', '-t', pane, '-l', '--', text]).code !== 0) return false;
  return run(['send-keys', '-t', pane, 'Enter']).code === 0;
}

/**
 * The last `lines` lines of content visible in a pane (no scrollback: this is
 * for peeking at a lead and scraping its session URL, not for archaeology —
 * that is what the pipe-pane transcript is for).
 */
export function capturePane(target, lines = 40, run = defaultRun) {
  if (!target) return '';                        // same reason as sendKeys: a null pane is a state, not a fault
  // capture-pane returns the pane's full height, blank-padded: a lead two lines
  // into an 80x24 pane yields 22 empty rows, so an unstripped tail is 40 blank
  // lines and the death scene reads as whitespace. Drop the padding first.
  const all = run(['capture-pane', '-p', '-t', paneTarget(target)]).stdout.replace(/\n+$/, '').split('\n');
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

/** Kill a session and everything in it. Returns whether tmux found it. */
export const killSession = (name, run = defaultRun) => run(['kill-session', '-t', sessionTarget(name)]).code === 0;

/**
 * Keep a pane and its scrollback after the process exits — the death scene the
 * watchdog reads. tmux stores this at window scope, so it also covers panes
 * split into the lead's window later (teammates).
 */
export const setRemainOnExit = (name, run = defaultRun) =>
  run(['set-option', '-t', windowTarget(name), 'remain-on-exit', 'on']).code === 0;

/** Every pane in a session: `{index, dead, title}`. */
export function listPanes(session, run = defaultRun) {
  const out = run(['list-panes', '-s', '-t', sessionTarget(session), '-F', '#{pane_index}\t#{pane_dead}\t#{pane_title}']).stdout;
  return out.split('\n').filter(Boolean).map((l) => {
    // A pane title can contain tabs, so everything past the second field is
    // title — rejoined rather than truncated.
    const [index, dead, ...title] = l.split('\t');
    return { index: Number(index), dead: dead === '1', title: title.join('\t') };
  });
}
