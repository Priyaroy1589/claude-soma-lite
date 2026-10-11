import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

/**
 * A fresh state root plus a fresh `worktree.mjs` pointed at it.
 *
 * `tag` (not `Date.now()`) busts the module cache, so two tests starting inside the same
 * millisecond still get their own instance — which matters here because the re-entrancy
 * flag is module-level state. `t.after` removes the mkdtemp dir, since `npm test` runs
 * the whole suite in one process.
 */
async function fresh(t, tag) {
  const home = mkdtempSync(join(tmpdir(), 'soma-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.SOMA_HOME = home;
  const { ensureTree, p } = await import('../bin/lib/paths.mjs?' + tag);
  ensureTree();
  return { home, p, w: await import('../bin/lib/worktree.mjs?' + tag) };
}

/** A recording `run` stub: `reply(joined, args)` returns `{stdout, code}` or undefined for the default. */
function stub(reply = () => undefined) {
  const cmds = [];
  const run = (args) => {
    const joined = args.join(' ');
    cmds.push(joined);
    return reply(joined, args) ?? { stdout: '', code: 0 };
  };
  return { cmds, run };
}

/** One `git worktree list` row in git's default (space-padded) format. */
const row = (dir, branch = 'soma/x', sha = 'deadbee') => `${dir}  ${sha} [${branch}]`;

/**
 * The error `fn` threw, for the cases where one `assert.throws` regex is not the whole
 * claim — an error that has to carry a path *and* an errno *and* a remedy needs an
 * assertion per part, so a message that keeps one and drops the rest cannot pass.
 */
const capture = (fn, why) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return assert.fail(`expected a throw: ${why}`);
};

// ---------------------------------------------------------------------------
// The two tests below are the original spec, verbatim but for a `fresh()`
// that cleans up after itself.
// ---------------------------------------------------------------------------

test('ensureWorktree fetches remote base and bases branch on origin/<base>', async (t) => {
  const { w } = await fresh(t, 'spec-1');
  const cmds = [];
  const run = (args) => { cmds.push(args.join(' ')); if (args.includes('rev-parse')) return { stdout: 'abc123\n', code: 0 }; return { stdout: '', code: 0 }; };
  const r = w.ensureWorktree({ repo: 'acme-app', taskId: 'cr-1', base: 'develop', repoPath: '/repo' }, run);
  assert.ok(cmds.some((c) => c.includes('fetch origin develop')));
  assert.ok(cmds.some((c) => c.includes('worktree add') && c.includes('-b soma/cr-1') && c.includes('origin/develop')));
  assert.equal(r.branch, 'soma/cr-1');
  assert.equal(r.base_sha, 'abc123');
});

test('retry of an existing dirty worktree recreates with -r2 suffix', async (t) => {
  const { w } = await fresh(t, 'spec-2');
  const cmds = [];
  const run = (args) => {
    cmds.push(args.join(' '));
    if (args.includes('rev-parse')) return { stdout: 'sha\n', code: 0 };
    if (args.join(' ').includes('worktree list')) return { stdout: `${process.env.SOMA_HOME}/worktrees/acme-app/cr-1 sha [soma/cr-1]\n`, code: 0 };
    if (args.includes('status') && args.includes('--porcelain')) return { stdout: ' M file.ts\n', code: 0 }; // dirty
    return { stdout: '', code: 0 };
  };
  const r = w.ensureWorktree({ repo: 'acme-app', taskId: 'cr-1', base: 'develop', repoPath: '/repo' }, run);
  assert.equal(r.branch, 'soma/cr-1-r2');
  assert.ok(cmds.some((c) => c.includes('worktree remove') && c.includes('--force')));
});

// ---------------------------------------------------------------------------
// The rest pin what the spec tests leave open, and each one is a defect the
// first sample implementation had.
// ---------------------------------------------------------------------------

test('the command sequence is fetch -> rev-parse -> list -> add, all against the repo', async (t) => {
  const { w, p } = await fresh(t, 'sequence');
  const { cmds, run } = stub((j) => (j.includes('rev-parse origin/develop') ? { stdout: 'abc123\n', code: 0 } : undefined));
  const r = w.ensureWorktree({ repo: 'app', taskId: 'cr-1', base: 'develop', repoPath: '/repo' }, run);

  assert.deepEqual(cmds, [
    '-C /repo fetch origin develop',
    '-C /repo rev-parse origin/develop',
    '-C /repo worktree list',
    '-C /repo branch --list soma/cr-1',
    `-C /repo worktree add ${p('worktrees', 'app', 'cr-1')} --no-track -b soma/cr-1 origin/develop`,
  ]);
  // `excluded: false` only because a stubbed `git worktree add` creates no checkout:
  // the ignore rule is never written into a directory that is not there. The real-git
  // test is what pins that it lands, and that it works.
  assert.deepEqual(r, { dir: p('worktrees', 'app', 'cr-1'), branch: 'soma/cr-1', base_sha: 'abc123', reused: false, excluded: false });
  // The dir lives under the state root, and its parent is created for git.
  assert.equal(existsSync(p('worktrees', 'app')), true);
  // `--no-track` is load-bearing: a branch that tracks origin/<base> lets a bare
  // `git push` (push.default=upstream) write straight to the auto-deploying base
  // branch, which the writeback guard's command-text deny cannot see coming.
  assert.ok(cmds.some((c) => c.includes('--no-track')));
  // The lock is per-repo, taken for the whole operation, and always released.
  assert.equal(existsSync(p('state', 'repo-app.lock')), false);
});

test('a worktree dir that is only a PREFIX of a listed one is not mistaken for it', async (t) => {
  const { w, p } = await fresh(t, 'prefix');
  // `worktrees/app/cr-1` is a substring of `worktrees/app/cr-10`: a naive
  // `listed.includes(dir)` reads cr-10's row as cr-1's own worktree, judges the
  // missing dir dirty, and hands the FIRST attempt of cr-1 a `-r2` branch.
  const { cmds, run } = stub((j) => {
    if (j.includes('rev-parse')) return { stdout: 'abc123\n', code: 0 };
    if (j.includes('worktree list')) return { stdout: `${p('worktrees', 'app', 'cr-10')}  sha [soma/cr-10]\n`, code: 0 };
    return undefined;
  });
  const r = w.ensureWorktree({ repo: 'app', taskId: 'cr-1', base: 'develop', repoPath: '/repo' }, run);
  assert.equal(r.branch, 'soma/cr-1');
  assert.equal(r.reused, false);
  assert.equal(cmds.some((c) => c.includes('worktree remove')), false, 'cr-10 was destroyed on cr-1 behalf');
  assert.equal(cmds.some((c) => c.includes('status')), false, 'a worktree that does not exist must not be probed');
});

test('a clean existing worktree is reused, and reports the branch it is actually on', async (t) => {
  const { w, p } = await fresh(t, 'reuse');
  const dir = p('worktrees', 'app', 'cr-1');
  const { cmds, run } = stub((j) => {
    if (j.includes('rev-parse origin/develop')) return { stdout: 'abc123\n', code: 0 };
    if (j.includes('worktree list')) return { stdout: `${row(dir, 'soma/cr-1-r2')}\n`, code: 0 };
    return undefined; // status --porcelain -> '' -> clean
  });
  const r = w.ensureWorktree({ repo: 'app', taskId: 'cr-1', base: 'develop', repoPath: '/repo' }, run);

  // Reporting the nominal `soma/cr-1` here would name a branch this checkout is
  // not on — and `soma/cr-1` still exists from attempt 1, so the lie is not even
  // self-evident: soma-pr would open a PR from the wrong head.
  assert.deepEqual(r, { dir, branch: 'soma/cr-1-r2', base_sha: 'abc123', reused: true, excluded: false });
  assert.equal(cmds.some((c) => c.includes('worktree remove')), false);
  assert.equal(cmds.some((c) => c.includes('worktree add')), false, 'a reused worktree must not be re-added');
});

test('a clean worktree that is not on this task\'s branch is not reused either', async (t) => {
  const { w, p } = await fresh(t, 'foreign');
  const dir = p('worktrees', 'app', 'cr-1');
  // Clean is not enough. A detached HEAD, or a worktree someone else put at soma's
  // path, would be handed back as "the lead's branch" — and the lead would commit
  // wherever that is and soma-pr would open the PR from it.
  for (const [row_, expect] of [[`${dir}  sha (detached HEAD)`, 'soma/cr-1-r2'], [`${dir}  sha [develop]`, 'soma/cr-1-r2']]) {
    const { cmds, run } = stub((j) => {
      if (j.includes('rev-parse')) return { stdout: 'abc123\n', code: 0 };
      if (j.includes('worktree list')) return { stdout: `${row_}\n`, code: 0 };
      return undefined; // status --porcelain -> clean
    });
    const r = w.ensureWorktree({ repo: 'app', taskId: 'cr-1', base: 'develop', repoPath: '/repo' }, run);
    assert.equal(r.reused, false, `reused a worktree on ${row_}`);
    assert.equal(r.branch, expect);
    assert.ok(cmds.some((c) => c.includes('worktree remove') && c.includes('--force')));
  }
});

test('the retry suffix climbs past -r2 and stays inside the task namespace', async (t) => {
  const { w, p } = await fresh(t, 'suffix');
  const dir = p('worktrees', 'app', 'cr-1');
  const attempt = (branch) => {
    const { run } = stub((j) => {
      if (j.includes('rev-parse')) return { stdout: 'abc123\n', code: 0 };
      if (j.includes('worktree list')) return { stdout: `${row(dir, branch)}\n`, code: 0 };
      if (j.includes('status --porcelain')) return { stdout: ' M a\n', code: 0 };
      return undefined;
    });
    return w.ensureWorktree({ repo: 'app', taskId: 'cr-1', base: 'develop', repoPath: '/repo' }, run).branch;
  };
  // A fixed `-r2` (as first sketched) fails on the third attempt: `worktree add -b
  // soma/cr-1-r2` is refused because that branch already exists (verified on git
  // 2.39.5), and the retry dies at spawn — the very failure this step exists for.
  assert.equal(attempt('soma/cr-1'), 'soma/cr-1-r2');
  assert.equal(attempt('soma/cr-1-r2'), 'soma/cr-1-r3');
  assert.equal(attempt('soma/cr-1-r9'), 'soma/cr-1-r10');
  // Not derived from an unrelated branch's suffix: the lead's branch must always
  // be recognizable as this task's.
  assert.equal(attempt('feature/someone-else-r4'), 'soma/cr-1-r2');
  assert.equal(attempt('(detached HEAD)'), 'soma/cr-1-r2');
});

test('a branch that outlived its worktree does not block the respawn', async (t) => {
  const { w, p } = await fresh(t, 'branch-taken');
  // The branch is deliberately kept when a worktree is removed (a draft PR points at
  // it), so "no worktree registered" does NOT mean "the name is free": `worktree add
  // -b soma/cr-1` is refused by git, and the task could never be spawned again.
  const taken = new Set(['soma/cr-1', 'soma/cr-1-r2', 'soma/cr-1-r3']);
  const { cmds, run } = stub((j, args) => {
    if (j.includes('rev-parse')) return { stdout: 'abc123\n', code: 0 };
    if (j.includes('branch --list')) return { stdout: taken.has(args.at(-1)) ? `  ${args.at(-1)}\n` : '', code: 0 };
    return undefined;
  });
  const r = w.ensureWorktree({ repo: 'app', taskId: 'cr-1', base: 'develop', repoPath: '/repo' }, run);
  assert.equal(r.branch, 'soma/cr-1-r4');
  assert.equal(r.reused, false);
  assert.ok(cmds.includes('-C /repo branch --list soma/cr-1-r4'));
  assert.ok(cmds.some((c) => c.includes('worktree add') && c.includes('-b soma/cr-1-r4')));
  assert.equal(existsSync(p('state', 'repo-app.lock')), false);

  // A task whose whole namespace is taken is a fleet problem: say which repo to
  // clean up rather than looping or silently reusing a live branch.
  const all = stub((j) => (j.includes('rev-parse') ? { stdout: 'abc123\n', code: 0 } : (j.includes('branch --list') ? { stdout: '  x\n', code: 0 } : undefined)));
  assert.throws(() => w.ensureWorktree({ repo: 'app', taskId: 'cr-1', base: 'develop', repoPath: '/repo' }, all.run), /already exist/);
  assert.equal(all.cmds.some((c) => c.includes('worktree add')), false);
});

test('a worktree whose cleanliness cannot be established is recreated, not reused', async (t) => {
  const { w, p } = await fresh(t, 'unverifiable');
  const dir = p('worktrees', 'app', 'cr-1');
  // The dir was deleted under a registered worktree: `git -C <dir> status` exits
  // 128 with an empty stdout, which reads as "clean" to a check that only looks at
  // the output — and the lead would be launched into a cwd that does not exist.
  const { cmds, run } = stub((j) => {
    if (j.includes('rev-parse')) return { stdout: 'abc123\n', code: 0 };
    if (j.includes('worktree list')) return { stdout: `${row(dir, 'soma/cr-1')}\n`, code: 0 };
    if (j.includes('status --porcelain')) return { stdout: '', code: 128 };
    return undefined;
  });
  const r = w.ensureWorktree({ repo: 'app', taskId: 'cr-1', base: 'develop', repoPath: '/repo' }, run);
  assert.equal(r.reused, false);
  assert.equal(r.branch, 'soma/cr-1-r2');
  assert.ok(cmds.some((c) => c.includes('worktree remove') && c.includes('--force')));
});

test('a failed remove falls back to prune, and the clearance is verified not assumed', async (t) => {
  const { w, p } = await fresh(t, 'prune');
  const dir = p('worktrees', 'app', 'cr-1');

  // The prune works: the second `worktree list` no longer carries the row.
  let listings = 0;
  const { cmds, run } = stub((j) => {
    if (j.includes('rev-parse')) return { stdout: 'abc123\n', code: 0 };
    if (j.includes('worktree list')) return { stdout: listings++ === 0 ? `${row(dir, 'soma/cr-1')}\n` : '', code: 0 };
    if (j.includes('status --porcelain')) return { stdout: ' M a\n', code: 0 };
    if (j.includes('worktree remove')) return { stdout: 'fatal: not a working tree', code: 128 };
    return undefined;
  });
  const r = w.ensureWorktree({ repo: 'app', taskId: 'cr-1', base: 'develop', repoPath: '/repo' }, run);
  assert.ok(cmds.some((c) => c === '-C /repo worktree prune'), 'a stale registration must be prunable');
  assert.equal(r.branch, 'soma/cr-1-r2');

  // `git worktree prune` exits 0 having pruned NOTHING (verified on 2.39.5), so its exit
  // code is not evidence. A locked worktree refuses `--force`, prune reports success, and
  // the `add` then fails on the cause-hiding "already exists" — after creating the
  // branch. Trusting prune therefore burns one suffix per watchdog respawn and leaves ~50
  // dead soma/cr-1-r* branches behind while the operator is told the wrong thing.
  for (const pruneCode of [0, 128]) {
    const stuck = stub((j) => {
      if (j.includes('rev-parse')) return { stdout: 'abc123\n', code: 0 };
      if (j.includes('worktree list')) return { stdout: `${row(dir, 'soma/cr-1')} locked\n`, code: 0 };
      if (j.includes('status --porcelain')) return { stdout: ' M a\n', code: 0 };
      if (j.includes('worktree remove')) return { stdout: "fatal: ... use 'remove -f -f' to override or unlock first", code: 128 };
      if (j.includes('worktree prune')) return { stdout: '', code: pruneCode };
      return undefined;
    });
    assert.throws(() => w.ensureWorktree({ repo: 'app', taskId: 'cr-1', base: 'develop', repoPath: '/repo' }, stuck.run),
      /still registered.*remove -f -f/s, `prune exit ${pruneCode} was taken as proof`);
    assert.equal(stuck.cmds.some((c) => c.includes('worktree add')), false, 'nothing may be added over a worktree we failed to clear');
    assert.equal(stuck.cmds.some((c) => c.includes('branch --list')), false, 'a doomed attempt must not leak a branch');
  }

  // Nor may an unreadable listing be read as "it is gone now".
  let seen = 0;
  const blind = stub((j) => {
    if (j.includes('rev-parse')) return { stdout: 'abc123\n', code: 0 };
    if (j.includes('worktree list')) return seen++ === 0 ? { stdout: `${row(dir, 'soma/cr-1')}\n`, code: 0 } : { stdout: 'fatal: boom', code: 128 };
    if (j.includes('status --porcelain')) return { stdout: ' M a\n', code: 0 };
    if (j.includes('worktree remove')) return { stdout: 'fatal: nope', code: 128 };
    return undefined;
  });
  assert.throws(() => w.ensureWorktree({ repo: 'app', taskId: 'cr-1', base: 'develop', repoPath: '/repo' }, blind.run), /still registered/);
  assert.equal(blind.cmds.some((c) => c.includes('worktree add')), false);
});

test('every git failure is loud, and nothing is created after one', async (t) => {
  const { w, p } = await fresh(t, 'loud');
  const dir = p('worktrees', 'app', 'cr-1');
  const fail = (match, reply) => stub((j) => {
    if (j.includes(match)) return reply;
    if (j.includes('rev-parse')) return { stdout: 'abc123\n', code: 0 };
    return undefined;
  });

  // A failed fetch with a stale `origin/<base>` still lying around is the
  // stale-base defect: rev-parse succeeds, every branch forks off an old base, and
  // on a repo whose base auto-deploys that PR is actively harmful.
  const f = fail('fetch', { stdout: 'fatal: could not read from remote', code: 128 });
  assert.throws(() => w.ensureWorktree({ repo: 'app', taskId: 'cr-1', base: 'develop', repoPath: '/repo' }, f.run),
    /fetch origin develop failed.*could not read from remote/s);
  assert.deepEqual(f.cmds, ['-C /repo fetch origin develop'], 'a failed fetch must stop the operation dead');

  // `git rev-parse origin/nope` prints `origin/nope` on STDOUT and exits 128
  // (verified on 2.39.5): trusting the output alone records that string as the
  // base sha and spawns a lead against a base that does not exist.
  const rp = stub((j) => (j.includes('rev-parse') ? { stdout: 'origin/nope\n', code: 128 } : undefined));
  assert.throws(() => w.ensureWorktree({ repo: 'app', taskId: 'cr-1', base: 'nope', repoPath: '/repo' }, rp.run), /rev-parse origin\/nope failed/);
  assert.equal(rp.cmds.some((c) => c.includes('worktree')), false);

  // An empty sha is the same hole without the exit code.
  const blank = stub((j) => (j.includes('rev-parse') ? { stdout: '\n', code: 0 } : undefined));
  assert.throws(() => w.ensureWorktree({ repo: 'app', taskId: 'cr-1', base: 'develop', repoPath: '/repo' }, blank.run), /no sha/);

  for (const [match, re] of [['worktree list', /worktree list failed/], ['worktree add', /worktree add .* failed/],
    ['branch --list', /branch --list .* failed/]]) {
    const s = fail(match, { stdout: 'fatal: boom', code: 128 });
    assert.throws(() => w.ensureWorktree({ repo: 'app', taskId: 'cr-1', base: 'develop', repoPath: '/repo' }, s.run), re);
  }

  // A directory git does not know about is not soma's to delete: name it and stop.
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'leftover'), 'x');
  const junk = stub((j) => (j.includes('rev-parse') ? { stdout: 'abc123\n', code: 0 } : undefined));
  assert.throws(() => w.ensureWorktree({ repo: 'app', taskId: 'cr-1', base: 'develop', repoPath: '/repo' }, junk.run), /not a registered worktree/);
  assert.equal(readdirSync(dir).length, 1, 'the leftover must be left where it is');
  assert.equal(existsSync(p('state', 'repo-app.lock')), false, 'a throw still releases the repo lock');
});

