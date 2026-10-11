import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * `bin/soma-pr.mjs` is the only PR-creation path a lead's team is allowed to use,
 * so "always draft" has to hold at the process boundary, not just in a pure
 * function. Three layers of tests, therefore:
 *
 *   buildPrArgs — the argv contract, asserted directly, and asserted
 *   *structurally* over a generated corpus of draft spellings rather than over a
 *   hand-listed few. A hand-listed few is exactly how the shorthand-cluster
 *   bypass (`-fd=false`) shipped in the first version of this file.
 *
 *   entryUrls — the direct-run guard's inputs, which no end-to-end test can
 *   discriminate on a Node that has `import.meta.main`.
 *
 *   the wrapper as a process — run with a fake `gh` first on PATH that records
 *   the argv it was handed. That is the vector a real `gh` would see, and it is
 *   the only way to prove the guard fires at all (a guard that quietly fails
 *   closed exits 0 having created nothing, which reads to a lead exactly like a
 *   PR that exists).
 */
const WRAPPER = fileURLToPath(new URL('../bin/soma-pr.mjs', import.meta.url));

/**
 * A directory holding a fake `gh`, meant to go first on PATH.
 *
 * The stub appends one line per argument to `$SOMA_PR_TEST_ARGV` before running
 * `tail`, so a test can assert on the exact vector *and* on what the wrapper
 * does with gh's output/exit code. `t.after` removes the dir: `npm test` runs
 * the whole suite in one process, so a leaked mkdtemp per test is a real leak.
 */
function fakeGh(t, tail = 'echo https://github.com/o/r/pull/7\n') {
  const dir = mkdtempSync(join(tmpdir(), 'soma-pr-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "$SOMA_PR_TEST_ARGV"; done\n${tail}`);
  chmodSync(gh, 0o755);
  return { dir, argvLog: join(dir, 'argv.txt') };
}

/** Run `node <script> <args…>` with the fake gh in front of PATH. */
const run = (script, args, { dir, argvLog }, env = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: dir + delimiter + process.env.PATH, SOMA_PR_TEST_ARGV: argvLog, ...env },
  });

/** The argument vector the fake gh recorded (one arg per line, trailing newline dropped). */
const recorded = (argvLog) => readFileSync(argvLog, 'utf8').split('\n').slice(0, -1);

/** How many times `needle` occurs in `text` — "exactly once" is a real assertion here. */
const count = (text, needle) => text.split(needle).length - 1;

/** symlink() needs no privileges here, but a filesystem may still refuse it. */
function symlinkOrFail(link, target) {
  try {
    symlinkSync(target, link);
  } catch (e) {
    assert.fail(`cannot symlink on this filesystem: ${e.message}`);
  }
}

/**
 * Any token that can hand the draft flag a value the *caller* chose. This is the
 * dangerous class, and nothing in it may survive into the vector gh sees.
 *
 * pflag walks a shorthand cluster character by character, so the `d=` that ends
 * one lands on `--draft` however many letters precede it — gh says so itself:
 * `gh pr create -fd=notabool` answers `invalid argument "notabool" for
 * "-d, --draft" flag`. A bare `-d`/`-fd` (no assignment) can only take pflag's
 * NoOptDefVal, i.e. set draft *true*, and is therefore not in this class.
 */
const SETS_DRAFT_VALUE = /^(--draft=|-[A-Za-z]*d=)/;

/** The wider shape a draft flag can take — the review's structural predicate. */
const LOOKS_LIKE_DRAFT = /^-[A-Za-z]*d(=|$)/;

/** Every shorthand `gh pr create` 2.76.1 defines, so the sweep is over its real alphabet. */
const SHORTHANDS = 'aBbFdefHlmprTtw';

/** Every spelling that can switch draft off, including one per shorthand cluster. */
const DRAFT_OFF_TOKENS = [
  '--draft=false', '--draft=FALSE', '--draft=0',
  '-d=false', '-d=0',
  ...[...SHORTHANDS].map((c) => `-${c}d=false`),
  '-dd=false', '-fd=false', '-wd=false', '-ed=false',
  '-fwd=false', '-wed=false',
];

// --- the contract, as originally specified -----------------------------------

test('soma-pr always injects --draft exactly once', async () => {
  const m = await import('../bin/soma-pr.mjs?' + Date.now());
  assert.ok(m.buildPrArgs(['--title', 't', '--body', 'b']).includes('--draft'));
  const twice = m.buildPrArgs(['--draft', '--title', 't']);
  // CHANGED from the original `1`, on review instruction, and it is the only
  // assertion in this file that was weakened rather than added to: the vector now
  // carries a `--draft` at each end. The leading one cannot be eaten as another
  // flag's value; the trailing one wins pflag's last-occurrence tie against any
  // draft spelling the filter has not thought of. The caller's own `--draft` is
  // still gone, which is what this test was pinning — one token in, two of ours
  // out, never the caller's.
  assert.equal(twice.filter((a) => a === '--draft').length, 2);
  assert.equal(twice.at(0), 'pr');
  assert.equal(twice.at(2), '--draft');
  assert.equal(twice.at(-1), '--draft');
});

