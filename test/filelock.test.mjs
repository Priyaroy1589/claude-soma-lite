import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createFileLock } from '../bin/lib/filelock.mjs';

/**
 * The shared lock, tested directly rather than only through its three callers.
 *
 * Each caller's suite pins its own contract; this one pins the eight rules the module carries,
 * and pins them *per rule* — an assertion per part, so a change that keeps one part and drops
 * another cannot pass. Every assertion here was validated by mutation: the rule it guards was
 * deliberately broken in `filelock.mjs` and this assertion is the one that failed. Suite-level
 * red/green cannot establish that, because `node:test` aborts a test at its first failing
 * assertion and a sibling silently absorbs the mutation.
 */

/** A throwaway directory, removed after the test. */
function dir(t) {
  const d = mkdtempSync(join(tmpdir(), 'filelock-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A lock instance over `<d>/x.lock`, with everything overridable. */
function makeLock(d, spec = {}) {
  return createFileLock({
    api: 'testLock',
    label: 'x.lock',
    lockFile: () => join(d, 'x.lock'),
    hardLinks: { requirement: 'THE ROOT must be on a filesystem that supports hard links', remedy: 'move THE ROOT off this volume' },
    timeoutMs: 500,
    retryMs: 10,
    ...spec,
  });
}

/**
 * One acquire, with BOTH outcomes reported as values rather than by throwing.
 *
 * `{ran}` is whether the critical section was entered and `{message}` is why it was refused,
 * so a refusal that must carry a path *and* an errno *and* a remedy gets an assertion per part.
 *
 * Returning rather than `assert.fail`-ing on "it did not throw" is the load-bearing part. A
 * helper that ends in `assert.fail` aborts the test, so a change that turns a refused acquire
 * into a successful one goes red with no attribution — and a per-assertion audit, which is the
 * only instrument that can tell whether an individual assertion has teeth, sees nothing at all.
 * Measured: with `assert.fail` here, the mutation that steals an unreadable lock turned the
 * suite red and was invisible to the audit; with this, it is attributed to two named lines.
 */
function attempt(lock, key, opts) {
  let ran = false, message = '', value;
  try {
    value = lock.withLock(key, () => { ran = true; return 'entered'; }, opts);
  } catch (e) {
    message = e.message;
  }
  return { ran, message, value };
}

const scratches = (d) => readdirSync(d).filter((n) => n.endsWith('.tmp'));
/** A pid that has certainly exited — a synthesized "dead owner". */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

const FILELOCK = new URL('../bin/lib/filelock.mjs', import.meta.url).href;

/**
 * One child process running `body` with a lock over `<d>/x.lock` in scope.
 *
 * `patch` lands before the first ESM import of `node:fs`, which is what makes it visible to
 * `filelock.mjs`'s own `import { linkSync }` — the first ESM import snapshots node:fs's named
 * exports, so a patch applied after one is a silent no-op and the assay proves nothing.
 */
function child(d, body, { patch = '', spec = '' } = {}) {
  const src = `
    import { createRequire } from 'node:module';
    const fs = createRequire(import.meta.url)('fs');
    ${patch}
    const { createFileLock } = await import(${JSON.stringify(FILELOCK)});
    const lock = createFileLock({
      api: 'testLock',
      label: 'x.lock',
      lockFile: () => ${JSON.stringify(join(d, 'x.lock'))},
      hardLinks: { requirement: 'THE ROOT must be on a filesystem that supports hard links', remedy: 'move THE ROOT off this volume' },
      timeoutMs: 500,
      retryMs: 10,
      ${spec}
    });
    const say = (o) => process.stdout.write(JSON.stringify(o));
    ${body}
  `;
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    cp.stdout.on('data', (x) => { out += x; });
    cp.stderr.on('data', (x) => { err += x; });
    cp.on('exit', (code, signal) => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch { /* the child died before saying anything */ }
      resolve({ ...parsed, raw: out, err, code, signal, pid: cp.pid });
    });
  });
}

// ---------------------------------------------------------------------------
// Rule 1 + 2: publish by link(2), and classify rather than unlink.
// ---------------------------------------------------------------------------

test('the lock is never observable present-but-ownerless, and no update is lost', async (t) => {
  const d = dir(t);
  const counter = join(d, 'counter');
  writeFileSync(counter, '0');
  const N = 6, M = 10;

  // Sampled from the parent while the children run as separate processes: the empty-file
  // window is only observable from OUTSIDE the holder. An O_EXCL create publishes the name
  // before the pid, and every ownerless read is a licence for a waiter to unlink a live lock
  // and join the holder inside the critical section. Measured on the code this replaces: 2081
  // of 9315 present-lock reads found it ownerless.
  const kids = Array.from({ length: N }, () => child(d, `
    const { readFileSync, writeFileSync } = fs;
    for (let i = 0; i < ${M}; i++) {
      lock.withLock(null, () => {
        const n = Number(readFileSync(${JSON.stringify(counter)}, 'utf8'));
        const until = Date.now() + 1; while (Date.now() < until);
        writeFileSync(${JSON.stringify(counter)}, String(n + 1));
      }, { timeoutMs: 20000 });
    }
    say({ ok: true });
  `));

  let present = 0, ownerless = 0;
  const lp = join(d, 'x.lock');
  const until = Date.now() + 800;
  while (Date.now() < until) {
    let raw;
    try { raw = readFileSync(lp, 'utf8'); } catch { continue; } // absent is the released state
    present++;
    const pid = Number(raw.trim());
    if (!(Number.isInteger(pid) && pid > 0)) ownerless++;
    if (Number(readFileSync(counter, 'utf8')) === N * M) break;
  }
  const rs = await Promise.all(kids);

  for (const r of rs) assert.equal(r.ok, true, `a child failed to acquire: ${r.err.trim()}`);
  assert.ok(present > 0, 'the probe never caught the lock held, so it proves nothing');
  assert.equal(ownerless, 0, `the lock was ownerless on ${ownerless} of ${present} reads that found it present`);
  assert.equal(Number(readFileSync(counter, 'utf8')), N * M, `${N} x ${M} increments lost an update — the lock is not exclusive`);
  assert.equal(existsSync(lp), false, 'every child released');
  assert.deepEqual(scratches(d), [], 'and left no scratch file behind');
});