test('bad arguments are refused before any git runs', async (t) => {
  const { w } = await fresh(t, 'args');
  const { cmds, run } = stub();
  const ok = { repo: 'app', taskId: 'cr-1', base: 'develop', repoPath: '/repo' };
  // `repoPath` is `cfg.repos[task.repo]?.path` at the call site, so undefined is a
  // routine misconfiguration; without this guard it reaches execFileSync as an
  // undefined argv entry and surfaces as a child_process type error.
  for (const bad of [{}, undefined, null, { ...ok, repoPath: undefined }, { ...ok, repoPath: '' },
    { ...ok, base: null }, { ...ok, taskId: '' }, { ...ok, repo: 42 }, { ...ok, taskId: 'a/b' },
    { ...ok, taskId: '..' }, { ...ok, repo: '../../etc' }, { ...ok, taskId: 'a\\b' }, { ...ok, repo: 'a/./b' }]) {
    assert.throws(() => w.ensureWorktree(bad, run), TypeError, `ensureWorktree accepted ${JSON.stringify(bad)}`);
  }
  // removeWorktree needs less: no base, and repoPath is optional (git then runs inside
  // the worktree). It still has to hold the line on the two names that reach the path.
  for (const bad of [{}, undefined, null, { repo: 'app' }, { taskId: 'cr-1' }, { repo: 'app', taskId: '..' },
    { repo: 'app', taskId: 'a/b' }, { repo: '..', taskId: 'cr-1' }, { repo: 'app', taskId: 'cr-1', repoPath: '' },
    { repo: 'app', taskId: 'cr-1', repoPath: 42 }]) {
    assert.throws(() => w.removeWorktree(bad, run), TypeError, `removeWorktree accepted ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(cmds, []);
  for (const bad of [undefined, null, 42, '', {}]) assert.throws(() => w.repoSlug(bad), TypeError);
  assert.equal(w.repoSlug('Acme App 2.0/x'), 'Acme-App-2.0-x');
});

test('removeWorktree is idempotent, targets the repo, and fails loudly', async (t) => {
  const { w, p } = await fresh(t, 'remove');
  const dir = p('worktrees', 'app', 'cr-1');

  // The original `run(['worktree','remove',dir])` carries no `-C`: git would run in
  // whatever cwd the bus or the watchdog happens to have.
  const listed = stub((j) => (j.includes('worktree list') ? { stdout: `${row(dir, 'soma/cr-1')}\n`, code: 0 } : undefined));
  w.removeWorktree({ repo: 'app', taskId: 'cr-1', repoPath: '/repo' }, listed.run);
  assert.deepEqual(listed.cmds, ['-C /repo worktree list', `-C /repo worktree remove ${dir}`]);

  const forced = stub((j) => (j.includes('worktree list') ? { stdout: `${row(dir, 'soma/cr-1')}\n`, code: 0 } : undefined));
  w.removeWorktree({ repo: 'app', taskId: 'cr-1', force: true, repoPath: '/repo' }, forced.run);
  assert.ok(forced.cmds.some((c) => c === `-C /repo worktree remove ${dir} --force`));

  // Already gone: a no-op, so `soma gc` can be re-run without an error per row.
  const gone = stub();
  w.removeWorktree({ repo: 'app', taskId: 'cr-1', repoPath: '/repo' }, gone.run);
  assert.deepEqual(gone.cmds, ['-C /repo worktree list']);

  // Without repoPath git is run inside the worktree itself, which works while the
  // dir is alive (verified on 2.39.5) — and says what to pass when it is not.
  const inside = stub((j) => (j.includes('worktree list') ? { stdout: `${row(dir, 'soma/cr-1')}\n`, code: 0 } : undefined));
  w.removeWorktree({ repo: 'app', taskId: 'cr-1' }, inside.run);
  assert.equal(inside.cmds[0], `-C ${dir} worktree list`);
  const unreachable = stub(() => ({ stdout: 'fatal: cannot change to', code: 128 }));
  assert.throws(() => w.removeWorktree({ repo: 'app', taskId: 'cr-1' }, unreachable.run), /pass repoPath/);

  const failing = stub((j) => (j.includes('worktree list')
    ? { stdout: `${row(dir, 'soma/cr-1')}\n`, code: 0 }
    : { stdout: 'fatal: contains modified or untracked files', code: 128 }));
  assert.throws(() => w.removeWorktree({ repo: 'app', taskId: 'cr-1', repoPath: '/repo' }, failing.run), /worktree remove .* failed/);
  assert.equal(existsSync(p('state', 'repo-app.lock')), false);
});

test('withRepoLock: one holder per repo, released in a finally, re-entrant in-process', async (t) => {
  const { w, p } = await fresh(t, 'lock');
  const lock = p('state', 'repo-app.lock');

  assert.equal(w.withRepoLock('app', () => {
    assert.equal(readFileSync(lock, 'utf8').trim(), String(process.pid), 'the lock must name its holder');
    // Re-entrant on purpose: the spawner is expected to wrap a whole spawn in the
    // lock, and ensureWorktree takes it again from inside. A non-re-entrant lock
    // would queue behind itself, burn the timeout and throw.
    return w.withRepoLock('app', () => w.withRepoLock('other-repo', () => {
      assert.equal(existsSync(p('state', 'repo-other-repo.lock')), true, 'a second repo is not blocked by the first');
      return 'nested';
    }));
  }), 'nested');
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(p('state', 'repo-other-repo.lock')), false);

  assert.throws(() => w.withRepoLock('app', () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(lock), false, 'a throwing fn must not strand the repo');

  // A live holder is waited on, then refused — with the pid to go look at.
  writeFileSync(lock, `${process.pid}\n`);
  assert.throws(() => w.withRepoLock('app', () => 'never', undefined, { timeoutMs: 0 }), new RegExp(`held by pid ${process.pid}`));
  assert.equal(existsSync(lock), true, 'a refusal must not steal a live holder lock');

  // A crashed holder is taken over rather than waited out: `soma down` killing a
  // pane mid-spawn would otherwise wedge every later spawn against that repo.
  // (Takeover needs a nonzero deadline: the deadline is checked before the
  // is-the-owner-alive branch, so that every path out of the loop is bounded.)
  const dead = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  writeFileSync(lock, `${dead}\n`);
  assert.equal(w.withRepoLock('app', () => 'took over', undefined, { timeoutMs: 200 }), 'took over');

  // `Number('') === 0` and `process.kill(0, 0)` signals our own process group
  // without throwing, so a lock file truncated by a crash between create and write
  // reads as "held by a live process" to a naive check — and wedges forever.
  writeFileSync(lock, '');
  assert.equal(w.withRepoLock('app', () => 'took over empty'), 'took over empty');
  for (const junk of ['not-a-pid\n', '-1', '0', '   ']) {
    writeFileSync(lock, junk);
    assert.equal(w.withRepoLock('app', () => 'ok'), 'ok', `lock content ${JSON.stringify(junk)} wedged the repo`);
  }

  // A lock we cannot *read* is a different thing from one whose owner is gone. An EACCES is
  // the environment misbehaving, not evidence the owner died — a takeover on the strength of
  // one is a permissions hiccup promoted into two `worktree add`s in the same repo. (Under a
  // root test runner the read succeeds and this becomes the live-holder case above, which
  // must refuse the steal for its own reason.)
  writeFileSync(lock, `${process.pid}\n`);
  const wasIno = statSync(lock).ino;
  chmodSync(lock, 0o000);
  let ran = false;
  const unreadable = capture(() => w.withRepoLock('app', () => { ran = true; }, undefined, { timeoutMs: 100 }), 'an unreadable lock');
  assert.equal(ran, false, 'an unreadable lock must not be stolen');
  chmodSync(lock, 0o600);
  assert.equal(readFileSync(lock, 'utf8'), `${process.pid}\n`, 'and must be left exactly as it was');
  assert.equal(statSync(lock).ino, wasIno, 'the same file, not a replacement');

  // Refusing to steal it is right, and it also means nothing soma does *later* clears it: the
  // next spawn against this repo fails identically, so the wait is unbounded across calls and
  // an operator is the only way out of it. So the error has to be addressed to one — naming
  // the file absolutely, because it moves with $SOMA_HOME, naming the errno, because EACCES
  // (fix the mode) and EISDIR (something made a directory here) want different repairs, and
  // saying what to do. "Gave up after 100ms" alone reads as a hang to wait out, which this is
  // not. (A root runner reads the file fine and gets the live-holder message; the case below
  // covers every uid.)
  if (process.getuid?.() !== 0) {
    assert.match(unreadable.message, /unreadable \(EACCES\)/, 'the error must say why it could not be read');
    assert.ok(unreadable.message.includes(lock), `and name the absolute lock path: ${unreadable.message}`);
    assert.match(unreadable.message, /remove it by hand if no soma process is running/, 'and how to clear it');
  }
  rmSync(lock);

  // The same dead end reached another way: something in the lock's place that is not a file at
  // all. EISDIR for every uid, so this one holds under a root runner too.
  mkdirSync(lock);
  ran = false;
  const notAFile = capture(() => w.withRepoLock('app', () => { ran = true; }, undefined, { timeoutMs: 100 }), 'a lock that is a directory');
  assert.equal(ran, false, 'a lock soma cannot classify must not be entered past either');
  assert.match(notAFile.message, /unreadable \(EISDIR\)/, 'the error must say why it could not be read');
  assert.ok(notAFile.message.includes(lock), `and name the absolute lock path: ${notAFile.message}`);
  assert.match(notAFile.message, /remove it by hand if no soma process is running/, 'and how to clear it');
  rmSync(lock, { recursive: true });

  // `linkLanded` returns from the acquire *before* the live-holder check above ever runs, so it
  // has to be proof rather than a guess — and it is proof only while the scratch name is ours
  // alone. When it was `repo-<slug>.lock.<pid>.tmp` anyone could derive it, and on the one
  // deployment the shortcut exists for (a shared $SOMA_HOME on a network filesystem) host B's
  // pid 500 derives host A's pid 500's name exactly. Pre-link that name to a live holder's lock
  // and the proof is true of a lock we never won: measured against the pre-fix module, this
  // entered the critical section beside pid 1, overwrote its lock with our own pid through the
  // shared inode, and deleted it on the way out. An inode check alone does not close this —
  // with a pre-linked scratch the inodes match too — only a name nobody else can arrive at.
  const guessable = `${lock}.${process.pid}.tmp`;
  writeFileSync(lock, '1\n');                    // pid 1 is alive on every host, and never ours
  const liveIno = statSync(lock).ino;
  linkSync(lock, guessable);
  ran = false;
  assert.throws(() => w.withRepoLock('app', () => { ran = true; }, undefined, { timeoutMs: 100 }), /repo-app\.lock/);
  assert.equal(ran, false, 'a scratch name a stranger can derive must not prove we hold the lock');
  assert.equal(readFileSync(lock, 'utf8'), '1\n', 'and the live holder must keep its lock, bytes and all');
  assert.equal(statSync(lock).ino, liveIno, 'the same inode, not a lock we replaced');
  rmSync(guessable);
  rmSync(lock);

  // Release happens on the synchronous return, so an async fn would run its
  // "protected" work unlocked — and a synchronous waiter in this process blocks the
  // event loop the promise needs to settle on, which is a deadlock, not a delay.
  const floating = w.withRepoLock;
  assert.throws(() => floating('app', async () => 'nope'), TypeError);
  assert.throws(() => floating('app', () => Promise.reject(new Error('adopted'))), TypeError);
  assert.equal(existsSync(lock), false);

  // A message matcher, not a bare `TypeError`: `assert.throws(fn, TypeError)` matches every
  // native TypeError there is, including the `fn is not a function` an UNGUARDED call throws on
  // its own one line later — so with the guard deleted this passed, having taken and released a
  // lock it had no business taking. Measured: deleting the guard leaves the suite green.
  for (const bad of [undefined, null, 'fn', 42, {}]) {
    assert.throws(() => w.withRepoLock('app', bad), /^TypeError: withRepoLock\(app\): fn must be a function, got /,
      `a ${typeof bad} fn must be refused by the guard, before any lock is taken`);
    assert.equal(existsSync(lock), false, 'and no lock may be taken on the way to refusing it');
  }
  // The lock file name is a flat filename, so the slug is what keeps a repo key
  // with a separator in it from writing outside state/.
  w.withRepoLock('org/repo x', () => assert.equal(existsSync(p('state', 'repo-org-repo-x.lock')), true));
});

test('withRepoLock serializes real contention, and is never present-but-ownerless', async (t) => {
  const { w, home, p } = await fresh(t, 'contention');
  const N = 6;
  const M = 10;
  const counter = p('state', 'counter');
  writeFileSync(counter, '0');
  const lock = p('state', 'repo-app.lock');
  const url = new URL('../bin/lib/worktree.mjs', import.meta.url).href;

  // A read-modify-write with a gap in the middle, which is what `ensureWorktree` is:
  // without exclusion two children read the same n and one increment is simply gone.
  const src = `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { withRepoLock } from ${JSON.stringify(url)};
    const counter = ${JSON.stringify(counter)};
    for (let i = 0; i < ${M}; i++) {
      withRepoLock('app', () => {
        const n = Number(readFileSync(counter, 'utf8'));
        const until = Date.now() + 1; while (Date.now() < until);
        writeFileSync(counter, String(n + 1));
      });
    }
  `;
  const kids = Array.from({ length: N }, () => new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, ['--input-type=module', '-e', src], {
      env: { ...process.env, SOMA_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('error', reject);
    cp.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${err}`))));
  }));

  // Sampled from here, synchronously, while the children run as separate processes: the
  // empty-file window is only observable from outside the holder. An `O_EXCL` create
  // publishes the name before the pid, and every ownerless read is a licence for a waiter
  // to unlink a live lock and join the holder inside the critical section.
  let present = 0;
  let ownerless = 0;
  const until = Date.now() + 600;
  while (Date.now() < until) {
    let raw;
    try {
      raw = readFileSync(lock, 'utf8');
    } catch {
      continue;                                    // absent is the released state, not a fault
    }
    present++;
    const pid = Number(raw.trim());
    if (!(Number.isInteger(pid) && pid > 0)) ownerless++;
    if (Number(readFileSync(counter, 'utf8')) === N * M) break;
  }
  await Promise.all(kids);

  assert.equal(Number(readFileSync(counter, 'utf8')), N * M, `${N} x ${M} increments lost an update — the lock is not exclusive`);
  assert.equal(ownerless, 0, `the lock was ownerless on ${ownerless} of ${present} reads that found it present`);
  assert.ok(present > 0, 'the probe never caught the lock held, so it proves nothing');
  assert.equal(existsSync(lock), false, 'every child released');
  assert.deepEqual(readdirSync(p('state')).filter((n) => n.endsWith('.tmp')), [], 'the link scratch files must be cleaned up');
});

