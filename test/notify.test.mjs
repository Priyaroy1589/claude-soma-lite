import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The module under test, freshly instantiated (it holds no state, but keeps the fresh-import idiom). */
const load = (tag) => import('../bin/lib/notify.mjs?' + tag);
const MODULE = new URL('../bin/lib/notify.mjs', import.meta.url).href;

/** Records the (cmd, args, opts) a notify call produces instead of firing one. */
const recorder = () => {
  const calls = [];
  return { calls, run: (cmd, args, opts) => calls.push({ cmd, args, opts }) };
};

/** A throwaway directory for this test's fixtures. */
const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'soma-notify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A stand-in /proc/version — the seam that lets a Mac drive the WSL branch. */
const procVersionFile = (t, contents) => {
  const path = join(scratch(t), 'version');
  writeFileSync(path, contents);
  return path;
};

/**
 * Pin process.platform for one test. It is an ordinary own property and
 * os.platform() returns it, so this is what lets a single host exercise all
 * three branches; the original descriptor is restored verbatim.
 */
const withPlatform = (t, platform) => {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...desc, value: platform });
  t.after(() => Object.defineProperty(process, 'platform', desc));
};

/** Pin environment variables for one test; `undefined` means "unset". */
const withEnv = (t, patch) => {
  const prior = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
  const apply = (o) => {
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply(patch);
  t.after(() => apply(prior));
};

/** Everything a Linux-branch test needs: platform pinned, and demonstrably not WSL. */
const asLinux = (t, env = {}) => {
  withPlatform(t, 'linux');
  withEnv(t, {
    SOMA_PROC_VERSION_TESTONLY: procVersionFile(t, 'Linux version 6.8.0-45-generic (buildd@lcy02) #45-Ubuntu\n'),
    ...env,
  });
};

// --- the original test, verbatim: whatever host this runs on, one command is chosen ---

test('notify picks the platform command', async () => {
  const n = await import('../bin/lib/notify.mjs?' + Date.now());
  const calls = [];
  const run = (cmd, args) => calls.push({ cmd, args });
  n.notify('soma', 'hi', run);
  assert.equal(calls.length, 1);
  assert.ok(['osascript', 'notify-send', 'powershell.exe'].includes(calls[0].cmd));
  assert.ok(calls[0].args.join(' ').includes('hi'));
});

// --- the three branches, pinned one at a time ---

test('darwin sends one osascript -e script', async (t) => {
  withPlatform(t, 'darwin');
  const n = await load('darwin');
  const { calls, run } = recorder();
  n.notify('soma', 'task-1 NEEDS_INPUT', run);
  assert.deepEqual(calls, [{
    cmd: 'osascript',
    args: ['-e', 'display notification "task-1 NEEDS_INPUT" with title "soma"'],
    opts: undefined,
  }]);
});

test('linux sends notify-send, app-named, with options terminated', async (t) => {
  // `--` for the reason sendKeys has one: GOption reads a body starting with
  // `-` as a flag, and the toast dies as a usage error nobody sees.
  asLinux(t, { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' });
  const n = await load('linux');
  const { calls, run } = recorder();
  n.notify('soma', '-task-1 ERROR', run);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'notify-send');
  assert.deepEqual(calls[0].args, ['-a', 'soma', '--', 'soma', '-task-1 ERROR']);
});

test('WSL sends a powershell.exe WinRT toast, not notify-send', async (t) => {
  withPlatform(t, 'linux');
  withEnv(t, {
    SOMA_PROC_VERSION_TESTONLY: procVersionFile(t, 'Linux version 5.15.167.4-microsoft-standard-WSL2 (root@build) #1 SMP\n'),
  });
  const n = await load('wsl');
  const { calls, run } = recorder();
  n.notify('soma', 'task-1 COMPLETED', run);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'powershell.exe');            // never pwsh: WinRT is unreliable in 7.x
  assert.equal(calls[0].args[0], '-NoProfile');
  assert.equal(calls[0].args[1], '-Command');
  const script = calls[0].args[2];
  assert.match(script, /ToastNotificationManager,Windows\.UI\.Notifications,ContentType=WindowsRuntime/);
  assert.match(script, /GetTemplateContent\(0\)/);
  assert.ok(script.includes("CreateTextNode('soma: task-1 COMPLETED')"), script);
  assert.match(script, /CreateToastNotifier\('soma'\)\.Show\(/);
});

// --- the sniff that decides between those last two ---

test('isWSL is a guarded /proc/version sniff', async (t) => {
  const n = await load('sniff');
  const check = (contents) => {
    const priorPath = process.env.SOMA_PROC_VERSION_TESTONLY;
    process.env.SOMA_PROC_VERSION_TESTONLY = procVersionFile(t, contents);
    try { return n.isWSL(); } finally { process.env.SOMA_PROC_VERSION_TESTONLY = priorPath; }
  };
  withEnv(t, { SOMA_PROC_VERSION_TESTONLY: undefined });

  assert.equal(check('Linux version 5.15.167.4-microsoft-standard-WSL2 (root@build)\n'), true);
  assert.equal(check('Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com)\n'), true);   // WSL1's casing
  assert.equal(check('Linux version 6.8.0-45-generic (buildd@lcy02) #45-Ubuntu SMP\n'), false);

  // Absent, and unreadable-because-it-is-a-directory: both are answers, not throws.
  process.env.SOMA_PROC_VERSION_TESTONLY = join(scratch(t), 'nothing-here');
  assert.equal(n.isWSL(), false);
  const dir = join(scratch(t), 'proc');
  mkdirSync(dir);
  process.env.SOMA_PROC_VERSION_TESTONLY = dir;
  assert.equal(n.isWSL(), false);

  // And on this host, whatever it is, the contract is a boolean.
  delete process.env.SOMA_PROC_VERSION_TESTONLY;
  assert.equal(typeof n.isWSL(), 'boolean');
});

// --- escaping: a lead's summary is untrusted text going into two script languages ---

test('an AppleScript body cannot break out of its literal', async (t) => {
  withPlatform(t, 'darwin');
  const n = await load('osa-escape');
  const script = (body) => {
    const { calls, run } = recorder();
    n.notify('soma', body, run);
    return calls[0].args[1];
  };

  // A trailing backslash is the one that bites: unescaped, `"oops\"` makes the
  // closing quote literal and osascript refuses to compile (error -2740), so
  // the operator never hears about the event.
  assert.equal(script('oops\\'), 'display notification "oops\\\\" with title "soma"');
  assert.equal(script('C:\\Users\\x'), 'display notification "C:\\\\Users\\\\x" with title "soma"');
  // Quotes become apostrophes — which cannot open an AppleScript string, so
  // there is no way to append `& (do shell script "…")`.
  assert.equal(script('he said "no"'), `display notification "he said 'no'" with title "soma"`);
  // Newlines and tabs collapse: a toast is one line on every platform.
  assert.equal(script('line1\nline2\tthird'), 'display notification "line1 line2 third" with title "soma"');
  // Control characters go with them — a NUL arriving through a JSON payload
  // would otherwise make spawn reject the whole argument vector.
  assert.equal(script('a\u0000b\u001bc'), 'display notification "a b c" with title "soma"');
  // The title travels the same path.
  const { calls, run } = recorder();
  n.notify('soma "prod"', 'x', run);
  assert.equal(calls[0].args[1], `display notification "x" with title "soma 'prod'"`);
});

test('a PowerShell body cannot close its single-quoted string', async (t) => {
  withPlatform(t, 'linux');
  withEnv(t, { SOMA_PROC_VERSION_TESTONLY: procVersionFile(t, 'Linux microsoft-standard-WSL2\n') });
  const n = await load('ps-escape');
  const script = (body) => {
    const { calls, run } = recorder();
    n.notify('soma', body, run);
    return calls[0].args[2];
  };

  /**
   * The invariant, stated directly: inside the literal every run of
   * single-quote-class characters is even, so none of them can be the one that
   * terminates it. The class is not just U+0027 — PowerShell's tokenizer also
   * opens and closes a single-quoted string on U+2018, U+2019, U+201A and
   * U+201B, so an ASCII-only /'+/ here passes *vacuously* on a smart-quoted
   * payload (zero matches, zero assertions).
   *
   * The literal is sliced between fixed delimiters rather than matched, so a
   * body that happens to contain `')) > $null` cannot fool the extraction.
   */
  const PS_SQUOTE = /['\u2018\u2019\u201A\u201B]+/g;
  const stillClosed = (body) => {
    const s = script(body);
    const opens = "CreateTextNode('";
    const inner = s.slice(s.indexOf(opens) + opens.length, s.lastIndexOf("')) > $null"));
    for (const quotes of inner.match(PS_SQUOTE) ?? []) {
      assert.equal(quotes.length % 2, 0, `odd quote run (${quotes.length}) would close the literal: ${inner}`);
    }
    return s;
  };

  // An apostrophe is ordinary English ("couldn't") and would end the string
  // mid-word; doubling is PowerShell's own escape.
  assert.ok(stillClosed("couldn't finish").includes("CreateTextNode('soma: couldn''t finish')"));
  // A crafted body tries to end it on purpose. Every quote is doubled, so the
  // string never closes and `iex` stays text. (The three quotes before `))` are
  // the body's escaped pair plus the literal's own closing quote.)
  const injected = stillClosed("x'); iex('calc'); ('");
  assert.ok(injected.includes("CreateTextNode('soma: x''); iex(''calc''); (''')"), injected);

  // The same two bodies as an LLM summary or a Jira title actually writes them —
  // U+2019 for the apostrophe, U+2018/U+2019 for the quotes. These are string
  // delimiters to PowerShell too, so unescaped the first breaks the toast and
  // the second runs `iex`.
  assert.ok(stillClosed('couldn\u2019t finish').includes("CreateTextNode('soma: couldn''t finish')"));
  stillClosed('x\u2019)); iex(\u2018calc\u2019); ((\u2018');
  // No member of either Unicode class survives the fold at all — which is what
  // makes a mixed-class pair (an ASCII quote beside a smart one, straddling the
  // escape) impossible to construct rather than merely unlikely.
  const SMART = '\u2018\u2019\u201A\u201B\u201C\u201D\u201E';
  assert.equal(/[\u2018\u2019\u201A\u201B\u201C\u201D\u201E]/.test(script(`q${SMART}q`)), false);
  // And not one double quote in the whole command: powershell.exe is reached
  // through WSL interop, which rebuilds a Windows command line, and `"` is the
  // character that mangles.
  assert.equal(script('he said "no"').includes('"'), false);
});

test('[darwin] every generated osascript command really compiles, and the body survives as data', async (t) => {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/osacompile')) {
    t.skip('needs macOS osacompile');
    return;
  }
  const dir = scratch(t);
  const pwned = join(dir, 'pwned');
  const n = await load('osa-real');
  const bodies = [
    'task-1 NEEDS_INPUT: which base branch?',
    'he said "no" then left',
    "it's fine",
    'C:\\Users\\x\\',                                              // trailing backslash: the -2740 case
    'regex \\d+ and \\\\ both',
    'line1\nline2\ttabbed',
    'unicode café ✅ 🚀',                                          // compile-only: osascript's stdout escapes non-ASCII
    `x\\" & (do shell script "touch ${pwned}") & \\"`,             // an attempt to leave the literal
    'A'.repeat(2000),                                              // a body at the bus's summary cap
  ];

  bodies.forEach((body, i) => {
    const { calls, run } = recorder();
    n.notify('soma', body, run);
    const script = calls[0].args[1];

    // osacompile parses without executing: no notification is ever posted here.
    const out = join(dir, `probe-${i}.scpt`);
    try {
      execFileSync('/usr/bin/osacompile', ['-e', script, '-o', out], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    } catch (e) {
      assert.fail(`osacompile rejected body #${i} (${JSON.stringify(body).slice(0, 60)}): ${(e.stderr || e.message).trim()}\n  ${script}`);
    }

    // ...and the value AppleScript ends up holding is exactly what we escaped:
    // `return` evaluates the literal without displaying anything.
    const [, escaped] = /^display notification "(.*)" with title "(.*)"$/.exec(script);
    if (/^[\x20-\x7e]*$/.test(escaped)) {
      const seen = execFileSync('/usr/bin/osascript', ['-e', `return "${escaped}"`], { encoding: 'utf8' }).replace(/\n$/, '');
      assert.equal(seen, escaped.replaceAll('\\\\', '\\'), `body #${i} did not round-trip`);
      assert.equal(seen.includes('"'), false);
    }
  });

  // The injection payload ran as text, not as AppleScript.
  assert.equal(existsSync(pwned), false, 'a body escaped its literal and executed');
});

// --- the two promises the callers actually depend on ---

test('notify never throws, whatever it is handed', async (t) => {
  withPlatform(t, 'darwin');
  const n = await load('never-throws');
  // A dep that blows up (a stubbed run in a test, a transport that rejects).
  assert.doesNotThrow(() => n.notify('soma', 'x', () => { throw new Error('boom'); }));
  // A caller that passes something that is not callable at all.
  assert.doesNotThrow(() => n.notify('soma', 'x', 42));
  // A body that refuses to become a string.
  assert.doesNotThrow(() => n.notify('soma', { toString() { throw new Error('nope'); } }, () => {}));
  // Nothing at all: a toast, not the word "undefined".
  const { calls, run } = recorder();
  n.notify('soma', undefined, run);
  assert.equal(calls[0].args[1], 'display notification "" with title "soma"');
});

/**
 * Notify with the default `run` in a throwaway child process.
 *
 * PATH has to be handed to the child at *startup*, not assigned inside it:
 * libuv resolves an executable with posix_spawnp on macOS, which reads the
 * environment the process began with, so a runtime `process.env.PATH = …`
 * silently resolves nothing and the child exits 127 with no 'error' event
 * (measured). Returns how long the caller was held.
 */
const notifyInChild = (t, { path, procVersion, body }) => {
  const script = `
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { notify } = await import(${JSON.stringify(MODULE)});
    notify('soma', ${JSON.stringify(body)});
  `;
  const started = Date.now();
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      timeout: 20_000,
      encoding: 'utf8',
      env: { PATH: path, SOMA_PROC_VERSION_TESTONLY: procVersion },
    });
  } catch (e) {
    // A timeout is not an exit code, and conflating the two made the caller's own
    // `waited < 5000` assertion UNFAILABLE — measured. The fake notifier sleeps 30s,
    // which is longer than the timeout above, so a caller that IS held open never
    // returns here at all: both mutations of the property that assertion names
    // (dropping `unref`, and `stdio: 'pipe'`) used to fail as
    // `spawnSync … ETIMEDOUT` from this line, 20s in, and the assertion that says
    // what actually went wrong was never reached. A sibling guard absorbing the
    // failure of the one it sits next to is the same defect class as the audit this
    // change came out of. So: hand the elapsed time back and let the caller judge it.
    if (e.code === 'ETIMEDOUT') return Date.now() - started;
    // Anything else IS an exit code, and it is the failure this proves absent: an
    // unhandled 'error' event on the spawned notifier would end the process, not
    // just the toast.
    assert.fail(`the notifying child exited nonzero: ${(e.stderr || e.message).trim()}`);
  }
  return Date.now() - started;
};

