import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBudgetClass } from '../bin/lib/wd/budget-class.mjs';

/**
 * The one resolver the breaker and `soma_status` share (issue #59): which budget class prices a
 * lead, by name and caps, and what to announce about it.
 *
 * Every rule is pinned here once, against a lookup shaped like `harness.namedBudgetClassFor`, beside
 * the property the issue is about: the name it reports is the class whose caps it returns.
 * `test/watchdog.tick.test.mjs` pins the same rules through the breaker, and
 * `test/bus-tools.orch.test.mjs` through the status row, so the two callers cannot drift from this.
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = 1_800_000_000_000;

/** Four classes with four token caps, so a returned class says which rule bound it. */
const PRICED = {
  standard: { tokens_cap: 1_000_000, turn_cap: 600, wall_ms: 8 * HOUR },
  iterate: { tokens_cap: 3_000_000, turn_cap: 600, wall_ms: 12 * HOUR },
  review: { tokens_cap: 2_000_000, turn_cap: 600, wall_ms: 10 * HOUR },
  babysit: { tokens_cap: 400_000, turn_cap: 0, wall_ms: 0 },
};

/** The class each harness reserves, as `prompts/harnesses.json` ships the table. `research` is not configured here. */
const RESERVES = { H1: 'standard', H2: 'iterate', H3: 'iterate', H4: 'review', H5: 'babysit', H6: 'research' };

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * `harness.namedBudgetClassFor`, in shape: a leading registry id (prose after it is allowed), and the
 * class the table reserves for it, by name and caps, only when the config defines that class as a
 * record. Every call is recorded, so a test can say the lookup was never asked.
 */
const lookup = (cfg, asked = []) => (harness) => {
  asked.push(harness);
  const id = typeof harness === 'string' ? /^H[1-9][0-9]*/.exec(harness.trim().toUpperCase())?.[0] : undefined;
  const name = id !== undefined && Object.hasOwn(RESERVES, id) ? RESERVES[id] : null;
  const budgets = cfg?.budgets;
  return name !== null && isRecord(budgets) && Object.hasOwn(budgets, name) && isRecord(budgets[name]) ? { name, cls: budgets[name] } : null;
};

/** One event as `events.appendEvent` stores it: `ts` is the numeric prefix of its own id. */
const ev = (type, ts, payload = {}) => ({ id: `${ts}-0000`, ts, type, lead: 'a', payload });

/** A HARNESS report as `soma_report` stores it on the lead's own stream. */
const declared = (harness, ts) => ev('HARNESS', ts, { harness_id: harness, plan_summary: 'p' });

/** A spawned task row with every pricing field `fleet.enqueue` writes. */
const row = (over = {}) => ({ id: 'a', status: 'spawned', repo: 'r', harness: null, budget_class: null, budget_override: null, ...over });

/**
 * One resolution against `budgets` (the shipped four by default), with the stream read and the
 * lookup both recorded. `stream` may be a function, for a read that throws or answers a non-array.
 */
const resolve = ({ task = row(), stream = [], budgets = structuredClone(PRICED) } = {}) => {
  const cfg = { budgets };
  const asked = [];
  const reads = [];
  const read = (id) => {
    reads.push(id);
    return typeof stream === 'function' ? stream(id) : stream;
  };
  const { name, cls, defaulted } = resolveBudgetClass(task, read, cfg, lookup(cfg, asked));
  return { priced: { name, cls, defaulted }, asked, reads, budgets };
};

/**
 * Pins no class can be bound from, each with the name a HARNESS_DEFAULTED payload gives it — the
 * watchdog's own table. The strings: a name soma.json never wrote; three that resolve through
 * Object.prototype, which a truthiness or `in` lookup would bind; an own key whose value is not a
 * record; and a record class reachable only through the budgets' prototype. The rest are not
 * strings at all. Both enqueue doors refuse every one of them, so a row gets one only from a
 * hand-edited checkpoint, an enqueue with no class to check it against (soma.json unreadable, or
 * defining none), or, for a string, a class removed from soma.json later. Only a string can name a
 * class: `Object.hasOwn(budgets, 42)` would find a class named "42", and `['babysit']` would find
 * babysit.
 */
