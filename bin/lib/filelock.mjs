/**
 * The one cross-process file mutex — `link(2)` to publish, four owner states to classify,
 * and no unlink of a file this process has not just proved is the one it judged.
 *
 * Three modules derived this shape independently: `fleet.mjs` over the fleet checkpoint,
 * `worktree.mjs` over each target repo, `pretrust.mjs` over claude's own `.claude.json`.
 * Two of the three were then *provably broken*, each in a different way, and each fix
 * landed in only the copy that was being looked at. By the time they were compared, the
 * strongest copy carried two hardenings the weakest lacked and the weakest carried one
 * the others lacked. This file is the union, and it exists so the next fix lands once.
 *
 * Every rule below is the shape of a measured failure. None of them is a style choice, and
 * the ones that look redundant are the ones a reviewer has already tried to remove:
 *
 * 1. **Publish by `link(2)`, never `open('wx')` then write.** `writeFileSync(lock, pid,
 *    {flag:'wx'})` is open-THEN-write, so the file is briefly EMPTY. A waiter sampling
 *    that window read `Number('') === 0`, found `process.kill(0, 0)` did not throw,
 *    concluded "dead owner" and **stole a live lock**. Measured on the code this replaces:
 *    2081 of 9315 present-lock reads found it ownerless, 60 of 60 contended runs failed,
 *    0 of 60 afterwards. `link(2)` either publishes a finished inode under the lock's name
 *    or fails EEXIST having published nothing. There is no third state to observe.
 * 2. **Four owner states, never "the owner pid, or null".** Absent, unreadable and corrupt
 *    all read as "no owner", so a collapsed classifier can only answer all three the same
 *    way — by unlinking whatever is at the path. That blind unlink was the *dominant*
 *    defect: grafting only that one branch back onto an otherwise-fixed lock put two
 *    holders in the critical section in 3 of 8 runs of a 12-process probe.
 * 3. **An unreadable lock is never stolen.** An EACCES is the environment misbehaving, not
 *    evidence the owner died; promoting one into a steal turns a permissions hiccup into
 *    two writers. Nothing soma does later clears it either, so the deadline error is
 *    addressed to a person: absolute path, errno, and the remedy.
 * 4. **The scratch name is unique per *attempt*, not per process.** `linkLanded`'s proof is
 *    only that *our* link landed while nobody else could have put a second name on this
 *    inode, so the name has to be one nobody else can arrive at. A derivable name defeats
 *    the live-holder check outright: measured against a per-pid name, a waiter entered past
 *    live pid 1, overwrote pid 1's lock with its own pid through the shared inode, and
 *    deleted it on release.
 * 5. **The inode compare is in addition to that name, never instead of it.** With a foreign
 *    pre-linked scratch, `nlink === 2` is true *and the inodes match* (measured on this
 *    filesystem), so an inode check standing alone reopens rule 4 exactly. What it adds is
 *    that `nlink === 2` does not say *which* second name the inode gained.
 * 6. **Release reads before it unlinks.** An unconditional `unlink` by name means a holder
 *    whose lock was already taken over deletes its *successor's* lock on the way out, and
 *    the successor never learns — worse than the takeover it follows, which at least leaves
 *    someone to time out and say so. Measured: 40 of 40 such releases before, 0 after. The
 *    rule is deliberately narrow — leave alone only a `held` lock that is not ours; still
 *    unlink `free`, `corrupt` and `unreadable`, because over-caution here produces a lock
 *    nothing ever clears. "Ours" is the inode and the bytes we published, and the bytes carry
 *    a nonce fresh to each acquisition: ext4 hands a freed inode number straight back, so with
 *    the pid alone a successor carrying our pid read as ours (see `nonce`).
 * 7. **Hard links are a hard requirement, and the failure is named.** On a volume without
 *    them `linkSync` fails and escapes as libuv's `ENOTSUP: operation not supported on
 *    socket, link '…'` — about a file. Reproduced on a real FAT volume, on which the `wx`
 *    create this idiom replaced worked fine, so the rewrite introduced it. The catch wraps
 *    the single `linkSync` call, because EPERM is also what a scratch write returns for a
 *    directory this process may not write, and relabelling that "move to another
 *    filesystem" sends an operator to reformat a disk over a chmod.
 * 8. **That diagnosis is the caller's to word,** because the callers are not all on the same
 *    volume: two of these locks live under `$SOMA_HOME` and the third lives beside claude's
 *    own config, where "move SOMA_HOME" is simply the wrong instruction.
 *
 * ## The residual, which is documented rather than closed
 *
 * POSIX has no "unlink only if this inode", so taking over a dead holder's lock is always
 * two syscalls and a successor's lock can land between them. `takeOver` re-reads and
 * compares identity immediately before the unlink, which narrows the window to the gap
 * between two adjacent syscalls; it does not close it. Measured across independent
 * harnesses at 0.28–1.63 violations per 1000 *provoked* takeovers, and zero across tens of
 * thousands of critical sections with no crashed holder — a takeover needs a dead holder
 * plus two simultaneous takers to reach at all.
 *
 * Three narrowings were tried and none closed it. Two are dead ends, recorded so they are
 * not tried again:
 *
 * - **A second lock serialising takeovers does not close it.** Its own crash-stale state
 *   has to be reclaimed by something, which reintroduces a smaller copy of the same wedge.
 * - **A symlink lock does not close it.** A symlink makes *publication* atomic, which
 *   `link(2)` already does; taking over a dead holder is still `unlink` by name. (Two older
 *   reports claim otherwise. They are wrong. Verified separately: symlinks are available
 *   even on the FAT volume where `link(2)` is not, so availability was never the issue.)
 *
 * Only `flock`/`fcntl` on a held descriptor genuinely closes it, because the kernel drops
 * the lock on process death and no takeover logic is needed at all. Node 24 on this
 * platform exposes no `fs.flockSync` and no `O_EXLOCK`/`O_SHLOCK` constant, so with the
 * zero-dependency rule that is not available here.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';

/**
 * How a filesystem says "I do not do hard links".
 *
 * EPERM is in the set because some filesystems report an unsupported link that way rather
 * than ENOTSUP. It costs a little precision — an immutable or append-only directory reports
 * EPERM too — but the errno is named in the message, and the remedy overlaps.
 *
 * Not a `wx` fallback, deliberately. Degrading to `O_CREAT|O_EXCL` on these volumes would
 * reopen the empty-file window rule 1 exists to close, and would do it silently, on exactly
 * the machines nobody is watching. A lock that refuses to start is a bad afternoon; a lock
 * that quietly stops being exclusive is a lost fleet.
 */
