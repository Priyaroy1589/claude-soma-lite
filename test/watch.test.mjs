/**
 * `bin/lib/watch.mjs` and `soma watch`: the keystroke-free event poller (#35).
 *
 * The bus wakes the orchestrator by typing into its pane, which needs a pane on soma's own tmux
 * server and fires for four types at most once per 30 s. `soma watch` is the other way in: a
 * command the orchestrator runs under Claude Code's Monitor tool, which turns every stdout line
 * into a wake. So most of what is pinned here is a claim about stdout. There is one line per event
 * that needs the orchestrator, saying who and what and never the payload. Each event is said once,
 * and a poll is capped. Health lines appear only when a state is entered. The banner and every
 * error go to stderr. Nothing is ever written: a watcher that moved the `orch` cursor would eat
 * what `soma_inbox` still has to return.
 */
import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// `tmux.mjs` reads SOMA_TMUX_SOCKET once, at load, and `soma.mjs` imports it, so a throwaway name
// is set before either loads. Nothing in this process calls tmux: every reader of it is a stub.
const SOCK = 'soma-t35-watch-test';
process.env.SOMA_TMUX_SOCKET = SOCK;
const { dispatch } = await import('../bin/soma.mjs');
const { ensureTree } = await import('../bin/lib/paths.mjs');
const { enqueue } = await import('../bin/lib/fleet.mjs');
const { appendEvent, readEvents: realReadEvents, unread, writeCursor } = await import('../bin/lib/events.mjs');
const { acquireLease } = await import('../bin/lib/lease.mjs');
const { readFleet: realReadFleet } = await import('../bin/lib/fleet.mjs');
// The watchdog's own BACKPRESSURE builder and storm reason, so the freeze tests carry the payload
// exactly as the tick emits it.
const { backpressure } = await import('../bin/lib/wd/rotation-events.mjs');
const { STORM_REASON } = await import('../bin/lib/wd/backpressure.mjs');

const CLI = fileURLToPath(new URL('../bin/soma.mjs', import.meta.url));

/** The module under test, loaded inside each test so a missing export fails that test, not the file. */
const mod = () => import('../bin/lib/watch.mjs');

/** The rows of the orchestrator's wake table that ask it for a move: the types that ring. */
const RING = [
  'NEEDS_INPUT', 'HARNESS', 'COMPLETED', 'ERROR', 'GAVE_UP', 'BUDGET', 'BACKPRESSURE', 'BLOCKED',
  'HARNESS_DEFAULTED', 'VERSION_GATE', 'LEAD_BLOCKED_ON_PROMPT', 'LEAD_DEAD_SHELL', 'ROTATION_UNAVAILABLE',
];

/** The wake line the SPEC gives for `who` and `type`. */
const W = (who, type) => `[soma] ${who} ${type}. Call soma_inbox.`;

/** A throwaway, ensureTree'd state root for one test; the previous SOMA_HOME comes back afterwards. */
const stateRoot = (t) => {
  const prev = process.env.SOMA_HOME;
  const home = mkdtempSync(join(tmpdir(), 'sw-'));
  t.after(() => {
    if (prev === undefined) delete process.env.SOMA_HOME; else process.env.SOMA_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });
  process.env.SOMA_HOME = home;
  ensureTree();
  return home;
};

/** Queue lead rows the way `soma enqueue` does. */
const seed = (...ids) => enqueue(ids.map((id) => ({ id, title: id, repo: 'r', source: {}, brief: 'b' })));

/** Append one event the way a lead does on its own stream, or the fleet on `orch` (no lead). */
const emit = (stream, type, { lead = stream === 'orch' ? null : stream, payload = {} } = {}) => appendEvent(stream, { type, payload, lead });

/** A hand-written fleet checkpoint: the rows `enqueue` refuses to write still reach a reader this way. */
const writeFleetRows = (home, tasks) => writeFileSync(join(home, 'state', 'fleet.json'), JSON.stringify({ tasks }));

/**
 * Append one event by hand at the `ts` it is given, its id following from it the way `events.mjs`
 * stamps one: the freeze tests below run a clock of their own, two hours of ticks in a second.
 */
const put = (home, stream, ts, type, payload = {}, lead = stream === 'orch' ? null : stream) => {
  const id = `${String(ts).padStart(13, '0')}-0000`;
  writeFileSync(join(home, 'events', `${stream}.ndjson`), `${JSON.stringify({ id, ts, type, payload, lead })}\n`, { flag: 'a' });
  return id;
};

/**
 * The two BACKPRESSURE payloads the watchdog emits (`bin/soma-watchdog.mjs`). A storm is said on
 * every frozen tick with its record's `since`, or under another freeze's record with the tick's own
 * time, and carries the leads whose limit hits make it up. The spend cap is said once per freeze.
 */
const STORM = (since) => ({ ...backpressure({ reason: STORM_REASON, since, until: null }).payload, evidence: [{ lead: 'cr-1' }, { lead: 'cr-2' }] });
const SPEND_CAP = (since) => backpressure({ reason: 'org_level_disabled_until', since, until: null }).payload;
const BP = '[soma] fleet BACKPRESSURE. Call soma_inbox.';
/** A clock for the freeze tests, in ms; any 13-digit time will do. */
const T0 = 1_700_000_000_000;
const TICK = 30_000;

/** Every file under `dir` with its bytes, inode and mtime, and every directory's entries: what "wrote nothing" claims. */
const snapshot = (dir) => {
  const out = {};
  const walk = (rel) => {
    const abs = join(dir, rel);
    const st = lstatSync(abs);
    if (st.isDirectory()) {
      const names = readdirSync(abs).sort();
      out[rel || '.'] = { entries: names };
      for (const n of names) walk(join(rel, n));
    } else {
      out[rel] = { bytes: readFileSync(abs, 'utf8'), ino: st.ino, mtimeMs: st.mtimeMs };
    }
  };
  walk('');
  return out;
};

/** The health lines, by the state each announces. The SPEC fixes how each one starts. */
const HEALTH = Object.entries({
  down: '[soma] health: watchdog down.',
  back: '[soma] health: watchdog back.',
  lost: '[soma] health: lease lost.',
  none: '[soma] health: no orchestrator holds the lease.',
  stale: '[soma] health: lease stale.',
  fresh: '[soma] health: lease fresh.',
});

/** Each line as the health state it announces. Anything else, a multi-line string included, shows itself whole. */
const kinds = (lines) => lines.map((l) => (typeof l === 'string' && !l.includes('\n') && HEALTH.find(([, p]) => l.startsWith(p))?.[0])
  || `unexpected: ${JSON.stringify(l)}`);

const ME = 'ME-UUID';
const OTHER = 'OTHER-UUID';
const MIN = 60_000;

/** A lease record shaped the way `acquireLease` writes one: another session's, with a pane, fresh. */
const leaseOf = (over = {}) => ({
  session_id: OTHER, tmux_socket: SOCK, tmux_pane: '%3', wake: 'tmux', lease_seq: 1, heartbeat_at: Date.now(), ...over,
});

/**
 * Run `health()` once per step and return what each poll said, as kinds (`raw`: the lines
 * themselves). A step sets the watchdog reading (`wd`, default 'live'), what readLease answers
 * (`lease`: a record, null, or an Error to throw; default a fresh lease of another session) and
 * what hasPane answers (`pane`: a boolean, or an Error to throw; default true).
 */
const healthSteps = async (steps, { env = {}, raw = false } = {}) => {
  const { watcher } = await mod();
  let s = {};
  const w = watcher({
    env,
    deps: {
      watchdogState: () => s.wd ?? 'live',
      readLease: () => {
        const l = 'lease' in s ? s.lease : leaseOf();
        if (l instanceof Error) throw l;
        return l;
      },
      hasPane: () => {
        const p = s.pane ?? true;
        if (p instanceof Error) throw p;
        return p;
      },
    },
  });
  return steps.map((step) => {
    s = step;
    return raw ? w.health() : kinds(w.health());
  });
};

// ------------------------------------------------------------------------ constants and lines

test('the constants: thirteen ring types, 20 lines a poll, health every 30 s, an interval of 1..300 s that defaults to 5', async () => {
  const { RING_TYPES, MAX_LINES, HEALTH_EVERY_MS, INTERVAL_DEFAULT_S, INTERVAL_MIN_S, INTERVAL_MAX_S } = await mod();
  assert.ok(RING_TYPES instanceof Set);
  assert.deepEqual([...RING_TYPES].sort(), [...RING].sort());
  assert.equal(RING_TYPES.size, 13);
  assert.equal(MAX_LINES, 20);
  assert.equal(HEALTH_EVERY_MS, 30_000);
  assert.equal(INTERVAL_DEFAULT_S, 5);
  assert.equal(INTERVAL_MIN_S, 1);
  assert.equal(INTERVAL_MAX_S, 300);
});

test('RING_TYPES is frozen, contents included: add, delete and clear throw, and the set is unchanged', async () => {
  // A module instance of its own, so a mutation that does take effect cannot leak into the tests
  // around this one.
  const { RING_TYPES } = await import('../bin/lib/watch.mjs?frozen-probe');
  assert.ok(Object.isFrozen(RING_TYPES));
  // `Object.freeze` on a Set freezes its properties, not its contents: `frozen.add(x)` still adds.
  // The house rule for a Set that must not change is `tokens.KNOWN_USAGE_FIELDS`': the mutators
  // throw. A stray add() would turn every MILESTONE of a ten-lead fleet into a wake, and a mutator
  // that quietly did nothing would hide the caller that tried.
  for (const [what, poke] of [
    ['add', (s) => s.add('MILESTONE')], ['delete', (s) => s.delete('NEEDS_INPUT')], ['clear', (s) => s.clear()],
  ]) {
    assert.throws(() => poke(RING_TYPES), (e) => e instanceof TypeError && /immutable/.test(e.message), `.${what}() did not throw`);
    assert.deepEqual([...RING_TYPES].sort(), [...RING].sort(), `.${what}() changed the ring set`);
  }
  assert.equal(RING_TYPES.size, 13);
});