test('a waiter that finds the lock gone retries the link, and never unlinks the path', async (t) => {
  const d = dir(t);
  const lp = join(d, 'x.lock');
  const marker = join(d, 'raced');
  const successor = `${process.ppid}\n`; // alive, and not the waiter

  // The `free` branch is where the blind unlink lived, and restoring only that one line to an
  // otherwise-fixed lock was measured as the DOMINANT defect — two holders in the critical
  // section in 3 of 8 runs of a 12-process probe. A contention probe does catch it, but only in
  // some runs (measured 1 of 2 runs of an 8x12 probe), and a mutation caught half the time is
  // not caught at all. So the race is STAGED rather than waited for.
  //
  // The staging has two halves, and getting either wrong makes the assay silently useless.
  //
  // `linkSync` fails EEXIST having created nothing for a fixed WINDOW, not for a fixed number of
  // attempts. That is what guarantees the successor's lock can be published at all: the waiter
  // cannot take the lock during the window, so the `wx` publish below always lands. A first
  // version failed only the FIRST attempt and reported a false violation under 8-way load — the
  // waiter's immediate retry won, no successor was ever published, and "the successor's lock is
  // gone" was true because there had never been one.
  //
  // And the publish waits a few milliseconds after the marker, rather than firing on sight. The
  // damage needs the waiter to have ALREADY read `free` and to act on that stale reading; a
  // publish that lands before its read just makes it read `held`, which is the branch that was
  // always safe. Correct code re-links within microseconds of reading `free`, so a delayed
  // publish essentially never lands in its window; the blind-unlink version sleeps 10 ms first,
  // so it lands in nearly every one. Publishing on sight made this assay green against the
  // mutation, which is the failure mode the whole exercise is about.
  //
  // Measured: 0 violations on this code, and every staged round violated with a `sleep` and an
  // `unlink` grafted onto that branch. *A missing lock is not a stale lock.*
  const WINDOW = 200, ROUNDS = 3;
  let violations = 0, published = 0;
  for (let round = 0; round < ROUNDS; round++) {
    rmSync(marker, { force: true });
    rmSync(lp, { force: true });
    const running = child(d, `
      let entered = false;
      try { lock.withLock(null, () => { entered = true; }, { timeoutMs: 600 }); } catch {}
      say({ entered });
    `, {
      patch: `
        const real = fs.linkSync;
        // Anchored to the FIRST attempt, not to the moment this patch runs. Measured from patch
        // time it failed 2 of 8 runs at 8-way oversubscription: node's startup and the dynamic
        // import ate the whole window, so the waiter's second attempt was unstubbed, it took the
        // lock for real before any successor existed, and the assay reported a violation of its
        // own making. Anchoring here makes the window a property of the race rather than of how
        // loaded the machine is.
        let until = null;
        fs.linkSync = (from, to) => {
          if (until === null) until = Date.now() + ${WINDOW};
          if (Date.now() < until) {
            fs.writeFileSync(${JSON.stringify(marker)}, 'x');   // we are about to read 'free'
            throw Object.assign(new Error('EEXIST: staged race, link'), { code: 'EEXIST' });
          }
          return real(from, to);
        };
      `,
    });
    // Spin rather than await a timer: the marker means the waiter has reached the branch, and
    // every millisecond spent noticing is a millisecond of the window spent.
    // Polled rather than busy-waited: a spin here pegs a core, and eight oversubscribed copies
    // of this suite spinning is load the thing under test then has to compete with.
    for (let i = 0; i < 5000 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 1));
    if (existsSync(marker)) {
      await new Promise((r) => setTimeout(r, 4)); // inside the window a sleeping branch opens
      try { writeFileSync(lp, successor, { flag: 'wx' }); published++; } catch { /* waiter holds it */ }
    }
    const r = await running;
    const survived = existsSync(lp) && readFileSync(lp, 'utf8') === successor;
    // A violation is the successor's LIVE lock being gone: whether the waiter then managed to
    // enter is a second-order detail, since the successor already believes it holds a mutex.
    if (!survived) violations += 1;
    else assert.equal(r.entered, false, 'and a waiter must not enter past a live successor either');
    rmSync(lp, { force: true });
  }
  assert.equal(published, ROUNDS, 'the successor never got its lock published, so this proves nothing');
  assert.equal(violations, 0, `${violations} of ${published} staged rounds deleted a live successor's lock`);
  assert.deepEqual(scratches(d), []);
});