test('a lock left behind by a crashed holder is still reclaimable', async (t) => {
  const { w, home, p } = await fresh(t, 'crashed-holder');
  const lock = p('state', 'repo-app.lock');
  const url = new URL('../bin/lib/worktree.mjs', import.meta.url).href;
  // The holder dies *inside* the critical section — `soma down` killing a pane mid-spawn —
  // so its `finally` never runs and the lock survives with a real, now-dead pid in it.
  // The takeover only unlinks a lock whose bytes are unchanged, which is what stops it
  // deleting a successor's; this pins that the same check cannot refuse the reclaim, since
  // a fix that wedges every later spawn against the repo is worse than the race it closed.
  const src = `
    import { withRepoLock } from ${JSON.stringify(url)};
    withRepoLock('app', () => { process.kill(process.pid, 'SIGKILL'); });
  `;
  const dead = await new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, ['--input-type=module', '-e', src], {
      env: { ...process.env, SOMA_HOME: home }, stdio: 'ignore',
    });
    cp.on('error', reject);
    cp.on('exit', (code, signal) => resolve({ pid: cp.pid, signal }));
  });
  assert.equal(dead.signal, 'SIGKILL');
  assert.equal(readFileSync(lock, 'utf8').trim(), String(dead.pid), 'the crashed holder did not leave its lock behind');

  assert.equal(w.withRepoLock('app', () => 'reclaimed', undefined, { timeoutMs: 5000 }), 'reclaimed');
  assert.equal(existsSync(lock), false);
  // The scratch is unlinked on the acquire's own return, not at release, so even a holder
  // killed mid-critical-section leaves no litter in state/.
  assert.deepEqual(readdirSync(p('state')).filter((n) => n.endsWith('.tmp')), []);
});

