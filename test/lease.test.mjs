import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

/**
 * A fresh state root plus a fresh `lease.mjs` instance pointed at it.
 *
 * `tag` (not `Date.now()`) busts the module cache, so two tests starting in the same
 * millisecond still get their own instance; `t.after` removes the mkdtemp dir, since
 * `npm test` runs the whole suite in one process.
 *
 * `fleet.mjs` is imported WITHOUT a tag on purpose: it must be the same instance
 * `lease.mjs` itself imported, or the two copies would each see the other's lock as
 * "held by a live pid" and the re-entrancy the lease relies on would time out.
 */
async function fresh(t, tag) {
  const home = mkdtempSync(join(tmpdir(), 'soma-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.SOMA_HOME = home;
  const { ensureTree, p } = await import('../bin/lib/paths.mjs?' + tag);
  ensureTree();
  return { home, p, l: await import('../bin/lib/lease.mjs?' + tag), f: await import('../bin/lib/fleet.mjs') };
}

const claim = (s, extra = {}) => ({ session_id: s, tmux_socket: 'soma', tmux_pane: `%${s}`, wake: 'tmux', ...extra });

/** Burn `ms` of wall clock, so a test comparing timestamps is not comparing one. */
const spin = (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until);
};

const STALE_MS = 10 * 60 * 1000;
const leaseUrl = new URL('../bin/lib/lease.mjs', import.meta.url).href;

/**
 * One `acquireLease` in its own process, against `home`, resolving what it returned.
 *
 * Real processes are the shape the compare-and-swap exists for: the fleet lock's
 * "do I already hold it" flag is per-process, so nothing but a second process can
 * prove the file lock is what serializes two promotions.
 */
function racer(home, n, force) {
  const src = `
    import { acquireLease } from ${JSON.stringify(leaseUrl)};
    const r = acquireLease({ session_id: 'S${n}', tmux_socket: 'soma', tmux_pane: '%${n}', wake: 'tmux' }, { force: ${force} });
    process.stdout.write(JSON.stringify({ me: 'S${n}', ...r }));
  `;
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, ['--input-type=module', '-e', src], {
      env: { ...process.env, SOMA_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('error', reject);
    cp.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`racer ${n} exited ${code}: ${err}`))));
  });
}

test('first acquire wins, second is refused without force', async (t) => {
  const { l } = await fresh(t, 'first-wins');
  const a = l.acquireLease(claim('A'));
  assert.equal(a.ok, true);
  const b = l.acquireLease(claim('B'));
  assert.equal(b.ok, false);
  assert.equal(b.holder.session_id, 'A');
});

test('force steal bumps lease_seq; release frees', async (t) => {
  const { l } = await fresh(t, 'steal');
  const a = l.acquireLease(claim('A'));
  const b = l.acquireLease(claim('B'), { force: true });
  assert.equal(b.ok, true);
  assert.equal(b.lease_seq, a.lease_seq + 1);
  l.releaseLease('B');
  assert.equal(l.readLease(), null);
});

test('leaseStale true when pane gone', async (t) => {
  const { l } = await fresh(t, 'stale');
  l.acquireLease(claim('A'));
  const lease = l.readLease();
  assert.equal(l.leaseStale(lease, () => false), true); // pane absent
  assert.equal(l.leaseStale({ ...lease, heartbeat_at: Date.now() }, () => true), false);
});

// The three tests above are the original spec, verbatim but for a `fresh()` that
// cleans up after itself. The rest pin the invariants they imply: the record shape four
// other modules read, the holder-only checks that stop a demoted session from
// unmounting its replacement, and — the one that matters most — that the compare-and-set
// holds between real processes rather than only within one.