test('every owner state is classified, and only a dead or corrupt one is taken over', async (t) => {
  const d = dir(t);
  const lock = makeLock(d);
  const lp = join(d, 'x.lock');

  assert.equal(lock.withLock(null, () => {
    assert.equal(readFileSync(lp, 'utf8').trim(), String(process.pid), 'the lock records its owner');
    return 'value';
  }), 'value');
  assert.equal(existsSync(lp), false, 'released on the happy path');

  assert.throws(() => lock.withLock(null, () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(lp), false, 'released when fn throws');

  // A lock left by a dead process is taken over: `soma down` killing a pane mid-write is the
  // common way to lose a holder, and a lock nobody will release must not wedge the fleet.
  const dead = deadPid();
  writeFileSync(lp, String(dead));
  assert.equal(lock.withLock(null, () => 'took over', { timeoutMs: 1000 }), 'took over');

  // ...and so is one with no readable pid. `Number('') === 0` and `process.kill(0, 0)` signals
  // our own process group without throwing, so a truncated lock reads as "alive" to a naive
  // check and wedges forever.
  for (const garbage of ['', '   ', 'not-a-pid', '0', '-1', '3.5', '1e9999', `${dead}\n`]) {
    writeFileSync(lp, garbage);
    assert.equal(lock.withLock(null, () => 'ok', { timeoutMs: 1000 }), 'ok', `wedged on lock content ${JSON.stringify(garbage)}`);
  }

  // A live holder is waited on, then reported — never stolen.
  writeFileSync(lp, `${process.pid}\n`);
  const live = attempt(lock, null, { timeoutMs: 120 });
  assert.equal(live.ran, false, 'a live holder must never have its lock stolen');
  assert.match(live.message, new RegExp(`is still held by pid ${process.pid}`), `the refusal must name the holder: ${live.message}`);
  assert.ok(live.message.includes(lp), `and the absolute path: ${live.message}`);
  assert.equal(readFileSync(lp, 'utf8'), `${process.pid}\n`, 'and leave the live lock exactly as it was');
  rmSync(lp);
});

// ---------------------------------------------------------------------------
// Rule 3: an unreadable lock is never stolen, and the error is actionable.
// ---------------------------------------------------------------------------

test('an unreadable lock is never stolen, and the error names the path, the errno and the cure', async (t) => {
  const d = dir(t);
  const lock = makeLock(d);
  const lp = join(d, 'x.lock');

  // Two routes to the same dead end. An EACCES is the environment misbehaving, not evidence
  // the owner died — a takeover on the strength of one is a permissions hiccup promoted into
  // two writers. (Under a root runner the read succeeds and this becomes the live-holder case,
  // which refuses the steal for its own reason; the EISDIR case below holds for every uid.)
  for (const [why, setup, code] of [
    ['EACCES', () => { writeFileSync(lp, `${process.ppid}\n`); chmodSync(lp, 0o000); }, 'EACCES'],
    ['EISDIR', () => { mkdirSync(lp); }, 'EISDIR'],
  ]) {
    if (why === 'EACCES' && process.getuid?.() === 0) continue;
    setup();
    // stat needs no read permission, so size+inode is an identity that survives chmod 000.
    const before = { size: statSync(lp).size, ino: statSync(lp).ino };
    const e = attempt(lock, null, { timeoutMs: 120 });

    assert.equal(e.ran, false, `${why}: a lock soma cannot classify must not be entered past`);
    assert.equal(statSync(lp).size, before.size, `${why}: the bytes must be untouched`);
    assert.equal(statSync(lp).ino, before.ino, `${why}: the same file, not a replacement`);
    // Refusing to steal it also means nothing soma does later clears it: the next call fails
    // identically, so the wait is unbounded across calls and an operator is the only way out.
    // "Gave up after 120ms" alone reads as a hang to wait out, which this is not.
    assert.match(e.message, new RegExp(`is unreadable \\(${code}\\)`), `${why}: the error must say why it could not be read: ${e.message}`);
    assert.ok(e.message.includes(lp), `${why}: and name the absolute lock path: ${e.message}`);
    assert.match(e.message, /remove it by hand if no soma process is running/, `${why}: and how to clear it`);
    rmSync(lp, { recursive: true, force: true });
  }

  // The two self-resolving states get no such advice: telling an operator to delete a lock a
  // live holder is using is how one wedge becomes two writers.
  writeFileSync(lp, `${process.pid}\n`);
  const held = attempt(lock, null, { timeoutMs: 0 });
  assert.equal(held.ran, false, 'and a live holder is still not entered past');
  assert.doesNotMatch(held.message, /remove it by hand/, 'a live holder must not be offered up for deletion');
  rmSync(lp);
});

// ---------------------------------------------------------------------------
// Rule 4 + 5: an unguessable name per attempt, and the inode compare on top of it.
// ---------------------------------------------------------------------------

test('every link attempt in one contended acquire mints a name of its own', async (t) => {
  const d = dir(t);
  const lp = join(d, 'x.lock');
  writeFileSync(lp, `${process.pid}\n`); // we are alive, so the child has to keep trying

  // One name for the whole wait is not a smaller version of the bug, it *is* the bug: a name
  // that outlives one attempt is a name a second acquirer can find on disk and link, and the
  // landed-link proof would then read a second name on it as proof we hold a lock we do not.
  // So the claim is per *attempt*, checked across the retry loop, since a broken implementation
  // mints its one name outside it. `linkSync` is wrapped rather than replaced, so the code
  // under test still really contends against the live holder above.
  //
  // The wrapper ENDS the acquire on the Nth attempt, rather than letting a wall-clock budget end
  // it. That makes the attempt count a property of the race instead of a property of how loaded
  // the machine is: a `timeoutMs: 400` version with `retryMs: 10` expects ~40 attempts, and at
  // 8-way oversubscription the delayed `Atomics.wait` wakeups pushed one run below the
  // `attempts > 5` validity guard — 1 failure in 48. Same class as the staged-race window that
  // was anchored to patch time. A non-EEXIST errno is the clean way out: it is not the contended
  // path, so it escapes the acquire loop untouched, and the finally still drops the scratch.
  const WANT = 12;
  const r = await child(d, `
    try { lock.withLock(null, () => 'never', { timeoutMs: 30000 }); } catch (e) { var stopped = e.code; }
    say({ attempts: seen.length, distinct: new Set(seen).size, names: seen, childPid: process.pid, stopped });
  `, {
    patch: `
      const real = fs.linkSync;
      const seen = [];
      fs.linkSync = (from, to) => {
        seen.push(String(from));
        if (seen.length >= ${WANT}) throw Object.assign(new Error('EIO: enough attempts, link'), { code: 'EIO' });
        return real(from, to);
      };
    `,
  });

  assert.equal(r.stopped, 'EIO', `the child must have been stopped by the wrapper, not by a deadline: ${r.raw}`);
  assert.equal(r.attempts, WANT, `the child did not contend ${WANT} times (${r.attempts}), so this proves nothing`);
  assert.equal(r.distinct, r.attempts, `${r.attempts} link attempts shared ${r.distinct} scratch name(s)`);

  // Distinct is necessary and not sufficient: a *counter* alone is distinct per attempt and
  // still fully derivable, which is what the random token is for. It cannot be tested by
  // reproducing the case it exists for — that needs two hosts with one state root and the same
  // pid — so the testable claim is the one that makes that case safe: none of the names the
  // acquire actually used may be one an outsider could have written down in advance from the
  // lock path, the pid and a small integer.
  const derivable = new Set([`${lp}.tmp`, `${lp}.${r.childPid}.tmp`]);
  for (let i = 0; i <= r.attempts + 1; i++) {
    derivable.add(`${lp}.${i}.tmp`);
    derivable.add(`${lp}.${r.childPid}.${i}.tmp`);
  }
  const guessed = (r.names ?? []).filter((n) => derivable.has(n));
  assert.deepEqual(guessed, [], `a scratch name a stranger could derive was used: ${guessed.join(' ')}`);

  assert.equal(readFileSync(lp, 'utf8'), `${process.pid}\n`, 'and the live holder kept its lock');
  rmSync(lp);
  assert.deepEqual(scratches(d), [], 'a name per attempt is not litter per attempt');
});

test('a scratch name a stranger can derive does not prove we hold the lock', async (t) => {
  const d = dir(t);
  const lock = makeLock(d);
  const lp = join(d, 'x.lock');

  // The landed-link proof returns from the acquire *before* the live-holder check ever runs, so
  // it has to be proof rather than a guess — and it is proof only while the name is ours alone.
  // On the one deployment it exists for, a shared state root over a network filesystem, host
  // B's pid 500 derives host A's pid 500's name exactly. Measured against a derivable name plus
  // a truncating scratch write, this entered the critical section beside live pid 1, overwrote
  // its lock with our own pid through the shared inode, and deleted it on release.
  //
  // In-process, with our own pid: a child's pid is not knowable in advance, so a cross-process
  // version of this cannot pre-link the name the acquirer will actually use, reports clean
  // against a per-pid name, and proves nothing at all.
  writeFileSync(lp, '1\n'); // pid 1 is alive on every host, and never ours to steal from
  const holderIno = statSync(lp).ino;
  for (const guessable of [`${lp}.${process.pid}.tmp`, `${lp}.tmp`]) {
    linkSync(lp, guessable);
    const e = attempt(lock, null, { timeoutMs: 100 });
    assert.equal(e.ran, false, `${guessable}: a derivable name must not prove we hold the lock`);
    assert.match(e.message, /is still held by pid 1\b/, `and the refusal must still name the real holder: ${e.message}`);
    assert.equal(readFileSync(lp, 'utf8'), '1\n', 'the live holder must keep its lock, bytes and all');
    assert.equal(statSync(lp).ino, holderIno, 'the same inode, not a lock we replaced');
    unlinkSync(guessable);
  }
  rmSync(lp);
});

test('a link that landed somewhere other than the lock is not a lock we won', async (t) => {
  const d = dir(t);
  const lp = join(d, 'x.lock');

  // The case the landed-link proof exists for is a network filesystem reporting EEXIST for a
  // link it made. `nlink === 2` says the inode gained a second name; it does NOT say the name
  // it gained is the lock. Here the link really does land — under a different name — so a
  // count-only proof claims a lock that was never published. This is what the inode compare
  // adds, and it is an addition to the unguessable name, never a substitute: against a foreign
  // pre-linked scratch the inodes match too (see the test above).
  const r = await child(d, `
    let entered = false;
    try { lock.withLock(null, () => { entered = true; }, { timeoutMs: 120 }); } catch (e) { say({ entered, message: e.message }); }
    if (entered) say({ entered });
  `, {
    patch: `
      const real = fs.linkSync;
      fs.linkSync = (from, to) => {
        real(from, String(from) + '.elsewhere');       // the link DID land, under another name
        throw Object.assign(new Error('EEXIST: stubbed, link'), { code: 'EEXIST' });
      };
    `,
  });

  assert.equal(r.entered, false, 'a second name on our scratch is not proof the LOCK is ours');
  assert.match(r.message ?? '', /keeps being re-taken by another acquirer/, `and the refusal reports the race it lost: ${r.message}`);
  assert.equal(existsSync(lp), false, 'no lock was ever published');
});

test('a takeover unlinks the file it judged, or nothing at all', async (t) => {
  const d = dir(t);
  const lp = join(d, 'x.lock');
  const marker = join(d, 'judged');

  // `takeOver` is the one place a waiter unlinks a file it does not own, so the one thing it must
  // not do is unlink a *successor*. It re-reads immediately before the unlink and compares BOTH
  // halves of the file's identity — the bytes, and the inode.
  //
  // Staging this needs a window between the judgement and the unlink, and the `corrupt` branch
  // already has one in production: it pays a `retryMs` backoff before calling `takeOver`. So the
  // lock starts corrupt, `retryMs` is turned up to make that window wide, and the successor is
  // published inside it.
  //
  // The ordering is *observed*, not timed. The child writes a marker from inside its first
  // read-open of the lock path — which is `readLock`, i.e. the judgement itself — so the marker
  // means "the old inode has already been read" rather than "probably by now". Waiting a fixed
  // few milliseconds instead would make this assay fail whenever the child was descheduled
  // between two adjacent syscalls, which is the load-dependent shape that has already cost this
  // file two false failures.
  const RETRY = 500;
  const stage = async (replace, { timeoutMs }) => {
    rmSync(marker, { force: true });
    writeFileSync(lp, 'garbage\n');                 // corrupt: nothing here writes bytes like this
    const judgedIno = statSync(lp).ino;
    const running = child(d, `
      let entered = false;
      try { lock.withLock(null, () => { entered = true; }, { timeoutMs: ${timeoutMs} }); } catch {}
      say({ entered, attempts: seen.length });
    `, {
      spec: `retryMs: ${RETRY},`,
      patch: `
        const seen = [];
        const realLink = fs.linkSync;
        fs.linkSync = (from, to) => { seen.push(String(from)); return realLink(from, to); };
        const realOpen = fs.openSync;
        let judged = false;
        fs.openSync = (p, flags, ...rest) => {
          const fd = realOpen(p, flags, ...rest);
          // The first read-open of the lock is readLock's, and readLock is the judgement.
          if (!judged && p === ${JSON.stringify(lp)} && flags === 'r') {
            judged = true;
            fs.writeFileSync(${JSON.stringify(marker)}, 'x');
          }
          return fd;
        };
      `,
    });
    for (let i = 0; i < 5000 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 1));
    assert.equal(existsSync(marker), true, 'the child never reached the judgement, so this proves nothing');
    const successor = replace();                     // inside the backoff the corrupt branch pays
    // Captured here, not after the child has run: in the same-bytes case the child eventually
    // unlinks this file, so there would be nothing left to stat.
    const successorIno = existsSync(lp) ? statSync(lp).ino : null;
    const r = await running;
    return { ...r, judgedIno, successor, successorIno };
  };

  // A successor with DIFFERENT bytes — the plain case, and the one with a permanent consequence.
  // A takeover that unlinks by name deletes a live holder's lock and walks in beside it; one that
  // re-reads leaves it alone and times out saying so.
  const live = `${process.ppid}\n`;
  const diff = await stage(() => { rmSync(lp, { force: true }); writeFileSync(lp, live); return live; }, { timeoutMs: 2000 });
  assert.equal(diff.entered, false, 'a takeover must not enter past a successor that arrived while it decided');
  assert.equal(existsSync(lp), true, "and must not delete the successor's lock");
  assert.equal(readFileSync(lp, 'utf8'), live, 'which must still be the successor that owns it');

  // A successor with the SAME bytes and a different inode — the case the inode half of the compare
  // exists for. Two acquisitions do not write the same bytes (each carries its own nonce), so this
  // is the shape it takes: a corrupt lock, whose bytes are whatever an outside edit wrote, replaced
  // by an identical one. The bytes cannot tell these apart, so the observable is the attempt
  // count: re-reading declines the first takeover (inodes differ), pays another backoff, and takes
  // over the file it has now judged — three link attempts. A bytes-only compare unlinks a file it
  // never read and acquires in two.
  //
  // The judged file is pinned under a second name before the swap. Without that, ext4 hands its
  // freed inode number straight to the replacement, which is then the same (inode, bytes) pair as
  // the file judged, indistinguishable to `takeOver` and not the case this assay is for: the
  // sanity check below failed on every run on an ext4 Linux VM.
  const pinned = join(d, 'judged.pinned');
  const same = await stage(() => {
    linkSync(lp, pinned);
    rmSync(lp, { force: true });
    writeFileSync(lp, 'garbage\n');
    return 'garbage\n';
  }, { timeoutMs: 8000 });
  rmSync(pinned);
  assert.equal(same.entered, true, 'a corrupt lock must still be reclaimable — this must not wedge');
  assert.equal(same.successor, 'garbage\n', 'sanity: the successor really does carry the same bytes');
  assert.notEqual(same.successorIno, same.judgedIno, 'sanity: and really is a different file');
  assert.equal(same.attempts, 3, `a bytes-only compare would unlink a file it never read and acquire in 2 attempts, not ${same.attempts}`);
  assert.equal(existsSync(lp), false);
  assert.deepEqual(scratches(d), []);
});

