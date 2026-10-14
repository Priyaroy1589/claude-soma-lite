/**
 * The inject hook's installer (`soma init --inject-hook`), and the one reading of whether a
 * Claude Code `settings.json` already runs it.
 *
 * `bin/hooks/orch-inject.mjs` staples unread event headers onto the lease holder's next prompt.
 * It lives in the config root's user `settings.json` as a `UserPromptSubmit` entry, and that is
 * why installing it is **opt-in** rather than a step of every `soma init`: a user-scope
 * UserPromptSubmit hook is a `node` spawn on every prompt of every session in that config root —
 * the orchestrator, every lead, every teammate and every unrelated project the operator opens —
 * and all but one of them exit having injected nothing. That cost is the operator's to accept.
 *
 * The command pins two things, for the reasons the bus registration pins them (`soma init`'s
 * `claude mcp add -e …`, and `soma up`'s watchdog argv):
 *
 * - **`SOMA_HOME`**, because a session's environment does not carry it. An unpinned hook does not
 *   stay undecided, it decides the default root — an empty fleet, which injects nothing and
 *   errors nowhere. That is the silent failure the bus's own pin was added for.
 * - **The absolute `node`**, the interpreter running `soma init`: `engines.node` is >=24, and
 *   `node` off a session's PATH is whatever nvm last selected.
 *
 * And it never overwrites bytes it cannot read. `settings.json` is the operator's file — their
 * model, their permissions, their other hooks — so anything this module cannot parse into an
 * object it can extend is a refusal that leaves the file untouched, never a fresh `{}` written
 * over it. Only a file that does not exist starts from nothing — a symlink to a missing file is
 * there, and is refused like the rest.
 */