// --- buildPrArgs -------------------------------------------------------------

test('buildPrArgs keeps the caller argv and brackets it with --draft', async () => {
  const { buildPrArgs } = await import('../bin/soma-pr.mjs?shape');

  assert.deepEqual(buildPrArgs(['--title', 't', '--body', 'b']),
    ['pr', 'create', '--draft', '--title', 't', '--body', 'b', '--draft']);
  assert.deepEqual(buildPrArgs([]), ['pr', 'create', '--draft', '--draft']);
  assert.deepEqual(buildPrArgs(), ['pr', 'create', '--draft', '--draft']);

  // The leading position is load-bearing. A value-expecting flag left at the end
  // of the caller's argv — `--title` whose value was forgotten, or whose value we
  // just stripped — swallows the next token as its value (verified against gh
  // 2.76.1: `gh pr create --title --draft` parses, and gh then reports the *body*
  // missing). Only the trailing flag is edible, and the leading one still marks
  // the PR a draft.
  assert.equal(buildPrArgs(['--title'])[2], '--draft');
  assert.deepEqual(buildPrArgs(['--body', '--draft']), ['pr', 'create', '--draft', '--body', '--draft']);
});

test('no draft spelling in the sweep survives buildPrArgs', async () => {
  const { buildPrArgs } = await import('../bin/soma-pr.mjs?sweep');

  // Structural, not a list of the ones somebody remembered: whatever the caller
  // passed, the vector gh sees must contain no token that can set draft to a
  // caller-chosen value. `-fd=false` alone was a complete ready-for-review PR
  // (`-f` is `--fill`, which takes title and body from the commits).
  for (const off of DRAFT_OFF_TOKENS) {
    const args = buildPrArgs([off, '--title', 't', '--body', 'b']);
    assert.deepEqual(args.filter((a) => SETS_DRAFT_VALUE.test(a)), [], `reached gh: ${off}`);
    assert.deepEqual(args.filter((a) => LOOKS_LIKE_DRAFT.test(a)), [], `reached gh: ${off}`);
    assert.deepEqual(args, ['pr', 'create', '--draft', '--title', 't', '--body', 'b', '--draft'], `bad vector for ${off}`);
  }

  // Bare `-d` too, which pflag can only read as true, but which has no business
  // reaching gh from a caller either.
  assert.deepEqual(buildPrArgs(['-d', '--title', 't']), ['pr', 'create', '--draft', '--title', 't', '--draft']);

  // A cluster with no assignment survives on purpose: it can only take pflag's
  // NoOptDefVal, i.e. set draft *true*. `-dfw=false` is this case too — the `=`
  // lands on `w`(eb), not on `d`.
  for (const harmless of ['-fd', '-df', '-dfw=false']) {
    assert.ok(buildPrArgs([harmless]).includes(harmless), `wrongly stripped: ${harmless}`);
    assert.deepEqual(buildPrArgs([harmless]).filter((a) => SETS_DRAFT_VALUE.test(a)), []);
  }

  // Only draft flags go. A `draft` *substring* is somebody's branch or label.
  assert.deepEqual(buildPrArgs(['--head', 'soma/draft-fix', '--label', 'draft', '--body', '-d=false']), [
    'pr', 'create', '--draft', '--head', 'soma/draft-fix', '--label', 'draft', '--body', '--draft',
  ]);
});

test('buildPrArgs returns a fresh array and leaves the caller argv alone', async () => {
  const { buildPrArgs } = await import('../bin/soma-pr.mjs?pure');
  const userArgs = ['--draft', '--title', 't'];
  const a = buildPrArgs(userArgs);
  const b = buildPrArgs(userArgs);

  assert.deepEqual(userArgs, ['--draft', '--title', 't']);
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
});

// --- the direct-run guard's inputs -------------------------------------------

