/**
 * `bin/lib/seats-summary.mjs` — the ONE merge of soma.json seats with state/seats.json that
 * `soma status` and `soma_status` both render. Per-assertion, and the clock is pinned per test
 * through `process.env.TZ`: Node re-reads it at runtime (verified on v24.14.1), and `node --test`
 * runs each file in its own process, so the pin cannot leak into a sibling suite.
 */
import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const { clock, summariseSeats, seatsSummary } = await import('../bin/lib/seats-summary.mjs');

/**
 * The sample reset: `resetsAt 1440433800` (seconds), Event A's five-hour row in the limit
 * fixture — 2015-08-24T16:30Z, which is 1:30am the next day in Asia/Tokyo.
 * In ms here, the unit every field of this module carries.
 */
const RESET_MS = 1_440_433_800_000;
const HOUR = 3_600_000;
/** "Now" for every summary below: three hours before the sample reset (2015-08-24T13:30Z). */
const NOW = RESET_MS - 3 * HOUR;
/** A configured seat, as `loadSeats` hands it over. */
const seat = (label, over = {}) => ({ config_dir: `/seats/${label}`, label, ...over });
/** A state row, as `state/seats.json` holds it. */
const row = (label, over = {}) => ({ config_dir: `/seats/${label}`, label, closed_until: 0, closed_reason: null, unverified: false, ...over });
const state = (...rows) => ({ seats: rows });

/** Pin the process timezone for one test; restored after it. */
const tz = (t, zone) => {
  const prev = process.env.TZ;
  process.env.TZ = zone;
  t.after(() => { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; });
};

// --------------------------------------------------------------------------- clock

test('clock renders the sample reset the way the pane spells it — 1:30am in Asia/Tokyo', (t) => {
  tz(t, 'Asia/Tokyo');
  assert.equal(clock(RESET_MS, NOW), '1:30am');
});

test('clock renders a reset inside the next 24 h as a bare local time — the same instant is 4:30pm in UTC', (t) => {
  tz(t, 'UTC');
  assert.equal(clock(RESET_MS, NOW), '4:30pm');
});

test('clock renders midnight as 12:xxam, never 0:xx', (t) => {
  tz(t, 'UTC');
  // 2015-08-25T00:05Z is 10 h 35 min after NOW: inside the day, so no date.
  assert.equal(clock(Date.UTC(2015, 7, 25, 0, 5), NOW), '12:05am');
});

test('clock renders noon as 12:00pm', (t) => {
  tz(t, 'UTC');
  // 22 h 30 min after NOW: still inside the day.
  assert.equal(clock(Date.UTC(2015, 7, 25, 12, 0), NOW), '12:00pm');
});

test('clock past 24 h carries the day: a weekly window resets on a Thursday and a bare 12:00am would read as tonight', (t) => {
  tz(t, 'UTC');
  assert.equal(clock(Date.UTC(2015, 7, 27, 0, 0), NOW), 'Aug 27 12:00am');
});

test('clock on a non-finite stamp is "?", never "Invalid Date"', () => {
  assert.equal(clock(Number.NaN, NOW), '?');
});

test('clock carries the YEAR when the stamp is not in this one — a hand-edited closure in 3000 must not read as this January', (t) => {
  tz(t, 'UTC');
  // `seats.close` clamps at MAX_CLOSE_MS so soma cannot write this, but `readSeatState` accepts
  // any finite `closed_until >= 0` and the RUNBOOK invites hand edits of `state/seats.json`.
  // Without the year this rendered `Jan 1 12:00pm` — a closure 985 years out, spelled exactly
  // like one four months out, on a line whose whole job is to say when the seat comes back.
  assert.equal(clock(Date.UTC(3000, 0, 1, 12, 0), NOW), 'Jan 1 3000 12:00pm');
});

test('clock dates a stamp more than a day in the PAST too, rather than spelling it as tonight', (t) => {
  tz(t, 'UTC');
  // Unreachable through `summariseSeats`, which only buckets `closed_until > nowMs` — but this
  // formatter is exported for other callers, and `1:30pm` for a stamp two days gone
  // is the same lie in the other direction.
  assert.equal(clock(NOW - 2 * 24 * HOUR, NOW), 'Aug 22 1:30pm');
});

test('a "now" that is not a finite number falls back to the wall clock, so a reset an hour away is not spelled as a far-off date', (t) => {
  tz(t, 'UTC');
  // Three states about the clock itself: not knowing when now is cannot be read as evidence
  // that the reset is far away. Anchored on the real wall clock, because that IS the fallback.
  assert.match(clock(Date.now() + HOUR, Number.NaN), /^\d{1,2}:\d{2}(am|pm)$/);
});

// --------------------------------------------------------------------------- summariseSeats

