/**
 * The loop-harness registry: the six shapes a lead's work may take, and what each
 * one is allowed to spend.
 *
 * `prompts/harnesses.json` is the machine-readable half of the design's step 0
 * ("choose your loop harness before anything else"); `prompts/lead.md` is the half a
 * lead reads. The schema and vocabulary — `shape`, `iteration {mode, max_iterations,
 * stagnation, no_progress}`, `verify {kind, independent}`, `stop_conditions`,
 * `autonomy` — are borrowed from loop-engineering (MIT, attributed, decision D4) and
 * kept field-compatible on purpose, so upstream patterns port without a fork. JSON
 * rather than the spec's YAML for one reason: zero runtime dependencies.
 *
 * Three functions, and each one exists because something downstream would otherwise
 * be guessing:
 *
 * - `loadHarnesses()` is the registry itself (`soma doctor` asserts it still holds
 *   six entries; a shipped file that fails to parse is a broken install, not a
 *   runtime condition).
 * - `budgetClassFor(id)` is what the watchdog binds a circuit breaker to. It
 *   resolves *through* `loadConfig()`, never through a copy of DEFAULTS, so an
 *   operator retuning a class mid-run retunes the live breaker on the next tick.
 * - `validateHarnessReport(payload)` runs inside the bus, *before* a HARNESS event
 *   is stored, which puts two constraints on it that ordinary validators do not
 *   have. It must never throw — the transport hands a thrown message to the model
 *   verbatim, and `node:fs` puts the absolute path it could not open into that
 *   message — and every refusal must be an instruction a lead can act on in its next
 *   turn. So the failures are values, the values name fields and harnesses, and none
 *   of them names a file.
 *
 * Two invariants worth stating because they are easy to break by editing:
 *
 *   **A budget class is a function of the harness, not a field a lead chooses.** The
 *   design's table maps research→H6, standard→H1, iterate→H2/H3, review→H4,
 *   babysit→H5, and the watchdog binds the breaker from the *harness id* the lead
 *   declared, unless the operator pinned a class for the task at enqueue. A report
 *   that declares some other class is therefore not a smaller reservation or a
 *   larger one — it is a plan of record that disagrees with the
 *   mechanism enforcing it, which the digest and `soma_status` would then render as
 *   fact. It is refused, and the refusal says which class to report.
 *
 *   **Every lookup is `Object.hasOwn` or a Map, never truthiness.** `reg['toString']`
 *   and `budgets['constructor']` are inherited functions: truthy, and not harnesses.
 *   A lead reporting `harness_id: "constructor"` past a truthiness check would store
 *   a HARNESS event whose id resolves to no budget class at all, and
 *   `budgetClassFor` would hand the watchdog `null` — a lead running with no breaker,
 *   which is the one outcome this module exists to prevent. For the same reason the
 *   validator accepts only what the pricer can price: both read the same registry
 *   entry and the same class table, so an accepted reservation is always enforceable.
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.mjs';

/**
 * The registry file, addressed relative to this module rather than to a cwd.
 *
 * A URL, not a `path.join` of three `dirname`s: `readFileSync` takes it directly, and
 * it stays correct on Windows (WSL is the supported story, but `soma doctor` and the
 * tests run wherever the operator is).
 */
const REGISTRY_URL = new URL('../../prompts/harnesses.json', import.meta.url);

/** A value with named fields — not an array, not null. */
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** `String(value)` that cannot take the caller down with it (a throwing `toString`). */
const text = (value) => {
  try {
    return String(value);
  } catch {
    return '';
  }
};

/** Longest fragment of a rejected value quoted back at the model. */
const MAX_QUOTE = 40;

/** A rejected value, quoted so an empty or whitespace-only one is visible. */
const quote = (value) => JSON.stringify(text(value).slice(0, MAX_QUOTE));

