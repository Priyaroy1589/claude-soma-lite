import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SEAT_WINDOW_TYPES, MIN_CLOSE_MS, nextMonthStartMs, classifyLimit } from '../bin/lib/wd/limit-state.mjs';

/**
 * Synthetic rows shaped like real ones. Every entry under `rate_limit`, `negative` and `healthy`
 * has the shape of a transcript row Claude Code writes (its `_source` is an invented
 * `<file>:<line>`), trimmed to the fields the classifier reads plus provenance labels; the ids,
 * timestamps and resets are made up. `quotaLimits.resetsAt` is in epoch SECONDS here, exactly as
 * Claude Code writes it — the assertions below that expect milliseconds are the units check.
 */
const FX = JSON.parse(readFileSync(new URL('./fixtures/limit-rows.json', import.meta.url), 'utf8'));
const FIVE_HOUR = FX.rate_limit.five_hour;
const ABSENT = FX.rate_limit.absent;
/** Event A (s10.jsonl:218): the limit hit whose whole cycle the fixture carries — resumed 85 s after `resetsAt`. */
const EVENT_A = FIVE_HOUR.find((r) => r._source === 's10.jsonl:218');
/** Event A's resume (s10.jsonl:225): the healthy `claude-opus-5` row written 53 min later. */
const HEALTHY = FX.healthy[0];
/**
 * Event A's own clock — the `now` a tick that saw the row live would have held (2015-08-24T15:38:25.681Z).
 * Optional chaining so a fixture that lost Event A reddens the assertion below that says so, instead of
 * throwing here and taking the whole file down at load with a TypeError that names no assertion.
 */
const EVENT_A_MS = Date.parse(EVENT_A?.timestamp);

// ─────────────────────────── the fixture itself ───────────────────────────

test('fixture: 33 rate_limit rows — 15 with quotaLimits (all five_hour), 18 without', () => {
  assert.equal(FIVE_HOUR.length + ABSENT.length, 33);
  assert.equal(FIVE_HOUR.length, 15);
  assert.equal(ABSENT.length, 18);
  for (const r of [...FIVE_HOUR, ...ABSENT]) {
    assert.equal(r.type, 'assistant', r._source);
    assert.equal(r.isApiErrorMessage, true, r._source);
    assert.equal(r.error, 'rate_limit', r._source);
    assert.equal(r.apiErrorStatus, 429, r._source);
    assert.equal(r.message.model, '<synthetic>', r._source);
    assert.ok(Number.isFinite(Date.parse(r.timestamp)), `${r._source} has no parseable timestamp`);
  }
  for (const r of ABSENT) assert.equal('quotaLimits' in r, false, `${r._source} carries quotaLimits`);
  for (const r of FIVE_HOUR) {
    assert.equal(r.quotaLimits.status, 'rejected', r._source);
    assert.equal(r.quotaLimits.rateLimitType, 'five_hour', r._source);
    assert.equal(r.quotaLimits.overageDisabledReason, 'org_spend_cap_reached', r._source);
    // Seconds, not milliseconds: 1440433800 is 2015-08-24T16:30Z; as ms it would be 1970-01-17.
    assert.ok(Number.isInteger(r.quotaLimits.resetsAt) && r.quotaLimits.resetsAt < 1e10, `${r._source} resetsAt not in seconds`);
  }
  // The non-monotonic reset real rows show, modelled here: nine rows at the true reset, and SIX at "now + 5 h" — 1440449400 ×2, 1440450600 ×3, 1440451200 ×1 — which is why the count below is 4.
  assert.equal(FIVE_HOUR.filter((r) => r.quotaLimits.resetsAt === 1440433800).length, 9);
  assert.equal(new Set(FIVE_HOUR.map((r) => r.quotaLimits.resetsAt)).size, 4);
  assert.ok(EVENT_A, 'Event A row missing from the fixture');
  // The index other test files quote: five_hour[0] is Event A, absent[1] is Event C (s01.jsonl:5141).
  assert.equal(FIVE_HOUR[0], EVENT_A);
  assert.equal(ABSENT[1]._source, 's01.jsonl:5141');
});