const LINK_UNSUPPORTED = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM']);

/** Synchronous sleep with no dependencies and no busy-wait. */
const SLEEP_SLOT = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => void Atomics.wait(SLEEP_SLOT, 0, 0, ms);

/**
 * One counter for every lock in the process, not one per lock instance.
 *
 * Module-scoped on purpose: the tests deliberately create several instances of a caller
 * module in one process (`import('./fleet.mjs?tag')`), and per-instance counters would let
 * two of them mint the same `<pid>.<token>.<n>` name if they ever agreed on a token. One
 * counter makes that impossible to arrange rather than merely unlikely.
 */
let scratchSerial = 0;

/** A spec field that may be a constant or a function of the lock's key. */
const val = (x, key) => (typeof x === 'function' ? x(key) : x);

/**
 * Refuse a `fn` that returned a promise — after adopting it. `api` names the caller.
 *
 * The `catch` is not politeness. Refusing the result does not un-start the work it
 * represents: the promise is already in flight, and if it rejects, nobody is left holding it
 * once we throw. Under Node's default `--unhandled-rejections=throw` that kills the process
 * at the next microtask checkpoint — *after* the caller has caught and handled this
 * TypeError — so one stray `async` callback would take down the watchdog or the bus instead
 * of costing a single tick. Adopting it keeps the TypeError as the thing that gets reported
 * and reduces the rejection to a no-op.
 *
 * Exported because the refusal has to happen at every point a synchronous critical section
 * hands control to a caller's callback, and one of these locks wraps a second callback of
 * its own (`fleet.updateFleet`) inside the one this module already guards.
 */