// ---------------------------------------------------------------------------
// Rule 6: release reads before it unlinks — and is not over-cautious.
// ---------------------------------------------------------------------------

test('every acquisition writes bytes of its own, and they still read as our pid', async (t) => {
  const d = dir(t);
  const lock = makeLock(d);
  const lp = join(d, 'x.lock');

  // "Is this still my lock?" is answered by the file's inode number plus its bytes, and ext4
  // hands a freed inode number straight back. While the bytes were only `<pid>\n`, a successor
  // carrying our pid matched on both halves there, and the successor cases in this file and in
  // fleet.test.mjs failed on every run on an ext4 Linux VM. A nonce minted per acquisition is the
  // half no file system can recycle. It is asserted here, directly, because on a file system that
  // does not reuse inode numbers at once (APFS) those successor cases pass with or without it.
  //
  // The bytes must still read as our pid under `Number(raw.trim())`, the parse every `readLock`
  // soma has shipped uses: an older soma process still running through an upgrade reads anything
  // else as `corrupt`, and takes a corrupt lock over after one backoff.
  const seen = [];
  for (let i = 0; i < 2; i++) lock.withLock(null, () => { seen.push(readFileSync(lp, 'utf8')); });
  for (const raw of seen) {
    assert.equal(Number(raw.trim()), process.pid, `the lock must read as our pid to every readLock: ${JSON.stringify(raw)}`);
  }
  assert.notEqual(seen[0], seen[1], 'two acquisitions wrote the same bytes, so only the inode number can tell them apart');
  assert.equal(existsSync(lp), false);
});