/**
 * The six harnesses, or `{}` if the shipped registry could not be read.
 *
 * Degrades to empty rather than throwing because both callers are on paths that must
 * not throw: the bus turns a throw into a model-visible `-32000` carrying a
 * filesystem path, and the watchdog's tick would lose every later duty in the loop.
 * Empty is not silent — `validateHarnessReport` reports it as its own distinct,
 * actionable failure, `budgetClassFor` returns `null`, and `soma doctor` checks the
 * count — but it is quiet enough that a broken install cannot cascade.
 *
 * A fresh parse per call, deliberately: the result is therefore never shared, so a
 * caller that normalizes an entry in place cannot rewrite the registry for everyone
 * later in the process (the same property `config.loadConfig` buys with a deep copy).
 * The cost is one small read per HARNESS report and per live lead per 30 s tick.
 *
 * `__proto__` is skipped for the reason `config.mjs` skips it: `JSON.parse` keeps it
 * as an own enumerable key, and `out.__proto__ = entry` would run the
 * `Object.prototype` setter — reparenting this object instead of storing a harness.
 */
export function loadHarnesses() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(REGISTRY_URL, 'utf8'));
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const out = {};
  for (const key of Object.keys(parsed)) {
    if (key !== '__proto__' && isRecord(parsed[key])) out[key] = parsed[key];
  }
  return out;
}

/**
 * The budget classes this fleet can actually price, as a Map — or `null` if the
 * config could not be read at all.
 *
 * `loadConfig` throws on an unparseable `soma.json` on purpose (reading `max_leads: 3`
 * as 10 is the worst outcome on its menu). Here that throw has to become a value:
 * this module's two exports are called from the bus and the watchdog tick, and
 * `config.mjs`'s message names the file it could not parse — a path, headed for a
 * model's context. The distinction between "cannot read the config" and "unknown
 * class" is kept because they are different instructions for the lead reading them.
 *
 * A class counts as defined only when its value is a record of caps, which is what
 * makes the validator and the pricer agree: an overlay that set `budgets.iterate` to
 * a number would otherwise pass a `hasOwn` check in `validateHarnessReport` and still
 * leave `budgetClassFor` with nothing to hand the watchdog — a reservation the fleet
 * accepted and cannot enforce. A Map rather than the parsed object for the same
 * reason the registry uses `Object.hasOwn`: `map.has('toString')` is false.
 */
function readBudgets() {
  let budgets;
  try {
    budgets = loadConfig().budgets;
  } catch {
    return null;
  }
  if (!isRecord(budgets)) return null;
  const out = new Map();
  for (const key of Object.keys(budgets)) if (isRecord(budgets[key])) out.set(key, budgets[key]);
  return out;
}

/**
 * The canonical harness id `value` means, or `null`.
 *
 * Forgiving, within limits, because a harness id is a constant a model types from
 * memory into a payload — `h3`, `H3 TDD-LOOP`, `TDD-LOOP` — and a refused first
 * report costs the lead a whole turn (and burns one of the Stop hook's three blocks)
 * to learn what it already meant. Both exports resolve through this one function, so
 * whatever `validateHarnessReport` accepts, `budgetClassFor` can price: a spelling
 * one accepted and the other did not would be a stored HARNESS report with no
 * breaker behind it. The containment is one-way on purpose — the validator adds
 * refusals of its own (an id naming two harnesses), because being strict at the door
 * costs a turn while being strict about an id already on a task row costs a breaker.
 *
 * Near-misses stay refused rather than snapping to a neighbour. `H10` on a six-entry
 * registry is not `H1`, and `HARNESS 3` is not `H3` — the leading-id match requires a
 * digit right after the `H`, and the name match is exact once punctuation and case
 * are normalized away.
 */