const UNBOUND = [
  ['premium', 'premium'], ['constructor', 'constructor'], ['toString', 'toString'], ['__proto__', '__proto__'],
  ['flat', 'flat'], ['inherited', 'inherited'],
  [42, '42'], [true, 'true'], [{}, 'object'], [{ toString: 1 }, 'object'], [['babysit'], 'array'],
];

/** The budgets those pins are tried against: every trap above, beside the four real classes. */
const unboundBudgets = () => Object.assign(
  Object.create({ inherited: { tokens_cap: 1, turn_cap: 0, wall_ms: 0 } }),
  structuredClone(PRICED),
  { flat: 42, 42: { tokens_cap: 1, turn_cap: 0, wall_ms: 0 } },
);

// ---------------------------------------------------------------------------
// The four rules, in order
// ---------------------------------------------------------------------------

test('a class pinned at enqueue wins over every harness, and nothing else is read to find it', () => {
  const r = resolve({
    task: row({ harness: 'H4', budget_class: 'babysit', budget_override: 'babysit' }),
    stream: [declared('H4', NOW - 5 * MIN)],
  });
  assert.deepEqual(r.priced, { name: 'babysit', cls: PRICED.babysit, defaulted: null });
  // The breaker's own order of work, kept: a pin that binds costs no stream read and no registry read.
  assert.deepEqual(r.reads, [], 'a pin that binds needs no stream read');
  assert.deepEqual(r.asked, [], 'and no harness lookup');
});

test('the newest HARNESS on the lead\'s own stream beats the harness its row carries, before any drain', () => {
  // The documented H1 -> H4 degrade: the orchestrator drained the first report and not the second.
  const superseded = resolve({
    task: row({ harness: 'H1', budget_class: 'standard' }),
    stream: [declared('H1', NOW - 30 * MIN), declared('H4', NOW - 5 * MIN)],
  });
  assert.deepEqual(superseded.priced, { name: 'review', cls: PRICED.review, defaulted: null });
  assert.deepEqual(superseded.reads, ['a'], 'the lead\'s OWN stream, read once');

  // Newest by when it was filed, not by where it sits: a stream is append-ordered, but nothing
  // here should rest on that.
  const shuffled = resolve({ task: row({ harness: 'H1' }), stream: [declared('H4', NOW - 5 * MIN), declared('H1', NOW - 30 * MIN)] });
  assert.equal(shuffled.priced.name, 'review');

  // A row nothing has drained yet: no harness on it at all, and the report already prices the lead.
  const undrained = resolve({ stream: [ev('STARTED', NOW - 9 * MIN), declared('H3 TDD-LOOP', NOW - 8 * MIN)] });
  assert.deepEqual(undrained.priced, { name: 'iterate', cls: PRICED.iterate, defaulted: null });
  assert.deepEqual(undrained.asked, ['H3 TDD-LOOP'], 'the spelling the lead filed goes to the registry as filed');
});