test('entryUrls offers both the spelled and the resolved entry path', async (t) => {
  const { entryUrls } = await import('../bin/soma-pr.mjs?entry');
  const dir = mkdtempSync(join(tmpdir(), 'soma pr entry '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'soma-pr.mjs');
  const link = join(dir, 'link.mjs');
  copyFileSync(WRAPPER, target);
  symlinkOrFail(link, target);

  // The space half: `import.meta.url` percent-encodes it, a raw
  // `file://${process.argv[1]}` does not.
  assert.ok(entryUrls(target).every((u) => u.includes('%20')), entryUrls(target).join(' '));

  // The symlink half, which `pathToFileURL` alone does NOT fix — it resolves
  // relative paths, never symlinks, while the ESM loader realpaths by default.
  // On this machine even `mkdtemp` is behind one (`/var` -> `/private/var`).
  assert.ok(entryUrls(link).includes(pathToFileURL(realpathSync.native(link)).href), entryUrls(link).join(' '));
  assert.ok(entryUrls(link).includes(pathToFileURL(link).href), 'the unresolved spelling must stay a candidate');

  // `node -e` has no entry file at all. Asserted with a falsy-but-not-undefined
  // argument, because `undefined` is what re-triggers the `process.argv[1]`
  // default — which is exactly what the real `node -e` case evaluates to, and
  // that path is covered end to end by "importing the module runs no gh".
  for (const nothing of [null, '', 0]) assert.deepEqual(entryUrls(nothing), [], JSON.stringify(nothing));
});

// --- the wrapper as a process ------------------------------------------------

test('the wrapper execs gh with the built argv and passes gh stdout through', async (t) => {
  const gh = fakeGh(t);
  const r = run(WRAPPER, ['--title', 't', '--body', 'b'], gh);

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(recorded(gh.argvLog), ['pr', 'create', '--draft', '--title', 't', '--body', 'b', '--draft']);
  assert.match(r.stdout, /^https:\/\/github\.com\/o\/r\/pull\/7\n$/);
});

test('no caller can talk the wrapper out of --draft', async (t) => {
  const gh = fakeGh(t);
  // `-fd=false` is the whole bypass in one token; the rest are the family it came
  // from. Passed through the real wrapper, not just the pure function.
  const r = run(WRAPPER, ['--draft', '--draft=false', '-d', '-d=false', '-dd=false', '-fd=false', '-wd=false',
    '-ed=false', '--title', 't', '--body', 'b'], gh);
  const argv = recorded(gh.argvLog);

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(argv.filter((a) => SETS_DRAFT_VALUE.test(a)), []);
  assert.deepEqual(argv.filter((a) => LOOKS_LIKE_DRAFT.test(a)), []);
  assert.equal(argv.filter((a) => a === '--draft').length, 2);
  assert.deepEqual(argv, ['pr', 'create', '--draft', '--title', 't', '--body', 'b', '--draft']);
});

test('a gh failure exits 1 and reports gh stderr exactly once', async (t) => {
  const gh = fakeGh(t, 'echo "gh: could not create pull request: BOOM" >&2\nexit 4\n');
  const r = run(WRAPPER, ['--title', 't', '--body', 'b'], gh);

  // execFileSync forwards the child's stderr to ours whenever no `stdio` is
  // passed, so writing `e.stderr` in the catch would print every gh error
  // twice. gh's own text is the whole diagnostic; it must arrive once.
  assert.equal(r.status, 1);
  assert.equal(count(r.stderr, 'BOOM'), 1, r.stderr);
});

test('a missing gh exits 1 naming the PATH problem, not a silent success', async (t) => {
  const gh = fakeGh(t);
  const empty = mkdtempSync(join(tmpdir(), 'soma-pr-nopath-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));

  // A lead is spawned under `env -i`; a curated PATH without gh is a live failure
  // mode, and it is the one case where gh produces no stderr to lean on.
  const r = run(WRAPPER, ['--title', 't'], gh, { PATH: empty });

  assert.equal(r.status, 1);
  assert.match(r.stderr, /gh not found on PATH/);
  assert.equal(existsSync(gh.argvLog), false);
});

test('importing the module runs no gh', async (t) => {
  const gh = fakeGh(t);
  const src = `import { buildPrArgs } from ${JSON.stringify(pathToFileURL(WRAPPER).href)};`
    + `process.stdout.write(buildPrArgs(['--title', 't']).join(' '));`;
  const r = run('--input-type=module', ['-e', src], gh);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'pr create --draft --title t --draft');
  assert.equal(existsSync(gh.argvLog), false, 'importing soma-pr must not exec gh');
});

test('the direct-run guard survives a path with a space and a symlink', async (t) => {
  const gh = fakeGh(t);
  const spacey = mkdtempSync(join(tmpdir(), 'soma pr space '));
  t.after(() => rmSync(spacey, { recursive: true, force: true }));
  const copy = join(spacey, 'soma-pr.mjs');
  const link = join(spacey, 'linked-soma-pr.mjs');
  copyFileSync(WRAPPER, copy);
  symlinkOrFail(link, copy);

  // Space: `import.meta.url` percent-encodes it and a raw interpolation does not.
  // Symlink: the ESM loader realpaths and `process.argv[1]` does not — and on
  // macOS `mkdtemp` is already behind `/var` -> `/private/var`. Either mismatch
  // is a wrapper that exits 0 having created nothing.
  for (const entry of [copy, link]) {
    rmSync(gh.argvLog, { force: true });
    const r = run(entry, ['--title', 't'], gh);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(recorded(gh.argvLog), ['pr', 'create', '--draft', '--title', 't', '--draft'], entry);
  }
});