test('fixture: the negative corpus covers the four other error kinds, none with quotaLimits; one healthy row', () => {
  assert.deepEqual(Object.keys(FX.negative).sort(),
    ['authentication_failed', 'invalid_request', 'oauth_org_not_allowed', 'server_error']);
  for (const [kind, rows] of Object.entries(FX.negative)) {
    assert.ok(rows.length >= 1, `${kind} has no row`);
    for (const r of rows) {
      assert.equal(r.type, 'assistant', r._source);
      assert.equal(r.isApiErrorMessage, true, r._source);
      assert.equal(r.error, kind, r._source);
      assert.equal('quotaLimits' in r, false, `${r._source} carries quotaLimits`);
      assert.equal(r.message.model, '<synthetic>', r._source);
      assert.ok(Number.isFinite(Date.parse(r.timestamp)), `${r._source} has no parseable timestamp`);
    }
  }
  // server_error is the family named by symptom: an overloaded API, a DNS failure, a timeout.
  const serverKinds = FX.negative.server_error.map((r) => r._text);
  for (const k of ['529', 'ENOTFOUND', 'timeout']) assert.ok(serverKinds.includes(k), `no server_error row for ${k}`);
  assert.equal(FX.negative.server_error.find((r) => r._text === '529').apiErrorStatus, 529);
  assert.equal(FX.healthy.length, 1);
  assert.equal(HEALTHY.type, 'assistant');
  assert.equal('isApiErrorMessage' in HEALTHY, false);
  assert.equal(HEALTHY.message.model, 'claude-opus-5');
  assert.ok(Number.isFinite(Date.parse(HEALTHY.timestamp)), 'the healthy row has no parseable timestamp');
});

// ─────────────────────────── exports and the calendar helper ───────────────────────────
//
// The calendar edge cases below (a month start, a 31-day overflow, a year boundary, a zone already past
// midnight) are chosen for the arithmetic they exercise. Every sample CLOCK in this file is the fixture's:
// Event A's own `timestamp`, its `resetsAt` 1440433800 s and the monthly boundary after it, 1441065600 s.

test('exports: SEAT_WINDOW_TYPES is exactly the six representative claims; MIN_CLOSE_MS is five minutes', () => {
  assert.deepEqual([...SEAT_WINDOW_TYPES].sort(),
    ['five_hour', 'overage', 'seven_day', 'seven_day_opus', 'seven_day_overage_included', 'seven_day_sonnet']);
  // The spend-cap reasons are NOT windows: a seat hit by one has no window reset to reopen on.
  assert.equal(SEAT_WINDOW_TYPES.has('org_spend_cap_reached'), false);
  assert.equal(SEAT_WINDOW_TYPES.has('org_level_disabled_until'), false);
  assert.equal(MIN_CLOSE_MS, 5 * 60 * 1000);
});

test('nextMonthStartMs: 00:00:00Z on the 1st of the FOLLOWING month', () => {
  // Event A's monthly boundary: 1441065600 s = 2015-09-01T00:00:00Z, the value a real row's `overageResetsAt` carries for its month.
  assert.equal(nextMonthStartMs(EVENT_A_MS), 1441065600000);
  assert.equal(new Date(nextMonthStartMs(EVENT_A_MS)).toISOString(), '2015-09-01T00:00:00.000Z');
  // Already exactly on a month start: the answer is the NEXT 1st, never "now".
  assert.equal(new Date(nextMonthStartMs(Date.UTC(2015, 8, 1, 0, 0, 0, 0))).toISOString(), '2015-10-01T00:00:00.000Z');
  // The last day of a 31-day month: `setMonth(+1)` on Jan 31 overflows to Mar 3; `Date.UTC(y, m+1, 1)` does not.
  assert.equal(new Date(nextMonthStartMs(Date.UTC(2026, 0, 31, 12))).toISOString(), '2026-02-01T00:00:00.000Z');
});

test('nextMonthStartMs: across a year boundary', () => {
  const lastMs = Date.UTC(2026, 11, 31, 23, 59, 59, 999);
  assert.equal(nextMonthStartMs(lastMs), 1798761600000);
  assert.equal(new Date(nextMonthStartMs(lastMs)).toISOString(), '2027-01-01T00:00:00.000Z');
});

