import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROTATION_EVENT_TYPES } from '../bin/lib/wd/rotation-events.mjs';

/**
 * The three spec tests pinned verbatim keep their `?Date.now()` cache-buster;
 * everything below uses this counter instead, so two cases that load the module
 * inside the same millisecond still each get their own instance. The module holds
 * no state today — the isolation is insurance against a future one.
 */
let loads = 0;
const load = () => import('../bin/lib/bus-tools.mjs?' + `n${++loads}`);

function ctx(env, overrides = {}) {
  const events = []; const keys = []; const toasts = [];
  return {
    env,
    deps: {
      appendEvent: (s, e) => { events.push({ s, ...e }); return { id: `${events.length}`, ts: 1 }; },
      readLease: () => ({ tmux_socket: 'soma', tmux_pane: '%1', wake: 'tmux' }),
      sendKeys: (t, text) => keys.push({ t, text }),
      notify: (title, body) => toasts.push({ title, body }),
      lastWakeAgeMs: () => 999999,
      validateHarnessReport: () => ({ ok: true }),
      taskFor: () => ({ id: 'cr-1', brief: 'do x', repo: 'r', base_branch: 'develop' }),
      ...overrides,
    },
    _events: events, _keys: keys, _toasts: toasts,
  };
}

/** A lead's ctx, with `deps` overrides — the shape every test below starts from. */
const lead = (overrides = {}) => ctx({ SOMA_LEAD_NAME: 'cr-1' }, overrides);

/** Let a floating promise rejection reach the process before the test ends. */
const drain = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// The original spec tests, verbatim.
// ---------------------------------------------------------------------------

test('soma_report(HARNESS) validates and stores; COMPLETED wakes + toasts', async () => {
  const bt = await import('../bin/lib/bus-tools.mjs?' + Date.now());
  const c = ctx({ SOMA_LEAD_NAME: 'cr-1' });
  const tools = bt.leadTools(c);
  await tools.get('soma_report')({ type: 'HARNESS', payload: { harness_id: 'H1', budget_class: 'standard' } });
  assert.equal(c._events[0].type, 'HARNESS');
  assert.equal(c._events[0].lead, 'cr-1');
  await tools.get('soma_report')({ type: 'COMPLETED', payload: { summary: 's', pr_url: 'u' } });
  assert.equal(c._keys.length, 1);                 // send-keys wake fired
  assert.ok(c._keys[0].text.includes('cr-1'));
  assert.equal(c._toasts.length, 1);               // COMPLETED always toasts
});

test('soma_report(HARNESS) rejects invalid payload', async () => {
  const bt = await import('../bin/lib/bus-tools.mjs?' + Date.now());
  const c = ctx({ SOMA_LEAD_NAME: 'cr-1' }, { validateHarnessReport: () => ({ ok: false, error: 'no harness_id' }) });
  const r = await bt.leadTools(c).get('soma_report')({ type: 'HARNESS', payload: {} });
  assert.match(JSON.stringify(r), /no harness_id/);
  assert.equal(c._events.length, 0);
});

test('soma_task returns the lead brief', async () => {
  const bt = await import('../bin/lib/bus-tools.mjs?' + Date.now());
  const c = ctx({ SOMA_LEAD_NAME: 'cr-1' });
  const r = await bt.leadTools(c).get('soma_task')({});
  assert.equal(r.task_id, 'cr-1');
  assert.equal(r.brief, 'do x');
});

// ---------------------------------------------------------------------------
// The tool set
// ---------------------------------------------------------------------------

test('the lead is handed exactly three tools, all of them async', async () => {
  const bt = await load();
  const tools = bt.leadTools(lead());
  assert.deepEqual([...tools.keys()].sort(), ['soma_checkpoint', 'soma_report', 'soma_task']);
  for (const [name, fn] of tools) {
    assert.equal(typeof fn, 'function', name);
    // Every handler is awaited by the transport; one that is not async would
    // still work, but a *thenable-returning* non-async one is the floating
    // promise the bus dies on, so the contract is pinned here.
    assert.equal(fn.constructor.name, 'AsyncFunction', name);
  }
});

test('every handler survives being called with nothing, and returns JSON', async () => {
  const bt = await load();
  const c = lead();
  for (const [name, fn] of bt.leadTools(c)) {
    for (const args of [undefined, null, {}]) {
      const r = await fn(args);
      // Plain data only: the transport wraps the result in JSON.stringify, and a
      // result it cannot serialize is a -32000 the model reads instead of an answer.
      assert.equal(JSON.parse(JSON.stringify(r)) !== null, true, `${name}(${args})`);
    }
  }
});

// ---------------------------------------------------------------------------
// soma_report: types
// ---------------------------------------------------------------------------

test('every declared type is stored on the lead\'s own stream, stamped with the lead', async () => {
  const bt = await load();
  const c = lead();
  const report = bt.leadTools(c).get('soma_report');
  const types = ['STARTED', 'HARNESS', 'MILESTONE', 'NEEDS_INPUT', 'COMPLETED', 'ERROR'];
  for (const type of types) {
    const r = await report({ type, payload: {} });
    assert.equal(r.delivered, true, type);
    assert.equal(typeof r.stored_id, 'string', type);
  }
  assert.deepEqual(c._events.map((e) => e.type), types);
  // stream name === lead id: the orchestrator's inbox sweeps `events/<lead>.ndjson`
  // per task row, so a report filed anywhere else is a report nobody reads.
  assert.deepEqual([...new Set(c._events.map((e) => e.s))], ['cr-1']);
  assert.deepEqual([...new Set(c._events.map((e) => e.lead))], ['cr-1']);
});

test('an unknown type is refused without appending, and the refusal names the six', async () => {
  const bt = await load();
  const c = lead();
  for (const type of ['DONE', '', ' ', null, undefined, 42, {}, ['COMPLETED']]) {
    const r = await bt.leadTools(c).get('soma_report')({ type, payload: { summary: 's' } });
    assert.equal(r.ok, false, JSON.stringify(type));
    assert.match(r.error, /NEEDS_INPUT/);
  }
  assert.equal(c._events.length, 0);
  assert.equal(c._keys.length, 0);
  assert.equal(c._toasts.length, 0);
});

test('a refusal cannot be used to echo a novel back at the model', async () => {
  const bt = await load();
  const c = lead();
  const r = await bt.leadTools(c).get('soma_report')({ type: 'x'.repeat(100_000) });
  assert.equal(r.ok, false);
  // The error text reaches the model verbatim, so the quoted type is clamped.
  assert.ok(r.error.length < 200, `error was ${r.error.length} chars`);
});

