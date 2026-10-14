/**
 * `soma watch` — one stdout line per fleet event that needs the orchestrator, written for Claude
 * Code's Monitor tool, which turns every stdout line of a command into a wake.
 *
 * The bus already wakes the orchestrator by typing into its pane, and that push has edges: it
 * fires only for the four urgent types, only when the lease records a pane on soma's own tmux
 * server, at most once per 30 s, and every wake is a keystroke into a live composer. A watcher
 * the orchestrator arms itself needs none of that — no pane, no server, no keystroke — and it
 * covers every row of `prompts/orchestrator.md`'s wake table that asks for a move. A wake still
 * means `soma_inbox`: these lines say who and what, never the payload.
 *
 * **It never writes.** No `writeCursor`, no fleet or lease write, no file. The `orch` cursor is
 * read only to skip what `soma_inbox` has already consumed, so a watcher can never consume an
 * event `soma_inbox` should still return, and any number of them can run or restart: the worst a
 * restart costs is a line said twice, and a duplicate wake is one `soma_inbox` call.
 *
 * What it has printed is remembered per process and keyed by `(stream, id)`, never by a position:
 * ids are unique per stream only, and a position cursor would skip an event stamped earlier but
 * appended later by another process — the silent loss `events.mjs`'s ordering rules exist for.
 */
import { statSync } from 'node:fs';
import process from 'node:process';
import { readCursor, readEvents, streamPath } from './events.mjs';
import { readFleet } from './fleet.mjs';
import { leaseStale, readLease } from './lease.mjs';
import { SOMA_HOME } from './paths.mjs';

/**
 * The event types that ring: the rows of the orchestrator's wake table that ask it for a move.
 * The "read, do nothing" rows (MILESTONE, STARTED, ROTATED, …) stay in the mailbox for the next
 * `soma_inbox`, which is where `--all` is for.
 *
 * The mutators are refused, not merely frozen — `Object.freeze` on a Set freezes its properties,
 * not its contents (`tokens.KNOWN_USAGE_FIELDS` says so) — because a stray `.add()` would turn
 * every MILESTONE of a ten-lead fleet into a wake.
 */
export const RING_TYPES = (() => {
  const ring = new Set([
    'NEEDS_INPUT', 'HARNESS', 'COMPLETED', 'ERROR', 'GAVE_UP', 'BUDGET', 'BACKPRESSURE', 'BLOCKED',
    'HARNESS_DEFAULTED', 'VERSION_GATE', 'LEAD_BLOCKED_ON_PROMPT', 'LEAD_DEAD_SHELL', 'ROTATION_UNAVAILABLE',
  ]);
  for (const method of ['add', 'delete', 'clear']) {
    ring[method] = () => {
      throw new TypeError(`RING_TYPES is immutable — it mirrors prompts/orchestrator.md's wake table (.${method}() refused)`);
    };
  }
  return Object.freeze(ring);
})();

/** How many wake lines one poll may print before the rest are summarised. A wake is a notification, not an inbox. */
export const MAX_LINES = 20;
/** How often the watchdog and the lease are looked at. They change on the watchdog's 30 s tick, no faster. */
export const HEALTH_EVERY_MS = 30_000;
export const INTERVAL_DEFAULT_S = 5;
export const INTERVAL_MIN_S = 1;
export const INTERVAL_MAX_S = 300;

/** A stream name is a lead id: `events/<id>.ndjson`. Mirrors `fleet.mjs`'s `ID_RE`. */
const STREAM_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ORCH = 'orch';

/** One stored field, safe on a line the orchestrator reads as context — `orch-inject.mjs`'s `label`. */
const label = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);

/** One line of text for whatever was thrown. Must never throw. */
const reason = (e) => {
  try {
    const m = e?.message;
    return typeof m === 'string' && m !== '' ? m : String(e) || 'unknown error';
  } catch {
    return 'unknown error';
  }
};

/**
 * The bus's own wake line (`bus-tools.wake()`), so a wake reads the same whichever path it came by.
 *
 * Who and what, never payload text: these lines become the orchestrator's context, and a lead
 * writes the payloads — a NEEDS_INPUT's question here would be an injection surface, which is
 * `orch-inject.mjs`'s argument too. The one exception is a BUDGET's percentage, and only as a
 * finite number. `soma_inbox` carries the payloads, and it does the fold.
 */
export function wakeLine(event) {
  let who = 'fleet';
  if (event?.lead != null) who = typeof event.lead === 'string' && event.lead !== '' ? event.lead : 'an unnamed lead';
  const pct = event?.type === 'BUDGET' && Number.isFinite(event?.payload?.pct) ? ` ${event.payload.pct}%` : '';
  return `[soma] ${label(who, 64)} ${label(event?.type, 32)}${pct}. Call soma_inbox.`;
}

