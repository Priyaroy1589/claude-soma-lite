import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { INVARIANTS, evaluateCanary, formatCanary, probeCanary, runCanary } from '../bin/lib/canary.mjs';

/**
 * `canary.mjs` is the gate that opens the queue: until these nine invariants are
 * observed to hold on *this* machine and *this* Claude Code version, no lead may
 * be spawned. Every invariant rests on undocumented Claude Code behavior a version
 * bump can silently change, so the one failure mode that matters here is not a
 * false alarm — it is a canary that reports PASS without having proven anything.
 *
 * The tests are shaped around that. Three families:
 *
 *   the truth table — a literal `true` holds an invariant and nothing else does,
 *   asserted over a corpus of adversarial values rather than a hand-picked few.
 *   The live driver observes these facts through shell exits and environment
 *   variables, which are *always strings*, so `"false"` is the value most likely
 *   to actually arrive — and it is truthy.
 *
 *   the no-probe cases — a driver that produced nothing, crashed, or returned
 *   garbage must yield a clean verdict naming that, never a TypeError from inside
 *   a safety check. An operator has to be able to tell "this machine breaks the
 *   safety model" from "the canary harness is broken"; those are different actions.
 *
 *   the channel — the verdict must never reach stdout. Asserted at the process
 *   boundary, because that is where the damage happens: stdout is the MCP bus's
 *   JSON-RPC frame stream (`bin/lib/jsonrpc.mjs`), not a log.
 */

/** A probe in which every invariant holds — fresh each call, so tests can mutate it. */
const allTrue = () => ({
  busMounted: true,
  teammateCanEdit: true,
  leadCannotWrite: true,
  teammateUserMcpDenied: true,
  somaPrDraft: true,
  slotFreedAfterComplete: true,
  rcUrl: true,
  oauthUnderEnvI: true,
  cdCompoundReadRuns: true,
});

/** The original contract test, verbatim — the contract other modules were promised. */
test('canary passes only when every invariant holds', () => {
  const good = allTrue();
  assert.equal(evaluateCanary(good).ok, true);
  const bad = { ...good, leadCannotWrite: false };
  const r = evaluateCanary(bad);
  assert.equal(r.ok, false);
  assert.ok(r.failures.includes('leadCannotWrite'));
});

/**
 * The nine names are load-bearing: other modules, the runbook and the bring-up
 * procedure all refer to them by name, so a rename is a breaking change and this
 * is the tripwire. The freeze assertions are the other half — a consumer that
 * mutated the exported list would be editing the gate itself.
 *
 * `cdCompoundReadRuns` is the ninth, added 2026-09-07 for the cd-compound stall: Claude Code 2.1.259
 * raised a bypass-immune permission prompt on `cd <dir> && grep <relative>` whenever a
 * `Read()` deny rule existed, and 79 unattended leads sat on it for 214 hours. It sits LAST
 * so the eight names the runbook already quotes keep their positions.
 */
test('the nine invariant names are exactly these, and are not mutable', () => {
  assert.deepEqual([...INVARIANTS], [
    'busMounted', 'teammateCanEdit', 'leadCannotWrite', 'teammateUserMcpDenied',
    'somaPrDraft', 'slotFreedAfterComplete', 'rcUrl', 'oauthUnderEnvI',
    'cdCompoundReadRuns',
  ]);
  assert.ok(Object.isFrozen(INVARIANTS));
  assert.throws(() => { INVARIANTS.push('extra'); }, TypeError);
  assert.equal(INVARIANTS.length, 9);
});

/**
 * The corpus. `"false"` and `"0"` are the realistic ones — a shell command's
 * output or an environment variable, which is how the live driver observes most
 * of these — and both are truthy. `"true"` is the mirror image: a probe that is
 * *right* but mistyped is still a probe whose values were never booleans, and
 * letting it pass would license the string channel that lets `"false"` through.
 * `new Boolean(true)` is the same trap wearing the right type's name.
 */
