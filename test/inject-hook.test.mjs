/**
 * `bin/lib/inject-hook.mjs` and `soma init --inject-hook`: the opt-in installer for the
 * UserPromptSubmit hook (`orch-inject.mjs`) that staples unread fleet events onto the lease
 * holder's next prompt.
 *
 * Until this existed nothing registered that hook. `soma init` only OBSERVED whether somebody had
 * wired it by hand, and an orchestrator nobody had wired heard about a lead's NEEDS_INPUT only when
 * it thought to ask. The installer writes the operator's own Claude Code `settings.json`, which
 * every session on the machine reads, so the rules pinned here are the ones that keep that safe:
 * it is opt-in; it refuses any file it cannot extend without loss, leaving the bytes alone; it
 * never rewrites a file that already carries the hook; it appends rather than replaces; it
 * publishes by rename; and it pins the fleet's state root into the command, because a hook
 * without the pin reads `~/.soma`.
 */
import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, readlinkSync,
  realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// `tmux.mjs` reads SOMA_TMUX_SOCKET once, at load, and `soma.mjs` imports it, so a throwaway name
// is set before either loads. Nothing in this file calls tmux (every guarded dep is a stub); the
// name only makes `init`'s socket pin distinguishable from the live default.
const SOCK = 'soma-t13-inject-test';
process.env.SOMA_TMUX_SOCKET = SOCK;
const { dispatch, GUARDED_DEPS } = await import('../bin/soma.mjs');
const { socketName } = await import('../bin/lib/tmux.mjs');

/** The module under test, loaded inside each test so a missing export fails that test, not the file. */
const mod = () => import('../bin/lib/inject-hook.mjs');

/** A throwaway directory, removed when the test ends. */
const tmp = (t, prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** The house single-quote idiom (`settings-gen.shq`, `tmux.shQuote`): the expected spelling of every command word. */
const sq = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

/** A settings object whose one UserPromptSubmit entry runs `command`. */
const wiredTo = (command) => ({ hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command }] }] } });

/** Bytes, inode and mtime: the three things "the file was not rewritten" is a claim about. */
const fingerprint = (fp) => {
  const st = statSync(fp);
  return { bytes: readFileSync(fp, 'utf8'), ino: st.ino, mtimeMs: st.mtimeMs };
};

/** Push a file's mtime an hour back, so a rewrite in the same second still moves it visibly. */
const age = (fp) => {
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(fp, past, past);
};

const ROOT = '/state/root';
const NODE = '/opt/node/bin/node';

// ------------------------------------------------------------------ INJECT_HOOK and injectCommand