test('the type is read the way a model writes it, and stored canonically', async () => {
  const bt = await load();
  const c = lead();
  await bt.leadTools(c).get('soma_report')({ type: ' completed ', payload: {} });
  assert.equal(c._events[0].type, 'COMPLETED');
});

test('a payload that is not an object is refused, not stored off-schema', async () => {
  const bt = await load();
  const c = lead();
  for (const payload of ['done', 42, true, ['a'], null]) {
    const r = await bt.leadTools(c).get('soma_report')({ type: 'MILESTONE', payload });
    assert.equal(r.ok, false, JSON.stringify(payload));
    assert.match(r.error, /object/);
  }
  assert.equal(c._events.length, 0);
  // An absent payload is not a bad payload — it is an empty one.
  await bt.leadTools(c).get('soma_report')({ type: 'MILESTONE' });
  assert.deepEqual(c._events[0].payload, {});
});

// ---------------------------------------------------------------------------
// soma_report: HARNESS validation ordering
// ---------------------------------------------------------------------------

test('HARNESS validation runs before the append and before the wake', async () => {
  const bt = await load();
  const seen = [];
  const c = lead({ validateHarnessReport: (p) => { seen.push(p); return { ok: false, error: 'no harness_id' }; } });
  const r = await bt.leadTools(c).get('soma_report')({ type: 'HARNESS', payload: { budget_class: 'standard' } });
  assert.deepEqual(r, { ok: false, error: 'no harness_id' });
  assert.equal(c._events.length, 0);
  assert.equal(c._keys.length, 0);
  assert.equal(c._toasts.length, 0);
  // The validator sees what the lead sent, not the clamped copy: a truncated
  // plan_summary must not be able to satisfy a rule about its content.
  assert.deepEqual(seen, [{ budget_class: 'standard' }]);
});

test('a refused HARNESS carries the validator\'s reason and nothing of ours', async () => {
  const bt = await load();
  const c = lead({ validateHarnessReport: () => ({ ok: false }) });
  const r = await bt.leadTools(c).get('soma_report')({ type: 'HARNESS', payload: {} });
  assert.equal(r.ok, false);
  assert.equal(typeof r.error, 'string');   // never `undefined` — the model has to read this
  assert.ok(r.error.length > 0);
});

test('the harness validator is consulted for HARNESS only', async () => {
  const bt = await load();
  let calls = 0;
  const c = lead({ validateHarnessReport: () => { calls += 1; return { ok: true }; } });
  const report = bt.leadTools(c).get('soma_report');
  for (const type of ['STARTED', 'MILESTONE', 'NEEDS_INPUT', 'COMPLETED', 'ERROR']) await report({ type, payload: {} });
  assert.equal(calls, 0);
  await report({ type: 'HARNESS', payload: {} });
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// soma_report: payload caps (the log's bounded-line invariant)
// ---------------------------------------------------------------------------

test('summary is clamped to 2000 and question to 500, before the append', async () => {
  const bt = await load();
  const c = lead();
  const r = await bt.leadTools(c).get('soma_report')({
    type: 'NEEDS_INPUT',
    payload: { summary: 'a'.repeat(5000), question: 'b'.repeat(5000) },
  });
  assert.equal(c._events[0].payload.summary.length, 2000);
  assert.equal(c._events[0].payload.question.length, 500);
  assert.equal(r.clamped, true);
  assert.equal(r.delivered, true);
});

test('a report inside the limits is stored untouched and reports no clamp', async () => {
  const bt = await load();
  const c = lead();
  const payload = { summary: 'shipped', pr_url: 'https://example.test/pr/1', paths: ['a.mjs', 'b.mjs'], followups: [] };
  const r = await bt.leadTools(c).get('soma_report')({ type: 'COMPLETED', payload });
  assert.deepEqual(c._events[0].payload, payload);
  assert.equal(r.clamped, false);
});

test('arrays are capped at 10 entries', async () => {
  const bt = await load();
  const c = lead();
  const r = await bt.leadTools(c).get('soma_report')({
    type: 'COMPLETED',
    payload: { paths: Array.from({ length: 40 }, (_, i) => `f${i}.mjs`), urls: Array.from({ length: 11 }, () => 'u') },
  });
  assert.equal(c._events[0].payload.paths.length, 10);
  assert.deepEqual(c._events[0].payload.paths[0], 'f0.mjs');
  assert.deepEqual(c._events[0].payload.paths[9], 'f9.mjs');
  assert.equal(c._events[0].payload.urls.length, 10);
  assert.equal(r.clamped, true);
});

test('the caps do not mutate the payload the caller handed in', async () => {
  const bt = await load();
  const c = lead();
  const payload = { summary: 'a'.repeat(5000), paths: Array.from({ length: 40 }, () => 'p') };
  await bt.leadTools(c).get('soma_report')({ type: 'COMPLETED', payload });
  assert.equal(payload.summary.length, 5000);
  assert.equal(payload.paths.length, 40);
  assert.notEqual(c._events[0].payload, payload);
});

test('no payload, however hostile, can put an unbounded line on the log', async () => {
  const bt = await load();
  const c = lead();
  const r = await bt.leadTools(c).get('soma_report')({
    type: 'ERROR',
    payload: {
      summary: 'x'.repeat(1_000_000),
      traceback: 'y'.repeat(1_000_000),
      paths: Array.from({ length: 5000 }, () => 'z'.repeat(5000)),
      wide: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, 'v'.repeat(500)])),
    },
  });
  assert.equal(r.clamped, true);
  const line = JSON.stringify(c._events[0]);      // this is the physical NDJSON line
  // 9 KiB throughout: the measured worst case over every shape probed is 8.3 KB, so
  // this is that ceiling plus headroom and nothing like the 47 KB an under-charged
  // key used to buy. A threshold loose enough to pass a mis-accounted line is not a
  // test of the bound.
  assert.ok(line.length < 9 * 1024, `line was ${line.length} chars`);
  assert.equal(c._events[0].payload.summary.length, 2000);
  assert.equal(c._events[0].payload.traceback.length, 2000);
  // Ten is the array cap (pinned exactly above, on a list that fits); here the
  // budget runs out inside the list, so what is left of it is shorter still.
  assert.ok(c._events[0].payload.paths.length <= 10);
  for (const p of c._events[0].payload.paths) assert.ok(p.length <= 512);
  // Past the budget the remaining fields are dropped, not truncated: `wide` never
  // made it onto the line at all, and the lead was told (`clamped`) that something
  // did not fit rather than left believing the log has it.
  assert.equal(c._events[0].payload.wide, undefined);
});