test('a holder whose lock was taken over does not delete its successor on the way out', async (t) => {
  const d = dir(t);
  const lock = makeLock(d);
  const lp = join(d, 'x.lock');

  // Release used to unlink by name with no check, so a holder that lost its lock to a takeover
  // deleted the *successor's* lock on the way out and the successor went on believing it held a
  // mutex nobody had. That is worse than the takeover it follows: a losing takeover at least
  // leaves someone to time out and say so, while this one is silent. Measured 40 of 40 exits
  // before, 0 after. The steal is done from inside `fn` because that is the only place it can
  // be done deterministically, and it is exactly the interleaving a misdiagnosis produces.
  const successor = `${deadPid()}\n`;
  assert.notEqual(successor, `${process.pid}\n`);
  for (let i = 0; i < 5; i++) {
    lock.withLock(null, () => {
      assert.equal(readFileSync(lp, 'utf8').trim(), String(process.pid), 'the lock names us while we hold it');
      unlinkSync(lp);                    // a waiter decides we are dead and takes it over...
      writeFileSync(lp, successor);      // ...and publishes its own
    });
    assert.equal(existsSync(lp), true, "the successor's lock must survive our release");
    assert.equal(readFileSync(lp, 'utf8'), successor, 'and it must still be the successor that owns it');
    rmSync(lp);
  }

  // A successor carrying our own pid — what a recycled pid re-taking its own lock looks like — is
  // a successor too. On ext4 it lands on our inode NUMBER, which the filesystem hands straight
  // back, so there only the bytes can tell them apart: the successor's carry no nonce of ours.
  // While a lock's bytes were the pid alone, this failed on every run on an ext4 Linux VM.
  lock.withLock(null, () => {
    unlinkSync(lp);
    writeFileSync(lp, `${process.pid}\n`);
  });
  assert.equal(existsSync(lp), true, 'a successor carrying our own pid is still not our lock');
  rmSync(lp);

  // A successor carrying our EXACT bytes, nonce and all, on another inode. Two acquisitions do
  // not write the same bytes, so this takes a copy, and the copy is the point: it isolates the
  // inode half of the identity, the only thing that tells this file from ours. Our inode is
  // pinned under a second name before the swap, so the filesystem cannot hand its number to the
  // copy (ext4 would) and the two are different files on every filesystem.
  const pinned = join(d, 'ours.pinned');
  let ours = null, copy = null;
  lock.withLock(null, () => {
    const bytes = readFileSync(lp, 'utf8');
    linkSync(lp, pinned);
    ours = statSync(lp).ino;
    unlinkSync(lp);
    writeFileSync(lp, bytes);
    copy = statSync(lp).ino;
  });
  assert.notEqual(copy, ours, 'sanity: the copy really is a different file');
  assert.equal(existsSync(lp), true, 'a successor carrying our exact bytes is still not our lock');
  rmSync(lp);
  rmSync(pinned);

  // Which must not turn into a lock nothing ever clears. Over-caution here is its own outage.
  lock.withLock(null, () => 'ok');
  assert.equal(existsSync(lp), false, 'an ordinary release still drops our own lock');
  lock.withLock(null, () => { writeFileSync(lp, 'garbage\n'); });
  assert.equal(existsSync(lp), false, 'a corrupt lock is not left for the next acquirer to wait on');
  if (process.getuid?.() !== 0) {
    lock.withLock(null, () => { chmodSync(lp, 0o000); });
    assert.equal(existsSync(lp), false, 'nor is an unreadable one, which nothing else is allowed to steal');
  }
  assert.throws(() => lock.withLock(null, () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(lp), false, 'and a throwing fn still releases');
  assert.deepEqual(scratches(d), []);
});

// ---------------------------------------------------------------------------
// Rule 7 + 8: hard links are required, named, narrowly caught, and worded by the caller.
// ---------------------------------------------------------------------------

test('a filesystem without hard links says so, and nothing else is relabelled', async (t) => {
  const d = dir(t);
  const lp = join(d, 'x.lock');
  // Scoped to the scratch path rather than replacing the call outright: `openSync` is also how
  // `readLock` reads the lock and how the ESM loader reads this very module, so a blanket stub
  // kills the child before it can report anything — which reads as a silent pass.
  // A numeric first argument is the scratch write, which goes through the descriptor `openSync`
  // just returned — so a stub scoped to path suffixes alone would sail past it and the acquire
  // would publish an EMPTY lock and succeed, which is the very window this module exists to
  // close. (Found by this assertion failing, which is the only reason it is written this way.)
  const throwing = (fn, code) => `
    const real_${fn} = fs.${fn};
    fs.${fn} = (p, ...rest) => {
      if (typeof p === 'number' || (typeof p === 'string' && (p.endsWith('.tmp') || p.endsWith('.lock')))) {
        throw Object.assign(new Error(${JSON.stringify(`${code}: stubbed failure, ${fn}`)}), { code: ${JSON.stringify(code)} });
      }
      return real_${fn}(p, ...rest);
    };`;
  const acquireWith = (patch) => child(d, `
    try { lock.withLock(null, () => 0, { timeoutMs: 50 }); say({ entered: true }); }
    catch (e) { say({ message: e.message, causeCode: e.cause?.code ?? null }); }
  `, { patch });

  // `link(2)` IS the lock, so a volume without hard links cannot host it — and it used to say
  // so in libuv's words rather than soma's: `ENOTSUP: operation not supported on socket,
  // link '…'`, about a file. Reproduced on a real FAT32 volume, on which the `wx` create this
  // idiom replaced worked fine, so the rewrite introduced this. All three errnos, because some
  // filesystems report an unsupported link as EPERM. An assertion per part, so a message that
  // keeps one and drops the rest cannot pass.
  for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'EPERM']) {
    const r = await acquireWith(throwing('linkSync', code));
    assert.equal(r.entered, undefined, `${code} must not be treated as a successful acquire`);
    assert.match(r.message ?? '', /must be on a filesystem that supports hard links/, `${code} must name the cause: ${r.message}`);
    assert.match(r.message ?? '', new RegExp(`link\\(2\\) returned ${code}`), `${code} must be named: ${r.message}`);
    assert.ok((r.message ?? '').includes(lp), `${code} must name the absolute lock path: ${r.message}`);
    assert.match(r.message ?? '', /move THE ROOT off this volume/, `${code} must carry the caller's remedy: ${r.message}`);
    assert.equal(r.causeCode, code, 'and keep the original error as its cause');
  }

  // And not one errno more, in either direction. A cross-device link and an I/O error are
  // different faults with different fixes, and burying either under "this volume has no hard
  // links" would send someone reformatting a disk over a misplaced state root.
  for (const code of ['EXDEV', 'EIO', 'EACCES']) {
    const r = await acquireWith(throwing('linkSync', code));
    assert.match(r.message ?? '', new RegExp(`${code}: stubbed failure, linkSync`), `an unrelated link failure must surface as itself: ${r.message}`);
    assert.doesNotMatch(r.message ?? '', /supports hard links/, `${code} must not be relabelled`);
  }

  // The narrowness that matters most: EPERM is in the set, and it is also what the *scratch
  // write* returns for a directory this process may not write — an immutable one reports EPERM
  // (reproduced with `chflags uchg`), a mode-500 one EACCES. That is a permissions problem with
  // a permissions fix, and relabelling it "move to another filesystem" sends an operator to
  // reformat a disk over a chmod. Which is why the catch wraps the single `linkSync` call.
  for (const [fn, code] of [['writeFileSync', 'EPERM'], ['writeFileSync', 'EACCES'], ['openSync', 'EPERM'], ['openSync', 'EACCES']]) {
    const r = await acquireWith(throwing(fn, code));
    assert.equal(r.entered, undefined, `a scratch ${fn} that fails ${code} is not an acquire`);
    assert.match(r.message ?? '', new RegExp(`${code}: stubbed failure, ${fn}`), `a scratch-write ${code} must surface as itself: ${r.message}`);
    assert.doesNotMatch(r.message ?? '', /supports hard links/, `a scratch ${code} must not be relabelled a filesystem without hard links`);
  }

  // An EEXIST from the scratch open is not an EEXIST from the link. They mean opposite things:
  // from the link, "the lock is contended", which is ordinary; from the scratch open, "a name
  // that should be ours alone exists and we could not remove it", which must not be papered
  // over by consulting nlink on a file we did not write.
  const collided = await acquireWith(
    `const realOpen = fs.openSync;\n      fs.openSync = (p, ...rest) => { if (String(p).endsWith('.tmp')) throw Object.assign(new Error('EEXIST: stubbed scratch collision, open'), { code: 'EEXIST' }); return realOpen(p, ...rest); };`,
  );
  assert.equal(collided.entered, undefined, 'a scratch collision is not an acquire');
  assert.match(collided.message ?? '', /EEXIST: stubbed scratch collision/, `it must surface as itself: ${collided.message}`);
  assert.doesNotMatch(collided.message ?? '', /keeps being re-taken/, 'and must not be diagnosed as a contended lock');

  // No `wx` fallback, deliberately — degrading to O_CREAT|O_EXCL would reopen the empty-file
  // steal window silently, on exactly the machines nobody is watching.
  assert.deepEqual(scratches(d), [], 'a refused acquire leaves no scratch file');
  assert.equal(existsSync(lp), false, 'and no lock');
});