test('INJECT_HOOK is the absolute, forward-slashed path of this install\'s orch-inject.mjs', async () => {
  const { INJECT_HOOK } = await mod();
  assert.equal(typeof INJECT_HOOK, 'string');
  assert.ok(isAbsolute(INJECT_HOOK) || /^[A-Za-z]:\//.test(INJECT_HOOK), `a cwd-relative hook path resolves wherever claude was started: ${INJECT_HOOK}`);
  assert.ok(!INJECT_HOOK.includes('\\'), `not forward-slashed: ${INJECT_HOOK}`);
  assert.ok(INJECT_HOOK.endsWith('/bin/hooks/orch-inject.mjs'), INJECT_HOOK);
  assert.equal(realpathSync(INJECT_HOOK), realpathSync(fileURLToPath(new URL('../bin/hooks/orch-inject.mjs', import.meta.url))),
    'the hook of THIS install, not some other checkout');
});

test('injectCommand pins SOMA_HOME and runs orch-inject.mjs with this node, every word single-quoted', async () => {
  const { INJECT_HOOK, injectCommand } = await mod();
  assert.equal(injectCommand(ROOT, NODE), `SOMA_HOME=${sq(ROOT)} ${sq(NODE)} ${sq(INJECT_HOOK)}`);
  // `node` defaults to the node running soma: an absolute path, so the hook does not depend on
  // whichever `node` the PATH of a session started months later happens to find first.
  assert.equal(injectCommand(ROOT), `SOMA_HOME=${sq(ROOT)} ${sq(process.execPath)} ${sq(INJECT_HOOK)}`);
  // The embedded quote is closed, escaped and reopened, the POSIX way.
  assert.equal(injectCommand("/tmp/o'brien/my soma", NODE), `SOMA_HOME='/tmp/o'\\''brien/my soma' ${sq(NODE)} ${sq(INJECT_HOOK)}`);
});

test('injectCommand survives a root and a node path with spaces and single quotes: sh -c hands each word over intact', async (t) => {
  const { INJECT_HOOK, injectCommand } = await mod();
  const dir = tmp(t, "ih q'x ");
  // A stand-in for node that reports what it was handed: its environment's SOMA_HOME, its argc, its argv[1].
  const fakeNode = join(dir, "fake no'de");
  writeFileSync(fakeNode, '#!/bin/sh\nprintf \'%s\\n\' "$SOMA_HOME" "$#" "$1"\n', { mode: 0o755 });
  const root = join(dir, "my soma o'brien");
  const out = execFileSync('sh', ['-c', injectCommand(root, fakeNode)], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  assert.deepEqual(out.split('\n'), [root, '1', INJECT_HOOK, ''],
    'an unquoted root splits at the space and the hook reads a state root that does not exist');
});

// ------------------------------------------------------------------------------- inspectInject

test('inspectInject: not wired unless a UserPromptSubmit entry\'s hooks run orch-inject.mjs', async () => {
  const { inspectInject } = await mod();
  for (const settings of [
    {},
    { hooks: {} },
    { hooks: { UserPromptSubmit: [] } },
    // the right script on the wrong event
    { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node /a/bin/hooks/orch-inject.mjs' }] }] } },
    // the right event running something else
    wiredTo('node /a/bin/hooks/something-else.mjs'),
    // a command outside any `hooks` array is not a registration
    { hooks: { UserPromptSubmit: [{ command: 'node /a/bin/hooks/orch-inject.mjs' }] } },
  ]) {
    assert.equal(inspectInject(settings, ROOT)?.wired, false, JSON.stringify(settings));
  }
});

test('inspectInject: pins says whether the wired command carries THIS root, another, or none', async () => {
  const { inspectInject, injectCommand } = await mod();
  const cases = [
    [injectCommand(ROOT), 'this'],
    [injectCommand(ROOT, NODE), 'this'],
    [`SOMA_HOME=${ROOT} node /a/bin/hooks/orch-inject.mjs`, 'this'],                 // bare, wired by hand
    [`SOMA_HOME='${ROOT}' node /a/bin/hooks/orch-inject.mjs`, 'this'],               // quoted, wired by hand
    ['SOMA_HOME=/other/root node /a/bin/hooks/orch-inject.mjs', 'other'],
    [`SOMA_HOME=${ROOT}2 node /a/bin/hooks/orch-inject.mjs`, 'other'],               // this root is a PREFIX of it
    [`SOMA_HOME=${ROOT}/sub node /a/bin/hooks/orch-inject.mjs`, 'other'],
    ["SOMA_HOME='/state' node /a/bin/hooks/orch-inject.mjs", 'other'],               // a prefix OF this root
    [injectCommand('/somewhere/else'), 'other'],
    ['node /a/bin/hooks/orch-inject.mjs', 'none'],
    [`${sq(NODE)} ${sq('/a/bin/hooks/orch-inject.mjs')}`, 'none'],
  ];
  for (const [command, pins] of cases) {
    const r = inspectInject(wiredTo(command), ROOT);
    assert.equal(r?.wired, true, command);
    assert.equal(r.pins, pins, command);
  }
  // A root with a space and a quote, spelled the way injectCommand spells it, round-trips.
  const odd = "/tmp/o'brien/my soma";
  assert.equal(inspectInject(wiredTo(injectCommand(odd)), odd).pins, 'this');
  assert.equal(inspectInject(wiredTo(injectCommand(odd)), '/tmp/o').pins, 'other', 'a prefix of the pinned root is not this root');
  assert.equal(inspectInject(wiredTo(injectCommand('/tmp/o')), odd).pins, 'other');
});

test('inspectInject: a double-quoted pin reads like a bare or a single-quoted one, on this root and on any other', async () => {
  const { inspectInject } = await mod();
  // `sh` hands `SOMA_HOME="<root>"` over as exactly <root>, as it does the bare and the
  // single-quoted spelling. A hand-wired hook is as likely to be double-quoted as not, and reading
  // one that names this root as "another root" makes `soma init --inject-hook` warn and exit 2
  // over a hook that is fine.
  const hook = (pin) => wiredTo(`SOMA_HOME=${pin} node /a/bin/hooks/orch-inject.mjs`);
  for (const [how, spell] of [['bare', (r) => r], ['single-quoted', (r) => `'${r}'`], ['double-quoted', (r) => `"${r}"`]]) {
    assert.equal(inspectInject(hook(spell(ROOT)), ROOT).pins, 'this', `${how}: ${spell(ROOT)}`);
    // another root, a root this one is a prefix of, and a prefix of this root
    for (const other of ['/other/root', `${ROOT}2`, `${ROOT}/sub`, '/state']) {
      assert.equal(inspectInject(hook(spell(other)), ROOT).pins, 'other', `${how}: ${spell(other)} is not ${ROOT}`);
    }
  }
  // Double quotes keep a space and a single quote inside the one word, so the pinned word ends at
  // the closing quote: a root that stops at the space is a prefix of it, not it.
  const odd = "/tmp/o'brien/my soma";
  assert.equal(inspectInject(hook(`"${odd}"`), odd).pins, 'this');
  for (const prefix of ["/tmp/o'brien/my", '/tmp/o']) {
    assert.equal(inspectInject(hook(`"${odd}"`), prefix).pins, 'other', `${prefix} is a prefix of the pinned root, not the root`);
  }
});

test('inspectInject finds the hook past entries that are garbage or run something else', async () => {
  const { inspectInject, injectCommand } = await mod();
  const settings = { hooks: { UserPromptSubmit: [
    null, 'x', 7, [], { hooks: null }, { hooks: 'orch-inject.mjs' },
    { matcher: '', hooks: [{ type: 'command', command: 'node /a/first.mjs' }, null, { command: 42 }, { type: 'command', command: injectCommand(ROOT) }] },
  ] } };
  const r = inspectInject(settings, ROOT);
  assert.equal(r?.wired, true);
  assert.equal(r.pins, 'this');
});

test('inspectInject never throws, whatever settings.json held', async () => {
  const { inspectInject } = await mod();
  for (const settings of [
    null, undefined, 0, 'x', true, [], [1],
    { hooks: null }, { hooks: 'x' }, { hooks: [] }, { hooks: 5 },
    { hooks: { UserPromptSubmit: null } }, { hooks: { UserPromptSubmit: 'node /a/orch-inject.mjs' } }, { hooks: { UserPromptSubmit: {} } },
    { hooks: { UserPromptSubmit: [null, 1, 'x', [], { hooks: null }, { hooks: 'orch-inject.mjs' }, { hooks: [null, 1, { command: null }, { command: 42 }, { command: {} }] }] } },
  ]) {
    let r;
    assert.doesNotThrow(() => { r = inspectInject(settings, ROOT); }, JSON.stringify(settings));
    assert.equal(r?.wired, false, JSON.stringify(settings));
  }
  for (const root of [undefined, null, '', 42, {}]) {
    assert.doesNotThrow(() => inspectInject(wiredTo('SOMA_HOME=/x node /a/bin/hooks/orch-inject.mjs'), root), `root ${JSON.stringify(root)}`);
    assert.doesNotThrow(() => inspectInject(wiredTo('node /a/bin/hooks/orch-inject.mjs'), root), `root ${JSON.stringify(root)}`);
  }
});

// --------------------------------------------------------------------------- installInjectHook

test('installInjectHook: no settings.json yet — creates it and its parent, holding exactly the one entry', async (t) => {
  const { installInjectHook, injectCommand } = await mod();
  const dir = tmp(t, 'ih-');
  const settingsPath = join(dir, 'cfg', 'nested', 'settings.json');
  const r = installInjectHook({ settingsPath, root: ROOT, node: NODE });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.action, 'added');
  assert.equal(r.pins, 'this');
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')),
    { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: injectCommand(ROOT, NODE) }] }] } });
  assert.deepEqual(readdirSync(dirname(settingsPath)), ['settings.json'], 'the scratch file of the publish was left behind');

  // `node` defaults to the node running soma.
  const other = join(dir, 'cfg2', 'settings.json');
  assert.equal(installInjectHook({ settingsPath: other, root: ROOT }).action, 'added');
  assert.equal(JSON.parse(readFileSync(other, 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command, injectCommand(ROOT));
});

test('installInjectHook appends after the existing entries and keeps every other key, in order', async (t) => {
  const { installInjectHook, injectCommand } = await mod();
  const dir = tmp(t, 'ih-');
  const settingsPath = join(dir, 'settings.json');
  const before = {
    model: 'opus',
    env: { FOO: '1' },
    hooks: {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node /x/stop.mjs' }] }],
      UserPromptSubmit: [
        { matcher: '', hooks: [{ type: 'command', command: 'node /x/first.mjs' }] },
        { hooks: [{ type: 'command', command: 'node /x/second.mjs', timeout: 5 }] },
      ],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node /x/gate.mjs' }] }],
    },
    permissions: { allow: ['Bash(ls:*)'], deny: [] },
    zz: [1, 'two', null, { deep: true }],
  };
  writeFileSync(settingsPath, JSON.stringify(before, null, 2));
  const r = installInjectHook({ settingsPath, root: ROOT, node: NODE });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.action, 'added');
  assert.equal(r.pins, 'this');

  const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const expected = structuredClone(before);
  expected.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: injectCommand(ROOT, NODE) }] });
  assert.deepEqual(after, expected, 'the operator\'s own settings are theirs: one entry appended, nothing else touched');
  assert.deepEqual(Object.keys(after), Object.keys(before), 'top-level key order');
  assert.deepEqual(Object.keys(after.hooks), Object.keys(before.hooks), 'hook-event key order');
  assert.deepEqual(readdirSync(dir), ['settings.json']);
});