test('wakeLine: who and what, in the bus\'s own words, and never the payload', async () => {
  const { wakeLine } = await mod();
  assert.equal(wakeLine({ id: '1', ts: 1, type: 'NEEDS_INPUT', lead: 'cr-1', payload: { question: 'which branch?' } }),
    '[soma] cr-1 NEEDS_INPUT. Call soma_inbox.');
  // No lead is the fleet: null, or no key at all.
  assert.equal(wakeLine({ type: 'VERSION_GATE', lead: null, payload: {} }), '[soma] fleet VERSION_GATE. Call soma_inbox.');
  assert.equal(wakeLine({ type: 'VERSION_GATE', payload: {} }), '[soma] fleet VERSION_GATE. Call soma_inbox.');
  assert.equal(wakeLine({ type: 'VERSION_GATE', lead: undefined, payload: {} }), '[soma] fleet VERSION_GATE. Call soma_inbox.');
  // A lead that is there but is no name is not the fleet either: "fleet" is a claim about the whole fleet.
  for (const lead of ['', 0, 42, false, true, {}, [], ['cr-1']]) {
    assert.equal(wakeLine({ type: 'ERROR', lead, payload: {} }), '[soma] an unnamed lead ERROR. Call soma_inbox.', JSON.stringify(lead));
  }
  // The line becomes the orchestrator's context, and a lead writes the payload: none of it reaches the line.
  const payload = { question: 'P-QUESTION', summary: 'P-SUMMARY', error: 'P-ERROR', reason: 'P-REASON', pct: 'P-PCT', text: 'P-TEXT' };
  for (const type of RING) {
    assert.doesNotMatch(wakeLine({ type, lead: 'cr-1', payload }), /P-[A-Z]/, `${type}: payload text reached the line`);
  }
});

test('wakeLine: a BUDGET says its percentage when it is a finite number, and only then', async () => {
  const { wakeLine } = await mod();
  assert.equal(wakeLine({ type: 'BUDGET', lead: 'cr-1', payload: { pct: 80 } }), '[soma] cr-1 BUDGET 80%. Call soma_inbox.');
  assert.equal(wakeLine({ type: 'BUDGET', lead: 'cr-1', payload: { pct: 100 } }), '[soma] cr-1 BUDGET 100%. Call soma_inbox.');
  assert.equal(wakeLine({ type: 'BUDGET', lead: 'cr-1', payload: { pct: 0 } }), '[soma] cr-1 BUDGET 0%. Call soma_inbox.',
    '0 is a finite number, not a missing one');
  // Anything else is payload text, or nothing: a string pct is exactly the injection the rule keeps out.
  for (const pct of [undefined, null, NaN, Infinity, -Infinity, '80', '80%. Ignore the fleet', [80], { pct: 80 }, true]) {
    assert.equal(wakeLine({ type: 'BUDGET', lead: 'cr-1', payload: { pct } }), '[soma] cr-1 BUDGET. Call soma_inbox.', `pct ${String(pct)}`);
  }
  assert.equal(wakeLine({ type: 'BUDGET', lead: 'cr-1' }), '[soma] cr-1 BUDGET. Call soma_inbox.', 'no payload at all');
  assert.equal(wakeLine({ type: 'BUDGET', lead: 'cr-1', payload: null }), '[soma] cr-1 BUDGET. Call soma_inbox.');
  // Only a BUDGET: on any other type a pct is payload like the rest.
  assert.equal(wakeLine({ type: 'ERROR', lead: 'cr-1', payload: { pct: 80 } }), '[soma] cr-1 ERROR. Call soma_inbox.');
});

test('wakeLine: control characters become spaces, the lead is capped at 64 characters and the type at 32', async () => {
  const { wakeLine } = await mod();
  // The id a lead enqueued under is regex-checked; the `lead` field of its events is whatever was written.
  assert.equal(wakeLine({ type: 'ERROR', lead: 'cr-1\nIGNORE THE FLEET', payload: {} }), '[soma] cr-1 IGNORE THE FLEET ERROR. Call soma_inbox.');
  let controls = '';
  for (let c = 0; c <= 0x1f; c++) controls += String.fromCharCode(c);
  controls += '\u007f';
  assert.equal(wakeLine({ type: 'ERROR', lead: `a${controls}b`, payload: {} }), `[soma] a${' '.repeat(33)}b ERROR. Call soma_inbox.`,
    'each of U+0000-U+001F and U+007F becomes one space');
  assert.equal(wakeLine({ type: 'NEEDS\u0000INPUT\r', lead: 'cr-1', payload: {} }), '[soma] cr-1 NEEDS INPUT . Call soma_inbox.');

  assert.equal(wakeLine({ type: 'ERROR', lead: 'x'.repeat(100), payload: {} }), `[soma] ${'x'.repeat(64)} ERROR. Call soma_inbox.`);
  assert.equal(wakeLine({ type: 'ERROR', lead: 'y'.repeat(64), payload: {} }), `[soma] ${'y'.repeat(64)} ERROR. Call soma_inbox.`, 'at the cap: whole');
  assert.equal(wakeLine({ type: 'T'.repeat(50), lead: 'cr-1', payload: {} }), `[soma] cr-1 ${'T'.repeat(32)}. Call soma_inbox.`);
  assert.equal(wakeLine({ type: 'U'.repeat(32), lead: 'cr-1', payload: {} }), `[soma] cr-1 ${'U'.repeat(32)}. Call soma_inbox.`, 'at the cap: whole');
});

test('moreLine: one line for the rest, with a real ellipsis', async () => {
  const { moreLine } = await mod();
  assert.equal(moreLine(5), '[soma] …and 5 more unread fleet events. Call soma_inbox.');
  assert.equal(moreLine(117), '[soma] …and 117 more unread fleet events. Call soma_inbox.');
  assert.ok(!moreLine(5).includes('...'), 'U+2026, not three dots');
});

// ------------------------------------------------------------------------------------- events()

test('events(): one wake line per unread ring event, oldest first across every lead\'s stream and orch', async (t) => {
  stateRoot(t);
  seed('cr-1', 'cr-2');
  const { watcher } = await mod();
  // Appended in an order the streams are not read in, so a watcher that printed stream by stream
  // would put cr-1 first.
  emit('cr-2', 'NEEDS_INPUT', { payload: { question: 'which branch?' } });
  emit('orch', 'VERSION_GATE');
  emit('cr-1', 'COMPLETED', { payload: { summary: 'done' } });
  emit('cr-2', 'MILESTONE');
  // Who is the event's lead, not the stream it sits in.
  emit('orch', 'LEAD_DEAD_SHELL', { lead: 'cr-2' });
  emit('cr-1', 'ERROR', { payload: { error: 'boom' } });
  assert.deepEqual(watcher({}).events(), [
    W('cr-2', 'NEEDS_INPUT'), W('fleet', 'VERSION_GATE'), W('cr-1', 'COMPLETED'), W('cr-2', 'LEAD_DEAD_SHELL'), W('cr-1', 'ERROR'),
  ]);
});

test('events(): every ring type rings and nothing else does, unless all', async (t) => {
  stateRoot(t);
  seed('cr-1');
  const { watcher } = await mod();
  // The "read, do nothing" rows, and near-misses of a ring type, which match nothing.
  const quiet = ['MILESTONE', 'STARTED', 'SPAWNED', 'ROTATED', 'needs_input', 'NEEDS_INPUT '];
  const types = [];
  RING.forEach((type, i) => {
    types.push(type);
    if (i < quiet.length) types.push(quiet[i]);
  });
  for (const type of types) emit('cr-1', type);
  assert.deepEqual(watcher({}).events(), RING.map((type) => W('cr-1', type)));
  assert.deepEqual(watcher({ all: true }).events(), types.map((type) => W('cr-1', type)), 'all: every event rings');
});

test('events(): each event is said once: a poll with nothing new says nothing, and one new event between polls is one line', async (t) => {
  stateRoot(t);
  seed('cr-1', 'cr-2');
  const { watcher } = await mod();
  const w = watcher({});
  emit('cr-1', 'NEEDS_INPUT');
  assert.deepEqual(w.events(), [W('cr-1', 'NEEDS_INPUT')]);
  assert.deepEqual(w.events(), [], 'an unread event said again on the next poll: a wake every few seconds until soma_inbox runs');
  assert.deepEqual(w.events(), []);
  emit('cr-2', 'ERROR');
  emit('cr-2', 'MILESTONE');
  assert.deepEqual(w.events(), [W('cr-2', 'ERROR')]);
  assert.deepEqual(w.events(), []);
  emit('cr-1', 'COMPLETED');
  assert.deepEqual(w.events(), [W('cr-1', 'COMPLETED')]);
});

test('events(): an id is unique per stream only, so the same id in two streams is two events', async (t) => {
  const home = stateRoot(t);
  seed('cr-1', 'cr-2');
  const { watcher } = await mod();
  // Every appending process stamps its own ids, so two of them in the same millisecond mint the same one.
  const line = (id, lead) => `${JSON.stringify({ id, ts: Number(id.slice(0, 13)), type: 'NEEDS_INPUT', payload: {}, lead })}\n`;
  const at = (stream, id, lead = stream) => writeFileSync(join(home, 'events', `${stream}.ndjson`), line(id, lead), { flag: 'a' });
  const w = watcher({});
  // In one poll.
  at('cr-1', '1700000000000-0000');
  at('cr-2', '1700000000000-0000');
  assert.deepEqual(w.events().sort(), [W('cr-1', 'NEEDS_INPUT'), W('cr-2', 'NEEDS_INPUT')]);
  // And across polls, which is where a memory keyed by id alone would drop the second one.
  at('cr-1', '1700000000001-0000');
  assert.deepEqual(w.events(), [W('cr-1', 'NEEDS_INPUT')]);
  at('cr-2', '1700000000001-0000');
  assert.deepEqual(w.events(), [W('cr-2', 'NEEDS_INPUT')], 'an id already said in cr-1 is a different event in cr-2');
  at('orch', '1700000000001-0000', null);
  assert.deepEqual(w.events(), [W('fleet', 'NEEDS_INPUT')]);
  assert.deepEqual(w.events(), []);
});

