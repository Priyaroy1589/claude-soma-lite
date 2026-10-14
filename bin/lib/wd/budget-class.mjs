/**
 * Which budget class prices a lead: the one rule the circuit breaker binds and `soma_status`
 * reports.
 *
 * It lives here, and not in the watchdog, because it has two callers that must not disagree. The
 * breaker (`meter` in `soma-watchdog.mjs`) needs the caps, and `soma_status` needs the class's name
 * beside the same caps. They used to answer separately: the status priced a lead from the row's
 * `budget_class`, which only the orchestrator's inbox drain moves, so an unpinned lead read
 * `budget_class: null` until that drain while the breaker was already metering it, and after an
 * H1 -> H4 supersede the row still named the old class and the percentage was of the wrong cap
 * (issue #59). One resolver, called by both, is what makes "the class the status shows" and "the
 * class the breaker binds" the same sentence.
 *
 * Pure, in the sense the rest of `wd/` is: a task row, the config and two injected reads in, a
 * decision out, and nothing touched. The two reads are injected because the callers reach them
 * differently. The watchdog has its own deps and its own test doubles; the bus may import nothing
 * (`bus-tools.mjs` is import-free), so `soma-bus.mjs` hands it this function already composed with
 * the real ones.
 *
 * - `leadEvents(id)` is the lead's OWN event stream. It is called at most once, with the row's
 *   id, and only when no pinned class binds, so a pinned lead costs no stream read.
 * - `classFor(harness)` is the registry's class for a harness as the lead spelled it:
 *   `{name, cls}`, or null when it does not price. `harness.namedBudgetClassFor` is the real one,
 *   and it answers both from one resolution, so a name never comes back for a class that does not
 *   price. The breaker's older `budgetClassFor` answers with caps alone, and the watchdog wraps it
 *   with `name: null`: it never reads the name.
 */

/**
 * The harness a lead that has declared nothing is priced at: no class pinned at enqueue, and no
 * HARNESS on its stream or its row. Every lead spends its first minutes like this, before its
 * step-1 report, and it is not announced (rule 3, below).
 */
const DEFAULT_HARNESS = 'H1';

/**
 * The class bound when something was declared and nothing declared can be priced, and the class
 * `HARNESS_DEFAULTED` names when it binds one (rule 4, below). The same class H1 reserves, as
 * shipped.
 */
const DEFAULT_CLASS = 'standard';

/** A value with named fields: not an array, not null. */
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A value for an error message: quoted if a string, named by type if not. Never `String()` on an object. */
const show = (v) =>
  typeof v === 'string' ? JSON.stringify(v) : v !== null && typeof v === 'object' ? (Array.isArray(v) ? 'array' : 'object') : String(v);

/** A name as a row or a payload declares one: a string with something in it, else null. */
const declaredName = (value) => (typeof value === 'string' && value !== '' ? value : null);

/**
 * The pin on a row as a HARNESS_DEFAULTED payload names it, cut to 32, or null when there is none.
 *
 * Any value but undefined, null and '' is a pin. Both enqueue doors refuse a pin that names no
 * class, so 42 or `{}` reaches a row only through a hand-edited checkpoint or an enqueue that had no
 * class to check it against (soma.json unreadable, or defining none); a class name can also lose
 * its class to a later soma.json edit. Reading one as "nothing declared" priced that lead as H1
 * without a word. A string keeps its spelling; anything else is named by `show`, which names an
 * object by its type and never calls `String()` on it: JSON can carry `{"toString": 1}`, `String()`
 * of that throws, and a throw here costs the lead its verdict for the tick.
 */
const pinName = (pin) => (pin === undefined || pin === null || pin === '' ? null : (typeof pin === 'string' ? pin : show(pin)).slice(0, 32));

/**
 * The class soma.json defines under exactly `name`, or null.
 *
 * Own key and record value, never truthiness and never `in`: `constructor` resolves through
 * `Object.prototype` to a function nobody wrote in soma.json. The record check is
 * `harness.readBudgets`'s. A pinned class that cannot be bound still has the lead's harness behind
 * it, so it is passed over; handed to `checkBudget` instead, it would be refused on every tick, and
 * the lead would go unmetered for as long as the row exists.
 */
