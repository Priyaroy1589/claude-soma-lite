/**
 * A throwaway state root for every test process, set before anything else in it runs.
 *
 * Not a test file (the `test/**\/*.test.mjs` glob skips it). Every test file imports it first, as
 * `import './soma-home.mjs';`, and `soma-home.test.mjs` fails for any file that does not.
 *
 * The rule used to live in the `npm test` script alone:
 *
 *   SOMA_HOME="${SOMA_TEST_HOME:-$(mktemp -d)}" node --test "test/**\/*.test.mjs"
 *
 * so a test file started any other way (`node --test test/spawn.test.mjs`, an editor's test
 * runner) ran against whatever `SOMA_HOME` its shell had, or `~/.soma` when it had none. Measured
 * that way, `spawn.test.mjs` wrote `guardpin-*`, `seats-*`, `leads/cr-1`, `leads/cr-2`,
 * `leads/cr-ban` and the whole state tree into the root it found. A shell with `SOMA_HOME` set is
 * not an edge case: `buildLeadEnv` hands every lead its fleet's root, so a lead that runs one test
 * file in its worktree runs it against the live fleet.
 *
 * The rule is the script's, applied in each test process instead of once per run:
 *
 *   - `$SOMA_TEST_HOME` set: that directory is the state root. The caller owns it (it is how you
 *     keep what a test left behind, to inspect it), so it is never removed.
 *   - otherwise: a fresh `soma-test-*` directory in the system temp dir, removed when the process
 *     exits. The script never removed the one it made.
 *
 * An inherited `$SOMA_HOME` is never used. Removal runs on `exit`, so a process killed by a signal
 * leaves its directory behind: no exit handler runs then.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

if (process.env.SOMA_TEST_HOME) {
  process.env.SOMA_HOME = process.env.SOMA_TEST_HOME;
} else {
  const home = mkdtempSync(join(tmpdir(), 'soma-test-'));
  process.env.SOMA_HOME = home;
  process.on('exit', () => rmSync(home, { recursive: true, force: true }));
}