test('a second process cannot hold the same repo lock', async (t) => {
  const { w, home, p } = await fresh(t, 'cross-process');
  const url = new URL('../bin/lib/worktree.mjs', import.meta.url).href;
  const src = `
    import { withRepoLock } from ${JSON.stringify(url)};
    withRepoLock('app', () => {
      process.stdout.write('held');
      const until = Date.now() + 1500; while (Date.now() < until);
    });
  `;
  const child = execFileSync(process.execPath, ['--input-type=module', '-e', src], {
    env: { ...process.env, SOMA_HOME: home }, encoding: 'utf8',
  });
  assert.equal(child, 'held');
  // The child is gone by the time execFileSync returns, so the lock it held must be
  // gone too — release is not conditional on the parent knowing about it.
  assert.equal(existsSync(p('state', 'repo-app.lock')), false);
  assert.equal(w.withRepoLock('app', () => 'free'), 'free');
});

test('every link attempt in one contended acquire uses a name of its own', async (t) => {
  const { w, home, p } = await fresh(t, 'per-attempt-scratch');
  const lock = p('state', 'repo-app.lock');
  const url = new URL('../bin/lib/worktree.mjs', import.meta.url).href;

  // One name for the whole wait is not a smaller version of this bug, it *is* the bug: a name
  // that outlives one attempt is a name a second acquirer can find on disk and link, and
  // `linkLanded` would then read a second name on it as proof we hold a lock we do not. So the
  // claim is per *attempt*, not merely per acquisition — checked across the retry loop, since
  // the pre-fix code minted its one name outside it. Measured: 62 attempts, 1 distinct name
  // before; 62 attempts, 62 distinct names after.
  //
  // `linkSync` is wrapped rather than replaced, so the code under test is the shipped code and
  // still really contends. The patch lands before the first ESM import of node:fs, which is
  // what makes worktree.mjs's own `import { linkSync }` see it.
  writeFileSync(lock, `${process.pid}\n`);       // we are alive, so the child has to keep trying
  const src = `
    import { createRequire } from 'node:module';
    const fs = createRequire(import.meta.url)('fs');
    const real = fs.linkSync;
    const seen = [];
    fs.linkSync = (from, to) => { seen.push(String(from)); return real(from, to); };
    const { withRepoLock } = await import(${JSON.stringify(url)});
    try { withRepoLock('app', () => 'never', undefined, { timeoutMs: 600 }); } catch {}
    process.stdout.write(JSON.stringify({ attempts: seen.length, distinct: new Set(seen).size }));
  `;
  const r = await new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, ['--input-type=module', '-e', src], {
      env: { ...process.env, SOMA_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('error', reject);
    cp.on('exit', () => resolve(out ? JSON.parse(out) : assert.fail(`child said nothing: ${err.trim()}`)));
  });

  assert.ok(r.attempts > 5, `the child never really contended (${r.attempts} attempts), so this proves nothing`);
  assert.equal(r.distinct, r.attempts, `${r.attempts} link attempts shared ${r.distinct} scratch name(s)`);
  assert.equal(readFileSync(lock, 'utf8'), `${process.pid}\n`, 'and the live holder kept its lock');
  rmSync(lock);
  // Every attempt drops its own scratch on the way out, so a name per attempt is not litter
  // per attempt.
  assert.deepEqual(readdirSync(p('state')).filter((n) => n.endsWith('.tmp')), []);
  assert.equal(w.withRepoLock('app', () => 'free'), 'free');
});