test('events(): what soma_inbox has consumed is not announced: the orch cursor is read, and no other consumer\'s', async (t) => {
  stateRoot(t);
  seed('cr-1', 'cr-2');
  const { watcher } = await mod();
  emit('cr-1', 'NEEDS_INPUT');
  const b = emit('cr-2', 'ERROR');
  const c = emit('cr-1', 'COMPLETED');
  writeCursor('orch', b.id);
  // The inject hook's cursor is its own business: an event it stapled onto a prompt is still unread
  // for soma_inbox.
  writeCursor('orch-inject', c.id);
  assert.deepEqual(watcher({}).events(), [W('cr-1', 'COMPLETED')]);
});

test('RESTART: a fresh watcher says again what is still unread, and nothing once soma_inbox is past it', async (t) => {
  stateRoot(t);
  seed('cr-1');
  const { watcher } = await mod();
  emit('cr-1', 'NEEDS_INPUT');
  const b = emit('orch', 'BACKPRESSURE');
  const first = watcher({});
  assert.deepEqual(first.events(), [W('cr-1', 'NEEDS_INPUT'), W('fleet', 'BACKPRESSURE')]);
  // What a watcher has said lives in its memory only, so a restart says it again...
  assert.deepEqual(watcher({}).events(), [W('cr-1', 'NEEDS_INPUT'), W('fleet', 'BACKPRESSURE')]);
  // ...until soma_inbox has consumed it.
  writeCursor('orch', b.id);
  assert.deepEqual(watcher({}).events(), []);
  assert.deepEqual(first.events(), []);
});

test('RESTART: events appended while no watcher ran are said by the next one', async (t) => {
  stateRoot(t);
  seed('cr-1', 'cr-2');
  const { watcher } = await mod();
  const a = emit('cr-1', 'NEEDS_INPUT');
  assert.deepEqual(watcher({}).events(), [W('cr-1', 'NEEDS_INPUT')]);
  // soma_inbox read it, and the watcher stopped. Then the fleet went on.
  writeCursor('orch', a.id);
  emit('cr-2', 'HARNESS');
  emit('cr-1', 'MILESTONE');
  emit('cr-1', 'GAVE_UP');
  assert.deepEqual(watcher({}).events(), [W('cr-2', 'HARNESS'), W('cr-1', 'GAVE_UP')]);
});

test('the cap: 25 unread ring events are 20 wake lines and one "…and 5 more" line, and the next poll is silent', async (t) => {
  stateRoot(t);
  seed('cr-1', 'cr-2');
  const { watcher } = await mod();
  const sent = [];
  // Every ring type but BACKPRESSURE, so this test is about the cap alone: whether a BACKPRESSURE
  // rings depends on the ones before it (its own tests, below). Reasoned ones of one freeze fold
  // into one line; a reasonless one, which is what emit() writes here, always rings.
  const EACH = RING.filter((type) => type !== 'BACKPRESSURE');
  for (let i = 0; i < 25; i++) {
    const lead = i % 2 ? 'cr-2' : 'cr-1';
    const type = EACH[i % EACH.length];
    emit(lead, type);
    sent.push(W(lead, type));
  }
  emit('cr-1', 'MILESTONE'); // does not ring, so it is not one of the "more"
  const w = watcher({});
  const lines = w.events();
  assert.equal(lines.length, 21, JSON.stringify(lines));
  assert.deepEqual(lines.slice(0, 20), sent.slice(0, 20), 'the twenty oldest, in order');
  assert.equal(lines[20], '[soma] …and 5 more unread fleet events. Call soma_inbox.');
  assert.deepEqual(w.events(), [], 'the five behind the more-line already rang once and are not said again');
  emit('cr-2', 'ERROR');
  assert.deepEqual(w.events(), [W('cr-2', 'ERROR')]);
});

test('the cap\'s edges: exactly 20 is 20 lines and no more-line, and 21 is 20 lines and "…and 1 more"', async (t) => {
  stateRoot(t);
  seed('cr-1');
  const { watcher, moreLine } = await mod();
  let last;
  for (let i = 0; i < 20; i++) last = emit('cr-1', 'ERROR');
  assert.deepEqual(watcher({}).events(), Array(20).fill(W('cr-1', 'ERROR')));
  writeCursor('orch', last.id);
  for (let i = 0; i < 21; i++) emit('cr-1', 'NEEDS_INPUT');
  assert.deepEqual(watcher({}).events(), [...Array(20).fill(W('cr-1', 'NEEDS_INPUT')), moreLine(1)]);
});

// ------------------------------------------------------------------------- BACKPRESSURE, once a freeze
//
// The watchdog says a storm's BACKPRESSURE on EVERY frozen tick, deliberately: a storm's end has no
// event, so the repetition records how long it held. A watcher that rang each one would wake the
// orchestrator every 30 s for the whole storm, hours of it under a five-hour window and days under
// a weekly one. So in ring mode a BACKPRESSURE with a reason (a non-empty string) rings unless the
// last one with a reason this watcher saw, rung or not, has the same reason and either the same
// `since` or a ts less than BACKPRESSURE_QUIET_MS (10 minutes) before this one's. One it does not
// ring is still taken as said: it is never announced later, it becomes the last one seen, and it
// takes no place under the 20-line cap. One with no reason always rings and leaves the last one seen
// as it was. The last one seen is one slot. `--all` is the raw stream and prints every one.

test('BACKPRESSURE rings once per freeze: a storm said every 30 s for two hours is one wake line, through a drain and a silence', async (t) => {
  const home = stateRoot(t);
  seed('cr-1', 'cr-2');
  const { watcher } = await mod();
  const w = watcher({});
  const said = [];
  let first = null;
  for (let i = 0; i <= 240; i++) {
    const id = put(home, 'orch', T0 + i * TICK, 'BACKPRESSURE', STORM(T0));
    first ??= id;
    said.push(...w.events());
    // soma_inbox drains the first wake while the storm goes on.
    if (i === 1) writeCursor('orch', first);
  }
  assert.deepEqual(said, [BP], 'one storm, said every tick for two hours, is one wake');
  // The watchdog was down for three hours and came back to the same storm record: the same since.
  put(home, 'orch', T0 + 240 * TICK + 180 * MIN, 'BACKPRESSURE', STORM(T0));
  assert.deepEqual(w.events(), [], 'the same since is the same freeze, however long the silence');
});

test('BACKPRESSURE once per freeze: a restart mid-storm says it once', async (t) => {
  const home = stateRoot(t);
  seed('cr-1', 'cr-2');
  const { watcher } = await mod();
  // A hundred re-emits, none drained: a watcher started now says the storm once.
  for (let i = 0; i < 100; i++) put(home, 'orch', T0 + i * TICK, 'BACKPRESSURE', STORM(T0));
  const w = watcher({});
  assert.deepEqual(w.events(), [BP]);
  put(home, 'orch', T0 + 100 * TICK, 'BACKPRESSURE', STORM(T0));
  assert.deepEqual(w.events(), []);
  // What a watcher has seen lives in its memory only, so the next restart says it once again.
  assert.deepEqual(watcher({}).events(), [BP]);
});

test('BACKPRESSURE once per freeze: a spend cap, which the watchdog says once, rings once', async (t) => {
  const home = stateRoot(t);
  seed('cr-1');
  const { watcher } = await mod();
  put(home, 'orch', T0, 'BACKPRESSURE', SPEND_CAP(T0));
  const w = watcher({});
  assert.deepEqual(w.events(), [BP]);
  assert.deepEqual(w.events(), []);
});

test('BACKPRESSURE once per freeze: a storm under a spend cap\'s record, each re-emit dated by its tick, is one more wake, not one a tick', async (t) => {
  const home = stateRoot(t);
  seed('cr-1', 'cr-2');
  const { watcher } = await mod();
  const w = watcher({});
  const said = [];
  put(home, 'orch', T0, 'BACKPRESSURE', SPEND_CAP(T0));
  said.push(...w.events());
  // Under another freeze's record the storm has no record of its own to carry a since from, so each
  // re-emit stamps its tick: a new since every 30 s, an hour of them.
  for (let i = 1; i <= 120; i++) {
    const ts = T0 + i * TICK;
    put(home, 'orch', ts, 'BACKPRESSURE', STORM(ts));
    said.push(...w.events());
  }
  assert.deepEqual(said, [BP, BP], 'the spend cap, then the storm: two freezes, two wakes');
});

test('BACKPRESSURE once per freeze: a new storm after eleven quiet minutes rings again', async (t) => {
  const home = stateRoot(t);
  seed('cr-1', 'cr-2');
  const { watcher } = await mod();
  const w = watcher({});
  const said = [];
  let ts = T0;
  for (let i = 0; i <= 20; i++) {
    ts = T0 + i * TICK;
    put(home, 'orch', ts, 'BACKPRESSURE', STORM(T0));
    said.push(...w.events());
  }
  // Eleven minutes with no BACKPRESSURE, then a storm with a since of its own.
  const t2 = ts + 11 * MIN;
  for (let i = 0; i <= 20; i++) {
    put(home, 'orch', t2 + i * TICK, 'BACKPRESSURE', STORM(t2));
    said.push(...w.events());
  }
  assert.deepEqual(said, [BP, BP], 'two storms, eleven minutes apart, are two wakes');
});