test('the granted lease is the documented record, and readers see it without the lock', async (t) => {
  const { l, p } = await fresh(t, 'record');
  assert.equal(l.readLease(), null, 'a fleet with no lease file has no orchestrator');

  const before = Date.now();
  const r = l.acquireLease(claim('A'));
  assert.deepEqual(r, { ok: true, degraded: false, lease_seq: 1, stolen_from: null });

  const lease = l.readLease();
  // The shape is a contract: bus wake(), the watchdog, the inject hook and doctor all
  // read these six fields, and `undefined` would be dropped by JSON.stringify — so the
  // in-memory record and the persisted one would disagree on their key set.
  assert.deepEqual(Object.keys(lease).sort(), [
    'heartbeat_at', 'lease_seq', 'session_id', 'tmux_pane', 'tmux_socket', 'wake',
  ]);
  assert.equal(lease.session_id, 'A');
  assert.equal(lease.tmux_socket, 'soma');
  assert.equal(lease.tmux_pane, '%A');
  assert.equal(lease.wake, 'tmux');
  assert.equal(lease.lease_seq, 1);
  assert.ok(Number.isInteger(lease.heartbeat_at) && lease.heartbeat_at >= before);

  // A claim's extra fields stay out of the record, and it cannot dictate its own seq.
  l.acquireLease(claim('B', { lease_seq: 99, heartbeat_at: 0, junk: true }), { force: true });
  assert.deepEqual(Object.keys(l.readLease()).sort(), Object.keys(lease).sort());
  assert.equal(l.readLease().lease_seq, 2);

  assert.deepEqual(JSON.parse(readFileSync(p('state', 'orch.lease'), 'utf8')), l.readLease());
  assert.deepEqual(readdirSync(p('state')).filter((n) => n.endsWith('.tmp')), [], 'tmp+rename must leave no scratch behind');

  // Publishing *replaces* the record rather than rewriting it in place, which is what
  // makes the lock-free readers safe: `wake()` and the inject hook see a whole old lease
  // or a whole new one, never the truncated middle of a write. An in-place
  // `writeFileSync` reuses the inode; a rename installs a new one.
  const ino = statSync(p('state', 'orch.lease')).ino;
  l.heartbeat('B');
  assert.notEqual(statSync(p('state', 'orch.lease')).ino, ino, 'the lease must be published by rename, not truncate-and-write');
  assert.equal(existsSync(p('state', 'fleet.lock')), false, 'every mutation releases the fleet lock');

  // The bus, the watchdog and the hooks are separate processes: the lease lives in the
  // file, not in the module instance that wrote it.
  const reloaded = await import('../bin/lib/lease.mjs?record-reload');
  assert.deepEqual(reloaded.readLease(), l.readLease());

  // `writeLease` carries no ENOENT self-heal of its own, on the stated grounds that
  // `withFleetLock` already made `state/` on the way in to the lock. Pinned here, so
  // a tree wiped under a running fleet stays one mkdir rather than the end of promotion.
  rmSync(p('state'), { recursive: true, force: true });
  assert.equal(l.acquireLease(claim('E')).ok, true, 'a wiped state dir must not cost the fleet its orchestrator');
  assert.equal(l.readLease().session_id, 'E');
});

test('a refusal writes nothing and hands back the whole holder record', async (t) => {
  const { l, p } = await fresh(t, 'refuse');
  l.acquireLease(claim('A'));
  const raw = readFileSync(p('state', 'orch.lease'), 'utf8');

  spin(2);
  const b = l.acquireLease(claim('B'));
  assert.deepEqual(b, { ok: false, holder: l.readLease() });
  // Not one byte: a refused promotion must not bump the seq (which would make the real
  // holder's remembered generation stale) or extend the lease's heartbeat for it.
  assert.equal(readFileSync(p('state', 'orch.lease'), 'utf8'), raw);
  assert.equal(existsSync(p('state', 'fleet.lock')), false);

  // `soma_adopt` reports the holder to the caller, so it has to carry enough to act on:
  // whom to ask, and which pane to steal from.
  assert.equal(b.holder.session_id, 'A');
  assert.equal(b.holder.tmux_pane, '%A');
  assert.equal(b.holder.lease_seq, 1);
});