test('installInjectHook adds the UserPromptSubmit list when hooks has none, and keeps the other events', async (t) => {
  const { installInjectHook, injectCommand } = await mod();
  const dir = tmp(t, 'ih-');
  const settingsPath = join(dir, 'settings.json');
  const before = { model: 'opus', hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node /x/stop.mjs' }] }] } };
  writeFileSync(settingsPath, JSON.stringify(before));
  assert.equal(installInjectHook({ settingsPath, root: ROOT, node: NODE }).action, 'added');
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), {
    model: 'opus',
    hooks: { ...before.hooks, UserPromptSubmit: [{ hooks: [{ type: 'command', command: injectCommand(ROOT, NODE) }] }] },
  });
  // and a file with no `hooks` key at all
  writeFileSync(settingsPath, JSON.stringify({ model: 'opus' }));
  assert.equal(installInjectHook({ settingsPath, root: ROOT, node: NODE }).action, 'added');
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')),
    { model: 'opus', hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: injectCommand(ROOT, NODE) }] }] } });
});

test('installInjectHook: already wired — reports present with its pins, and does not rewrite the file', async (t) => {
  const { installInjectHook, injectCommand } = await mod();
  for (const [command, pins] of [
    [injectCommand(ROOT, NODE), 'this'],
    [`SOMA_HOME=${ROOT} node /hand/bin/hooks/orch-inject.mjs`, 'this'],
    ['SOMA_HOME=/some/other/root node /hand/bin/hooks/orch-inject.mjs', 'other'],
    ['node /hand/bin/hooks/orch-inject.mjs', 'none'],
  ]) {
    const dir = tmp(t, 'ih-');
    const settingsPath = join(dir, 'settings.json');
    // Formatting a rewrite would normalise, so "same bytes" cannot pass by coincidence.
    writeFileSync(settingsPath, `${JSON.stringify(wiredTo(command), null, 4)}\n\n`);
    age(settingsPath);
    const before = fingerprint(settingsPath);
    const r = installInjectHook({ settingsPath, root: ROOT, node: NODE });
    assert.equal(r.ok, true, `${command}: ${JSON.stringify(r)}`);
    assert.equal(r.action, 'present', command);
    assert.equal(r.pins, pins, command);
    assert.deepEqual(fingerprint(settingsPath), before, `${command}: the file was rewritten (bytes, inode or mtime moved)`);
    assert.deepEqual(readdirSync(dir), ['settings.json'], command);
  }
});

test('installInjectHook refuses a settings.json it cannot extend without loss, and leaves its bytes alone', async (t) => {
  const { installInjectHook } = await mod();
  const cases = [
    ['invalid JSON', '{ "hooks": '],
    ['a top-level null', 'null'],
    ['a top-level array', '[{"hooks":{}}]'],
    ['a top-level string', '"x"'],
    ['a top-level number', '42'],
    ['hooks is an array', '{"model":"opus","hooks":[]}'],
    ['hooks is a string', '{"hooks":"x"}'],
    ['hooks is a number', '{"hooks":1}'],
    ['UserPromptSubmit is an object', '{"hooks":{"UserPromptSubmit":{"hooks":[]}}}'],
    ['UserPromptSubmit is a string', '{"hooks":{"UserPromptSubmit":"node /a/bin/hooks/orch-inject.mjs"}}'],
  ];
  for (const [what, bytes] of cases) {
    const dir = tmp(t, 'ih-');
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, bytes);
    age(settingsPath);
    const before = fingerprint(settingsPath);
    let r;
    assert.doesNotThrow(() => { r = installInjectHook({ settingsPath, root: ROOT, node: NODE }); }, what);
    assert.equal(r.ok, false, `${what}: ${JSON.stringify(r)}`);
    assert.equal(typeof r.error, 'string', what);
    assert.ok(r.error.length > 0, `${what}: a refusal must say why`);
    assert.deepEqual(fingerprint(settingsPath), before, `${what}: the refused file was touched`);
    assert.deepEqual(readdirSync(dir), ['settings.json'], `${what}: a file was left beside it`);
  }
});

/** Write `bytes` as settings.json and require a refusal that says why, the file as it was, and nothing beside it. */
const refusesUntouched = (t, installInjectHook, what, bytes) => {
  const dir = tmp(t, 'ih-');
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, bytes);
  age(settingsPath);
  const before = fingerprint(settingsPath);
  let r;
  assert.doesNotThrow(() => { r = installInjectHook({ settingsPath, root: ROOT, node: NODE }); }, what);
  assert.equal(r.ok, false, `${what}: ${JSON.stringify(r)}`);
  assert.equal(typeof r.error, 'string', what);
  assert.ok(r.error.length > 0, `${what}: a refusal must say why`);
  assert.deepEqual(fingerprint(settingsPath), before, `${what}: the refused file was touched`);
  assert.deepEqual(readdirSync(dir), ['settings.json'], `${what}: a file was left beside it`);
};

test('installInjectHook refuses a "hooks" or a "UserPromptSubmit" that is null, and leaves the bytes alone', async (t) => {
  const { installInjectHook } = await mod();
  // A null is a value somebody wrote, not a missing key, and it is no object or list to extend.
  // Putting one there would replace the operator's value, which this installer never does.
  for (const [what, bytes] of [
    ['hooks is null', '{"model":"opus","hooks":null}'],
    ['UserPromptSubmit is null', '{"model":"opus","hooks":{"Stop":[],"UserPromptSubmit":null}}'],
  ]) {
    refusesUntouched(t, installInjectHook, what, bytes);
  }
});

test('installInjectHook refuses a 0-byte settings.json: a file that is there and empty is not a missing one', async (t) => {
  const { installInjectHook } = await mod();
  // Only a file that does not exist starts from nothing. An empty one is not JSON, and it is what
  // another program's truncate-then-write save looks like halfway: a rename over it would orphan
  // the inode that program is still writing, and its save would be lost.
  refusesUntouched(t, installInjectHook, 'a 0-byte file', '');
});