test('BACKPRESSURE once per freeze: the ten minutes run from the last one seen, said or not, and end at exactly BACKPRESSURE_QUIET_MS', async (t) => {
  const home = stateRoot(t);
  seed('cr-1', 'cr-2');
  const { watcher, BACKPRESSURE_QUIET_MS } = await mod();
  const QUIET = 600_000;
  // A new since every time, so only the gap decides. 9 + 9 minutes is two gaps under ten, not one
  // of eighteen: the one not said is still the last one seen. Ten minutes exactly is no longer
  // under ten; a millisecond less still is.
  const at = [T0, T0 + 9 * MIN, T0 + 18 * MIN, T0 + 18 * MIN + QUIET, T0 + 18 * MIN + 2 * QUIET - 1];
  const w = watcher({});
  const said = at.map((ts) => {
    put(home, 'orch', ts, 'BACKPRESSURE', STORM(ts));
    return w.events();
  });
  assert.deepEqual(said, [[BP], [], [], [BP], []]);
  assert.equal(BACKPRESSURE_QUIET_MS, QUIET, 'and the constant says so');
});

test('BACKPRESSURE once per freeze: a re-emit it does not ring is said for good, and another freeze after it does not bring it back', async (t) => {
  const home = stateRoot(t);
  seed('cr-1', 'cr-2');
  const { watcher } = await mod();
  const w = watcher({});
  const said = [0, 1, 2].map((i) => {
    put(home, 'orch', T0 + i * TICK, 'BACKPRESSURE', STORM(T0));
    return w.events();
  });
  // The spend cap outranks a storm and is a freeze of its own: it rings.
  put(home, 'orch', T0 + 3 * TICK, 'BACKPRESSURE', SPEND_CAP(T0 + 3 * TICK));
  said.push(w.events());
  // The storm's two re-emits are behind it, unread and of another reason. They were said.
  said.push(w.events());
  // The last one seen is one slot, and it holds the spend cap now: the storm's next re-emit is its
  // reason's first since then, and rings. Storm, spend cap, storm: three wakes.
  for (const i of [4, 5]) {
    put(home, 'orch', T0 + i * TICK, 'BACKPRESSURE', STORM(T0));
    said.push(w.events());
  }
  assert.deepEqual(said, [[BP], [], [], [BP], [], [BP], []]);
});

test('BACKPRESSURE once per freeze: one with no reason always rings, and leaves the last one seen as it was', async (t) => {
  const home = stateRoot(t);
  seed('cr-1', 'cr-2');
  const { watcher } = await mod();
  const w = watcher({});
  const said = [];
  const step = (i, payload) => {
    put(home, 'orch', T0 + i * TICK, 'BACKPRESSURE', payload);
    said.push(w.events());
  };
  step(0, STORM(T0));
  // No reason, a reason that is not a string, an empty one: each rings, two in a row included.
  step(1, {});
  step(2, { reason: 42, since: T0 });
  step(3, { reason: '', since: T0 });
  step(4, {});
  // And none of them is the last one seen: the storm's re-emit is still the same freeze.
  step(5, STORM(T0));
  assert.deepEqual(said, [[BP], [BP], [BP], [BP], [BP], []]);
});

test('BACKPRESSURE once per freeze: --all is the raw stream and prints every re-emit', async (t) => {
  const home = stateRoot(t);
  seed('cr-1', 'cr-2');
  const { watcher } = await mod();
  const w = watcher({ all: true });
  const said = [];
  for (let i = 0; i < 10; i++) {
    put(home, 'orch', T0 + i * TICK, 'BACKPRESSURE', STORM(T0));
    said.push(...w.events());
  }
  assert.deepEqual(said, Array(10).fill(BP));
});

test('BACKPRESSURE once per freeze: re-emits it does not ring take no place under the cap', async (t) => {
  const home = stateRoot(t);
  seed('cr-1', 'cr-2');
  const { watcher } = await mod();
  for (let i = 0; i < 25; i++) put(home, 'orch', T0 + i * TICK, 'BACKPRESSURE', STORM(T0));
  put(home, 'cr-1', T0 + 15_000, 'NEEDS_INPUT');
  put(home, 'cr-1', T0 + 45_000, 'NEEDS_INPUT');
  put(home, 'cr-2', T0 + 10 * MIN + 15_000, 'NEEDS_INPUT');
  const w = watcher({});
  // 28 unread ring events, 24 of them re-emits of one storm: four wake lines, oldest first, and no
  // "…and N more" line.
  assert.deepEqual(w.events(), [BP, W('cr-1', 'NEEDS_INPUT'), W('cr-1', 'NEEDS_INPUT'), W('cr-2', 'NEEDS_INPUT')]);
  assert.deepEqual(w.events(), []);
});

test('a fleet row whose id is not a lead id is never read as a stream', async (t) => {
  const home = stateRoot(t);
  const { watcher } = await mod();
  const bad = ['../escape', 'cr-1/../../escape', 'Cr-1', 'cr_1', 'cr 1', '', '1cr', '-cr', 'cr-1\n', 'a'.repeat(65)];
  const good = ['cr-1', 'z', 'a'.repeat(64)];
  const rows = [...bad.map((id) => ({ id })), { id: 7 }, { id: null }, {}, null, 'cr-2', ...good.map((id) => ({ id }))];

  // What is asked for, every reader stubbed.
  const asked = new Set();
  const w = watcher({ deps: { readFleet: () => ({ tasks: rows }), readCursor: () => null, readEvents: (stream) => { asked.add(stream); return []; } } });
  assert.deepEqual(w.events(), []);
  assert.deepEqual([...asked].sort(), [...good, 'orch'].sort());

  // And on disk: a ring event planted where `../escape` leads is never announced.
  writeFleetRows(home, [{ id: '../escape' }, { id: 'cr-1' }]);
  writeFileSync(join(home, 'escape.ndjson'),
    `${JSON.stringify({ id: '1700000000000-0000', ts: 1700000000000, type: 'NEEDS_INPUT', payload: {}, lead: 'escape' })}\n`);
  emit('cr-1', 'ERROR');
  assert.deepEqual(watcher({}).events(), [W('cr-1', 'ERROR')]);
});

test('streams are de-duplicated: a repeated row and a lead named orch are each read once', async (t) => {
  const home = stateRoot(t);
  const { watcher } = await mod();
  writeFleetRows(home, [{ id: 'cr-1' }, { id: 'cr-1' }, { id: 'orch' }]);
  emit('cr-1', 'NEEDS_INPUT');
  emit('orch', 'ERROR');
  assert.deepEqual(watcher({}).events(), [W('cr-1', 'NEEDS_INPUT'), W('fleet', 'ERROR')]);
});

test('an unreadable fleet checkpoint still leaves orch, and events() does not throw', async (t) => {
  const home = stateRoot(t);
  seed('cr-1');
  emit('cr-1', 'NEEDS_INPUT');
  emit('orch', 'BACKPRESSURE');
  const { watcher } = await mod();
  writeFileSync(join(home, 'state', 'fleet.json'), '{"tasks": [');
  let lines;
  assert.doesNotThrow(() => { lines = watcher({}).events(); });
  assert.deepEqual(lines, [W('fleet', 'BACKPRESSURE')]);
  // A reader that throws outright, through the dep.
  const w = watcher({ deps: { readFleet: () => { throw new Error('EIO'); } } });
  assert.deepEqual(w.events(), [W('fleet', 'BACKPRESSURE')]);
});

test('NEVER writes: no cursor file appears, an existing one stays byte-identical, and soma_inbox still has every event', async (t) => {
  const home = stateRoot(t);
  seed('cr-1', 'cr-2');
  const a = emit('cr-1', 'NEEDS_INPUT');
  emit('cr-2', 'MILESTONE');
  emit('orch', 'ERROR');
  emit('cr-2', 'BLOCKED');
  const { watcher } = await mod();
  const cursorFile = join(home, 'events', '.cursors.json');
  const streams = ['cr-1', 'cr-2', 'orch'];
  const exercise = () => {
    const w = watcher({ deps: { watchdogState: () => 'absent', hasPane: () => false } });
    for (let i = 0; i < 3; i++) {
      w.events();
      w.health();
    }
    watcher({ all: true }).events();
  };

  assert.equal(existsSync(cursorFile), false, 'fixture: no cursor yet');
  let before = snapshot(home);
  let inbox = unread('orch', streams);
  exercise();
  assert.equal(existsSync(cursorFile), false, 'a watcher wrote the orch cursor: soma_inbox would now skip what was announced');
  assert.deepEqual(snapshot(home), before, 'a watcher wrote under the state root');
  assert.deepEqual(unread('orch', streams), inbox);
  assert.equal(inbox.length, 4, 'fixture: soma_inbox has all four');

  writeCursor('orch', a.id);
  before = snapshot(home);
  inbox = unread('orch', streams);
  exercise();
  assert.deepEqual(snapshot(home), before, 'the cursor file (or anything else) was rewritten');
  assert.deepEqual(unread('orch', streams), inbox);
  assert.equal(inbox.length, 3);
});

test('what soma_inbox is past is forgotten: if the cursor then moves back, the event is unread again and said again', async (t) => {
  const home = stateRoot(t);
  seed('cr-1');
  const { watcher } = await mod();
  const a = emit('cr-1', 'NEEDS_INPUT');
  const w = watcher({});
  assert.deepEqual(w.events(), [W('cr-1', 'NEEDS_INPUT')]);
  writeCursor('orch', a.id);
  assert.deepEqual(w.events(), []);
  // A torn cursor file reads as no cursor, so soma_inbox will hand the event out again. A duplicate
  // wake is the cheap direction (events.mjs: replaying costs a wake, losing costs a task).
  writeFileSync(join(home, 'events', '.cursors.json'), '{"orch": ');
  assert.deepEqual(w.events(), [W('cr-1', 'NEEDS_INPUT')]);
});