test('nextMonthStartMs: UTC, not the process zone', () => {
  const saved = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  try {
    // 2026-09-30T20:00Z is already 05:00 on Oct 1 in Asia/Tokyo. A local-time implementation
    // answers "Nov 1 00:00 local" (= 2026-10-31T15:00Z); the UTC answer is Oct 1 00:00Z.
    assert.equal(new Date(Date.UTC(2026, 8, 30, 20)).getMonth(), 9, 'TZ override did not take; test is vacuous');
    assert.equal(nextMonthStartMs(Date.UTC(2026, 8, 30, 20)), 1790812800000);
    assert.equal(new Date(nextMonthStartMs(Date.UTC(2026, 8, 30, 20))).toISOString(), '2026-10-01T00:00:00.000Z');
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});

test('nextMonthStartMs: refuses a now that is not a finite number', () => {
  for (const bad of [undefined, null, NaN, Infinity, '1440433800', {}]) {
    assert.throws(() => nextMonthStartMs(bad), { name: 'TypeError', message: /nowMs/ }, `accepted ${String(bad)}`);
  }
});

// ─────────────────────────── classifyLimit ───────────────────────────

/** A copy of a fixture row with its `quotaLimits` replaced — the ONLY way a shape the fixture lacks enters this file. */
const withQuota = (row, quotaLimits) => ({ ...row, quotaLimits });
/**
 * Transcript rows that are not assistant rows, in the shapes Claude Code writes between a limit hit and its
 * resume (lines 219–224 of s10.jsonl, between Event A's two rows). The classifier reads only `type` off a
 * non-assistant row; the other fields are the ones real rows carry, kept so the shapes stay recognisable.
 */
const SYSTEM_NOTICE = { type: 'system', subtype: 'informational', level: 'notice', isMeta: false };
const TURN_DURATION = { type: 'system', subtype: 'turn_duration', isMeta: false };
const QUEUE_OP = { type: 'queue-operation' };
const META_USER = { type: 'user', isMeta: true };

test('classifyLimit: every five_hour row is seat_window, resetsAt converted to MILLISECONDS', () => {
  for (const r of FIVE_HOUR) {
    assert.deepEqual(classifyLimit([r]),
      { kind: 'seat_window', rateLimitType: 'five_hour', resetsAt: r.quotaLimits.resetsAt * 1000 }, r._source);
  }
  // The one conversion site, pinned with a literal: 1440433800 s → 1_440_433_800_000 ms.
  const v = classifyLimit([EVENT_A]);
  assert.equal(v.resetsAt, 1_440_433_800_000);
  assert.equal(new Date(v.resetsAt).toISOString(), '2015-08-24T16:30:00.000Z');
  // …and in the unit every downstream guard checks: epoch ms is >= 1e12 for any date after 2001; seconds never are.
  assert.ok(v.resetsAt >= 1e12);
  assert.ok(EVENT_A.quotaLimits.resetsAt < 1e12);
});

test('classifyLimit: each of the six window types is seat_window', () => {
  for (const t of SEAT_WINDOW_TYPES) {
    const row = withQuota(EVENT_A, { ...EVENT_A.quotaLimits, rateLimitType: t });
    assert.deepEqual(classifyLimit([row]), { kind: 'seat_window', rateLimitType: t, resetsAt: 1440433800000 }, t);
  }
});

test('classifyLimit: a window with a finite reset outranks the spend-cap reason it arrives with', () => {
  // All 15 quotaLimits rows in the fixture say `overageDisabledReason: org_spend_cap_reached` AND `rateLimitType: five_hour`.
  // Event A resumed 85 s after the five_hour reset (16:31:25Z), so the seat reopened at the window, not on the 1st.
  // Reading the cap first would close a seat for up to a month that reopens within five hours.
  const v = classifyLimit([EVENT_A]);
  assert.equal(v.kind, 'seat_window');
  assert.notEqual(v.kind, 'seat_cap');
  assert.equal(v.resetsAt, 1440433800000);
  assert.notEqual(v.resetsAt, 1441065600000);   // Sept 1, the cap's own boundary
});

test('classifyLimit: org_spend_cap_reached with no usable window reset is seat_cap until the next 1st', () => {
  const NOW = EVENT_A_MS;   // 2015-08-24 → the following 1st is 2015-09-01T00:00Z
  const shapes = {
    'reason only, no window claim': { status: 'rejected', overageDisabledReason: 'org_spend_cap_reached' },
    'window claim without a finite reset': { status: 'rejected', rateLimitType: 'five_hour', resetsAt: null, overageDisabledReason: 'org_spend_cap_reached' },
    'reason in rateLimitType (the contract\'s literal shape)': { status: 'rejected', rateLimitType: 'org_spend_cap_reached' },
  };
  for (const [what, q] of Object.entries(shapes)) {
    assert.deepEqual(classifyLimit([withQuota(EVENT_A, q)], { nowMs: NOW }),
      { kind: 'seat_cap', rateLimitType: 'org_spend_cap_reached', resetsAt: 1441065600000 }, what);
  }
});

test('classifyLimit: seat_cap.resetsAt is nextMonthStartMs of the row\'s own timestamp, else of nowMs — the seam, across a year boundary', () => {
  const dec31 = Date.UTC(2026, 11, 31, 23, 59, 59, 999);
  const capQ = { status: 'rejected', overageDisabledReason: 'org_spend_cap_reached' };
  // The row is stamped 2015-08-24: its cap resets on Sept 1 whatever the tick's clock says. A watchdog
  // that first reads a last-month row after the boundary must not close the seat a month too long.
  assert.equal(classifyLimit([withQuota(EVENT_A, capQ)], { nowMs: dec31 }).resetsAt, 1441065600000);
  // No timestamp, or one that does not parse: the tick's clock decides.
  const { timestamp, ...unstamped } = withQuota(EVENT_A, capQ);
  assert.equal(classifyLimit([unstamped], { nowMs: dec31 }).resetsAt, nextMonthStartMs(dec31));
  assert.equal(classifyLimit([unstamped], { nowMs: dec31 }).resetsAt, 1798761600000);
  assert.equal(classifyLimit([{ ...unstamped, timestamp: 'yesterday' }], { nowMs: dec31 }).resetsAt, 1798761600000);
  // Neither injected: the boundary after Date.now().
  const before = nextMonthStartMs(Date.now());
  const v = classifyLimit([unstamped]);
  const after = nextMonthStartMs(Date.now());
  assert.ok(v.resetsAt === before || v.resetsAt === after, `resetsAt ${v.resetsAt} is neither ${before} nor ${after}`);
});

test('classifyLimit: org_level_disabled_until is spend_cap and carries no reset', () => {
  const shapes = {
    'reason only, no window claim': { status: 'rejected', overageDisabledReason: 'org_level_disabled_until' },
    'window claim without a finite reset': { status: 'rejected', rateLimitType: 'five_hour', resetsAt: undefined, overageDisabledReason: 'org_level_disabled_until' },
    'reason in rateLimitType (the contract\'s literal shape)': { status: 'rejected', rateLimitType: 'org_level_disabled_until' },
  };
  for (const [what, q] of Object.entries(shapes)) {
    const v = classifyLimit([withQuota(EVENT_A, q)]);
    assert.deepEqual(v, { kind: 'spend_cap', rateLimitType: 'org_level_disabled_until' }, what);
    assert.equal('resetsAt' in v, false, `${what}: spend_cap must not invent a reset`);
  }
});

test('classifyLimit: every negative row reads none, and so does the healthy row', () => {
  for (const [kind, rows] of Object.entries(FX.negative)) {
    for (const r of rows) assert.deepEqual(classifyLimit([r]), { kind: 'none' }, `${kind} ${r._source}`);
  }
  assert.deepEqual(classifyLimit([HEALTHY]), { kind: 'none' });
});

test('classifyLimit: the LAST assistant row decides — a rate_limit row followed by a healthy row is none', () => {
  // Event A's cycle, row for row in the order Claude Code writes it: 218 the error, 219 notice, 220 turn_duration,
  // 221–222 queue-operation, 223 a second notice, 224 the isMeta user prompt, 225 the resume.
  assert.deepEqual(classifyLimit([EVENT_A, SYSTEM_NOTICE, TURN_DURATION, QUEUE_OP, QUEUE_OP, SYSTEM_NOTICE, META_USER, HEALTHY]), { kind: 'none' });
  // The same rows in the other order are a live hit: order is the whole rule.
  assert.equal(classifyLimit([HEALTHY, EVENT_A]).kind, 'seat_window');
  // Nothing Claude Code writes between the hit and the resume is a recovery: a user row (a teammate's death
  // report, a queued prompt), a notice, the turn's end, the queue operation that arms the auto-continue.
  assert.equal(classifyLimit([EVENT_A, META_USER]).kind, 'seat_window');
  assert.equal(classifyLimit([EVENT_A, SYSTEM_NOTICE, TURN_DURATION]).kind, 'seat_window');
  assert.equal(classifyLimit([EVENT_A, SYSTEM_NOTICE, TURN_DURATION, QUEUE_OP, QUEUE_OP, SYSTEM_NOTICE, META_USER]).kind, 'seat_window');
  // A later API error that is not rate_limit is none — the shape the watchdog's revert step (spec §3.5 step 5) reads.
  const overloaded = FX.negative.server_error.find((r) => r._text === '529');
  assert.deepEqual(classifyLimit([EVENT_A, overloaded]), { kind: 'none' });
});

test('classifyLimit: rows missing, empty, not an array, or holding no assistant row are unobservable, each saying why', () => {
  const whys = new Map();
  for (const bad of [undefined, null, 'rows', 42, {}, []]) {
    const v = classifyLimit(bad);
    assert.equal(v.kind, 'unobservable', `${String(bad)} did not read unobservable`);
    assert.ok(typeof v.why === 'string' && v.why.length > 0, `${String(bad)} has no why`);
    // Keyed by a LABEL, not by `bad` itself: a Map keyed by the array would answer `undefined` to
    // every later `get([])` (a fresh array is a different key), and the comparison below could never fail.
    whys.set(Array.isArray(bad) ? 'empty array' : String(bad), v.why);
  }
  // An empty tail and a missing tail are different faults; the two whys must not be the same sentence.
  assert.notEqual(whys.get('empty array'), whys.get('undefined'));
  const noAssistant = classifyLimit([META_USER, SYSTEM_NOTICE, TURN_DURATION]);
  assert.equal(noAssistant.kind, 'unobservable');
  assert.match(noAssistant.why, /assistant/);
});

test('classifyLimit: a rate_limit row without quotaLimits is unobservable — not none, not seat_window', () => {
  for (const r of ABSENT) {
    const v = classifyLimit([r]);
    assert.equal(v.kind, 'unobservable', `${r._source} (${r._build}, ${r._text})`);
    assert.match(v.why, /quotaLimits/, r._source);
  }
});

test('classifyLimit: a window row whose resetsAt is not a finite number is unobservable, not seat_window', () => {
  for (const bad of [null, undefined, NaN, Infinity, -Infinity, '1440433800', true]) {
    const q = { status: 'rejected', rateLimitType: 'five_hour', resetsAt: bad };
    const v = classifyLimit([withQuota(EVENT_A, q)]);
    assert.equal(v.kind, 'unobservable', `resetsAt ${String(bad)} read ${v.kind}`);
    assert.match(v.why, /resetsAt/, `resetsAt ${String(bad)}`);
    assert.match(v.why, /five_hour/, `resetsAt ${String(bad)}: why does not name the window`);
  }
});

test('classifyLimit: an unrecognised rateLimitType with no cap reason is unobservable and names it', () => {
  const v = classifyLimit([withQuota(EVENT_A, { status: 'rejected', rateLimitType: 'seven_day_haiku', resetsAt: 1440433800 })]);
  assert.equal(v.kind, 'unobservable');
  assert.match(v.why, /seven_day_haiku/);
  const none = classifyLimit([withQuota(EVENT_A, { status: 'rejected' })]);
  assert.equal(none.kind, 'unobservable');
  assert.match(none.why, /rateLimitType/);
});

test('classifyLimit: a torn or unparseable entry NEWER than the last assistant row is unobservable; an older one is ignored', () => {
  // `tokens.readTailRows` passes `null` for a kept line it could not parse. Before the hit it is history; after it,
  // it may be the healthy row that would make this `none` — and a kill on that guess lands on a lead mid-turn.
  assert.equal(classifyLimit([null, EVENT_A]).kind, 'seat_window');
  assert.equal(classifyLimit(['{"type":"assistant","mess', EVENT_A]).kind, 'seat_window');
  for (const torn of [null, undefined, '{"type":"assistant","mess', 42, []]) {
    const v = classifyLimit([EVENT_A, torn]);
    assert.equal(v.kind, 'unobservable', `trailing ${String(torn)} read ${v.kind}`);
    assert.match(v.why, /row 1/, `trailing ${String(torn)}: why does not locate the entry`);
  }
  assert.equal(classifyLimit([EVENT_A, SYSTEM_NOTICE, null]).kind, 'unobservable');
  // The reader's exact shape for a live file: a healthy row, then the torn final line as `null` (`bad_lines: 1`).
  // Unobservable — not `none` — and the one verdict the watchdog turns into a WATCHDOG_ERROR.
  assert.equal(classifyLimit([HEALTHY, null]).kind, 'unobservable');
});

test('classifyLimit: keys on isApiErrorMessage + error alone — apiErrorStatus and message.model are corroboration', () => {
  // Design §3.2 names the predicate. Gating on the corroborating fields would turn an unobserved wording
  // or status drift into `none` — "healthy" — which is the wrong direction for a parked lead.
  const { apiErrorStatus, message, ...bare } = EVENT_A;
  assert.equal(classifyLimit([bare]).kind, 'seat_window');
  // …and `isApiErrorMessage` must be the boolean true, not merely truthy.
  assert.deepEqual(classifyLimit([{ ...EVENT_A, isApiErrorMessage: 'true' }]), { kind: 'none' });
  assert.deepEqual(classifyLimit([{ ...EVENT_A, error: 'rate_limit_error' }]), { kind: 'none' });
});

test('classifyLimit: a resetsAt already in MILLISECONDS is refused, never multiplied a second time', () => {
  // The drift this closes. 1440433800000 is Event A's own reset already in ms; multiplied again it is
  // +047615-07-13, and it passes the `>= 1e12` units bound the rotation-event builders and writeBackpressure
  // enforce — so nothing downstream rejects it and the seat `seats.close` parks on it never reopens.
  const MS = 1_440_433_800_000;
  const v = classifyLimit([withQuota(EVENT_A, { status: 'rejected', rateLimitType: 'five_hour', resetsAt: MS })]);
  assert.equal(v.kind, 'unobservable', `resetsAt ${MS} read ${v.kind}`);
  assert.match(v.why, /MILLISECONDS/, 'the why must name the suspected units, not merely refuse the number');
  assert.match(v.why, /1440433800000/, 'the why must name the value it refused');
  // 1e11 is the seam between the two bands: 1e11 s is the year 5138, 1e11 ms is 1973-03-03. No epoch-ms
  // value written since 1973 is below it and no window a fleet can wait for reaches it. The seam is refused.
  assert.equal(classifyLimit([withQuota(EVENT_A, { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1e11 })]).kind, 'unobservable');
  // The row shape the fixture models carries a cap reason beside the window claim. An unusable reset is an unusable reset
  // however it fails: the cap decides, exactly as it does for the `resetsAt: null` shape above — and the
  // number that could not be read reaches no field of the verdict.
  assert.deepEqual(classifyLimit([withQuota(EVENT_A, { ...EVENT_A.quotaLimits, resetsAt: MS })], { nowMs: EVENT_A_MS }),
    { kind: 'seat_cap', rateLimitType: 'org_spend_cap_reached', resetsAt: 1441065600000 });
});
