/**
 * Append-only NDJSON event log — the lead → orchestrator channel.
 *
 * One file per stream (`events/<stream>.ndjson`, where a stream is a lead id or
 * the literal `orch`), one physical line per event, and one writer per file, so
 * appends need no lock: each line is one `write(2)` on a descriptor opened
 * `O_APPEND|O_CREAT`, which the kernel places at the true end of the file, and a
 * line this small is not interleaved with a second appender's — the bus caps
 * summary at 2000 chars and question at 500, keeping a line comfortably inside
 * the 4 KiB window, so even the lead's Stop hook writing the same stream is safe.
 * Readers are pull-based and hold no state beyond `events/.cursors.json`, a map
 * of "last event I consumed" keyed by consumer ROLE (`orch`), not session id.
 *
 * Ordering is the whole ballgame. A consumer advances its cursor to the id of the
 * last event it handled and then asks for everything with `id > cursor`, so an id
 * that sorts *below* one already consumed is an event silently lost. That single
 * requirement explains the id format in `stamp()` and why a record's `ts` is
 * always exactly the numeric prefix of its own id.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { p } from './paths.mjs';

/**
 * Stream names reaching the filesystem are lead ids (`fleet.enqueue` regex) or `orch`. Exported so
 * `watch.mjs` can stat a stream without a second spelling of where it lives.
 */
export const streamPath = (stream) => p('events', `${stream}.ndjson`);
const cursorsPath = () => p('events', '.cursors.json');

/** Epoch-ms prefix width: 13 digits from 2001 to 2286. */
const TS_WIDTH = 13;
/** Per-millisecond sequence width: 10^4 events in one ms, zero-padded. */
const SEQ_WIDTH = 4;
const SEQ_LIMIT = 10 ** SEQ_WIDTH;

let lastTs = 0;
let seq = 0;

/**
 * The next `{id, ts}`. The id is `${ts}-${seq}`, strictly increasing within this
 * process under *lexicographic* comparison — the comparison `sinceId` filtering
 * and every cursor test actually perform.
 *
 * Three details earn their keep, each closing a silent-event-loss path:
 * - Both fields are zero-padded to a fixed width. An unpadded counter compares
 *   wrong the instant it gains a digit (`'10' < '9'`), which would drop an event
 *   appended in the same millisecond as the one a cursor points at.
 * - `lastTs` never moves backwards, so an NTP step or a VM with a bad RTC cannot
 *   mint an id below one already consumed. The log's `ts` is therefore a
 *   monotonic stamp seeded by the wall clock rather than the raw clock.
 * - A sequence overflow borrows a virtual millisecond instead of widening the
 *   field. Unreachable at one syscall per append; it makes the invariant total.
 */
function stamp() {
  const now = Date.now();
  if (now > lastTs) {
    lastTs = now;
    seq = 0;
  } else if (++seq >= SEQ_LIMIT) {
    lastTs += 1;
    seq = 0;
  }
  const id = `${String(lastTs).padStart(TS_WIDTH, '0')}-${String(seq).padStart(SEQ_WIDTH, '0')}`;
  return { id, ts: lastTs };
}

/**
 * Run `write`; if the events dir is missing, create it and try exactly once more.
 *
 * The callers are Stop hooks and MCP tool handlers whose only failure surface is a
 * broken turn, so a state root that has not been `ensureTree()`d yet — or was
 * wiped from under a running fleet — self-heals instead of throwing. Costs nothing
 * on the hot path: no `existsSync` probe, just the error the first write returns.
 */
function writeSelfHealing(fp, write) {
  try {
    write();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    mkdirSync(dirname(fp), { recursive: true });
    write();
  }
}

/**
 * Append one event to `stream`; returns its `{id, ts}` so the caller can quote the
 * stored id back (`soma_report` → `stored_id`) or park a cursor on it.
 *
 * `JSON.stringify` is load-bearing rather than incidental: it escapes newlines
 * inside the payload, so a multi-line summary or stack trace stays ONE physical
 * NDJSON line and cannot forge extra events.
 */