function resolveId(registry, value) {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  if (upper === '') return null;

  // `H3`, `H3 TDD-LOOP`, `h3:tdd-loop` — the id, plus whatever the lead appended.
  const leading = /^H[1-9][0-9]*/.exec(upper);
  if (leading && Object.hasOwn(registry, leading[0])) return leading[0];

  // The name on its own: `TDD-LOOP`, `tdd loop`, `TDDLoop`.
  const flat = upper.replace(/[^A-Z0-9]/g, '');
  if (flat === '') return null;
  for (const [id, entry] of Object.entries(registry)) {
    const name = typeof entry.name === 'string' ? entry.name.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
    if (name !== '' && name === flat) return id;
  }
  return null;
}

/** `H1 ONE-SHOT-PIPELINE, H2 ITERATE-TO-GREEN, …` — the menu, for a refusal. */
const menu = (registry) =>
  Object.entries(registry)
    .map(([id, entry]) => (typeof entry.name === 'string' ? `${id} ${entry.name}` : id))
    .join(', ');

/**
 * The budget class bound to `harnessId`: `{tokens_cap, turn_cap, wall_ms}`, or `null`.
 *
 * `null` means "no class", and the watchdog reads it as exactly that. It is returned
 * for an unknown harness, for a registry that maps a harness to a class this fleet
 * does not define, and for a config or registry that could not be read — three
 * different diagnoses, but one meaning for the caller, which then has nothing to bind
 * a breaker to. The watchdog's answer to that case is its fallback class and the
 * HARNESS_DEFAULTED event (`budgetClassOf` in `soma-watchdog.mjs`), so no lead runs
 * breakerless; keeping this function total is what lets that fallback run.
 */
export function budgetClassFor(harnessId) {
  const registry = loadHarnesses();
  const id = resolveId(registry, harnessId);
  if (id === null) return null;
  const cls = registry[id].budget_class;
  const budgets = readBudgets();
  if (typeof cls !== 'string' || budgets === null) return null;
  return budgets.get(cls) ?? null;
}

/**
 * Is this HARNESS payload a reservation the fleet can honor? `{ok}` or `{ok:false, error}`.
 *
 * Called by `soma_report` before the event is stored, because a HARNESS report is
 * simultaneously the plan of record and the budget reservation: an incomplete one
 * must not become an event at all. What is checked, and why each one is a refusal
 * rather than a shrug:
 *
 * - **harness_id** must resolve to a registry entry. An unresolvable id is a lead
 *   with no declared loop and no class to price it at.
 * - **budget_class** must be the class the registry maps that harness to. See the
 *   invariant in the header: the watchdog prices the harness, so a divergent
 *   declaration is a stored falsehood, not a smaller ask.
 * - **max_iterations**, when the harness declares a cap and the lead declares a
 *   number, must be a finite count at or under it. A lead planning 25 rounds under a
 *   10-round harness has mis-set the loop it just promised to run, and telling it now
 *   costs one turn where the orchestrator's veto costs a round trip. `1e400` is the
 *   same mistake wearing a disguise — it is valid JSON that parses to Infinity, so the
 *   bound has to be checked against non-finite counts explicitly rather than skipped
 *   for them. Prose (`"until green"`) is left alone: it does not coerce to a number at
 *   all, so it is payload, not a claim about the bound.
 *
 * Nothing else is required. The design's other payload fields (`autonomy`,
 * `verify_command`, `team_plan`, `plan_summary`) are the orchestrator's to judge in
 * its one-turn veto window: a validator that refused a report for a missing
 * `plan_summary` would block the very event the veto is supposed to review.
 *
 * On success the canonical id and class come back alongside `ok` — advisory, for any
 * caller that would rather store `H3` than the `tdd loop` a lead typed.
 */
