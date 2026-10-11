import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

/**
 * The six rotation events, as records `events.appendEvent(ORCH, …)` stores verbatim.
 *
 * Every shape assertion is a `deepEqual` on the WHOLE returned record — type, payload key set
 * and top-level `lead` in one comparison — so a builder that renames a field, drops one, adds
 * one, or forgets to lift `lead` to the top level fails on the line that pins that event, and
 * only there. Each sample carries an `extra` field the contract does not name, so the same
 * comparison pins that unknown fields are dropped.
 *
 * What those comparisons do NOT pin is key ORDER: under `node:assert/strict` `deepEqual` is
 * `deepStrictEqual`, which compares own keys as a set, so reordering a payload literal leaves
 * all of them green. The field order of the stored JSON line has its own test, below the six.
 */
let loads = 0;
const load = () => import('../bin/lib/wd/rotation-events.mjs?' + `re${++loads}`);

const NOW = 1_440_433_800_000;   // 2015-08-24T16:30:00Z — the ms form of the limit fixture's `resetsAt` 1440433800

test('ROTATION_EVENT_TYPES is exactly the six of design §3.8, in table order', async () => {
  const { ROTATION_EVENT_TYPES } = await load();
  assert.deepEqual([...ROTATION_EVENT_TYPES], ['SEAT_CLOSED', 'SEAT_REOPENED', 'ROTATED', 'ROTATION_FAILED', 'ROTATION_UNAVAILABLE', 'BACKPRESSURE']);
});

test('the two lists are frozen, so a caller cannot widen them at runtime', async () => {
  const { ROTATION_EVENT_TYPES, UNAVAILABLE_WHY } = await load();
  assert.throws(() => ROTATION_EVENT_TYPES.push('LATER'), TypeError);
  assert.throws(() => UNAVAILABLE_WHY.push('later'), TypeError);
});

test('every type has a builder and every builder emits a listed type', async () => {
  const m = await load();
  const emitted = [
    m.seatClosed({ seat: 's', reason: 'five_hour', resetsAt: NOW }),
    m.seatReopened({ seat: 's' }),
    m.rotated({ lead: 'a', from: 's', to: 't', rateLimitType: 'five_hour', resetsAt: NOW }),
    m.rotationFailed({ lead: 'a', from: 't', to: 's', why: 'authentication_failed' }),
    m.rotationUnavailable({ lead: 'a', why: 'thrash' }),
    m.backpressure({ reason: 'org_level_disabled_until', since: NOW, until: null }),
  ].map((r) => r.type).sort();
  assert.deepEqual(emitted, [...m.ROTATION_EVENT_TYPES].sort());
});

// ── the payload shapes, one record per event ─────────────────────────────────────────────

test('SEAT_CLOSED is { seat, reason, resetsAt } with no lead', async () => {
  const { seatClosed } = await load();
  assert.deepEqual(
    seatClosed({ seat: 'seat-a', reason: 'seven_day_opus', resetsAt: NOW, extra: 'dropped' }),
    { type: 'SEAT_CLOSED', payload: { seat: 'seat-a', reason: 'seven_day_opus', resetsAt: NOW }, lead: null },
  );
});

test('SEAT_REOPENED is { seat } with no lead', async () => {
  const { seatReopened } = await load();
  assert.deepEqual(
    seatReopened({ seat: 'seat-a', extra: 'dropped' }),
    { type: 'SEAT_REOPENED', payload: { seat: 'seat-a' }, lead: null },
  );
});

test('ROTATED is { lead, from, to, rateLimitType, resetsAt } and lifts lead to the top level', async () => {
  const { rotated } = await load();
  assert.deepEqual(
    rotated({ lead: 'task-1', from: 'seat-a', to: 'seat-b', rateLimitType: 'five_hour', resetsAt: NOW, extra: 'dropped' }),
    {
      type: 'ROTATED',
      payload: { lead: 'task-1', from: 'seat-a', to: 'seat-b', rateLimitType: 'five_hour', resetsAt: NOW },
      lead: 'task-1',
    },
  );
});