function definedClass(cfg, name) {
  const budgets = cfg?.budgets;
  if (name === null || budgets === null || typeof budgets !== 'object' || Array.isArray(budgets) || !Object.hasOwn(budgets, name)) return null;
  const cls = budgets[name];
  return isRecord(cls) ? cls : null;
}

/**
 * The `standard` budget class off a config, or null.
 *
 * `Object.hasOwn`, never truthiness and never `in`, for `wd/budget.mjs`'s reason: a class inherited
 * from `Object.prototype` is a class nobody wrote in soma.json, and one resolving to "no caps" is a
 * lead running with no breaker. Deliberately NOT a record check: whatever soma.json holds under
 * `standard` goes to `checkBudget`, which refuses a scalar out loud, where null here would say only
 * that the class is missing.
 */
function fallbackClass(cfg) {
  const budgets = cfg?.budgets;
  if (budgets === null || typeof budgets !== 'object') return null;
  return Object.hasOwn(budgets, DEFAULT_CLASS) ? budgets[DEFAULT_CLASS] : null;
}

/**
 * When an event happened, in the same milliseconds `task.updated` is stamped in.
 *
 * A copy of `bus-tools.stampOf`'s rule, as the watchdog's own copy is, and it has to agree with
 * both: `events.mjs` guarantees a record's `ts` is exactly the numeric prefix of its own id, so a
 * hand-written line with no `ts` can still be placed in time. One that cannot be placed decides
 * nothing.
 */
