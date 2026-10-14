/**
 * Admission: which queued task, if any, may spawn on this tick.
 *
 * Three governors, in order of how badly they must not fail:
 *
 * - **Backpressure.** A storm — two leads holding a live usage-limit hit at once — freezes
 *   admission entirely: leads 3 through 10 never start while leads 1 and 2 sit on a closed
 *   window (design §11).
 * - **The 90 s stagger.** `stagger_s` exists so ten leads do not hit the API in the same
 *   second, and so that a fleet ramping up reveals a rate-limit problem at lead 2 rather
 *   than at lead 10. Its clock is `fleet.last_spawn_at`, stamped inside
 *   `setTaskStatus(id, 'spawned')` under the fleet lock — the one moment in the system
 *   that knows a lead just started. This function only *reads* it, from the snapshot it
 *   was handed: it takes no lock and writes nothing.
 * - **`max_leads`.** Delegated to `fleet.admit`, which also picks the oldest queued task
 *   and counts only `spawned` rows as occupying a slot.
 *
 * Every guard below turns a silent failure into a loud one, because each of these
 * mistakes disables a governor while the fleet keeps reporting healthy:
 *
 * - **`stagger_s` must be present.** A renamed or dropped key makes
 *   `now - last < undefined` false and admits ten leads into the same second — dead
 *   config that looks like working config. This build has already paid for that once.
 * - **`last_spawn_at: 0` is a timestamp, not "never".** Only `null`/absent means never
 *   spawned. The synthetic fleets in watchdog tests use `last_spawn_at: 0`, so a falsy
 *   check would skip the stagger for exactly the inputs that are supposed to prove it.
 * - **`backpressureActive` must be a boolean.** `nextAdmission(fleet, cfg, now, storm)`
 *   instead of `storm.frozen` is one keystroke away, and an object is always truthy: the
 *   queue would freeze forever, silently, with no BACKPRESSURE event to explain it.
 * - **`fleet.tasks` must be an array**, named here rather than left to `fleet.admit`,
 *   which reaches it through `countActive` and reports `Cannot read properties of null
 *   (reading 'filter')` from two frames down — a native error standing in for a guard is
 *   how the toothless assertion in this module family happened. `reconcile` and
 *   `settlement` both name it; this is the third fleet consumer and now says the same.
 */
import { admit } from '../fleet.mjs';

/**
 * @param {{tasks: Array<{id: string, status: string}>, last_spawn_at?: number|null}} fleet snapshot
 * @param {{max_leads: number, stagger_s: number}} cfg merged config
 * @param {number} now epoch ms — a parameter, never `Date.now()`, so a tick is reproducible
 * @param {boolean} backpressureActive `detectStorm(...).frozen || readBackpressure().active === true` —
 *   the tick composes it, so a freeze another writer put in `state/backpressure.json` (the spend cap)
 *   holds admission too, and a storm whose record failed to write still holds it this tick
 * @returns {string|null} the task id to spawn, or null
 */
export function nextAdmission(fleet, cfg, now, backpressureActive) {
  // The snapshot's own integrity first, in the same voice as `reconcile` and `settlement`:
  // there is no branch of this function that can work without `tasks`, and letting
  // `fleet.admit` discover it produces a native TypeError from two frames down.
  const tasks = fleet?.tasks;
  if (!Array.isArray(tasks)) {
    throw new TypeError(`nextAdmission: fleet.tasks must be an array, got ${show(tasks)}`);
  }
  // Validated before the backpressure return, so a config that lost `stagger_s` is loud
  // on the first tick rather than on the first tick after a thaw.
  const staggerMs = reqNum('nextAdmission: cfg.stagger_s', cfg?.stagger_s) * 1000;
  if (typeof backpressureActive !== 'boolean') {
    throw new TypeError(
      `nextAdmission: backpressureActive must be a boolean, got ${backpressureActive === null ? 'null' : typeof backpressureActive} — passing detectStorm()'s result object instead of its .frozen would freeze admission permanently`,
    );
  }
  if (backpressureActive) return null;

  const last = fleet?.last_spawn_at;
  if (last != null) {
    const since = reqNum('nextAdmission: now', now) - reqNum('nextAdmission: fleet.last_spawn_at', last);
    // `<` on ms, so `stagger_s: 90` opens admission at exactly 90_000 ms and a
    // last_spawn_at in the future (clock skew, a hand-edited checkpoint) holds rather
    // than opens. `stagger_s: 0` is a real setting: no stagger at all.
    if (since < staggerMs) return null;
  }
  return admit(fleet, cfg);
}

/**
 * A required non-negative finite number, tolerating the one string worth keeping.
 *
 * Same rule as `fleet.admit`'s `max_leads` read: a hand-edited `"90"` in soma.json is
 * fine, but nothing is coerced — `Number(null)`, `Number('')` and `Number([])` are all
 * 0, which would turn the stagger off and read as a deliberate setting.
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
