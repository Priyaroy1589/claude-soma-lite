import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('append is single-line and readable; cursor advances', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'soma-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.SOMA_HOME = home;
  const { ensureTree } = await import('../bin/lib/paths.mjs?' + Date.now());
  ensureTree();
  const ev = await import('../bin/lib/events.mjs?' + Date.now());
  const a = ev.appendEvent('cr-1', { type: 'STARTED', payload: { x: 1 }, lead: 'cr-1' });
  const b = ev.appendEvent('cr-1', { type: 'COMPLETED', payload: { pr_url: 'u' }, lead: 'cr-1' });
  assert.notEqual(a.id, b.id);
  const all = ev.readEvents('cr-1');
  assert.equal(all.length, 2);
  assert.equal(all[1].type, 'COMPLETED');
  assert.equal(all[1].payload.pr_url, 'u');
  const fresh = ev.unread('orch', ['cr-1']);
  assert.equal(fresh.length, 2);
  ev.writeCursor('orch', b.id);
  assert.equal(ev.unread('orch', ['cr-1']).length, 0);
});

test('payload with newline stays one physical line', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'soma-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.SOMA_HOME = home;
  const { ensureTree } = await import('../bin/lib/paths.mjs?' + Date.now());
  ensureTree();
  const ev = await import('../bin/lib/events.mjs?' + Date.now());
  ev.appendEvent('cr-2', { type: 'MILESTONE', payload: { note: 'line1\nline2' } });
  const { readFileSync } = await import('node:fs');
  const { p } = await import('../bin/lib/paths.mjs?' + Date.now());
  const raw = readFileSync(p('events', 'cr-2.ndjson'), 'utf8').trimEnd();
  assert.equal(raw.split('\n').length, 1);
  assert.equal(ev.readEvents('cr-2')[0].payload.note, 'line1\nline2');
});

// The two tests above are the original spec, verbatim. The rest pin the
// invariants they imply — every one of them a silent-event-loss path in a log
// whose consumers ask for "everything after this id".