export function refuseThenable(api, result) {
  if (result && typeof result.then === 'function') {
    if (typeof result.catch === 'function') result.catch(() => {});
    throw new TypeError(`${api}: fn must be synchronous — the lock is released before a promise could settle`);
  }
  return result;
}

/** Whether `pid` still exists. EPERM means alive but not ours; ESRCH means gone. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * A fresh nonce for one acquisition's lock bytes: 64 random bits, one character per bit, a space
 * for 0 and a tab for 1. The lock holds `<pid>\n<nonce>\n`.
 *
 * **The nonce is the half of the lock's identity the file system cannot recycle.** `takeOver`
 * and `releaseLock` decide "is this still the file I judged?" by its inode number plus its
 * bytes, and ext4 hands a freed inode number straight back: on an ext4 Linux VM, a lock-sized
 * file unlinked and re-created at once got the old number back 2000 times in 2000. While the
 * bytes were only `<pid>\n`, a successor carrying the same pid — a recycled pid, or this
 * process's own next acquisition — therefore matched on both halves, and the suite's successor
 * cases failed on every run there. File times cannot stand in for the nonce: on the same VM, two
 * files created back to back carried the same mtime, ctime and birth time 2000 times in 2000.
 *
 * **Whitespace only, and that is not a style choice.** Every `readLock` soma has shipped parses
 * the bytes as `Number(raw.trim())`, and `trim()` strips spaces, tabs and newlines, so that parse
 * still reads these bytes as the pid alone — a `held` lock. A visible token (a hex second line,
 * say) reads as `corrupt` to an older soma process still running through an upgrade, and
 * `corrupt` is taken over after one backoff, so the upgrade would steal live locks. Readers and
 * comparers need no change: `takeOver` and `releaseLock` already compare the bytes whole. A lock
 * an older soma wrote carries no nonce, so it keeps the pid-only bytes, and the weaker identity
 * that comes with them, until that process lets it go.
 */
function nonce() {
  let out = '';
  for (const byte of randomBytes(8)) {
    for (let bit = 7; bit >= 0; bit--) out += (byte >> bit) & 1 ? '\t' : ' ';
  }
  return out;
}

/** Two states have no file behind them, so they carry no identity to compare. */
const free = () => ({ state: 'free', pid: null, raw: null, ino: null, ageMs: 0, code: null });
const opaque = (code) => ({ state: 'unreadable', pid: null, raw: null, ino: null, ageMs: 0, code });

/**
 * What the lock says right now — one of four states, plus the identity and age of the file
 * those bytes came from.
 *
 * - `free`       nothing there. Retry the link; there is nothing to clean up.
 * - `held`       a pid, plus the acquisition's nonce in whitespace that `trim()` drops (see
 *                `nonce`). Waited on while it is alive and young; taken over otherwise.
 * - `corrupt`    bytes that are not a pid. Cannot be a holder caught mid-write, because the
 *                link publishes name and pid in one step — so it is an outside edit.
 * - `unreadable` EACCES, EIO, a directory at the path. No evidence whatever that the holder
 *                is gone, so it is waited out and reported, never stolen.
 *
 * Read through one descriptor rather than by path, so `raw`, `ino` and `ageMs` all describe
 * the *same* file: a successor linked between two path-based syscalls cannot be mistaken for
 * the file we judged. `takeOver` and `releaseLock` compare that identity before they unlink.
 *
 * The pid guard is also the defence against genuine corruption: `Number('')` is 0 and
 * `process.kill(0, 0)` signals our own process group without throwing, so a truncated lock
 * read as "held by a live process" would wedge every acquirer forever.
 *
 * `code` is carried out with the state because the deadline message has to report it: it is
 * the only thing that tells an operator which repair the wedge needs (EACCES wants a chmod,
 * EISDIR means something created a *directory* here).
 */