/**
 * The heartbeat repairs a stale pane, and that repair is the fix for a silent hours-long
 * failure — not a tidy-up.
 *
 * MEASURED on a real fleet: the operator resumed the SAME claude session id into a NEW tmux
 * pane. The lease is keyed on the session id, so it still matched: the heartbeat kept stamping
 * and the record read healthy (`wake: 'tmux'`, fresh beat, seq intact) while `tmux_pane` still
 * named the pane that died with the previous incarnation. Every wake push went to a pane that
 * no longer existed, `wake()` hands `sendKeys` to `fireAndForget`, and the `notify` transport
 * fires unconditionally — so the operator got macOS toasts and an orchestrator pane that never
 * once heard from a lead, with nothing anywhere reporting a failure.
 *
 * A pane id is per-server and per-incarnation; a session id survives a resume. That mismatch
 * is the whole defect.
 */
test('the heartbeat repairs a stale pane for a tmux holder, and only for one', async (t) => {
  const { l } = await fresh(t, 'panefix');
  l.acquireLease(claim('A'));
  assert.equal(l.readLease().tmux_pane, '%A');

  // The resume case: same session id, new pane. This is the bug, fixed.
  l.heartbeat('A', { pane: '%NEW' });
  assert.equal(l.readLease().tmux_pane, '%NEW',
    'a push to the old pane fails silently forever, so the heartbeat is the only chance to notice');

  // Idempotent, and the stamp still moves when the pane already agrees.
  const before = l.readLease().heartbeat_at;
  spin(2);
  l.heartbeat('A', { pane: '%NEW' });
  const after = l.readLease();
  assert.equal(after.tmux_pane, '%NEW');
  assert.ok(after.heartbeat_at > before, 'the heartbeat is still a heartbeat');

  // No pane offered (a caller that does not know, or an older soma) must not erase one.
  l.heartbeat('A');
  assert.equal(l.readLease().tmux_pane, '%NEW', 'an absent pane is not a null pane');
  l.heartbeat('A', { pane: '' });
  assert.equal(l.readLease().tmux_pane, '%NEW', 'nor is an empty one');
  l.heartbeat('A', { pane: null });
  assert.equal(l.readLease().tmux_pane, '%NEW');

  // A NOTIFY holder has no pane by design — leaseStale depends on that distinction, and
  // turning one into a tmux holder is a change of transport, not a repair. soma_adopt owns it.
  l.acquireLease({ session_id: 'B', tmux_socket: null, tmux_pane: null, wake: 'notify' }, { force: true });
  l.heartbeat('B', { pane: '%SNEAKY' });
  const notify = l.readLease();
  assert.equal(notify.tmux_pane, null, 'a notify holder that gains a pane must re-adopt, not drift into tmux');
  assert.equal(notify.wake, 'notify', 'and its transport must not change under it');

  // Holder-only, exactly as the stamp already is: a demoted session must not steer the pane
  // of the session that displaced it.
  l.heartbeat('A', { pane: '%HIJACK' });
  assert.equal(l.readLease().tmux_pane, null, 'a non-holder rewrote the holder\'s pane');
});

test('release and heartbeat are holder-only, and release makes the fleet adoptable again', async (t) => {
  const { l, p } = await fresh(t, 'holder-only');
  l.acquireLease(claim('A'));
  const before = l.readLease();

  // A session that was force-stolen from still calls soma_release and heartbeats on its
  // own schedule. Neither may touch the lease that replaced it.
  spin(2);
  for (const notTheHolder of ['B', undefined, null, '', 0, { session_id: 'A' }]) {
    assert.deepEqual(l.releaseLease(notTheHolder), { released: false }, `${JSON.stringify(notTheHolder)} released someone else's lease`);
    l.heartbeat(notTheHolder);
    assert.deepEqual(l.readLease(), before, `${JSON.stringify(notTheHolder)} altered someone else's lease`);
  }

  // The holder's own heartbeat moves only the stamp — a heartbeat is not a new
  // generation — and preserves fields a newer soma may have written.
  writeFileSync(p('state', 'orch.lease'), JSON.stringify({ ...before, future_field: { keep: true } }));
  l.heartbeat('A');
  const beaten = l.readLease();
  assert.ok(beaten.heartbeat_at > before.heartbeat_at, 'the holder heartbeat did not land');
  assert.equal(beaten.lease_seq, before.lease_seq);
  assert.deepEqual(beaten.future_field, { keep: true });

  assert.deepEqual(l.releaseLease('A'), { released: true });
  assert.equal(l.readLease(), null);
  // Idempotent, and a heartbeat with no lease is a no-op rather than a thrown turn.
  assert.deepEqual(l.releaseLease('A'), { released: false });
  l.heartbeat('A');
  assert.equal(l.readLease(), null);
  assert.equal(existsSync(p('state', 'fleet.lock')), false);

  assert.equal(l.acquireLease(claim('C')).ok, true, 'a released fleet is adoptable without force');
});