test('only the orch cursor forgets: a poll that cannot read the fleet, or a row gone for a poll, re-announces nothing', async (t) => {
  const home = stateRoot(t);
  seed('cr-1', 'cr-2');
  const { watcher } = await mod();
  let fleetDown = false;
  const w = watcher({ deps: { readFleet: () => { if (fleetDown) throw new Error('EIO: the checkpoint could not be read'); return realReadFleet(); } } });
  emit('cr-1', 'NEEDS_INPUT');
  emit('cr-2', 'ERROR');
  assert.deepEqual(w.events(), [W('cr-1', 'NEEDS_INPUT'), W('cr-2', 'ERROR')]);
  // One poll reads orch alone. Both events are still unread, and both stay said.
  fleetDown = true;
  assert.deepEqual(w.events(), []);
  fleetDown = false;
  assert.deepEqual(w.events(), [], 'an event already said was said again after one poll that could not read the fleet');
  // A hand-edited checkpoint that drops a row for a poll and puts it back is the same.
  writeFleetRows(home, [{ id: 'cr-1' }]);
  assert.deepEqual(w.events(), []);
  writeFleetRows(home, [{ id: 'cr-1' }, { id: 'cr-2' }]);
  assert.deepEqual(w.events(), [], 'an event already said was said again when its row came back');
  // A new event still rings.
  emit('cr-2', 'COMPLETED');
  assert.deepEqual(w.events(), [W('cr-2', 'COMPLETED')]);
});

// ------------------------------------------------------------------------------------- health()

test('health: the watchdog is announced when it goes down, the first reading included, and when it comes back, once each', async () => {
  assert.deepEqual(await healthSteps([{ wd: 'absent' }, { wd: 'absent' }, { wd: 'live' }, { wd: 'live' }, { wd: 'absent' }, { wd: 'absent' }, { wd: 'live' }]),
    [['down'], [], ['back'], [], ['down'], [], ['back']]);
  // A first reading of live is the normal case, and says nothing.
  assert.deepEqual(await healthSteps([{ wd: 'live' }, { wd: 'live' }]), [[], []]);
});

test('health: an unknown watchdog reading says nothing and changes nothing', async () => {
  // Unknown is tmux that could not be read, and unreadable is not dead.
  assert.deepEqual(await healthSteps([{ wd: 'unknown' }, { wd: 'unknown' }]), [[], []]);
  assert.deepEqual(await healthSteps([{ wd: 'unknown' }, { wd: 'absent' }]), [[], ['down']], 'after unknown, absent is still an entry');
  assert.deepEqual(await healthSteps([{ wd: 'unknown' }, { wd: 'live' }]), [[], []], 'after unknown, live is still a first live');
  assert.deepEqual(await healthSteps([{ wd: 'absent' }, { wd: 'unknown' }, { wd: 'absent' }]), [['down'], [], []], 'down, unreadable, still down: one line');
  assert.deepEqual(await healthSteps([{ wd: 'absent' }, { wd: 'unknown' }, { wd: 'live' }]), [['down'], [], ['back']]);
  assert.deepEqual(await healthSteps([{ wd: 'live' }, { wd: 'unknown' }, { wd: 'absent' }]), [[], [], ['down']]);
  assert.deepEqual(await healthSteps([{ wd: 'live' }, { wd: 'unknown' }, { wd: 'live' }]), [[], [], []], 'live again after unreadable is no comeback');
});

test('health: for a session that does not hold it, a lease nobody holds, a stale one and a fresh one are each said once when entered', async () => {
  const none = { lease: null };
  const fresh = { lease: leaseOf() };
  const stalePane = { lease: leaseOf(), pane: false };
  const staleBeat = { lease: leaseOf({ tmux_pane: null, wake: 'notify', heartbeat_at: Date.now() - 11 * MIN }) };
  assert.deepEqual(await healthSteps([none, none, fresh, fresh, stalePane, stalePane, staleBeat, fresh, none, stalePane, none]),
    [['none'], [], ['fresh'], [], ['stale'], [], [], ['fresh'], ['none'], ['stale'], ['none']]);
  // First readings: nobody holding it and a stale lease are entered; a fresh one is not news.
  assert.deepEqual(await healthSteps([fresh]), [[]]);
  assert.deepEqual(await healthSteps([staleBeat]), [['stale']]);
  assert.deepEqual(await healthSteps([none]), [['none']]);
});

test('health: a non-holder\'s first reading of a fresh lease is silent; "lease fresh" is said only on leaving a none or stale episode', async () => {
  const fresh = { lease: leaseOf() };
  // "Fresh" is news only as the end of something that was said: a lease nobody held, or a stale one.
  assert.deepEqual(await healthSteps([{ lease: null }, fresh, fresh]), [['none'], ['fresh'], []]);
  assert.deepEqual(await healthSteps([{ lease: leaseOf(), pane: false }, fresh, fresh]), [['stale'], ['fresh'], []]);
  // A first reading is silent wherever it comes: when the watcher starts, after a lease that could
  // not be read, under a watchdog that is down, and straight after this session lost the lease.
  assert.deepEqual(await healthSteps([fresh, fresh]), [[], []]);
  assert.deepEqual(await healthSteps([{ lease: new Error('EIO') }, fresh]), [[], []]);
  assert.deepEqual(await healthSteps([{ wd: 'absent', ...fresh }]), [['down']]);
  assert.deepEqual(await healthSteps([{ lease: leaseOf({ session_id: ME }) }, fresh, fresh], { env: { CLAUDE_CODE_SESSION_ID: ME } }),
    [[], ['lost'], []]);
});

test('health: the lease holder hears nothing about its own lease, stale or not', async () => {
  const env = { CLAUDE_CODE_SESSION_ID: ME };
  const mine = (over = {}) => ({ lease: leaseOf({ session_id: ME, ...over }) });
  // Inside the holder, "stale" only means it has idled ten minutes.
  assert.deepEqual(await healthSteps([mine(), mine(), { ...mine(), pane: false }, mine({ tmux_pane: null, wake: 'notify', heartbeat_at: Date.now() - 11 * MIN })], { env }),
    [[], [], [], []]);
  // Becoming the holder out of a "nobody holds it" episode is not announced as fresh either.
  assert.deepEqual(await healthSteps([{ lease: null }, mine(), mine()], { env }), [['none'], [], []]);
});

test('health: losing the lease is "lease lost", then in the same poll what a non-holder hears on entering what it finds', async () => {
  // Lease loss is compositional. Once the lease is lost this session is a non-holder, and the
  // non-holder's rules apply in that same poll: a lease nobody holds and a stale lease are each
  // entered and said, and another session's fresh lease is a first fresh reading, which is no news.
  const env = { CLAUDE_CODE_SESSION_ID: ME };
  const mine = { lease: leaseOf({ session_id: ME }) };
  for (const [what, after, expected] of [
    ['to nobody', { lease: null }, ['lost', 'none']],
    ['to a stale holder: its pane is gone', { lease: leaseOf(), pane: false }, ['lost', 'stale']],
    ['to a stale holder: its heartbeat is old', { lease: leaseOf({ tmux_pane: null, wake: 'notify', heartbeat_at: Date.now() - 11 * MIN }) }, ['lost', 'stale']],
    ['to a fresh holder', { lease: leaseOf() }, ['lost']],
  ]) {
    assert.deepEqual(await healthSteps([mine, after, after, after], { env }), [[], expected, [], []], what);
  }
  // Held again and lost again is a new episode, and a new line.
  assert.deepEqual(await healthSteps([mine, { lease: null }, mine, { lease: leaseOf() }], { env }), [[], ['lost', 'none'], [], ['lost']]);
});

test('health: the "lease lost" line claims the loss and nothing else: one wording whoever has the lease now, never another holder', async () => {
  const env = { CLAUDE_CODE_SESSION_ID: ME };
  const mine = { lease: leaseOf({ session_id: ME }) };
  const lost = [];
  for (const after of [{ lease: null }, { lease: leaseOf(), pane: false }, { lease: leaseOf() }]) {
    const [, said] = await healthSteps([mine, after], { env, raw: true });
    lost.push(...said.filter((l) => l.startsWith('[soma] health: lease lost.')));
  }
  assert.equal(lost.length, 3, JSON.stringify(lost));
  // It is said when nobody holds the lease now as much as when another session does, so it cannot
  // say who has it: the line after it in the same poll says that, or nothing does.
  assert.equal(new Set(lost).size, 1, `the line varies with who has the lease now: ${JSON.stringify(lost)}`);
  assert.doesNotMatch(lost[0], /\b(another|other|someone|somebody|new)\b[^.:]*\b(session|holder|orchestrator)\b/i, lost[0]);
  assert.doesNotMatch(lost[0], /\b(took|taken|takes|displaced|superseded|replaced|won)\b/i, lost[0]);
});

test('health: the holder is env.CLAUDE_CODE_SESSION_ID when non-empty and equal to the lease\'s, and env defaults to process.env', async (t) => {
  const stale = { lease: leaseOf({ session_id: ME }), pane: false };
  assert.deepEqual(await healthSteps([stale], { env: {} }), [['stale']], 'no session id: not the holder');
  assert.deepEqual(await healthSteps([stale], { env: { CLAUDE_CODE_SESSION_ID: OTHER } }), [['stale']]);
  assert.deepEqual(await healthSteps([{ lease: leaseOf({ session_id: '' }), pane: false }], { env: { CLAUDE_CODE_SESSION_ID: '' } }), [['stale']],
    'two empty ids are not a match');
  assert.deepEqual(await healthSteps([stale], { env: { CLAUDE_CODE_SESSION_ID: ME } }), [[]]);

  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prev; });
  process.env.CLAUDE_CODE_SESSION_ID = ME;
  assert.deepEqual(await healthSteps([stale], { env: {} }), [['stale']], 'the env passed in decides, not the process\'s');
  const { watcher } = await mod();
  const w = watcher({ deps: { watchdogState: () => 'live', readLease: () => stale.lease, hasPane: () => false } });
  assert.deepEqual(kinds(w.health()), [], 'with no env given, the process\'s own session id is the one compared');
});