const NOT_TRUE = [
  ['the string "false"', 'false'],
  ['the string "0"', '0'],
  ['the string "true"', 'true'],
  ['the number 0', 0],
  ['the number 1', 1],
  ['the empty string', ''],
  ['null', null],
  ['undefined', undefined],
  ['an empty array', []],
  ['an empty object', {}],
  ['NaN', NaN],
  ['a boxed Boolean(true)', new Boolean(true)],
  ['a function', () => true],
];

test('only a literal true holds an invariant', () => {
  for (const key of INVARIANTS) {
    for (const [label, value] of NOT_TRUE) {
      const r = evaluateCanary({ ...allTrue(), [key]: value });
      assert.equal(r.ok, false, `${key} = ${label} must not pass`);
      assert.deepEqual(r.failures, [key], `${key} = ${label} must fail exactly ${key}`);
      // A well-formed probe carrying a bad *value* is still a probe: the fault is
      // per-invariant, so the other seven verdicts survive and `reason` stays null.
      assert.equal(r.reason, null);
    }
  }
  // The positive control, so the corpus above cannot pass by failing everything.
  assert.equal(evaluateCanary(allTrue()).ok, true);
});

test('a false invariant fails whether it is one or all eight', () => {
  const r = evaluateCanary(Object.fromEntries(INVARIANTS.map((k) => [k, false])));
  assert.equal(r.ok, false);
  assert.deepEqual(r.failures, [...INVARIANTS]);
});

/**
 * "Silently fail it" was the alternative to this. An operator reading
 * `canary: FAIL (oauthUnderEnvI)` would go looking for a real OAuth failure on the
 * machine; the actual fault is a driver that stringified a boolean, and only the
 * observed value says so.
 */
test('a mistyped observation says what arrived instead of true', () => {
  const r = evaluateCanary({ ...allTrue(), oauthUnderEnvI: 'false' });
  const notes = r.notes.join('\n');
  assert.match(notes, /oauthUnderEnvI/);
  assert.match(notes, /expected true/);
  assert.match(notes, /the string "false"/);
  // And the same rendering reaches the operator through the formatted verdict.
  assert.match(formatCanary(r), /the string "false"/);
});

test('an absent observation is named as absent, not as a false one', () => {
  const probe = allTrue();
  delete probe.rcUrl;
  const r = evaluateCanary(probe);
  assert.deepEqual(r.failures, ['rcUrl']);
  assert.match(r.notes.join('\n'), /rcUrl.*absent/s);
});

/**
 * An inherited `true` is not an observation this probe made. Nothing in a
 * zero-dependency tree is expected to pollute `Object.prototype`, but the whole
 * point of this module is that a truthy-looking nothing must not open the queue,
 * and `Object.create(allTrue())` is a probe that reports nine invariants it never
 * measured. Own-property reads also make a `Object.create(null)` probe — what a
 * careful driver would build — work exactly the same way.
 */
test('an inherited observation is not an observation', () => {
  // Nothing was measured, so this is unproven rather than eight violations — but the
  // reason must name the ACTUAL cause. "Wrong shape" would send an operator hunting a
  // Map while their debugger shows all eight reading `true`.
  const r = evaluateCanary(Object.create(allTrue()));
  assert.equal(r.ok, false);
  assert.deepEqual(r.failures, [...INVARIANTS]);
  // The COUNT, not merely the word. Rendering the wrong counter here — `missing`, which
  // is 0 in this case, sits one token away — produces "0 of them are inherited from its
  // prototype", which is the noise this test's own comment is about, and a `/inherited/`
  // match cannot tell the two apart.
  assert.match(r.reason, new RegExp(`${INVARIANTS.length} of them are inherited from its prototype`));
  assert.doesNotMatch(r.reason, /wrong shape/);
  // And WHY an inherited value is fatal, which is the half of the sentence that turns a
  // count into a diagnosis a driver author can act on.
  assert.match(r.reason, /not an observation this probe made/);
  assert.match(r.reason, /^malformed probe: /);
  assert.match(r.reason, /so nothing was measured$/);
  assert.match(formatCanary(r), /ERROR/);

  // A MIX is a measured run: something on that probe was really observed, so the
  // inherited ones are reported per-key and the verdict stays FAIL.
  const mixed = Object.create(allTrue());
  mixed.busMounted = true;
  const m = evaluateCanary(mixed);
  assert.equal(m.reason, null);
  assert.equal(m.ok, false);
  assert.equal(m.failures.length, INVARIANTS.length - 1);
  assert.match(m.notes.join('\n'), /inherited, not an own property/);

  const ownedOnNullProto = Object.assign(Object.create(null), allTrue());
  assert.equal(evaluateCanary(ownedOnNullProto).ok, true);
});

