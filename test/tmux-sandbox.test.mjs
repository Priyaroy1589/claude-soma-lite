import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { SOCKET_PATH_MAX, startSkip, tmuxSandbox } from './tmux-sandbox.mjs';

/**
 * `test/tmux-sandbox.mjs`, the short private TMUX_TMPDIR every real-tmux test file starts its
 * servers in, and issue #46's regression: those files, run under a long TMPDIR and a long
 * TMUX_TMPDIR. A Unix socket path is capped (104 bytes on macOS, 108 on Linux), so there one real-
 * tmux test failed on "File name too long", and six skipped as if the host had run out of ptys.
 */

const tmuxInstalled = spawnSync('tmux', ['-V']).status === 0;
const USER_DIR = `tmux-${process.getuid()}`;

/** A throwaway directory whose realpath is at least `bytes` long; its root goes when the test ends. */
const longDir = (t, bytes) => {
  const root = mkdtempSync(join(tmpdir(), 'tsb-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'l'.repeat(Math.max(1, bytes - Buffer.byteLength(realpathSync(root)) - 1)));
  mkdirSync(dir);
  return dir;
};

/** A box tmuxSandbox made, removed when the test ends. */
const keep = (t, box) => {
  if (box.dir) t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  return box;
};

test('tmuxSandbox makes a fresh private directory under the first base the socket path fits in, and says where the socket goes', (t) => {
  const base = mkdtempSync('/tmp/tsb-');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const box = keep(t, tmuxSandbox('soma-t12-4194304', { bases: [base, '/tmp'] }));
  assert.ok(box.dir, box.skip);
  assert.ok(box.dir.startsWith(`${realpathSync(base)}/`), `the first base fits, so the box is in it: ${box.dir}`);
  assert.equal(statSync(box.dir).mode & 0o777, 0o700, 'private: no other user may reach a socket in it');
  // The path tmux will bind: realpath(TMUX_TMPDIR)/tmux-<uid>/<name>, as tmux itself reports it.
  assert.equal(box.socket, join(realpathSync(box.dir), USER_DIR, 'soma-t12-4194304'));
  assert.ok(Buffer.byteLength(box.socket) <= SOCKET_PATH_MAX);
  // Fresh each time: two files' servers never share a directory.
  const again = keep(t, tmuxSandbox('soma-t12-4194304', { bases: [base] }));
  assert.notEqual(again.dir, box.dir);
});

test('tmuxSandbox passes over a base too long for the socket path, makes nothing in it, and falls back to /tmp', (t) => {
  const long = longDir(t, 100);
  const box = keep(t, tmuxSandbox('soma-absent-4194304', { bases: [long, '/tmp'] }));
  assert.ok(box.dir, box.skip);
  assert.ok(!box.dir.startsWith(realpathSync(long)), `a box under the long base would fail to bind: ${box.dir}`);
  assert.ok(box.dir.startsWith(`${realpathSync('/tmp')}/`), box.dir);
  assert.ok(Buffer.byteLength(box.socket) <= SOCKET_PATH_MAX, `${box.socket} is ${Buffer.byteLength(box.socket)} bytes`);
  assert.deepEqual(readdirSync(long), [], 'nothing was made under the long base');
  // A base that does not exist (a TMPDIR naming a deleted directory) is passed over the same way.
  const missing = keep(t, tmuxSandbox('soma', { bases: [join(long, 'gone'), '/tmp'] }));
  assert.ok(missing.dir?.startsWith(`${realpathSync('/tmp')}/`), missing.dir ?? missing.skip);
});

test(`tmuxSandbox takes a socket path of exactly ${SOCKET_PATH_MAX} bytes and refuses one byte more`, (t) => {
  const base = mkdtempSync('/tmp/tsb-');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  // mkdtemp adds six characters to the prefix; the rest of the path is fixed, and a slash precedes the name.
  const room = SOCKET_PATH_MAX - Buffer.byteLength(join(realpathSync(base), 'tx-XXXXXX', USER_DIR)) - 1;
  const fits = keep(t, tmuxSandbox('n'.repeat(room), { prefix: 'tx-', bases: [base] }));
  assert.equal(Buffer.byteLength(fits.socket ?? ''), SOCKET_PATH_MAX, fits.skip);
  const over = keep(t, tmuxSandbox('n'.repeat(room + 1), { prefix: 'tx-', bases: [base] }));
  assert.equal(over.dir, null);
  assert.match(over.skip, new RegExp(`\\(${SOCKET_PATH_MAX + 1} bytes\\)`));
});

test('tmuxSandbox, with no base short enough, makes nothing and names each path it tried with its length', (t) => {
  const a = longDir(t, 100);
  const b = longDir(t, 120);
  const box = tmuxSandbox('soma', { prefix: 'sw-', bases: [a, b] });
  assert.equal(box.dir, null);
  assert.equal(box.socket, undefined);
  for (const base of [a, b]) {
    const would = join(realpathSync(base), 'sw-XXXXXX', USER_DIR, 'soma');
    assert.ok(box.skip.includes(`${would} (${Buffer.byteLength(would)} bytes)`), box.skip);
    assert.deepEqual(readdirSync(base), [], `nothing made under ${base}`);
  }
});

test('startSkip names a socket path too long to bind, with its length, and keeps the pty wording for anything else', () => {
  const sock = '/private/var/folders/ab/cdefghijklmnopqrstuvwxyz0000gn/T/tmp.AbCdEfGhIj/st-AbCdEf/tmux-501/soma-absent-12345';
  for (const said of [
    `error connecting to ${sock} (File name too long)\n`,
    // newSession's throw carries the same words behind its own prefix
    `tmux new-session failed (1): error connecting to ${sock} (File name too long)`,
    // musl's strerror, on Alpine and the like, spells it as one word
    `error connecting to ${sock} (Filename too long)\n`,
  ]) {
    const why = startSkip(said, sock);
    assert.ok(why.includes(sock) && why.includes(`${Buffer.byteLength(sock)} bytes`), why);
    assert.match(why, /socket path/);
    assert.doesNotMatch(why, /could not start a session here/, 'a path that is too long is not a pty-exhausted host');
  }
  // Anything else is what these skips always said, tmux's own words included.
  assert.equal(startSkip('fork failed: Device not configured\n', sock), 'tmux could not start a session here: fork failed: Device not configured');
  assert.equal(startSkip('', sock), 'tmux could not start a session here');
  assert.equal(startSkip(undefined, sock), 'tmux could not start a session here');
});

/** The three files that start real tmux servers, by absolute path, and the repository they run from. */
const REAL_TMUX_FILES = ['soma-bus.smoke.test.mjs', 'tmux.test.mjs', 'wake-sockets.test.mjs']
  .map((f) => fileURLToPath(new URL(f, import.meta.url)));
const REPO = fileURLToPath(new URL('..', import.meta.url));

test('issue #46: the real-tmux test files neither fail nor skip under a long TMPDIR and a long TMUX_TMPDIR', { skip: !tmuxInstalled && 'tmux not installed' }, (t) => {
  // A host that cannot start a tmux server at all (pty-exhausted: "fork failed: Device not
  // configured") makes those files skip, rightly: that is the host, not its paths. So this asks
  // first, in a sandbox of its own, and skips with the same reason.
  const probe = tmuxSandbox('p', { prefix: 'tp-' });
  if (!probe.dir) return t.skip(probe.skip);
  const inProbe = { env: { ...process.env, TMUX_TMPDIR: probe.dir }, encoding: 'utf8', timeout: 10_000 };
  const up = spawnSync('tmux', ['-f', '/dev/null', '-L', 'p', 'new-session', '-d', 'cat'], inProbe);
  spawnSync('tmux', ['-L', 'p', 'kill-server'], inProbe);
  rmSync(probe.dir, { recursive: true, force: true });
  if (up.status !== 0) return t.skip(startSkip(up.stderr, probe.socket));

  // Long enough that no socket fits under either: realpath plus `/tmux-<uid>/<name>` is far past
  // 108 bytes, on macOS and on Linux.
  const env = { ...process.env, TMPDIR: longDir(t, 100), TMUX_TMPDIR: longDir(t, 100) };
  // NODE_TEST_CONTEXT is how the runner marks its own children: inherited, it makes the child report
  // to this process instead of running. SOMA_TEST_HOME would hand the child this process's state
  // root; without it, each file makes its own (soma-home.mjs). $TMUX names a server this suite may
  // be running inside.
  for (const k of ['NODE_TEST_CONTEXT', 'SOMA_TEST_HOME', 'TMUX', 'TMUX_PANE']) delete env[k];

  const started = Date.now();
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...REAL_TMUX_FILES],
    { env, cwd: REPO, encoding: 'utf8', timeout: 120_000 });
  const took = Date.now() - started;
  const lines = String(run.stdout ?? '').split('\n');
  const total = (key) => lines.find((l) => l.startsWith(`# ${key} `));
  const notOk = lines.filter((l) => /^not ok /.test(l));
  const skips = lines.filter((l) => /^ok .* # SKIP/.test(l));
  assert.equal(run.signal, null, `the child run was killed by ${run.signal} after ${took} ms`);
  // A failure, or a skip that blamed a start failure or named a socket path, is this issue back.
  // "tmux not installed" cannot happen here, and the files' other skips are not about tmux.
  assert.deepEqual(
    { fail: total('fail'), startSkips: skips.filter((l) => /could not start|socket path/.test(l)) },
    { fail: '# fail 0', startSkips: [] },
    `${notOk.join('\n')}\n${String(run.stderr ?? '').slice(-2000)}`);
  assert.notEqual(total('pass') ?? '# pass 0', '# pass 0', 'the files ran');
});