export function validateHarnessReport(payload) {
  const registry = loadHarnesses();
  if (Object.keys(registry).length === 0) {
    return { ok: false, error: 'the harness registry could not be read, so no harness can be reserved: report NEEDS_INPUT and ask the operator to run soma doctor' };
  }
  const fields = isRecord(payload) ? payload : {};

  const id = resolveId(registry, fields.harness_id);
  if (id === null) {
    const named = fields.harness_id === undefined || fields.harness_id === null ? 'missing harness_id' : `unknown harness_id ${quote(fields.harness_id)}`;
    return { ok: false, error: `${named}; expected one of ${menu(registry)}` };
  }
  // `resolveId` takes the first id it finds, which is the right lenience for pricing a
  // row that already exists and the wrong one for admitting a plan: "H2 or maybe H3"
  // is a lead that has not finished step 0, and silently binding it to H2's breaker
  // would make that indecision permanent.
  const mentioned = new Set((text(fields.harness_id).toUpperCase().match(/H[1-9][0-9]*/g) ?? []).filter((m) => Object.hasOwn(registry, m)));
  if (mentioned.size > 1) {
    return { ok: false, error: `harness_id ${quote(fields.harness_id)} names ${mentioned.size} harnesses; declare exactly one, and report NEEDS_INPUT if you cannot choose between them` };
  }

  const budgets = readBudgets();
  if (budgets === null || budgets.size === 0) {
    return { ok: false, error: 'no budget class could be resolved from the fleet config, so nothing can be reserved: report NEEDS_INPUT and ask the operator to run soma doctor' };
  }
  const reserved = registry[id].budget_class;
  if (typeof reserved !== 'string' || !budgets.has(reserved)) {
    // A registry entry and a config that disagree. The lead cannot fix either, so it
    // is told the one thing it can do about it.
    return { ok: false, error: `the registry reserves a budget class for ${id} that this fleet does not define; pick another harness or report NEEDS_INPUT` };
  }

  const declared = typeof fields.budget_class === 'string' ? fields.budget_class.trim() : null;
  if (declared === null || declared === '') {
    return { ok: false, error: `missing budget_class; ${id} reserves "${reserved}"` };
  }
  // Case is forgiven for the same reason a report type's is: the class is a constant
  // typed from memory, and the classes this fleet defines are the only candidates.
  const matched = budgets.has(declared) ? declared : budgets.has(declared.toLowerCase()) ? declared.toLowerCase() : null;
  if (matched === null) {
    return { ok: false, error: `unknown budget_class ${quote(fields.budget_class)}; this fleet defines ${[...budgets.keys()].join(', ')}, and ${id} reserves "${reserved}"` };
  }
  if (matched !== reserved) {
    return { ok: false, error: `${id} reserves budget class "${reserved}", not "${matched}"; report "${reserved}", or choose the harness whose class you need` };
  }

  const cap = registry[id].iteration?.max_iterations;
  if (typeof cap === 'number' && fields.max_iterations !== undefined && fields.max_iterations !== null) {
    const wanted = Number(fields.max_iterations);
    // Prose is the one thing that gets past the bound without claiming anything about it,
    // and it is recognised by *not coercing*: `Number('until green')` is NaN. Everything
    // that does coerce is a count, and a count must be finite.
    //
    // Infinity is not a hypothetical here. `1e400` is ordinary JSON — `JSON.parse` hands
    // back Infinity for it, so it arrives through the bus as a number a lead typed — and it
    // is the single value that wins `wanted > cap` while failing `Number.isFinite`. Guarding
    // only the comparison on finiteness therefore skipped the cap for exactly the declaration
    // that overruns it hardest. `"1e400"` coerces the same way, so it is refused the same way.
    const isProse = typeof fields.max_iterations !== 'number' && Number.isNaN(wanted);
    if (!isProse && !Number.isFinite(wanted)) {
      return { ok: false, error: `${id} allows at most ${cap} iterations, and ${quote(fields.max_iterations)} is not a finite count of them; report ${cap} or fewer, or choose a harness with a longer loop` };
    }
    if (Number.isFinite(wanted) && wanted > cap) {
      return { ok: false, error: `${id} allows at most ${cap} iterations, not ${wanted}; report ${cap} or fewer, or choose a harness with a longer loop` };
    }
  }

  return { ok: true, harness_id: id, budget_class: reserved };
}