test('health: a lease that cannot be read says nothing and changes nothing', async () => {
  const boom = { lease: new Error('EACCES') };
  assert.deepEqual(await healthSteps([{ lease: null }, boom, { lease: null }]), [['none'], [], []]);
  assert.deepEqual(await healthSteps([{ lease: leaseOf(), pane: false }, boom, { lease: leaseOf() }]), [['stale'], [], ['fresh']]);
  assert.deepEqual(await healthSteps([boom, { lease: leaseOf() }]), [[], []], 'an unreadable first reading is no reading: fresh after it is a first fresh');
  const s = await healthSteps([{ lease: leaseOf({ session_id: ME }) }, boom, { lease: null }], { env: { CLAUDE_CODE_SESSION_ID: ME } });
  assert.deepEqual(s[1], []);
  assert.ok(s[2].includes('lost'), `the holder state did not survive an unreadable poll: ${JSON.stringify(s)}`);
  // The watchdog is read regardless.
  assert.deepEqual(await healthSteps([{ wd: 'absent', lease: new Error('EIO') }]), [['down']]);
});

test('health: a pane tmux could not be asked about is a present pane', async () => {
  const lease = leaseOf(); // a fresh heartbeat, so the pane decides
  assert.deepEqual(await healthSteps([{ lease, pane: new Error('tmux timed out') }, { lease, pane: false }, { lease, pane: new Error('tmux timed out') }]),
    [[], ['stale'], ['fresh']]);
});

test('health: watchdogState and hasPane have no defaults: either one missing or not a function is a TypeError naming it, and events() needs neither', async (t) => {
  stateRoot(t);
  seed('cr-1');
  emit('cr-1', 'NEEDS_INPUT');
  const { watcher } = await mod();
  const both = { watchdogState: () => 'live', hasPane: () => true };
  for (const [name, other] of [['watchdogState', 'hasPane'], ['hasPane', 'watchdogState']]) {
    for (const [how, unwire] of [
      ['missing', (d) => { delete d[name]; }],
      // a reading where the reader should be
      ['not a function', (d) => { d[name] = name === 'watchdogState' ? 'live' : true; }],
    ]) {
      // A lease nobody holds asks no pane anything: the refusal comes when health() runs, not only
      // once something needs the reader.
      for (const lease of [null, leaseOf()]) {
        const deps = { ...both, readLease: () => lease };
        unwire(deps);
        const what = `${name} ${how}, ${lease === null ? 'no lease' : 'a fresh lease'}`;
        assert.throws(() => watcher({ env: {}, deps }).health(), (e) => {
          assert.ok(e instanceof TypeError, `${what}: ${e?.stack ?? e}`);
          assert.ok(e.message.includes(name), `${what}: the refusal does not name ${name}: ${e.message}`);
          assert.ok(!e.message.includes(other), `${what}: the refusal names ${other}, which was there: ${e.message}`);
          return true;
        }, what);
      }
    }
  }
  // events() asks for neither.
  assert.deepEqual(watcher({}).events(), [W('cr-1', 'NEEDS_INPUT')]);
});

test('health: readLease defaults to the real lease under SOMA_HOME', async (t) => {
  stateRoot(t);
  const { watcher } = await mod();
  const w = watcher({ env: {}, deps: { watchdogState: () => 'live', hasPane: () => false } });
  assert.deepEqual(kinds(w.health()), ['none'], 'no lease file: nobody holds it');
  acquireLease({ session_id: OTHER, tmux_socket: SOCK, tmux_pane: '%3', wake: 'tmux' }, { force: true });
  assert.deepEqual(kinds(w.health()), ['stale'], 'the real lease, whose pane hasPane says is gone');
});

// ------------------------------------------------------------------------------------ runWatch

/**
 * `runWatch` with recorders. `print` and `warn` collect lines. `sleep` records each interval, runs
 * `between(n)` after poll n, and aborts once `polls` polls have run. The tmux readers default to
 * a live watchdog and a present pane, and the lease to another session's fresh one, so a test
 * hears only what it sets up.
 */
const runFor = async ({ polls = 1, between = () => {}, intervalMs = 5000, all = false, env = {}, deps = {} } = {}) => {
  const { runWatch } = await mod();
  const out = [];
  const err = [];
  const slept = [];
  const signals = [];
  const ac = new AbortController();
  await runWatch({
    all,
    intervalMs,
    env,
    deps: { watchdogState: () => 'live', hasPane: () => true, readLease: () => leaseOf(), ...deps },
    print: (s) => out.push(s),
    warn: (s) => err.push(s),
    signal: ac.signal,
    sleep: async (ms, signal) => {
      slept.push(ms);
      signals.push(signal);
      between(slept.length);
      if (slept.length >= polls) ac.abort();
    },
  });
  return { out, err, slept, signals, ac };
};

test('runWatch: the banner goes to warn, once; print carries the wake and health lines, events first, and nothing else', async (t) => {
  stateRoot(t);
  seed('cr-1');
  emit('cr-1', 'NEEDS_INPUT');
  let checks = 0;
  const r = await runFor({
    polls: 3,
    between: (n) => { if (n === 1) emit('cr-1', 'ERROR'); },
    deps: { watchdogState: () => { checks++; return 'absent'; } },
  });
  assert.equal(r.err.length, 1, `one banner, said once, and nothing else on warn: ${JSON.stringify(r.err)}`);
  assert.ok(!r.out.includes(r.err[0]), 'the banner reached print');
  assert.equal(r.out.length, 3, JSON.stringify(r.out));
  assert.equal(r.out[0], W('cr-1', 'NEEDS_INPUT'));
  assert.deepEqual(kinds([r.out[1]]), ['down']);
  assert.equal(r.out[2], W('cr-1', 'ERROR'));
  assert.equal(checks, 1, 'health ran on a later poll, though 30 s of the real clock have not passed');
});

test('runWatch: all reaches the watcher', async (t) => {
  stateRoot(t);
  seed('cr-1');
  emit('cr-1', 'MILESTONE');
  assert.deepEqual((await runFor({ all: true })).out, [W('cr-1', 'MILESTONE')]);
  assert.deepEqual((await runFor({})).out, []);
});

test('runWatch: sleeps intervalMs with the signal between polls, stops when it aborts, and resolves', async (t) => {
  stateRoot(t);
  const r = await runFor({ polls: 3, intervalMs: 7000 });
  assert.deepEqual(r.slept, [7000, 7000, 7000]);
  assert.ok(r.signals.every((s) => s === r.ac.signal), 'sleep must be handed the signal, or an abort cannot cut it short');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(r.slept.length, 3, 'it went on polling after it resolved');
});

test('runWatch: a poll that throws is one "soma watch:" warn line, the same failure is not repeated, and the loop goes on', async (t) => {
  stateRoot(t);
  seed('cr-1');
  emit('cr-1', 'NEEDS_INPUT');
  // Polls 1 and 2 fail the same way, poll 3 another way, poll 4 reads.
  const modes = ['A', 'A', 'B', 'ok'];
  let mode = modes[0];
  const readEvents = (stream, opts) => {
    if (mode === 'A') throw new Error('EIO: the disk said no');
    if (mode === 'B') throw new Error('EACCES: another reason');
    return realReadEvents(stream, opts);
  };
  const r = await runFor({ polls: 4, deps: { readEvents }, between: (n) => { mode = modes[n] ?? 'ok'; } });
  assert.equal(r.err.length, 3, `the banner, A once, B once: ${JSON.stringify(r.err)}`);
  assert.ok(r.err[1].startsWith('soma watch:'), r.err[1]);
  assert.match(r.err[1], /EIO: the disk said no/);
  assert.ok(r.err[2].startsWith('soma watch:'), r.err[2]);
  assert.match(r.err[2], /EACCES: another reason/);
  assert.deepEqual(r.out, [W('cr-1', 'NEEDS_INPUT')], 'the loop did not go on to the poll that could read');
  assert.equal(r.slept.length, 4);
});

test('runWatch: a failure is said again once its part has had a good poll: A, A is one line; A, a good poll, A is two; A, B is two', async (t) => {
  stateRoot(t);
  // The health check is what fails here, and deps.now moves 31 s between polls, so every poll runs it.
  const modes = ['A', 'A', 'ok', 'A', 'B', 'B'];
  let mode = modes[0];
  let clock = 0;
  const r = await runFor({
    polls: modes.length,
    deps: {
      now: () => clock,
      watchdogState: () => {
        if (mode === 'A') throw new Error('tmux: no answer within 5 s');
        if (mode === 'B') throw new Error('tmux: permission denied');
        return 'live';
      },
    },
    between: (n) => { mode = modes[n] ?? 'ok'; clock += 31_000; },
  });
  const said = r.err.slice(1); // past the banner
  assert.equal(said.length, 3, `A on poll 1, A again on poll 4 after the good poll 3, B on poll 5: ${JSON.stringify(said)}`);
  for (const l of said) assert.ok(l.startsWith('soma watch:'), l);
  assert.match(said[0], /tmux: no answer within 5 s/, 'the line carries the exception\'s message');
  assert.equal(said[1], said[0], 'the same failure is the same line');
  assert.match(said[2], /tmux: permission denied/);
  assert.deepEqual(r.out, [], 'a failing check is no wake: nothing on stdout');
});

test('runWatch: a health check that throws is a warn line too, and that poll\'s event lines still print', async (t) => {
  stateRoot(t);
  seed('cr-1');
  emit('cr-1', 'NEEDS_INPUT');
  const r = await runFor({ deps: { watchdogState: () => { throw new Error('tmux wedged'); } } });
  assert.deepEqual(r.out, [W('cr-1', 'NEEDS_INPUT')]);
  assert.equal(r.err.length, 2, JSON.stringify(r.err));
  assert.ok(r.err[1].startsWith('soma watch:'), r.err[1]);
  assert.match(r.err[1], /tmux wedged/);
});

