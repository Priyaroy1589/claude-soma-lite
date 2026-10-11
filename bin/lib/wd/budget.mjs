/**
 * The circuit breaker's verdict, and the two flag files that carry it to the lead.
 *
 * `checkBudget` is the whole of the judgement: usage in, `null | 'warn' | 'trip'` out,
 * no clock of its own and no I/O. At 80% the tick writes `warnPath(id)` and emits BUDGET;
 * at 100% it writes `tripPath(id)` — the file that turns enforcement on.
 *
 * **Who consumes `tripPath`.** `bin/hooks/lead-gate.mjs`, the PreToolUse hook installed
 * in the lead's `--settings`: while `leads/<id>/BUDGET_TRIPPED` exists it denies every
 * tool call except `mcp__soma__*`, so the lead can still report and answer but cannot
 * act (design §9, §11). The same hook runs for that lead's *teammates* — they inherit
 * the session's settings — and that is deliberate: teammates are where most of a lead's
 * spend goes, so a lead-only trip would be a breaker with no teeth. Presence is the
 * whole protocol; the contents are a debugging courtesy. Clearing a trip is an explicit
 * operator/orchestrator action (unlink), never a tick's decision.
 *
 * **Who writes and who consumes `warnPath`.** The BUDGET event at 80% lands on the
 * orchestrator's stream, which the lead never reads; `leads/<id>/BUDGET_WARNED` is how the
 * lead hears. The watchdog writes it once, at the 80% verdict, and BEFORE it logs that
 * BUDGET event, because the logged event is the once-per-lead dedupe: a write that failed
 * after the event landed would never be retried. The same gate hook consumes it: the first
 * time the LEAD itself makes a tool call the gate allows, the gate renames the flag to
 * `BUDGET_WARNED.delivered` and hands the lead a short wind-down note as context. Teammates
 * never see or consume it, and neither does a tripped lead, which the trip already told.
 * Presence is the protocol here too: the rename is the claim, so one flag is one note even
 * when two registrations of the gate race on the same call, and `.delivered` is a record
 * that nothing reads.
 *
 * **Governance is validated; evidence is tolerated — but only when it is wholly absent.**
 * A budget *class* that cannot be read is fatal and refused, because a class resolving to
 * "no caps" is a lead running with no breaker — this build has already shipped that exact
 * bug, via a registry indexed by truthiness that accepted every `Object.prototype` name
 * and returned nothing. `usage` is the tolerated side, and its two failure shapes are
 * *different cases with different handling*:
 *
 * - **No reading at all** (`null`/`undefined`) is a real state: the caller had no session
 *   to read, so there are 0 measured tokens and 0 turns. The turn and wall caps still
 *   bind, and the next tick re-reads.
 * - **A reading that lost a field** — a `usage` object without own `est_tokens` or
 *   `turns` — is a contract violation and is refused by name (`measured()`, below).
 *   `readUsage` reports both fields on *every* path, so the only way here is a renamed
 *   field, a hand-rolled double or a shape drift; defaulting that to 0 would report every
 *   lead at 0% of its budget and disable the token cap fleet-wide, silently.
 *
 * That refusal does not weaken design §11's "parse failure degrades to turn and wall
 * caps, never to no breaker", because a parse failure never reaches it: a missing
 * session, an unreadable session name, an empty transcript, binary garbage and a
 * half-written JSON line all return an own `est_tokens: 0` from `readUsage`, which is
 * the degrade path, taken *inside* the meter. Keep it that way — the throw is reserved
 * for a caller that hand-rolls a reading, which is the one case that cannot degrade
 * safely. So: `cls` throws, an absent `usage` reads as 0, and a malformed one throws.
 *
 * **`est_tokens` is SPEND, and only spend. It is never a context proxy.** This function is
 * the only consumer of it, and the reading it comes on also carries `live_context` — the
 * last prompt's size — which is a different quantity by two orders of magnitude: measured
 * on the operator's own transcript, one reading held `est_tokens: 120,527,067` against
 * `live_context: 601,285`. Reusing `est_tokens` as a stand-in for context is not a rounding
 * error, it is a **200x** one, and it has already cost this build a governor:
 * `wd/revive.mjs`'s resume decision was written against a spend number and refused a resume
 * for 44% of real sessions, making design §10's resume-first dead policy. It now reads
 * `live_context` and this module does not read that field at all. The separation is the
 * fix; do not re-unify the two numbers, in either direction, however similar the names look
 * on the same object. A cumulative sum crosses any context-sized threshold within a handful
 * of turns and then never returns — which is exactly why it makes a *plausible* context
 * proxy and a completely wrong one.
 *
 * **A 0 cap means "no cap", and so does an absent one.** Both are spelled out here
 * rather than left to falsiness, because `babysit` genuinely ships `turn_cap: 0` and
 * `wall_ms: 0` (500k tokens, no turn cap, runs until the PR closes) — and because a cap
 * that vanishes through a typo must not look like a cap the operator switched off. What
 * closes that gap is the refusal below: a class with no enforceable cap at all is an
 * error, so "all three keys went missing" can never read as "unlimited".
 */