test('the default run swallows a missing notifier binary', async (t) => {
  // notify-send absent is the ordinary state of a headless Linux box: ENOENT
  // arrives as an event, and unhandled it would end the watchdog rather than
  // just losing a toast.
  const dir = scratch(t);
  const procVersion = join(dir, 'version');
  writeFileSync(procVersion, 'Linux version 6.8.0-45-generic\n');
  notifyInChild(t, { path: join(dir, 'no-binaries-here'), procVersion, body: 'nobody is listening' });

  // And in-process, for the same reason, on whatever this host is.
  asLinux(t, { PATH: join(scratch(t), 'empty-bin') });
  const n = await load('enoent');
  assert.doesNotThrow(() => n.notify('soma', 'nobody is listening'));
});

test('the default run is fire-and-forget: a slow notifier does not hold the caller open', async (t) => {
  const dir = scratch(t);
  const marker = join(dir, 'invoked');
  const procVersion = join(dir, 'version');
  writeFileSync(procVersion, 'Linux version 6.8.0-45-generic\n');
  // `: >` is a shell builtin, so the marker lands before PATH matters; sleep is
  // the only external, and this PATH holds nothing but the fake itself.
  writeFileSync(join(dir, 'notify-send'), `#!/bin/sh\n: > "${marker}"\nPATH=/usr/bin:/bin sleep 30\n`, { mode: 0o755 });

  // A child process, because what is under test is when *this* process would be
  // free to exit. execFile would pipe the notifier's stdio and wait out all
  // thirty seconds; spawn + stdio:'ignore' + unref does not.
  const waited = notifyInChild(t, { path: dir, procVersion, body: 'a notifier that sleeps' });
  assert.ok(waited < 5000, `the caller waited ${waited}ms for a notifier that sleeps 30s`);

  // ...and it really did spawn one, or the timing above proves nothing: a notifier that
  // was never spawned also never held anyone open, so without this the assertion above
  // is satisfied vacuously.
  //
  // WHY THE DEADLINE IS 60s AND NOT 5s, MEASURED — do not go looking for a bug in
  // `notify.mjs` if you see this fail. 48 whole-suite runs at 8-way oversubscription on
  // an 18-core machine: `v1-build` (523 tests) failed 0 of 48; `t28` (270 tests) failed
  // 8 of 48, every failure this assertion, every one `no notifier was spawned at all`.
  // Failing runs took 5417ms and passing runs 2316ms, so the failures EXHAUSTED the old
  // 5s poll rather than missing a single check. `bin/lib/notify.mjs` and this file are
  // BYTE-IDENTICAL between those two trees (compared as blob hashes, not by eye), so the
  // code is not the variable — suite composition and process contention are. Nor is
  // `v1-build`'s 0-of-48 a clearance: with identical code the race is latent there too
  // and simply did not surface.
  //
  // The raised ceiling costs nothing on the healthy path, because the loop returns the
  // moment the marker appears. It is only ever paid when the marker genuinely never
  // arrives — and that case has to fail loudly rather than quickly. A deadline short
  // enough to be comfortable is a flake; an assertion that tolerated a missing marker
  // would be an assertion that cannot fail, which is the worse defect of the two.
  //
  // Note what is under load here: after the caller exits, the detached `/bin/sh` has to
  // be scheduled before it can run even a builtin. That is why this assertion is exposed
  // and `waited < 5000` above is not — that one measures node's own startup, which has
  // 30x headroom against the 30s it is excluding.
  const deadline = Date.now() + 60_000;
  const polling = Date.now();
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert.ok(existsSync(marker),
    `no notifier was spawned at all: the caller returned in ${waited}ms and no marker appeared in the ${Date.now() - polling}ms after it`);
});