test('a shape too wide, too deep, or looped back on itself is stored bounded', async () => {
  const bt = await load();
  const c = lead();
  const deep = { level: 0 };
  let node = deep;
  for (let i = 1; i < 200; i += 1) { node.child = { level: i }; node = node.child; }
  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  const r = await bt.leadTools(c).get('soma_report')({
    type: 'ERROR',
    payload: { wide: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i])), deep, cyclic },
  });
  assert.equal(r.clamped, true);
  const stored = c._events[0].payload;
  assert.equal(Object.keys(stored.wide).length, 32);
  // Four levels below the payload root, and the chain stops — which is also the
  // branch a self-referential payload terminates on instead of recursing forever.
  assert.deepEqual(stored.deep, { level: 0, child: { level: 1, child: { level: 2, child: {} } } });
  assert.deepEqual(stored.cyclic, { name: 'loop', self: { name: 'loop', self: { name: 'loop', self: {} } } });
  assert.doesNotThrow(() => JSON.stringify(c._events[0]));
});

test('a field inside its cap is still cut to fit the line it escapes to', async () => {
  const bt = await load();
  const c = lead();
  // A control character is six characters wide on the line, so 2000 of them sit
  // inside the 2000-char summary cap and three times over the payload's budget.
  // (The everyday version of this is a summary of ANSI-coloured test output, where
  // every escape costs six.)
  const ansi = String.fromCharCode(27) + '[31mFAIL' + String.fromCharCode(27) + '[0m';
  // two escapes, each five characters wider on the line than in memory:
  assert.equal(JSON.stringify(ansi).length, ansi.length + 2 + 2 * 5);
  const control = String.fromCharCode(1).repeat(2000);   // no literal ESC in the source
  const r = await bt.leadTools(c).get('soma_report')({ type: 'ERROR', payload: { summary: control } });
  assert.equal(r.clamped, true);
  const line = JSON.stringify(c._events[0]);
  assert.ok(line.length < 9 * 1024, `line was ${line.length} chars`);
  const summary = c._events[0].payload.summary;
  assert.ok(summary.length < 2000 && summary.length > 0, `summary was ${summary.length} chars, not shortened to fit`);
});

test('shape alone cannot inflate a line either', async () => {
  const bt = await load();
  const c = lead();
  // Not one character of content: 32 fields of ten-wide arrays of ten-wide arrays…
  // If only content were charged for, this would serialize to a megabyte of
  // brackets while every named cap read as satisfied.
  const lattice = (depth) => (depth === 0 ? [] : Array.from({ length: 10 }, () => lattice(depth - 1)));
  const payload = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, lattice(5)]));
  const r = await bt.leadTools(c).get('soma_report')({ type: 'MILESTONE', payload });
  assert.equal(r.clamped, true);
  const line = JSON.stringify(c._events[0]);
  assert.ok(line.length < 9 * 1024, `line was ${line.length} chars`);
});

test('a field name is charged what it costs on the line, not what it costs in memory', async () => {
  const bt = await load();
  const c = lead();
  // A key is a string on the line like any other, so 120 control characters in a
  // *name* are 720 characters wide there. Charging the raw width under-charged this
  // sixfold and took the worst line from 8.4 KB to 47 KB — bounded, but not by the
  // number the log's atomicity argument leans on.
  const uniq = (i) => 'k' + String(i).padStart(3, '0');
  const ctrlKey = (i) => String.fromCharCode(1).repeat(116) + uniq(i);
  const surrKey = (i) => '\ud800'.repeat(116) + uniq(i);
  const keyed = (n, key, make) => Object.fromEntries(Array.from({ length: n }, (_, i) => [key(i), make(i)]));
  const shapes = {
    'flat control keys': keyed(40, ctrlKey, () => 1),
    'flat lone-surrogate keys': keyed(40, surrKey, () => 1),
    'control keys of objects of control keys': keyed(32, ctrlKey, (i) => keyed(32, ctrlKey, () => i)),
    'arrays of objects with control keys': keyed(32, ctrlKey, () => Array.from({ length: 32 }, () => keyed(32, ctrlKey, () => 'v'))),
  };
  for (const [what, payload] of Object.entries(shapes)) {
    const fresh = lead();
    const r = await bt.leadTools(fresh).get('soma_report')({ type: 'ERROR', payload });
    assert.equal(r.clamped, true, what);
    const line = JSON.stringify(fresh._events[0]);
    assert.ok(line.length < 9 * 1024, `${what}: line was ${line.length} chars`);
  }
  // And a name of ordinary characters still fits as many fields as it ever did.
  await bt.leadTools(c).get('soma_report')({ type: 'MILESTONE', payload: keyed(32, uniq, () => 'v') });
  assert.equal(Object.keys(c._events[0].payload).length, 32);
});

test('a field name too long to be a field name takes the field with it', async () => {
  const bt = await load();
  const c = lead();
  // The key reaches the line as well as the value, and it is the one string the
  // clamp cannot shorten without renaming the field.
  const r = await bt.leadTools(c).get('soma_report')({
    type: 'MILESTONE',
    payload: { summary: 'ok', ['k'.repeat(200_000)]: 'v' },
  });
  assert.equal(r.clamped, true);
  assert.deepEqual(c._events[0].payload, { summary: 'ok' });
  assert.ok(JSON.stringify(c._events[0]).length < 1024);
});

test('a payload key of __proto__ is stored as a field, not as a prototype', async () => {
  const bt = await load();
  const c = lead();
  // JSON.parse hands the bus an *own* '__proto__' key, and `out[k] = v` would
  // assign this object's prototype instead of the field — the log would silently
  // lose it, and the copy would carry a caller-chosen prototype.
  const payload = JSON.parse('{"__proto__": {"polluted": true}, "summary": "s"}');
  await bt.leadTools(c).get('soma_report')({ type: 'MILESTONE', payload });
  const stored = c._events[0].payload;
  assert.equal(Object.getPrototypeOf(stored), Object.prototype);
  assert.equal(stored.polluted, undefined);
  assert.equal(({}).polluted, undefined);
  assert.match(JSON.stringify(stored), /__proto__/);
});

test('the clamp keeps non-string leaves as they are', async () => {
  const bt = await load();
  const c = lead();
  await bt.leadTools(c).get('soma_report')({
    type: 'HARNESS',
    payload: { harness_id: 'H1', max_iterations: 6, autonomy: true, team_plan: { verifier: 'H4' }, unset: null },
  });
  assert.deepEqual(c._events[0].payload, {
    harness_id: 'H1', max_iterations: 6, autonomy: true, team_plan: { verifier: 'H4' }, unset: null,
  });
});