test('which HARNESS counts: one that names no harness declares nothing, an unplaceable one decides nothing, and a tie goes to the later row', () => {
  // `soma_report` refuses such a report before it is stored, so only a hand-written line can be
  // one. It must not mask the real declaration filed before it.
  const blank = resolve({
    stream: [declared('H4', NOW - 9 * MIN), ev('HARNESS', NOW - 3 * MIN, {}), ev('HARNESS', NOW - 2 * MIN, { harness_id: '' }), ev('HARNESS', NOW - MIN, { harness_id: 42 })],
  });
  assert.equal(blank.priced.name, 'review');

  // A line with no `ts` is placed by its id's numeric prefix, exactly as `events.mjs` stamps both;
  // one that cannot be placed at all decides nothing.
  const placed = resolve({ stream: [declared('H4', NOW - 9 * MIN), { id: `${NOW - MIN}-0001`, type: 'HARNESS', lead: 'a', payload: { harness_id: 'H2' } }] });
  assert.equal(placed.priced.name, 'iterate');
  const unplaceable = resolve({ stream: [declared('H4', NOW - 9 * MIN), { id: 'hand-written', type: 'HARNESS', lead: 'a', payload: { harness_id: 'H2' } }] });
  assert.equal(unplaceable.priced.name, 'review');

  const tie = resolve({ stream: [declared('H4', NOW - MIN), declared('H2', NOW - MIN)] });
  assert.equal(tie.priced.name, 'iterate', 'two reports in one millisecond: the later row is the later report');

  // Other types carry no harness, whatever their payload says.
  const other = resolve({ task: row({ harness: 'H4' }), stream: [ev('MILESTONE', NOW - MIN, { harness_id: 'H2' })] });
  assert.equal(other.priced.name, 'review');
});

test('the row\'s harness prices the lead when its stream declares none, or cannot be read, and that is not announced', () => {
  const cases = [
    ['a stream with no HARNESS on it', [ev('STARTED', NOW - 9 * MIN), ev('MILESTONE', NOW - MIN)]],
    ['a stream that cannot be read', () => { throw new Error('EACCES reading the lead stream'); }],
    ['a stream read that answers no rows', () => null],
    ['a stream read that answers something else', () => 'not rows'],
  ];
  for (const [name, stream] of cases) {
    const r = resolve({ task: row({ harness: 'H4', budget_class: 'review' }), stream });
    assert.deepEqual(r.priced, { name: 'review', cls: PRICED.review, defaulted: null }, name);
  }
});

test('a lead that has declared nothing is priced as H1, and nothing is announced', () => {
  // `''` is no pin either: it names nothing, and `soma_enqueue` refuses it at the door. And a row
  // enqueued before the pin existed has no `budget_override` key at all, which is no pin.
  const legacy = row();
  delete legacy.budget_override;
  for (const [name, task] of [['null pin', row()], ['empty pin', row({ budget_class: '', budget_override: '' })], ['no pin key', legacy]]) {
    const r = resolve({ task, stream: [ev('STARTED', NOW - 9 * MIN)] });
    // Every lead spends its first minutes here, before its step-1 HARNESS report. Announcing it
    // would announce every spawn, and an alarm that fires on every spawn is one an operator mutes.
    assert.deepEqual(r.priced, { name: 'standard', cls: PRICED.standard, defaulted: null }, name);
    assert.deepEqual(r.asked, ['H1'], name);
  }
});

test('a declaration nothing can price binds the fallback class, and the payload names what was declared', () => {
  const cases = [
    { name: 'a harness the registry does not carry, read off the stream before any drain',
      task: row(), stream: [declared('H9', NOW - 5 * MIN)],
      payload: { harness: 'H9', budget_override: null, budget_class: 'standard' } },
    { name: 'a harness on the row whose class soma.json does not define',
      task: row({ harness: 'H6' }), stream: [],
      payload: { harness: 'H6', budget_override: null, budget_class: 'standard' } },
    { name: 'a pinned class soma.json does not define, with no harness declared behind it',
      task: row({ budget_class: 'premium', budget_override: 'premium' }), stream: [],
      payload: { harness: null, budget_override: 'premium', budget_class: 'standard' } },
    // Both cut to 32: one event is one atomic append, so nothing unbounded rides in a payload.
    { name: 'long spellings of both',
      task: row({ budget_class: 'p'.repeat(100), budget_override: 'p'.repeat(100) }), stream: [declared('X'.repeat(100), NOW - 5 * MIN)],
      payload: { harness: 'X'.repeat(32), budget_override: 'p'.repeat(32), budget_class: 'standard' } },
  ];
  for (const { name, task, stream, payload } of cases) {
    const r = resolve({ task, stream });
    assert.deepEqual(r.priced, { name: 'standard', cls: PRICED.standard, defaulted: payload }, name);
  }

  // A pin that is not a string is still a declaration. Read as "nothing declared", that lead took
  // H1's class without a word, which is the silent pricing the announcement exists to end.
  for (const [pin, name] of UNBOUND.filter(([p]) => typeof p !== 'string')) {
    const r = resolve({ task: row({ budget_class: pin, budget_override: pin }), stream: [ev('STARTED', NOW - 9 * MIN)], budgets: unboundBudgets() });
    assert.deepEqual(r.asked, [], `${name}: a declared pin never takes the silent H1 path`);
    assert.deepEqual(r.priced.defaulted, { harness: null, budget_override: name, budget_class: 'standard' }, name);
    assert.equal(r.priced.name, 'standard', name);
    assert.equal(r.priced.cls, r.budgets.standard, name);
  }
});