test('ROTATION_FAILED is { lead, from, to, why } — from the seat that rejected, to the original — and lifts lead to the top level', async () => {
  const { rotationFailed } = await load();
  assert.deepEqual(
    rotationFailed({ lead: 'task-1', from: 'seat-b', to: 'seat-a', why: 'oauth_org_not_allowed', extra: 'dropped' }),
    { type: 'ROTATION_FAILED', payload: { lead: 'task-1', from: 'seat-b', to: 'seat-a', why: 'oauth_org_not_allowed' }, lead: 'task-1' },
  );
});

test('ROTATION_UNAVAILABLE is { lead, why } and lifts lead to the top level', async () => {
  const { rotationUnavailable } = await load();
  assert.deepEqual(
    rotationUnavailable({ lead: 'task-1', why: 'no_open_seat', extra: 'dropped' }),
    { type: 'ROTATION_UNAVAILABLE', payload: { lead: 'task-1', why: 'no_open_seat' }, lead: 'task-1' },
  );
});

test('BACKPRESSURE is { reason, since, until } with no lead', async () => {
  const { backpressure } = await load();
  assert.deepEqual(
    backpressure({ reason: 'org_level_disabled_until', since: NOW, until: null, extra: 'dropped' }),
    { type: 'BACKPRESSURE', payload: { reason: 'org_level_disabled_until', since: NOW, until: null }, lead: null },
  );
});

test('each payload lists its fields in design §3.8 table order — the six deepEquals above cannot see it', async () => {
  const m = await load();
  // The consequence of a reordered literal is only the field order of the JSON line in the
  // event log, and no consumer parses that — but RUNBOOK §10 has the OPERATOR read those
  // lines, and the header above claimed an order nothing measured. This is that measurement:
  // one table, so a builder that shuffles its payload reddens here and only here.
  const order = (rec) => `${rec.type} { ${Object.keys(rec.payload).join(', ')} }`;
  assert.deepEqual(
    [
      order(m.seatClosed({ seat: 's', reason: 'five_hour', resetsAt: NOW })),
      order(m.seatReopened({ seat: 's' })),
      order(m.rotated({ lead: 'a', from: 's', to: 't', rateLimitType: 'five_hour', resetsAt: NOW })),
      order(m.rotationFailed({ lead: 'a', from: 't', to: 's', why: 'w' })),
      order(m.rotationUnavailable({ lead: 'a', why: 'thrash' })),
      order(m.backpressure({ reason: 'r', since: NOW, until: null })),
    ],
    [
      'SEAT_CLOSED { seat, reason, resetsAt }',
      'SEAT_REOPENED { seat }',
      'ROTATED { lead, from, to, rateLimitType, resetsAt }',
      'ROTATION_FAILED { lead, from, to, why }',
      'ROTATION_UNAVAILABLE { lead, why }',
      'BACKPRESSURE { reason, since, until }',
    ],
  );
});

// ── the values each field admits ─────────────────────────────────────────────────────────

test('ROTATION_UNAVAILABLE takes each of the three reasons the watchdog can have', async () => {
  const { rotationUnavailable, UNAVAILABLE_WHY } = await load();
  for (const why of UNAVAILABLE_WHY) {
    assert.equal(rotationUnavailable({ lead: 'a', why }).payload.why, why, why);
  }
});

test('ROTATED accepts from: null and ROTATION_FAILED accepts to: null — a row spawned before seats existed has no seat to leave or return to', async () => {
  const { rotated, rotationFailed } = await load();
  assert.equal(rotated({ lead: 'a', from: null, to: 'seat-b', rateLimitType: 'five_hour', resetsAt: NOW }).payload.from, null);
  assert.equal(rotationFailed({ lead: 'a', from: 'seat-b', to: null, why: 'server_error' }).payload.to, null);
});