import {
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * The hook script, absolute and forward-slashed: `/bin/sh` runs the command from whatever cwd a
 * session has, so a relative path resolves somewhere else. `fileURLToPath`, not `.pathname`, for
 * settings-gen's reason — an install under `~/My Repos/` would come out as `My%20Repos`.
 */
export const INJECT_HOOK = fileURLToPath(new URL('../hooks/orch-inject.mjs', import.meta.url)).replaceAll('\\', '/');

/** Quote one word for `/bin/sh` — the house idiom (`tmux.shQuote`, settings-gen's `shq`). */
const shq = (word) => `'${String(word).replaceAll("'", "'\\''")}'`;

/** A value with own keys worth walking. Arrays and null are not. */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The predicate `soma init` has always used: the entry is ours when its command names the script. */
const INJECT_RE = /orch-inject\.mjs/;

/** The hook command, pinned to `root` and to `node`. */
export function injectCommand(root, node = process.execPath) {
  return `SOMA_HOME=${shq(root)} ${shq(node)} ${shq(INJECT_HOOK)}`;
}

/**
 * Which state root a hook command pins: `this`, `other`, or `none`.
 *
 * `this` only for a spelling `/bin/sh` reads back as exactly `root` — the quoted form
 * `injectCommand` writes, the bare form the README's hand-wired example used (when `root` needs
 * no quoting), or double quotes — and only as a whole word, so `/x/soma` does not match a pin on
 * `/x/soma2`.
 */
const pinOf = (command, root) => {
  const names = (word) => {
    const needle = `SOMA_HOME=${word}`;
    for (let i = command.indexOf(needle); i !== -1; i = command.indexOf(needle, i + 1)) {
      if (/^[\s;&|(]?$/.test(command[i - 1] ?? '') && /^[\s;&|)]?$/.test(command[i + needle.length] ?? '')) return true;
    }
    return false;
  };
  const r = String(root);
  const spellings = [shq(r)];
  if (/^[\w./+,:@%-]+$/.test(r)) spellings.push(r);
  if (!/["$`\\]/.test(r)) spellings.push(`"${r}"`);
  if (spellings.some(names)) return 'this';
  return /(?:^|[\s;&|(])SOMA_HOME=/.test(command) ? 'other' : 'none';
};

/**
 * Does `settings` (a parsed `settings.json`) run the inject hook, and on which root?
 * `{ wired: false }` | `{ wired: true, pins: 'this' | 'other' | 'none' }`; the first matching
 * command decides the pin. Never throws: only a hand-built object can make the walk throw, and a
 * value that cannot even be read is not a hook command.
 */
export function inspectInject(settings, root) {
  try {
    const entries = settings?.hooks?.UserPromptSubmit;
    if (!Array.isArray(entries)) return { wired: false };
    for (const e of entries) {
      if (!Array.isArray(e?.hooks)) continue;
      for (const h of e.hooks) {
        const command = String(h?.command ?? '');
        if (INJECT_RE.test(command)) return { wired: true, pins: pinOf(command, root) };
      }
    }
  } catch { /* see above */ }
  return { wired: false };
}

/**
 * Register the hook in `settingsPath`, or say why not:
 * `{ ok: true, action: 'added' | 'present', pins }` | `{ ok: false, error }`.
 *
 * Already wired is `present`, and the file is not rewritten: a hand-wired entry is the operator's,
 * and `pins` says whether it reads this root. Otherwise one entry is appended to
 * `hooks.UserPromptSubmit`, every other key and entry kept in order, and the file is published
 * tmp+rename — a session reading settings mid-write sees the old file or the new one, never half.
 *
 * Errors carry an errno, never the error's own message: fs messages name the path they failed on,
 * and the tmp file and the parent directory are paths the operator did not ask about.
 */
export function installInjectHook({ settingsPath, root, node = process.execPath }) {
  const refuse = (why) => ({ ok: false, error: `${settingsPath} ${why}, so it was left untouched` });
  let raw = null;
  try {
    raw = readFileSync(settingsPath, 'utf8');
  } catch (e) {
    if (e?.code !== 'ENOENT') return refuse(`could not be read (${e?.code ?? 'unknown error'})`);
    // ENOENT is also what a DANGLING symlink reads as: a dotfiles link whose target is not there
    // (yet). That is not a file that does not exist — the link is the operator's, and the rename
    // below would replace it with a regular file, cutting settings off from wherever it points.
    // `lstat` sees the link itself. Its target is not named: the operator asked about one path.
    let link = false;
    try {
      link = lstatSync(settingsPath).isSymbolicLink();
    } catch { /* nothing at the path at all: a settings.json that does not exist yet */ }
    if (link) return refuse('is a symlink to a missing file');
  }
  let settings = {};
  if (raw !== null) {
    try {
      settings = JSON.parse(raw);
    } catch {
      return refuse('is not valid JSON');
    }
  }
  if (!isObject(settings)) return refuse('does not hold a JSON object');
  if (settings.hooks !== undefined && !isObject(settings.hooks)) return refuse('has a "hooks" that is not an object');
  const entries = settings.hooks?.UserPromptSubmit;
  if (entries !== undefined && !Array.isArray(entries)) return refuse('has a "hooks.UserPromptSubmit" that is not an array');

  const seen = inspectInject(settings, root);
  if (seen.wired) return { ok: true, action: 'present', pins: seen.pins };

  settings.hooks ??= {};
  settings.hooks.UserPromptSubmit = [...(entries ?? []), { hooks: [{ type: 'command', command: injectCommand(root, node) }] }];
  let tmp = null;
  try {
    let target = settingsPath;
    let mode = 0o600;
    if (raw === null) {
      mkdirSync(dirname(settingsPath), { recursive: true });
    } else {
      // The file stays the operator's in two more ways than its keys. A symlinked settings.json (a
      // dotfiles checkout) is published at its target, so the link survives the rename. And the
      // new file keeps the old one's permission bits: settings can carry `env` secrets, and a
      // scratch file born under the umask would turn a 0600 file into a 0644 one at the rename.
      target = realpathSync(settingsPath);
      mode = statSync(target).mode & 0o777;
    }
    tmp = `${target}.${process.pid}.tmp`;
    // `pretrust.writeAtomic`'s defence, for the same reason: the scratch name is predictable and the
    // file it receives is the operator's settings, `env` secrets included. So anything already at
    // the name is hostile, not ours to reuse: unlink it (a symlink itself, never its target), then
    // create with O_EXCL, so a symlink re-planted in that gap fails the open instead of being
    // followed. fchmod, not chmod: it sets the bits on the inode we hold, whatever the umask did.
    unlinkIfPresent(tmp);
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      fchmodSync(fd, mode);
      writeFileSync(fd, `${JSON.stringify(settings, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch (e) {
    if (tmp !== null) unlinkIfPresent(tmp);
    return { ok: false, error: `${settingsPath} could not be written (${e?.code ?? 'unknown error'}); nothing was registered` };
  }
  return { ok: true, action: 'added', pins: 'this' };
}

/** Remove `fp` when something is there — a symlink itself, never its target. Never throws. */
function unlinkIfPresent(fp) {
  try {
    unlinkSync(fp);
  } catch {
    /* not there, or already gone */
  }
}