const stampOf = (event) => {
  if (Number.isFinite(event?.ts)) return event.ts;
  const parsed = Number.parseInt(String(event?.id ?? '').slice(0, 13), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * The harness the newest HARNESS in `rows` declares, as the lead spelled it, or null.
 *
 * A HARNESS whose payload names no harness declares nothing, so it cannot mask the report filed
 * before it (`soma_report` refuses one before it is stored, so only a hand-written line can be one).
 * Newest by stamp, not by position; a tie goes to the later row, as the watchdog's `newestOf` has it.
 */
function newestHarness(rows) {
  let best = null;
  let bestAt = -Infinity;
  for (const e of rows) {
    if (e?.type !== 'HARNESS' || declaredName(e?.payload?.harness_id) === null) continue;
    const at = stampOf(e);
    if (at === null || at < bestAt) continue;
    best = e.payload.harness_id;
    bestAt = at;
  }
  return best;
}

/**
 * The budget class that prices `task`: `{name, cls, defaulted}`.
 *
 * - `cls` is what the breaker binds and hands to `checkBudget`.
 * - `name` is that class's name in soma.json, or null. It is never a name for something that
 *   cannot price: when `cls` is not a class (a broken install, below) `name` is null, and a
 *   `classFor` that prices without naming gets null rather than a guess.
 * - `defaulted` is the HARNESS_DEFAULTED payload when the fallback class was bound or a pin was
 *   passed over, and null when there is nothing to announce.
 *
 * The first rule that prices the lead wins:
 *
 * 1. **The class the operator pinned at enqueue**, when soma.json defines it. Only a string pin
 *    can name a class: `Object.hasOwn(budgets, 42)` would find a class named "42", and `['babysit']`
 *    would find babysit. Read from `budget_override`, which only `fleet.enqueue` writes, and never
 *    from `budget_class`. The inbox fold keeps `budget_class` following the lead's newest harness,
 *    so on a row nobody pinned it is the harness's class restated. On a row folded before
 *    `budget_override` existed it is the class of the FIRST report: after the documented H1 -> H4
 *    degrade, a resolver reading it as a pin prices a review lead at standard.
 * 2. **The harness the lead declared**: the newest HARNESS on its OWN stream that names one, else
 *    the row's `harness`. The stream comes first because the row learns the harness only when the
 *    orchestrator drains its inbox, and until that drain an iterate lead tripped at standard's cap
 *    with its reservation already on disk. A stream that cannot be read, or that answers anything
 *    but an array, leaves the row's harness standing and is not reported here: for a `spawned` lead
 *    the watchdog's phase 4 reads the same stream on the same tick and reports the failure, and for
 *    a `blocked` one nothing does, so it is priced at its row's harness until a later read succeeds.
 * 3. **Nothing declared at all**: H1's class, and nothing is announced. Every lead spends its first
 *    minutes here, before its step-1 HARNESS, and an event on every spawn is an alarm an operator
 *    learns to mute.
 * 4. **Something declared, and nothing declared can be priced**: a harness the registry does not
 *    carry or soma.json cannot price, a pin no class can be bound from with no priceable harness
 *    behind it, or H1 itself unpriceable. The fallback class is bound, and the payload names what
 *    was declared with `budget_class: 'standard'`, each name cut to 32 characters because one event
 *    is one atomic append.
 *
 * A pin no class can be bound from (a string soma.json does not define, or not a string at all) on a
 * lead whose harness prices is passed over, and said: the payload carries `budget_class: null`,
 * because no fallback was bound and the lead's own harness prices it. An operator who pinned
 * babysit and is billed at review's cap is exactly the failure this resolver ends.
 * Both enqueue doors refuse such a class (`bus-tools.intake`); one still reaches a row through an
 * enqueue that had no class to check it against (soma.json unreadable, or defining none), by being
 * removed from soma.json after the enqueue, or through a hand-edited checkpoint. The watchdog says
 * a HARNESS_DEFAULTED once per lead, off its durable log, so a pin announced under rule 4 is not
 * announced again when a harness later prices the lead.
 *
 * `cls` can still be null (rule 4 with no `standard` defined either), and the breaker hands it to
 * `checkBudget` regardless, which refuses it out loud. Anything `classFor` answers that is not null
 * or undefined counts as priced, as the breaker has always read `budgetClassFor`: `checkBudget`
 * refuses a `cls` that is not a class, where folding it into the fallback would hide a broken lookup
 * behind a working breaker. A `classFor` that throws is not caught here either: the breaker reports
 * it as that lead's WATCHDOG_ERROR, and `soma_status` as null columns.
 *
 * @param {object} task the fleet row
 * @param {(id: string) => object[]} leadEvents the lead's own event rows
 * @param {object|null} cfg the merged config (`budgets`)
 * @param {(harness: string) => ({name: string|null, cls: object}|null)} classFor the registry's class for a harness
 * @returns {{name: string|null, cls: object|null, defaulted: object|null}}
 */
export function resolveBudgetClass(task, leadEvents, cfg, classFor) {
  if (!isRecord(task)) throw new TypeError(`resolveBudgetClass: task must be a task row, got ${show(task)}`);
  if (typeof leadEvents !== 'function') {
    throw new TypeError(`resolveBudgetClass: leadEvents must be a function from a lead id to its own event rows, got ${show(leadEvents)}`);
  }
  if (typeof classFor !== 'function') {
    throw new TypeError(`resolveBudgetClass: classFor must be a function from a harness to {name, cls} or null, got ${show(classFor)}`);
  }

  const pin = declaredName(task.budget_override);
  const pinned = definedClass(cfg, pin);
  if (pinned !== null) return { name: pin, cls: pinned, defaulted: null };
  const override = pinName(task.budget_override);

  let harness = declaredName(task.harness);
  try {
    const rows = leadEvents(task.id);
    const newest = newestHarness(Array.isArray(rows) ? rows : []);
    if (newest !== null) harness = newest;
  } catch {
    // The row's harness stands; rule 2 above says why this is not reported.
  }

  // Rules 2 and 3. A pin that could not be bound is a declaration too, so a row carrying one never
  // reaches H1 silently. With a pin present here, `harness` is not null, and the pin it was priced
  // over is said with a null class.
  if (harness !== null || override === null) {
    const found = classFor(harness ?? DEFAULT_HARNESS);
    const cls = found === null || found === undefined ? null : found.cls;
    if (cls !== null && cls !== undefined) {
      return {
        name: isRecord(cls) ? declaredName(found.name) : null,
        cls,
        defaulted: override === null ? null : { harness: harness.slice(0, 32), budget_override: override, budget_class: null },
      };
    }
  }
  const cls = fallbackClass(cfg);
  return {
    name: isRecord(cls) ? DEFAULT_CLASS : null,
    cls,
    defaulted: { harness: harness === null ? null : harness.slice(0, 32), budget_override: override, budget_class: DEFAULT_CLASS },
  };
}