test('a filesystem without hard links says so, instead of reporting a socket error', async (t) => {
  const { home, p } = await fresh(t, 'no-hard-links');
  const url = new URL('../bin/lib/worktree.mjs', import.meta.url).href;

  // `link(2)` IS this lock, so a volume that does not do hard links cannot host $SOMA_HOME at
  // all — and it used to say so in libuv's words rather than soma's: `ENOTSUP: operation not
  // supported on socket, link '…'`, reproduced on a real FAT16 volume, on which the `wx` create
  // this idiom replaced worked fine. That errno is not EEXIST, so it escapes the acquire loop
  // untouched, and an operator who pointed $SOMA_HOME at an exFAT drive or a cloud-sync mount
  // got a socket error about a file. It is the tree's only hard-link dependency, so nothing
  // else in soma would tell them, and $SOMA_HOME's filesystem is not something a running
  // deployment changes.
  //
  // Stubbed rather than mounted: a real FAT volume needs hdiutil and a mount, while this patch
  // lands before the first ESM import of node:fs and is therefore visible to worktree.mjs's own
  // `import { linkSync }` — so the code under test is the shipped code.
  const acquireWith = (stub) => new Promise((resolve, reject) => {
    const src = `
      import { createRequire } from 'node:module';
      const fs = createRequire(import.meta.url)('fs');
      ${stub}
      const { withRepoLock } = await import(${JSON.stringify(url)});
      try {
        withRepoLock('app', () => 0, undefined, { timeoutMs: 50 });
        process.stdout.write(JSON.stringify({ entered: true }));
      } catch (e) {
        process.stdout.write(JSON.stringify({ message: e.message, causeCode: e.cause?.code ?? null }));
      }
    `;
    const cp = spawn(process.execPath, ['--input-type=module', '-e', src], {
      env: { ...process.env, SOMA_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('error', reject);
    cp.on('exit', () => resolve(out ? JSON.parse(out) : { message: `(nothing on stdout; stderr: ${err.trim()})`, causeCode: null }));
  });
  const throwing = (fn, code) => `fs.${fn} = () => { throw Object.assign(new Error(${JSON.stringify(`${code}: stubbed failure, ${fn}`)}), { code: ${JSON.stringify(code)} }); };`;

  // All three, because some filesystems report an unsupported link as EPERM rather than
  // ENOTSUP. Each has to carry the cause, the errno, the absolute path (it moves with
  // $SOMA_HOME) and the remedy — an assertion per part, so a message that keeps one and drops
  // the rest cannot pass.
  for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'EPERM']) {
    const r = await acquireWith(throwing('linkSync', code));
    assert.equal(r.entered, undefined, `${code} must not be treated as a successful acquire`);
    assert.match(r.message, /must be on a filesystem that supports hard links/, `${code} must name the cause`);
    assert.match(r.message, new RegExp(`link\\(2\\) returned ${code}`), `${code} must be named: ${r.message}`);
    assert.ok(r.message.includes(p('state', 'repo-app.lock')), `${code} must name the absolute lock path: ${r.message}`);
    assert.match(r.message, /move SOMA_HOME off this volume/, `${code} must say what to do about it`);
    assert.equal(r.causeCode, code, 'and keep the original error as its cause');
  }

  // And not one errno more. A cross-device link and an I/O error are different faults with
  // different fixes, and burying either under "this volume has no hard links" would send
  // someone reformatting a disk over a misplaced state root.
  for (const code of ['EXDEV', 'EIO']) {
    const r = await acquireWith(throwing('linkSync', code));
    assert.match(r.message, new RegExp(`${code}: stubbed failure`), `an unrelated link failure must surface as itself: ${r.message}`);
    assert.doesNotMatch(r.message, /supports hard links/);
  }

  // The narrowness that matters most: EPERM is in the set, and it is also what the *scratch
  // write* returns for a `state/` this process may not write — an immutable directory reports
  // EPERM (reproduced with `chflags uchg`), a mode-500 one EACCES. That is a permissions
  // problem with a permissions fix, and relabelling it "move SOMA_HOME to another filesystem"
  // sends an operator to reformat a disk over a chmod. Which is why the catch wraps the single
  // `linkSync` call and not the block around it.
  for (const code of ['EPERM', 'EACCES']) {
    const r = await acquireWith(throwing('writeFileSync', code));
    assert.equal(r.entered, undefined, `a scratch write that fails ${code} is not an acquire`);
    assert.match(r.message, new RegExp(`${code}: stubbed failure, writeFileSync`), `a scratch-write ${code} must surface as itself: ${r.message}`);
    assert.doesNotMatch(r.message, /supports hard links/, `a scratch-write ${code} must not be relabelled a filesystem without hard links`);
  }

  // No `wx` fallback, deliberately — degrading to O_CREAT|O_EXCL here would reopen the
  // empty-file steal window silently, on exactly the machines nobody is watching. So the
  // acquire fails, and having failed it leaves nothing behind.
  assert.deepEqual(readdirSync(p('state')).filter((n) => n.endsWith('.tmp')), [], 'a refused acquire leaves no scratch file');
  assert.equal(existsSync(p('state', 'repo-app.lock')), false, 'and no lock');
});

test('a holder whose lock was taken over does not delete its successor on the way out', async (t) => {
  const { w, p } = await fresh(t, 'release-identity');
  const lock = p('state', 'repo-app.lock');

  // Release is the second half of the takeover race, and it used to unlink by name with no
  // check at all — so a holder that lost its lock to a takeover deleted the *successor's* lock
  // on the way out, and the successor went on believing it held a mutex nobody had. That is
  // worse than the takeover it follows: a losing takeover at least leaves someone to time out
  // and say so, while this one is silent. One read before the unlink closes the whole class.
  //
  // The steal is done from inside `fn` because that is the only place it can be done
  // deterministically — it is exactly the interleaving a crashed-holder misdiagnosis produces.
  const successor = `${execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })}\n`;
  assert.notEqual(successor, `${process.pid}\n`);
  w.withRepoLock('app', () => {
    assert.equal(readFileSync(lock, 'utf8').trim(), String(process.pid), 'the lock names us while we hold it');
    unlinkSync(lock);                 // a waiter decides we are dead and takes it over...
    writeFileSync(lock, successor);   // ...and publishes its own
  });
  assert.equal(existsSync(lock), true, "the successor's lock must survive our release");
  assert.equal(readFileSync(lock, 'utf8'), successor, 'and it must still be the successor that owns it');
  rmSync(lock);

  // Which must not turn into a lock nothing ever clears. An ordinary release still drops our
  // own; so does one whose bytes were corrupted under us (nothing here writes bytes that read
  // that way, and an acquirer would take a corrupt lock over anyway); and so does a throw.
  w.withRepoLock('app', () => 'ok');
  assert.equal(existsSync(lock), false, 'an ordinary release still drops our own lock');
  w.withRepoLock('app', () => { writeFileSync(lock, 'garbage\n'); });
  assert.equal(existsSync(lock), false, 'a corrupt lock is not left for the next spawn to wait on');
  assert.throws(() => w.withRepoLock('app', () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(lock), false, 'and a throwing fn still releases');

  // A re-entrant inner call must not release the outer's lock either — the outer is still in
  // its critical section when the inner returns.
  w.withRepoLock('app', () => {
    w.withRepoLock('app', () => 'inner');
    assert.equal(existsSync(lock), true, 'a nested return must not release the lock the outer still holds');
  });
  assert.equal(existsSync(lock), false);
  assert.deepEqual(readdirSync(p('state')).filter((n) => n.endsWith('.tmp')), []);
});

// ---------------------------------------------------------------------------
// Real git. Stubs prove the argument vectors; only git proves the behaviour —
// and three of the fixes above exist because git disagreed with the first sketch.
// ---------------------------------------------------------------------------

/** `git <args...>` in a hermetic environment, throwing on failure and staying quiet. */
const git = (...args) => execFileSync('git', args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],   // git's chatter is not this suite's output
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
}).trim();