export function appendEvent(stream, { type, payload = {}, lead = null }) {
  if (typeof type !== 'string' || type === '') {
    throw new TypeError(`appendEvent(${stream}): type must be a non-empty string`);
  }
  const { id, ts } = stamp();
  const line = JSON.stringify({ id, ts, type, payload, lead }) + '\n';
  const fp = streamPath(stream);
  writeSelfHealing(fp, () => appendFileSync(fp, line));
  return { id, ts };
}

/**
 * Events in `stream`, in append order; with `sinceId`, only those after it.
 *
 * Two tolerances keep a lock-free log readable, because `fleet.json` is a
 * checkpoint and this log is the thing it is rebuilt from:
 * - a stream that does not exist yet reads as empty (a lead has no file until it
 *   first reports), and
 * - a line that is not an event — one that will not parse, or that parses to
 *   something without an id — is skipped rather than thrown on, so the torn tail
 *   left by a writer killed mid-append costs that one crumb, not the whole log.
 *   (A fragment left without its newline also swallows the next append onto its
 *   line — one further event lost; the rest of the log still reads.)
 */
export function readEvents(stream, { sinceId = null } = {}) {
  let raw;
  try {
    raw = readFileSync(streamPath(stream), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (line === '') continue; // the trailing newline every append leaves behind
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    // Parsing is not enough: `null`, `0`, `"x"`, `[1,2]` and an id-less object are
    // all valid JSON. Checked before `event` is used at all, so it guards both the
    // `sinceId` compare (which would throw, taking every consumer's inbox down with
    // it) and the plain path (which would hand a non-event to callers).
    if (!event || typeof event !== 'object' || typeof event.id !== 'string') continue;
    if (sinceId === null || event.id > sinceId) out.push(event);
  }
  return out;
}

/**
 * The whole cursor map. Absent, unreadable, or half-written (hand-edited, torn)
 * all read as empty on purpose: replaying events costs a duplicate wake, while
 * losing them costs a task — and the next `writeCursor` republishes a clean file.
 */
function readCursors() {
  try {
    const parsed = JSON.parse(readFileSync(cursorsPath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Id of the last event `consumer` consumed, or null if it has never read. */
export const readCursor = (consumer) => readCursors()[consumer] ?? null;

/**
 * Point `consumer` at `id`.
 *
 * tmp+rename is the house publish idiom (`fleet.writeFleet`, `lease`), so a reader
 * never sees a half-written map. Unlike those, this file has no lock around it —
 * the watchdog and the bus are separate processes — so the tmp name carries the
 * pid to stop two writers interleaving into one scratch file. Last writer wins on
 * the map itself: a lost update re-delivers events, it never skips them.
 */
export function writeCursor(consumer, id) {
  const cursors = readCursors();
  cursors[consumer] = id;
  const fp = cursorsPath();
  const tmp = `${fp}.${process.pid}.tmp`;
  writeSelfHealing(tmp, () => writeFileSync(tmp, JSON.stringify(cursors, null, 2) + '\n'));
  renameSync(tmp, fp);
}

/**
 * Everything `consumer` has not seen across `streams`, oldest first.
 *
 * One cursor read for the whole sweep, then a sort by `(ts, id)`. Because a
 * record's `ts` *is* its id prefix, that order is precisely id order — which is
 * what makes the consumers' idiom safe: `soma_inbox` takes a `slice(0, limit)`
 * prefix of this array and writes its cursor from the last element of the slice,
 * so no dropped element may hold an id greater than the one the cursor lands on.
 */
export function unread(consumer, streams) {
  const sinceId = readCursor(consumer);
  const out = [];
  for (const stream of streams) {
    for (const event of readEvents(stream, { sinceId })) out.push(event);
  }
  return out.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