test('every message is worded by the caller, and keyed', async (t) => {
  const d = dir(t);
  // Two of soma's three locks live under SOMA_HOME and the third lives beside claude's own
  // config, where "move SOMA_HOME off this volume" is simply the wrong instruction — an
  // operator sent to change a setting that has no bearing on where the file lives. So the
  // wording belongs to the caller, and it has to be able to depend on the key, because that
  // is the only way the third lock can name the directory it is actually in.
  const spec = `
      label: (k) => \`\${k}.lock\`,
      lockFile: (k) => ${JSON.stringify(d)} + '/' + k + '.lock',
      hardLinks: {
        requirement: (k) => \`the volume holding \${k} must support hard links\`,
        remedy: (k) => \`repoint \${k} somewhere else\`,
      },`;
  for (const k of ['alpha', 'beta']) {
    const r = await child(d, `
      try { lock.withLock(${JSON.stringify(k)}, () => 0, { timeoutMs: 40 }); say({ entered: true }); }
      catch (e) { say({ message: e.message }); }
    `, { spec, patch: `
      const real = fs.linkSync;
      fs.linkSync = () => { throw Object.assign(new Error('ENOTSUP: stubbed, link'), { code: 'ENOTSUP' }); };
    ` });
    assert.equal(r.entered, undefined, `${k}: a link failure is not an acquire`);
    assert.match(r.message ?? '', new RegExp(`^${k}\\.lock: the volume holding ${k} must support hard links`), `${k}: the requirement must be keyed: ${r.message}`);
    assert.match(r.message ?? '', new RegExp(`— repoint ${k} somewhere else`), `${k}: and so must the remedy: ${r.message}`);
    assert.ok((r.message ?? '').includes(join(d, `${k}.lock`)), `${k}: and it must name that key's own file: ${r.message}`);
    // The label keys the deadline message too — the two must not drift apart, since an operator
    // greps for the same prefix whichever way the lock refused them.
    writeFileSync(join(d, `${k}.lock`), `${process.ppid}\n`);
    const timedOut = await child(d, `
      try { lock.withLock(${JSON.stringify(k)}, () => 0, { timeoutMs: 30 }); say({ entered: true }); }
      catch (e) { say({ message: e.message }); }
    `, { spec });
    assert.match(timedOut.message ?? '', new RegExp(`^${k}\\.lock: .*is still held by pid ${process.ppid}`), `${k}: the deadline message must be keyed too: ${timedOut.message}`);
    rmSync(join(d, `${k}.lock`), { force: true });
  }
  assert.deepEqual(scratches(d), []);
});