// --- the Linux-only wrinkle: a detached daemon has no session bus ---

test('notify-send is handed a session bus when the environment has none', async (t) => {
  const n = await load('dbus');
  const optsFor = () => {
    const { calls, run } = recorder();
    n.notify('soma', 'hi', run);
    return calls[0].opts;
  };

  // The watchdog is spawned `env -i` inside tmux, so this is its normal state:
  // without an address libnotify autolaunches over X11 and the toast vanishes
  // with exit 0.
  asLinux(t, { DBUS_SESSION_BUS_ADDRESS: undefined, XDG_RUNTIME_DIR: '/run/user/4242' });
  assert.equal(optsFor().env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/4242/bus');
  assert.equal(optsFor().env.PATH, process.env.PATH, 'the rest of the environment must survive');

  // No XDG_RUNTIME_DIR either: fall back to the standard per-user socket.
  delete process.env.XDG_RUNTIME_DIR;
  assert.equal(optsFor().env.DBUS_SESSION_BUS_ADDRESS, `unix:path=/run/user/${process.getuid()}/bus`);

  // A real address always wins, and nothing is overridden.
  process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/run/user/1000/bus';
  assert.equal(optsFor(), undefined);
});

// --- hygiene: a toast is a glance ---

test('a runaway summary is clamped to one glanceable line', async (t) => {
  withPlatform(t, 'darwin');
  const n = await load('clamp');
  const { calls, run } = recorder();
  n.notify('soma', `start ${'x'.repeat(5000)} end`, run);
  const [, body] = /^display notification "(.*)" with title "(.*)"$/.exec(calls[0].args[1]);
  assert.ok(body.length <= 300, `body was ${body.length} chars`);
  assert.ok(body.startsWith('start x'));
  assert.ok(body.endsWith('...'));
});