test('a non-string summary is stored as the text every consumer expects', async () => {
  const bt = await load();
  const c = lead();
  await bt.leadTools(c).get('soma_report')({ type: 'COMPLETED', payload: { summary: 42, question: ['a', 'b'] } });
  assert.equal(c._events[0].payload.summary, '42');
  assert.equal(c._events[0].payload.question, 'a,b');
});

// ---------------------------------------------------------------------------
// wake: who gets pushed, who gets toasted
// ---------------------------------------------------------------------------

test('only the urgent three push and toast; the rest wait for the watchdog', async () => {
  const bt = await load();
  let leaseReads = 0;
  const c = lead({ readLease: () => { leaseReads += 1; return { tmux_pane: '%1', wake: 'tmux' }; } });
  const report = bt.leadTools(c).get('soma_report');
  for (const type of ['STARTED', 'HARNESS', 'MILESTONE']) await report({ type, payload: {} });
  assert.equal(c._events.length, 3);
  assert.equal(c._keys.length, 0);
  assert.equal(c._toasts.length, 0);
  assert.equal(leaseReads, 0);        // a batched event does not even read the lease
});

test('each urgent type pushes and toasts, with the lead and the type in the line', async () => {
  const bt = await load();
  for (const type of ['NEEDS_INPUT', 'ERROR', 'COMPLETED']) {
    const c = lead();
    await bt.leadTools(c).get('soma_report')({ type, payload: {} });
    assert.equal(c._keys.length, 1, type);
    assert.equal(c._keys[0].t, '%1', type);
    assert.equal(c._keys[0].text, `[soma] cr-1 ${type}. Call soma_inbox.`, type);
    assert.deepEqual(c._toasts, [{ title: 'soma', body: `[soma] cr-1 ${type}` }], type);
  }
});

test('wake is callable on its own, for the orchestrator paths that will need it', async () => {
  const bt = await load();
  const c = lead();
  assert.equal(bt.wake(c, { lead: 'cr-9', type: 'ERROR' }), undefined);
  assert.equal(c._keys[0].text, '[soma] cr-9 ERROR. Call soma_inbox.');
  assert.equal(c._events.length, 0);          // wake stores nothing
});

// ---------------------------------------------------------------------------
// wake: BACKPRESSURE is the fourth urgent type (account rotation, design §3.8)
// ---------------------------------------------------------------------------

// A spend cap closes every seat at once: no rotation, no revival, no auto-continue can help,
// so it is the one watchdog event that must reach a human the way NEEDS_INPUT does. It has
// no lead — the line names the fleet.

test('BACKPRESSURE pushes into the orchestrator pane under a tmux lease', async () => {
  const bt = await load();
  const c = lead();
  bt.wake(c, { lead: null, type: 'BACKPRESSURE' });
  assert.deepEqual(c._keys, [{ t: '%1', text: '[soma] fleet BACKPRESSURE. Call soma_inbox.' }]);
});

test('BACKPRESSURE toasts, naming the fleet rather than a lead', async () => {
  const bt = await load();
  const c = lead();
  bt.wake(c, { lead: null, type: 'BACKPRESSURE' });
  assert.deepEqual(c._toasts, [{ title: 'soma', body: '[soma] fleet BACKPRESSURE' }]);
});

test('a BACKPRESSURE wake whose pane cannot be read types nothing', async () => {
  const bt = await load();
  const c = lead({ paneReading: () => ({ state: 'unobservable', fine: 'unobservable', kind: null, cmd: null, source: 'live', why: 'tmux timed out' }) });
  bt.wake(c, { lead: null, type: 'BACKPRESSURE' });
  assert.deepEqual(c._keys, []);
});

test('a BACKPRESSURE wake whose pane cannot be read still toasts, and says why it was not typed', async () => {
  const bt = await load();
  const c = lead({ paneReading: () => ({ state: 'unobservable', fine: 'unobservable', kind: null, cmd: null, source: 'live', why: 'tmux timed out' }) });
  bt.wake(c, { lead: null, type: 'BACKPRESSURE' });
  assert.deepEqual(c._toasts, [{ title: 'soma', body: "[soma] fleet BACKPRESSURE — not typed: the orchestrator's pane could not be read (tmux timed out)" }]);
});

test('the wake line has three states for the event lead — a name, the fleet, and a name that could not be read', async () => {
  const bt = await load();
  // `nonEmpty(lead) ? lead : 'fleet'` was two-state over a three-state world: "this event has
  // no lead" (a fleet event) and "this event's lead name is unreadable" both rendered as
  // `fleet`, which is a positive claim the operator acts on — every seat closed, admission
  // frozen, now. Before BACKPRESSURE joined URGENT the second case printed
  // `[soma] undefined NEEDS_INPUT`: useless, but visibly broken rather than confidently
  // wrong. Unreachable from the one call site today (`soma_report` matches SOMA_LEAD_NAME
  // against LEAD_RE before wake is reached), so what this pins is the rendering, not a path.
  const said = [];
  for (const event of [
    { lead: 'cr-1', type: 'NEEDS_INPUT' },   // a lead's own alarm: named
    { lead: null, type: 'BACKPRESSURE' },    // the fleet's: no lead at all
    { type: 'BACKPRESSURE' },                // the same fact, with the key absent
    { lead: 42, type: 'NEEDS_INPUT' },       // present and unreadable: not the fleet's
    { lead: '', type: 'NEEDS_INPUT' },
    { lead: {}, type: 'NEEDS_INPUT' },
  ]) {
    const c = lead();
    bt.wake(c, event);
    said.push(c._toasts[0]?.body ?? '(no toast)');
  }
  assert.deepEqual(said, [
    '[soma] cr-1 NEEDS_INPUT',
    '[soma] fleet BACKPRESSURE',
    '[soma] fleet BACKPRESSURE',
    '[soma] an unnamed lead NEEDS_INPUT',
    '[soma] an unnamed lead NEEDS_INPUT',
    '[soma] an unnamed lead NEEDS_INPUT',
  ]);
  // The expensive channel says the same thing: an unreadable name must not type a fleet-wide
  // alarm into the orchestrator's live composer.
  const c = lead();
  bt.wake(c, { lead: 42, type: 'NEEDS_INPUT' });
  assert.deepEqual(c._keys, [{ t: '%1', text: '[soma] an unnamed lead NEEDS_INPUT. Call soma_inbox.' }]);
});

