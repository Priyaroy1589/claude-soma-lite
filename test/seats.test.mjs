import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';
import { MIN_CLOSE_MS } from '../bin/lib/wd/limit-state.mjs';

/**
 * A fresh state root plus a fresh `seats.mjs` instance pointed at it.
 *
 * `tag` (not `Date.now()`) busts the module cache, so two tests starting in the same
 * millisecond still get their own instance; `t.after` removes the mkdtemp dir, since
 * `npm test` runs the whole suite in one process.
 *
 * `fleet.mjs` is imported WITHOUT a tag on purpose: it must be the same instance
 * `seats.mjs` itself imported, or the two copies would each see the other's lock as
 * "held by a live pid" and the re-entrancy the compose test relies on would time out.
 */
async function fresh(t, tag) {
  const home = mkdtempSync(join(tmpdir(), 'soma-seats-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.SOMA_HOME = home;
  const { ensureTree, p } = await import('../bin/lib/paths.mjs?' + tag);
  ensureTree();
  return { home, p, s: await import('../bin/lib/seats.mjs?' + tag), f: await import('../bin/lib/fleet.mjs') };
}

/**
 * A fake seat: a real directory under the test root, optionally with a `.claude.json` body.
 *
 * FIXTURE NOTE — the `.claude.json` bodies handed in here (the `loggedIn` tests) began
 * spec-derived: design §3.1 names `oauthAccount` as the login mark, and the limit measurement
 * report names only `cachedExtraUsageDisabledReason` and `overageCreditGrantCache` from that
 * file. The mark's KEY NAME and VALUE TYPE are now OBSERVED, not assumed: the 2026-09-17
 * re-review found a top-level `oauthAccount` whose value is a JSON object — not an array — in
 * two real Claude Code config dirs on this machine. Key name and type ONLY: no value was read,
 * no other key was named, no keychain was touched, no `claude` was invoked. So the object body
 * below is the real shape, and the array body the `false` test uses is garbage by construction —
 * no login writes one. Every OTHER key in these bodies is still spec-derived; if a real seat
 * spells the mark differently, the `loggedIn` block and `loggedIn()` change together.
 */
function seatDir(home, name, claudeJson) {
  const dir = join(home, 'seats', name);
  mkdirSync(dir, { recursive: true });
  if (claudeJson !== undefined) {
    writeFileSync(join(dir, '.claude.json'), typeof claudeJson === 'string' ? claudeJson : JSON.stringify(claudeJson));
  }
  return dir;
}

/** A cfg naming these dirs as seats, labelled by basename, in this order. */
const cfgOf = (...dirs) => ({ seats: dirs.map((d) => ({ config_dir: d, label: basename(d) })) });

/** The state file's rows, as the file has them — not through readSeatState, which normalises. */
const rows = (p) => JSON.parse(readFileSync(p('state', 'seats.json'), 'utf8')).seats;

/** Burn `ms` of wall clock inside a synchronous critical section. */
const spin = (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until);
};

// The sample clock, in ms: the limit fixture's `resetsAt: 1440433800` s = 2015-08-24T16:30Z, an
// arbitrary instant. Every assertion here is about ordering, never wall time, but the
// samples are real epoch-ms values so a seconds-for-ms slip reads as one at a glance.
const NOW = 1_440_433_800_000;
const H = 3_600_000;
const seatsUrl = new URL('../bin/lib/seats.mjs', import.meta.url).href;

// ---------------------------------------------------------------------------
// resolveConfigDir — the codebase's one `~` expander
// ---------------------------------------------------------------------------

test("resolveConfigDir expands ~ and ~/x, normalises an absolute path, and refuses '' and non-strings with a TypeError", async (t) => {
  const { s } = await fresh(t, 'resolve-dir');
  // Exported on its own because `soma init --seat` takes it directly and turns its TypeError into
  // a usage exit; spawn's `seatRoots` reaches it only through `loadSeats`, never directly. One
  // expander, so `~/seat-a` in soma.json and `--seat ~/seat-a` on the command line are one dir.
  assert.equal(s.resolveConfigDir('~'), homedir());
  assert.equal(s.resolveConfigDir('~/.claude-seat-a'), join(homedir(), '.claude-seat-a'));
  assert.equal(s.resolveConfigDir('/tmp//seats/../seat-b/'), '/tmp/seat-b');
  for (const bad of ['', undefined, null, 42, ['~']]) {
    assert.throws(() => s.resolveConfigDir(bad), { name: 'TypeError', message: /config_dir/ }, `${JSON.stringify(bad)} was accepted`);
  }
});

// ---------------------------------------------------------------------------
// loadSeats — soma.json.seats, resolved
// ---------------------------------------------------------------------------

test('loadSeats resolves a ~-prefixed config_dir against homedir()', async (t) => {
  const { s } = await fresh(t, 'tilde');
  assert.deepEqual(s.loadSeats({ seats: [{ config_dir: '~/.claude-seat-a', label: 'seat-a' }] }), [
    { config_dir: join(homedir(), '.claude-seat-a'), label: 'seat-a', closed_until: 0, closed_reason: null, unverified: false },
  ]);
});

test('loadSeats resolves a bare ~ to homedir() itself', async (t) => {
  const { s } = await fresh(t, 'bare-tilde');
  assert.equal(s.loadSeats({ seats: [{ config_dir: '~', label: 'home' }] })[0].config_dir, homedir());
});

test('loadSeats normalises an absolute config_dir and keeps soma.json order', async (t) => {
  const { s } = await fresh(t, 'absolute');
  const seats = s.loadSeats({ seats: [{ config_dir: '/tmp//seats/../seat-b/', label: 'b' }, { config_dir: '/tmp/seat-a', label: 'a' }] });
  assert.deepEqual(seats.map((x) => x.config_dir), ['/tmp/seat-b', '/tmp/seat-a']);
});

test("loadSeats refuses config_dir '' with a sentence that says an empty CLAUDE_CONFIG_DIR means unset", async (t) => {
  const { s } = await fresh(t, 'empty');
  // resolve('') is the cwd, and '' is what claudeConfigRoot and buildLeadEnv read as "unset" —
  // so a seat spelled '' would be the operator's default ~/.claude profile wearing a seat label.
  assert.throws(() => s.loadSeats({ seats: [{ config_dir: '', label: 'x' }] }), { name: 'TypeError', message: /config_dir[\s\S]*unset/ });
});

test('loadSeats refuses a non-string config_dir', async (t) => {
  const { s } = await fresh(t, 'nonstring');
  for (const bad of [undefined, null, 42, true, ['/x'], { path: '/x' }]) {
    assert.throws(() => s.loadSeats({ seats: [{ config_dir: bad, label: 'x' }] }), { name: 'TypeError', message: /config_dir/ }, `config_dir ${JSON.stringify(bad)} was accepted`);
  }
});

test('loadSeats requires cfg.seats to be an array, the way admit requires cfg.max_leads', async (t) => {
  const { s } = await fresh(t, 'noarray');
  // DEFAULTS always carries `seats`, so a cfg without it is not a config; `?? []` would turn a
  // caller bug into a fleet that silently never rotates.
  for (const cfg of [undefined, {}, { seats: null }, { seats: {} }, { seats: 'x' }]) {
    assert.throws(() => s.loadSeats(cfg), { name: 'TypeError', message: /cfg\.seats/ }, `cfg ${JSON.stringify(cfg)} was accepted`);
  }
});

test('loadSeats refuses a seat entry that is not an object', async (t) => {
  const { s } = await fresh(t, 'entry');
  for (const bad of [null, 'x', 42, ['/x']]) {
    assert.throws(() => s.loadSeats({ seats: [bad] }), { name: 'TypeError', message: /cfg\.seats\[0\]/ }, `entry ${JSON.stringify(bad)} was accepted`);
  }
});

test('loadSeats with no seats configured is an empty pool', async (t) => {
  const { s } = await fresh(t, 'nopool');
  assert.deepEqual(s.loadSeats({ seats: [] }), []);
});

test('loadSeats defaults a missing or empty label to the basename of the resolved dir', async (t) => {
  const { s } = await fresh(t, 'label');
  // The contract sentence: `label` defaults to `basename(config_dir)`. Not refused the way
  // `config_dir: ''` is — a label is a display name, and a deterministic default beats a tick
  // that throws for a missing one.
  const seats = s.loadSeats({ seats: [{ config_dir: '/x/.claude-seat-c' }, { config_dir: '~/.claude-seat-d', label: '' }] });
  assert.deepEqual(seats.map((x) => x.label), ['.claude-seat-c', '.claude-seat-d']);
});

// ---------------------------------------------------------------------------
// readSeatState — tolerant, lock-free, three-state
// ---------------------------------------------------------------------------

test('readSeatState: no file is an empty, readable pool', async (t) => {
  const { s } = await fresh(t, 'nofile');
  assert.deepEqual(s.readSeatState(), { seats: [] });
});

test('readSeatState: anything soma did not write reads as unreadable, with no seats', async (t) => {
  const { s, p } = await fresh(t, 'corrupt');
  // Whole-file, not row-by-row: one bad row is an outside edit, and honouring the rows beside
  // it would rotate a lead onto a seat whose closure was in the line that broke.
  for (const junk of ['', '{', 'null', '[]', '"x"', '42', 'true', '{}', '{"seats": {}}', '{"seats": null}',
    '{"seats": [null]}', '{"seats": ["x"]}', '{"seats": [["/a"]]}', '{"seats": [{"label": "no-dir"}]}',
    '{"seats": [{"config_dir": ""}]}', '{"seats": [{"config_dir": "/a", "closed_until": "soon"}]}',
    '{"seats": [{"config_dir": "/a", "closed_until": -1}]}', '{"seats": [{"config_dir": "/a", "closed_until": null}]}']) {
    writeFileSync(p('state', 'seats.json'), junk);
    assert.deepEqual(s.readSeatState(), { seats: [], unreadable: true }, `readSeatState honoured ${JSON.stringify(junk)}`);
  }
});

test('readSeatState: an unverified that is not a boolean voids the file, exactly as a garbage closed_until does', async (t) => {
  const { s, p, home } = await fresh(t, 'unverified-garbage');
  const a = seatDir(home, 'a');
  // Two governance fields, ONE theory of bad input. MEASURED before the guard: every junk value
  // below normalised to `unverified: false` and `pick` handed the seat back — the permissive
  // reading of the field that says "nobody is logged in", while a garbage `closed_until` already
  // voided the file. Unreadable is the safe direction: `pick` answers null, nothing rotates, and
  // the bytes stay on disk for the hand repair the RUNBOOK's `seats` row tells the operator to
  // make. Nothing soma writes can land here — every published row carries a boolean.
  for (const junk of ['1', '"yes"', '0', '"true"', 'null', '"false"', '{}', '[]', '""']) {
    writeFileSync(p('state', 'seats.json'), `{"seats": [{"config_dir": ${JSON.stringify(a)}, "unverified": ${junk}}]}`);
    assert.deepEqual(s.readSeatState(), { seats: [], unreadable: true }, `readSeatState honoured unverified ${junk}`);
    assert.equal(s.pick(NOW, cfgOf(a)), null, `pick handed back a seat whose unverified was ${junk}`);
  }
});

test('readSeatState: a directory where the file should be is unreadable, not a throw', async (t) => {
  const { s, p } = await fresh(t, 'eisdir');
  // This runs inside the watchdog tick; a throw there ends admission for the whole fleet.
  mkdirSync(p('state', 'seats.json'));
  assert.deepEqual(s.readSeatState(), { seats: [], unreadable: true });
});

test('readSeatState fills the fields an older row lacks and keeps the ones it does not know', async (t) => {
  const { s, p } = await fresh(t, 'shape');
  writeFileSync(p('state', 'seats.json'), JSON.stringify({ seats: [{ config_dir: '/a', future_field: { keep: true } }] }));
  assert.deepEqual(s.readSeatState(), {
    seats: [{ config_dir: '/a', future_field: { keep: true }, label: null, closed_until: 0, closed_reason: null, unverified: false }],
  });
});

// ---------------------------------------------------------------------------
// pick — the first OPEN seat in soma.json order
// ---------------------------------------------------------------------------

test('pick: with no state file the first configured seat is the open one, in the documented shape', async (t) => {
  const { s, home } = await fresh(t, 'pick-fresh');
  const a = seatDir(home, 'a');
  const b = seatDir(home, 'b');
  assert.deepEqual(s.pick(NOW, cfgOf(a, b)), { config_dir: a, label: 'a', closed_until: 0, closed_reason: null, unverified: false });
});

test('pick: soma.json order decides between never-closed seats', async (t) => {
  const { s, home } = await fresh(t, 'pick-order');
  const a = seatDir(home, 'a');
  const b = seatDir(home, 'b');
  assert.equal(s.pick(NOW, cfgOf(b, a)).config_dir, b);
});

test('pick: a closed seat is skipped', async (t) => {
  const { s, home } = await fresh(t, 'pick-closed');
  const a = seatDir(home, 'a');
  const b = seatDir(home, 'b');
  s.close(a, NOW + H, 'five_hour', NOW);
  assert.equal(s.pick(NOW, cfgOf(a, b)).config_dir, b);
});

test('pick: soma.json order beats recency — the first seat wins although its closure is the NEWER', async (t) => {
  const { s, home } = await fresh(t, 'pick-order-over-recency');
  const a = seatDir(home, 'a');
  const b = seatDir(home, 'b');
  s.close(a, NOW + 2 * H, 'five_hour', NOW);
  s.close(b, NOW + H, 'five_hour', NOW);
  // At NOW + 3 h both are open. b's closure is the older one, so the least-recently-closed order
  // this replaced picked b; priority order picks a, because a is first in soma.json. This is the
  // operator's case: the seat they watch is last in the file and must be reached last.
  assert.equal(s.pick(NOW + 3 * H, cfgOf(a, b)).config_dir, a);
  // …and the file's order is the whole of it: the same two closures, listed the other way round,
  // answer b. Without this line a `return open[0]` that never looked at the order would pass.
  assert.equal(s.pick(NOW + 3 * H, cfgOf(b, a)).config_dir, b);
});

test('pick: an EXPIRED closure the limits phase has not cleared does not demote its seat', async (t) => {
  const { s, home } = await fresh(t, 'pick-expired-not-demoted');
  const a = seatDir(home, 'a');
  const b = seatDir(home, 'b');
  // b's closure has passed but `reopenExpired` has not run, so b's row still carries a large past
  // epoch-ms while a sits at 0. Under `closed_until` ascending that put b LAST, behind a
  // never-closed seat — the state the old comment called "at 0" and measurement found is not.
  s.close(b, NOW + H, 'five_hour', NOW);
  assert.equal(s.pick(NOW + 2 * H, cfgOf(b, a)).config_dir, b);
  // Once `reopenExpired` HAS cleared it the answer is the same. That the two agree is the point:
  // rank no longer reads `closed_until` at all, so the pool cannot drift with the limits phase.
  assert.equal(s.reopenExpired(NOW + 2 * H).length, 1);
  assert.equal(s.pick(NOW + 2 * H, cfgOf(b, a)).config_dir, b);
});

test('pick: a never-closed seat does NOT outrank an earlier-listed seat whose closure expired', async (t) => {
  const { s, home } = await fresh(t, 'pick-zero');
  const a = seatDir(home, 'a');
  const b = seatDir(home, 'b');
  const c = seatDir(home, 'c');
  // c has never been closed and so sorted first under `closed_until` ascending. It is last in
  // soma.json, and a and b are open again at NOW + 2 h, so priority order never reaches it.
  s.close(a, NOW + H, 'five_hour', NOW);
  s.close(b, NOW + H, 'five_hour', NOW);
  assert.equal(s.pick(NOW + 2 * H, cfgOf(a, b, c)).config_dir, a);
  // Still closed at NOW + H - 1, both of them: then the never-closed seat IS the first open one.
  assert.equal(s.pick(NOW + H - 1, cfgOf(a, b, c)).config_dir, c);
});

test('pick: the preferred seat being unverified falls THROUGH, it does not block the pool', async (t) => {
  const { s, home } = await fresh(t, 'pick-unverified-fallthrough');
  const a = seatDir(home, 'a');
  const b = seatDir(home, 'b');
  const c = seatDir(home, 'c');
  // Priority order concentrates load on the head of the file, so the head is also where a
  // logged-out or closed seat would stall every launch if it were a stop rather than a skip.
  s.markUnverified(a, true);
  s.close(b, NOW + H, 'five_hour', NOW);
  assert.equal(s.pick(NOW, cfgOf(a, b, c)).config_dir, c);
});

test('pick: a malformed entry AFTER the seat it picks is still the TypeError it always was', async (t) => {
  const { s, home } = await fresh(t, 'pick-eager-loadseats');
  const a = seatDir(home, 'a');
  // The early return reads only as far as the first open seat, so "a malformed `soma.json` is a
  // loud TypeError" stopped being structural here: under the sort it held for ANY `loadSeats`,
  // because the loop drained the iterable before ranking; now it holds only because `loadSeats`
  // is `raw.map(...)`, fully evaluated before the first iteration. The `pick` JSDoc asserts that,
  // and until this line nothing checked it. MEASURED: with `loadSeats` rewritten as a generator,
  // `pick` returns `a` and never looks at `seats[1]` — and the only tests that redden are the
  // eight `loadSeats` ones, not one `pick` test. So the next person to make `loadSeats` lazy (the
  // obvious optimisation, precisely BECAUSE `pick` short-circuits) would have fixed those eight
  // and shipped a `pick` that hands back a seat out of a config file the fleet cannot read.
  assert.throws(() => s.pick(NOW, { seats: [{ config_dir: a, label: 'a' }, null] }),
    { name: 'TypeError', message: /cfg\.seats\[1\]/ });
});

test('pick: a seat is open at exactly closed_until', async (t) => {
  const { s, home } = await fresh(t, 'pick-boundary-open');
  const a = seatDir(home, 'a');
  s.close(a, NOW + H, 'five_hour', NOW);
  // The limits phase reopens on the same comparison; the two must agree or admission would
  // refuse a seat the next tick reopens anyway.
  assert.equal(s.pick(NOW + H, cfgOf(a))?.config_dir, a);
});

test('pick: a seat is closed one millisecond before closed_until', async (t) => {
  const { s, home } = await fresh(t, 'pick-boundary-closed');
  const a = seatDir(home, 'a');
  s.close(a, NOW + H, 'five_hour', NOW);
  assert.equal(s.pick(NOW + H - 1, cfgOf(a)), null);
});

test('pick: an unverified seat is skipped', async (t) => {
  const { s, home } = await fresh(t, 'pick-unverified');
  const a = seatDir(home, 'a');
  const b = seatDir(home, 'b');
  s.markUnverified(a, true);
  assert.equal(s.pick(NOW, cfgOf(a, b)).config_dir, b);
});

test('pick: clearing unverified puts the seat back in rotation', async (t) => {
  const { s, home } = await fresh(t, 'pick-reverified');
  const a = seatDir(home, 'a');
  const b = seatDir(home, 'b');
  s.markUnverified(a, true);
  s.markUnverified(a, false);
  assert.equal(s.pick(NOW, cfgOf(a, b)).config_dir, a);
});

test('pick: null when every configured seat is closed', async (t) => {
  const { s, home } = await fresh(t, 'pick-all-closed');
  const a = seatDir(home, 'a');
  const b = seatDir(home, 'b');
  s.close(a, NOW + H, 'five_hour', NOW);
  s.close(b, NOW + H, 'seven_day', NOW);
  assert.equal(s.pick(NOW, cfgOf(a, b)), null);
});

test('pick: null when no seat is configured', async (t) => {
  const { s } = await fresh(t, 'pick-none');
  assert.equal(s.pick(NOW, { seats: [] }), null);
});

test('pick: null when the state file is unreadable, whatever soma.json says', async (t) => {
  const { s, p, home } = await fresh(t, 'pick-unreadable');
  const a = seatDir(home, 'a');
  // Fail closed for the kill: no seat means no rotation, and the bytes stay for repair.
  writeFileSync(p('state', 'seats.json'), '{"seats": [');
  assert.equal(s.pick(NOW, cfgOf(a)), null);
});

test("pick: the picked seat carries the file's closure fields and soma.json's label", async (t) => {
  const { s, p, home } = await fresh(t, 'pick-view');
  const a = seatDir(home, 'a');
  writeFileSync(p('state', 'seats.json'), JSON.stringify({
    seats: [{ config_dir: a, label: 'stale-name', closed_until: NOW + H, closed_reason: 'seven_day', unverified: false }],
  }));
  // soma.json is authoritative for the label; the state file's copy is a courtesy.
  assert.deepEqual(s.pick(NOW + 2 * H, cfgOf(a)), { config_dir: a, label: 'a', closed_until: NOW + H, closed_reason: 'seven_day', unverified: false });
});

test('pick refuses a non-finite clock', async (t) => {
  const { s, home } = await fresh(t, 'pick-clock');
  const a = seatDir(home, 'a');
  for (const bad of [undefined, null, NaN, 'now', Infinity]) {
    assert.throws(() => s.pick(bad, cfgOf(a)), { name: 'TypeError', message: /nowMs/ }, `nowMs ${String(bad)} was accepted`);
  }
});

// ---------------------------------------------------------------------------
// close — the floor, and never shorter
// ---------------------------------------------------------------------------

test('MIN_CLOSE_MS is five minutes', () => {
  assert.equal(MIN_CLOSE_MS, 5 * 60 * 1000);
});

test('close floors a past reset at MIN_CLOSE_MS from now', async (t) => {
  const { s, p, home } = await fresh(t, 'floor-past');
  const a = seatDir(home, 'a');
  // MEASURED: resetsAt is non-monotonic (design §9), and a past value must not reopen a seat
  // the API just refused.
  s.close(a, NOW - 1000, 'five_hour', NOW);
  assert.equal(rows(p)[0].closed_until, NOW + MIN_CLOSE_MS);
});

test('close floors a reset inside the window at MIN_CLOSE_MS from now', async (t) => {
  const { s, p, home } = await fresh(t, 'floor-short');
  const a = seatDir(home, 'a');
  s.close(a, NOW + 60_000, 'five_hour', NOW);
  assert.equal(rows(p)[0].closed_until, NOW + MIN_CLOSE_MS);
});

test('close keeps a reset past the floor as it is', async (t) => {
  const { s, p, home } = await fresh(t, 'floor-long');
  const a = seatDir(home, 'a');
  s.close(a, NOW + 3 * H, 'five_hour', NOW);
  assert.equal(rows(p)[0].closed_until, NOW + 3 * H);
});

test('close records the reason', async (t) => {
  const { s, p, home } = await fresh(t, 'reason');
  const a = seatDir(home, 'a');
  s.close(a, NOW + 3 * H, 'seven_day_opus', NOW);
  assert.equal(rows(p)[0].closed_reason, 'seven_day_opus');
});

test('close normalises a reason that is not a non-empty string to null, in the file itself', async (t) => {
  const { s, p, home } = await fresh(t, 'reason-normalise');
  // Only the file can see this. `readSeatState` re-normalises a non-string back to null on the
  // way in, so a writer that persisted `42`, `''` or `{}` would read back clean and look right —
  // while `state/seats.json` is the file the RUNBOOK tells an operator to open and repair by hand.
  for (const [i, bad] of [undefined, null, '', 42, {}, ['five_hour']].entries()) {
    const dir = seatDir(home, `r-${i}`);
    s.close(dir, NOW + 3 * H, bad, NOW);
    assert.equal(rows(p).find((r) => r.config_dir === dir).closed_reason, null, `reason ${JSON.stringify(bad)} reached the file as it came`);
  }
});

test('close never shortens an existing longer closure', async (t) => {
  const { s, p, home } = await fresh(t, 'no-shorten');
  const a = seatDir(home, 'a');
  s.close(a, NOW + 3 * H, 'seven_day', NOW);
  // A seat closed to the reset for `seven_day` must not be pulled back by a later `five_hour` row.
  s.close(a, NOW + H, 'five_hour', NOW);
  assert.equal(rows(p)[0].closed_until, NOW + 3 * H);
});

test('a close that would shorten leaves the reason, the bytes and the inode alone', async (t) => {
  const { s, p, home } = await fresh(t, 'no-shorten-bytes');
  const a = seatDir(home, 'a');
  s.close(a, NOW + 3 * H, 'seven_day', NOW);
  const before = readFileSync(p('state', 'seats.json'), 'utf8');
  const ino = statSync(p('state', 'seats.json')).ino;
  s.close(a, NOW + H, 'five_hour', NOW);
  assert.equal(readFileSync(p('state', 'seats.json'), 'utf8'), before);
  // Bytes alone cannot see a rewrite of identical content — a tmp+rename of the same JSON passes
  // the line above. The module's claim ("leaves the file's bytes - and inode - alone") is about
  // the WRITE, and only the inode can observe that one did not happen.
  assert.equal(statSync(p('state', 'seats.json')).ino, ino, 'the pool was re-published with identical bytes');
});

test('a longer re-close extends the closure and takes the new reason', async (t) => {
  const { s, p, home } = await fresh(t, 'extend');
  const a = seatDir(home, 'a');
  s.close(a, NOW + H, 'five_hour', NOW);
  s.close(a, NOW + 3 * H, 'seven_day', NOW);
  assert.deepEqual([rows(p)[0].closed_until, rows(p)[0].closed_reason], [NOW + 3 * H, 'seven_day']);
});

test('close treats a non-finite untilMs as the floor and leaves the file readable', async (t) => {
  const { s, p, home } = await fresh(t, 'nan-until');
  const a = seatDir(home, 'a');
  // Math.max(NaN, floor) is NaN, JSON.stringify writes NaN as null, and the next read would
  // refuse the whole file as unreadable — the one way this module could corrupt its own state.
  for (const [i, bad] of [undefined, NaN, 'soon', Infinity].entries()) {
    const dir = seatDir(home, `nan-${i}`);
    s.close(dir, bad, 'five_hour', NOW);
    assert.equal(rows(p).find((r) => r.config_dir === dir).closed_until, NOW + MIN_CLOSE_MS, `untilMs ${String(bad)} did not floor`);
  }
  assert.equal(s.readSeatState().unreadable, undefined, 'a garbage untilMs corrupted seats.json');
});

test('close returns the whole pool as it now reads', async (t) => {
  const { s, home } = await fresh(t, 'close-returns');
  const a = seatDir(home, 'a');
  const b = seatDir(home, 'b');
  s.close(a, NOW + H, 'five_hour', NOW);
  assert.deepEqual(s.close(b, NOW + 2 * H, 'seven_day', NOW), s.readSeatState());
});

test('close keys the row on the resolved dir, so ~/x and its absolute spelling are one seat', async (t) => {
  const { s, p } = await fresh(t, 'close-tilde');
  s.close('~/.soma-seat-test-z', NOW + H, 'five_hour', NOW);
  s.close(join(homedir(), '.soma-seat-test-z'), NOW + 2 * H, 'five_hour', NOW);
  assert.deepEqual(rows(p).map((r) => [r.config_dir, r.closed_until]), [[join(homedir(), '.soma-seat-test-z'), NOW + 2 * H]]);
});

test('close copies the label soma.json gives the seat, and null for a dir it does not name', async (t) => {
  const { s, p, home } = await fresh(t, 'close-label');
  const a = seatDir(home, 'a');
  const b = seatDir(home, 'b');
  writeFileSync(p('soma.json'), JSON.stringify({ seats: [{ config_dir: a, label: 'seat-a' }] }));
  s.close(a, NOW + H, 'five_hour', NOW);
  s.close(b, NOW + H, 'five_hour', NOW);
  assert.deepEqual(rows(p).map((r) => r.label), ['seat-a', null]);
});

test('close refuses a non-finite nowMs', async (t) => {
  const { s, home } = await fresh(t, 'close-clock');
  const a = seatDir(home, 'a');
  for (const bad of [null, NaN, 'now', Infinity]) {
    assert.throws(() => s.close(a, NOW + H, 'five_hour', bad), { name: 'TypeError', message: /nowMs/ }, `nowMs ${String(bad)} was accepted`);
  }
});

test("close refuses config_dir '' before touching the file", async (t) => {
  const { s, p } = await fresh(t, 'close-empty');
  assert.throws(() => s.close('', NOW + H, 'five_hour', NOW), { name: 'TypeError', message: /config_dir/ });
  assert.equal(existsSync(p('state', 'seats.json')), false);
});

test('close on an unreadable file writes nothing and hands the unreadable state back', async (t) => {
  const { s, p, home } = await fresh(t, 'close-unreadable');
  const a = seatDir(home, 'a');
  writeFileSync(p('state', 'seats.json'), '{"seats": [');
  // "Repairing" the pool by rewriting it would forget every closure it held, and the next pick
  // would rotate onto a seat that is still closed. The bytes stay for a human, as readFleet
  // leaves a torn checkpoint.
  assert.deepEqual(s.close(a, NOW + H, 'five_hour', NOW), { seats: [], unreadable: true });
  assert.equal(readFileSync(p('state', 'seats.json'), 'utf8'), '{"seats": [', 'a corrupt pool was overwritten');
});

// ---------------------------------------------------------------------------
// close — the plausibility ceiling (carried forward from the classifier's review)
// ---------------------------------------------------------------------------

test('MAX_CLOSE_MS is 32 days — one day past the longest closure the classifier can produce', async (t) => {
  const { s } = await fresh(t, 'ceiling-const');
  // MEASURED against the classifier's nextMonthStartMs over every month of 2026-2030: the longest
  // legitimate verdict is a seat_cap, whose resetsAt is the 1st after the hit, and that is at
  // most 31 days ahead (a hit at 00:00:00.000Z on the 1st of a 31-day month). Every other
  // verdict is bounded by its own window — five_hour 5 h, the seven_day family 7 days. The one
  // day of headroom is for the skew between the API clock that stamps resetsAt and the host
  // clock close reads as nowMs; a host further out than that has already broken lease staleness
  // and every budget window.
  assert.equal(s.MAX_CLOSE_MS, 32 * 24 * 60 * 60 * 1000);
});

test('close caps an in-band but absurd resetsAt at MAX_CLOSE_MS from now', async (t) => {
  const { s, p, home } = await fresh(t, 'ceiling-absurd');
  const a = seatDir(home, 'a');
  // MEASURED through the real classifier: quotaLimits.resetsAt 3.25e10 SECONDS is inside its
  // units band (< 1e11, the year 5138), so classifyLimit believes the row and returns
  // { kind: 'seat_window', rateLimitType: 'five_hour', resetsAt: 32500000000000 } —
  // 2999-11-19T09:46:40Z, 973 years out. A closure is never shortened and reopenExpired only
  // clears expired ones, so without a ceiling that single row retires the seat until a human
  // edits state/seats.json. The floor and the ceiling are the same argument in both directions.
  s.close(a, 32_500_000_000_000, 'five_hour', NOW);
  assert.equal(rows(p)[0].closed_until, NOW + s.MAX_CLOSE_MS);
});

test('close leaves the longest legitimate closure — a 31-day monthly cap — exactly as it is', async (t) => {
  const { s, p, home } = await fresh(t, 'ceiling-spares-cap');
  const a = seatDir(home, 'a');
  // The other half of the ceiling, and the reason it is not tighter: a cap below 31 days would
  // reopen a seat whose organisation cannot pay for it until the 1st, and the classifier would
  // close it again on the next tick — a rotation storm against a seat that cannot serve.
  s.close(a, NOW + 31 * 24 * H, 'org_spend_cap_reached', NOW);
  assert.equal(rows(p)[0].closed_until, NOW + 31 * 24 * H);
});

test('a seat closed on an absurd reset comes back, which is what the ceiling is for', async (t) => {
  const { s, home } = await fresh(t, 'ceiling-reopens');
  const a = seatDir(home, 'a');
  s.close(a, 32_500_000_000_000, 'five_hour', NOW);
  // The invariant stated end to end: no row, however absurd, can take a seat out of the pool
  // for longer than the ceiling.
  assert.deepEqual(s.reopenExpired(NOW + s.MAX_CLOSE_MS).map((r) => r.config_dir), [a]);
});

// ---------------------------------------------------------------------------
// close — what a SECOND tick does, per input class (the contract's idempotence clause)
// ---------------------------------------------------------------------------

test('a second tick with the same ordinary untilMs writes nothing — the no-op the contract claims', async (t) => {
  const { s, p, home } = await fresh(t, 'tick-ordinary');
  const a = seatDir(home, 'a');
  const fp = p('state', 'seats.json');
  // The limits phase re-reads the same rate_limit row every tick until it clears, so "a second
  // tick reading the same limit row" is the module's own worked example, not a hypothetical.
  s.close(a, NOW + 3 * H, 'five_hour', NOW);
  const [bytes, ino] = [readFileSync(fp, 'utf8'), statSync(fp).ino];
  s.close(a, NOW + 3 * H, 'five_hour', NOW + 30_000);
  assert.deepEqual([readFileSync(fp, 'utf8'), statSync(fp).ino], [bytes, ino], 'an unchanged ordinary closure was re-published');
});

test('a floored closure re-arms from the new nowMs — a real change every tick, and no reopen between them', async (t) => {
  const { s, p, home } = await fresh(t, 'tick-floored');
  const a = seatDir(home, 'a');
  const fp = p('state', 'seats.json');
  // MEASURED, four 30 s ticks with one untilMs: an ordinary reset rewrites nothing after the
  // first close; a floored one rewrites on every tick, closed_until sliding forward with nowMs.
  // The module says so where `close` is declared — this is the half of that sentence that an
  // earlier wording denied.
  s.close(a, NOW - 1000, 'five_hour', NOW);
  const ino = statSync(fp).ino;
  s.close(a, NOW - 1000, 'five_hour', NOW + 30_000);
  assert.equal(rows(p)[0].closed_until, NOW + 30_000 + MIN_CLOSE_MS, 'the floor did not re-arm from the new clock');
  assert.notEqual(statSync(fp).ino, ino, 'a re-armed closure must be a real write, not a silent no-op');
  // And so the seat cannot reopen while that row keeps arriving: the floor is always ahead of now.
  assert.deepEqual(s.reopenExpired(NOW + 30_000), [], 'a re-armed closure reopened under the clock that armed it');
});

test('the floored seat DOES reopen once ticks are further apart than MIN_CLOSE_MS — the precondition on that clause', async (t) => {
  const { s, home } = await fresh(t, 'tick-floored-boundary');
  const a = seatDir(home, 'a');
  // The sibling above pins the 30 s case; `close`'s comment used to state the no-reopen half
  // without its precondition. MEASURED, one floored seat with reopenExpired at the next tick
  // before that tick's close: 30_000 ms -> 0 reopened, 299_999 -> 0, 300_000 -> 1, 600_000 -> 1.
  // The boundary is MIN_CLOSE_MS itself, so the clause holds only while ticks are closer together
  // than the floor — true of DEFAULTS.tick_ms (30 s, a 10x margin), not of a stalled or restarted
  // watchdog. Both sides are asserted, so neither an earlier nor a later boundary survives.
  s.close(a, NOW - 1000, 'five_hour', NOW);
  assert.deepEqual(s.reopenExpired(NOW + MIN_CLOSE_MS - 1), [], 'a floored seat reopened one ms before its floor');
  assert.equal(s.reopenExpired(NOW + MIN_CLOSE_MS).length, 1, 'a floored seat did not reopen at exactly its floor');
});

test('a capped closure re-arms the same way, so the ceiling is a sliding 32 days and not a retirement', async (t) => {
  const { s, p, home } = await fresh(t, 'tick-capped');
  const a = seatDir(home, 'a');
  const fp = p('state', 'seats.json');
  s.close(a, 32_500_000_000_000, 'five_hour', NOW);
  const ino = statSync(fp).ino;
  s.close(a, 32_500_000_000_000, 'five_hour', NOW + 30_000);
  assert.equal(rows(p)[0].closed_until, NOW + 30_000 + s.MAX_CLOSE_MS, 'the ceiling did not re-arm from the new clock');
  assert.notEqual(statSync(fp).ino, ino, 'a re-armed closure must be a real write, not a silent no-op');
});

// ---------------------------------------------------------------------------
// reopenExpired — exactly the reopened, idempotent
// ---------------------------------------------------------------------------

test('reopenExpired returns exactly the seats whose closure has passed, as they now read', async (t) => {
  const { s, home } = await fresh(t, 'reopen-returns');
  const a = seatDir(home, 'a');
  const b = seatDir(home, 'b');
  seatDir(home, 'c');
  s.close(a, NOW + H, 'five_hour', NOW);
  s.close(b, NOW + 2 * H, 'five_hour', NOW);
  assert.deepEqual(s.reopenExpired(NOW + H), [{ config_dir: a, label: null, closed_until: 0, closed_reason: null, unverified: false }]);
});

test('reopenExpired opens them in the file and leaves the others closed', async (t) => {
  const { s, p, home } = await fresh(t, 'reopen-file');
  const a = seatDir(home, 'a');
  const b = seatDir(home, 'b');
  s.close(a, NOW + H, 'five_hour', NOW);
  s.close(b, NOW + 2 * H, 'seven_day', NOW);
  s.reopenExpired(NOW + H);
  assert.deepEqual(rows(p).map((r) => [r.closed_until, r.closed_reason]), [[0, null], [NOW + 2 * H, 'seven_day']]);
});

test('reopenExpired is idempotent: a second call returns [] and writes nothing', async (t) => {
  const { s, p, home } = await fresh(t, 'reopen-idem');
  const a = seatDir(home, 'a');
  s.close(a, NOW + H, 'five_hour', NOW);
  s.reopenExpired(NOW + H);
  const before = readFileSync(p('state', 'seats.json'), 'utf8');
  const ino = statSync(p('state', 'seats.json')).ino;
  assert.deepEqual(s.reopenExpired(NOW + H), []);
  assert.equal(readFileSync(p('state', 'seats.json'), 'utf8'), before, 'an idempotent no-op rewrote the file');
  assert.equal(statSync(p('state', 'seats.json')).ino, ino, 'an idempotent no-op re-published identical bytes');
});

test('reopenExpired leaves unverified in place — a clock does not log anyone in', async (t) => {
  const { s, home } = await fresh(t, 'reopen-unverified');
  const a = seatDir(home, 'a');
  s.markUnverified(a, true);
  s.close(a, NOW + H, 'five_hour', NOW);
  assert.equal(s.reopenExpired(NOW + H)[0].unverified, true);
});

test('reopenExpired on an unreadable file reopens nothing and leaves the bytes for repair', async (t) => {
  const { s, p } = await fresh(t, 'reopen-unreadable');
  writeFileSync(p('state', 'seats.json'), '{"seats": [');
  assert.deepEqual(s.reopenExpired(NOW), []);
  assert.equal(readFileSync(p('state', 'seats.json'), 'utf8'), '{"seats": [', 'a corrupt pool was overwritten');
});

test('reopenExpired with nothing to do writes no file at all', async (t) => {
  const { s, p } = await fresh(t, 'reopen-nothing');
  assert.deepEqual(s.reopenExpired(NOW), []);
  assert.equal(existsSync(p('state', 'seats.json')), false);
});

test('reopenExpired refuses a non-finite clock', async (t) => {
  const { s } = await fresh(t, 'reopen-clock');
  for (const bad of [null, NaN, 'now']) {
    assert.throws(() => s.reopenExpired(bad), { name: 'TypeError', message: /nowMs/ }, `nowMs ${String(bad)} was accepted`);
  }
});

// ---------------------------------------------------------------------------
// markUnverified
// ---------------------------------------------------------------------------

test('markUnverified refuses anything but true or false, and writes nothing', async (t) => {
  const { s, p, home } = await fresh(t, 'unverified-refuse');
  const a = seatDir(home, 'a');
  // The dangerous direction is `markUnverified(dir, undefined)` — a caller that read a field
  // which was not there — silently CLEARING the flag on a seat nobody is logged in to.
  for (const bad of [undefined, null, 0, 1, '', 'true', 'false', {}, []]) {
    assert.throws(() => s.markUnverified(a, bad), /true or false/, `${JSON.stringify(bad)} was accepted`);
  }
  assert.equal(existsSync(p('state', 'seats.json')), false);
});

test('markUnverified flags a seat the file has never seen, creating its row open', async (t) => {
  const { s, p, home } = await fresh(t, 'unverified-create');
  const a = seatDir(home, 'a');
  s.markUnverified(a, true);
  assert.deepEqual(rows(p), [{ config_dir: a, label: null, closed_until: 0, closed_reason: null, unverified: true }]);
});

test('markUnverified keys the row on the resolved dir, so ~/x and its absolute spelling are one seat', async (t) => {
  const { s, p } = await fresh(t, 'unverified-tilde');
  // As `close keys the row on the resolved dir…` does for the other writer. Only the STRING
  // reaches disk — into the temp-root state file — so nothing is created under the real $HOME.
  // Unresolved, the second call would open a SECOND row for a seat that already has one, and
  // `pick` would hand back a dir spelled `~/…` that no launch can use.
  s.markUnverified('~/.soma-seat-test-mu', true);
  s.markUnverified(join(homedir(), '.soma-seat-test-mu'), false);
  assert.deepEqual(rows(p).map((r) => [r.config_dir, r.unverified]), [[join(homedir(), '.soma-seat-test-mu'), false]]);
});

test('markUnverified false clears the flag and keeps the closure', async (t) => {
  const { s, p, home } = await fresh(t, 'unverified-clear');
  const a = seatDir(home, 'a');
  s.close(a, NOW + H, 'five_hour', NOW);
  s.markUnverified(a, true);
  s.markUnverified(a, false);
  assert.deepEqual([rows(p)[0].unverified, rows(p)[0].closed_until], [false, NOW + H]);
});

test('markUnverified with the flag already set writes nothing', async (t) => {
  const { s, p, home } = await fresh(t, 'unverified-idem');
  const a = seatDir(home, 'a');
  s.markUnverified(a, true);
  const before = readFileSync(p('state', 'seats.json'), 'utf8');
  const ino = statSync(p('state', 'seats.json')).ino;
  s.markUnverified(a, true);
  assert.equal(readFileSync(p('state', 'seats.json'), 'utf8'), before);
  // The short-circuit at `row.unverified === flag`, and rowFor's `created` flag for a row that
  // already exists: both write identical bytes when they break, so bytes cannot see either.
  assert.equal(statSync(p('state', 'seats.json')).ino, ino, 'an already-set flag re-published the pool');
});

test('markUnverified on an unreadable file writes nothing and hands the unreadable state back', async (t) => {
  const { s, p, home } = await fresh(t, 'unverified-unreadable');
  const a = seatDir(home, 'a');
  writeFileSync(p('state', 'seats.json'), '{"seats": [');
  assert.deepEqual(s.markUnverified(a, true), { seats: [], unreadable: true });
  assert.equal(readFileSync(p('state', 'seats.json'), 'utf8'), '{"seats": [', 'a corrupt pool was overwritten');
});

// ---------------------------------------------------------------------------
// The lock and the publish — pinned as in lease.test.mjs
// ---------------------------------------------------------------------------

test('every mutation releases the fleet lock', async (t) => {
  const { s, p, home } = await fresh(t, 'release');
  const a = seatDir(home, 'a');
  s.close(a, NOW + H, 'five_hour', NOW);
  s.markUnverified(a, true);
  s.reopenExpired(NOW + H);
  assert.equal(existsSync(p('state', 'fleet.lock')), false);
});

test('the pool is published by rename, never truncated in place', async (t) => {
  const { s, p, home } = await fresh(t, 'rename');
  const a = seatDir(home, 'a');
  s.close(a, NOW + H, 'five_hour', NOW);
  // An in-place writeFileSync reuses the inode; a rename installs a new one. That is what lets
  // the lock-free readers see a whole old pool or a whole new one.
  const ino = statSync(p('state', 'seats.json')).ino;
  s.close(a, NOW + 2 * H, 'seven_day', NOW);
  assert.notEqual(statSync(p('state', 'seats.json')).ino, ino);
});

test('tmp+rename leaves no scratch behind', async (t) => {
  const { s, p, home } = await fresh(t, 'scratch');
  const a = seatDir(home, 'a');
  s.close(a, NOW + H, 'five_hour', NOW);
  s.reopenExpired(NOW + H);
  // Every name the writer can produce, not just *.tmp: its scratch is built from the published
  // path (`${fp}.<pid>.tmp`), so a scratch renamed to anything and then leaked still shows up
  // here. Filtered to this file's own names so an unrelated new file in state/ —
  // backpressure.json, say — is not a false red.
  assert.deepEqual(readdirSync(p('state')).filter((n) => n.startsWith('seats.json')), ['seats.json']);
});

test('the scratch is seats.json.<pid>.tmp — the pid suffix is the defence against two writers', async (t) => {
  const { s, p, home } = await fresh(t, 'scratch-name');
  const a = seatDir(home, 'a');
  // The scratch exists only between writeFileSync and renameSync, inside the lock, so no reader
  // can catch it in flight. Occupying the exact name with a DIRECTORY makes the writer say which
  // name it picked: a directory cannot be opened for writing, so the publish fails loudly iff the
  // writer used this name, and silently succeeds under any other. That pins both halves the
  // module claims — the pid (two writers never share a scratch) and the .tmp suffix (which is
  // what the leak check above is written to recognise).
  mkdirSync(p('state', `seats.json.${process.pid}.tmp`));
  assert.throws(
    () => s.close(a, NOW + H, 'five_hour', NOW),
    (e) => e.code === 'EISDIR' && e.message.includes(`seats.json.${process.pid}.tmp`),
    'the writer did not open state/seats.json.<pid>.tmp',
  );
  assert.equal(existsSync(p('state', 'seats.json')), false, 'the pool was published under a name this test could not predict');
  // And a writer that throws mid-publish still leaves the fleet lock released for the next tick.
  assert.equal(existsSync(p('state', 'fleet.lock')), false, 'a throwing publish leaked fleet.lock');
});

test('the first close writes a row for that seat only — the rest of soma.json stays implicit', async (t) => {
  const { s, p, home } = await fresh(t, 'first-close');
  const a = seatDir(home, 'a');
  seatDir(home, 'b');
  s.close(a, NOW + H, 'five_hour', NOW);
  assert.deepEqual(rows(p).map((r) => r.config_dir), [a]);
});

test('the writer carries no ENOENT self-heal of its own, because withFleetLock already made state/', async (t) => {
  const { s, p, home } = await fresh(t, 'wiped');
  const a = seatDir(home, 'a');
  // Pinned as lease.test pins writeLease: a tree wiped under a running fleet stays one mkdir.
  rmSync(p('state'), { recursive: true, force: true });
  s.close(a, NOW + H, 'five_hour', NOW);
  assert.equal(s.readSeatState().seats[0].closed_until, NOW + H);
});

test('seat mutations compose inside a fleet mutation, so it is THE fleet lock and not a private one', async (t) => {
  const { s, f, home } = await fresh(t, 'compose');
  const a = seatDir(home, 'a');
  f.enqueue([{ id: 'cr-1', title: 't', repo: 'r', source: {}, brief: 'b' }]);
  // The watchdog closes a seat and stamps the row's `seat` in one breath. A second lock
  // instance on the same file would see this process's live pid, wait 5 s and throw.
  f.updateFleet((fleet) => {
    s.close(a, NOW + H, 'five_hour', NOW);
    fleet.tasks[0].seat = 'a';
  });
  assert.deepEqual([s.readSeatState().seats[0].closed_until, f.readFleet().tasks[0].seat], [NOW + H, 'a']);
});

test('a mutation waits for a live fleet-lock holder instead of writing beside it', async (t) => {
  const { s, f, p, home } = await fresh(t, 'contention');
  const a = seatDir(home, 'a');
  const go = join(home, 'go');
  const entered = join(home, 'entered');
  const seatsFile = p('state', 'seats.json');

  // A second process, because that is the shape the lock exists for: the bus (soma_status,
  // doctor) and the watchdog's limits phase share this file. The child waits for `go`, marks
  // `entered`, then calls close() — which must block on the lock this process is holding.
  // Sever the withFleetLock call in mutateSeats and the file appears while we hold the lock.
  const src = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { close } from ${JSON.stringify(seatsUrl)};
    const deadline = Date.now() + 5000;
    while (!existsSync(${JSON.stringify(go)}) && Date.now() < deadline);
    writeFileSync(${JSON.stringify(entered)}, '');
    close(${JSON.stringify(a)}, ${NOW + H}, 'five_hour', ${NOW});
  `;
  const child = new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, ['--input-type=module', '-e', src], {
      env: { ...process.env, SOMA_HOME: home },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('error', reject);
    cp.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${err}`))));
  });

  let fileWhileHeld = null;
  f.withFleetLock(() => {
    writeFileSync(go, '');
    const deadline = Date.now() + 5000;
    while (!existsSync(entered) && Date.now() < deadline);
    assert.equal(existsSync(entered), true, 'the child never reached close()');
    spin(300); // the child is inside close() now; unlocked, it would have written within a few ms
    fileWhileHeld = existsSync(seatsFile);
  });
  assert.equal(fileWhileHeld, false, 'close() published the pool while another process held fleet.lock');
  await child;
  assert.equal(s.readSeatState().seats[0]?.closed_until, NOW + H, 'the wait must end in the write, once the lock is released');
});