/** Fresh temp state root + a fresh events module instance (its own id counter). */
async function freshHome(t, tag) {
  const home = mkdtempSync(join(tmpdir(), 'soma-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.SOMA_HOME = home;
  const { ensureTree, p } = await import('../bin/lib/paths.mjs?' + tag);
  ensureTree();
  return { home, p, ev: await import('../bin/lib/events.mjs?' + tag) };
}

test('ids are fixed-width and sort in append order through a same-millisecond burst', async (t) => {
  const { ev } = await freshHome(t, 'burst');
  const ids = [];
  for (let i = 0; i < 500; i++) ids.push(ev.appendEvent('cr-3', { type: 'MILESTONE', payload: { i } }).id);

  for (const id of ids) assert.match(id, /^\d{13}-\d{4}$/); // padded: '10' must never compare below '9'
  for (let i = 1; i < ids.length; i++) {
    assert.ok(ids[i] > ids[i - 1], `id ${ids[i]} does not sort after ${ids[i - 1]}`);
  }

  const events = ev.readEvents('cr-3');
  assert.deepEqual(events.map((e) => e.id), ids);
  assert.deepEqual(events.map((e) => e.payload.i), [...ids.keys()]);
  // `ts` IS the id prefix, stated as the identity the module's ordering argument
  // rests on. Through a padded string this reads the same but pins less; the case
  // where the two can actually come apart is the stubbed clock below, where
  // `Date.now()` and `lastTs` disagree.
  for (const e of events) assert.equal(Number(e.id.split('-')[0]), e.ts);
  assert.ok(
    new Set(events.map((e) => e.ts)).size < events.length,
    'no two appends shared a millisecond — this test no longer exercises the same-ms path',
  );

  // The property consumers actually depend on: walking the cursor one event at a
  // time delivers every event exactly once, in order.
  const walked = [];
  for (;;) {
    const next = ev.unread('walker', ['cr-3'])[0];
    if (!next) break;
    walked.push(next.id);
    ev.writeCursor('walker', next.id);
  }
  assert.deepEqual(walked, ids);
});

test('the id clock never runs backwards, whatever the wall clock does', async (t) => {
  const { ev } = await freshHome(t, 'ntp');
  // `stamp()` reads `Date.now()`, so the clock is the effect to stub — the way
  // `notify.test.mjs` stubs `process.platform`. Restored first, before the home is
  // removed, so a failure mid-test cannot leave the stub installed for the next file.
  const real = Date.now;
  t.after(() => { Date.now = real; });

  let fake = 1_800_000_000_000;
  Date.now = () => fake;
  const before = ev.appendEvent('cr-10', { type: 'STARTED', payload: {}, lead: 'cr-10' });

  fake -= 60_000;                       // an NTP step, or a VM resuming with a bad RTC
  const after = ev.appendEvent('cr-10', { type: 'MILESTONE', payload: {}, lead: 'cr-10' });

  // Every consumer asks for `id > cursor`, so an id minted below one already consumed
  // is not a mis-sort: it is an event nobody ever sees again — the NEEDS_INPUT nobody
  // answers. `lastTs` is a monotonic stamp seeded by the wall clock, not the clock.
  assert.ok(after.id > before.id, `an id minted after a backwards clock step sorts below the cursor: ${after.id} <= ${before.id}`);
  assert.ok(after.ts >= before.ts, `the log's ts moved backwards: ${after.ts} < ${before.ts}`);
  // And here the `ts`-is-the-id-prefix identity is decidable: this is the one moment
  // `Date.now()` and `lastTs` differ, so a `ts` taken from the clock rather than from
  // the stamp shows up instead of passing by luck.
  assert.equal(Number(after.id.split('-')[0]), after.ts, 'ts is no longer the numeric prefix of its own id');

  // The consequence, end to end: a consumer parked on the first event still receives
  // the second one.
  ev.writeCursor('orch', before.id);
  assert.deepEqual(ev.unread('orch', ['cr-10']).map((e) => e.id), [after.id],
    'an event minted after a backwards clock step was silently lost');
});

test('sinceId is exclusive and cursors are per-consumer and file-backed', async (t) => {
  const { ev } = await freshHome(t, 'cursors');
  const a = ev.appendEvent('cr-4', { type: 'STARTED', payload: {}, lead: 'cr-4' });
  const b = ev.appendEvent('cr-4', { type: 'COMPLETED', payload: {}, lead: 'cr-4' });

  assert.deepEqual(ev.readEvents('cr-4', { sinceId: a.id }).map((e) => e.id), [b.id]);
  assert.deepEqual(ev.readEvents('cr-4', { sinceId: b.id }), []);

  assert.equal(ev.readCursor('orch'), null); // never read
  ev.writeCursor('orch', a.id);
  assert.equal(ev.readCursor('orch'), a.id);
  assert.equal(ev.readCursor('watchdog'), null); // keyed by role: one advancing never moves another
  assert.equal(ev.unread('orch', ['cr-4']).length, 1);
  assert.equal(ev.unread('watchdog', ['cr-4']).length, 2);

  // The bus and the watchdog are separate processes: a cursor has to live on disk,
  // not in the module instance that wrote it.
  const reloaded = await import('../bin/lib/events.mjs?cursors-reload');
  assert.equal(reloaded.readCursor('orch'), a.id);
});

test('unread merges streams oldest-first and ignores streams never written', async (t) => {
  const { ev } = await freshHome(t, 'merge');
  const first = ev.appendEvent('cr-5', { type: 'STARTED', payload: {}, lead: 'cr-5' });
  const second = ev.appendEvent('cr-6', { type: 'STARTED', payload: {}, lead: 'cr-6' });
  const third = ev.appendEvent('cr-5', { type: 'COMPLETED', payload: {}, lead: 'cr-5' });

  // 'cr-7' is queued but has never reported — its stream file does not exist yet.
  const events = ev.unread('orch', ['cr-5', 'cr-6', 'cr-7']);
  assert.deepEqual(events.map((e) => e.id), [first.id, second.id, third.id]);
  assert.deepEqual(events.map((e) => e.lead), ['cr-5', 'cr-6', 'cr-5']);
  assert.deepEqual(ev.readEvents('cr-7'), []);

  // soma_inbox's idiom: take a prefix, park the cursor on its last element.
  ev.writeCursor('orch', events[1].id);
  assert.deepEqual(ev.unread('orch', ['cr-5', 'cr-6', 'cr-7']).map((e) => e.id), [third.id]);
});

test('a line that is not an event costs one event, not the log; a torn cursor file replays', async (t) => {
  const { ev, p } = await freshHome(t, 'torn');
  const fp = p('events', 'cr-8.ndjson');
  const a = ev.appendEvent('cr-8', { type: 'STARTED', payload: {}, lead: 'cr-8' });
  appendFileSync(fp, '{"id":"tor\n'); // a hand-edit, or a fragment that kept its newline
  // Valid JSON that is not an event: a scalar, an array, an object with no id. All
  // parse, so only a shape check keeps them out of `event.id` and out of callers.
  appendFileSync(fp, 'null\n0\n"x"\n[1,2]\n{"type":"STARTED"}\n');
  const b = ev.appendEvent('cr-8', { type: 'COMPLETED', payload: {}, lead: 'cr-8' });
  appendFileSync(fp, '{"id":"tor'); // the realistic shape: writer killed mid-append, at EOF

  assert.deepEqual(ev.readEvents('cr-8').map((e) => e.id), [a.id, b.id]);
  assert.deepEqual(ev.readEvents('cr-8', { sinceId: a.id }).map((e) => e.id), [b.id]);
  assert.deepEqual(ev.unread('orch', ['cr-8']).map((e) => e.id), [a.id, b.id]);

  writeFileSync(p('events', '.cursors.json'), '{"orch": "1753'); // half-written map
  assert.equal(ev.readCursor('orch'), null);
  assert.equal(ev.unread('orch', ['cr-8']).length, 2); // replays rather than going blind
  ev.writeCursor('orch', b.id); // and the next write heals the file
  assert.equal(ev.readCursor('orch'), b.id);
  assert.equal(ev.unread('orch', ['cr-8']).length, 0);
});

test('appendEvent defaults payload/lead, rejects a typeless event, and recreates a wiped events dir', async (t) => {
  const { ev, p } = await freshHome(t, 'guards');
  ev.appendEvent('cr-9', { type: 'TURN_END' });
  assert.deepEqual(ev.readEvents('cr-9')[0].payload, {});
  assert.equal(ev.readEvents('cr-9')[0].lead, null);

  for (const bad of [{}, { type: '' }, { type: 7 }]) {
    assert.throws(() => ev.appendEvent('cr-9', bad), TypeError);
  }

  // A Stop hook can fire before `soma init`, or after someone wipes the tree.
  rmSync(p('events'), { recursive: true, force: true });
  const healed = ev.appendEvent('cr-9', { type: 'TURN_END', payload: {}, lead: 'cr-9' });
  assert.deepEqual(ev.readEvents('cr-9').map((e) => e.id), [healed.id]);
  ev.writeCursor('orch', healed.id);
  assert.equal(ev.readCursor('orch'), healed.id);
});