test('installInjectHook refuses on any read error but ENOENT, and creates nothing', async (t) => {
  const { installInjectHook } = await mod();

  // EISDIR: settings.json is a directory.
  const a = tmp(t, 'ih-');
  const isDir = join(a, 'settings.json');
  mkdirSync(isDir);
  writeFileSync(join(isDir, 'keep'), 'k');
  const r1 = installInjectHook({ settingsPath: isDir, root: ROOT, node: NODE });
  assert.equal(r1.ok, false, JSON.stringify(r1));
  assert.equal(typeof r1.error, 'string');
  assert.ok(statSync(isDir).isDirectory());
  assert.deepEqual(readdirSync(isDir), ['keep']);
  assert.deepEqual(readdirSync(a), ['settings.json']);

  // ENOTDIR: the parent is a FILE. Not "missing", so no directory may be made in its place.
  const b = tmp(t, 'ih-');
  writeFileSync(join(b, 'cfg'), 'a file, not a config dir');
  const r2 = installInjectHook({ settingsPath: join(b, 'cfg', 'settings.json'), root: ROOT, node: NODE });
  assert.equal(r2.ok, false, JSON.stringify(r2));
  assert.equal(readFileSync(join(b, 'cfg'), 'utf8'), 'a file, not a config dir');
  assert.deepEqual(readdirSync(b), ['cfg']);

  // EACCES: a file that is there and cannot be read is not an empty one. (Root reads it anyway.)
  if (process.getuid?.() !== 0) {
    const c = tmp(t, 'ih-');
    const locked = join(c, 'settings.json');
    const bytes = JSON.stringify({ model: 'opus', hooks: { Stop: [] } });
    writeFileSync(locked, bytes);
    chmodSync(locked, 0o000);
    const r3 = installInjectHook({ settingsPath: locked, root: ROOT, node: NODE });
    chmodSync(locked, 0o644);
    assert.equal(r3.ok, false, `an unreadable settings.json was treated as absent and replaced: ${JSON.stringify(r3)}`);
    assert.equal(readFileSync(locked, 'utf8'), bytes);
    assert.deepEqual(readdirSync(c), ['settings.json']);
  }
});

/** A settings.json that reads fine and needs the hook appended, so every install below gets as far as the write. */
const READABLE = JSON.stringify({ model: 'opus', hooks: { Stop: [] } }, null, 2);

/** The result of an install whose write failed: a refusal that says why, not a throw and not a success. */
const assertWriteRefused = (r) => {
  assert.equal(r?.ok, false, `a publish that did not happen was reported as done: ${JSON.stringify(r)}`);
  assert.equal(typeof r.error, 'string');
  assert.ok(r.error.length > 0, 'a refusal must say why');
};

test('installInjectHook: a write that fails after a good read refuses, leaves the bytes alone, and leaves no *.tmp',
  { skip: process.getuid?.() === 0 ? 'running as root: a read-only directory cannot be staged' : false }, async (t) => {
    const { installInjectHook } = await mod();
    const dir = mkdtempSync(join(tmpdir(), 'ih-'));
    t.after(() => { chmodSync(dir, 0o755); rmSync(dir, { recursive: true, force: true }); });
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, READABLE);
    age(settingsPath);
    const before = fingerprint(settingsPath);
    // The file still reads; nothing can be created, renamed or removed beside it.
    chmodSync(dir, 0o555);
    let r;
    assert.doesNotThrow(() => { r = installInjectHook({ settingsPath, root: ROOT, node: NODE }); });
    assertWriteRefused(r);
    assert.deepEqual(fingerprint(settingsPath), before, 'the file was touched');
    assert.deepEqual(readdirSync(dir), ['settings.json'], 'a scratch (*.tmp) file was left behind');
  });

/**
 * The same rule where the scratch file DID get written: the rename onto settings.json is what
 * fails, so the clean-up is what is under test. macOS refuses to replace a file flagged
 * user-immutable (`chflags uchg`) while it still reads it and lets the directory take new files;
 * Linux has no unprivileged equivalent, so there the test is skipped.
 */
test('installInjectHook: a rename that fails after the scratch file was written refuses, and removes the scratch file',
  { skip: process.platform !== 'darwin' ? 'needs chflags uchg (macOS) to fail a rename after a good write' : false }, async (t) => {
    const { installInjectHook } = await mod();
    const dir = mkdtempSync(join(tmpdir(), 'ih-'));
    const settingsPath = join(dir, 'settings.json');
    t.after(() => {
      try { execFileSync('chflags', ['nouchg', settingsPath], { stdio: 'ignore' }); } catch { /* never flagged */ }
      rmSync(dir, { recursive: true, force: true });
    });
    writeFileSync(settingsPath, READABLE);
    age(settingsPath);
    execFileSync('chflags', ['uchg', settingsPath], { stdio: 'ignore' });
    const before = fingerprint(settingsPath);
    let r;
    assert.doesNotThrow(() => { r = installInjectHook({ settingsPath, root: ROOT, node: NODE }); });
    assertWriteRefused(r);
    assert.deepEqual(fingerprint(settingsPath), before, 'the file was touched');
    assert.deepEqual(readdirSync(dir), ['settings.json'], 'the scratch (*.tmp) file of the failed publish was left behind');
  });

test('installInjectHook publishes by rename: a reader holding the old file still sees all of it', async (t) => {
  const { installInjectHook } = await mod();
  const dir = tmp(t, 'ih-');
  const settingsPath = join(dir, 'settings.json');
  const bytes = JSON.stringify({ model: 'opus', hooks: { Stop: [] } }, null, 2);
  writeFileSync(settingsPath, bytes);
  const ino = statSync(settingsPath).ino;
  // Claude Code reads this file at every session start; a truncate-then-write publish hands a
  // session that starts mid-write an empty or half-written settings file.
  const fd = openSync(settingsPath, 'r');
  t.after(() => closeSync(fd));
  assert.equal(installInjectHook({ settingsPath, root: ROOT, node: NODE }).action, 'added');
  const held = Buffer.alloc(bytes.length + 256);
  const n = readSync(fd, held, 0, held.length, 0);
  assert.equal(held.subarray(0, n).toString(), bytes, 'an open reader must still see the whole old file');
  assert.notEqual(statSync(settingsPath).ino, ino, 'a rename publishes a new inode; an in-place write keeps the old one');
  assert.match(readFileSync(settingsPath, 'utf8'), /orch-inject\.mjs/);
  assert.deepEqual(readdirSync(dir), ['settings.json'], 'no scratch file left behind');
});

/*
 * The file stays the operator's in two more ways than its keys: its permission bits, and the
 * symlink it may be. settings.json can carry `env` secrets, so a publish whose new file took its
 * bits from the umask would turn a 0600 file into a 0644 one at the rename. And a settings.json
 * that links into a dotfiles checkout is that checkout's file: a rename onto the link replaces the
 * link with a plain file, and the checkout silently stops being the settings.
 */

/** POSIX modes and symlinks (the house reading, as in `pretrust.test.mjs`); the repo runs on macOS, Linux and WSL. */
const POSIX = process.platform !== 'win32';
const modeOf = (fp) => statSync(fp).mode & 0o777;
const oct = (m) => `0${m.toString(8)}`;

/** Run `fn` under `umask`, restored afterwards, so a dir or fixture made around it is made under the usual one. */
const underUmask = (umask, fn) => {
  const saved = process.umask(umask);
  try {
    return fn();
  } finally {
    process.umask(saved);
  }
};