// ---------------------------------------------------------------------------
// loggedIn — three states, a file read
// (the mark's key name and value type are observed against two real .claude.json files; every
// other key in these bodies is spec-derived — see the FIXTURE NOTE on seatDir)
// ---------------------------------------------------------------------------

test('loggedIn is true when .claude.json carries an oauthAccount object', async (t) => {
  const { s, home } = await fresh(t, 'login-true');
  const a = seatDir(home, 'a', { numStartups: 3, oauthAccount: { accountUuid: 'u-1', emailAddress: 'op@example.com' } });
  assert.equal(s.loggedIn(a), true);
});

test('loggedIn is false when .claude.json has no oauthAccount', async (t) => {
  const { s, home } = await fresh(t, 'login-false');
  const a = seatDir(home, 'a', { numStartups: 3, mcpServers: {} });
  assert.equal(s.loggedIn(a), false);
});

test('loggedIn is false when oauthAccount is null', async (t) => {
  const { s, home } = await fresh(t, 'login-null-account');
  const a = seatDir(home, 'a', { oauthAccount: null });
  assert.equal(s.loggedIn(a), false);
});

test('loggedIn is false when oauthAccount is an array — typeof [] is "object", and no login writes one', async (t) => {
  const { s, home } = await fresh(t, 'login-array-account');
  // The dangerous direction, and the reason this is not pedantry: `rotate()` skips anything but
  // `true`, so an array reading as the POSITIVE verdict would say "this seat is usable" about
  // garbage. The mark is an object in both real config dirs the FIXTURE NOTE names, so an array
  // can only be a hand edit or a half-written file. `false`, not `null`: the file parsed, so the
  // absence of a usable mark IS observed.
  for (const [i, body] of ['{"oauthAccount": []}', '{"oauthAccount": [1, 2]}', '{"oauthAccount": [{"accountUuid": "u-1"}]}'].entries()) {
    assert.equal(s.loggedIn(seatDir(home, `arr${i}`, body)), false, `${body} was read as a login state`);
  }
});

