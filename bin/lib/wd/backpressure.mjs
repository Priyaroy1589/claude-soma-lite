/**
 * Rate-limit storm detection — the one governor whose asymmetry runs the other way.
 *
 * A freeze stops admission for the whole fleet, so the cost of the two mistakes is not
 * symmetric. A *missed* storm costs some retried requests: Claude Code retries in-flight
 * calls natively, admission is already capped at one spawn per tick with a 90 s stagger,
 * and the next tick re-reads the evidence 30 s later. A *false* freeze stalls all ten leads
 * and every queued task behind them until its evidence lapses — `soma thaw` refuses a
 * storm freeze on purpose, because a live storm re-writes its record every tick (see the
 * freeze record below). So
 * every ambiguity here resolves toward not freezing, and that is a design decision
 * (§11), not leniency.
 *
 * The evidence arrives as two lists, and each has its own rule.
 *
 * **The pane half needs corroboration**: pane matches in two *distinct* leads within
 * one tick, or one lead's pane match plus a machine-emitted retry stanza in *that same
 * lead's* transcript. The reason is concrete and lives in the operator's own backlog:
 * it contains tickets about HTTP 429 bugs, so a lead reading 429 logs — or writing a
 * plan that quotes one — must not be able to freeze the fleet on its own. Its scraper is
 * still a documented stub (the watchdog's `paneSignals` returns `[]`). A usage-limit hit
 * does put a line on the pane, `You've hit your <limit name>` (with its reset time, for a
 * window), above an idle composer; the account-rotation design calls that line
 * corroboration and the transcript row the reliable signal, and no scraper pattern has been
 * built or measured against it. The retry stanza the one-lead rule pairs it with has not
 * been seen beside a limit hit: across the local transcripts, 63 synthetic `rate_limit`
 * rows (59 carrying `quotaLimits`) came with ZERO retry stanzas.
 *
 * **The transcript half needs two leads.** It is the limits phase's own reading: one row per
 * spawned lead whose transcript ends on a LIVE usage-limit hit. The row that hit is read off
 * is the synthetic assistant row Claude Code itself writes when a seat refuses a request —
 * `isApiErrorMessage: true`, `error: 'rate_limit'` (`limit-state.mjs`) — so no lead can
 * produce it by reading or quoting 429 logs, and it needs no pane to corroborate it:
 * corroboration exists to stop text a lead can write, and this row is not a lead's text. What
 * it needs instead is a second lead (`STORM_MIN_LEADS`), because one lead's limit is its own
 * seat's window.
 *
 * The two lists never corroborate each other. A limit row is one seat's window and a pane hit
 * is uncorroborated text, so one of each is neither two leads' limits nor a corroborated pane.
 *
 * **What lifts a transcript storm.** Nothing here remembers anything: each tick decides from
 * that tick's lists, and the limits phase stops listing a lead's hit when the lead is
 * relaunched (rotated, revived or spawned anew — the stale-row guard: the hit belongs to the
 * process the launch replaced), when the lead resumes (a healthy row after the hit reads
 * `none`), when its row stops being `spawned`, or when the hit's own `resetsAt` passes. That
 * last rule caps any false freeze: none outlasts the resets of the hits that hold it.
 *
 * Two consequences worth stating, because both look like bugs until you read the above:
 *
 * - **Two signals are not two leads.** Deduping by lead id is the whole point of
 *   "distinct". The dedup is a `Set`, never an object keyed by lead id: task ids are
 *   `^[a-z][a-z0-9-]{0,63}$`, so `constructor` is a perfectly legal lead name, and an
 *   object registry would report it as already-seen and quietly drop a real storm's
 *   second witness back to one. That family of bug has already shipped in this build.
 *
 * - **Unusable input reads as no evidence, not as an error.** This function runs before
 *   admission on every tick; a throw here would freeze admission exactly as effectively
 *   as `frozen: true`, and permanently. A list that is not an array, a row that is not
 *   an object, a hit with no lead to attribute it to — each is skipped, and an
 *   unattributable hit can never corroborate or count toward anything. The named guards
 *   below say which shapes are *expected*; the `try` around each list is what makes "never
 *   throws" a property of this function rather than a list of shapes it happens to know,
 *   and it covers what enumeration cannot — a throwing `paneHit` getter, a `Proxy` row, an
 *   array whose iterator or `length` throws. One `try` PER LIST, so a hostile shape in one
 *   cannot erase the other's evidence. It is a backstop for hostile *shapes*, not a
 *   licence to put fallible logic in the loop: anything that can genuinely fail belongs
 *   outside it, where its failure is visible.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { withFleetLock } from '../fleet.mjs';
import { p } from '../paths.mjs';
import { MIN_EPOCH_MS } from './rotation-events.mjs';

/**
 * How many DISTINCT leads make a storm, read by both two-lead rules: pane matches in two leads,
 * and two leads whose own transcripts end on a live usage-limit hit. The operator's fixed
 * threshold, deliberately not a `soma.json` key.
 *
 * Why two. One lead's limit is its own seat's window, and rotation handles it: the lead moves to
 * an open seat, or, with none open, Claude Code's auto-continue resumes it at the reset. It takes
 * two leads limited at once to make the limit the fleet's. The worst case of waiting for the
 * second is a fleet with no seats, where every lead shares one account: one extra spawn, which
 * sits stalled until auto-continue resumes it at the reset.
 */