/**
 * A bare `origin` whose `develop` has advanced past the clone's local `develop`.
 *
 * That gap is the point: it is exactly the state a repo the operator has not
 * pulled for days is in, and the one a worktree based on local `<base>` would
 * silently fork from.
 */
function repoFixture(root) {
  const at = (name) => join(root, name);
  git('init', '-q', '--bare', at('origin.git'));
  git('-C', at('origin.git'), 'symbolic-ref', 'HEAD', 'refs/heads/develop');
  git('clone', '-q', at('origin.git'), at('seed'));
  writeFileSync(join(at('seed'), 'a.txt'), 'one\n');
  git('-C', at('seed'), 'checkout', '-q', '-b', 'develop');
  git('-C', at('seed'), 'add', 'a.txt');
  git('-C', at('seed'), '-c', 'user.email=s@t', '-c', 'user.name=s', 'commit', '-qm', 'c1');
  git('-C', at('seed'), 'push', '-q', 'origin', 'develop');
  git('clone', '-q', at('origin.git'), at('repo'));          // local develop = c1
  writeFileSync(join(at('seed'), 'a.txt'), 'two\n');
  git('-C', at('seed'), '-c', 'user.email=s@t', '-c', 'user.name=s', 'commit', '-qam', 'c2');
  git('-C', at('seed'), 'push', '-q', 'origin', 'develop');  // origin/develop = c2
  return { repoPath: at('repo'), c1: git('-C', at('seed'), 'rev-parse', 'HEAD~1'), c2: git('-C', at('seed'), 'rev-parse', 'HEAD') };
}

