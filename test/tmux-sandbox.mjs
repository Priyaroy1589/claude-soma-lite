/**
 * A private, short TMUX_TMPDIR for a test file that starts real tmux servers.
 *
 * Not a test file: the `test/**\/*.test.mjs` glob skips it, and so does soma-home.test.mjs's
 * first-import pin. `tmux-sandbox.test.mjs` tests it.
 *
 * PRIVATE. tmux keeps each server's socket at `realpath($TMUX_TMPDIR)/tmux-<uid>/<socket name>`,
 * under `/tmp` when TMUX_TMPDIR is unset, which is where every live tmux server on the machine
 * lives, a fleet's `soma` included. In a fresh directory of its own, no socket name a test uses,
 * `soma` included, can reach one of them.
 *
 * SHORT. A Unix socket path is capped: 104 bytes on macOS and 108 on Linux, the NUL included, and
 * tmux measures the realpath (`/var/folders/…` on macOS is `/private/var/folders/…`). Past the cap
 * tmux says `error connecting to <path> (File name too long)`. Under a long TMPDIR one real-tmux
 * test failed on that, and under a long TMUX_TMPDIR six skipped as if the host had run out of
 * ptys (issue #46). So the directory goes under the system temp dir only when the socket path fits
 * there, and under `/tmp`, short on every platform, otherwise.
 *
 * WHAT THE CALLER MUST DO. Point TMUX_TMPDIR at the directory before its first tmux call: each
 * tmux child reads it from the inherited environment. Keep it until after the last one, because
 * tmux reads a TMUX_TMPDIR that does not exist as unset and goes to `/tmp` without a word: kill the
 * servers first, then remove the directory. And pass `-f /dev/null` on the call that starts a
 * server, the only call that reads a config: the operator's tmux.conf may load plugins that save
 * and restore sessions.
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

/** The longest socket path a sandbox allows, in bytes: macOS takes 103 and Linux 107, so a few spare. */
export const SOCKET_PATH_MAX = 100;

/**
 * A fresh, private directory for TMUX_TMPDIR in which tmux can bind a socket named `longest`, the
 * longest socket name the caller will use. `bases` are tried in order; the tests inject theirs.
 *
 * Returns `{ dir, socket }`, `socket` being the path tmux will give `longest` there. When no base
 * leaves room it makes nothing and returns `{ dir: null, skip }`: the reason the caller skips with,
 * naming each path it would have made and that path's length.
 */
export function tmuxSandbox(longest, { prefix = 'tx-', bases = [tmpdir(), '/tmp'] } = {}) {
  const userDir = `tmux-${process.getuid()}`;
  const tried = [];
  for (const base of bases) {
    let real;
    try {
      real = realpathSync(base);
    } catch (e) {
      tried.push(`${base} (${e.code})`);
      continue;
    }
    // Measured before anything is made: mkdtemp adds six characters to the prefix.
    const would = join(real, `${prefix}XXXXXX`, userDir, longest);
    const bytes = Buffer.byteLength(would);
    if (bytes > SOCKET_PATH_MAX) {
      tried.push(`${would} (${bytes} bytes)`);
      continue;
    }
    const dir = mkdtempSync(join(real, prefix));
    return { dir, socket: join(dir, userDir, longest) };
  }
  return { dir: null, skip: `no temp directory leaves room for a tmux socket path of at most ${SOCKET_PATH_MAX} bytes: ${tried.join('; ')}` };
}

/**
 * The skip reason for a tmux that could not start a server: from what it said (its stderr, or an
 * error message that carries it) and the socket path it was started on.
 *
 * A socket path too long to bind is named, with its length: the paths are wrong, not the host, and
 * a skip that blamed the host hid every real-tmux test that never ran (issue #46). Anything else
 * keeps the wording these skips always had. Its usual cause is a pty-exhausted host ("fork failed:
 * Device not configured"), an OS limit and not a regression, so not a reason to fail the build.
 */
export function startSkip(said, socket) {
  const text = String(said ?? '').trim();
  // ENAMETOOLONG in strerror's words: "File name too long" on glibc and macOS, "Filename" on musl.
  if (/File ?name too long/.test(text)) {
    return `tmux's socket path is too long to bind: ${socket} is ${Buffer.byteLength(socket)} bytes (tmux said: ${text})`;
  }
  return text ? `tmux could not start a session here: ${text}` : 'tmux could not start a session here';
}