import { join } from 'node:path';
import { leadDir } from '../paths.mjs';

/** Design §11: BUDGET warning at 80% of the token estimate, hard trip at 100%. */
const WARN_FRAC = 0.8;

/** The three caps a budget class may carry. A cap of 0 (or absent) is not enforced. */
const CAPS = ['tokens_cap', 'turn_cap', 'wall_ms'];

/**
 * Legal task id, deliberately a copy of `fleet.mjs`'s `ID_RE` (which is not exported).
 *
 * `enqueue` is the one door into the fleet and the real path-traversal guard, but these
 * functions name the only two files the breaker has, and the gate hook only ever probes
 * `leads/<id>/BUDGET_TRIPPED` and `leads/<id>/BUDGET_WARNED`. An id that could resolve
 * anywhere else would produce a trip nobody enforces — a silently breakerless lead — or a
 * warning nobody delivers, so the cheap re-check stays.
 */
const ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * One of the breaker's flag files for lead `id`: `<SOMA_HOME>/leads/<id>/<name>`.
 *
 * Built through `paths.leadDir` so the state root is resolved exactly once, in one
 * place, for every process that has to agree on this path. One validator for both flags,
 * so they cannot drift; `fn` is only there so the refusal names the caller.
 */
function flagPath(fn, id, name) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new TypeError(`${fn}: ${show(id)} is not a legal task id (^[a-z][a-z0-9-]{0,63}$)`);
  }
  return join(leadDir(id), name);
}

/** The BUDGET_TRIPPED flag file for lead `id`: `<SOMA_HOME>/leads/<id>/BUDGET_TRIPPED`. */
export function tripPath(id) {
  return flagPath('tripPath', id, 'BUDGET_TRIPPED');
}

/** The BUDGET_WARNED flag file for lead `id`: `<SOMA_HOME>/leads/<id>/BUDGET_WARNED`. */
export function warnPath(id) {
  return flagPath('warnPath', id, 'BUDGET_WARNED');
}

/**
 * The breaker's verdict for one lead.
 *
 * @param {{est_tokens: number, turns: number}|null} usage `readUsage()` output — both
 *   fields required when it is an object; `null` for "no session to read yet"
 * @param {{tokens_cap?: number, turn_cap?: number, wall_ms?: number}} cls its budget class
 * @param {{now: number, startedAt: number}} [clock] wall-clock pair; omit to skip the
 *   wall cap. Supply it (`now`, and the lead's spawn timestamp) to arm `wall_ms`.
 * @returns {null|'warn'|'trip'}
 */