test('loggedIn is null when .claude.json is not JSON', async (t) => {
  const { s, home } = await fresh(t, 'login-torn');
  const a = seatDir(home, 'a', '{"oauthAccount": {');
  assert.equal(s.loggedIn(a), null);
});

test('loggedIn is null when .claude.json is JSON but not an object', async (t) => {
  const { s, home } = await fresh(t, 'login-nonobject');
  for (const [i, body] of ['[]', '"x"', '42', 'null'].entries()) {
    assert.equal(s.loggedIn(seatDir(home, `a${i}`, body)), null, `${body} was read as a login state`);
  }
});

test('loggedIn is null when .claude.json is a directory', async (t) => {
  const { s, home } = await fresh(t, 'login-eisdir');
  const a = seatDir(home, 'a');
  mkdirSync(join(a, '.claude.json'));
  assert.equal(s.loggedIn(a), null);
});

test('loggedIn is null when the dir exists but has no .claude.json', async (t) => {
  const { s, home } = await fresh(t, 'login-nofile');
  // A fresh seat dir before its first `claude auth login`: not "logged out", not observable.
  assert.equal(s.loggedIn(seatDir(home, 'a')), null);
});

test('loggedIn is null when the dir does not exist', async (t) => {
  const { s, home } = await fresh(t, 'login-nodir');
  assert.equal(s.loggedIn(join(home, 'seats', 'nope')), null);
});