test('every rotation event but BACKPRESSURE, plus REVIVED and the batched three, stays non-urgent: no lease read, no keys, no toast', async () => {
  const bt = await load();
  // The set grew by one name, not by a class. Design §3.8 marks the other five rotation events
  // "urgent: no", and SEAT_CLOSED is the one a later hand is most likely to promote so the
  // operator "sees closures" — at which point every seat closure types a line into the
  // orchestrator's live composer and fires a toast, which is exactly the "talks its supervisor
  // to death" failure the comment above URGENT exists to prevent. So all five are named here,
  // not just the two that reach a lead, and each is asserted under its own label: a promotion
  // reddens on the name that was promoted.
  const NOT_URGENT = [
    'REVIVED', 'ROTATED', 'SEAT_CLOSED', 'SEAT_REOPENED', 'ROTATION_FAILED', 'ROTATION_UNAVAILABLE',
    'STARTED', 'HARNESS', 'MILESTONE',
  ];
  // The list above is a literal, so this is what keeps it exhaustive: a seventh rotation event
  // must either appear in it or be declared urgent on purpose. Without this the loop could
  // silently stop covering the family it is named for.
  assert.deepEqual(
    ROTATION_EVENT_TYPES.filter((t) => !NOT_URGENT.includes(t)),
    ['BACKPRESSURE'],
    'BACKPRESSURE is the only rotation event that may be urgent; every other one belongs in the loop below',
  );
  for (const type of NOT_URGENT) {
    let leaseReads = 0;
    const c = lead({ readLease: () => { leaseReads += 1; return { tmux_pane: '%1', wake: 'tmux' }; } });
    bt.wake(c, { lead: 'cr-1', type });
    assert.equal(leaseReads, 0, type);
    assert.deepEqual(c._keys, [], type);
    assert.deepEqual(c._toasts, [], type);
  }
});

