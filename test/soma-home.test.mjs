import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * `test/soma-home.mjs` keeps every test process off a real state root. These pin that from three
 * sides: every test file loads it before anything else, it does what its header says, and the
 * `npm test` script no longer makes a root of its own.
 *
 * Measured before it existed, with `SOMA_HOME` unset and a fake `HOME`: run on its own,
 * `spawn.test.mjs` wrote `guardpin-*`, `seats-*`, `leads/cr-1`, `leads/cr-2`, `leads/cr-ban` and the
 * whole state tree into `$HOME/.soma`. With `SOMA_HOME` pointing at a fake live root, it wrote the
 * same set there. Only the `npm test` script set a throwaway root, so every other way of starting
 * a test file ran against the real one.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(HERE, 'soma-home.mjs');
const HELPER_URL = pathToFileURL(HELPER).href;
const PATHS_URL = new URL('../bin/lib/paths.mjs', import.meta.url).href;

/** A throwaway directory, removed when the test ends. */
const tmp = (t, prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Every file the `npm test` glob, `test/**\/*.test.mjs`, runs. */
const testFiles = () => readdirSync(HERE, { recursive: true })
  .filter((rel) => rel.endsWith('.test.mjs'))
  .map((rel) => join(HERE, rel))
  .sort();

/** The first line of `src` that is neither blank nor part of a comment. */
const firstCodeLine = (src) => {
  let inBlock = false;
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (inBlock) { if (line.includes('*/')) inBlock = false; continue; }
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('/*')) { inBlock = !line.includes('*/', 2); continue; }
    return line;
  }
  return null;
};

test('every test file imports soma-home.mjs first, before any module that could read the environment', () => {
  const files = testFiles();
  // The walk itself, checked: a walk that found nothing would pass the loop below vacuously.
  for (const known of ['soma-home.test.mjs', 'spawn.test.mjs']) {
    assert.ok(files.includes(join(HERE, known)), `the test-file walk missed ${known}: ${files.map((f) => relative(HERE, f))}`);
  }
  const wrong = [];
  for (const file of files) {
    let spec = relative(dirname(file), HELPER).split(sep).join('/');
    if (!spec.startsWith('.')) spec = `./${spec}`;
    const first = firstCodeLine(readFileSync(file, 'utf8'));
    if (first !== `import '${spec}';`) wrong.push(`${relative(HERE, file)} starts with: ${first}`);
  }
  // Modules are evaluated in import order, so only the first import is sure to run before every
  // other module's load-time code. `lib/tmux.mjs` already captures `SOMA_TMUX_SOCKET` at load time;
  // a module that did the same with `SOMA_HOME` would keep whatever root it found.
  assert.deepEqual(wrong, [],
    `each of these must open with \`import './soma-home.mjs';\` (after any header comment), or run on its own it writes into the shell's SOMA_HOME or ~/.soma:\n  ${wrong.join('\n  ')}`);
});

test('the npm test script leaves the state root to soma-home.mjs: it neither sets SOMA_HOME nor runs mktemp', () => {
  // The script used to be `SOMA_HOME="${SOMA_TEST_HOME:-$(mktemp -d)}" node --test …`, and nothing
  // ever removed that directory. No TMPDIR-scoped check sees it on macOS: measured on macOS 26,
  // `mktemp -d` ignores TMPDIR and makes it in the per-user temp dir. So on a Mac nothing but this
  // pin notices the script making one again. The exact script is deliberately not pinned, only
  // the two things it must not do.
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(typeof scripts?.test, 'string', 'package.json has no test script');
  assert.doesNotMatch(scripts.test, /\bSOMA_HOME\b/,
    'the test script must not set SOMA_HOME: soma-home.mjs sets it in every test process and ignores an inherited one, and a root set in the script protected `npm test` alone');
  assert.doesNotMatch(scripts.test, /\bmktemp\b/,
    'the test script must not make a directory: nothing removes one made there. soma-home.mjs makes each process its own root and removes it on exit');
});

/**
 * A child node whose first import is the helper, which is how every test file loads it, started
 * with nothing in its environment but PATH and `env`: nothing from the process running this test
 * reaches it. It builds the state tree through `bin/lib/paths.mjs`, as the tests do, and reports
 * the root that tree landed in and the temp dir it saw.
 */
const child = (env) => {
  const code = [
    `import ${JSON.stringify(HELPER_URL)};`,
    `import { tmpdir } from 'node:os';`,
    `import { SOMA_HOME, ensureTree } from ${JSON.stringify(PATHS_URL)};`,
    'ensureTree();',
    'process.stdout.write(JSON.stringify({ home: SOMA_HOME(), tmp: tmpdir() }));',
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { PATH: process.env.PATH, ...env }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, `the child failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
};

const TREE = ['digests', 'events', 'heartbeats', 'leads', 'logs', 'state', 'worktrees'];

test('with SOMA_HOME unset, a test process gets a fresh root in its temp dir, not ~/.soma, and it is removed on exit', (t) => {
  const home = tmp(t, 'home-');
  const temp = tmp(t, 'tmpdir-');
  const seen = child({ HOME: home, TMPDIR: temp });
  assert.equal(seen.tmp, temp, 'the child must see the TMPDIR it was given, or the checks below prove nothing');
  assert.equal(dirname(seen.home), temp, `the state root was ${seen.home}, not a fresh directory in the child's temp dir`);
  assert.equal(existsSync(join(home, '.soma')), false, 'the test process wrote into $HOME/.soma');
  assert.equal(existsSync(seen.home), false, `the state root ${seen.home} outlived the process that made it`);
  assert.deepEqual(readdirSync(temp), [], 'the process left something in its temp dir');
});

test('an inherited SOMA_HOME is never used: the live root it names stays untouched', (t) => {
  const home = tmp(t, 'home-');
  const temp = tmp(t, 'tmpdir-');
  const live = tmp(t, 'live-');
  const seen = child({ HOME: home, TMPDIR: temp, SOMA_HOME: live });
  assert.notEqual(seen.home, live, 'the test process ran against the SOMA_HOME its shell exported');
  assert.equal(dirname(seen.home), temp, `the state root was ${seen.home}, not a fresh directory in the child's temp dir`);
  assert.deepEqual(readdirSync(live), [], 'the inherited root gained files');
  assert.equal(existsSync(join(home, '.soma')), false, 'the test process wrote into $HOME/.soma');
  assert.deepEqual(readdirSync(temp), [], 'the fresh root outlived the process that made it');
});

test('SOMA_TEST_HOME is the root as given and is never removed: the caller owns it', (t) => {
  const home = tmp(t, 'home-');
  const temp = tmp(t, 'tmpdir-');
  const live = tmp(t, 'live-');
  const given = tmp(t, 'given-');
  const seen = child({ HOME: home, TMPDIR: temp, SOMA_HOME: live, SOMA_TEST_HOME: given });
  assert.equal(seen.home, given, 'SOMA_TEST_HOME must win over an inherited SOMA_HOME, as it did in the npm script');
  assert.deepEqual(readdirSync(given).sort(), TREE,
    'the caller\'s directory, and what the test wrote into it, must still be there after the process exits');
  assert.deepEqual(readdirSync(live), [], 'the inherited root gained files');
  assert.deepEqual(readdirSync(temp), [], 'a root was made in the temp dir although the caller supplied one');
});