/**
 * The malformed-probe family. `evaluateCanary(null)` threw a TypeError as first
 * sketched — a stack trace out of a safety check, which reads to an operator
 * like a soma bug rather than like "the canary never ran".
 *
 * `failures` lists all eight deliberately: none of them was proven, and a caller
 * that checks `failures.length` instead of `ok` must not read an empty list as a
 * clean bill of health.
 */
test('a missing or malformed probe is a clean failure, not a stack trace', () => {
  const cases = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'busMounted=true'],
    ['a number', 42],
    ['a boolean', true],
    ['an array', [true, true, true, true, true, true, true, true]],
    ['a function', () => allTrue()],
  ];
  for (const [label, probe] of cases) {
    const r = evaluateCanary(probe);
    assert.equal(r.ok, false, `${label} must not pass`);
    assert.deepEqual(r.failures, [...INVARIANTS], `${label} proves nothing, so all eight are unproven`);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, `${label} must say why`);
    assert.match(formatCanary(r), /ERROR/, `${label} is unproven, not measured-and-violated`);
  }
  // No arguments at all is the same case as an explicit undefined.
  assert.equal(evaluateCanary().ok, false);
});

/**
 * An object of the right TYPE but the wrong SHAPE is a driver bug, not eight broken
 * safety invariants, and the verdict has to say which. A driver that accumulates
 * observations into a `Map` (natural for an incremental prober) and forgets
 * `Object.fromEntries` would otherwise be told "8 of 8 invariants did not hold" —
 * which by this module's own contract means *measured and violated*, i.e. go dismantle
 * your Claude Code install.
 */