test('runWatch: health runs on the first poll, then again only once HEALTH_EVERY_MS has passed on deps.now', async (t) => {
  stateRoot(t);
  const { HEALTH_EVERY_MS } = await mod();
  assert.equal(HEALTH_EVERY_MS, 30_000);
  const start = 1_000_000;
  // One clock reading per poll, in ms after the first. 30 s is due; the exact boundary is left alone.
  const at = [0, 10_000, 29_000, 31_000, 59_000, 62_000];
  let clock = start;
  const ranAt = new Set();
  await runFor({
    polls: at.length,
    deps: { now: () => clock, watchdogState: () => { ranAt.add(clock - start); return 'live'; } },
    between: (n) => { clock = start + (at[n] ?? at[at.length - 1]); },
  });
  assert.deepEqual([...ranAt], [0, 31_000, 62_000]);
});

// ------------------------------------------------------------------------------------ soma watch

/**
 * `dispatch` deps for `watch`: the three tmux readers stubbed and no other guarded dep at all, so
 * an arm that reached for `sendKeys` (or anything else that acts) would be refused by name. The
 * loop is driven: `sleep` records each interval and aborts after `polls` polls. A backstop aborts
 * after 15 s, so an arm that ignored `deps.sleep` fails its assertions instead of hanging the file.
 */
const watchDeps = ({ polls = 1, liveSessions = () => new Set(['soma-watchdog']), serverAbsent = () => false, paneStates = () => null } = {}) => {
  const out = [];
  const err = [];
  const slept = [];
  const ac = new AbortController();
  const backstop = setTimeout(() => ac.abort(), 15_000);
  backstop.unref();
  ac.signal.addEventListener('abort', () => clearTimeout(backstop), { once: true });
  const deps = {
    print: (s) => out.push(String(s)),
    warn: (s) => err.push(String(s)),
    env: { PATH: process.env.PATH ?? '' },
    liveSessions,
    serverAbsent,
    paneStates,
    signal: ac.signal,
    sleep: async (ms) => {
      slept.push(ms);
      if (slept.length >= polls) ac.abort();
    },
  };
  return { deps, out, err, slept, ac };
};

/** Another session's fresh lease on disk, with a pane: silent on a first reading unless its pane is gone. */
const holdLease = () => acquireLease({ session_id: OTHER, tmux_socket: SOCK, tmux_pane: '%3', wake: 'tmux' }, { force: true });

test('soma watch: --interval is a whole number of seconds from 1 to 300; anything else is exit 1 with a reason, before any poll', async (t) => {
  stateRoot(t);
  for (const argv of [
    ['--interval', '0'], ['--interval', '301'], ['--interval', 'x'], ['--interval', '1.5'], ['--interval', '-1'], ['--interval', ''],
    ['--interval'], ['--bogus'], ['--all', '--bogus'], ['cr-1'],
  ]) {
    const h = watchDeps();
    assert.equal(await dispatch(['watch', ...argv], h.deps), 1, JSON.stringify(argv));
    assert.ok(h.err.join('').trim().length > 0, `${JSON.stringify(argv)}: a refusal must say why`);
    assert.deepEqual(h.out, [], JSON.stringify(argv));
    assert.deepEqual(h.slept, [], `${JSON.stringify(argv)}: refused, yet it polled`);
  }
  // The edges are in, and the default is 5 s.
  for (const [argv, ms] of [[['--interval', '1'], 1000], [['--interval', '300'], 300_000], [[], 5000]]) {
    const h = watchDeps();
    assert.equal(await dispatch(['watch', ...argv], h.deps), 0, `${JSON.stringify(argv)}: ${h.err.join(' | ')}`);
    assert.deepEqual(h.slept, [ms], JSON.stringify(argv));
  }
});

test('soma watch: a run returns 0 with the wake lines on stdout and the banner on stderr; --all rings every event', async (t) => {
  stateRoot(t);
  seed('cr-1');
  holdLease();
  emit('cr-1', 'MILESTONE');
  emit('cr-1', 'NEEDS_INPUT');
  const h = watchDeps({ polls: 2 });
  assert.equal(await dispatch(['watch'], h.deps), 0, h.err.join('\n'));
  assert.deepEqual(h.out, [W('cr-1', 'NEEDS_INPUT')]);
  assert.ok(h.err.length >= 1, 'no banner on stderr');
  for (const argv of [['--all', '--interval', '7'], ['--interval', '7', '--all']]) {
    const a = watchDeps();
    assert.equal(await dispatch(['watch', ...argv], a.deps), 0, a.err.join('\n'));
    assert.deepEqual(a.out, [W('cr-1', 'MILESTONE'), W('cr-1', 'NEEDS_INPUT')], JSON.stringify(argv));
    assert.deepEqual(a.slept, [7000], JSON.stringify(argv));
  }
});

test('soma watch reads the watchdog the way status does: unreadable is down only when tmux says no server answers', async (t) => {
  stateRoot(t);
  seed('cr-1');
  holdLease();
  for (const [what, liveSessions, serverAbsent, want] of [
    ['no listing, no server', () => null, () => true, ['down']],
    ['no listing, a server that did not answer', () => null, () => false, []],
    ['no listing, and only true counts as no server', () => null, () => 'true', []],
    ['a listing without the watchdog', () => new Set(['lead-cr-1', 'orch']), () => false, ['down']],
    ['an empty listing', () => new Set(), () => false, ['down']],
    ['a listing with the watchdog', () => new Set(['soma-watchdog']), () => false, []],
    ['a listing with the watchdog, whatever serverAbsent says', () => new Set(['soma-watchdog', 'lead-cr-1']), () => true, []],
  ]) {
    const h = watchDeps({ liveSessions, serverAbsent });
    assert.equal(await dispatch(['watch'], h.deps), 0, `${what}: ${h.err.join(' | ')}`);
    // The watchdog's lines only: with no server, the lease's pane is gone too, and its line has a test
    // of its own (below).
    assert.deepEqual(kinds(h.out).filter((k) => k === 'down' || k === 'back'), want, what);
  }
});

test('soma watch asks paneStates for the lease\'s pane: no listing is a present pane, a listing without it is a stale lease', async (t) => {
  stateRoot(t);
  seed('cr-1');
  holdLease();
  /** One session's `paneStates` record; the first pane is the active one. */
  const rec = (...ids) => ({
    dead: false, cmd: '2.1.263', pid: 1, title: 't', pane_id: ids[0], active: true,
    panes: ids.map((pane_id, i) => ({ pane_id, dead: false, cmd: '2.1.263', pid: 1, title: 't', active: i === 0 })),
  });
  for (const [what, paneStates, want] of [
    ['tmux could not be read', () => null, []],
    ['the pane is there', () => new Map([['orch', rec('%3')]]), []],
    ['the pane is there, not the active one', () => new Map([['orch', rec('%9', '%3')]]), []],
    ['the pane is gone', () => new Map([['orch', rec('%9')]]), ['stale']],
    ['no panes at all', () => new Map(), ['stale']],
  ]) {
    const h = watchDeps({ paneStates });
    assert.equal(await dispatch(['watch'], h.deps), 0, `${what}: ${h.err.join(' | ')}`);
    assert.deepEqual(kinds(h.out), want, what);
  }
});

test('soma watch reads the lease\'s pane the way status does: no listing is a gone pane only when tmux says no server answers', async (t) => {
  stateRoot(t);
  seed('cr-1');
  // Another session's lease with a fresh heartbeat, so the pane alone decides whether it is stale.
  acquireLease({ session_id: OTHER, tmux_socket: SOCK, tmux_pane: '%9', wake: 'tmux' }, { force: true });
  const rec = (...ids) => ({
    dead: false, cmd: '2.1.263', pid: 1, title: 't', pane_id: ids[0], active: true,
    panes: ids.map((pane_id, i) => ({ pane_id, dead: false, cmd: '2.1.263', pid: 1, title: 't', active: i === 0 })),
  });
  const listed = () => new Set(['soma-watchdog']);
  for (const [what, liveSessions, serverAbsent, paneStates, want] of [
    // No server: nothing runs there, the lease's pane included. (The watchdog reads as down too.)
    ['no listing, no server', () => null, () => true, () => null, ['stale']],
    // Unreadable is not dead: a server that did not answer is no evidence the pane is gone.
    ['no listing, a server that did not answer', () => null, () => false, () => null, []],
    ['no listing, and only true counts as no server', () => null, () => 'true', () => null, []],
    ['a listing without the pane', listed, () => false, () => new Map([['orch', rec('%3')]]), ['stale']],
    ['a listing with the pane', listed, () => false, () => new Map([['orch', rec('%9')]]), []],
    ['a listing with the pane, whatever serverAbsent says', listed, () => true, () => new Map([['orch', rec('%9')]]), []],
  ]) {
    const h = watchDeps({ liveSessions, serverAbsent, paneStates });
    assert.equal(await dispatch(['watch'], h.deps), 0, `${what}: ${h.err.join(' | ')}`);
    assert.deepEqual(kinds(h.out).filter((k) => k !== 'down'), want, what);
  }
});

test('soma watch writes nothing: the state tree is identical after a run, the cursor file included or still absent', async (t) => {
  const home = stateRoot(t);
  seed('cr-1', 'cr-2');
  holdLease();
  emit('cr-2', 'NEEDS_INPUT');
  emit('orch', 'VERSION_GATE');
  const cursorFile = join(home, 'events', '.cursors.json');
  // Every health line fires: the watchdog is down and the lease's pane is gone.
  const run = async () => {
    const h = watchDeps({ polls: 3, liveSessions: () => null, serverAbsent: () => true, paneStates: () => new Map() });
    assert.equal(await dispatch(['watch', '--all'], h.deps), 0, h.err.join('\n'));
    assert.ok(h.out.length >= 3, `fixture: the run said something: ${JSON.stringify(h.out)}`);
  };
  let before = snapshot(home);
  await run();
  assert.equal(existsSync(cursorFile), false, 'soma watch wrote the orch cursor');
  assert.deepEqual(snapshot(home), before);

  const c = emit('cr-1', 'ERROR');
  writeCursor('orch', c.id);
  emit('cr-1', 'COMPLETED');
  before = snapshot(home);
  await run();
  assert.deepEqual(snapshot(home), before);
});