test('installInjectHook: a rewritten settings.json keeps its permission bits, and a new one is created 0600, whatever the umask',
  { skip: POSIX ? false : 'POSIX modes' }, async (t) => {
    const { installInjectHook } = await mod();
    // 0o022 is the usual umask and strips the group and other write bits; 0o200 strips the owner's
    // write bit. A mode that is only right because of the umask comes out wrong under one of them.
    for (const umask of [0o022, 0o200]) {
      for (const mode of [0o600, 0o640, 0o644, 0o660, 0o664]) {
        const dir = tmp(t, 'ih-');
        const settingsPath = join(dir, 'settings.json');
        writeFileSync(settingsPath, READABLE);
        chmodSync(settingsPath, mode);
        const r = underUmask(umask, () => installInjectHook({ settingsPath, root: ROOT, node: NODE }));
        assert.equal(r?.action, 'added', `${oct(mode)}, umask ${oct(umask)}: ${JSON.stringify(r)}`);
        assert.equal(oct(modeOf(settingsPath)), oct(mode), `a ${oct(mode)} settings.json was republished with other bits (umask ${oct(umask)})`);
        assert.deepEqual(readdirSync(dir), ['settings.json'], `${oct(mode)}, umask ${oct(umask)}`);
      }
      const dir = tmp(t, 'ih-');
      const settingsPath = join(dir, 'settings.json');
      const r = underUmask(umask, () => installInjectHook({ settingsPath, root: ROOT, node: NODE }));
      assert.equal(r?.action, 'added', `a new settings.json, umask ${oct(umask)}: ${JSON.stringify(r)}`);
      assert.equal(oct(modeOf(settingsPath)), oct(0o600), `a new settings.json is the operator's alone (umask ${oct(umask)})`);
    }
  });

test('installInjectHook writes a symlinked settings.json at its target: the link stays the same link, and the target keeps the rest',
  { skip: POSIX ? false : 'symlinks' }, async (t) => {
    const { installInjectHook, injectCommand } = await mod();
    const dir = tmp(t, 'ih-');
    // A dotfiles checkout, linked into the config root the way a stow-style manager links it: by a
    // relative path.
    const dots = join(dir, 'dotfiles');
    const cfg = join(dir, 'cfg');
    mkdirSync(dots);
    mkdirSync(cfg);
    const target = join(dots, 'claude-settings.json');
    const before = { model: 'opus', hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node /x/stop.mjs' }] }] } };
    writeFileSync(target, JSON.stringify(before, null, 2));
    chmodSync(target, 0o640);
    const settingsPath = join(cfg, 'settings.json');
    const linkText = join('..', 'dotfiles', 'claude-settings.json');
    symlinkSync(linkText, settingsPath);
    const link = lstatSync(settingsPath);

    const r = installInjectHook({ settingsPath, root: ROOT, node: NODE });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.action, 'added');

    const now = lstatSync(settingsPath);
    assert.ok(now.isSymbolicLink(), 'the link was replaced by a plain file: the dotfiles checkout is no longer the settings');
    assert.equal(readlinkSync(settingsPath), linkText, 'the link points somewhere else now');
    assert.equal(now.ino, link.ino, 'the link was recreated rather than left alone');
    const expected = structuredClone(before);
    expected.hooks.UserPromptSubmit = [{ hooks: [{ type: 'command', command: injectCommand(ROOT, NODE) }] }];
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), expected, 'the target holds the new entry and everything it held before');
    assert.equal(oct(modeOf(target)), oct(0o640), 'the bits kept are the target\'s, not the link\'s');
    assert.deepEqual(readdirSync(cfg), ['settings.json'], 'a scratch file was left beside the link');
    assert.deepEqual(readdirSync(dots), ['claude-settings.json'], 'a scratch file was left beside the target');
  });

test('installInjectHook refuses a dangling symlinked settings.json: the link stays as it was, and nothing is created at either end',
  { skip: POSIX ? false : 'symlinks' }, async (t) => {
    const { installInjectHook } = await mod();
    // A link to a missing file is not a missing settings.json. Writing through it creates a file
    // wherever the link points, and a rename onto it replaces the link with a plain file: either
    // way the operator's dotfiles setup changes under them. The link is theirs to repair.
    for (const [what, linkText] of [
      ['a missing file in a directory that exists', join('..', 'dotfiles', 'claude-settings.json')],
      ['a missing file in a directory that does not exist', join('..', 'gone', 'claude-settings.json')],
    ]) {
      const dir = tmp(t, 'ih-');
      const dots = join(dir, 'dotfiles');
      const cfg = join(dir, 'cfg');
      mkdirSync(dots);
      mkdirSync(cfg);
      const settingsPath = join(cfg, 'settings.json');
      symlinkSync(linkText, settingsPath);
      const link = lstatSync(settingsPath);
      let r;
      assert.doesNotThrow(() => { r = installInjectHook({ settingsPath, root: ROOT, node: NODE }); }, what);
      assert.equal(r?.ok, false, `${what}: a dangling link was written through: ${JSON.stringify(r)}`);
      assert.equal(typeof r.error, 'string', what);
      assert.ok(r.error.length > 0, `${what}: a refusal must say why`);
      const now = lstatSync(settingsPath);
      assert.ok(now.isSymbolicLink(), `${what}: the link was replaced`);
      assert.equal(readlinkSync(settingsPath), linkText, `${what}: the link points somewhere else now`);
      assert.equal(now.ino, link.ino, `${what}: the link was recreated`);
      assert.deepEqual(readdirSync(cfg), ['settings.json'], `${what}: a file was left beside the link`);
      assert.deepEqual(readdirSync(dots), [], `${what}: a file was created in the dotfiles directory`);
      assert.deepEqual(readdirSync(dir).sort(), ['cfg', 'dotfiles'], `${what}: a directory was created for the link's target`);
    }
  });

/**
 * The scratch name is predictable — `<target>.<pid>.tmp`, pretrust's convention, where the target
 * is the file the installer publishes (settings.json's realpath, the link's target for a symlinked
 * one) and the pid is this test process's because the installer runs in it — and the file written
 * there is the operator's settings, `env` secrets included. So whatever is already at that name is
 * not the installer's to write through: `pretrust.test.mjs` pins the same rule for `~/.claude.json`.
 */