test('an object carrying none of the eight observations is a shape fault, not eight violations', () => {
  const cases = [
    ['a Map', new Map(Object.entries(allTrue()))],
    ['a Date', new Date()],
    ['an Error', new Error('driver internal')],
    ['an empty object', {}],
    ['a boxed Boolean', new Boolean(true)],
    ['a class instance', new (class Observations {})()],
  ];
  for (const [label, probe] of cases) {
    const r = evaluateCanary(probe);
    assert.equal(r.ok, false, `${label} must not pass`);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, `${label} must be reported as unproven`);
    assert.match(formatCanary(r), /ERROR/, `${label} is a shape fault, so it must not render as FAIL`);
    assert.doesNotMatch(formatCanary(r), /invariants did not hold/, `${label} measured nothing`);
  }
  // And the verdict names the shape, because "an object" would not tell the driver
  // author what they actually returned.
  assert.match(evaluateCanary(new Map()).reason, /a Map/);
  assert.match(evaluateCanary(new Date()).reason, /a Date/);
  assert.match(evaluateCanary(new (class Observations {})()).reason, /an Observations instance/);
  // The article is COMPUTED, and both arms have to be pinned or only one of them is:
  // `/a Map/` above catches an always-"an" article, and only a vowel-initial name
  // catches an always-"a" one — which renders `a Error`, the exact typo the article
  // logic exists to prevent.
  assert.match(evaluateCanary(new Error('driver internal')).reason, /an Error/);
  // A plain object is named as such, not flattened into the vaguer "an object" that the
  // unnameable cases fall back to.
  assert.match(evaluateCanary({}).reason, /a plain object/);

  // The CAUSE clause is the whole point of this verdict, and its arms must not be
  // confused: a wrong-shaped container is not a prototype problem, and telling an
  // operator "0 of them are inherited" is how a diagnostic becomes noise.
  const mapReason = evaluateCanary(new Map(Object.entries(allTrue()))).reason;
  assert.match(mapReason, /wrong shape/);
  assert.doesNotMatch(mapReason, /inherit/);
  // The framing carries the operator's next move, so it is asserted too: the `malformed
  // probe:` prefix is what says the fault is in the harness rather than on the machine,
  // and the closing clause is what says no invariant was even attempted.
  assert.match(mapReason, /^malformed probe: /);
  assert.match(mapReason, /so nothing was measured$/);

  // `describeShape` interpolates a bug- or attacker-controlled string into a verdict, so
  // it is capped the way `describeValue` caps a long string. Measured without the cap: a
  // 300-character `Symbol.toStringTag` produced a 433-character verdict line, and an
  // empty tag produced `malformed probe: a  yielded …` — an empty article and a double
  // space where the shape's name belonged.
  const huge = evaluateCanary({ [Symbol.toStringTag]: 'X'.repeat(300) });
  assert.ok(huge.reason.length < 200, `a hostile tag became the verdict: ${huge.reason.length} chars`);
  assert.match(huge.reason, /\(300 chars\)/);
  for (const blank of ['', '   ', '\n']) {
    const r = evaluateCanary({ [Symbol.toStringTag]: blank });
    assert.match(r.reason, /an object yielded none/, `a blank tag must still read as a sentence`);
    assert.doesNotMatch(r.reason, / {2}/, 'no double space where the shape name belonged');
  }
  // And `reason` is ONE line of a multi-line report: a newline in it desynchronizes the
  // report's own framing, which is the stdout rule of this module one level down.
  assert.doesNotMatch(evaluateCanary({ [Symbol.toStringTag]: 'Ma\np' }).reason, /\n/);

  // One real observation present is enough to make it a measured run again: a probe
  // that got partway through is violated, not malformed.
  const partial = evaluateCanary({ busMounted: true });
  assert.equal(partial.reason, null);
  assert.equal(partial.failures.length, INVARIANTS.length - 1);
  assert.match(formatCanary(partial), /FAIL/);
  // Even when the one present observation is a FALSE one — something was measured.
  const oneFalse = evaluateCanary({ busMounted: false });
  assert.equal(oneFalse.reason, null);
  assert.match(formatCanary(oneFalse), /FAIL/);
});

/**
 * `probeCanary` is the composition callers are pointed at, and it exists because the
 * hand-rolled version of it has a trap that the most obvious code walks straight into.
 * A caller that wants an exit code per outcome (ERROR apart from FAIL) needs the result object
 * — `soma up --canary` does not: it exits 3 on any non-pass, through `runCanary`'s boolean — so
 * it would write `try { evaluateCanary(await drive()) } catch (e) { reason: e.message }` — and
 * `e.message` on a `Promise.reject(null)` is a TypeError inside the guard. The guarded
 * path must be the one that ships, not one every caller re-derives.
 */