/** The one line that stands for everything past `MAX_LINES` in a poll. */
export function moreLine(n) {
  return `[soma] …and ${n} more unread fleet events. Call soma_inbox.`;
}

/** Health lines. Each is said once when its state is entered, never every poll. */
const WATCHDOG_DOWN = '[soma] health: watchdog down. Nothing spawns, revives, meters or drains until the operator runs `soma up`.';
const WATCHDOG_BACK = '[soma] health: watchdog back.';
const LEASE_LOST = '[soma] health: lease lost. This session no longer holds the orchestrator lease: stop acting on the fleet, and soma_adopt again only if the operator says so.';
const NO_HOLDER = '[soma] health: no orchestrator holds the lease. Nothing answers NEEDS_INPUT or drains soma_inbox until a session runs soma_adopt.';
const LEASE_STALE = "[soma] health: lease stale. Its holder's pane is gone or its heartbeat is over 10 minutes old, so the next soma_adopt takes the fleet without force.";
const LEASE_FRESH = '[soma] health: lease fresh.';

/**
 * `{ events(), health() }`, each returning the lines to print now.
 *
 * `deps.watchdogState` (`'live' | 'absent' | 'unknown'`) and `deps.hasPane` have NO defaults: they
 * read tmux, and the caller decides which server. Everything else defaults to the real reader.
 */
export function watcher({ all = false, env = process.env, deps = {} } = {}) {
  const fleetOf = deps.readFleet ?? readFleet;
  const cursorOf = deps.readCursor ?? readCursor;
  const eventsOf = deps.readEvents ?? readEvents;
  const statOf = deps.statStream ?? ((stream) => statSync(streamPath(stream)));
  const leaseOf = deps.readLease ?? readLease;
  const need = (name) => {
    const fn = deps[name];
    if (typeof fn !== 'function') {
      throw new TypeError(`soma watch: dependency "${name}" is missing or is not a function. It reads tmux and has no default:`
        + ' the caller says which server.');
    }
    return fn;
  };

  /** stream -> ids printed and not yet behind the cursor. */
  const printed = new Map();
  /** stream -> { stamp, since, events }: the unread events last parsed, and what they were read against. */
  const parsed = new Map();

  /**
   * The events after `cursor` in one stream, re-reading the file only when its size or mtime moved.
   * A live root holds megabytes across dozens of streams, nearly all of them quiet between polls.
   * A kept parse answers only for a cursor at or past the one it was read with: a cursor that moved
   * back (a torn cursor file reads as none) needs events the parse filtered out.
   */
  const unreadIn = (stream, cursor) => {
    let stamp = null;
    try {
      const s = statOf(stream);
      stamp = `${s.size}:${s.mtimeMs}`;
    } catch { /* no stamp, so nothing to compare: read it */ }
    const kept = parsed.get(stream);
    if (stamp !== null && kept?.stamp === stamp && (kept.since === null || (cursor !== null && cursor >= kept.since))) {
      const events = cursor === kept.since ? kept.events : kept.events.filter((e) => e.id > cursor);
      parsed.set(stream, { stamp, since: cursor, events });
      return events;
    }
    const events = eventsOf(stream, { sinceId: cursor });
    if (stamp === null) parsed.delete(stream);
    else parsed.set(stream, { stamp, since: cursor, events });
    return events;
  };

  const events = () => {
    // The sweep `soma_inbox` and `orch-inject.mjs` make: every lead's stream plus the
    // orchestrator's own, de-duplicated, ids filtered because a hand-edited checkpoint's id reaches
    // the filesystem as a path. An unreadable checkpoint still leaves `orch`.
    let tasks = [];
    try {
      const t = fleetOf()?.tasks;
      if (Array.isArray(t)) tasks = t;
    } catch { /* `orch` alone, below */ }
    const streams = [...new Set(tasks.map((t) => t?.id).filter((id) => typeof id === 'string' && STREAM_RE.test(id)).concat(ORCH))];
    const cursor = cursorOf(ORCH);
    for (const stream of parsed.keys()) if (!streams.includes(stream)) parsed.delete(stream);

    const pending = [];
    for (const stream of streams) {
      for (const e of unreadIn(stream, cursor)) {
        if (!all && !RING_TYPES.has(e?.type)) continue;
        if (printed.get(stream)?.has(e.id)) continue;
        pending.push({ stream, e });
      }
    }
    // `(ts, id)`, the order `events.unread` hands `soma_inbox`.
    pending.sort((a, b) => a.e.ts - b.e.ts || (a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0));
    const lines = pending.slice(0, MAX_LINES).map(({ e }) => wakeLine(e));
    if (pending.length > MAX_LINES) lines.push(moreLine(pending.length - MAX_LINES));

    // Everything considered is printed, the summarised tail too: the more-line already rang for it.
    for (const { stream, e } of pending) {
      if (!printed.has(stream)) printed.set(stream, new Set());
      printed.get(stream).add(e.id);
    }
    // And forgotten once `soma_inbox` is past it, since no read returns it again.
    for (const [stream, ids] of printed) {
      if (cursor !== null) for (const id of ids) if (id <= cursor) ids.delete(id);
      if (ids.size === 0 || !streams.includes(stream)) printed.delete(stream);
    }
    return lines;
  };

  let watchdog = null; // the last reading that counted: 'live' | 'absent'
  let held = false;    // this session held the lease at the last reading
  let episode = null;  // a non-holder's last lease reading: 'none' | 'stale' | 'fresh'

  const health = () => {
    const watchdogState = need('watchdogState');
    const hasPane = need('hasPane');
    const lines = [];

    // `unknown` is tmux that could not be read, and `soma status`'s rule holds: unreadable is not
    // dead. It neither speaks nor moves the state. The first reading speaks only if it is `absent`.
    const w = watchdogState();
    if (w === 'absent' && watchdog !== 'absent') lines.push(WATCHDOG_DOWN);
    if (w === 'live' && watchdog === 'absent') lines.push(WATCHDOG_BACK);
    if (w === 'absent' || w === 'live') watchdog = w;

    let lease;
    try {
      lease = leaseOf();
    } catch {
      return lines; // an unreadable lease is no reading at all
    }
    const sid = env?.CLAUDE_CODE_SESSION_ID;
    if (typeof sid === 'string' && sid !== '' && lease?.session_id === sid) {
      // The holder hears nothing about staleness: inside it, "stale" only means it idled ten minutes.
      held = true;
      episode = null;
      return lines;
    }
    if (held) {
      // The keystroke-free stand-in for the DEMOTED notice the bus types into a displaced pane. It
      // claims only the loss: from here this session is a non-holder (`episode` is still null from
      // its holding), so the rules below say in this same poll whether nobody holds the lease now
      // or a stale one does. Another session's fresh lease adds nothing.
      held = false;
      lines.push(LEASE_LOST);
    }
    // A pane tmux could not be asked about is present: a lease must not read stale because tmux did.
    const present = (pane) => {
      try {
        return hasPane(pane);
      } catch {
        return true;
      }
    };
    const now = lease == null ? 'none' : leaseStale(lease, present) ? 'stale' : 'fresh';
    if (now === 'none' && episode !== 'none') lines.push(NO_HOLDER);
    if (now === 'stale' && episode !== 'stale') lines.push(LEASE_STALE);
    if (now === 'fresh' && (episode === 'none' || episode === 'stale')) lines.push(LEASE_FRESH);
    episode = now;
    return lines;
  };

  return { events, health };
}