test('installInjectHook never follows a symlink planted at its scratch name: the decoy is untouched, and what it publishes is a plain file',
  { skip: POSIX ? false : 'symlinks' }, async (t) => {
    const { installInjectHook, injectCommand } = await mod();
    const linkText = join('..', 'dotfiles', 'claude-settings.json');
    for (const kind of ['an existing', 'a new', 'a symlinked']) {
      for (const decoyExists of [true, false]) {
        const what = `${kind} settings.json, a link to ${decoyExists ? 'a file' : 'a missing file'}`;
        const dir = tmp(t, 'ih-');
        const cfg = join(dir, 'cfg');
        const dots = join(dir, 'dotfiles');
        const elsewhere = join(dir, 'elsewhere');
        for (const d of [cfg, dots, elsewhere]) mkdirSync(d);
        const settingsPath = join(cfg, 'settings.json');
        // The file the installer publishes, beside which its scratch name sits.
        let published = settingsPath;
        if (kind === 'an existing') {
          writeFileSync(settingsPath, READABLE);
          chmodSync(settingsPath, 0o600);
        } else if (kind === 'a symlinked') {
          published = join(dots, 'claude-settings.json');
          writeFileSync(published, READABLE);
          chmodSync(published, 0o600);
          symlinkSync(linkText, settingsPath);
        }
        const decoy = join(elsewhere, 'decoy');
        if (decoyExists) {
          writeFileSync(decoy, 'untouched');
          chmodSync(decoy, 0o644);
          age(decoy);
        }
        const before = decoyExists ? { ...fingerprint(decoy), mode: modeOf(decoy) } : null;
        symlinkSync(decoy, `${join(realpathSync(dirname(published)), basename(published))}.${process.pid}.tmp`);

        const r = installInjectHook({ settingsPath, root: ROOT, node: NODE });
        assert.equal(r.ok, true, `${what}: ${JSON.stringify(r)}`);
        assert.equal(r.action, 'added', what);
        if (decoyExists) {
          // Followed, the write hands the decoy the operator's settings and the chmod changes its bits.
          assert.deepEqual({ ...fingerprint(decoy), mode: modeOf(decoy) }, before, `${what}: the planted link was followed into the decoy`);
        } else {
          // Followed, a create through a dangling link makes the file it names.
          assert.equal(existsSync(decoy), false, `${what}: the planted link was followed, and its target created`);
        }
        assert.deepEqual(readdirSync(elsewhere), decoyExists ? ['decoy'] : [], what);
        // Renamed as found, the planted link itself would be what settings.json reads now.
        assert.equal(lstatSync(published).isSymbolicLink(), false, `${what}: the planted link was published`);
        assert.equal(JSON.parse(readFileSync(published, 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command, injectCommand(ROOT, NODE), what);
        assert.equal(oct(modeOf(published)), oct(0o600), `${what}: the published file's bits`);
        assert.deepEqual(readdirSync(dirname(published)), [basename(published)], `${what}: something was left at the scratch name`);
        assert.deepEqual(readdirSync(cfg), ['settings.json'], what);
        if (kind === 'a symlinked') assert.equal(readlinkSync(settingsPath), linkText, `${what}: the settings link was changed`);
      }
    }
  });

test('installInjectHook twice is one install, even for a root with a space and a quote', async (t) => {
  const { installInjectHook, inspectInject } = await mod();
  const dir = tmp(t, 'ih-');
  const settingsPath = join(dir, 'settings.json');
  const root = "/tmp/o'brien/my soma";
  const first = installInjectHook({ settingsPath, root, node: NODE });
  assert.equal(first.action, 'added');
  age(settingsPath);
  const before = fingerprint(settingsPath);
  const second = installInjectHook({ settingsPath, root, node: NODE });
  assert.equal(second.ok, true);
  assert.equal(second.action, 'present', 'a re-run appended a second copy of the hook');
  assert.equal(second.pins, 'this', 'the installer does not recognise its own quoting');
  assert.deepEqual(fingerprint(settingsPath), before);
  assert.equal(JSON.parse(before.bytes).hooks.UserPromptSubmit.length, 1);
  assert.equal(inspectInject(JSON.parse(before.bytes), root).pins, 'this');
});

/**
 * The installed command, end to end: the REAL orch-inject.mjs, run the way Claude Code runs a hook
 * (`sh -c`, the payload on stdin), in an environment with no SOMA_HOME at all — so the pin is the
 * only thing that can lead it to the fleet. The root carries a space and a quote. The control run
 * without the pin finds nothing, which is what an unpinned hand-wired hook does on a machine whose
 * fleet is not at `~/.soma`.
 */
test('the installed command drives the real orch-inject against the pinned root, and only the pin finds it', async (t) => {
  const { installInjectHook, INJECT_HOOK } = await mod();
  const dir = tmp(t, "ih e2e q'x ");
  const root = join(dir, "state o'b");
  const prev = process.env.SOMA_HOME;
  const restore = () => { if (prev === undefined) delete process.env.SOMA_HOME; else process.env.SOMA_HOME = prev; };
  t.after(restore);
  process.env.SOMA_HOME = root;
  const { ensureTree } = await import('../bin/lib/paths.mjs');
  const { enqueue } = await import('../bin/lib/fleet.mjs');
  const { acquireLease } = await import('../bin/lib/lease.mjs');
  const { appendEvent } = await import('../bin/lib/events.mjs');
  ensureTree();
  enqueue([{ id: 'cr-1', title: 'cr-1', repo: 'r', source: {}, brief: 'b' }]);
  acquireLease({ session_id: 'ORCH-UUID', tmux_socket: SOCK, tmux_pane: '%3', wake: 'tmux' }, { force: true });
  appendEvent('cr-1', { type: 'NEEDS_INPUT', payload: { question: 'which branch?' }, lead: 'cr-1' });
  restore();

  const settingsPath = join(dir, 'cfg', 'settings.json');
  assert.equal(installInjectHook({ settingsPath, root }).action, 'added');
  const command = JSON.parse(readFileSync(settingsPath, 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command;

  const env = { PATH: process.env.PATH ?? '', HOME: dir };
  const input = JSON.stringify({ session_id: 'ORCH-UUID', hook_event_name: 'UserPromptSubmit', prompt: 'status?' });
  const out = execFileSync('sh', ['-c', command], { input, env, encoding: 'utf8', timeout: 15_000 });
  const j = JSON.parse(out);
  assert.equal(j.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(j.hookSpecificOutput.additionalContext, /cr-1 NEEDS_INPUT/);

  // The control: the same hook with no pin reads $HOME/.soma, which holds no fleet.
  const unpinned = execFileSync('sh', ['-c', `${sq(process.execPath)} ${sq(INJECT_HOOK)}`], { input, env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(unpinned, '', 'fixture: without the pin the hook must find nothing, or the pin proves nothing');
});

// ------------------------------------------------------------------------ soma init --inject-hook

/** A throwaway state root for one test; restores the previous one afterwards. */
const stateRoot = (t) => {
  const prev = process.env.SOMA_HOME;
  const home = mkdtempSync(join(tmpdir(), 'ih-home-'));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SOMA_HOME; else process.env.SOMA_HOME = prev;
  });
  process.env.SOMA_HOME = home;
  return home;
};

/**
 * `dispatch` deps for `init`: every guarded dep present and recording, and `deps.env` naming a
 * throwaway CLAUDE_CONFIG_DIR — the config root `init` installs into.
 *
 * Every guarded dep but one does nothing real. `installInjectHook` records its call and then runs
 * the REAL installer, because what `init --inject-hook` leaves in settings.json is what these tests
 * are about. It runs only on this fixture's own settings.json: handed any other path, it fails the
 * test before anything is written.
 *
 * `capture` answers `claude mcp get soma` with an entry that carries this root and this socket,
 * so a clean init prints nothing on stderr and any warning below is the inject hook's own. It also
 * records whether settings.json carried the hook when each `claude mcp` call ran: that is how
 * "after the bus step" is observed.
 */
const initDeps = async ({ home, cfg }) => {
  const { installInjectHook } = await mod();
  const out = [];
  const err = [];
  const settingsPath = join(cfg, 'settings.json');
  const hookOnDisk = () => {
    try { return /orch-inject\.mjs/.test(readFileSync(settingsPath, 'utf8')); } catch { return false; }
  };
  const calls = {
    installSkill: [], capture: [], installInjectHook: [], newSession: [], killSession: [], sendKeys: [], resumeLead: [], exec: [], confirm: [],
  };
  const deps = {
    print: (s) => out.push(String(s)),
    warn: (s) => err.push(String(s)),
    env: { PATH: process.env.PATH ?? '', HOME: cfg, CLAUDE_CONFIG_DIR: cfg },
    liveSessions: () => new Set(),
    serverAbsent: () => false,
    paneStates: () => null,
    newSession: (spec) => { calls.newSession.push(spec); },
    killSession: (name) => { calls.killSession.push(name); return true; },
    sendKeys: (target, text) => { calls.sendKeys.push({ target, text }); return true; },
    capturePane: () => '',
    resumeLead: (task) => { calls.resumeLead.push(task); return { session_uuid: null }; },
    exec: (cmd, args) => { calls.exec.push({ cmd, args }); },
    capture: (cmd, args) => {
      calls.capture.push({ cmd, args, hookOnDisk: hookOnDisk() });
      return args.includes('get')
        ? { stdout: `soma: node /abs/bin/soma-bus.mjs\n  SOMA_HOME=${home}\n  SOMA_TMUX_SOCKET=${SOCK}`, stderr: '', code: 0 }
        : { stdout: '', stderr: '', code: 0 };
    },
    doctor: async () => true,
    canary: async () => true,
    confirm: (q) => { calls.confirm.push(q); return false; },
    linkProbe: () => ({ ok: true, code: null, dir: home }),
    installSkill: (cfgRoot) => { calls.installSkill.push(cfgRoot); return { ok: true, dest: join(cfgRoot, 'skills', 'soma-promote') }; },
    installInjectHook: (opts) => {
      calls.installInjectHook.push(opts);
      assert.equal(opts?.settingsPath, settingsPath, 'init handed the installer a path that is not <config root>/settings.json; the real installer was not run');
      return installInjectHook(opts);
    },
  };
  for (const name of GUARDED_DEPS) assert.equal(typeof deps[name], 'function', `fixture: guarded dep ${name} is not stubbed`);
  const lines = (arr) => arr.join('\n').split('\n');
  return { deps, calls, settingsPath, stdout: () => out.join('\n'), stderr: () => err.join('\n'), outLines: () => lines(out), errLines: () => lines(err), err };
};

test('fixture: init runs on the throwaway socket, and a clean init with these stubs warns about nothing', async (t) => {
  assert.equal(socketName(), SOCK, 'tmux.mjs loaded before the socket was set; the init pins below would be meaningless');
  const home = stateRoot(t);
  const cfg = tmp(t, 'ih-cfg-');
  writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ model: 'opus' }));
  const h = await initDeps({ home, cfg });
  assert.equal(await dispatch(['init'], h.deps), 0, h.stderr());
  assert.equal(h.stderr(), '', 'the stubs are meant to make init clean, so a stderr line in the tests below is the inject hook\'s');
});

test('init --inject-hook registers orch-inject in <config root>/settings.json, pinned to this SOMA_HOME, after the bus step', async (t) => {
  const { injectCommand } = await mod();
  const home = stateRoot(t);
  const cfg = tmp(t, 'ih-cfg-');
  const stop = [{ matcher: '', hooks: [{ type: 'command', command: 'node /x/stop.mjs' }] }];
  writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: stop } }, null, 2));
  const h = await initDeps({ home, cfg });
  assert.equal(await dispatch(['init', '--inject-hook'], h.deps), 0, h.stderr());

  const j = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
  assert.equal(j.model, 'opus', 'the operator\'s other settings survive');
  assert.deepEqual(j.hooks.Stop, stop);
  assert.deepEqual(j.hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: injectCommand(home) }] }],
    'one entry, pinned to the state root this CLI runs on');
  assert.ok(h.outLines().some((l) => l.startsWith('inject hook: registered by soma init --inject-hook')), h.stdout());
  assert.doesNotMatch(h.stdout(), /inject hook: NOT installed/, 'the hook it just installed is not "NOT installed"');
  assert.equal(h.calls.installInjectHook.length, 1, 'one init --inject-hook is one install');

  // After the bus step: every `claude mcp` call, the read-back included, ran before the hook landed.
  assert.ok(h.calls.capture.some((c) => c.args.includes('get')), 'fixture: the bus read-back ran');
  assert.deepEqual(h.calls.capture.map((c) => c.hookOnDisk), h.calls.capture.map(() => false),
    'the inject hook was written before the bus was registered and read back');
});