function readLock(lockFile) {
  let fd;
  try {
    fd = openSync(lockFile, 'r');
  } catch (e) {
    // ENOENT is the released state as well as the never-locked one. Anything else is the
    // environment misbehaving, not a holder that died.
    return e.code === 'ENOENT' ? free() : opaque(e.code ?? e.message);
  }
  try {
    const st = fstatSync(fd);
    const raw = readFileSync(fd, 'utf8');
    const pid = Number(raw.trim());
    // Nothing rewrites a lock once it is linked, so mtime is the moment it was taken.
    const id = { raw, ino: st.ino, ageMs: Date.now() - st.mtimeMs, code: null };
    return Number.isInteger(pid) && pid > 0
      ? { state: 'held', pid, ...id }
      : { state: 'corrupt', pid: null, ...id };
  } catch (e) {
    // A directory opens fine and then fails EISDIR on the read. Unreadable either way, and
    // unreadable is never evidence of death.
    return opaque(e.code ?? e.message);
  } finally {
    closeSync(fd);
  }
}

/**
 * What to throw when the acquire deadline passes, given whatever is in the lock's place.
 *
 * Two of the four states are self-resolving and naming them is the whole job: a live holder
 * finishes or dies, and a lock that reads free means we are losing a link race we can simply
 * re-enter. The other two outlive this call — nothing soma does on the next call clears an
 * unreadable or corrupt lock either, so the next acquire fails identically and the one after
 * that. The wait is unbounded *across* calls and a person is the only thing that can end it,
 * which is why those two get the remedy and the self-resolving two do not: telling an
 * operator to delete a lock a live holder is using is how one wedge becomes two writers.
 */
function timeoutMessage(label, lockFile, timeoutMs) {
  const lock = readLock(lockFile);
  const gaveUp = `gave up after ${timeoutMs}ms`;
  const byHand = 'soma cannot tell whether its owner is alive; remove it by hand if no soma process is running.';
  if (lock.state === 'held') return `${label}: ${lockFile} is still held by pid ${lock.pid} — ${gaveUp}`;
  if (lock.state === 'free') return `${label}: ${lockFile} keeps being re-taken by another acquirer — ${gaveUp}`;
  if (lock.state === 'unreadable') return `${label}: ${lockFile} is unreadable (${lock.code}) — ${gaveUp}. ${byHand}`;
  // Sliced: the bytes are worth showing, but this is an arbitrary file's contents.
  return `${label}: ${lockFile} holds no pid (${JSON.stringify(lock.raw.slice(0, 40))}) — ${gaveUp}. ${byHand}`;
}