test('a pin no class can be bound from is passed over for the harness, and said with a null class', () => {
  for (const [pin, name] of UNBOUND) {
    const r = resolve({ task: row({ budget_class: pin, budget_override: pin }), stream: [declared('H4', NOW - 5 * MIN)], budgets: unboundBudgets() });
    // An operator who pinned a class and is billed at another is the complaint this resolver
    // answers: so it is said, with a null class, because no fallback was bound.
    assert.deepEqual(r.priced, { name: 'review', cls: r.budgets.review, defaulted: { harness: 'H4', budget_override: name, budget_class: null } }, name);
  }
  // The harness as the lead spelled it, cut to 32: `harness.budgetClassFor` prices a leading id with
  // prose after it, so a spelling can be long and still price the lead.
  const spelling = `H4 ${'review loop, '.repeat(10)}`;
  const long = resolve({ task: row({ budget_class: 'premium', budget_override: 'premium' }), stream: [declared(spelling, NOW - 5 * MIN)] });
  assert.deepEqual(long.priced.defaulted, { harness: spelling.slice(0, 32), budget_override: 'premium', budget_class: null });
  assert.equal(long.priced.name, 'review');
});

test('when even the fallback cannot price, nothing is named, and the announcement still says standard', () => {
  // A broken install: the caller hands `cls` to `checkBudget` regardless, which refuses it out loud.
  // The name says nothing that the caps do not back.
  const cases = [
    ['standard missing', { review: { ...PRICED.review } }, null],
    ['standard a scalar', { ...structuredClone(PRICED), standard: 42 }, 42],
    ['standard only on the prototype', Object.assign(Object.create({ standard: { ...PRICED.standard } }), { review: { ...PRICED.review } }), null],
  ];
  for (const [name, budgets, cls] of cases) {
    const r = resolve({ budgets });
    assert.deepEqual(r.priced, { name: null, cls, defaulted: { harness: null, budget_override: null, budget_class: 'standard' } }, name);
  }
});

// ---------------------------------------------------------------------------
// The property soma_status rests on
// ---------------------------------------------------------------------------