export const STORM_MIN_LEADS = 2;

/**
 * @param {Array<{lead: string, paneHit?: boolean, transcriptHit?: boolean}>} signals
 *   the pane half: one row per lead scraped this tick
 * @param {Array<{lead: string}>} [limited] the transcript half: one row per spawned lead whose own
 *   transcript ends on a LIVE usage-limit hit, from the watchdog's limits phase. Omitted, it is
 *   `[]`, so a one-argument call is the pane rule alone, exactly as it was before this list existed.
 * @returns {{frozen: boolean, evidence: Array<{lead: string}>}}
 */
export function detectStorm(signals, limited = []) {
  // The limits phase's list first, in a `try` of its own: its evidence is in hand before any pane
  // row is touched, so nothing a hostile pane row does when read can reach it.
  const limits = new Set();       // distinct leads whose own transcript ends on a live hit
  try {
    const rows = Array.isArray(limited) ? limited : [];
    for (const r of rows) {
      if (r === null || typeof r !== 'object') continue;
      // A hit with no lead to attribute it to counts toward nothing: added as it is, one phantom
      // key beside one real lead would be two leads, and a freeze on a single witness.
      if (typeof r.lead !== 'string' || r.lead === '') continue;
      limits.add(r.lead);
    }
  } catch {
    // Silent for the reason the pane catch below gives. The hits read before the bad row stand.
  }

  const panes = new Set();        // distinct leads whose pane matched
  const corroborated = new Set(); // ...whose own transcript matched as well
  try {
    const rows = Array.isArray(signals) ? signals : [];
    for (const s of rows) {
      if (s === null || typeof s !== 'object') continue;
      if (!s.paneHit) continue;
      // A hit we cannot attribute to a lead is a hit that cannot be corroborated, and
      // `undefined` as a key would collapse every such hit into one phantom lead.
      if (typeof s.lead !== 'string' || s.lead === '') continue;
      panes.add(s.lead);
      if (s.transcriptHit) corroborated.add(s.lead);
    }
  } catch {
    // A row (or a container) that cannot even be read is not evidence. Whatever was
    // gathered before it stands — those hits were attributed and corroborated normally —
    // and whatever came after is lost, which fails toward *not* freezing. That is this
    // module's documented direction, and it is why the catch is deliberately silent: the
    // tick's own WATCHDOG_ERROR path would abort admission for the whole fleet instead.
  }

  // Three rules, OR-ed, and no rule reads both lists: a limit hit and a pane hit are one seat's
  // window and one uncorroborated line, whether they sit on one lead or on two.
  const frozen = panes.size >= STORM_MIN_LEADS || corroborated.size >= 1 || limits.size >= STORM_MIN_LEADS;
  // Evidence: every lead either list could attribute, once each — the limited leads first, then
  // the pane leads, each in first-seen order. It is what BACKPRESSURE carries and what an
  // operator reads in `soma digest` to see which leads made the storm, so it is
  // empty when nothing froze — never "here is what we nearly acted on".
  return { frozen, evidence: frozen ? [...new Set([...limits, ...panes])].map((lead) => ({ lead })) : [] };
}

// ═══════════════════════ the freeze record: `state/backpressure.json` ═══════════════════════
//
// `detectStorm` above decides; what follows RECORDS. The record is the governor the fleet can see:
// `soma_status` and `soma status` render it, the watchdog's admission phase obeys it, and it has two
// writers — the storm branch of the tick (`STORM_REASON`) and the spend-cap branch of its limits
// phase (`reason: 'org_level_disabled_until'`). Both come through `writeBackpressure`, so "the two
// writers produce the same shape" is a property of this function rather than of two call sites.
// One reader lifts it by hand: `soma thaw`, through `clearBackpressure`, and only for a reason that
// is not `STORM_REASON` — a live storm re-writes its record on every tick it holds.
//
// Written like `lease.mjs`'s `writeLease`: field by field, tmp+rename, under the fleet lock. The
// rename buys a lock-free READER a whole record (old or new, never half); the lock is what stops two
// writers' read-modify-write cycles — the tick's storm branch reading `since` back before it
// re-writes, say — from clobbering each other. No ENOENT self-heal of `state/` here, for the reason
// `writeLease` gives: `withFleetLock` creates it on the way in to the lock.

/** `state/backpressure.json` — the ONE spelling. `soma-bus.mjs`, `soma.mjs` and the watchdog all resolve it here. */
export const backpressurePath = () => p('state', 'backpressure.json');