test('probeCanary is the guarded compose, and survives what a naive one does not', async () => {
  const good = await probeCanary(async () => allTrue());
  assert.equal(good.ok, true);
  assert.equal(good.reason, null);

  // The exact case a naive `e.message` guard dies on.
  const nonError = await probeCanary(() => Promise.reject(null));
  assert.equal(nonError.ok, false);
  assert.match(nonError.reason, /threw/);
  assert.deepEqual(nonError.failures, [...INVARIANTS]);

  for (const [label, drive] of [
    ['a rejected Error', async () => { throw new Error('tmux socket refused'); }],
    ['a synchronous throw', () => { throw new Error('spawn failed'); }],
    ['a thrown string', () => { throw 'no session'; }],           // eslint-disable-line no-throw-literal
    ['a thrown undefined', () => { throw undefined; }],           // eslint-disable-line no-throw-literal
    ['a getter that throws null', () => ({ get busMounted() { throw null; } })],
  ]) {
    const r = await probeCanary(drive);
    assert.equal(r.ok, false, `${label} must not pass`);
    assert.match(formatCanary(r), /(ERROR|FAIL)/, `${label} must still render a verdict`);
  }
  assert.match((await probeCanary(async () => { throw new Error('tmux socket refused'); })).reason, /tmux socket refused/);

  // Same refusal as runCanary, from the same place, and it names the real way to run it.
  await assert.rejects(() => probeCanary(), /soma up --canary/);
  await assert.rejects(() => probeCanary({}), /soma up --canary/);
  // Phrased for both entry points, since runCanary delegates its check here.
  await assert.rejects(() => probeCanary(), /runCanary\(driveProbe\)/);
  await assert.rejects(() => runCanary(), /probeCanary\(driveProbe\)/);

  // A non-probe return is a verdict, not a throw — the same as through runCanary.
  assert.match((await probeCanary(async () => null)).reason, /returned null/);
  assert.match((await probeCanary(async () => undefined)).reason, /returned nothing/);
});

/** A probe is data, but nothing stops a driver from handing over an object that computes. */
test('an observation that throws on read fails that invariant, not the process', () => {
  const probe = allTrue();
  Object.defineProperty(probe, 'busMounted', {
    get() { throw new Error('probe getter exploded'); },
    enumerable: true,
    configurable: true,
  });
  const r = evaluateCanary(probe);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failures, ['busMounted']);
  assert.match(r.notes.join('\n'), /unreadable/);
  // ONE unreadable key among the other real observations is a MEASURED run — the rest
  // genuinely were — so `reason` stays null and the operator is told to stop the fleet,
  // not to fix the harness. This is the near side of the boundary the next test walks.
  assert.equal(r.reason, null);
  assert.match(formatCanary(r), new RegExp(`FAIL — 1 of ${INVARIANTS.length}`));
});

/**
 * A probe NOTHING could be read from is unproven, not eight violations — and this is the
 * same misdiagnosis the shape-fault check exists to prevent, reached through a different
 * door. The per-key catch above already KNOWS the key was not observed; it writes
 * `unreadable` into the note. Until it also counted, the tally that decides "was anything
 * measured?" saw eight ordinary failures.
 *
 * The driver that produces this is plausible rather than hostile: eight lazy getters that
 * shell out into the synthetic lead's tmux session, and the session died. Measured before
 * the fix: `reason: null` and `canary: FAIL — 8 of 8 invariants did not hold`, i.e. the
 * verdict said stop the fleet, this machine breaks every safety invariant it has — where it
 * must say ERROR, fix the harness. (`soma up --canary` exits 3 on both; the verdict's word is
 * what tells the operator which.)
 */