/** Unlink the lock by name. Every caller establishes first that it is theirs to unlink. */
function removeLock(lockFile) {
  try {
    unlinkSync(lockFile);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

/** Drop a scratch file we are done with, or one whose write never landed. */
function dropScratch(tmp) {
  try {
    unlinkSync(tmp);
  } catch { /* not there, which is the state we wanted */ }
}

/**
 * Clear a lock we have judged abandoned — but only while it is still the same file.
 *
 * A takeover is the one place a waiter unlinks a file it does not own, so the one thing it
 * must not do is unlink a *successor*. Between reading pid 41 and deciding it is dead, 41's
 * lock can be cleared and live pid 42's linked in its place; unlinking by name would delete a
 * healthy lock and put two writers in one critical section — the same lost update by another
 * door, and not theoretical: the unlink-by-name this replaces put two holders in together in
 * 16 of 40 measured takeover storms.
 *
 * Both halves of the identity are compared, and each catches something the other cannot.
 *
 * The **bytes** catch a successor that landed on a *reused inode number*: the original was
 * unlinked and the filesystem handed its number to the successor's file. On ext4 that is not rare
 * but the normal case — measured on an ext4 Linux VM, an immediate successor got the old number
 * back 2000 times in 2000. The bytes can only tell the two apart because every acquisition writes
 * a nonce of its own after the pid (see `nonce`): with the pid alone, a successor carrying the
 * same pid matched on both halves there. Pinned in-suite on every filesystem by "every acquisition
 * writes bytes of its own", and on ext4 also by the successor cases of the release tests.
 *
 * The **inode** catches a successor whose bytes match exactly. Two acquisitions do not write the
 * same bytes, so the case that arises is a `corrupt` lock — whose bytes are whatever an outside
 * edit wrote, nonce-free — replaced by an identical one. Pinned in-suite — see "a takeover unlinks
 * the file it judged", and the exact-bytes case of "a holder whose lock was taken over"; dropping
 * it makes a waiter unlink a file it never read.
 *
 * The age needs no re-check — the same inode carries the same mtime, because nothing ever
 * rewrites a lock.
 *
 * Narrows, does not close. See the residual note at the top of this file, and do not chase
 * the two dead ends recorded there.
 */
function takeOver(lockFile, lock) {
  const now = readLock(lockFile);
  if (now.state === 'free') return;                            // someone else already cleared it
  if (now.ino !== lock.ino || now.raw !== lock.raw) return;     // a successor owns this name now
  removeLock(lockFile);
}

/**
 * Drop the lock on the way out of the critical section — ours, and only ours.
 *
 * Unconditional would be wrong for the same reason `takeOver` is guarded, one step later: a
 * holder whose lock had already been taken over (by an age-out, or by a `kill(0)` that
 * guessed wrong) would delete the *thief's* lock on its way out, handing the critical section
 * to a third writer and cascading one breach into two.
 *
 * Everything that is not a live foreign holder is still unlinked, and that narrowness is the
 * point. `free` has nothing to do. `corrupt` cannot be anyone's legitimate hold — nothing here
 * writes bytes that read that way — and an acquirer would take it over anyway. `unreadable` is
 * unlinked too, deliberately: we cannot prove it is ours, but we published this name and
 * nothing here is allowed to *steal* an unreadable lock, so leaving one behind wedges every
 * later acquire on a file only a person can clear. The one narrow case that gives up is an
 * unreadable *successor*, which needs a takeover and a chmod in the same instant.
 */
function releaseLock(lockFile, mine) {
  const now = readLock(lockFile);
  if (now.state === 'free') return;
  if (now.state === 'held' && (now.ino !== mine.ino || now.raw !== mine.raw)) return;
  removeLock(lockFile);
}

/**
 * Run `write`; if its parent dir is missing, create it and try exactly once more.
 *
 * A state root that has not been created yet — or was wiped from under a running fleet —
 * should cost one `mkdir`, not every acquire from here on. Costs nothing on the hot path: no
 * probe, just the error the first write returns. `dirMode` matters because one of these locks
 * lives in a directory that holds credentials and must not be recreated world-readable.
 */
function writeSelfHealing(fp, dirMode, write) {
  try {
    write();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    mkdirSync(dirname(fp), { recursive: true, ...(dirMode === undefined ? {} : { mode: dirMode }) });
    write();
  }
}

/**
 * Write the lock's bytes — the pid and this acquisition's nonce — to a fresh scratch file, and
 * return the inode it landed in.
 *
 * That inode and those bytes — not the path, and not the pid — are this acquisition's claim: the
 * inode is the one the lock *becomes* if the link lands, so the pair is what `releaseLock`
 * compares before it unlinks anything.
 *
 * Unlink-then-`O_EXCL` rather than a plain truncating open, for two reasons that pull the
 * same way. One of these locks lives in a directory soma does not own, so a symlink planted
 * at the scratch name must fail the open instead of routing a write somewhere of someone
 * else's choosing. And the unlink is what keeps `O_EXCL` from turning a freak name collision
 * — or a directory restored from a backup — into a permanently failing acquire.
 *
 * `fchmod` on the descriptor we hold rather than a `chmod` on the path, so there is no window
 * in which the file exists at a wider mode, and no path for a swap in between.
 */
function writeScratch(tmp, raw, mode) {
  dropScratch(tmp);
  const fd = openSync(tmp, 'wx', mode);
  try {
    if (mode !== undefined) fchmodSync(fd, mode);
    writeFileSync(fd, raw);
    return fstatSync(fd).ino;
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether an EEXIST-reporting `link` actually landed.
 *
 * On some network filesystems `link(2)` can report failure for a link it made, and this
 * returns from the acquire *before* the live-holder check — so it has to be proof, not a
 * guess. It is proof only because the scratch name is ours alone: fresh for this attempt and
 * derivable by nobody. While it was merely per-pid it was a hole rather than a belt, and
 * exactly on the deployment it exists for — on a shared state root, host B's pid 500 derives
 * host A's pid 500's scratch name, so a second name on that inode can be true of a lock we
 * never won.
 *
 * Three conditions, each carrying its own weight. `nlink === 2` says the inode gained a second
 * name; `scratch.ino === ino` says the file at our scratch path is still the file we wrote
 * (not one swapped in under us); and the lock path resolving to that same inode says the
 * second name it gained is *the lock* — which `nlink` alone does not, since a link made
 * anywhere else counts. Both paths are in one directory, so the inode number identifies the
 * file without the device.
 *
 * The inode compares are a belt on top of the count and never a substitute for the unguessable
 * name: against a foreign pre-linked scratch the inodes *do* match (measured), so on their own
 * they reopen that hole exactly.
 */
function linkLanded(lockFile, tmp, ino) {
  try {
    const scratch = statSync(tmp);
    return scratch.nlink === 2 && scratch.ino === ino && statSync(lockFile).ino === ino;
  } catch {
    return false;
  }
}

/**
 * One attempt at the lock: the claim if we hold it now, `null` to classify and try again.
 *
 * The scratch lives only across these few syscalls — written, linked, dropped — rather than
 * for the whole wait, which pays twice over. It keeps `linkLanded`'s proof honest, since the
 * name exists for less time than anyone could learn it. And it is what makes a never-reused
 * name affordable: a name no later run reclaims is a name a killed waiter strands for good,
 * and holding one across the wait meant *every* waiter killed mid-wait left one (measured 40
 * of 40, three runs of three). What the few killed inside the window leave is inert — nothing
 * ever reads a scratch, and no acquisition consults a name it did not just mint — but it is a
 * directory entry nothing collects.
 *
 * The `finally` covers the ways an attempt can fail as well as the way it succeeds — an
 * EEXIST we did not win, an EACCES on the link — so none of them leaves anything behind.
 *
 * The EEXIST test sits inside the `linkSync` catch and not around the whole block. Both the
 * scratch open and the link can report EEXIST, and they mean opposite things: from the link it
 * means the lock is contended, which is ordinary; from the scratch open it means a name that
 * should be ours alone already exists and we could not remove it, which is not something to
 * paper over by consulting `nlink` on a file we did not write. All three originals conflated
 * these.
 */
function tryAcquire({ lockFile, mintTmp, raw, mode, dirMode, label, hardLinks, key }) {
  const tmp = mintTmp();
  try {
    let claim = null;
    // Both calls sit inside the self-heal, so a state dir wiped from under a running fleet
    // costs one mkdir rather than every acquire from here on.
    writeSelfHealing(tmp, dirMode, () => {
      const ino = writeScratch(tmp, raw, mode);
      try {
        linkSync(tmp, lockFile);
        claim = { raw, ino };
      } catch (e) {
        if (e.code === 'EEXIST') {
          claim = linkLanded(lockFile, tmp, ino) ? { raw, ino } : null;
          return;
        }
        // Wrapped around this one call rather than the block: EPERM is in LINK_UNSUPPORTED,
        // and it is also what `removeLock` returns for a lock that is really a directory and
        // what the scratch open returns for a directory this process may not write (immutable
        // reports EPERM, mode-500 reports EACCES). Widening the catch would relabel all of
        // those as a filesystem without hard links.
        if (!LINK_UNSUPPORTED.has(e.code)) throw e;
        throw new Error(
          `${label}: ${val(hardLinks.requirement, key)} `
          + `(link(2) returned ${e.code} for ${lockFile}) — ${val(hardLinks.remedy, key)} `
          + `(exFAT/FAT and some FUSE or cloud-sync mounts do not support hard links)`,
          { cause: e },
        );
      }
    });
    return claim;
  } finally {
    // After a successful link this drops the second name from an inode the lock still holds;
    // after a failed one, a scratch file we turned out not to need.
    dropScratch(tmp);
  }
}

/**
 * Block until the lock is ours, or throw once the deadline has passed.
 *
 * The deadline bounds *every* branch, not just the wait-for-a-live-owner one: a takeover that
 * keeps losing the link race would otherwise loop with no end in sight. It is checked after
 * one attempt, so even `timeoutMs: 0` tries once before giving up.
 */
function acquire(ctx) {
  const { lockFile, label, timeoutMs, deadline, retryMs, staleMs } = ctx;
  for (;;) {
    const claim = tryAcquire(ctx);
    if (claim) return claim;

    if (Date.now() >= deadline) throw new Error(timeoutMessage(label, lockFile, timeoutMs));

    const lock = readLock(lockFile);
    if (lock.state === 'held') {
      // A crashed holder is taken over, and so is one whose pid has been recycled onto an
      // unrelated live process where the caller asked for that (`staleMs`). A holder that is
      // genuinely working is waited on, never stolen from.
      if (!pidAlive(lock.pid) || lock.ageMs >= staleMs) takeOver(lockFile, lock);
      else sleep(retryMs);
    } else if (lock.state === 'corrupt') {
      // Nothing here writes bytes that read this way — the link is what guarantees it — so it
      // is a hand-edit or a damaged filesystem, and clearing it is the only way off the wedge.
      // Still pay one backoff first: it costs a rare path one retry, and it means even a
      // hypothetical torn read has to stay torn to cost a live holder its lock.
      sleep(retryMs);
      takeOver(lockFile, lock);
    } else if (lock.state === 'unreadable') {
      // We cannot see who owns it, so we cannot know it is gone. Wait, and let the deadline
      // report it. The alternative is stealing a lock on the strength of an EACCES.
      sleep(retryMs);
    }
    // 'free': released between our link and this read. Retry at once — the link is the
    // test-and-set, so there is nothing to clean up and nothing to decide. This is the branch
    // the broken original unlinked on, and unlinking a path the filesystem has just said is
    // empty is how it deleted the lock of a holder that linked its own in between: *a missing
    // lock is not a stale lock*. Grafting a `sleep` and an `unlink` back on here — with the
    // link publish and both identity compares kept — brings two holders back into the
    // critical section in 3 of 8 runs of a 12-process probe.
  }
}

/**
 * A mutex over one file, or over a family of files named by a key.
 *
 * ```
 * const lock = createFileLock({
 *   api: 'withFleetLock',                       // the public name, for its TypeErrors
 *   label: 'fleet.lock',                        // message prefix; may be (key) => string
 *   lockFile: () => p('state', 'fleet.lock'),   // called per attempt: the state root moves
 *   hardLinks: { requirement, remedy },         // rule 8 — worded by the caller
 *   timeoutMs, retryMs, staleMs, mode, dirMode, reentrant,
 * });
 * lock.withLock(key, fn, { timeoutMs } | { deadline, timeoutMs });
 * ```
 *
 * `lockFile`, `label` and the two `hardLinks` fields may each be a function of `key`, and
 * `lockFile` should be one: the state root is read from the environment lazily and the tests
 * retarget it between calls, so a path captured at module load would be the wrong one. They are
 * evaluated **once per `withLock` call**, not once per attempt — the retry loop reuses what it
 * resolved on entry, so one acquisition cannot wander between two roots mid-wait.
 *
 * `staleMs` defaults to `Infinity`, and that default is the *safer of two bad options* rather
 * than a safe one. An age-out is a licence to steal a lock from a live pid, and shared across
 * callers it is simply wrong: one of these three locks is held across a `git fetch` of up to two
 * minutes, so any age-out short enough to help the others takes a working spawner's lock away
 * mid-fetch. But `Infinity` has its own cost, measured rather than assumed: a lock naming a
 * live-but-unrelated pid — a recycled pid, which is what `pretrust` sets `staleMs` for — is then
 * never reclaimed at any age, so every later acquire fails until a person deletes the file.
 * `Infinity` is chosen because a stolen lock is a silent lost update while a wedge is loud and
 * clearable, not because there is nothing to fix. The answer both callers that leave it unset
 * are waiting on is a per-caller bound set *above that caller's maximum legitimate hold*; see
 * the notes on their `createFileLock` calls.
 *
 * `reentrant` tracks the keys this instance holds so a nested acquire returns instead of
 * queueing behind itself, burning the whole timeout and throwing. Every acquisition here is
 * synchronous, so within one process "we already hold it" is exactly true: there is no await
 * between acquire and release for another caller to interleave into. It is also why `fn` may
 * not be async — see `refuseThenable`.
 */
export function createFileLock({
  api,
  label,
  lockFile,
  hardLinks,
  timeoutMs: defaultTimeoutMs,
  retryMs,
  staleMs = Infinity,
  mode,
  dirMode,
  reentrant = false,
}) {
  /**
   * The token half of the scratch name. Per instance, and random.
   *
   * The pid separates us from the other processes on this host; the serial separates this
   * attempt from our own last one, so a scratch stranded by a crash can neither be reused nor
   * believed; and the token separates us from the same pid on *another* host sharing one state
   * root over a network filesystem — which is the one deployment `linkLanded` exists for, and
   * the one where `<lock>.<pid>.tmp` is a name two hosts derive identically. A hostname would
   * not close that: containers on a shared mount routinely report the same one.
   */
  const token = randomBytes(4).toString('hex');
  /** Keys this instance already holds. Empty and unused when `reentrant` is false. */
  const held = new Set();

  return {
    withLock(key, fn, { timeoutMs = defaultTimeoutMs, deadline } = {}) {
      if (typeof fn !== 'function') throw new TypeError(`${api}: fn must be a function, got ${typeof fn}`);
      if (reentrant && held.has(key)) return refuseThenable(api, fn());

      const where = val(lockFile, key);
      const ctx = {
        key,
        lockFile: where,
        label: val(label, key),
        hardLinks,
        // Minted per attempt, by `tryAcquire`, exactly once — see rule 4. A function rather
        // than a value so the loop cannot accidentally reuse one attempt's name for the next.
        mintTmp: () => `${where}.${process.pid}.${token}.${++scratchSerial}.tmp`,
        // Our pid, then a nonce minted for this call, which is one acquisition, so no successor's
        // lock matches ours byte for byte, even on an inode number the file system handed back.
        // See `nonce`, and `takeOver` for what each half of the identity catches.
        raw: `${process.pid}\n${nonce()}\n`,
        mode,
        dirMode,
        // `deadline` is what bounds the wait; `timeoutMs` is only what the message reports.
        // They come apart for a caller whose budget spans several acquires — it passes the
        // whole-call deadline and the whole-call budget, so a refusal on its last attempt
        // still tells an operator how long soma actually waited.
        deadline: deadline ?? Date.now() + timeoutMs,
        timeoutMs,
        retryMs,
        staleMs,
      };

      const mine = acquire(ctx);
      if (reentrant) held.add(key);
      try {
        return refuseThenable(api, fn());
      } finally {
        if (reentrant) held.delete(key);
        releaseLock(where, mine);
      }
    },
  };
}