/** A timer `signal` can cut short. Resolves either way, never rejects. */
export const abortableSleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) {
    resolve();
    return;
  }
  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
});

/**
 * The loop, until `signal` aborts: events, then health when due, each line through `print`, then
 * sleep. Resolves when aborted.
 *
 * The banner goes to `warn`, never `print`: Monitor turns every stdout line into a wake, so stdout
 * carries the wake lines and nothing else. A poll that throws is one `warn` line and the loop goes
 * on; the same message from the same part is not repeated until that part succeeds again, or a
 * broken state root would print a line every few seconds for as long as the watcher runs.
 */
export async function runWatch({
  all = false, intervalMs = INTERVAL_DEFAULT_S * 1000, env = process.env, deps = {}, print, warn, signal, sleep = abortableSleep,
} = {}) {
  const w = watcher({ all, env, deps });
  const now = deps.now ?? Date.now;
  warn(`soma watch: watching ${SOMA_HOME()} every ${intervalMs / 1000}s for ${all ? 'every fleet event' : 'the fleet events that need the orchestrator'}`
    + ' — one stdout line each. Reads the orch cursor and consumes nothing: soma_inbox still returns every event.');
  const said = { events: null, health: null };
  const poll = (part, fn, out) => {
    try {
      out.push(...fn());
      said[part] = null;
    } catch (e) {
      const msg = `soma watch: ${part === 'events' ? 'reading the event log' : 'the health check'} failed: ${reason(e)}`;
      if (msg !== said[part]) warn(msg);
      said[part] = msg;
    }
  };
  let healthDue = -Infinity;
  while (!signal?.aborted) {
    const out = [];
    poll('events', w.events, out);
    if (now() >= healthDue) {
      healthDue = now() + HEALTH_EVERY_MS;
      poll('health', w.health, out);
    }
    for (const line of out) print(line);
    await sleep(intervalMs, signal);
  }
}