test("loggedIn refuses '' and a non-string dir rather than reading the cwd's own .claude.json", async (t) => {
  const { s } = await fresh(t, 'login-refuses');
  // Unresolved, `join('', '.claude.json')` is the RELATIVE path `.claude.json`: under a running
  // fleet the cwd is a repo checkout, and its own `.claude.json` would answer `true` for a seat
  // that does not exist. The refusal is `resolveConfigDir`'s, and this is what pins it here.
  for (const bad of ['', undefined, null, 42, ['/x']]) {
    assert.throws(() => s.loggedIn(bad), { name: 'TypeError', message: /config_dir/ }, `${JSON.stringify(bad)} was accepted`);
  }
});

test('loggedIn expands a ~-prefixed seat instead of looking for a directory named ~', async (t) => {
  const { s, home } = await fresh(t, 'login-tilde');
  // os.homedir() reads $HOME on POSIX, so pointing $HOME at this test's own root keeps the whole
  // test inside tmp: the operator's real home is never read and never written.
  const realHome = process.env.HOME;
  t.after(() => { if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome; });
  process.env.HOME = home;
  seatDir(home, 'tilde', { oauthAccount: { accountUuid: 'u-1', emailAddress: 'op@example.com' } });
  assert.equal(s.loggedIn('~/seats/tilde'), true);
});