test('init --inject-hook with no settings.json yet creates it', async (t) => {
  const { injectCommand } = await mod();
  const home = stateRoot(t);
  const cfg = tmp(t, 'ih-cfg-');
  const h = await initDeps({ home, cfg });
  assert.equal(await dispatch(['init', '--inject-hook'], h.deps), 0, h.stderr());
  assert.deepEqual(JSON.parse(readFileSync(h.settingsPath, 'utf8')),
    { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: injectCommand(home) }] }] } });
  assert.ok(h.outLines().some((l) => l.startsWith('inject hook: registered by soma init --inject-hook')), h.stdout());
});

test('init --inject-hook a second time says already registered, and leaves the file alone', async (t) => {
  const home = stateRoot(t);
  const cfg = tmp(t, 'ih-cfg-');
  const first = await initDeps({ home, cfg });
  assert.equal(await dispatch(['init', '--inject-hook'], first.deps), 0, first.stderr());
  age(first.settingsPath);
  const before = fingerprint(first.settingsPath);

  const again = await initDeps({ home, cfg });
  assert.equal(await dispatch(['init', '--inject-hook'], again.deps), 0, again.stderr());
  assert.ok(again.outLines().some((l) => l.startsWith('inject hook: already registered')), again.stdout());
  assert.doesNotMatch(again.stdout(), /registered by soma init --inject-hook/, 'a second run installed nothing and must not say it did');
  assert.deepEqual(fingerprint(again.settingsPath), before, 'the file was rewritten');
  assert.equal(JSON.parse(before.bytes).hooks.UserPromptSubmit.length, 1);
  assert.equal(again.stderr(), '', 'a hook pinned to this root is nothing to warn about');
});

test('init --inject-hook over a hand-wired hook pinned to ANOTHER root warns and exits 2, and changes nothing', async (t) => {
  const home = stateRoot(t);
  const cfg = tmp(t, 'ih-cfg-');
  const h = await initDeps({ home, cfg });
  writeFileSync(h.settingsPath, JSON.stringify(wiredTo('SOMA_HOME=/some/other/root node /hand/bin/hooks/orch-inject.mjs'), null, 2));
  age(h.settingsPath);
  const before = fingerprint(h.settingsPath);
  // A hook reading another fleet's root injects that fleet's events into this orchestrator, or
  // none at all: the install did not happen, and it must not read as success.
  assert.equal(await dispatch(['init', '--inject-hook'], h.deps), 2);
  assert.ok(h.outLines().some((l) => l.startsWith('inject hook: already registered')), h.stdout());
  assert.ok(h.err.length > 0, 'a hook on another root must be warned about');
  assert.deepEqual(fingerprint(h.settingsPath), before, 'soma init does not rewrite a hook somebody else wired');
});