test('a probe nothing could be read from is unproven, not eight violations', () => {
  // `howMany` keys whose read throws; the rest are simply absent.
  const deadSession = (howMany) => {
    const probe = {};
    for (const key of INVARIANTS.slice(0, howMany)) {
      Object.defineProperty(probe, key, {
        get() { throw new Error('tmux: no server running on /tmp/soma.sock'); },
        enumerable: true,
        configurable: true,
      });
    }
    return probe;
  };

  const all = evaluateCanary(deadSession(INVARIANTS.length));
  assert.equal(all.ok, false);
  assert.ok(typeof all.reason === 'string' && all.reason.length > 0, 'nothing was read, so nothing was proven');
  assert.match(all.reason, new RegExp(`${INVARIANTS.length} of them threw when read`));   // the count, on this arm too
  assert.doesNotMatch(all.reason, /wrong shape/, 'a dead session is not a wrong-shaped container');
  assert.doesNotMatch(all.reason, /inherit/, 'and it is not a prototype fault either');
  assert.match(formatCanary(all), /ERROR/);
  assert.doesNotMatch(formatCanary(all), /invariants did not hold/, 'nothing was measured to violate');

  // A MIXTURE of pure non-observations is the same fault: all-but-one reads that threw and
  // one key that was never there is still a probe from which nothing was observed.
  const mixed = evaluateCanary(deadSession(INVARIANTS.length - 1));
  assert.match(mixed.reason, new RegExp(`${INVARIANTS.length - 1} of them threw when read`));
  assert.match(formatCanary(mixed), /ERROR/);

  // Inherited AND unreadable together name both causes, because they are fixed differently
  // and a probe can have one of each.
  const both = Object.create(allTrue());
  for (const key of INVARIANTS.slice(0, 4)) {
    Object.defineProperty(both, key, { get() { throw new Error('boom'); }, enumerable: true, configurable: true });
  }
  const b = evaluateCanary(both);
  assert.match(b.reason, new RegExp(`${INVARIANTS.length - 4} of them are inherited`));
  assert.match(b.reason, /4 of them threw when read/);

  // THE BOUNDARY, and it is what makes the above a defect rather than a taste call: eight
  // OWN keys all valued `undefined` is a MEASURED run. Something was read at every one of
  // them and the answer was merely wrong, so it must stay FAIL — folding it into the shape
  // fault would tell an operator to go fix their harness about a driver that observed
  // eight times and got eight wrong answers.
  const eightUndefined = evaluateCanary(Object.fromEntries(INVARIANTS.map((k) => [k, undefined])));
  assert.equal(eightUndefined.reason, null);
  assert.deepEqual(eightUndefined.failures, [...INVARIANTS]);
  assert.match(formatCanary(eightUndefined), /FAIL — 9 of 9 invariants did not hold/);
  assert.match(eightUndefined.notes.join('\n'), /the value undefined/);
});

test('evaluateCanary does not mutate the probe it was handed', () => {
  const probe = { ...allTrue(), leadCannotWrite: 'false' };
  const before = JSON.stringify(probe);
  evaluateCanary(probe);
  assert.equal(JSON.stringify(probe), before);
});

/**
 * The driver stays injected. `runCanary()` with nothing is a programming error,
 * not a canary outcome, so it throws — and the message has to name the real way to
 * run it, because the operator hitting this is mid-bring-up.
 */
test('runCanary refuses without a live driver and names how to run it for real', async () => {
  await assert.rejects(() => runCanary(), (e) => {
    assert.ok(e instanceof Error);
    assert.match(e.message, /soma up --canary/);
    return true;
  });
  // A non-function driver is the same refusal, not a TypeError from calling it.
  for (const notADriver of [{}, 'drive', 42, true, []]) {
    await assert.rejects(() => runCanary(notADriver), /soma up --canary/);
  }
});

test('runCanary returns a strict boolean gate answer', async () => {
  assert.equal(await runCanary(async () => allTrue(), { write: () => {} }), true);
  assert.equal(await runCanary(async () => ({ ...allTrue(), rcUrl: false }), { write: () => {} }), false);
  // A sync driver is a driver too — `await` covers both, and the integration
  // driver's shape must not be part of this module's contract.
  assert.equal(await runCanary(() => allTrue(), { write: () => {} }), true);
});

/**
 * A canary that crashed and a canary that observed a violation are both "do not
 * open the queue", but they are not the same bug and the operator's next move
 * differs: fix the harness, or stop the fleet. So the verdict says which.
 */
test('a driver that throws is a legible non-pass, not a crash and not a violation', async () => {
  const said = [];
  const write = (s) => said.push(s);

  assert.equal(await runCanary(async () => { throw new Error('tmux socket refused'); }, { write }), false);
  assert.match(said.join(''), /ERROR/);
  assert.match(said.join(''), /tmux socket refused/);

  // A driver that rejects with a non-Error must not turn into a TypeError inside
  // the reporting path — `e.message` on `null` is exactly that.
  said.length = 0;
  assert.equal(await runCanary(() => Promise.reject(null), { write }), false);
  assert.match(said.join(''), /ERROR/);

  // A synchronous throw before any promise exists is the same outcome.
  said.length = 0;
  assert.equal(await runCanary(() => { throw new Error('spawn failed'); }, { write }), false);
  assert.match(said.join(''), /spawn failed/);
});