test('a lead still cannot file BACKPRESSURE: REPORT_TYPES did not grow with URGENT', async () => {
  const bt = await load();
  const c = lead();
  const r = await bt.leadTools(c).get('soma_report')({ type: 'BACKPRESSURE', payload: { reason: 'org_level_disabled_until' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /^unknown report type "BACKPRESSURE"; expected one of STARTED, HARNESS, MILESTONE, NEEDS_INPUT, COMPLETED, ERROR$/);
});

test('a refused BACKPRESSURE report stores nothing and types nothing', async () => {
  const bt = await load();
  const c = lead();
  await bt.leadTools(c).get('soma_report')({ type: 'BACKPRESSURE', payload: {} });
  assert.deepEqual([c._events, c._keys, c._toasts], [[], [], []]);
});

// The orchestrator's own pane is a pane too (the pane gate, added after leads were found stalled
// on prompts nobody saw). Measured: `send-keys -l` into a live permission dialog is swallowed and
// the Enter selects the highlighted "1. Yes"; into a bare shell the line executes; into a dead
// pane tmux exits 0. So `wake` looks before it types.
const RULE = '─'.repeat(80);
const IDLE_FRAME = [RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'].join('\n');
const PROMPT_FRAME = [RULE, ' Bash command', '', '   │ cd /w && grep -n x f', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend'].join('\n');
/** The AskUserQuestion dialog, in its measured layout — an orchestrator can be on one too. */
const QUESTION_FRAME = ['│ May I proceed?', '', '❯ 1. Yes', '  2. No, hold', '  3. Type something.', RULE, '  4. Chat about this', '', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'].join('\n');
/** The lease names the orchestrator's pane by id (`%1`), so the listing must be searchable by it. */
const orchPanes = (over = {}) => {
  const pane = { pane_id: '%1', dead: false, cmd: '2.1.263', pid: 1, title: '✳ orchestrator', active: true, ...over };
  return new Map([['orch', { dead: pane.dead, cmd: pane.cmd, pid: pane.pid, title: pane.title, pane_id: '%1', active: true, panes: [pane] }]]);
};
/** `soma-bus.mjs`'s `paneReading` dep, built as it builds it: the real `readPane` over a listing and a screen. */
const { readPane } = await import('../bin/lib/wd/pane-state.mjs');
const reader = (panes, frame) => ({ paneReading: (target) => readPane(target, { panes, capture: () => frame }) });

test('wake does not type into an orchestrator pane that is on a dialog, a shell or dead — the toast says why', async () => {
  const bt = await load();
  const cases = [
    ['blocked_on_prompt', reader(orchPanes(), PROMPT_FRAME), /prompt|dialog/i],
    ['blocked_on_prompt/question', reader(orchPanes(), QUESTION_FRAME), /question/i],
    ['dead_shell', reader(orchPanes({ cmd: 'zsh', title: '' }), ''), /shell/i],
    ['dead_pane', reader(orchPanes({ dead: true, cmd: 'env', title: '' }), ''), /dead/i],
    // The lease names a pane that is no longer on the server (the orchestrator's tmux window was
    // closed; the lease has not yet been declared stale): nothing to type into, and the toast says so.
    ['absent', reader(new Map(), ''), /gone|absent|no pane/i],
  ];
  for (const [name, over, why] of cases) {
    const c = lead(over);
    await bt.leadTools(c).get('soma_report')({ type: 'COMPLETED', payload: {} });
    assert.equal(c._keys.length, 0, `${name}: no keystroke`);
    assert.equal(c._toasts.length, 1, `${name}: the toast still fires — it is the channel that reaches a human`);
    assert.match(c._toasts[0].body, why, name);
    assert.match(c._toasts[0].body, /cr-1 COMPLETED/, `${name}: and still says who and what`);
  }
});

test('wake does not type when the pane cannot be read, and does type into an idle or unrecognised pane, or when no reader is wired', async () => {
  const bt = await load();
  // The listing failed: the wake cannot rule out a dialog, so the push is withheld and the pull
  // path (inject, soma_inbox) carries the event. Latency degrades; nothing is approved blind.
  const unlisted = lead(reader(null, IDLE_FRAME));
  await bt.leadTools(unlisted).get('soma_report')({ type: 'ERROR', payload: {} });
  assert.equal(unlisted._keys.length, 0);
  assert.equal(unlisted._toasts.length, 1);
  assert.match(unlisted._toasts[0].body, /could not be read/i);
  // A reader that answers asynchronously cannot be consulted inside this synchronous path: that
  // is the same "could not be read", not a licence to type.
  const asyncReader = lead({ paneReading: async (target) => readPane(target, { panes: orchPanes(), capture: () => IDLE_FRAME }) });
  await bt.leadTools(asyncReader).get('soma_report')({ type: 'ERROR', payload: {} });
  assert.equal(asyncReader._keys.length, 0);
  assert.equal(asyncReader._toasts.length, 1);

  const idle = lead(reader(orchPanes(), IDLE_FRAME));
  await bt.leadTools(idle).get('soma_report')({ type: 'NEEDS_INPUT', payload: {} });
  assert.equal(idle._keys.length, 1);
  assert.equal(idle._keys[0].text, '[soma] cr-1 NEEDS_INPUT. Call soma_inbox.');
  // An orchestrator in normal permission mode shows `? for shortcuts` rather than the bypass
  // status line; anything else it might show is unrecognised, which is a reading, not a hazard.
  const odd = lead(reader(orchPanes({ cmd: 'node' }), 'a screen the classifier has never seen'));
  await bt.leadTools(odd).get('soma_report')({ type: 'NEEDS_INPUT', payload: {} });
  assert.equal(odd._keys.length, 1);
  // No pane reader at all (this harness's default): the behaviour from before the pane gate, unchanged.
  const bare = lead();
  await bt.leadTools(bare).get('soma_report')({ type: 'COMPLETED', payload: {} });
  assert.equal(bare._keys.length, 1);
});

test('the 30s debounce gates the push, never the toast', async () => {
  const bt = await load();
  for (const [age, pushes] of [[0, 0], [29_999, 0], [30_000, 0], [30_001, 1], [Infinity, 1]]) {
    const c = lead({ lastWakeAgeMs: () => age });
    await bt.leadTools(c).get('soma_report')({ type: 'ERROR', payload: {} });
    assert.equal(c._keys.length, pushes, `age ${age}`);
    assert.equal(c._toasts.length, 1, `age ${age}`);   // urgent always toasts
  }
});

test('the push stamps the shared debounce clock before it types', async () => {
  const bt = await load();
  const order = [];
  const c = lead({
    stampWake: () => order.push('stamp'),
    // Stamped first, so a pane that has gone away costs one attempt per 30s
    // rather than one per report — even when the send itself blows up.
    sendKeys: () => { order.push('keys'); throw new Error('pane went away'); },
  });
  const r = await bt.leadTools(c).get('soma_report')({ type: 'COMPLETED', payload: {} });
  assert.deepEqual(order, ['stamp', 'keys']);
  assert.equal(r.delivered, true);
  assert.equal(c._toasts.length, 1);
});

test('a debounced push does not stamp the clock', async () => {
  const bt = await load();
  let stamps = 0;
  const c = lead({ lastWakeAgeMs: () => 1000, stampWake: () => { stamps += 1; } });
  await bt.leadTools(c).get('soma_report')({ type: 'ERROR', payload: {} });
  assert.equal(stamps, 0);
});

test('no lease, or a lease that does not want keys, means no keys', async () => {
  const bt = await load();
  for (const lease of [null, undefined, { wake: 'notify', tmux_pane: null }, { wake: 'tmux' }, 'nonsense']) {
    const c = lead({ readLease: () => lease });
    await bt.leadTools(c).get('soma_report')({ type: 'NEEDS_INPUT', payload: { question: 'which branch?' } });
    const wantKeys = lease && lease.wake === 'tmux' ? 1 : 0;
    assert.equal(c._keys.length, wantKeys, JSON.stringify(lease));
    assert.equal(c._toasts.length, 1, JSON.stringify(lease));   // the operator hears it either way
    assert.equal(c._events.length, 1, JSON.stringify(lease));
  }
});

test('a wake that cannot run does not un-store a stored report', async () => {
  const bt = await load();
  const boom = () => { throw new Error('EACCES'); };
  for (const overrides of [{ readLease: boom }, { lastWakeAgeMs: boom }, { sendKeys: boom }, { notify: boom }, { stampWake: boom }]) {
    const c = lead(overrides);
    const r = await bt.leadTools(c).get('soma_report')({ type: 'ERROR', payload: { summary: 'died' } });
    assert.equal(r.delivered, true, Object.keys(overrides)[0]);
    assert.equal(r.stored_id, '1', Object.keys(overrides)[0]);
    assert.equal(c._events.length, 1, Object.keys(overrides)[0]);
  }
});

test('a broken push still lets the operator hear an urgent event', async () => {
  const bt = await load();
  const c = lead({ readLease: () => { throw new Error('EIO'); } });
  await bt.leadTools(c).get('soma_report')({ type: 'NEEDS_INPUT', payload: {} });
  assert.deepEqual(c._toasts, [{ title: 'soma', body: '[soma] cr-1 NEEDS_INPUT' }]);
});

test('a dep that returns a promise cannot float a rejection out of wake', async () => {
  const bt = await load();
  const c = lead({
    sendKeys: () => Promise.reject(new Error('pane went away')),
    notify: () => Promise.reject(new Error('no dbus')),
    stampWake: () => Promise.reject(new Error('read-only fs')),
  });
  const r = await bt.leadTools(c).get('soma_report')({ type: 'ERROR', payload: {} });
  assert.equal(r.delivered, true);
  await drain();     // an unhandled rejection here would fail this file
});

// ---------------------------------------------------------------------------
// wake: only into a pane on this bus's own tmux server (issue #1)
// ---------------------------------------------------------------------------

// A pane id is a small per-server counter, so `%40` on one tmux server and `%40` on another are
// two strangers' terminals. Seen in the field: two fleets on two sockets, both orchestrators in
// `%40` of their own server, and every NEEDS_INPUT and COMPLETED wake from the second fleet's
// leads typed into the FIRST fleet's orchestrator. The lead's bus did not know its fleet's socket,
// fell back to `soma`, and never compared that with the socket the lease records.
// `test/wake-sockets.test.mjs` reproduces it on real tmux; these pin the rule itself.

/** An idle orchestrator pane, read through the real `readPane`, with every read recorded. */
const countedReader = () => {
  const reads = [];
  return {
    reads,
    deps: { paneReading: (target) => { reads.push(target); return readPane(target, { panes: orchPanes(), capture: () => IDLE_FRAME }); } },
  };
};

/** A wake ctx: the bus's env (beside the lead name) and the lease it reads, all effects recorded. */
const wakeCtx = (env, lease) => {
  const gate = countedReader();
  const order = [];
  const c = ctx({ SOMA_LEAD_NAME: 'cr-1', ...env }, {
    ...gate.deps,
    readLease: () => lease,
    stampWake: () => order.push('stamp'),
    sendKeys: (t, text) => { order.push('keys'); c._keys.push({ t, text }); },
  });
  return { c, reads: gate.reads, order };
};

const NEEDS_INPUT = { type: 'NEEDS_INPUT', payload: { question: 'which branch?' } };
const TYPED = [{ t: '%1', text: '[soma] cr-1 NEEDS_INPUT. Call soma_inbox.' }];

test('a lease on another tmux server is never typed into: no pane read, no stamp, no keys, and the toast says why', async () => {
  const bt = await load();
  const { c, reads, order } = wakeCtx({ SOMA_TMUX_SOCKET: 'soma' }, { tmux_socket: 'soma_pers', tmux_pane: '%1', wake: 'tmux' });
  const r = await bt.leadTools(c).get('soma_report')(NEEDS_INPUT);
  assert.equal(r.delivered, true, 'the report is on the log either way: the inject hook and soma_inbox carry it');
  assert.deepEqual(c._keys, [], "%1 on this bus's server is a stranger's pane, not the orchestrator's");
  assert.deepEqual(reads, [], "the pane gate reads %1 on this bus's server, so even looking would judge a stranger's pane");
  assert.deepEqual(order, [], 'a push never attempted must not spend the fleet-wide debounce');
  assert.deepEqual(c._toasts, [{ title: 'soma', body: "[soma] cr-1 NEEDS_INPUT — not typed: the orchestrator's pane is on tmux server soma_pers, not this bus's soma" }]);
});

test("a bus that was never told its socket is on the default server, so it holds a lease on any other (the field report's own case)", async () => {
  const bt = await load();
  // `''` is how soma spells unset, so it falls back exactly as the absent variable does.
  for (const env of [{}, { SOMA_TMUX_SOCKET: '' }]) {
    const { c, reads } = wakeCtx(env, { tmux_socket: 'soma2', tmux_pane: '%1', wake: 'tmux' });
    await bt.leadTools(c).get('soma_report')(NEEDS_INPUT);
    assert.deepEqual(c._keys, [], JSON.stringify(env));
    assert.deepEqual(reads, [], JSON.stringify(env));
    assert.deepEqual(c._toasts.map((x) => x.body), ["[soma] cr-1 NEEDS_INPUT — not typed: the orchestrator's pane is on tmux server soma2, not this bus's soma"], JSON.stringify(env));
  }
});

test('a lease on the same server is typed exactly as before: one reading of the pane, stamp, then keys', async () => {
  const bt = await load();
  const { c, reads, order } = wakeCtx({ SOMA_TMUX_SOCKET: 'soma_pers' }, { tmux_socket: 'soma_pers', tmux_pane: '%1', wake: 'tmux' });
  await bt.leadTools(c).get('soma_report')(NEEDS_INPUT);
  assert.deepEqual(c._keys, TYPED);
  assert.deepEqual(reads, ['%1']);
  assert.deepEqual(order, ['stamp', 'keys']);
  assert.deepEqual(c._toasts, [{ title: 'soma', body: '[soma] cr-1 NEEDS_INPUT' }]);
});

test('the default fleet is unchanged: a lease on soma is typed by a bus with no socket, an empty one, or soma', async () => {
  const bt = await load();
  for (const env of [{}, { SOMA_TMUX_SOCKET: '' }, { SOMA_TMUX_SOCKET: 'soma' }]) {
    const { c } = wakeCtx(env, { tmux_socket: 'soma', tmux_pane: '%1', wake: 'tmux' });
    await bt.leadTools(c).get('soma_report')(NEEDS_INPUT);
    assert.deepEqual(c._keys, TYPED, JSON.stringify(env));
    assert.deepEqual(c._toasts.map((x) => x.body), ['[soma] cr-1 NEEDS_INPUT'], JSON.stringify(env));
  }
});

test('a lease that records no socket is typed as it always was, by the rule demote() already follows', async () => {
  const bt = await load();
  // Nothing to compare, so nothing to refuse on: a lease written before the socket was recorded,
  // or by hand. `acquireLease` writes `tmux_socket || null`, so `''` only arrives by hand edit.
  for (const lease of [{ tmux_socket: null, tmux_pane: '%1', wake: 'tmux' }, { tmux_pane: '%1', wake: 'tmux' }, { tmux_socket: '', tmux_pane: '%1', wake: 'tmux' }]) {
    const { c } = wakeCtx({ SOMA_TMUX_SOCKET: 'soma_pers' }, lease);
    await bt.leadTools(c).get('soma_report')(NEEDS_INPUT);
    assert.deepEqual(c._keys, TYPED, JSON.stringify(lease));
  }
});

test('the hold names the two servers without echoing a path or an unbounded string out of the lease', async () => {
  const bt = await load();
  // The lease is a file an operator can edit and a model can fill, so what it says is not quoted
  // into a toast unless it is shaped like a socket name: short, and no slash.
  for (const odd of ['/private/tmp/tmux-501/default', 'x'.repeat(10_000), 'two words']) {
    const { c } = wakeCtx({ SOMA_TMUX_SOCKET: 'soma' }, { tmux_socket: odd, tmux_pane: '%1', wake: 'tmux' });
    await bt.leadTools(c).get('soma_report')(NEEDS_INPUT);
    assert.deepEqual(c._keys, [], 'it is still another server, so still held');
    const body = c._toasts[0]?.body ?? '';
    assert.match(body, /^\[soma\] cr-1 NEEDS_INPUT — not typed: the orchestrator's pane is on tmux server .+, not this bus's soma$/, body.slice(0, 200));
    assert.ok(!body.includes('/'), `a path reached the toast: ${body.slice(0, 200)}`);
    assert.ok(body.length <= 200, `the toast grew with the lease: ${body.length} characters`);
  }
});

// ---------------------------------------------------------------------------
// soma_task
// ---------------------------------------------------------------------------

test('soma_task hands back the six fields a re-orienting lead needs', async () => {
  const bt = await load();
  const asked = [];
  const c = lead({
    taskFor: (id) => {
      asked.push(id);
      return { id: 'cr-1', brief: 'do x', repo: 'acme/app', base_branch: 'develop',
               source: { ref: 'refs/heads/feat', url: 'u' }, verify_hint: 'npm test', status: 'spawned' };
    },
  });
  const r = await bt.leadTools(c).get('soma_task')({});
  assert.deepEqual(r, {
    task_id: 'cr-1', brief: 'do x', repo: 'acme/app', base_branch: 'develop',
    source_ref: 'refs/heads/feat', verify_hint: 'npm test',
  });
  assert.deepEqual(asked, ['cr-1']);      // its own row, keyed by SOMA_LEAD_NAME
});

test('soma_task fills the fields a task row happens not to carry', async () => {
  const bt = await load();
  const c = lead({ taskFor: () => ({ id: 'cr-1', brief: 'b' }) });
  const r = await bt.leadTools(c).get('soma_task')({});
  assert.deepEqual(r, { task_id: 'cr-1', brief: 'b', repo: null, base_branch: null, source_ref: null, verify_hint: null });
});

test('soma_task says so when there is no row, instead of answering in nulls', async () => {
  const bt = await load();
  for (const row of [{}, null, undefined, { id: '' }, { brief: 'orphan' }]) {
    const r = await bt.leadTools(lead({ taskFor: () => row })).get('soma_task')({});
    assert.equal(r.ok, false, JSON.stringify(row));
    assert.equal(typeof r.error, 'string', JSON.stringify(row));
  }
});

// ---------------------------------------------------------------------------
// soma_checkpoint
// ---------------------------------------------------------------------------

test('soma_checkpoint files a MILESTONE marked as a checkpoint', async () => {
  const bt = await load();
  const c = lead();
  const r = await bt.leadTools(c).get('soma_checkpoint')({ note: 'verifier green' });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(c._events, [{ s: 'cr-1', type: 'MILESTONE', payload: { note: 'verifier green', checkpoint: true }, lead: 'cr-1' }]);
});

test('soma_checkpoint stays cheap: no lease read, no keys, no toast', async () => {
  const bt = await load();
  let leaseReads = 0;
  const c = lead({ readLease: () => { leaseReads += 1; return { wake: 'tmux', tmux_pane: '%1' }; } });
  const checkpoint = bt.leadTools(c).get('soma_checkpoint');
  for (let i = 0; i < 20; i += 1) await checkpoint({ note: `step ${i}` });
  assert.equal(c._events.length, 20);
  assert.equal(leaseReads, 0);
  assert.equal(c._keys.length, 0);
  assert.equal(c._toasts.length, 0);
});

test('soma_checkpoint defaults its note and clamps a long one', async () => {
  const bt = await load();
  const c = lead();
  await bt.leadTools(c).get('soma_checkpoint')({});
  assert.deepEqual(c._events[0].payload, { note: '', checkpoint: true });
  await bt.leadTools(c).get('soma_checkpoint')({ note: 'n'.repeat(50_000) });
  assert.ok(c._events[1].payload.note.length <= 2000);
  assert.equal(c._events[1].payload.checkpoint, true);
});

// ---------------------------------------------------------------------------
// A lead id is the stream name, so it is checked before it reaches the log
// ---------------------------------------------------------------------------

test('a missing or unusable SOMA_LEAD_NAME is a diagnosable refusal, not a stray log file', async () => {
  const bt = await load();
  for (const name of [undefined, '', '   ', 'orch', '../../etc/passwd', 'CR-1', 'cr 1', 'cr/1', 'x'.repeat(200)]) {
    const c = ctx({ SOMA_LEAD_NAME: name });
    const tools = bt.leadTools(c);
    for (const tool of ['soma_report', 'soma_task', 'soma_checkpoint']) {
      const r = await tools.get(tool)({ type: 'COMPLETED', payload: {}, note: 'n' });
      assert.equal(r.ok, false, `${tool} ${JSON.stringify(name)}`);
      assert.match(r.error, /SOMA_LEAD_NAME/, `${tool} ${JSON.stringify(name)}`);
    }
    assert.equal(c._events.length, 0, JSON.stringify(name));
    assert.equal(c._keys.length, 0, JSON.stringify(name));
  }
  // 'orch' is refused for a reason of its own: it is the orchestrator's stream.
  assert.equal((await bt.leadTools(ctx({ SOMA_LEAD_NAME: 'orch' })).get('soma_report')({ type: 'ERROR' })).ok, false);
});

test('no refusal leaks a filesystem path back to the model', async () => {
  const bt = await load();
  const refusals = [];
  const c = ctx({ SOMA_LEAD_NAME: '' });
  for (const [, fn] of bt.leadTools(c)) refusals.push(await fn({}));
  const d = lead();
  refusals.push(await bt.leadTools(d).get('soma_report')({ type: 'NOPE' }));
  refusals.push(await bt.leadTools(d).get('soma_report')({ type: 'ERROR', payload: 'oops' }));
  refusals.push(await bt.leadTools(lead({ taskFor: () => ({}) })).get('soma_task')({}));
  for (const r of refusals) {
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.error, /[/\\]/, r.error);
  }
});

// ---------------------------------------------------------------------------
// Deps are awaited, so an async one is not a silently wrong answer
// ---------------------------------------------------------------------------

test('a handler awaits its deps, so an async dep still answers correctly', async () => {
  const bt = await load();
  const c = lead({
    appendEvent: async (s, e) => { c._events.push({ s, ...e }); return { id: 'async-1', ts: 2 }; },
    validateHarnessReport: async () => ({ ok: true }),
    taskFor: async () => ({ id: 'cr-1', brief: 'awaited' }),
  });
  const tools = bt.leadTools(c);
  const r = await tools.get('soma_report')({ type: 'HARNESS', payload: { harness_id: 'H1' } });
  assert.equal(r.stored_id, 'async-1');
  assert.equal(c._events.length, 1);
  assert.equal((await tools.get('soma_task')({})).brief, 'awaited');
  await drain();
});

test('a log that cannot be written is a refusal that does not name the file', async () => {
  const bt = await load();
  // What node:fs actually throws: the absolute path of the file it could not open
  // is in the message, and the transport hands a thrown message to the model.
  const enoent = () => {
    const e = new Error("ENOENT: no such file or directory, open '/Users/someone/.soma/events/cr-1.ndjson'");
    e.code = 'ENOENT';
    e.path = '/Users/someone/.soma/events/cr-1.ndjson';
    throw e;
  };
  const c = lead({ appendEvent: enoent });
  const tools = bt.leadTools(c);
  for (const [name, args] of [['soma_report', { type: 'ERROR', payload: {} }], ['soma_checkpoint', { note: 'n' }]]) {
    const r = await tools.get(name)(args);
    assert.equal(r.ok, false, name);
    assert.doesNotMatch(r.error, /[/\\]/, `${name} leaked a path: ${r.error}`);
    assert.doesNotMatch(r.error, /soma|ndjson|ENOENT/i, `${name} leaked the file: ${r.error}`);
  }
  assert.equal(c._keys.length, 0);      // nothing stored, so nobody is woken
  assert.equal(c._toasts.length, 0);
});

test('an async appendEvent that rejects leaks no path either', async () => {
  const bt = await load();
  const c = lead({ appendEvent: async () => { throw new Error("EACCES: permission denied, open '/root/.soma/events/cr-1.ndjson'"); } });
  const r = await bt.leadTools(c).get('soma_report')({ type: 'COMPLETED', payload: { summary: 's' } });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error, /[/\\]/);
  await drain();
});