test('init --inject-hook over a hand-wired hook with NO pin warns, and still exits 0', async (t) => {
  const home = stateRoot(t);
  const cfg = tmp(t, 'ih-cfg-');
  const h = await initDeps({ home, cfg });
  writeFileSync(h.settingsPath, JSON.stringify(wiredTo('node /hand/bin/hooks/orch-inject.mjs'), null, 2));
  age(h.settingsPath);
  const before = fingerprint(h.settingsPath);
  assert.equal(await dispatch(['init', '--inject-hook'], h.deps), 0, h.stderr());
  assert.ok(h.outLines().some((l) => l.startsWith('inject hook: already registered')), h.stdout());
  assert.ok(h.err.length > 0, 'an unpinned hook reads ~/.soma unless the session\'s own env says otherwise: warn');
  assert.deepEqual(fingerprint(h.settingsPath), before);
});

test('init --inject-hook on an unparseable settings.json reports NOT registered, exits 2, and leaves the bytes alone', async (t) => {
  const home = stateRoot(t);
  const cfg = tmp(t, 'ih-cfg-');
  const h = await initDeps({ home, cfg });
  writeFileSync(h.settingsPath, '{ "model": "opus", ');
  age(h.settingsPath);
  const before = fingerprint(h.settingsPath);
  assert.equal(await dispatch(['init', '--inject-hook'], h.deps), 2);
  assert.ok(h.errLines().some((l) => l.startsWith('soma init: the inject hook was NOT registered: ')), h.stderr());
  assert.doesNotMatch(h.stdout(), /registered by soma init --inject-hook/);
  assert.deepEqual(fingerprint(h.settingsPath), before, 'a file soma cannot parse is the operator\'s to fix, not soma\'s to replace');
  assert.deepEqual(readdirSync(cfg), ['settings.json']);
});

test('init --inject-hook --seat is refused before anything is installed or written', async (t) => {
  const home = stateRoot(t);
  const cfg = tmp(t, 'ih-cfg-');
  const seat = tmp(t, 'ih-seat-');
  for (const argv of [['init', '--inject-hook', '--seat', seat], ['init', '--seat', seat, '--inject-hook']]) {
    const h = await initDeps({ home, cfg });
    assert.equal(await dispatch(argv, h.deps), 1, JSON.stringify(argv));
    assert.match(h.stderr(), /--inject-hook/, JSON.stringify(argv));
    assert.match(h.stderr(), /--seat/, JSON.stringify(argv));
    assert.equal(h.calls.installSkill.length + h.calls.capture.length + h.calls.installInjectHook.length, 0,
      `${JSON.stringify(argv)}: refused, yet something was installed or registered`);
    assert.deepEqual(readdirSync(cfg), [], `${JSON.stringify(argv)}: refused, yet the fleet's config root was written`);
    assert.deepEqual(readdirSync(seat), [], `${JSON.stringify(argv)}: refused, yet the seat was written`);
    assert.deepEqual(readdirSync(home), [], `${JSON.stringify(argv)}: refused, yet the state tree was created`);
  }
});

test('plain init still only observes: it writes no settings.json, and its "not installed" line names --inject-hook', async (t) => {
  const home = stateRoot(t);

  // A settings.json that registers no inject hook: read, reported absent, left alone.
  const cfg = tmp(t, 'ih-cfg-');
  const h = await initDeps({ home, cfg });
  writeFileSync(h.settingsPath, JSON.stringify({ model: 'opus', hooks: { Stop: [] } }, null, 2));
  age(h.settingsPath);
  const before = fingerprint(h.settingsPath);
  assert.equal(await dispatch(['init'], h.deps), 0, h.stderr());
  assert.match(h.stdout(), /inject hook: NOT installed/);
  assert.match(h.stdout(), /soma init --inject-hook/, 'the line that says the hook is missing must name the command that installs it');
  assert.deepEqual(fingerprint(h.settingsPath), before, 'plain init wrote the operator\'s settings.json');
  assert.deepEqual(h.calls.installInjectHook, [], 'plain init asked for the installer');

  // No settings.json at all: still none afterwards.
  const bare = tmp(t, 'ih-cfg-');
  const b = await initDeps({ home, cfg: bare });
  assert.equal(await dispatch(['init'], b.deps), 0, b.stderr());
  assert.equal(existsSync(b.settingsPath), false, 'plain init created settings.json');
  assert.doesNotMatch(b.stdout(), /registered by soma init --inject-hook/);
  assert.deepEqual(b.calls.installInjectHook, [], 'plain init asked for the installer');
});

test('plain init never resolves the installer: with no installInjectHook dep at all it exits 0 and writes no settings.json', async (t) => {
  // The guard is per path. Only `init --inject-hook` asks for the one dep that writes the operator's
  // settings.json, so a caller that never wired it still has a working plain init.
  const home = stateRoot(t);
  for (const existing of [null, JSON.stringify({ model: 'opus', hooks: { Stop: [] } }, null, 2)]) {
    const what = existing === null ? 'no settings.json' : 'a settings.json without the hook';
    const cfg = tmp(t, 'ih-cfg-');
    const h = await initDeps({ home, cfg });
    delete h.deps.installInjectHook;
    let before = null;
    if (existing !== null) {
      writeFileSync(h.settingsPath, existing);
      age(h.settingsPath);
      before = fingerprint(h.settingsPath);
    }
    assert.equal(await dispatch(['init'], h.deps), 0, `${what}: ${h.stderr()}`);
    assert.equal(h.stderr(), '', `${what}: plain init has nothing to say about an installer it never asks for`);
    if (before === null) assert.equal(existsSync(h.settingsPath), false, `${what}: plain init created settings.json`);
    else assert.deepEqual(fingerprint(h.settingsPath), before, `${what}: plain init wrote the operator's settings.json`);
  }
});

test('init --inject-hook with no installer dep throws the guarded-dep TypeError naming it, and writes no settings.json', async (t) => {
  const home = stateRoot(t);
  for (const [what, unwire] of [
    ['absent', (deps) => { delete deps.installInjectHook; }],
    // a result where the function should be: present, truthy, and still no installer
    ['not a function', (deps) => { deps.installInjectHook = { ok: true, action: 'added', pins: 'this' }; }],
  ]) {
    const cfg = tmp(t, 'ih-cfg-');
    const h = await initDeps({ home, cfg });
    unwire(h.deps);
    await assert.rejects(() => dispatch(['init', '--inject-hook'], h.deps), (e) => {
      assert.ok(e instanceof TypeError, `${what}: not a TypeError: ${e?.stack ?? e}`);
      assert.match(e.message, /^soma init: dependency "installInjectHook" is missing or is not a function\./, what);
      return true;
    });
    assert.equal(existsSync(h.settingsPath), false, `${what}: settings.json was written with no installer to write it`);
  }
});