test('the class it names is always the class whose caps it returns, and a class that cannot price is never named', () => {
  const budgetSets = {
    shipped: () => structuredClone(PRICED),
    traps: unboundBudgets,
    'no standard': () => ({ iterate: { ...PRICED.iterate }, review: { ...PRICED.review } }),
    'standard a scalar': () => ({ ...structuredClone(PRICED), standard: 42 }),
    'standard on the prototype': () => Object.assign(Object.create({ standard: { ...PRICED.standard } }), { review: { ...PRICED.review } }),
    empty: () => ({}),
  };
  const pins = [undefined, null, '', 'babysit', 'review', 'premium', 'constructor', '__proto__', 'flat', 'inherited', 42, {}, ['babysit']];
  const harnesses = [undefined, null, '', 'H1', 'H2', 'H4 review loop', 'H6', 'H9', 'constructor'];
  const streams = [[], [declared('H3', NOW - MIN)], [declared('H9', NOW - MIN)], [ev('HARNESS', NOW - MIN, {})]];
  let named = 0;
  let unnamed = 0;
  for (const [label, budgetsOf] of Object.entries(budgetSets)) {
    for (const pin of pins) {
      for (const harness of harnesses) {
        for (const stream of streams) {
          const { priced, budgets } = resolve({ task: row({ harness, budget_class: pin, budget_override: pin }), stream, budgets: budgetsOf() });
          const where = `${label} / pin ${JSON.stringify(pin)} / row harness ${JSON.stringify(harness)} / stream ${JSON.stringify(stream.map((e) => e.payload.harness_id))}`;
          if (priced.name === null) {
            unnamed += 1;
            assert.ok(!isRecord(priced.cls), `${where}: a class that prices was left unnamed`);
          } else {
            named += 1;
            assert.ok(Object.hasOwn(budgets, priced.name), `${where}: named "${priced.name}", which soma.json does not define`);
            assert.equal(priced.cls, budgets[priced.name], `${where}: named "${priced.name}" and returned another class's caps`);
          }
        }
      }
    }
  }
  // Both halves were reached, or the loop proved nothing.
  assert.ok(named > 0 && unnamed > 0, `named ${named}, unnamed ${unnamed}`);
});

test('a lookup that prices without naming yields the caps and no name, never a guessed one', () => {
  const cfg = { budgets: structuredClone(PRICED) };
  // The breaker's own `budgetClassFor` answers with caps alone; whatever name the resolver reported
  // for it would be one nobody looked up.
  const capsOnly = (harness) => {
    const hit = lookup(cfg)(harness);
    return hit === null ? null : { name: null, cls: hit.cls };
  };
  assert.deepEqual(resolveBudgetClass(row({ harness: 'H4' }), () => [], cfg, capsOnly), { name: null, cls: cfg.budgets.review, defaulted: null });

  // An answer that is not a class still counts as priced, exactly as the breaker has always read
  // a non-null `budgetClassFor`: `checkBudget` refuses it out loud, where swallowing it into the
  // fallback would hide a broken lookup behind a working breaker. It is not named either.
  assert.deepEqual(resolveBudgetClass(row({ harness: 'H4' }), () => [], cfg, () => ({ name: 'review', cls: 42 })), { name: null, cls: 42, defaulted: null });
  // `undefined` is no class, like null.
  assert.deepEqual(resolveBudgetClass(row(), () => [], cfg, () => ({ name: 'standard', cls: undefined })).defaulted,
    { harness: null, budget_override: null, budget_class: 'standard' });
});

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

test('it refuses what is not a resolver input, by name, and lets a failing lookup fail', () => {
  const cfg = { budgets: structuredClone(PRICED) };
  for (const task of [null, undefined, 'a', 42, ['a']]) {
    assert.throws(() => resolveBudgetClass(task, () => [], cfg, lookup(cfg)), /resolveBudgetClass: task must be a task row/, JSON.stringify(task));
  }
  for (const events of [null, [], 'a']) {
    assert.throws(() => resolveBudgetClass(row(), events, cfg, lookup(cfg)), /resolveBudgetClass: leadEvents must be a function/, JSON.stringify(events));
  }
  for (const classFor of [null, {}, 'budgetClassFor']) {
    assert.throws(() => resolveBudgetClass(row(), () => [], cfg, classFor), /resolveBudgetClass: classFor must be a function/, JSON.stringify(classFor));
  }
  // A registry or config that cannot be read is the caller's to report: the breaker turns the throw
  // into this lead's WATCHDOG_ERROR, and `soma_status` into null columns. Swallowed here, it would
  // become the fallback class, priced and announced as if something had been declared.
  assert.throws(() => resolveBudgetClass(row(), () => [], cfg, () => { throw new Error('registry unreadable'); }), /registry unreadable/);
  // No config at all binds no pin and no fallback, and does not throw.
  assert.deepEqual(resolveBudgetClass(row({ budget_override: 'babysit' }), () => [], null, lookup(cfg)).defaulted,
    { harness: null, budget_override: 'babysit', budget_class: 'standard' });
});