test('BACKPRESSURE.until may be null (a cap with no reset) or a millisecond stamp', async () => {
  const { backpressure } = await load();
  assert.equal(backpressure({ reason: 'org_level_disabled_until', since: NOW, until: null }).payload.until, null);
  assert.equal(backpressure({ reason: 'org_level_disabled_until', since: NOW, until: NOW + 1 }).payload.until, NOW + 1);
});

test('a stored record survives JSON unchanged: no field is undefined, so the log holds the contract shape', async () => {
  const m = await load();
  for (const rec of [
    m.seatClosed({ seat: 's', reason: 'five_hour', resetsAt: NOW }),
    m.seatReopened({ seat: 's' }),
    m.rotated({ lead: 'a', from: null, to: 't', rateLimitType: 'five_hour', resetsAt: NOW }),
    m.rotationFailed({ lead: 'a', from: 't', to: null, why: 'w' }),
    m.rotationUnavailable({ lead: 'a', why: 'seats_unreadable' }),
    m.backpressure({ reason: 'r', since: NOW, until: null }),
  ]) {
    assert.deepEqual(JSON.parse(JSON.stringify(rec)), rec, rec.type);
  }
});

// ── refusals: a TypeError that names the event and the field ─────────────────────────────

test('a missing or mis-typed field is refused by name, never stored mis-shaped', async () => {
  const m = await load();
  const good = {
    seatClosed: { seat: 's', reason: 'five_hour', resetsAt: NOW },
    seatReopened: { seat: 's' },
    rotated: { lead: 'a', from: 's', to: 't', rateLimitType: 'five_hour', resetsAt: NOW },
    rotationFailed: { lead: 'a', from: 't', to: 's', why: 'w' },
    rotationUnavailable: { lead: 'a', why: 'thrash' },
    backpressure: { reason: 'r', since: NOW, until: null },
  };
  const cases = [
    // [builder, override, /message/]
    ['seatClosed', { seat: '' }, /^SEAT_CLOSED: seat must be a non-empty string, got ""$/],
    ['seatClosed', { reason: undefined }, /^SEAT_CLOSED: reason must be a non-empty string, got undefined$/],
    ['seatClosed', { resetsAt: '1440433800000' }, /^SEAT_CLOSED: resetsAt must be an epoch-ms number >= 1e12 \(a value in seconds is the units bug\), got "1440433800000"$/],
    ['seatClosed', { resetsAt: -1 }, /SEAT_CLOSED: resetsAt/],
    ['seatClosed', { resetsAt: Number.NaN }, /SEAT_CLOSED: resetsAt/],
    ['seatClosed', { resetsAt: Infinity }, /SEAT_CLOSED: resetsAt/],
    ['seatReopened', { seat: 7 }, /^SEAT_REOPENED: seat must be a non-empty string, got 7$/],
    ['rotated', { lead: undefined }, /^ROTATED: lead must be a non-empty string, got undefined$/],
    ['rotated', { to: null }, /^ROTATED: to must be a non-empty string, got null$/],
    ['rotated', { rateLimitType: '' }, /ROTATED: rateLimitType/],
    ['rotated', { resetsAt: null }, /ROTATED: resetsAt/],
    ['rotationFailed', { from: null }, /^ROTATION_FAILED: from must be a non-empty string, got null$/],
    ['rotationFailed', { to: '' }, /^ROTATION_FAILED: to must be a non-empty string, got ""$/],
    ['rotationFailed', { why: 42 }, /^ROTATION_FAILED: why must be a non-empty string, got 42$/],
    ['rotationUnavailable', { why: 'nope' }, /^ROTATION_UNAVAILABLE: why must be one of no_open_seat, thrash, seats_unreadable, got "nope"$/],
    ['rotationUnavailable', { lead: '' }, /ROTATION_UNAVAILABLE: lead/],
    ['backpressure', { until: 'never' }, /^BACKPRESSURE: until must be an epoch-ms number >= 1e12 \(a value in seconds is the units bug\), got "never"$/],
    ['backpressure', { since: undefined }, /^BACKPRESSURE: since must be an epoch-ms number >= 1e12 \(a value in seconds is the units bug\), got undefined$/],
    ['backpressure', { reason: null }, /BACKPRESSURE: reason/],
  ];
  // `inspect`, not `JSON.stringify`: five of these overrides are invisible to JSON — it drops
  // an `undefined` value (three cases would label as `seatClosed {}` / `rotated {}` /
  // `backpressure {}`) and writes both NaN and Infinity as `null`, against a shared regex. A
  // label that cannot name its case sends the next regression to the wrong line.
  for (const [name, over, re] of cases) {
    assert.throws(() => m[name]({ ...good[name], ...over }), { name: 'TypeError', message: re }, `${name} ${inspect(over)}`);
  }
});