test('lease_seq climbs monotonically through steals, and an unusable seq restarts as an integer', async (t) => {
  const { l, p } = await fresh(t, 'seq');
  assert.equal(l.acquireLease(claim('A')).lease_seq, 1, 'the first generation is 1, not 0');

  let prev = 'A';
  for (const [i, next] of ['B', 'C', 'D'].entries()) {
    const r = l.acquireLease(claim(next), { force: true });
    assert.equal(r.lease_seq, i + 2);
    // The bus send-keys a demotion notice to the pane it displaced; reading the old
    // holder before the steal would be a read outside the lock.
    assert.equal(r.stolen_from.session_id, prev);
    assert.equal(r.stolen_from.lease_seq, r.lease_seq - 1);
    prev = next;
  }

  // `'3' + 1` is `'31'` and `NaN + 1` is `NaN`: a hand-edited or newer-format seq must
  // not turn the generation counter into a string or poison every later comparison.
  for (const bad of ['3', null, 2.5, -1, 'x', true]) {
    writeFileSync(p('state', 'orch.lease'), JSON.stringify({ session_id: 'X', lease_seq: bad }));
    const r = l.acquireLease(claim('Y'), { force: true });
    assert.equal(r.lease_seq, 1, `seq ${JSON.stringify(bad)} was not restarted`);
    assert.ok(Number.isInteger(l.readLease().lease_seq));
  }
});

test('degraded is the notify-only wake, and a tmux claim with no pane is one', async (t) => {
  const { l } = await fresh(t, 'degraded');
  const notify = l.acquireLease(claim('A', { wake: 'notify', tmux_pane: null }));
  assert.equal(notify.ok, true);
  assert.equal(notify.degraded, true, 'a session promoted outside tmux gets notify-only wake');
  assert.equal(l.readLease().wake, 'notify');

  // wake:'tmux' with no pane is a wake path that silently goes nowhere — send-keys has
  // no target — while reporting `degraded: false`, so the operator is never told the
  // fleet cannot reach them. Written as what it actually is instead.
  for (const tmux_pane of [null, undefined, '']) {
    const r = l.acquireLease(claim('B', { wake: 'tmux', tmux_pane }), { force: true });
    assert.equal(r.degraded, true, `wake:'tmux' with pane ${JSON.stringify(tmux_pane)} cannot be sent keys`);
    assert.equal(l.readLease().wake, 'notify');
    assert.equal(l.readLease().tmux_pane, null);
  }

  // An unknown mode is notify too: `wake()` only special-cases 'tmux', so anything else
  // must still get toasts rather than a mode nothing handles.
  assert.equal(l.acquireLease(claim('C', { wake: 'carrier-pigeon' }), { force: true }).degraded, true);
  assert.equal(l.readLease().wake, 'notify');

  const good = l.acquireLease(claim('D'), { force: true });
  assert.equal(good.degraded, false);
  assert.equal(l.readLease().wake, 'tmux');
});

test('an unreadable lease reads as absent instead of wedging promotion', async (t) => {
  const { l, p } = await fresh(t, 'unreadable');
  const fp = p('state', 'orch.lease');

  // The opposite of readFleet's loudness, deliberately: fleet.json IS the fleet, but the
  // lease is derived state one soma_adopt re-establishes. `acquireLease` reads before it
  // writes, so a throw here would stop even force:true from taking the fleet back —
  // an unparseable byte would lock every session out of the orchestrator role forever.
  for (const junk of ['', '   ', '{', '{"session_id"', 'null', '[]', '"x"', '42', 'true',
    '{}', '{"session_id": 42}', '{"session_id": null}', '{"session_id": ""}', '{"lease_seq": 4}']) {
    writeFileSync(fp, junk);
    assert.equal(l.readLease(), null, `readLease honored ${JSON.stringify(junk)} as a lease`);
    assert.equal(l.leaseStale(l.readLease(), () => true), true);

    const r = l.acquireLease(claim('A'));
    assert.equal(r.ok, true, `promotion wedged by lease content ${JSON.stringify(junk)}`);
    assert.equal(r.lease_seq, 1);
    assert.equal(r.stolen_from, null);
    assert.equal(l.readLease().session_id, 'A');
    rmSync(fp, { force: true });
  }
});