/** Hermetic git for the module's own default `run` too — see the .claude/ assertions. */
function hermetic(t, root) {
  const saved = { ...process.env };
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    XDG_CONFIG_HOME: join(root, 'empty-xdg'),
  });
  mkdirSync(join(root, 'empty-xdg'), { recursive: true });
  t.after(() => { for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_TERMINAL_PROMPT', 'XDG_CONFIG_HOME']) {
    if (k in saved) process.env[k] = saved[k]; else delete process.env[k];
  } });
}

test('against real git: fetched base, no upstream, invisible .claude, escalating retries', async (t) => {
  const { w, p } = await fresh(t, 'real-git');
  if (w.defaultRun(['--version']).code !== 0) return t.skip('git not available');
  const root = mkdtempSync(join(tmpdir(), 'soma-repo-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  hermetic(t, root);
  const { repoPath, c1, c2 } = repoFixture(root);
  const args = { repo: 'app', taskId: 'cr-1', base: 'develop', repoPath };

  const r = w.ensureWorktree(args);
  assert.equal(r.dir, p('worktrees', 'app', 'cr-1'));
  assert.equal(r.branch, 'soma/cr-1');
  assert.equal(r.reused, false);
  assert.equal(r.excluded, true);

  // THE fix: the base is the freshly fetched remote tip, not the checkout's stale
  // local branch. `git -C repo rev-parse develop` is still c1 right now.
  assert.equal(r.base_sha, c2);
  assert.equal(git('-C', repoPath, 'rev-parse', 'develop'), c1, 'the fixture must actually be stale');
  assert.equal(git('-C', r.dir, 'rev-parse', 'HEAD'), c2, 'the worktree was based on the stale local branch');

  // `--no-track`: no upstream, so a bare `git push` cannot resolve to the base branch.
  assert.throws(() => git('-C', r.dir, 'rev-parse', '--abbrev-ref', '@{upstream}'));

  // The guard file's directory is invisible to git in the worktree — and it is
  // soma's own ignore rule that hides it, not the operator's global one.
  mkdirSync(join(r.dir, '.claude'), { recursive: true });
  writeFileSync(join(r.dir, '.claude', 'settings.local.json'), '{}');
  assert.equal(git('-C', r.dir, 'status', '--porcelain'), '');
  assert.match(git('-C', r.dir, 'check-ignore', '-v', '.claude/settings.local.json'), /^\.claude\/\.gitignore:/);
  // The first sketch wrote `.claude/` to `<repo>/.git/worktrees/<id>/info/exclude`. git
  // resolves $GIT_DIR/info to the COMMON dir, so that file is never read (verified:
  // `git rev-parse --git-path info/exclude` from the worktree prints
  // `<repo>/.git/info/exclude`) — the worktree would have looked dirty on every
  // retry, and reuse would have been dead code.
  assert.equal(existsSync(join(repoPath, '.git', 'worktrees', 'cr-1', 'info', 'exclude')), false);
  // The target repo itself is untouched: no .gitignore edit, no shared exclude edit.
  assert.equal(git('-C', repoPath, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(repoPath, '.git', 'info', 'exclude'), 'utf8').includes('.claude'), false);

  // A leaked GIT_DIR overrides `-C` rather than complementing it, so a parent that
  // exported one (a git hook, `rebase -x`) would have had every command in the module
  // operating on another repository — and the task's worktree registered there.
  const realGitDir = git('-C', repoPath, 'rev-parse', '--absolute-git-dir');
  process.env.GIT_DIR = join(root, 'origin.git');
  try {
    const leaked = (() => {
      try {
        return execFileSync('git', ['-C', repoPath, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      } catch (e) {
        return `git failed: ${e.status}`;
      }
    })();
    assert.notEqual(leaked, realGitDir, 'GIT_DIR did not leak into an unscrubbed child, so this proves nothing');
    assert.equal(w.defaultRun(['-C', repoPath, 'rev-parse', '--absolute-git-dir']).stdout.trim(), realGitDir);
  } finally {
    delete process.env.GIT_DIR;
  }

  // Reuse: clean (the guard file does not count), same branch, nothing recreated.
  const again = w.ensureWorktree(args);
  assert.deepEqual(again, { ...r, reused: true });
  assert.equal(git('-C', repoPath, 'worktree', 'list').split('\n').length, 2);

  // A pre-existing `.claude/.gitignore` with no trailing newline keeps its last pattern:
  // splicing the comment onto it corrupts that line, and a repo that tracks the file
  // carries the damage into the PR. (`**` hides the directory and itself, so the
  // worktree stays clean and this still goes down the reuse path.)
  writeFileSync(join(r.dir, '.claude', '.gitignore'), '**');
  assert.equal(w.ensureWorktree(args).reused, true);
  const lines = readFileSync(join(r.dir, '.claude', '.gitignore'), 'utf8').split('\n');
  assert.equal(lines[0], '**', 'the pre-existing pattern was spliced into');
  assert.ok(lines.includes('*'));
  assert.equal(git('-C', r.dir, 'status', '--porcelain'), '');
  // And a second pass adds nothing: the `*` line is the idempotency marker.
  const settled = readFileSync(join(r.dir, '.claude', '.gitignore'), 'utf8');
  assert.equal(w.ensureWorktree(args).excluded, true);
  assert.equal(readFileSync(join(r.dir, '.claude', '.gitignore'), 'utf8'), settled);

  // Dirty retry: a fresh branch off the same base, the old branch kept as evidence
  // (a draft PR may point at it), and the uncommitted change gone.
  writeFileSync(join(r.dir, 'a.txt'), 'dirty\n');
  const r2 = w.ensureWorktree(args);
  assert.equal(r2.branch, 'soma/cr-1-r2');
  assert.equal(r2.reused, false);
  assert.equal(r2.dir, r.dir);
  assert.equal(readFileSync(join(r2.dir, 'a.txt'), 'utf8'), 'two\n');
  assert.equal(git('-C', r2.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'soma/cr-1-r2');
  assert.ok(git('-C', repoPath, 'branch', '--list', 'soma/cr-1').includes('soma/cr-1'));

  // Third attempt: `-r3`. A fixed `-r2` would be refused here by git.
  writeFileSync(join(r2.dir, 'a.txt'), 'dirty again\n');
  assert.equal(w.ensureWorktree(args).branch, 'soma/cr-1-r3');

  // A registered worktree whose dir was deleted recovers instead of dying at add.
  rmSync(r.dir, { recursive: true, force: true });
  const r4 = w.ensureWorktree(args);
  assert.equal(r4.branch, 'soma/cr-1-r4');
  assert.equal(existsSync(join(r4.dir, 'a.txt')), true);

  // The state root is a symlinked path on macOS (/var -> /private/var) and git
  // reports worktrees by their real path, so the "is it already there" match has to
  // survive that — every reuse above is the proof.
  assert.ok(git('-C', repoPath, 'worktree', 'list').includes('worktrees/app/cr-1'));
  assert.equal(existsSync(p('state', 'repo-app.lock')), false);
});

test('against real git: removeWorktree unregisters, then no-ops', async (t) => {
  const { w, p } = await fresh(t, 'real-remove');
  if (w.defaultRun(['--version']).code !== 0) return t.skip('git not available');
  const root = mkdtempSync(join(tmpdir(), 'soma-repo-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  hermetic(t, root);
  const { repoPath } = repoFixture(root);
  const args = { repo: 'app', taskId: 'cr-1', base: 'develop', repoPath };

  const r = w.ensureWorktree(args);
  w.removeWorktree({ repo: 'app', taskId: 'cr-1', repoPath });
  assert.equal(existsSync(r.dir), false);
  assert.equal(git('-C', repoPath, 'worktree', 'list').includes('worktrees/app/cr-1'), false);
  w.removeWorktree({ repo: 'app', taskId: 'cr-1', repoPath });   // idempotent

  // A worktree with uncommitted work is git's to refuse; force is the operator's
  // explicit "throw it away". Respawning after a remove also proves the surviving
  // branch does not wedge the task: `soma/cr-1` is still there, so this is `-r2`.
  const again = w.ensureWorktree(args);
  assert.equal(again.branch, 'soma/cr-1-r2');
  writeFileSync(join(again.dir, 'a.txt'), 'dirty\n');
  assert.throws(() => w.removeWorktree({ repo: 'app', taskId: 'cr-1', repoPath }), /worktree remove .* failed/);
  assert.equal(existsSync(again.dir), true);
  w.removeWorktree({ repo: 'app', taskId: 'cr-1', force: true, repoPath });
  assert.equal(existsSync(again.dir), false);
  assert.equal(existsSync(p('state', 'repo-app.lock')), false);
});