test('a configured seat with no state row yet is open (seats.mjs treats it the same way)', () => {
  assert.deepEqual(summariseSeats([seat('a')], state(), NOW).open.map((x) => x.label), ['a']);
});

test('a seat whose closed_until is in the future is closed, carrying its until and reason', () => {
  const s = summariseSeats([seat('a')], state(row('a', { closed_until: RESET_MS, closed_reason: 'five_hour' })), NOW);
  assert.deepEqual(s.closed, [{ label: 'a', config_dir: '/seats/a', closed_until: RESET_MS, closed_reason: 'five_hour' }]);
});

test('a closure that has expired reads open even before reopenExpired has swept it — closed_until === now is open', () => {
  const s = summariseSeats([seat('a')], state(row('a', { closed_until: NOW, closed_reason: 'five_hour' })), NOW);
  assert.deepEqual([s.open.map((x) => x.label), s.closed.length], [['a'], 0]);
});

test('an unverified seat is unverified — not open, and not closed even when a closure is also recorded', () => {
  const s = summariseSeats([seat('a')], state(row('a', { unverified: true, closed_until: RESET_MS, closed_reason: 'seven_day' })), NOW);
  assert.deepEqual([s.open.length, s.closed.length, s.unverified.map((x) => x.label)], [0, 0, ['a']]);
});

test('a state row for a seat no longer in soma.json is ignored and not counted', () => {
  const s = summariseSeats([seat('a')], state(row('zombie', { closed_until: RESET_MS })), NOW);
  assert.deepEqual([s.configured, s.open.length, s.closed.length], [1, 1, 0]);
});

test('seats keep config order within a bucket', () => {
  assert.deepEqual(summariseSeats([seat('b'), seat('a')], state(), NOW).open.map((x) => x.label), ['b', 'a']);
});

test('an unreadable seat state claims nothing open — unreadable is the third state, not "all open"', () => {
  const s = summariseSeats([seat('a')], { seats: [], unreadable: true }, NOW);
  assert.deepEqual([s.unreadable, s.open, s.closed, s.unverified, s.configured], [true, [], [], [], 1]);
});

test('the unreadable summary names the file, because that is what the operator goes and looks at', () => {
  assert.match(summariseSeats([seat('a')], { seats: [], unreadable: true }, NOW).why, /seats\.json/);
});

// --------------------------------------------------------------------------- seatsSummary (the seam)

/** A throwaway state root with `state/`, and SOMA_HOME pointed at it for the test's life. */
const home = (t) => {
  const h = mkdtempSync(join(tmpdir(), 'soma-seats-'));
  const prev = process.env.SOMA_HOME;
  process.env.SOMA_HOME = h;
  t.after(() => { rmSync(h, { recursive: true, force: true }); if (prev === undefined) delete process.env.SOMA_HOME; else process.env.SOMA_HOME = prev; });
  mkdirSync(join(h, 'state'), { recursive: true });
  return h;
};

test('seatsSummary reads soma.json through loadSeats and state/seats.json through readSeatState — severing either call reddens this', (t) => {
  const h = home(t);
  writeFileSync(join(h, 'soma.json'), JSON.stringify({ seats: [{ config_dir: join(h, 'seat-a'), label: 'seat-a' }, { config_dir: join(h, 'seat-b'), label: 'seat-b' }] }));
  writeFileSync(join(h, 'state', 'seats.json'), JSON.stringify({ seats: [{ config_dir: join(h, 'seat-b'), label: 'seat-b', closed_until: RESET_MS, closed_reason: 'five_hour', unverified: false }] }));
  const s = seatsSummary(NOW);
  assert.deepEqual([s.open.map((x) => x.label), s.closed.map((x) => x.label)], [['seat-a'], ['seat-b']]);
});

test('a corrupt state/seats.json reads unreadable, with the configured count intact and nothing open', (t) => {
  const h = home(t);
  writeFileSync(join(h, 'soma.json'), JSON.stringify({ seats: [{ config_dir: join(h, 'seat-a'), label: 'seat-a' }] }));
  writeFileSync(join(h, 'state', 'seats.json'), '{"seats": [');
  const s = seatsSummary(NOW);
  assert.deepEqual([s.unreadable, s.open.length, s.configured], [true, 0, 1]);
});

test('a soma.json that will not load reads unreadable with the loader\'s sentence, and the count itself unknown', (t) => {
  const h = home(t);
  writeFileSync(join(h, 'soma.json'), 'not json');
  const s = seatsSummary(NOW);
  assert.deepEqual([s.unreadable, s.configured], [true, null]);
  assert.match(s.why, /soma\.json/);
});

test('nothing on disk is "none configured": zero seats, readable, nothing to say', (t) => {
  home(t);
  assert.deepEqual(seatsSummary(NOW), { configured: 0, open: [], closed: [], unverified: [], unreadable: false, why: null });
});