// ---------------------------------------------------------------------------
// Rule 9 as the module carries it: synchronous, thenable-refusing, optionally re-entrant.
// ---------------------------------------------------------------------------

test('fn must be a function, and must not be a thenable — and the rejection is adopted', async (t) => {
  const d = dir(t);
  const lock = makeLock(d);
  const lp = join(d, 'x.lock');

  // Two things, and the second is the one that needed rethinking. A message matcher, not a
  // bare constructor: `assert.throws(fn, TypeError)` matches every native TypeError there is,
  // including the `fn is not a function` an UNGUARDED call throws on its own one line later.
  //
  // And a LIVE HOLDER in the way, so that "refused before any lock is taken" is a claim this
  // test can actually falsify. Asserting the lock is absent afterwards cannot: the `finally`
  // removes it either way, so that absence is produced by the release rather than by the guard,
  // and it passed with the guard deleted. With a live holder present, an unguarded call waits
  // the whole timeout and refuses with the deadline message instead — which the matcher below
  // catches. (Measured: deleting the guard leaves the absence assertion green and turns this
  // one red.)
  writeFileSync(lp, `${process.ppid}\n`);
  for (const bad of [undefined, null, 'fn', 42, {}, Symbol('x')]) {
    assert.throws(() => lock.withLock(null, bad, { timeoutMs: 300 }), /^TypeError: testLock: fn must be a function, got /,
      `a ${typeof bad} fn must be refused by the guard, before the lock is even looked at`);
  }
  assert.equal(readFileSync(lp, 'utf8'), `${process.ppid}\n`, "and the holder's lock is untouched by the refusal");
  rmSync(lp);

  // Release happens on the synchronous return, so an async fn would unlock at its first await
  // and run the rest of its "protected" work in the open. Refused, not awaited — awaiting would
  // make every caller of this synchronous API async.
  for (const thenable of [async () => 'nope', () => Promise.resolve(1), () => ({ then() {} })]) {
    assert.throws(() => lock.withLock(null, thenable), /^TypeError: testLock: fn must be synchronous — the lock is released before a promise could settle$/);
    assert.equal(existsSync(lp), false, 'the lock is released anyway');
  }

  // Refusing the fn is right; abandoning the promise it already returned is not. Node's default
  // is --unhandled-rejections=throw, so an unadopted rejection kills the process at the next
  // microtask checkpoint — *after* the caller has caught and handled the TypeError. One async
  // callback would take down the watchdog or the bus rather than costing a tick. In a child,
  // because a listener in this process would mask exactly the failure being tested.
  const body = `
    for (const t of [async () => { throw new Error('inner-boom'); }, () => Promise.reject(new Error('inner-boom'))]) {
      try { lock.withLock(null, t); } catch {}
    }
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  `;
  // Two children, because a listener that *observes* the rejection also SUPPRESSES the kill:
  // Node only applies --unhandled-rejections=throw when nothing is listening. So the process
  // with a listener reports which rejections went unheld, and the one WITHOUT a listener is the
  // only place the actual consequence — the watchdog dying at the next microtask checkpoint —
  // can be measured. Asserting exit 0 on the listening child was toothless: it exits 0 whether
  // the promise is adopted or not.
  const watched = await child(d, `
    const kills = [];
    process.on('unhandledRejection', (x) => kills.push(String(x)));
    ${body}
    say({ kills, exists: fs.existsSync(${JSON.stringify(lp)}) });
  `);
  assert.deepEqual(watched.kills, [], 'the refused promise must be adopted, not abandoned');
  assert.equal(watched.exists, false, 'the lock is released anyway');

  const bare = await child(d, `${body}\n    say({ survived: true });`);
  assert.equal(bare.survived, true, `an unadopted rejection would take the process down here: ${bare.err.trim().slice(0, 300)}`);
  assert.equal(bare.code, 0, `and it must exit cleanly: signal=${bare.signal} stderr=${bare.err.trim().slice(0, 200)}`);
});

test('re-entrancy is per key and opt-in, and an inner return never releases the outer lock', async (t) => {
  const d = dir(t);
  const keyed = createFileLock({
    api: 'keyed',
    label: (k) => `${k}.lock`,
    lockFile: (k) => join(d, `${k}.lock`),
    hardLinks: { requirement: 'r', remedy: 'm' },
    timeoutMs: 200,
    retryMs: 10,
    reentrant: true,
  });
  const at = (k) => join(d, `${k}.lock`);

  assert.equal(keyed.withLock('a', () => {
    // A caller is expected to wrap a whole operation in the lock while an inner helper takes it
    // again; a non-re-entrant lock would queue behind itself, burn the timeout and throw.
    const inner = keyed.withLock('a', () => {
      assert.equal(keyed.withLock('b', () => existsSync(at('b'))), true, 'a second key is not blocked by the first');
      return 'inner';
    });
    assert.equal(inner, 'inner');
    assert.equal(existsSync(at('a')), true, "a nested return must not release the lock the outer still holds");
    return 'outer';
  }), 'outer');
  assert.equal(existsSync(at('a')), false);
  assert.equal(existsSync(at('b')), false);

  // A throwing inner call must not release it either, and the outer's finally still must.
  assert.throws(() => keyed.withLock('a', () => {
    try { keyed.withLock('a', () => { throw new Error('inner-boom'); }); } catch { /* handled */ }
    assert.equal(existsSync(at('a')), true, 'a nested throw must not release the outer lock');
    throw new Error('outer-boom');
  }), /outer-boom/);
  assert.equal(existsSync(at('a')), false, 'and the outer release still happens');

  // Without `reentrant` a nested acquire is a real acquire, which is what a caller that had
  // started to nest should find out about rather than have papered over.
  const plain = makeLock(d, { timeoutMs: 60 });
  let nested = '', inner = 'not-reached';
  try { plain.withLock(null, () => { inner = plain.withLock(null, () => 'never'); }); } catch (e) { nested = e.message; }
  assert.equal(inner, 'not-reached', 'without `reentrant`, a nested acquire must be a real acquire');
  assert.match(nested, new RegExp(`is still held by pid ${process.pid}`), `and it reports itself as the holder: ${nested}`);
  assert.equal(existsSync(join(d, 'x.lock')), false, 'and the outer still releases');
  assert.deepEqual(scratches(d), []);
});