/**
 * The freeze record, three-state, and it never throws:
 *
 * - `{active: false}` — no file. The released state and the never-frozen one, and what the bus
 *   has always rendered as "not frozen".
 * - the record — whatever is on disk, unshaped, when it is an object with a boolean `active`. A
 *   hand-written `{active: true, reason: 'storm'}` is a record; the bus fold nulls what is missing.
 * - `{active: false, unreadable: true, why}` — torn JSON, the wrong shape, EISDIR, EACCES. The
 *   third state, and it is NOT the first: the tolerant `active: false` is the safe direction for
 *   admission (a file nobody can read must not freeze the fleet), and `unreadable` is what lets
 *   the tick report it once and `soma_status` say so. `why` names no path — it reaches a model.
 */
export function readBackpressure() {
  let raw;
  try {
    raw = readFileSync(backpressurePath(), 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { active: false };
    return { active: false, unreadable: true, why: `state/backpressure.json could not be read (${e?.code ?? 'unknown error'})` };
  }
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return { active: false, unreadable: true, why: 'state/backpressure.json is not JSON' };
  }
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec) || typeof rec.active !== 'boolean') {
    return { active: false, unreadable: true, why: 'state/backpressure.json is not a backpressure record (expected an object with a boolean `active`)' };
  }
  return rec;
}

/**
 * `since`/`until` are epoch MILLISECONDS. `quotaLimits.resetsAt` arrives in SECONDS, the classifier
 * is the one conversion site, and a seconds value that slipped through would be a record every
 * reader renders as January 1970 and every `Date.now()` comparison gets wrong. The bound is
 * `rotation-events.mjs`'s `MIN_EPOCH_MS` (1e12 — anything under it is 2001 in ms or the year
 * 33,000 in seconds, either way the units bug), imported above and defined ONCE, there: the
 * builders refuse the same value this writer refuses because it is the same binding, not a copy.
 * Re-exported so the tick (which applies it to a `since` carried forward from a hand-edited
 * record) and this module's tests read the bound from the module that writes the record.
 */
export { MIN_EPOCH_MS };

/**
 * The `reason` the tick's storm branch writes into the record and clears from it. Exported so the
 * watchdog (writes and clears only this reason) and `soma thaw` (refuses to clear it — a live storm
 * is the watchdog's) spell it once.
 */
export const STORM_REASON = 'storm';

/** A value for an error message: quoted if a string, named by type if not (admission.mjs's rule). */
const show = (v) =>
  typeof v === 'string' ? JSON.stringify(v) : v !== null && typeof v === 'object' ? (Array.isArray(v) ? 'array' : 'object') : String(v);

/**
 * The four fields, validated by name, and nothing else — `evidence` and whatever a caller
 * spreads in are dropped, not written: the record is a contract read by the bus, the watchdog,
 * the CLI and doctor, and `JSON.stringify` dropping an `undefined` would change its shape across
 * a reload. `active` must be `true`: `clearBackpressure()` is the only writer of an inactive
 * record, so the two shapes cannot drift apart.
 */
function shapeActive(state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError(`writeBackpressure: state must be an object, got ${show(state)}`);
  }
  if (state.active !== true) {
    throw new TypeError(`writeBackpressure: active must be true, got ${show(state.active)} — clearBackpressure() is the only writer of an inactive record`);
  }
  if (typeof state.reason !== 'string' || state.reason === '') {
    throw new TypeError(`writeBackpressure: reason must be a non-empty string, got ${show(state.reason)}`);
  }
  if (!Number.isFinite(state.since) || state.since < MIN_EPOCH_MS) {
    throw new TypeError(`writeBackpressure: since must be epoch MILLISECONDS (>= 1e12), got ${show(state.since)} — a value in seconds is the units bug`);
  }
  if (state.until !== null && !(Number.isFinite(state.until) && state.until >= MIN_EPOCH_MS)) {
    throw new TypeError(`writeBackpressure: until must be epoch MILLISECONDS (>= 1e12) or null, got ${show(state.until)} — spell null when the end is not known`);
  }
  return { active: true, reason: state.reason, since: state.since, until: state.until };
}

/** Publish `rec` atomically. Call under `withFleetLock`; pid-suffixed scratch like `writeLease`. */
function publish(rec) {
  const fp = backpressurePath();
  const tmp = `${fp}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n');
  renameSync(tmp, fp);
}

/**
 * Write an ACTIVE freeze record `{active: true, reason, since, until}` and return what was written.
 *
 * `timeoutMs` forwards to `withFleetLock` — the one-argument call is the production call; tests
 * and deadline-bound callers shorten the wait. A record that fails validation writes nothing.
 */
export function writeBackpressure(state, { timeoutMs } = {}) {
  const rec = shapeActive(state);
  withFleetLock(() => publish(rec), { timeoutMs });
  return rec;
}

/** Write the released record, exactly `{active: false}` — the contract's shape, the bus's default. */
export function clearBackpressure({ timeoutMs } = {}) {
  withFleetLock(() => publish({ active: false }), { timeoutMs });
  return { active: false };
}