test('MIN_EPOCH_MS is 1e12 and every millisecond field is refused below it: the classifier\'s seconds, passed through unconverted, is the units bug', async () => {
  const m = await load();
  assert.equal(m.MIN_EPOCH_MS, 1e12, 'the one definition — backpressure.mjs re-exports this value, it does not redefine it');
  const SECONDS = 1_440_433_800;   // the fixture's `quotaLimits.resetsAt`, in seconds as Claude Code writes it
  assert.throws(
    () => m.seatClosed({ seat: 's', reason: 'five_hour', resetsAt: SECONDS }),
    { name: 'TypeError', message: /^SEAT_CLOSED: resetsAt must be an epoch-ms number >= 1e12 \(a value in seconds is the units bug\), got 1440433800$/ },
  );
  assert.throws(() => m.rotated({ lead: 'a', from: 's', to: 't', rateLimitType: 'five_hour', resetsAt: SECONDS }), { name: 'TypeError', message: /^ROTATED: resetsAt/ });
  assert.throws(() => m.backpressure({ reason: 'r', since: SECONDS, until: null }), { name: 'TypeError', message: /^BACKPRESSURE: since/ });
  assert.throws(() => m.backpressure({ reason: 'r', since: NOW, until: SECONDS }), { name: 'TypeError', message: /^BACKPRESSURE: until/ });
  assert.throws(() => m.backpressure({ reason: 'r', since: m.MIN_EPOCH_MS - 1, until: null }), { name: 'TypeError', message: /^BACKPRESSURE: since/ });
  assert.equal(m.backpressure({ reason: 'r', since: m.MIN_EPOCH_MS, until: null }).payload.since, 1e12, 'the bound itself is admitted');
  assert.equal(m.seatClosed({ seat: 's', reason: 'five_hour', resetsAt: SECONDS * 1000 }).payload.resetsAt, NOW, 'the same instant in milliseconds is the sample clock');
});

test("a field whose value cannot be rendered is still refused by name: show()'s catch is the contract", async () => {
  const m = await load();
  // `show` is the one place a builder touches an untrusted VALUE rather than its type, and
  // `String(v)` THROWS on a null-prototype object — it has no `toString`. Without the catch
  // the refusal becomes `TypeError: Cannot convert object to primitive value`, which names
  // neither the event nor the field: precisely the contract the module header states, broken
  // for the input that needs it most. The catch renders the type instead, which cannot be
  // confused with a string value (a string is rendered quoted).
  assert.throws(
    () => m.seatClosed({ seat: Object.create(null), reason: 'r', resetsAt: NOW }),
    { name: 'TypeError', message: /^SEAT_CLOSED: seat must be a non-empty string, got object$/ },
  );
});

test('a builder called with no record at all is refused as fields, not with a property-of-undefined crash', async () => {
  const m = await load();
  // `inspect` again, not `String`: `String([])` is '', which node reads as no message at all,
  // so the array case used to fail with a bare "Expected values to be strictly deep-equal:".
  for (const bad of [undefined, null, 'x', [], 42]) {
    assert.throws(() => m.backpressure(bad), { name: 'TypeError', message: /^BACKPRESSURE: fields must be an object, got / }, inspect(bad));
  }
});