// ---------------------------------------------------------------------------
// Rule 10 as the module carries it: an opt-in age-out, defaulting to none.
// ---------------------------------------------------------------------------

test('the recycled-pid age-out is opt-in, and never a licence to steal a working lock', async (t) => {
  const d = dir(t);
  const lp = join(d, 'x.lock');
  const withAgeOut = makeLock(d, { staleMs: 50, timeoutMs: 400 });
  const noAgeOut = makeLock(d, { timeoutMs: 150 });

  // The wedge an age-out closes: a holder is SIGKILLed, its lock survives with nothing on the
  // machine cleaning it up, and its pid is later handed to an unrelated long-lived process.
  // Liveness alone then says "held" forever and every future acquire refuses. Our own parent is
  // the deterministic version — certainly alive, certainly not holding this lock, and a real
  // pid on every platform (unlike a hardcoded 1).
  const stale = () => {
    writeFileSync(lp, `${process.ppid}\n`);
    const old = Date.now() / 1000 - 300;
    utimesSync(lp, old, old);
  };
  stale();
  assert.equal(withAgeOut.withLock(null, () => 'reclaimed'), 'reclaimed', 'an aged-out lock naming a live pid must be reclaimable');
  assert.equal(existsSync(lp), false, 'and released, not inherited');

  // Default is no age-out at all, and that default is load-bearing: one of soma's three locks
  // is held across a `git fetch` that may run for two minutes, so an age-out shared with it
  // would take the lock away from a spawner that is working normally.
  stale();
  const e = attempt(noAgeOut, null, undefined);
  assert.equal(e.ran, false, 'with no staleMs, age is not evidence of anything');
  assert.match(e.message, new RegExp(`is still held by pid ${process.ppid}`), `and the wait is reported, not resolved: ${e.message}`);
  assert.equal(readFileSync(lp, 'utf8'), `${process.ppid}\n`, 'and the lock is left exactly as it was');

  // The other half of the age-out: a FRESH lock naming a live pid is the one case where waiting
  // is the only safe answer. Taking it would put two critical sections in flight, which is the
  // lost update the lock exists to prevent.
  writeFileSync(lp, `${process.ppid}\n`);
  const fresh = attempt(withAgeOut, null, { timeoutMs: 30 });
  assert.equal(fresh.ran, false, 'a fresh live holder must never be stolen from, age-out or not');
  assert.match(fresh.message, new RegExp(`is still held by pid ${process.ppid}`));
  assert.equal(readFileSync(lp, 'utf8'), `${process.ppid}\n`);
  rmSync(lp);
});

// ---------------------------------------------------------------------------
// A real crash, a real filesystem, and the two remaining spec fields.
// ---------------------------------------------------------------------------

test('a holder SIGKILLed inside the critical section leaves a reclaimable lock', async (t) => {
  const d = dir(t);
  const lock = makeLock(d);
  const lp = join(d, 'x.lock');

  // A synthesized dead pid is not a crash. `soma down` killing a tmux pane mid-write is, so
  // the holder kills itself *inside* the critical section: its `finally` never runs and the
  // lock survives with a real, now-dead pid in it. The takeover only unlinks a lock whose
  // identity is unchanged, which is what stops it deleting a successor's; this pins that the
  // same check cannot refuse the reclaim, since a fix that wedges every later acquire is worse
  // than the race it closed.
  for (let i = 0; i < 3; i++) {
    const dead = await child(d, `lock.withLock(null, () => { process.kill(process.pid, 'SIGKILL'); });`);
    assert.equal(dead.signal, 'SIGKILL', 'the crash has to be real for this to prove anything');
    assert.equal(readFileSync(lp, 'utf8').trim(), String(dead.pid), 'the crashed holder left its lock behind');
    assert.equal(lock.withLock(null, () => 'reclaimed', { timeoutMs: 2000 }), 'reclaimed');
    assert.equal(existsSync(lp), false);
    // The scratch is unlinked on the acquire's own return, not at release, so even a holder
    // killed mid-critical-section leaves no litter.
    assert.deepEqual(scratches(d), []);
  }
});

test('mode and dirMode are honoured, and a wiped directory costs one mkdir', async (t) => {
  const d = dir(t);
  const nested = join(d, 'gone', 'deeper');
  const lp = join(nested, 'x.lock');
  const lock = makeLock(d, { lockFile: () => lp, mode: 0o600, dirMode: 0o700 });

  // The self-heal exists because a state root that has not been created — or was wiped from
  // under a running fleet — should cost one mkdir, not every acquire from here on. `dirMode`
  // exists because one of these locks lives in a directory full of credentials, and a self-heal
  // that recreated it world-readable would be a worse outage than the missing directory.
  let seen = null;
  assert.equal(lock.withLock(null, () => { seen = statSync(lp).mode & 0o777; return 'ok'; }), 'ok');
  if (process.platform !== 'win32') {
    assert.equal(seen, 0o600, 'the lock is a hard link of the scratch, so the scratch mode is the lock mode');
    assert.equal(statSync(nested).mode & 0o777, 0o700, 'a directory holding credentials is 0700 or nothing');
  }
  rmSync(join(d, 'gone'), { recursive: true, force: true });
  assert.equal(lock.withLock(null, () => 'healed again'), 'healed again', 'and it heals more than once');
});

test('a deadline bounds the wait while timeoutMs only reports it', async (t) => {
  const d = dir(t);
  const lock = makeLock(d);
  const lp = join(d, 'x.lock');
  writeFileSync(lp, `${process.ppid}\n`);

  // One caller's budget spans several acquires, so it passes the whole-call deadline and the
  // whole-call budget: the deadline is what stops the wait, and the number in the message is
  // what an operator actually set rather than whatever was left of it on the last round.
  const started = Date.now();
  const e = attempt(lock, null, { deadline: Date.now() + 40, timeoutMs: 5000 });
  const waited = Date.now() - started;
  assert.equal(e.ran, false, 'a live holder is still not entered past');
  assert.ok(waited < 1000, `the deadline must bound the wait, not timeoutMs (waited ${waited}ms)`);
  assert.match(e.message, /gave up after 5000ms/, `and the message reports the caller's budget: ${e.message}`);

  // Checked after one attempt, so even an already-expired deadline tries once before giving up.
  rmSync(lp);
  assert.equal(lock.withLock(null, () => 'got it', { deadline: Date.now() - 1000, timeoutMs: 1 }), 'got it');
  assert.equal(existsSync(lp), false);
});