test('a driver that returns a non-probe is a legible non-pass', async () => {
  for (const bad of [null, undefined, 'ok', 7, true, []]) {
    const said = [];
    assert.equal(await runCanary(async () => bad, { write: (s) => said.push(s) }), false);
    assert.match(said.join(''), /ERROR/, `driver returning ${JSON.stringify(bad) ?? 'undefined'} proves nothing`);
  }
});

test('the verdict distinguishes a measured violation from an unproven run', async () => {
  const said = [];
  const write = (s) => said.push(s);
  await runCanary(async () => ({ ...allTrue(), leadCannotWrite: false }), { write });
  assert.match(said.join(''), /FAIL/);
  assert.match(said.join(''), /leadCannotWrite/);
  assert.doesNotMatch(said.join(''), /ERROR/);

  said.length = 0;
  await runCanary(async () => allTrue(), { write });
  assert.match(said.join(''), /PASS/);
});

test('runCanary rejects a writer that is not a function', async () => {
  await assert.rejects(() => runCanary(async () => allTrue(), { write: 'stdout' }), /write/);
});

/**
 * The channel, asserted where it breaks.
 *
 * `bin/lib/jsonrpc.mjs` serves MCP by writing one `JSON.stringify(msg) + '\n'` per
 * message to `process.stdout`, and nothing stops the bus process from importing
 * this module. So the property under test is not "runCanary uses stderr" — it is
 * "after three canary runs, stdout is still a stream of parseable JSON-RPC
 * frames". A child process is the only place that property is real.
 */
test('the verdict never lands on stdout, which is the JSON-RPC frame channel', () => {
  const url = new URL('../bin/lib/canary.mjs', import.meta.url).href;
  const probe = JSON.stringify(allTrue());
  const child = `
    const frame = (id) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\\n');
    frame(0);
    import(${JSON.stringify(url)}).then(async (m) => {
      const good = ${probe};
      await m.runCanary(async () => good);
      await m.runCanary(async () => ({ ...good, leadCannotWrite: false }));
      await m.runCanary(async () => { throw new Error('driver blew up'); });
      await m.runCanary(async () => null);
      frame(1);
    });
  `;
  const r = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8' });

  assert.equal(r.status, 0, `child died: ${r.stderr}`);
  const lines = r.stdout.split('\n').filter((l) => l !== '');
  // Every line, or the frame stream desynchronized and the orchestrator's only
  // control plane goes down with it.
  for (const line of lines) {
    const msg = JSON.parse(line);            // throws on `canary: PASS`
    assert.equal(msg.jsonrpc, '2.0');
  }
  assert.equal(lines.length, 2, `stdout carried extra lines: ${JSON.stringify(r.stdout)}`);
  // And the verdicts still went somewhere an operator can read.
  assert.match(r.stderr, /PASS/);
  assert.match(r.stderr, /FAIL/);
  assert.match(r.stderr, /driver blew up/);
});

/** The module is a leaf on purpose: importing it must not drag in tmux or spawn. */
test('canary.mjs imports nothing from the modules its live driver will need', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(
    fileURLToPath(new URL('../bin/lib/canary.mjs', import.meta.url)), 'utf8',
  ));
  for (const forbidden of ['spawn.mjs', 'tmux.mjs', 'settings-gen.mjs', 'node:child_process']) {
    assert.doesNotMatch(src, new RegExp(`^\\s*import[^\\n]*${forbidden.replace('.', '\\.')}`, 'm'),
      `canary.mjs must stay a pure unit; found an import of ${forbidden}`);
  }
});