test('a claim with no session id is refused before anything is written', async (t) => {
  const { l, p } = await fresh(t, 'claim-guard');
  // JSON.stringify drops an undefined value, so such a lease would come back from
  // readLease as null: the fleet would look free to the next promoter while the bus
  // treated the caller as the holder, and nobody could ever release it.
  for (const bad of [undefined, null, {}, { session_id: '' }, { session_id: 42 },
    { session_id: null }, { session_id: ['A'] }, claim(undefined)]) {
    assert.throws(() => l.acquireLease(bad), TypeError, `claim ${JSON.stringify(bad)} was accepted`);
    assert.throws(() => l.acquireLease(bad, { force: true }), TypeError);
  }
  assert.equal(l.readLease(), null, 'a rejected claim must not have written a lease nobody can see');
  assert.equal(existsSync(p('state', 'orch.lease')), false, 'validated before the lock, so nothing was touched');
  assert.equal(existsSync(p('state', 'fleet.lock')), false);
});

test('leaseStale: the pane is ground truth, the heartbeat is the fallback, and a paneless holder is not born stale', async (t) => {
  const { l } = await fresh(t, 'staleness');
  l.acquireLease(claim('A'));
  const lease = l.readLease();

  // Pure: the predicate is called once, with the recorded pane, and nothing else about
  // the record is touched — no tmux from in here.
  const seen = [];
  assert.equal(l.leaseStale(lease, (pane) => { seen.push(pane); return true; }), false);
  assert.deepEqual(seen, ['%A']);

  assert.equal(l.leaseStale({ ...lease, heartbeat_at: Date.now() - (STALE_MS + 1000) }, () => true), true, 'a heartbeat past 10 min is stale');
  assert.equal(l.leaseStale({ ...lease, heartbeat_at: Date.now() - 9 * 60 * 1000 }, () => true), false, 'a 9-minute-old one is not');
  for (const beat of [undefined, null, 'soon', NaN, Infinity, {}]) {
    assert.equal(l.leaseStale({ ...lease, heartbeat_at: beat }, () => true), true, `heartbeat_at ${JSON.stringify(beat)} must not read as fresh`);
  }
  // An NTP step forward is not staleness; the pane check still governs the tmux case.
  assert.equal(l.leaseStale({ ...lease, heartbeat_at: Date.now() + 60_000 }, () => true), false);
  assert.equal(l.leaseStale({ ...lease, heartbeat_at: Date.now() + 60_000 }, () => false), true);

  // A holder promoted outside tmux legitimately has no pane. Probing one it never had
  // reads `hasPane(null) === false` and makes every notify-mode orchestrator stealable
  // the instant it adopts — the fleet taken out from under a working session.
  l.acquireLease(claim('B', { wake: 'notify', tmux_pane: null }), { force: true });
  const paneless = l.readLease();
  let probes = 0;
  const counting = () => { probes++; return false; };
  assert.equal(l.leaseStale(paneless, counting), false, 'a fresh notify-mode holder is not stale');
  assert.equal(probes, 0, 'a lease with no pane must not be judged by one');
  assert.equal(l.leaseStale({ ...paneless, heartbeat_at: Date.now() - (STALE_MS + 1000) }, counting), true, 'its heartbeat is the only evidence there is');
  assert.equal(probes, 0);

  // No lease at all is stale whatever the predicate says — that is the "free to take"
  // answer the bus needs before it has anything to probe.
  for (const nothing of [null, undefined, false, 0, '', 'lease']) {
    assert.equal(l.leaseStale(nothing, () => true), true);
  }
  // The predicate is the contract even when this record happens not to need it —
  // otherwise a caller that forgot it gets a heartbeat-only answer and never finds out.
  for (const notAPredicate of [undefined, 'nope', true]) {
    assert.throws(() => l.leaseStale(lease, notAPredicate), TypeError, `hasPane ${JSON.stringify(notAPredicate)} was accepted`);
    assert.throws(() => l.leaseStale(paneless, notAPredicate), TypeError, `hasPane ${JSON.stringify(notAPredicate)} was accepted for a paneless lease`);
  }
});

