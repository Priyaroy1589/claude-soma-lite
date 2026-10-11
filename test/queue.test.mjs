import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A throwaway state root per test; the module reads `$SOMA_HOME` lazily, like `p()`. */
const root = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'soma-queue-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.SOMA_HOME = home;
  return home;
};

const load = (tag) => import('../bin/lib/queue.mjs?' + tag);

test('the pause switch round-trips, and presence is the whole protocol', async (t) => {
  root(t);
  const q = await load('roundtrip-' + Date.now());
  // The default is open. A fleet that came up paused because nobody had written the
  // switch yet would look identical to one an operator paused on purpose.
  assert.equal(q.queuePaused(), false);
  assert.equal(q.setQueuePaused(true), true);
  assert.equal(q.queuePaused(), true);
  // `statSync().isFile()`, deliberately not `existsSync` — which is what `queuePaused()` IS, so
  // asserting it here would be a line already determined by the one above it. What this adds is
  // independent: a DIRECTORY at that path would also make `existsSync` true, and would make the
  // switch unclearable, because `unlinkSync` cannot remove one. Durability across a restart
  // follows from it being a real file under the state root.
  assert.equal(statSync(q.queuePausedPath()).isFile(), true);
  assert.equal(q.setQueuePaused(false), false);
  assert.equal(q.queuePaused(), false);
  // Both directions are idempotent: `soma_queue resume` on an open queue is not an error,
  // and the watchdog must not be able to turn a double-pause into a throw on its own tick.
  assert.equal(q.setQueuePaused(false), false);
  assert.equal(q.setQueuePaused(true), true);
  assert.equal(q.setQueuePaused(true), true);
  assert.equal(q.queuePaused(), true);
});

test('the reader answers a strict boolean, because the watchdog and soma_status compare it with ===', async (t) => {
  root(t);
  const q = await load('strict-' + Date.now());
  // `soma_status` renders `(await deps.queuePaused()) === true`, and the tick vetoes
  // admission on `deps.queuePaused() === true`. If this ever answered a truthy
  // non-boolean — a file's contents, say — the two would disagree: status would render
  // `queue_paused: false` while the tick froze, or the reverse. That disagreement is the
  // whole defect the pause reader exists to close, so the type is pinned, not just the value.
  assert.strictEqual(q.queuePaused(), false);
  q.setQueuePaused(true);
  assert.strictEqual(q.queuePaused(), true);
  // The contents are a debugging courtesy, exactly as `BUDGET_TRIPPED`'s are. A switch
  // whose file says "false" is still a paused queue, and must not read as an open one.
  writeFileSync(q.queuePausedPath(), 'false\n');
  assert.strictEqual(q.queuePaused(), true);
});

test('a non-boolean is refused rather than read as resume', async (t) => {
  root(t);
  const q = await load('refuse-' + Date.now());
  q.setQueuePaused(true);
  // The one direction that must never be reachable by accident: `setQueuePaused(undefined)`
  // — a caller that forgot to compute the verb, or read a field that was not there —
  // silently RESUMING a queue an operator paused during a rate-limit incident. Coercion is
  // what makes that silent, so there is none, and the refusal names the two legal values.
  for (const bad of [undefined, null, 0, 1, '', 'pause', 'false', 'true', {}, []]) {
    assert.throws(() => q.setQueuePaused(bad), /setQueuePaused: paused must be true or false/,
      `${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(q.queuePaused(), true, 'a refused write leaves the switch exactly as it was');
});

test('the switch self-heals a state root that was never ensureTree()d', async (t) => {
  const home = root(t);
  rmSync(home, { recursive: true, force: true });   // no state/ dir, no root at all
  const q = await load('selfheal-' + Date.now());
  assert.equal(q.queuePaused(), false, 'a missing root is an open queue, not a throw');
  assert.equal(q.setQueuePaused(true), true);
  assert.equal(q.queuePaused(), true);
});

test('the path is under the state root and is derived, never re-spelled', async (t) => {
  const home = root(t);
  const q = await load('path-' + Date.now());
  const paths = await import('../bin/lib/paths.mjs?queue-' + Date.now());
  // Both halves of `soma_queue`'s round trip and the watchdog's veto have to name the
  // same file. The reader and the writer live in this one module for that reason; the
  // path is built from `paths.p` so it moves with $SOMA_HOME rather than being spelled
  // out a third time somewhere else.
  assert.equal(q.queuePausedPath(), paths.p('state', 'QUEUE_PAUSED'));
  assert.equal(q.queuePausedPath(), join(home, 'state', 'QUEUE_PAUSED'));

  // Resolved on every CALL, never captured at module load — the same reason `fleet.lockPath` is
  // a function. `p()` reads `$SOMA_HOME` lazily, so a path frozen at import time would lock a
  // directory the rest of the process has stopped using, and it would do so silently: every
  // spelling still looks absolute and plausible.
  const second = mkdtempSync(join(tmpdir(), 'soma-queue-moved-'));
  t.after(() => rmSync(second, { recursive: true, force: true }));
  process.env.SOMA_HOME = second;
  assert.equal(q.queuePausedPath(), join(second, 'state', 'QUEUE_PAUSED'));
  q.setQueuePaused(true);
  assert.equal(q.queuePaused(), true);
  process.env.SOMA_HOME = home;
  assert.equal(q.queuePaused(), false, 'the switch belongs to a state root, not to the process');
});