export function checkBudget(usage, cls, clock) {
  if (cls === null || typeof cls !== 'object') {
    throw new TypeError(`checkBudget: budget class must be an object, got ${cls === null ? 'null' : typeof cls}`);
  }
  const tokensCap = capOf(cls, 'tokens_cap');
  const turnCap = capOf(cls, 'turn_cap');
  const wallMs = capOf(cls, 'wall_ms');
  if (tokensCap === 0 && turnCap === 0 && wallMs === 0) {
    // Every cap 0 or absent — including a class whose caps live on its prototype rather
    // than on itself. Refused rather than answered `null`, because `null` here is
    // indistinguishable from "this lead is fine" and would run it breakerless.
    // Wording deliberately shares no phrase with the "budget class must be an object"
    // refusal above: when two guards in one function can both answer an operator's report,
    // a log line naming neither uniquely is how a toothless assertion — and a misdiagnosed
    // incident — happens. "budget class" appeared in both; this one now says CAPS.
    throw new TypeError(
      `checkBudget: no enforceable cap on this budget class (${CAPS.join(' / ')} all 0 or absent) — refusing to judge a lead with no breaker`,
    );
  }

  const est = measured(usage, 'est_tokens');
  const turns = measured(usage, 'turns');

  if (turnCap > 0 && turns >= turnCap) return 'trip';
  if (wallMs > 0 && clock !== undefined && clock !== null) {
    const now = reqNum('checkBudget: clock.now', clock.now);
    const startedAt = reqNum('checkBudget: clock.startedAt', clock.startedAt);
    if (now - startedAt >= wallMs) return 'trip';
  }
  // Token fraction last of the three, because it is the only one that can also warn.
  const frac = tokensCap > 0 ? est / tokensCap : 0;
  if (frac >= 1) return 'trip';
  if (frac >= WARN_FRAC) return 'warn';
  return null;
}

/**
 * One measured field off a `readUsage()` reading.
 *
 * `usage == null` is a real state — the caller had no session to read — and counts as 0.
 * A usage *object* missing the field is not: `readUsage` always returns `est_tokens` and
 * `turns` (0 when the transcript is absent or unparseable), so the only way to get here
 * without them is a contract violation — a renamed field, a hand-rolled double, a shape
 * drift — and reading that as 0 would report every lead at 0% of its budget and disable
 * the token cap for the whole fleet, silently. Named loudly instead.
 *
 * That is not hypothetical. `est_tokens` originally omitted `cache_creation_input_tokens`,
 * 56% of real token volume, so a `standard` lead would have burned roughly twice its
 * 1.5M cap before this function said `'trip'`. The caps were right and the measurement
 * was wrong — which is exactly why this reads the one field that owns the weighting and
 * never re-derives a total from `raw`: a second opinion here would drift from tokens.mjs
 * the moment either changed, and the drift would look like a working breaker.
 *
 * `Object.hasOwn` for the same reason the caps use it: a usage inheriting `est_tokens: 0`
 * from a prototype must not be able to zero the breaker.
 */
function measured(usage, key) {
  if (usage == null) return 0;
  if (typeof usage !== 'object') {
    throw new TypeError(`checkBudget: usage must be a readUsage() object or null, got ${show(usage)}`);
  }
  if (!Object.hasOwn(usage, key)) {
    throw new TypeError(`checkBudget: usage.${key} is missing — readUsage() always reports it, so this reading is not one`);
  }
  return reqNum(`checkBudget: usage.${key}`, usage[key]);
}

/**
 * One cap off `cls`: its own value, or 0 for "not enforced".
 *
 * `Object.hasOwn`, never truthiness and never `in`: `'constructor' in cls` is true, and
 * a cap inherited from a prototype is a cap nobody wrote in soma.json. Reading it as
 * absent is what makes the breakerless-class refusal above catch the forged case.
 */
function capOf(cls, key) {
  if (!Object.hasOwn(cls, key)) return 0;
  return reqNum(`checkBudget: cls.${key}`, cls[key]);
}

/**
 * A required non-negative finite number, tolerating the one string worth keeping.
 *
 * Same rule as `fleet.admit`'s `max_leads` read: a hand-edited `"1500000"` in soma.json
 * is fine, but nothing is coerced — `Number(null)`, `Number('')` and `Number([])` are
 * all 0, and a 0 invented here is a cap that stops existing without saying so.
 */
function reqNum(what, raw) {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    throw new TypeError(`${what} must be a non-negative finite number, got ${show(raw)}`);
  }
  return n;
}

/**
 * A value for an error message: quoted if a string, named by type if not.
 *
 * Not `JSON.stringify`, which throws on a BigInt and on a hostile `toJSON` — an error
 * path that fails while explaining itself is the worst possible time to be clever.
 */
const show = (v) =>
  typeof v === 'string' ? JSON.stringify(v) : v !== null && typeof v === 'object' ? (Array.isArray(v) ? 'array' : 'object') : String(v);