test('two simultaneous promotions cannot both win', async (t) => {
  const { l, home, p } = await fresh(t, 'race-refuse');
  const N = 5;
  const results = await Promise.all(Array.from({ length: N }, (_, i) => racer(home, i + 1, false)));

  const won = results.filter((r) => r.ok);
  assert.equal(won.length, 1, `${won.length} of ${N} sessions think they own the fleet`);
  const winner = won[0].me;
  assert.equal(won[0].lease_seq, 1);

  const lease = l.readLease();
  assert.equal(lease.session_id, winner, 'the file must name the session that was told it won');
  assert.equal(lease.lease_seq, 1, 'a refused promotion must not bump the generation');

  // Every loser is told who to ask — and it is the winner, because only one grant ever
  // happened, so no refusal can be quoting a lease that never existed.
  for (const lost of results.filter((r) => !r.ok)) {
    assert.equal(lost.holder.session_id, winner, `${lost.me} was refused against the wrong holder`);
    assert.equal(lost.holder.lease_seq, 1);
  }
  assert.equal(existsSync(p('state', 'fleet.lock')), false, 'every racer released');
  assert.deepEqual(readdirSync(p('state')).filter((n) => n.endsWith('.tmp')), []);
});

test('concurrent force steals each bump the generation exactly once', async (t) => {
  const { l, home, p } = await fresh(t, 'race-steal');
  l.acquireLease(claim('A'));
  const N = 5;
  const results = await Promise.all(Array.from({ length: N }, (_, i) => racer(home, i + 1, true)));

  // Unlocked, two steals read the same seq and write the same number: the fleet ends
  // with fewer generations than it had promotions, and two sessions hold what they each
  // believe is generation k. Serialized, the seqs are exactly 2..N+1, once each.
  assert.deepEqual(results.map((r) => r.lease_seq).sort((a, b) => a - b),
    Array.from({ length: N }, (_, i) => i + 2), 'a duplicated or skipped seq is a lost update');
  for (const r of results) {
    assert.equal(r.ok, true);
    assert.equal(r.stolen_from.lease_seq, r.lease_seq - 1, `${r.me} stole a generation someone else had already taken`);
  }

  const last = results.find((r) => r.lease_seq === N + 1);
  assert.equal(l.readLease().session_id, last.me, 'the surviving record is the last steal, not an overwrite of it');
  assert.equal(l.readLease().lease_seq, N + 1);
  assert.equal(existsSync(p('state', 'fleet.lock')), false);
});

test('lease mutations compose inside a fleet mutation', async (t) => {
  const { l, f } = await fresh(t, 'compose');
  f.enqueue([{ id: 'cr-1', title: 't', repo: 'r', source: {}, brief: 'b' }]);

  // The orchestrator's bus tools adopt and flip fleet state in one breath; the fleet lock is
  // re-entrant so the nested acquire does not queue behind itself, burn the timeout and throw.
  const r = f.updateFleet((fleet) => {
    const got = l.acquireLease(claim('A'));
    fleet.tasks[0].status = 'spawned';
    return got;
  });
  assert.equal(r.ok, true);
  assert.equal(l.readLease().session_id, 'A');
  assert.equal(f.readFleet().tasks[0].status, 'spawned');

  // Documented boundary: the lease is its own file, so nesting buys mutual exclusion,
  // not a two-file transaction. An outer rollback leaves the lease where it was put.
  assert.throws(() => f.updateFleet(() => {
    l.acquireLease(claim('B'), { force: true });
    throw new Error('boom');
  }), /boom/);
  assert.equal(l.readLease().session_id, 'B', 'the lease write is not rolled back with the fleet');
  assert.equal(f.readFleet().tasks[0].status, 'spawned');
});