test('soma watch: with no deps.sleep the real sleep runs, and an abort cuts it short', { timeout: 60_000 }, async (t) => {
  stateRoot(t);
  const h = watchDeps();
  delete h.deps.sleep;
  const started = Date.now();
  const timer = setTimeout(() => h.ac.abort(), 200);
  t.after(() => clearTimeout(timer));
  assert.equal(await dispatch(['watch', '--interval', '300'], h.deps), 0, h.err.join('\n'));
  assert.ok(Date.now() - started < 10_000, `a 300 s sleep was not cut short by the abort (${Date.now() - started} ms)`);
});

// ---------------------------------------------------------------------------------- acceptance

/** Every socket file under `dir`. A tmux server leaves one there; a client that found none does not. */
const sockets = (dir) => {
  const found = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const abs = join(d, n);
      const st = lstatSync(abs);
      if (st.isSocket()) found.push(abs);
      else if (st.isDirectory()) walk(abs);
    }
  };
  walk(dir);
  return found;
};

/**
 * The acceptance, as the operator will meet it: the real CLI as a real process, in an environment
 * built from nothing (no CLAUDE_* or SOMA_LEAD_* variable of the session running this suite), on a
 * throwaway tmux socket inside a throwaway TMUX_TMPDIR. The fleet has one lead, one event that
 * soma_inbox already consumed (behind the orch cursor) and one it has not. The first poll says the
 * unconsumed one. A NEEDS_INPUT appended after that poll is said within seconds, and only once over
 * the polls that follow. SIGTERM, which is how Monitor stops a command, is a clean exit 0. The
 * cursor file is unchanged, and no tmux server was started.
 */
test('acceptance: a real `soma watch --interval 1` says a NEEDS_INPUT within seconds, exits 0 on SIGTERM, and writes nothing',
  { timeout: 90_000 }, async (t) => {
    const base = mkdtempSync(join(tmpdir(), 'sw-e2e-'));
    // SHORT: a Unix socket path must fit in ~104 bytes, and tmux reports the realpath.
    const tt = mkdtempSync(existsSync('/tmp') ? '/tmp/sw-' : join(tmpdir(), 'sw-'));
    const sock = `soma-t35-e2e-${process.pid}`;
    let child = null;
    t.after(() => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      // Only reachable if a server was started after all, which the last assertion fails on.
      spawnSync('tmux', ['-L', sock, 'kill-server'], { env: { PATH: process.env.PATH ?? '', TMUX_TMPDIR: tt }, stdio: 'ignore' });
      rmSync(base, { recursive: true, force: true });
      rmSync(tt, { recursive: true, force: true });
    });

    const home = join(base, 'home');
    const inRoot = (fn) => {
      const prev = process.env.SOMA_HOME;
      process.env.SOMA_HOME = home;
      try { return fn(); } finally { if (prev === undefined) delete process.env.SOMA_HOME; else process.env.SOMA_HOME = prev; }
    };
    inRoot(() => {
      ensureTree();
      seed('cr-1');
      writeCursor('orch', emit('cr-1', 'ERROR').id);
      emit('cr-1', 'HARNESS');
    });
    const cursorFile = join(home, 'events', '.cursors.json');
    const cursorBefore = readFileSync(cursorFile, 'utf8');

    const env = { PATH: process.env.PATH ?? '', HOME: base, SOMA_HOME: home, TMUX_TMPDIR: tt, SOMA_TMUX_SOCKET: sock };
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'SOMA_HOME', 'SOMA_TMUX_SOCKET', 'TMUX_TMPDIR']);
    child = spawn(process.execPath, [CLI, 'watch', '--interval', '1'], { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    let closed = null;
    const exited = new Promise((resolve) => child.on('close', (code, signal) => { closed = { code, signal }; resolve(closed); }));
    const lines = () => out.split('\n').filter((l) => l !== '');
    const until = async (fn, ms) => {
      for (const end = Date.now() + ms; Date.now() < end && closed === null;) {
        if (fn()) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return fn();
    };
    const said = () => `\nstdout:\n${out}\nstderr:\n${err}\nexit: ${JSON.stringify(closed)}`;

    assert.ok(await until(() => lines().includes(W('cr-1', 'HARNESS')), 20_000), `no first poll within 20 s${said()}`);
    inRoot(() => emit('cr-1', 'NEEDS_INPUT', { payload: { question: 'which branch?' } }));
    // Within seconds at a 1 s interval; 10 s leaves room for a loaded machine running the whole suite.
    assert.ok(await until(() => lines().includes(W('cr-1', 'NEEDS_INPUT')), 10_000), `the NEEDS_INPUT was not said within 10 s${said()}`);
    // A few more 1 s polls, so a line said twice has the chance to show.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.equal(closed, null, `it exited on its own${said()}`);

    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const { code, signal } = await exited;
    clearTimeout(timer);
    assert.equal(code, 0, `SIGTERM must end the loop and exit 0 (got code ${code}, signal ${signal})${said()}`);

    assert.equal(lines().filter((l) => l === W('cr-1', 'NEEDS_INPUT')).length, 1, `said more than once${said()}`);
    assert.equal(lines().filter((l) => l === W('cr-1', 'HARNESS')).length, 1, `said more than once${said()}`);
    assert.ok(!lines().includes(W('cr-1', 'ERROR')), `an event soma_inbox had consumed was announced${said()}`);
    assert.ok(lines().every((l) => l.startsWith('[soma] ')), `stdout carries [soma] lines only; the banner belongs on stderr${said()}`);
    assert.ok(err.trim().length > 0, 'no banner on stderr');
    assert.ok(!out.includes('which branch?'), 'payload text reached stdout');
    assert.equal(readFileSync(cursorFile, 'utf8'), cursorBefore, 'the orch cursor file changed');
    assert.equal(env.TMUX_TMPDIR, tt);
    assert.deepEqual(sockets(tt), [], 'a tmux server was started inside the sandbox');
  });

/**
 * A real `soma watch --interval 1`, set up the way the acceptance above is (an environment built
 * from nothing, a throwaway socket in a throwaway TMUX_TMPDIR), on a fleet of one lead with one
 * unread HARNESS. `until(fn, ms)` waits for `fn` or the process's exit; `exit(ms)` waits for the
 * exit, with a SIGKILL past `ms`.
 */
let e2eRuns = 0;
const watchProcess = (t) => {
  const base = mkdtempSync(join(tmpdir(), 'sw-e2e-'));
  // SHORT: a Unix socket path must fit in ~104 bytes, and tmux reports the realpath.
  const tt = mkdtempSync(existsSync('/tmp') ? '/tmp/sw-' : join(tmpdir(), 'sw-'));
  const sock = `soma-t35-e2e-${process.pid}-${++e2eRuns}`;
  let child = null;
  t.after(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    spawnSync('tmux', ['-L', sock, 'kill-server'], { env: { PATH: process.env.PATH ?? '', TMUX_TMPDIR: tt }, stdio: 'ignore' });
    rmSync(base, { recursive: true, force: true });
    rmSync(tt, { recursive: true, force: true });
  });
  const home = join(base, 'home');
  const inRoot = (fn) => {
    const prev = process.env.SOMA_HOME;
    process.env.SOMA_HOME = home;
    try { return fn(); } finally { if (prev === undefined) delete process.env.SOMA_HOME; else process.env.SOMA_HOME = prev; }
  };
  inRoot(() => {
    ensureTree();
    seed('cr-1');
    emit('cr-1', 'HARNESS');
  });
  const env = { PATH: process.env.PATH ?? '', HOME: base, SOMA_HOME: home, TMUX_TMPDIR: tt, SOMA_TMUX_SOCKET: sock };
  child = spawn(process.execPath, [CLI, 'watch', '--interval', '1'], { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  let closed = null;
  const exited = new Promise((resolve) => child.on('close', (code, signal) => { closed = { code, signal }; resolve(closed); }));
  const until = async (fn, ms) => {
    for (const end = Date.now() + ms; Date.now() < end && closed === null;) {
      if (fn()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return fn();
  };
  const exit = async (ms) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), ms);
    const r = await exited;
    clearTimeout(timer);
    return r;
  };
  return {
    child, inRoot, until, exit,
    lines: () => out.split('\n').filter((l) => l !== ''),
    stderr: () => err,
    closed: () => closed,
    said: () => `\nstdout:\n${out}\nstderr:\n${err}\nexit: ${JSON.stringify(closed)}`,
  };
};

test('acceptance: SIGINT, an operator\'s Ctrl-C, ends `soma watch` with exit 0', { timeout: 60_000 }, async (t) => {
  const p = watchProcess(t);
  assert.ok(await p.until(() => p.lines().includes(W('cr-1', 'HARNESS')), 20_000), `no first poll within 20 s${p.said()}`);
  p.child.kill('SIGINT');
  const { code, signal } = await p.exit(10_000);
  assert.equal(code, 0, `SIGINT must end the loop and exit 0 (got code ${code}, signal ${signal})${p.said()}`);
});

test('acceptance: a reader that went away is no crash: a wake line written into the closed pipe, and `soma watch` still exits 0', { timeout: 60_000 }, async (t) => {
  const p = watchProcess(t);
  assert.ok(await p.until(() => p.lines().includes(W('cr-1', 'HARNESS')), 20_000), `no first poll within 20 s${p.said()}`);
  // The reader goes, and the next poll has a line to write into the pipe it left.
  p.child.stdout.destroy();
  p.inRoot(() => emit('cr-1', 'NEEDS_INPUT'));
  // Ending by itself on the write error is fine, and so is polling on until the next signal. An
  // unhandled EPIPE is not.
  await p.until(() => false, 5_000);
  if (p.closed() === null) p.child.kill('SIGTERM');
  const { code, signal } = await p.exit(10_000);
  assert.equal(code, 0, `a closed reader must not crash it (got code ${code}, signal ${signal})${p.said()}`);
  assert.doesNotMatch(p.stderr(), /EPIPE|Unhandled 'error'|node:internal|^\s+at /m, `a crash trace on stderr${p.said()}`);
});
