import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The tests run with `CLAUDE_CONFIG_DIR` unset, for the reason
 * `test/settings-gen.test.mjs` states: the operator's real root is set on the machine this
 * ships on, and the default-root assertions have to be deterministic. The tests that care
 * about the override set it explicitly in the `env` they hand `checks`, which is a
 * parameter here rather than a read of the process environment.
 */
delete process.env.CLAUDE_CONFIG_DIR;

const load = (tag) => import(`../bin/lib/doctor.mjs?${tag}-${Date.now()}`);

/** A throwaway state root, cleaned up when the test ends. */
const somaHome = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'soma-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.SOMA_HOME = home;
  return home;
};

/** A throwaway $HOME seeded with one user-scope MCP server. */
const fakeHome = (t, claudeJson) => {
  const saved = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  t.after(() => { process.env.HOME = saved; rmSync(home, { recursive: true, force: true }); });
  process.env.HOME = home;
  if (claudeJson) writeFileSync(join(home, '.claude.json'), JSON.stringify(claudeJson));
  return home;
};

const UUID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

/**
 * The REAL generated guard file and lead settings — not a hand-written fixture.
 *
 * This is the whole point of the doctor test. Every rule-shaped assertion below is a
 * statement about `settings-gen`'s current output, so deleting a rule from
 * `STANDING_DENIES` reddens the doctor check that names it. A hand-written fixture would
 * make these tests assert that doctor agrees with the fixture, which is a tautology
 * dressed as coverage — the "expected value produced by something other than the guard"
 * mechanism the build's toothless-test audit measured 8 instances of.
 */
const realFiles = async (t) => {
  const home = somaHome(t);
  fakeHome(t, { mcpServers: { extra_mcp: {} }, projects: { '/x': { mcpServers: { notion: {} } } } });
  const { ensureTree, leadDir } = await import(`../bin/lib/paths.mjs?dr-${Date.now()}`);
  ensureTree();
  mkdirSync(leadDir('cr-1'), { recursive: true });
  const s = await import(`../bin/lib/settings-gen.mjs?dr-${Date.now()}`);
  // The REAL argv too, and for the same reason as the two files: `lead edit ban on argv` is a
  // statement about what `spawn.buildLeadArgv` emits, so shortening `BANNED_TOOLS` must redden
  // it. A hand-written `['--disallowedTools', 'Edit,Write,NotebookEdit']` here would make that
  // check assert only that doctor agrees with this line.
  const sp = await import(`../bin/lib/spawn.mjs?dr-${Date.now()}`);
  const wt = mkdtempSync(join(tmpdir(), 'wt-'));
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  return {
    home,
    guardFile: JSON.parse(readFileSync(s.writeWorktreeGuardrails(wt, { teammateAllow: [] }), 'utf8')),
    leadSettings: JSON.parse(readFileSync(s.writeLeadSettings('cr-1'), 'utf8')),
    // The server names of the lead mcp.json soma REALLY writes, in the order it writes them.
    // A hand-written `['soma']` stood here while the generator wrote two servers, so the
    // healthy-machine test kept certifying a check that FAILed on every fleet with a lead.
    leadMcpServers: Object.keys(JSON.parse(readFileSync(s.writeLeadMcpConfig('cr-1'), 'utf8')).mcpServers),
    leadArgv: sp.buildLeadArgv({ id: 'cr-1', sessionUuid: 'u1', brief: 'b', settingsPath: '/s', mcpPath: '/m', standingPath: '/d' }),
    mcpServers: s.enumerateUserMcpServers(),
  };
};

/** `gh pr create --help`, as this machine's `gh` actually prints it (measured 2026-07-30). */
const GH_HELP = [
  'Create a pull request on GitHub.', '',
  'FLAGS', '  -a, --assignee login       Assign people by their login.',
  '  -B, --base branch          The branch into which you want your code merged',
  '  -d, --draft                Mark pull request as a draft',
  '      --dry-run              Print details instead of creating the PR.',
  '  -f, --fill                 Use commit info for title and body',
  // The trap for a naive "any --no-* flag is a draft negation" scan: this one ships today
  // and has nothing to do with drafts.
  '      --no-maintainer-edit   Disable maintainer\'s ability to modify pull request',
  '  -w, --web                  Open the web browser to create a pull request',
].join('\n');

/** The real gate's stdout for a tripped lead — runHook's wrapper around evaluateGate's deny. */
const DENY_TRIPPED = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: "soma: this task's budget is spent (BUDGET_TRIPPED). Wind down." } });

/**
 * Stream-json transcripts of the cd-compound probe, in the shapes the REAL binaries emitted
 * (trimmed to the frames the classifier reads; the paths are shortened). Three states and a
 * corpus for each, because a check whose job is to catch a build that stops leads on a
 * permission prompt must not be able to pass by failing to observe.
 */
const CD_CMD = 'cd /tmp/soma-doctor-cd-x/other && grep -n x y.txt';
const cdUse = (command, id = 'toolu_01') => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const cdResult = (content, is_error = false, id = 'toolu_01') => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
const ASK_TEXT = 'This Bash command contains multiple operations. The following parts require approval: cd /tmp/soma-doctor-cd-x/other, grep -n x y.txt';
const cdDenied = (id = 'toolu_01') => ({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: id, decision_reason_type: 'subcommandResults', message: ASK_TEXT });
const CD_INIT = { type: 'system', subtype: 'init', cwd: '/tmp/soma-doctor-cd-x/cwd' };
const CD_END = { type: 'result', subtype: 'success', is_error: false, num_turns: 2 };
/** 2.1.263 (p1c): the compound RAN. `Shell cwd was reset` is appended by Claude Code itself. */
const RAN_EVENTS = [CD_INIT, cdUse(CD_CMD), cdResult('1:x\nShell cwd was reset to /tmp/soma-doctor-cd-x/cwd'), CD_END];
/** 2.1.259 (q1b): the bypass-immune ASK — an `is_error` tool_result AND a permission_denied event. */
const ASKED_EVENTS = [CD_INIT, cdUse(CD_CMD), cdDenied(), cdResult(ASK_TEXT, true), CD_END];

/**
 * A probe set in which every observation is healthy — built from the real generated files.
 *
 * Every check `checks()` emits must be represented here, or the "healthy machine" test
 * below fails on the unobserved count. That is deliberate: it is the fence that stops a
 * check being added without a healthy reading, and stops one silently disappearing.
 */
const healthy = (files, over = {}) => normalize(files, {
  nodeMajor: () => 24,
  tmuxVersion: () => '3.6',
  gitVersion: () => '2.45.1',
  claudePing: () => true,
  // The 2.1.263 transcript, verbatim in shape: the compound ran. A `() => true` here would be
  // the sketch's rubber stamp — the check has to read the transcript, so the fixture is one.
  cdCompoundRead: () => RAN_EVENTS,
  ghAuth: () => true,
  workflowsEnabled: () => true,
  notifier: () => ({ ok: true, detail: 'osascript' }),
  repos: () => ({}),
  leadMcpServers: () => files.leadMcpServers,
  // `{servers, read, unreadable}`, not a bare array: the check has to be able to tell "no soma
  // in user scope" from "the file that would say was unreadable", and a bare array cannot.
  userScopeSomaServers: () => ({ servers: [], read: ['/h/.claude.json'], unreadable: [] }),
  // The REAL `existsSync`, against the real script paths the real generators just wrote
  // into `files`. A `() => true` stub here would make the healthy reading of "the command
  // points at a script that exists" unfalsifiable — which is the sentence the module header
  // claimed for most of this build while nothing checked it.
  hookScriptExists: () => (fp) => typeof fp === 'string' && fp !== '' && existsSync(fp),
  leadSettings: () => ({ live: files.leadSettings, reference: files.leadSettings }),
  guardFile: () => ({ live: files.guardFile, reference: files.guardFile }),
  leadArgv: () => files.leadArgv,
  worktreeGuards: () => [{ worktree: '/abs/soma/worktrees/app/task-x', path: '/abs/soma/worktrees/app/task-x/.claude/settings.local.json', bytes: 4096, rules: 97 }],
  mcpServers: () => files.mcpServers,
  teammateAllow: () => [],
  claudeConfig: () => ({ home: '/h', root: '/h/.claude', file: '/h/.claude.json', override: false, rootExists: true }),
  harnessCount: () => 6,
  ghPrCreateHelp: () => GH_HELP,
  leadNode: () => ({ path: '/n/bin/node', version: 'v24.14.1' }),
  enginesNode: () => '>=24',
  hookSessionId: () => UUID,
  somaHome: () => '/abs/soma',
  tripPath: (id) => `/abs/soma/leads/${id}/BUDGET_TRIPPED`,
  // Behavioural agreement, as the real probe reports it: the gate denied over the flag the
  // writer wrote, and fell silent once it was removed.
  gateBudgetProbe: () => ({ withFlag: DENY_TRIPPED, withoutFlag: '' }),
  // `{files, unreadable}`: a sweep that could not open a directory must not be able to answer
  // "0 stale", which is what an unconditional `[]` did.
  scratchFiles: () => ({ files: [], unreadable: [] }),
  // The seat pool (account rotation): two seats, both directories, both logged in, both on the
  // fleet's shared projects/ tree, one server each that the enumeration carries. `seats` carries
  // the read; the three that follow take the list as their argument, the way the checks call them.
  seats: () => [
    { label: 'seat-a', config_dir: '/h/.claude-seat-a', exists: true },
    { label: 'seat-b', config_dir: '/h/.claude-seat-b', exists: true },
  ],
  seatsLoggedIn: (seats) => seats.map((s) => ({ label: s.label, config_dir: s.config_dir, loggedIn: true })),
  seatProjects: (seats) => ({
    fleet: { path: '/h/.claude/projects' },
    seats: seats.map((s) => ({ label: s.label, config_dir: s.config_dir, projects: { path: '/h/.claude/projects' } })),
  }),
  seatMcpCoverage: (seats) => ({
    union: [...files.mcpServers, 'seat-only-a', 'seat-only-b'],
    seats: seats.map((s) => ({ label: s.label, config_dir: s.config_dir, own: { servers: [s.label === 'seat-a' ? 'seat-only-a' : 'seat-only-b'] } })),
  }),
  // The pool state file, in the state a newly seated fleet is in: seats declared, none ever closed,
  // so state/seats.json does not exist yet. That is healthy, and a different sentence from torn.
  seatPool: () => ({ state: 'absent', path: '/abs/soma/state/seats.json' }),
  ...over,
});

/**
 * `leadSettings` and `guardFile` answer `{live, reference}`, and doctor's subject is
 * `live ?? reference`. A test that overrides one of them with a BARE settings object means
 * "the live file looks like this", so the generator's reference is left pristine — which is
 * what makes such a mutation read as a live-file finding rather than a generator one. A
 * test that wants no live file at all passes `{live: null, reference}` explicitly.
 */
const normalize = (files, probe) => {
  const wrap = (key, pristine) => {
    const fn = probe[key];
    probe[key] = () => {
      const v = fn();
      if (v === null || typeof v !== 'object' || 'live' in v || 'reference' in v) return v;
      return { live: v, reference: pristine };
    };
  };
  wrap('leadSettings', files.leadSettings);
  wrap('guardFile', files.guardFile);
  return probe;
};

const by = (results, name) => {
  const r = results.find((x) => x.name === name);
  assert.ok(r, `no check named ${JSON.stringify(name)} — the check was renamed or dropped`);
  return r;
};

/* ------------------------------------------------------------------ the sketch's two */

test('checks fail when node < 24 or claude not authed', async (t) => {
  const files = await realFiles(t);
  const { checks } = await load('sketch');
  const results = checks({}, healthy(files, { nodeMajor: () => 20, claudePing: () => false }));
  assert.equal(by(results, 'node>=24').ok, false);
  assert.match(by(results, 'node>=24').detail, /\b20\b/, 'the detail must print what it resolved');
  assert.equal(by(results, 'claude auth').ok, false);
  // …and nothing else went red with them, which is what makes the two above attributable.
  assert.deepEqual(results.filter((r) => r.ok === false).map((r) => r.name), ['node>=24', 'claude auth']);
});

test('checks pass on a healthy machine, and every check is observed', async (t) => {
  const files = await realFiles(t);
  const { checks, CHECKS } = await load('healthy');
  const results = checks({ CLAUDE_CODE_SESSION_ID: UUID }, healthy(files));
  assert.deepEqual(results.filter((r) => r.ok !== true).map((r) => `${r.name}: ${r.detail}`), [],
    'a healthy machine must produce no FAIL and no unobserved check');
  // The name list is the published contract — the runbook and `soma up` quote it. Pinned as
  // an exact set so a check cannot be added without a healthy reading, or vanish unnoticed.
  assert.deepEqual(results.map((r) => r.name), [...CHECKS]);
  assert.equal(new Set(CHECKS).size, CHECKS.length, 'two checks share a name');
});

test('on a COLD machine the rule checks judge the generator, not nothing', async (t) => {
  // MEASURED on this machine against the first implementation: with no lead and no worktree
  // yet, reading only the live files left TWELVE checks unobserved — every rule-shaped one,
  // including the credential family, both PreToolUse matchers and the two account-side
  // wildcards. That is the run an operator makes on a fresh install, which is exactly when a
  // generator regression is cheapest to catch, and doctor was blind to it.
  const files = await realFiles(t);
  const { checks } = await load('cold');
  const cold = checks({ CLAUDE_CODE_SESSION_ID: UUID }, healthy(files, {
    leadSettings: () => ({ live: null, reference: files.leadSettings }),
    guardFile: () => ({ live: null, reference: files.guardFile }),
    // No `worktrees/` root either — a cold machine has nothing to enumerate, and reporting
    // that as a pass is the `[].every()` trap.
    worktreeGuards: () => null,
    leadMcpServers: () => null,
  }));
  for (const name of ["lead PreToolUse matcher '*'", "worktree PreToolUse matcher '*'", 'guard file self-protect',
    'no inert Write() rule', 'every Bash rule keeps a wildcard', 'mcp deny drift', 'mcp deny mcp__claude_ai_*',
    'mcp deny mcp__plugin_*', 'credential-store command denies', 'credential-store Read() denies',
    'protected-ref single-command paths', 'no edit ban in settings files', 'lead edit ban on argv']) {
    assert.equal(by(cold, name).ok, true, `${name} went unobserved on a cold machine`);
  }
  // …and the report says which source it read, or the operator cannot tell an assertion
  // about a live worktree from one about the generator.
  assert.match(by(cold, 'worktree guard file readable').detail, /no live file yet|would write NOW/i);
  assert.match(by(cold, 'credential-store command denies').detail, /generated reference/);
  // The whole unobserved set, as an exact list — which also pins the one thing that genuinely
  // cannot be made on a cold machine (the live-vs-generator comparison) and the two vacuous
  // ones (no lead to read, no worktree to enumerate). A separate `=== null` assertion for the
  // generator row used to sit above this line and could add nothing: this deepEqual already
  // pins the whole set including that name.
  assert.deepEqual(cold.filter((r) => r.ok === null).map((r) => r.name),
    ['every worktree guard file carries rules', 'lead mcp single-server', 'guard file matches the generator']);
});

test('a live worktree whose guard file predates a rule is drift a respawn fixes', async (t) => {
  // The `*` in `.claude/.gitignore` means this difference shows up in neither `git status`
  // nor the PR, so nothing but doctor reports it — and every teammate spawned into that
  // worktree keeps the OLD rules.
  const files = await realFiles(t);
  const { checks } = await load('gendrift');
  const stale = { ...files.guardFile, permissions: { ...files.guardFile.permissions,
    deny: files.guardFile.permissions.deny.filter((d) => !d.startsWith('Read(')) } };
  const r = checks({}, healthy(files, { guardFile: () => ({ live: stale, reference: files.guardFile }) }));
  assert.equal(by(r, 'guard file matches the generator').ok, false);
  assert.match(by(r, 'guard file matches the generator').detail, /Read\(~\/\.aws/);
  assert.match(by(r, 'guard file matches the generator').detail, /respawn/i, 'the operator needs the fix, not just the diff');
  // A rule ADDED by hand is the same finding from the other side.
  const edited = { ...files.guardFile, permissions: { ...files.guardFile.permissions,
    deny: [...files.guardFile.permissions.deny, 'Bash(hand-edited*)'] } };
  const r2 = checks({}, healthy(files, { guardFile: () => ({ live: edited, reference: files.guardFile }) }));
  assert.equal(by(r2, 'guard file matches the generator').ok, false);
  assert.match(by(r2, 'guard file matches the generator').detail, /hand-edited/);
  // …and an identical pair is not drift.
  assert.equal(by(checks({}, healthy(files)), 'guard file matches the generator').ok, true);
});

test('drift that is only the soma-pr install path is two copies of soma, not a stale file', async (t) => {
  // The soma-pr allow rules embed the absolute path of the copy that wrote them, so a doctor
  // run from any OTHER copy (a worktree checkout of this repo, a second clone) reported drift
  // on a guard file that is byte-for-byte what the live spawner writes — measured on the
  // machine this fix was written on, from inside a soma-cut worktree of soma itself.
  const files = await realFiles(t);
  const { checks } = await load('repin');
  const repin = (r) => (typeof r === 'string' ? r.replace(/^(Bash\((?:node )?)\/.*\/bin\/soma-pr\.mjs/, '$1/somewhere/else/bin/soma-pr.mjs') : r);
  const moved = { ...files.guardFile, permissions: { deny: files.guardFile.permissions.deny,
    allow: files.guardFile.permissions.allow.map(repin) } };
  const r = checks({}, healthy(files, { guardFile: () => ({ live: moved, reference: files.guardFile }) }));
  assert.equal(by(r, 'guard file matches the generator').ok, true, 'an install-path repin was reported as drift');
  assert.match(by(r, 'guard file matches the generator').detail, /different copy/);
  assert.match(by(r, 'guard file matches the generator').detail, /\/somewhere\/else/);
  // …but a repin does not LICENSE drift: a rule really lost still fails, path difference or no.
  const alsoStale = { ...moved, permissions: { ...moved.permissions,
    deny: moved.permissions.deny.filter((d) => !d.startsWith('Read(')) } };
  const r2 = checks({}, healthy(files, { guardFile: () => ({ live: alsoStale, reference: files.guardFile }) }));
  assert.equal(by(r2, 'guard file matches the generator').ok, false);
});

test("a user-scope soma bus is expected when it is init's own pinned registration", async (t) => {
  // `soma init` registers the bus at user scope ON PURPOSE — it is how a promoted operator
  // session drives the fleet — and the old blanket FAIL taught the operator to skim past
  // this row. Leads never inherit user scope (--strict-mcp-config); teammates that discover
  // the role-less candidate bus are denied it by the gate's bus arm. So what stays a
  // finding is a pin-less registration (the measured wrong-fleet failure) and a soma-shaped
  // server that runs something other than soma's own bus.
  const files = await realFiles(t);
  const { checks } = await load('userscope');
  const scoped = (servers) => by(checks({}, healthy(files, {
    userScopeSomaServers: () => ({ servers, read: ['/h/.claude.json'], unreadable: [] }),
  })), 'no orch soma in user scope');

  // init's own registration, pinned to the root this run inspects → EXPECTED, and says so.
  const pinnedHere = scoped([{ name: 'soma', runsBus: true, root: '/abs/soma' }]);
  assert.equal(pinnedHere.ok, true);
  assert.match(pinnedHere.detail, /Expected/);
  assert.match(pinnedHere.detail, /strict-mcp-config/);

  // …pinned to a DIFFERENT root: it drives that fleet, not this one. Environmental, named.
  const pinnedElsewhere = scoped([{ name: 'soma', runsBus: true, root: '/abs/other' }]);
  assert.equal(pinnedElsewhere.ok, true);
  assert.match(pinnedElsewhere.detail, /different state root/);
  assert.match(pinnedElsewhere.detail, /\/abs\/other/);

  // …with NO pin: a promoted session would drive whatever root its own environment resolves —
  // the measured wrong-fleet failure `soma init` was fixed for. A finding, with the remedy.
  const unpinned = scoped([{ name: 'soma', runsBus: true, root: null }]);
  assert.equal(unpinned.ok, false);
  assert.match(unpinned.detail, /NO SOMA_HOME/);
  assert.match(unpinned.detail, /soma init/);

  // …soma-shaped but not soma's bus: nothing audited what it serves. A finding.
  const foreign = scoped([{ name: 'soma-bridge', runsBus: false, root: '/abs/soma' }]);
  assert.equal(foreign.ok, false);
  assert.match(foreign.detail, /soma-bus\.mjs/);
});

/* ------------------------------------------- both PreToolUse matchers */

test('a narrowed PreToolUse matcher is a FAIL on the file that carries it, not on both', async (t) => {
  // Measured consequences of the two wrong values, with the matcher as the only variable:
  // lead settings under 'Bash' left `Task` — where most spend goes — outside the budget
  // breaker; the worktree file under 'Edit|Write|NotebookEdit' left teammates' Bash
  // unhooked, and a real bypassed teammate emptied its own guard file with `tee`.
  const files = await realFiles(t);
  const { checks } = await load('matchers');
  const narrow = (j, m) => ({ ...j, hooks: { ...j.hooks, PreToolUse: [{ ...j.hooks.PreToolUse[0], matcher: m }] } });

  const lead = checks({}, healthy(files, { leadSettings: () => narrow(files.leadSettings, 'Bash') }));
  assert.equal(by(lead, "lead PreToolUse matcher '*'").ok, false);
  assert.match(by(lead, "lead PreToolUse matcher '*'").detail, /Bash/);
  assert.equal(by(lead, "worktree PreToolUse matcher '*'").ok, true, 'the wrong file was blamed');

  const wt = checks({}, healthy(files, { guardFile: () => narrow(files.guardFile, 'Edit|Write|NotebookEdit') }));
  assert.equal(by(wt, "worktree PreToolUse matcher '*'").ok, false);
  assert.equal(by(wt, "lead PreToolUse matcher '*'").ok, true, 'the wrong file was blamed');

  // A hook entry that is gone entirely is the same finding, not a crash.
  const gone = checks({}, healthy(files, { leadSettings: () => ({ ...files.leadSettings, hooks: {} }) }));
  assert.equal(by(gone, "lead PreToolUse matcher '*'").ok, false);
  assert.match(by(gone, "lead PreToolUse matcher '*'").detail, /no PreToolUse/i);
});

/* ------------------------------------------------ the command, not only the matcher */

/**
 * ⚠ **THESE THREE SPELLINGS OF A WHOLLY INERT GATE EACH PRODUCED `doctor: PASS — all 39
 * checks hold` WITH ZERO ROWS MOVING**, on BOTH files, because nothing in doctor read a
 * hook's command. The matcher was `'*'`, the entry was in the file, and the report deferred
 * the credential and protected-ref residual class to a gate it had just certified without
 * observing.
 */
test('an inert gate is a FAIL: a missing script, an empty hooks list, and a command that is not the gate', async (t) => {
  const files = await realFiles(t);
  const { checks } = await load('gatecmd');
  const entry = (j) => j.hooks.PreToolUse[0];
  const withHooks = (j, hooks) => ({ ...j, hooks: { ...j.hooks, PreToolUse: [{ ...entry(j), hooks }] } });
  const LEAD = 'lead PreToolUse command runs the gate';
  const WT = 'worktree PreToolUse command runs the gate';

  // (1) the command points at a lead-gate.mjs that is not on disk.
  const missing = withHooks(files.leadSettings, [{ type: 'command', command: "node '/nowhere/bin/hooks/lead-gate.mjs'" }]);
  const r1 = checks({}, healthy(files, { leadSettings: () => missing }));
  assert.equal(by(r1, LEAD).ok, false);
  assert.match(by(r1, LEAD).detail, /NOT on disk/);
  assert.equal(by(r1, WT).ok, true, 'the wrong file was blamed');
  assert.equal(by(r1, "lead PreToolUse matcher '*'").ok, true,
    'the matcher is intact — which is exactly why this needed its own check');

  // (2) `hooks: []` with the matcher untouched. The gate is asked and nothing answers.
  const empty = checks({}, healthy(files, { guardFile: () => withHooks(files.guardFile, []) }));
  assert.equal(by(empty, WT).ok, false);
  assert.match(by(empty, WT).detail, /NOTHING runs/);
  assert.equal(by(empty, "worktree PreToolUse matcher '*'").ok, true);

  // (3) `command: "true"` — registered, consulted, and allowing everything.
  const alwaysAllow = checks({}, healthy(files, { guardFile: () => withHooks(files.guardFile, [{ type: 'command', command: 'true' }]) }));
  assert.equal(by(alwaysAllow, WT).ok, false);
  assert.match(by(alwaysAllow, WT).detail, /does not run lead-gate\.mjs/);

  // …and a hook that is not a command hook at all.
  const notACommand = checks({}, healthy(files, { leadSettings: () => withHooks(files.leadSettings, [{ type: 'prompt', command: 42 }]) }));
  assert.equal(by(notACommand, LEAD).ok, false);
  assert.match(by(notACommand, LEAD).detail, /type/);

  // The control: the real generated files pass, and they pass by naming what was resolved.
  const ok = checks({}, healthy(files));
  assert.equal(by(ok, LEAD).ok, true, by(ok, LEAD).detail);
  assert.equal(by(ok, WT).ok, true, by(ok, WT).detail);
  assert.match(by(ok, WT).detail, /all running an on-disk lead-gate\.mjs/);
  assert.match(by(ok, LEAD).detail, /all running an on-disk lead-gate\.mjs/);
});

/**
 * The `--session-guard` flag is RETIRED — it switched on the gate's session-discriminated
 * edit arm, gone with the lead edit-ban lift — so its absence is no longer a finding, and
 * its PRESENCE must not become one either: every worktree spawned before the retirement
 * still carries the flag in its guard file, and the gate ignores argv it does not know.
 */
test('a guard file that still carries the retired --session-guard flag is not a finding', async (t) => {
  const files = await realFiles(t);
  const { checks } = await load('staleflag');
  const flagged = (j) => {
    const e = j.hooks.PreToolUse[0];
    return { ...j, hooks: { ...j.hooks, PreToolUse: [{ ...e, hooks: e.hooks.map((h) => ({ ...h, command: `${h.command} --session-guard` })) }] } };
  };
  const r = checks({}, healthy(files, { guardFile: () => flagged(files.guardFile) }));
  assert.equal(by(r, 'worktree PreToolUse command runs the gate').ok, true,
    'a pre-retirement guard file must not start failing doctor');
  // The hooks block sits outside the rule diff, so the stale flag is invisible there too.
  assert.equal(by(r, 'guard file matches the generator').ok, true);
  // …and the same stale flag on the lead's base registration is equally ignorable.
  const both = checks({}, healthy(files, { leadSettings: () => flagged(files.leadSettings) }));
  assert.equal(by(both, 'lead PreToolUse command runs the gate').ok, true);
  assert.match(by(both, 'lead PreToolUse command runs the gate').detail, /all running an on-disk lead-gate\.mjs/);
});

/**
 * The other direction, and it is the one that makes the check safe to ship: **a correct
 * registration spelled differently must not FAIL.** A row that cries wolf on a working gate
 * is a row an operator learns to skip, which costs more than the row is worth.
 */
test('the command check reads a gate registration spelled other than the generator spells it', async (t) => {
  const files = await realFiles(t);
  const { checks } = await load('gatespell');
  const script = files.guardFile.hooks.PreToolUse[0].hooks[0].command.match(/'([^']*)'/)[1];
  const WT = 'worktree PreToolUse command runs the gate';
  const spell = (command) => checks({}, healthy(files, {
    guardFile: () => ({ ...files.guardFile, hooks: { ...files.guardFile.hooks, PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] } }),
  }));
  for (const command of [
    `node '${script}'`,                                                  // the generator's own
    `/usr/local/bin/node '${script}'`,                                   // an absolute interpreter
    `node --enable-source-maps '${script}'`,                             // a node option in front
    `node ${script}`,                                                    // unquoted (no space in this path)
    `node '${script}' --extra`,                                          // a future argument after it
    `node '${script}' --session-guard`,                                  // a pre-retirement registration
  ]) {
    const r = spell(command);
    assert.equal(by(r, WT).ok, true, `a correct registration read as inert: ${command} -> ${by(r, WT).detail}`);
    assert.match(by(r, WT).detail, /all running an on-disk lead-gate\.mjs/);
  }
  // A path with a space, quoted the way `shq` quotes it, is still one word.
  const spaced = join(t.name ? tmpdir() : tmpdir(), 'a dir with spaces', 'lead-gate.mjs');
  mkdirSync(join(spaced, '..'), { recursive: true });
  writeFileSync(spaced, '// stand-in\n');
  t.after(() => rmSync(join(spaced, '..'), { recursive: true, force: true }));
  const r = spell(`node '${spaced}'`);
  assert.equal(by(r, WT).ok, true, by(r, WT).detail);
});

/* --------------------------------- Edit(./.claude/**), never Write(...) */

test('the guard file must protect itself with Edit(...), and never with the inert Write(...)', async (t) => {
  // Claude Code prints, once per session in every guarded worktree: "Permission deny rule
  // (.claude/settings.local.json): `Write(./.claude/**)` is not matched by file permission
  // checks — only Edit(path) rules are." So a doctor asserting the Write rule asserts a
  // no-op, and the rule itself looked exactly like coverage.
  const files = await realFiles(t);
  const { checks } = await load('editrule');
  const swap = (from, to) => ({ ...files.guardFile,
    permissions: { ...files.guardFile.permissions, deny: files.guardFile.permissions.deny.map((d) => (d === from ? to : d)) } });

  const inert = checks({}, healthy(files, { guardFile: () => swap('Edit(./.claude/**)', 'Write(./.claude/**)') }));
  assert.equal(by(inert, 'guard file self-protect').ok, false, 'the Write spelling was accepted as coverage');
  assert.equal(by(inert, 'no inert Write() rule').ok, false);
  assert.match(by(inert, 'no inert Write() rule').detail, /Write\(\.\/\.claude/);

  // …and the two are independent findings: an ADDED Write rule beside a present Edit rule
  // is still a warning-per-session no-op, and must not be masked by the Edit rule passing.
  const both = checks({}, healthy(files, { guardFile: () => ({ ...files.guardFile,
    permissions: { ...files.guardFile.permissions, deny: [...files.guardFile.permissions.deny, 'Write(./.claude/**)'] } }) }));
  assert.equal(by(both, 'guard file self-protect').ok, true);
  assert.equal(by(both, 'no inert Write() rule').ok, false);
});

/* ---------------------------- the two wildcards, asserted VERBATIM */

test('the two account-side wildcards are asserted verbatim, not inferred from enumeration', async (t) => {
  // Account connectors may already be authenticated with real send/write tools, and
  // NOT ONE of them appears anywhere in `~/.claude.json`. So a
  // doctor that enumerates local config and confirms it is denied passes forever while a
  // connector authorised last week sits wide open. The wildcards are the only defence, and
  // they are exactly the line a later "tidy the deny list" edit removes.
  const files = await realFiles(t);
  const { checks } = await load('wildcards');
  const without = (rule) => ({ ...files.guardFile,
    permissions: { ...files.guardFile.permissions, deny: files.guardFile.permissions.deny.filter((d) => d !== rule) } });

  for (const [rule, name] of [['mcp__claude_ai_*', 'mcp deny mcp__claude_ai_*'], ['mcp__plugin_*', 'mcp deny mcp__plugin_*']]) {
    const r = checks({}, healthy(files, { guardFile: () => without(rule) }));
    assert.equal(by(r, name).ok, false, `${rule} can be deleted with doctor green`);
    assert.match(by(r, name).detail, /missing|absent/i);
    // The enumeration is untouched, which is the point: no local reading can notice this.
    assert.equal(by(r, 'mcp deny drift').ok, true, 'the drift check absorbed a wildcard deletion');
  }

  // A NEAR-MISS spelling must not satisfy it. `mcp__claude_ai*` (no underscore before the
  // star) is a different glob, and "verbatim" is the whole instruction.
  const near = checks({}, healthy(files, { guardFile: () => ({ ...files.guardFile,
    permissions: { ...files.guardFile.permissions,
      deny: files.guardFile.permissions.deny.map((d) => (d === 'mcp__claude_ai_*' ? 'mcp__claude_ai*' : d)) } }) }));
  assert.equal(by(near, 'mcp deny mcp__claude_ai_*').ok, false, 'a near-miss glob was accepted as the rule');
});

/* ------------------------ the credential-store family, both surfaces */

test('the credential-store family is asserted through the matcher, never by executing it', async (t) => {
  // NOTHING HERE RUNS. Every vector is a synthetic command string put through the
  // segment-aware matcher; no keychain is read by this test, by doctor, or anywhere in
  // this suite. The family exists because a review agent on this build read the
  // operator's LIVE Claude OAuth token into its own transcript with one such command.
  const files = await realFiles(t);
  const { checks } = await load('creds');
  const drop = (pred) => ({ ...files.guardFile,
    permissions: { ...files.guardFile.permissions, deny: files.guardFile.permissions.deny.filter((d) => !pred(d)) } });

  // Deleting the keychain rules is a FAIL on the command half and leaves the rest green.
  const noKeychain = checks({}, healthy(files, { guardFile: () => drop((d) => /security|generic-password|dump-keychain/.test(d)) }));
  assert.equal(by(noKeychain, 'credential-store command denies').ok, false);
  assert.match(by(noKeychain, 'credential-store command denies').detail, /find-generic-password/);
  assert.equal(by(noKeychain, 'credential-store Read() denies').ok, true, 'the wrong half was blamed');

  // Deleting the Read(...) half is its OWN finding — no Bash rule can cover the Read tool,
  // which produces no command string at all.
  const noRead = checks({}, healthy(files, { guardFile: () => drop((d) => d.startsWith('Read(')) }));
  assert.equal(by(noRead, 'credential-store Read() denies').ok, false);
  assert.match(by(noRead, 'credential-store Read() denies').detail, /Read\(~\/\.ssh/);
  assert.equal(by(noRead, 'credential-store command denies').ok, true, 'the wrong half was blamed');

  // The check is two-directional: a rule broad enough to refuse ordinary work is also a
  // FAIL, because that is the failure that dead-ends a task rather than leaking a secret.
  const overBroad = checks({}, healthy(files, { guardFile: () => ({ ...files.guardFile,
    permissions: { ...files.guardFile.permissions, deny: [...files.guardFile.permissions.deny, 'Bash(*Cookies*)'] } }) }));
  assert.equal(by(overBroad, 'credential-store command denies').ok, false);
  assert.match(by(overBroad, 'credential-store command denies').detail, /Cookies\.tsx|collateral/i);

  // And the honest claim: the detail must NOT read as "credentials are safe".
  const green = checks({}, healthy(files));
  assert.match(by(green, 'credential-store command denies').detail, /single-command|sandbox|gate/i);
});

/* ----------------- the config root, the union, and the .claude.json asymmetry */

test('the active config root is printed, and .claude.json is resolved BESIDE or INSIDE it', async (t) => {
  // The asymmetry is real and load-bearing: with the override unset the file sits at
  // `$HOME/.claude.json`, BESIDE the config dir; with it set the file sits INSIDE
  // `$CLAUDE_CONFIG_DIR` (measured). A `join(root, '.claude.json')` implementation is
  // therefore wrong in the default case and reads a file that does not exist.
  const files = await realFiles(t);
  const { checks } = await load('root');

  const dflt = checks({}, healthy(files, {
    claudeConfig: () => ({ home: '/h', root: '/h/.claude', file: '/h/.claude.json', override: false, rootExists: true }) }));
  assert.equal(by(dflt, '.claude.json location').ok, true);
  assert.match(by(dflt, 'claude config root').detail, /\/h\/\.claude\b/, 'the ACTIVE root must be printed');
  assert.match(by(dflt, 'claude config root').detail, /default/i);

  const over = checks({}, healthy(files, {
    claudeConfig: () => ({ home: '/h', root: '/h/.claude-second', file: '/h/.claude-second/.claude.json', override: true, rootExists: true }) }));
  assert.equal(by(over, '.claude.json location').ok, true);
  assert.match(by(over, 'claude config root').detail, /override/i, 'an override must be visible, not silent');

  // The bug the correction names: joining onto the root in the DEFAULT case.
  const joined = checks({}, healthy(files, {
    claudeConfig: () => ({ home: '/h', root: '/h/.claude', file: '/h/.claude/.claude.json', override: false, rootExists: true }) }));
  assert.equal(by(joined, '.claude.json location').ok, false);
  assert.match(by(joined, '.claude.json location').detail, /beside/i);

  // …and the mirror image: a file BESIDE an overridden root.
  const beside = checks({}, healthy(files, {
    claudeConfig: () => ({ home: '/h', root: '/h/.claude-second', file: '/h/.claude.json', override: true, rootExists: true }) }));
  assert.equal(by(beside, '.claude.json location').ok, false);
  assert.match(by(beside, '.claude.json location').detail, /inside/i);

  // A root that does not exist is the measured silent-zero defect: a stale `~/.claude`
  // usually still exists, finds no matching session uuid, reports every lead at 0 tokens,
  // and the budget breaker never trips with nothing in any log to say so.
  const missing = checks({}, healthy(files, {
    claudeConfig: () => ({ home: '/h', root: '/h/typo', file: '/h/.claude.json', override: true, rootExists: false }) }));
  assert.equal(by(missing, 'claude config root').ok, false);
  assert.match(by(missing, 'claude config root').detail, /does not exist/i);
});

test('mcp drift compares against the UNION of both roots, and names what is missing', async (t) => {
  // Comparing against ONE root reports drift on every worktree for the wrong reason:
  // `enumerateUserMcpServers` with neither `env` nor `home` unions both roots, and that
  // is the production path.
  const files = await realFiles(t);
  const { checks } = await load('drift');
  assert.ok(files.mcpServers.length >= 2, 'the fixture must seed two scopes for this to mean anything');

  const green = checks({}, healthy(files));
  assert.equal(by(green, 'mcp deny drift').ok, true);
  assert.match(by(green, 'mcp deny drift').detail, new RegExp(`\\b${files.mcpServers.length}\\b`));

  // A server the union can see but the guard file does not deny — the exact shape of the
  // local-scope miss that hid two write-capable local-scope servers.
  const missed = checks({}, healthy(files, { mcpServers: () => [...files.mcpServers, 'srv_write'] }));
  assert.equal(by(missed, 'mcp deny drift').ok, false);
  assert.match(by(missed, 'mcp deny drift').detail, /srv_write/);

  // An allowlisted server is not drift — that is the operator's decision, recorded.
  const allowed = checks({}, healthy(files, {
    mcpServers: () => [...files.mcpServers, 'srv_write'], teammateAllow: () => ['srv_write'] }));
  assert.equal(by(allowed, 'mcp deny drift').ok, true);

  // An enumeration that THREW is a real finding, not a zero. `~/.claude.json` unreadable
  // means every spawn writes a guard file with no personal denies in it.
  const threw = checks({}, healthy(files, { mcpServers: () => { throw new SyntaxError('/h/.claude.json is not valid JSON'); } }));
  assert.equal(by(threw, 'mcp enumeration readable').ok, false);
  assert.match(by(threw, 'mcp enumeration readable').detail, /not valid JSON/);
  // …and drift cannot be judged without it, so it must go UNOBSERVED rather than green.
  assert.equal(by(threw, 'mcp deny drift').ok, null);
});

/* ------------------------------------ the six-entry harness registry */

test('a harness registry that degraded to {} is a FAIL, since silence is its failure mode', async (t) => {
  // `loadHarnesses` degrades to `{}` BY DESIGN so a broken install cannot take down the
  // bus or a watchdog tick. That makes SILENCE the failure mode, and doctor the only
  // thing that can see it.
  const files = await realFiles(t);
  const { checks } = await load('harness');
  for (const [n, why] of [[0, 'unreadable'], [5, 'one dropped'], [7, 'one added']]) {
    const r = checks({}, healthy(files, { harnessCount: () => n }));
    assert.equal(by(r, 'harness registry').ok, false, `${n} harnesses (${why}) read as healthy`);
    assert.match(by(r, 'harness registry').detail, new RegExp(`\\b${n}\\b`));
  }
});

/* ---------------------- the gh flag surface, and the lead's own node */

test('the draft-only guarantee is pinned to the gh flag surface that carries it', async (t) => {
  const files = await realFiles(t);
  const { checks } = await load('gh');
  const green = checks({}, healthy(files));
  assert.equal(by(green, 'gh pr create --draft').ok, true);
  assert.equal(by(green, 'gh pr create draft negation').ok, true);
  // The trap: `--no-maintainer-edit` ships today, so a blanket `--no-*` scan false-alarms.
  assert.match(by(green, 'gh pr create draft negation').detail, /no-maintainer-edit|none/i);

  // A gh release that renames the flag unpins `soma-pr`'s only guarantee, silently.
  const renamed = checks({}, healthy(files, { ghPrCreateHelp: () => GH_HELP.replace('-d, --draft', '-D, --as-draft') }));
  assert.equal(by(renamed, 'gh pr create --draft').ok, false);

  // …and a NEW negation is the other half: `--no-draft` would make the wrapper's injected
  // `--draft` overridable by anything appended after it.
  for (const flag of ['      --no-draft             Do not mark as draft', '      --undraft             Publish immediately']) {
    const neg = checks({}, healthy(files, { ghPrCreateHelp: () => `${GH_HELP}\n${flag}` }));
    assert.equal(by(neg, 'gh pr create draft negation').ok, false, `a new negation slipped through: ${flag}`);
    assert.equal(by(neg, 'gh pr create --draft').ok, true, 'the wrong half was blamed');
  }
});

test('a gh help text that could not be READ is UNOBSERVED, never "no draft negation flag"', async (t) => {
  // THE DEFECT THIS PINS, and it was doctor's own headline defect living inside doctor. The
  // probe was `tryRun('gh', ['pr','create','--help']) ?? ''`, so gh absent from PATH, a
  // non-zero exit and the 20 s timeout ALL became the empty string. The negation check then
  // saw a string, extracted zero draft-negation flags from it, and printed
  //
  //   ok   gh pr create draft negation — no draft negation flag (benign --no-* flags ignored: none)
  //
  // Measured, both ends: `''` -> ok TRUE, `'   '` -> ok TRUE, and the real probe with an empty
  // PATH returned `''`. So on every machine without `gh`, doctor certified that the draft-only
  // guarantee was intact against a help surface it had never read. That `?? ''` is the `?? 0`
  // the module's own header names as one of the inert breakers it exists to catch.
  //
  // WHY THIS IS ITS OWN TEST, and every assertion in it names the negation check: `gh pr create
  // --draft` FAILED in the same run, so the REPORT was red while the ASSERTION was a rubber
  // stamp — which is how this survived a review. A pin that leans on the sibling reproduces the
  // disguise. Reverting the negation fix alone must redden THIS test and nothing else needs to.
  const files = await realFiles(t);
  const { checks } = await load('ghblank');
  const NEG = 'gh pr create draft negation';
  for (const blank of ['', '   ', '\n\t\n', null, undefined, 42, [], {}]) {
    const r = checks({}, healthy(files, { ghPrCreateHelp: () => blank }));
    assert.equal(by(r, NEG).ok, null,
      `${JSON.stringify(blank)} as the help text was judged rather than reported unread`);
    assert.match(by(r, NEG).detail, /not read at all/,
      'the detail must say the read did not happen, instead of reporting on flags it never saw');
    // The sentence that WAS printed, which is the thing an operator would have believed.
    //
    // DELIBERATE NEGATIVE, AND IT IS DOCUMENTATION RATHER THAN MEASUREMENT — do not count it
    // as an assertion. It CANNOT FAIL while the line above passes: those two sentences live in
    // mutually exclusive branches of `ghHelp`, so selecting one satisfies this by
    // construction, and both reverting mutations die at the `ok` pin, never here. Kept
    // because it names the forbidden sentence at the site, and the edit it exists to catch is
    // a plausible one: an author making the unread detail "more helpful" by appending "so
    // there is no draft negation flag" trips it. Adjudicated here rather than left to be
    // re-found — it has been reported three times on this build.
    assert.doesNotMatch(by(r, NEG).detail, /no draft negation flag/);
  }
  // The other half of the same read gets the same answer: an unreadable help is not evidence
  // that `-d, --draft` is gone either. Nothing is lost by not FAILING here — a missing `gh` is
  // `gh auth`'s finding, and it FAILS there, in the same run.
  const noGh = checks({}, healthy(files, { ghPrCreateHelp: () => null, ghAuth: () => false }));
  assert.equal(by(noGh, 'gh pr create --draft').ok, null);
  assert.equal(by(noGh, 'gh auth').ok, false, 'a machine without gh must still FAIL somewhere');

  // …and the check is still ON: a real help text is judged, in both directions.
  assert.equal(by(checks({}, healthy(files)), NEG).ok, true);
  assert.equal(by(checks({}, healthy(files, { ghPrCreateHelp: () => `${GH_HELP}\n      --no-draft   Publish` })), NEG).ok, false);
});

test('the PROBE half of that fix: an unreadable gh help is null, and never the empty string', async (t) => {
  // WHY THIS ASSERTION EXISTS, because it is not what it looks like. It is NOT closing a live
  // hole: the check above maps `''` and `null` to the same `null`, so no verdict can tell them
  // apart, and putting `?? ''` back on the probe was measured across seven probe states with
  // ZERO observable differences in name/ok/detail. The fix's load-bearing half is the check,
  // and that half is pinned twice over.
  //
  // It exists because the only thing standing between a future loosening of that check and the
  // original Critical was PROSE. The boundary is observable at the probe — `null` vs `""`, and
  // the rendered detail prints `(null)` vs `("")` — so it is pinnable, and pinned it cannot be
  // lost quietly. Regression protection on a correct fix, deliberately, not a repair.
  const { defaultProbes } = await load('ghprobe');
  const dir = mkdtempSync(join(tmpdir(), 'ghshim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; });
  // A FIRING CONTROL FIRST: an absence is evidence only once something present proved the
  // observation was live, which is this module's own rule. Without it, `() => null` would pass
  // the pin below just as well as the real probe does.
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\necho shimmed-help\n', { mode: 0o755 });
  process.env.PATH = dir;
  assert.equal(defaultProbes().ghPrCreateHelp(), 'shimmed-help\n',
    'the probe never read the gh on PATH, so the null below would prove nothing');
  // …and with nothing to run, it says so. `''` here is the Critical itself: it is a STRING, and
  // a check handed a string is a check that believes it read the help.
  process.env.PATH = '';
  assert.equal(defaultProbes().ghPrCreateHelp(), null,
    "gh absent from PATH must read null — `?? ''` here is what certified the draft-only guarantee on a machine with no gh");
});

test('a help text that WAS read but is not gh\'s is unobserved too, never "no draft negation flag"', async (t) => {
  // The last residual of the same Critical, and its own test on purpose: `node:test` abandons a
  // test at its first failing assertion, so folding this into the blank-help test above would
  // let any earlier failure there quietly unmeasure it — which is the shape of the original
  // defect, applied to its own pin.
  //
  // A BLANK help is already reported unread. A non-blank one that is not gh's help was still
  // judged, and answered `ok  gh pr create draft negation — no draft negation flag`: honest
  // about the text it read, and that text was never gh's. Reachability is close to nil —
  // `tryRun` answers null on a non-zero exit, so this needs a shim or wrapper named `gh` that
  // exits 0 printing something else — but so did the original, seen from inside this module.
  const files = await realFiles(t);
  const { checks } = await load('ghshim');
  const NEG = 'gh pr create draft negation';
  for (const text of ['nope', 'usage: gh <command> <subcommand> [flags]', GH_HELP.replace('-d, --draft', '-D, --as-draft')]) {
    const r = checks({}, healthy(files, { ghPrCreateHelp: () => text }));
    assert.equal(by(r, NEG).ok, null, `${JSON.stringify(text.slice(0, 40))} was judged for draft negations`);
    // WHICH of the two unobserved reasons, so they cannot be confused: the blank branch says
    // "not read at all" and never names the flag it looked for, so this discriminates them.
    assert.match(by(r, NEG).detail, /-d, --draft/,
      'the detail must name the flag whose absence made this unreadable, not just decline');
    // AND THE SIBLING IS NOT WEAKENED. It must keep FAILING on the same read — that is what
    // makes this residual harmless in effect rather than a fresh place to hide: a machine whose
    // `gh` is a shim is still red, in the same run, off the same reading.
    assert.equal(by(r, 'gh pr create --draft').ok, false,
      'the sibling stopped failing on a help text with no -d, --draft in it');
  }
  // …and the guard is keyed to that flag, not to a length or a keyword, so a real help is still
  // judged. Without this the new branch could fire on everything and the check would be off.
  assert.equal(by(checks({}, healthy(files)), NEG).ok, true, 'the guard swallowed a real gh help text');
});

test("the node a LEAD's PATH resolves to must satisfy engines.node, not the one running doctor", async (t) => {
  // The machine default here is Node 20 and `npm test`'s glob FAILS SILENTLY on it. Doctor
  // itself is usually launched from a shell with nvm active, so `process.version` is the
  // wrong subject: the reading that matters is `node` as resolved on the PATH.
  const files = await realFiles(t);
  const { checks } = await load('leadnode');
  assert.equal(by(checks({}, healthy(files)), 'lead PATH node vs engines.node').ok, true);

  const twenty = checks({}, healthy(files, { leadNode: () => ({ path: '/usr/local/bin/node', version: 'v20.11.0' }) }));
  assert.equal(by(twenty, 'lead PATH node vs engines.node').ok, false);
  assert.match(by(twenty, 'lead PATH node vs engines.node').detail, /v20\.11\.0/);
  assert.match(by(twenty, 'lead PATH node vs engines.node').detail, /\/usr\/local\/bin\/node/, 'the resolved path must be printed');
  // …and the two are separate readings: the in-process node is fine while the lead's is not.
  assert.equal(by(twenty, 'node>=24').ok, true);

  // No `node` on the PATH at all is a FAIL, not an unobserved.
  const none = checks({}, healthy(files, { leadNode: () => null }));
  assert.equal(by(none, 'lead PATH node vs engines.node').ok, false);
});

/* ----------------------------- CLAUDE_CODE_SESSION_ID and the hook payload */

test('a renamed session-id variable is caught by an independent in-session discriminator', async (t) => {
  // The rename is the one event that unpins the whole event-injection path, and it fails
  // closed but QUIETLY. Measured on this machine: a Bash subprocess of a live session
  // carries CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_VERSION and others ALONGSIDE
  // CLAUDE_CODE_SESSION_ID — so "some CLAUDE* variable is set" is an independent witness
  // that we are inside a session, and its presence WITHOUT the session id is the rename.
  const files = await realFiles(t);
  const { checks } = await load('sid');

  assert.equal(by(checks({ CLAUDE_CODE_SESSION_ID: UUID }, healthy(files)), 'CLAUDE_CODE_SESSION_ID').ok, true);

  const renamed = checks({ CLAUDECODE: '1', CLAUDE_CODE_VERSION: '2.1.220' }, healthy(files));
  assert.equal(by(renamed, 'CLAUDE_CODE_SESSION_ID').ok, false, 'a rename read as "not in a session"');
  assert.match(by(renamed, 'CLAUDE_CODE_SESSION_ID').detail, /CLAUDECODE/);

  // Outside a session there is genuinely nothing to read, and that is UNOBSERVED — never
  // a pass. A pass here is what would make the rename invisible.
  const outside = checks({}, healthy(files));
  assert.equal(by(outside, 'CLAUDE_CODE_SESSION_ID').ok, null);

  // Operator CONFIG is not session evidence. `CLAUDE_CONFIG_DIR` is exported from a shell
  // profile on exactly the machines that run a second config root, and matching the CLAUDE*
  // prefix counted it as a witness — so every plain-shell doctor run there reported a rename
  // that never happened. The witness is the runtime trio, by name.
  const configOnly = checks({ CLAUDE_CONFIG_DIR: '/h/.claude-second' }, healthy(files));
  assert.equal(by(configOnly, 'CLAUDE_CODE_SESSION_ID').ok, null, 'operator config read as session evidence');

  // Present but not uuid-shaped is a FAIL: the hook payload's `session_id` is a uuid, so a
  // non-uuid value cannot match one and the comparison would be vacuous.
  for (const bad of ['', '   ', 'not-a-uuid', UUID.slice(0, -1), `${UUID}x`]) {
    const r = checks({ CLAUDE_CODE_SESSION_ID: bad }, healthy(files));
    assert.equal(by(r, 'CLAUDE_CODE_SESSION_ID').ok, false, `${JSON.stringify(bad)} accepted as a uuid`);
  }

  // …and the equality itself.
  const mismatch = checks({ CLAUDE_CODE_SESSION_ID: UUID }, healthy(files, { hookSessionId: () => UUID.replace('0f1e', '9999') }));
  assert.equal(by(mismatch, 'session id matches hook payload').ok, false);
  assert.match(by(mismatch, 'session id matches hook payload').detail, /9999/);

  // No recorded payload is unobserved — the hooks that record it live elsewhere.
  const noPayload = checks({ CLAUDE_CODE_SESSION_ID: UUID }, healthy(files, { hookSessionId: () => null }));
  assert.equal(by(noPayload, 'session id matches hook payload').ok, null);
  // A case difference is not a mismatch: uuids are compared case-insensitively.
  const upper = checks({ CLAUDE_CODE_SESSION_ID: UUID.toUpperCase() }, healthy(files));
  assert.equal(by(upper, 'session id matches hook payload').ok, true);
});

/* ------------------- an absolute SOMA_HOME, and one breaker flag path */

test('SOMA_HOME must be absolute, and the breaker flag path must be the one the gate probes', async (t) => {
  const files = await realFiles(t);
  const { checks } = await load('home');
  const green = checks({}, healthy(files));
  assert.equal(by(green, 'SOMA_HOME absolute').ok, true);
  assert.match(by(green, 'SOMA_HOME absolute').detail, /\/abs\/soma/, 'the resolved root must be printed');

  // `paths.SOMA_HOME()` REFUSES a relative value rather than resolving it, so the probe
  // throws — and a throw here is the finding, not a crash in doctor.
  const rel = checks({}, healthy(files, { somaHome: () => { throw new Error('SOMA_HOME must be an absolute path (got "x")'); } }));
  assert.equal(by(rel, 'SOMA_HOME absolute').ok, false);
  assert.match(by(rel, 'SOMA_HOME absolute').detail, /absolute path/);

  // A trip path that does not sit under the state root is a breaker nobody enforces: the
  // gate only ever probes `<SOMA_HOME>/leads/<id>/BUDGET_TRIPPED`.
  for (const bad of ['/elsewhere/leads/x/BUDGET_TRIPPED', '/abs/soma/leads/x/TRIPPED', '/abs/soma/x/BUDGET_TRIPPED']) {
    const r = checks({}, healthy(files, { tripPath: () => bad }));
    assert.equal(by(r, 'budget flag path').ok, false, `${bad} accepted as the breaker's flag`);
  }
  // …and the reader's half is judged by RUNNING the real gate, never by grepping its source
  // for an import: the gate is dependency-free BY DESIGN, so "resolves through soma's own
  // path helpers" is a property it must NOT have — the text check that demanded it failed
  // every correct install of this repo, forever. A gate that does not deny over the exact
  // flag the writer wrote has forked the derivation.
  const forked = checks({}, healthy(files, { gateBudgetProbe: () => ({ withFlag: '', withoutFlag: '' }) }));
  assert.equal(by(forked, 'budget flag path').ok, false);
  assert.match(by(forked, 'budget flag path').detail, /did NOT deny/);
  // A gate that denies with NO flag on disk is a breaker that trips on nothing.
  const noisy = checks({}, healthy(files, { gateBudgetProbe: () => ({ withFlag: DENY_TRIPPED, withoutFlag: DENY_TRIPPED }) }));
  assert.equal(by(noisy, 'budget flag path').ok, false);
  assert.match(by(noisy, 'budget flag path').detail, /NO flag/);
  // A probe that THREW (spawn refused, gate script missing) is a FAIL naming the throw…
  const threw = checks({}, healthy(files, { gateBudgetProbe: () => { throw new Error('spawn ENOENT'); } }));
  assert.equal(by(threw, 'budget flag path').ok, false);
  assert.match(by(threw, 'budget flag path').detail, /spawn ENOENT/);
  // …a wrong shape is refused by name…
  const shapeless = checks({}, healthy(files, { gateBudgetProbe: () => ({}) }));
  assert.equal(by(shapeless, 'budget flag path').ok, false);
  assert.match(by(shapeless, 'budget flag path').detail, /withFlag/);
  // …and no behavioural probe at all leaves the writer's half alone, which is not agreement:
  // UNOBSERVED, saying why.
  const unprobed = checks({}, healthy(files, { gateBudgetProbe: undefined }));
  assert.equal(by(unprobed, 'budget flag path').ok, null);
  assert.match(by(unprobed, 'budget flag path').detail, /not probed/);
});

test('the real gate process agrees with the writer about where the flag lives', async () => {
  // The end-to-end reading the fixtures above fake: `defaultProbes().gateBudgetProbe()` spawns
  // the REAL hook twice against a scratch root. This is the test that reddens if the gate's
  // own inline state-root derivation ever forks from `paths.SOMA_HOME()`'s answer.
  const { defaultProbes } = await load('gatereal');
  const g = defaultProbes(process.env).gateBudgetProbe();
  const parsed = JSON.parse(g.withFlag);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny', 'the real gate did not find the flag the writer wrote');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /budget|BUDGET_TRIPPED/i);
  assert.equal(g.withoutFlag.trim(), '', 'the real gate denied with no flag on disk');
});

/* ----------------------- a scratch sweep must skip a live pid */

test('a scratch file whose pid is LIVE is a peer at work, never a leftover', async (t) => {
  // Reporting a peer's in-flight scratch as stale is how a sweep deletes it and turns that
  // peer's lock proof into a false timeout. Doctor only ever REPORTS — it deletes nothing —
  // but it must not report a live peer either.
  const files = await realFiles(t);
  const { checks } = await load('scratch');
  const live = { path: '/abs/soma/state/fleet.json.4242.tmp', pid: 4242, live: true };
  const dead = { path: '/abs/soma/state/fleet.json.99999.tmp', pid: 99999, live: false };

  const onlyLive = checks({}, healthy(files, { scratchFiles: () => ({ files: [live], unreadable: [] }) }));
  assert.equal(by(onlyLive, 'state scratch files').ok, true, "a peer's in-flight scratch was reported as debris");
  // `/1 in flight/`, not `/1 in flight|live/i` — BOTH branches of the detail template contain
  // the word "live", so the alternation was satisfied unconditionally: hard-wiring the
  // in-flight count to 0 kept it green. The count is the thing this test is about.
  assert.match(by(onlyLive, 'state scratch files').detail, /1 in flight/);

  const both = checks({}, healthy(files, { scratchFiles: () => ({ files: [live, dead], unreadable: [] }) }));
  assert.equal(by(both, 'state scratch files').ok, false);
  assert.match(by(both, 'state scratch files').detail, /99999/);
  assert.ok(!by(both, 'state scratch files').detail.includes('4242'),
    'the live peer was named in a finding about debris');
  // The STALE branch prints the in-flight count too, and only the clean branch's copy of it was
  // pinned — wiring `${live.length}` to 0 here survived the last round with 67/67 green. Both
  // branches or neither: "1 stale, 0 in flight" is the sentence that sends someone to delete a
  // peer's live scratch, and it is no less wrong for sitting inside a line that already FAILs.
  assert.match(by(both, 'state scratch files').detail, /1 in flight/);
});

/* --------------- the honest claim, and the wildcard invariant */

test('the protected-ref check states single-command paths, never a closed class', async (t) => {
  // Measured routes that all landed `main` on a real remote WHILE THESE RULES WERE IN
  // FORCE: `gh api --method PATCH …/git/refs/heads/main`, `git push
  // "$(git remote get-url origin)" main`, `git push upstream main`, `git send-pack`,
  // `git push origin HEAD` while on main, `git push origin "ma"in`, and a git alias. The
  // class boundary is "writes a protected ref", not "contains `git push`".
  const files = await realFiles(t);
  const { checks } = await load('protected');
  const green = checks({}, healthy(files));
  assert.equal(by(green, 'protected-ref single-command paths').ok, true);
  const d = by(green, 'protected-ref single-command paths').detail;
  assert.match(d, /single-command/i, 'the claim must be scoped to the paths actually closed');
  assert.match(d, /gate|sandbox/i, 'the residual class must name what would close it');
  assert.ok(!/safe|secure|protected branches are/i.test(d), `doctor implied the class is closed: ${d}`);

  // Both directions. Deleting the anchored rules is a FAIL…
  const noAnchor = checks({}, healthy(files, { guardFile: () => ({ ...files.guardFile,
    permissions: { ...files.guardFile.permissions,
      deny: files.guardFile.permissions.deny.filter((r) => !r.includes('origin main')) } }) }));
  assert.equal(by(noAnchor, 'protected-ref single-command paths').ok, false);
  assert.match(by(noAnchor, 'protected-ref single-command paths').detail, /git push origin main/);

  // …and so is a rule broad enough to refuse an ordinary task push, which is the failure
  // that dead-ends a task with a refusal that misdescribes itself.
  const overBroad = checks({}, healthy(files, { guardFile: () => ({ ...files.guardFile,
    permissions: { ...files.guardFile.permissions, deny: [...files.guardFile.permissions.deny, 'Bash(git push*main*)'] } }) }));
  assert.equal(by(overBroad, 'protected-ref single-command paths').ok, false);
  assert.match(by(overBroad, 'protected-ref single-command paths').detail, /soma\/fix-main-nav|collateral/i);
});

test('a wildcard-free Bash rule is whitespace-brittle, and that is a FAIL', async (t) => {
  // Measured with the rule as the only variable: a rule containing `*` matches
  // whitespace-INSENSITIVELY, a rule with none is compared to the RAW segment. So
  // `Bash(echo alpha beta)` lets `echo alpha  beta` RUN while `Bash(echo alpha beta*)`
  // refuses it. A wildcard-free rule added later is a one-keystroke bypass, invisible in
  // review, in a way nothing else in the file is.
  const files = await realFiles(t);
  const { checks } = await load('brittle');
  assert.equal(by(checks({}, healthy(files)), 'every Bash rule keeps a wildcard').ok, true);

  for (const rule of ['Bash(git push origin main)', 'Bash(security find-generic-password)']) {
    const r = checks({}, healthy(files, { guardFile: () => ({ ...files.guardFile,
      permissions: { ...files.guardFile.permissions, deny: [...files.guardFile.permissions.deny, rule] } }) }));
    assert.equal(by(r, 'every Bash rule keeps a wildcard').ok, false, `${rule} passed as whitespace-safe`);
    assert.match(by(r, 'every Bash rule keeps a wildcard').detail, /\bpush origin main\b|generic-password/);
  }
  // The ALLOW list is scanned too — a wildcard-free allow rule silently stops allowing.
  const allow = checks({}, healthy(files, { guardFile: () => ({ ...files.guardFile,
    permissions: { ...files.guardFile.permissions, allow: [...files.guardFile.permissions.allow, 'Bash(node /i/bin/soma-pr.mjs)'] } }) }));
  assert.equal(by(allow, 'every Bash rule keeps a wildcard').ok, false);
});

/* ------------- the ban is on argv, and in no settings file */

/**
 * THE REGRESSION GUARD FOR THE DEFECT THAT COST A WHOLE FLEET ITS HANDS.
 *
 * For most of this build the check under test asserted the OPPOSITE: that
 * `leads/<id>/settings.json` carried `Edit`, `Write` and `NotebookEdit` as bare denies. That
 * file is the base of `settings.launch.json`, which is the value of `--settings`, and
 * `--settings` is inherited by every split-pane teammate (measured, claude 2.1.220, from a
 * real teammate's own argv). So the "correct" state doctor was enforcing took all three write
 * tools off every teammate in the fleet, and a soma fleet produced no code.
 *
 * Both files are exercised, because both reach teammates — the lead's through `--settings`,
 * the worktree's from cwd — and because after the inversion they carry the *same* rule, so a
 * check that read only one would pass while the other disarmed the fleet.
 */
test('a bare write-tool deny in EITHER settings file is a finding, in both files', async (t) => {
  const files = await realFiles(t);
  const { checks } = await load('nodenyfiles');
  const NAME = 'no edit ban in settings files';
  assert.equal(by(checks({}, healthy(files)), NAME).ok, true,
    'the files settings-gen writes today must satisfy the check that judges them');

  // One tool at a time, in each file, so no name and no file can be dropped from the rule
  // and absorbed by a sibling. `Edit(**)` is the control: a PATH rule is not a bare tool
  // deny, it does not remove the tool from a teammate's context, and calling it a finding
  // here would make the guard file's own `Edit(./.claude/**)` self-protect rule illegal.
  for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
    const inLead = checks({}, healthy(files, { leadSettings: () => ({ ...files.leadSettings, permissions: { deny: [tool] } }) }));
    assert.equal(by(inLead, NAME).ok, false, `${tool} in the LEAD settings file went unnoticed — it propagates to every teammate`);
    assert.match(by(inLead, NAME).detail, new RegExp(`lead settings file denies ${tool}`), `${tool} in the lead file is not named in the detail`);

    const inGuard = checks({}, healthy(files, { guardFile: () => ({ ...files.guardFile,
      permissions: { ...files.guardFile.permissions, deny: [...files.guardFile.permissions.deny, tool] } }) }));
    assert.equal(by(inGuard, NAME).ok, false, `${tool} in the WORKTREE guard file went unnoticed — teammates load it from cwd`);
    assert.match(by(inGuard, NAME).detail, new RegExp(`worktree guard file denies ${tool}`), `${tool} in the guard file is not named in the detail`);
  }
  const pathRule = checks({}, healthy(files, { leadSettings: () => ({ ...files.leadSettings, permissions: { deny: ['Edit(**)'] } }) }));
  assert.equal(by(pathRule, NAME).ok, true, 'a path-scoped Edit(**) rule is not a bare tool deny and must not be read as one');

  // Neither file readable → UNOBSERVED, not a pass. An absence proves nothing about files
  // nobody opened, and this module's characteristic defect is exactly that reading.
  const blind = checks({}, healthy(files, { leadSettings: () => ({ live: null, reference: null }), guardFile: () => ({ live: null, reference: null }) }));
  assert.equal(by(blind, NAME).ok, null, 'the check passed while reading no file at all');

  // …and it names the files it DID read, so "no deny found" can be told from "nothing read".
  const oneFile = checks({}, healthy(files, { leadSettings: () => ({ live: null, reference: null }) }));
  assert.equal(by(oneFile, NAME).ok, true);
  assert.doesNotMatch(by(oneFile, NAME).detail, /the lead settings file/,
    'the detail claims a file that could not be read');
});

/**
 * THE OTHER HALF, INVERTED: the argv carries NO edit ban, and doctor guards the regression.
 *
 * The lead-only edit ban is lifted, so `buildLeadArgv` must emit no `--disallowedTools`
 * banning the edit tools. Doctor reads the argv back out and FAILS if the ban is re-imposed.
 * The two spellings — doctor's own `LEAD_BANNED_TOOLS` and the spawner's `BANNED_TOOLS` — are
 * still pinned equal at the end so they name the same set.
 */
test('doctor confirms the argv edit-ban is lifted, and fails if it is re-imposed', async (t) => {
  const files = await realFiles(t);
  const { checks, LEAD_BANNED_TOOLS } = await load('argvban');
  const { BANNED_TOOLS } = await import(`../bin/lib/spawn.mjs?ab-${Date.now()}`);
  const NAME = 'lead edit ban on argv';
  const one = (over) => by(checks({}, healthy(files, over)), NAME);

  // The argv buildLeadArgv emits today carries no --disallowedTools, so the check passes.
  assert.equal(one({}).ok, true, 'the argv buildLeadArgv emits today must satisfy the check that judges it');
  // It must not read as a claim about a live lead — doctor never observes one.
  assert.match(one({}).detail, /NOT from a running lead/);

  // The regression this now guards: a --disallowedTools that names any edit tool re-imposes
  // the lifted ban, so every one of these must FAIL and name the tool it re-banned.
  for (const tool of LEAD_BANNED_TOOLS) {
    const r = one({ leadArgv: () => ['claude', '--disallowedTools', tool] });
    assert.equal(r.ok, false, `--disallowedTools ${tool} re-banned the lead and passed`);
    assert.match(r.detail, new RegExp(tool));
  }
  assert.equal(one({ leadArgv: () => ['claude', '--disallowedTools', 'Edit,Write,NotebookEdit'] }).ok, false,
    'the old full ban must now be reported as a regression');
  // A --disallowedTools that names no edit tool is not the lifted ban, so it passes; and the
  // flag absent entirely is the healthy case.
  assert.equal(one({ leadArgv: () => ['claude', '--disallowedTools', 'Bash'] }).ok, true,
    'a non-edit --disallowedTools value does not re-impose the edit ban');
  assert.equal(one({ leadArgv: () => ['claude', '--model', 'opus'] }).ok, true, 'no --disallowedTools at all is healthy');
  assert.equal(one({ leadArgv: () => 'not an argv' }).ok, false);

  // The drift pin. Doctor and the spawner state the three names independently, so this is the
  // one line that says the two must agree on WHICH tools the (now-lifted) ban names.
  assert.deepEqual([...LEAD_BANNED_TOOLS].sort(), BANNED_TOOLS.split(',').sort(),
    'doctor and the spawner disagree about which tools name the edit ban');
});

/**
 * The recursion guard judges a lead's mcp.json against the SET of servers soma writes there:
 * `soma` and the stateless `sequential-thinking`. It used to demand exactly `["soma"]`, so on
 * every fleet that had spawned a lead it read FAIL and doctor exited 3 (#7). Order is not the
 * subject — a JSON object's key order is the generator's accident — but every other change is:
 * a server missing, one added, or one name standing in for the other.
 */
test('lead mcp single-server passes on the two servers a lead gets, and fails on any other set', async (t) => {
  const files = await realFiles(t);
  const { checks, LEAD_MCP_SERVERS } = await load('mcpset');
  const NAME = 'lead mcp single-server';
  const one = (names) => by(checks({}, healthy(files, { leadMcpServers: () => names })), NAME);

  // The mcp.json writeLeadMcpConfig really wrote, then both orders spelled out by hand.
  assert.equal(one(files.leadMcpServers).ok, true, `the mcp.json soma writes for every lead FAILs: ${one(files.leadMcpServers).detail}`);
  assert.equal(one(['soma', 'sequential-thinking']).ok, true);
  assert.equal(one(['sequential-thinking', 'soma']).ok, true, 'the order of the keys is not the guard');

  for (const names of [
    ['soma'],                                        // the reasoning server missing
    ['sequential-thinking'],                         // the bus missing
    [],
    ['soma', 'sequential-thinking', 'extra_mcp'],    // a third server — the recursion finding
    ['soma', 'extra_mcp'],                           // the right COUNT, a foreign name
    ['soma', 'soma'],                                // the right count, a duplicate
    ['sequential-thinking', 'sequential-thinking'],
    ['soma', 'sequential-thinking', 'soma'],
  ]) {
    assert.equal(one(names).ok, false, `${JSON.stringify(names)} passed the recursion guard`);
  }

  // A FAIL says what it found, what is allowed, and why the rule exists. `extra_mcp` alone
  // makes the last two observable: neither allowed name can come from what was found.
  const foreign = one(['extra_mcp']).detail;
  assert.match(foreign, /extra_mcp/, 'the detail must name what the file serves');
  assert.match(foreign, /\bsoma\b/, 'the detail must name the allowed servers');
  assert.match(foreign, /sequential-thinking/, 'the detail must name the allowed servers');
  assert.match(foreign, /orchestrator bus/, 'the detail must say why: a lead that reaches an orchestrator bus can spawn leads');

  // The drift pin, the same shape as the one above for LEAD_BANNED_TOOLS: doctor states the
  // allowed set itself, so this is the one line that says it is the set the generator writes.
  assert.ok(Array.isArray(LEAD_MCP_SERVERS), 'doctor must state its own list of the servers a lead may hold');
  assert.deepEqual([...LEAD_MCP_SERVERS].sort(), [...files.leadMcpServers].sort(),
    'doctor and writeLeadMcpConfig disagree about which servers a lead holds');
});

/* -------------------------------------------------- the rest of the sketch's checks */

test('the version, auth, notifier, mcp-recursion and per-repo checks each fail alone', async (t) => {
  const files = await realFiles(t);
  const { checks } = await load('rest');
  const one = (over, name) => by(checks({}, healthy(files, over)), name);

  assert.equal(one({ tmuxVersion: () => '3.1' }, 'tmux>=3.2').ok, false);
  assert.equal(one({ tmuxVersion: () => '3.2' }, 'tmux>=3.2').ok, true, 'the floor itself must pass');
  assert.equal(one({ gitVersion: () => '2.30.9' }, 'git>=2.31').ok, false);
  assert.equal(one({ gitVersion: () => '2.31.0' }, 'git>=2.31').ok, true);
  assert.equal(one({ ghAuth: () => false }, 'gh auth').ok, false);
  assert.equal(one({ notifier: () => ({ ok: false, detail: 'no osascript' }) }, 'notifier').ok, false);
  assert.equal(one({ notifier: () => ({ ok: false, detail: 'no osascript' }) }, 'notifier').detail.includes('no osascript'), true);

  // The recursion guard, both halves. A lead that can reach an orchestrator bus can spawn
  // leads, which can spawn leads.
  assert.equal(one({ leadMcpServers: () => ['soma', 'extra_mcp'] }, 'lead mcp single-server').ok, false);
  assert.match(one({ leadMcpServers: () => ['soma', 'extra_mcp'] }, 'lead mcp single-server').detail, /extra_mcp/);
  assert.equal(one({ leadMcpServers: () => ['extra_mcp'] }, 'lead mcp single-server').ok, false, 'a lead mcp.json without soma');
  assert.equal(one({ leadMcpServers: () => [] }, 'lead mcp single-server').ok, false);
  assert.equal(one({ leadMcpServers: () => null }, 'lead mcp single-server').ok, null, 'no lead to read is unobserved');
  // A soma-SHAPED server that does not run soma's own bus is still the recursion finding.
  assert.equal(one({ userScopeSomaServers: () => ({ servers: [{ name: 'soma', runsBus: false, root: null }], read: ['/h/.claude.json'], unreadable: [] }) },
    'no orch soma in user scope').ok, false);

  // Per-repo rows are named individually, or an operator with four repos cannot tell
  // which fetch failed.
  const repos = checks({}, healthy(files, { repos: () => ({
    app: { ok: true, detail: 'main reachable' }, api: { ok: false, detail: 'fetch: host unreachable' } }) }));
  assert.equal(by(repos, 'repo app base reachable').ok, true);
  assert.equal(by(repos, 'repo api base reachable').ok, false);
  assert.match(by(repos, 'repo api base reachable').detail, /host unreachable/);

  // A `workflowsEnabled` that cannot be observed must be UNOBSERVED, not `true`. The
  // sketch hard-coded five `() => true` probes, which is five checks that cannot fail.
  assert.equal(one({ workflowsEnabled: () => null }, 'workflows enabled').ok, null);
  assert.equal(one({ workflowsEnabled: () => false }, 'workflows enabled').ok, false);
});

/* --------------------------------------------------------- the matcher, re-derived */

test('doctor re-derives Claude Code\'s Bash matcher, with the two later corrections', async () => {
  // Every verdict below is one live run against claude 2.1.220, classified from the Bash
  // `tool_result` string. The same table is pinned in `test/settings-gen.test.mjs` against
  // that file's own copy; two copies exist so each is independently pinned to the
  // measurements, and they must not disagree.
  const { bashRuleMatches, deniesCommand } = await load('matcher');

  // round 3 — character semantics
  assert.ok(bashRuleMatches('Bash(git push*origin main)', 'git push origin main'));
  assert.ok(bashRuleMatches('Bash(git push*origin main)', 'git push -u origin main'));
  assert.ok(!bashRuleMatches('Bash(git push*origin main)', 'git push origin mainline'));
  assert.ok(!bashRuleMatches('Bash(git push*origin {main,develop}*)', 'git push origin main'), 'braces are literal');
  assert.ok(!bashRuleMatches('Bash(git push*origin main)', "git push origin 'main'"), 'not shell-unquoted');

  // round 4 — the unit of matching is the SEGMENT, on both sides
  const R = 'Bash(echo probe-alpha)';
  for (const cmd of ['echo probe-alpha', 'echo ok && echo probe-alpha', 'echo probe-alpha && echo ok',
    'echo ok || echo probe-alpha', 'echo probe-alpha;', 'echo probe-alpha | cat', 'echo probe-alpha & wait']) {
    assert.ok(bashRuleMatches(R, cmd), `segment not matched: ${cmd}`);
  }
  assert.ok(!bashRuleMatches(R, 'echo probe-alphax'), 'negative control');
  assert.ok(!bashRuleMatches('Bash(echo a*echo z)', 'echo a && echo z'), 'a wildcard cannot span a segment boundary');

  // whitespace — CONDITIONAL on the rule holding a wildcard, measured both ways
  assert.ok(!bashRuleMatches('Bash(echo alpha beta)', 'echo alpha  beta'), 'no wildcard: raw comparison');
  assert.ok(bashRuleMatches('Bash(echo alpha beta*)', 'echo alpha  beta gamma'), 'wildcard: insensitive');
  assert.ok(bashRuleMatches('Bash(git push*origin main)', 'git push origin  main'));

  // CORRECTION A — a NEWLINE segments too, and it was missing from the recorded set. A
  // checker built from `;` `&&` `||` `|` `&` alone lets a protected push on LINE 2 through.
  assert.ok(bashRuleMatches(R, 'echo ok\necho probe-alpha'), 'newline: second line not matched');
  assert.ok(bashRuleMatches('Bash(git push*origin main)', 'cd /repo\ngit push origin main'),
    'a protected push on line 2 was predicted ALLOW');
  assert.ok(bashRuleMatches('Bash(git push*origin main)', 'cd /repo\r\ngit push origin main'), 'CRLF too');

  // CORRECTION B — the quantifier over the RULE's segments is `every`, not `some`. `some`
  // over-predicts DENY, which in a safety checker is a false OK.
  assert.ok(bashRuleMatches('Bash(echo one && echo two)', 'echo one && echo two'), 'the rule body segments');
  assert.ok(!bashRuleMatches('Bash(echo one && echo two)', 'echo one'), '`some` over-predicted DENY');
  // …and a body that is empty or all separators must deny NOTHING, rather than everything.
  for (const rule of ['Bash()', 'Bash(;)', 'Bash( && )', 'Bash(|)']) {
    assert.ok(!bashRuleMatches(rule, 'git push origin main'), `${rule} vacuously denied everything`);
  }

  // Only `Bash(...)` rules are commands. A file rule is not a command matcher.
  for (const rule of ['Edit(./.claude/**)', 'Read(~/.ssh/**)', 'mcp__claude_ai_*', 'Bash', 'bash(x*)']) {
    assert.ok(!bashRuleMatches(rule, 'git push origin main'), `${rule} matched a command`);
  }
  assert.equal(deniesCommand(['Edit(./.claude/**)', 'Bash(git push*origin main)'], 'git push origin main'), true);
  assert.equal(deniesCommand([], 'git push origin main'), false);
  assert.equal(deniesCommand(['Bash(git push*origin main)'], 'git push origin soma/x'), false);
});

/* ---------------------------------------------------------------- report + wiring */

test('the report prints what was resolved, and an unobserved check is never a pass', async (t) => {
  const files = await realFiles(t);
  const { checks, formatDoctor, runDoctor } = await load('report');

  const results = checks({ CLAUDE_CODE_SESSION_ID: UUID }, healthy(files, {
    claudePing: () => false, workflowsEnabled: () => null, harnessCount: () => 0 }));
  const text = formatDoctor(results);
  assert.match(text, /^FAIL claude auth/m);
  assert.match(text, /^ok {3}node>=24 /m);
  assert.match(text, /^\?\?\?\? workflows enabled/m);
  assert.match(text, /doctor: FAIL/);
  assert.match(text, /2 of \d+ checks? failed/);
  assert.match(text, /1 unobserved/);
  // The names, so an operator does not have to scan the body for them.
  assert.match(text, /failed: claude auth, harness registry/);
  assert.match(text, /unobserved: workflows enabled/);
  // …and the sentence that stops a skip being read as coverage.
  assert.match(text, /unobserved is not a pass/i);

  // A clean run says so, and says how many.
  assert.match(formatDoctor(checks({ CLAUDE_CODE_SESSION_ID: UUID }, healthy(files))), /doctor: PASS — all \d+ checks/);
  // …and NOTHING FAILED BUT SOMETHING DID NOT RUN IS NOT "PASS". `doctor: PASS — 0 of 1 checks
  // hold, 1 unobserved` was the shape: the count and the `unobserved:` line were right, and
  // PASS is still the word an operator skims — this module's own defect in its own summary.
  const incomplete = formatDoctor(checks({}, healthy(files)));      // no CLAUDE* → 2 unobserved
  assert.match(incomplete, /doctor: INCOMPLETE — \d+ of \d+ checks hold, 2 unobserved/);
  // The same deliberate negative as in the gh-blank test above, and the same ruling:
  // documentation, not measurement. `PASS` is an EARLY RETURN in `formatDoctor` and
  // INCOMPLETE/FAIL is the ternary after it, so once the line above matches, this holds by
  // construction; restoring PASS dies there and at the `runDoctor` pin below, never here.
  assert.doesNotMatch(incomplete, /doctor: PASS/);
  assert.match(incomplete, /unobserved: CLAUDE_CODE_SESSION_ID, session id matches hook payload/);
  // The body label is computed from `=== true`/`=== false`, not from `String(ok)` as a key —
  // which rendered the STRING 'true' as `ok  ` in the body while the summary counted it
  // unobserved, one report disagreeing with itself. Unreachable from `checks()`; that is
  // exactly why it would have stayed true until it wasn't.
  const stringy = formatDoctor([{ name: 'x', ok: 'true', detail: 'a detail long enough' }]);
  assert.match(stringy, /^\?\?\?\? x /m, "the string 'true' rendered as a pass in the body");
  assert.match(stringy, /unobserved: x/);
  // A result list that is not a list must not throw out of the formatter.
  for (const junk of [null, undefined, 42, 'nope', {}]) assert.match(formatDoctor(junk), /doctor: ERROR/);

  // runDoctor returns a strict boolean and never writes to stdout when told not to.
  const lines = [];
  const ok = await runDoctor({ env: { CLAUDE_CODE_SESSION_ID: UUID }, probe: healthy(files), write: (s) => lines.push(s) });
  assert.equal(ok, true);
  assert.match(lines.join(''), /doctor: PASS/);
  const bad = await runDoctor({ env: {}, probe: healthy(files, { ghAuth: () => false }), write: () => {} });
  assert.equal(bad, false);
  // An UNOBSERVED check alone does not refuse the machine — but it is loud in the report, and
  // the headline word is INCOMPLETE while the return value is still `true`. Both halves matter:
  // refusing here would train an operator to ignore doctor, and saying PASS would let a `soma
  // up` gate open the queue on a report where safety assertions did not run.
  const skipped = [];
  assert.equal(await runDoctor({ env: {}, probe: healthy(files), write: (s) => skipped.push(s) }), true);
  assert.match(skipped.join(''), /unobserved: CLAUDE_CODE_SESSION_ID/);
  assert.match(skipped.join(''), /doctor: INCOMPLETE/);
  // A broken writer must not turn a verdict into a crash, and a non-function is refused.
  await assert.rejects(() => runDoctor({ probe: healthy(files), write: 'nope' }), /must be a \(text\) => void/);
  assert.equal(typeof await runDoctor({ env: {}, probe: healthy(files), write: () => { throw new Error('EPIPE'); } }), 'boolean');
});

test('EVERY Bash DENY rule in the guard file is load-bearing for exactly one vector', async (t) => {
  // The strongest property this file can state, and it is self-maintaining: delete ANY single
  // `Bash(...)` deny rule from settings-gen and at least one vector in doctor's table stops
  // being denied, so a doctor check reddens. Add a rule without a distinguishing vector and
  // THIS test reddens, which is the fence.
  //
  // SCOPE, stated because the title used to overstate it by one list: this examines
  // `permissions.DENY`. The three `Bash(...)` ALLOW rules (the `soma-pr` wrapper) do survive
  // individual deletion — doctor has no allow-vector table — and that is accepted rather than
  // hidden: deleting an allowance leaks nothing, it only makes the wrapper prompt. The
  // `Read(...)` deny rules have their own fence in the test below, because no vector in this
  // table can reach them: the Read tool produces no command string.
  //
  // It exists because measurement said the obvious vectors were not enough: with only the
  // commands anyone would think to write down, **35 of 68 rules could be deleted individually
  // with doctor green** — two overlapping rules both caught the same vector, so neither was
  // detectable on its own. `Bash(security *)` and `Bash(*find-generic-password*)` both refuse
  // `security find-generic-password …`; only `sudo security find-generic-password` separates
  // them. That is the "expected value produced by something other than the guard" mechanism
  // acting on a deny list, and reading the rules would never have shown it.
  const files = await realFiles(t);
  const { CREDENTIAL_VECTORS, CREDENTIAL_CONTROLS, PROTECTED_VECTORS, PROTECTED_CONTROLS, deniesCommand } = await load('loadbearing');
  const deny = files.guardFile.permissions.deny;
  const bash = deny.filter((r) => r.startsWith('Bash('));
  const vectors = [...CREDENTIAL_VECTORS, ...PROTECTED_VECTORS];
  const controls = [...CREDENTIAL_CONTROLS, ...PROTECTED_CONTROLS];

  assert.ok(bash.length >= 60, `only ${bash.length} Bash rules — the generator lost most of its rules`);
  assert.deepEqual(vectors.filter((c) => !deniesCommand(deny, c)), [], 'a vector doctor asserts is not actually denied');
  assert.deepEqual(controls.filter((c) => deniesCommand(deny, c)), [], 'a control command is collateral damage');

  const unpinned = bash.filter((rule) => {
    const without = deny.filter((r) => r !== rule);
    // No `deniesCommand(deny, c) &&` conjunct here: the assertion three lines up already
    // established that EVERY vector is denied by the full list, so that half was true by
    // construction and read as a condition doing work.
    return !vectors.some((c) => !deniesCommand(without, c));
  });
  assert.deepEqual(unpinned, [],
    'these rules can be deleted with every doctor check green — each needs a vector that ONLY it refuses');
  // Two vectors that are the same vector are one vector.
  assert.equal(new Set(vectors).size, vectors.length, 'the vector table has duplicates');
  assert.equal(new Set(controls).size, controls.length, 'the control table has duplicates');
});

test('EVERY Read(...) rule is load-bearing too — the surface no Bash vector can reach', async (t) => {
  // THE GAP THIS CLOSES. `settings-gen` shipped THIRTEEN `Read(...)` rules;
  // `CREDENTIAL_READ_RULES` asserted SEVEN, and `settings-gen.test.mjs` pinned the SAME seven —
  // so the six browser cookie and saved-password rules were pinned by nothing anywhere, and
  // **deleting `Read(~/.mozilla/**)` outright left all 552 tests green.** A hardcoded list
  // wearing a better name, on the one surface no `Bash(...)` rule reaches: for a credential
  // file at rest the Read rule is the half that carries the weight, because
  // `Bash(cat*credentials*)` loses to `head`, `less` and `python`.
  //
  // Two properties, and neither of them is "the list got longer" — six more assertions would be
  // the same hardcoded list with a longer list, drifting again on the next rule added.
  const files = await realFiles(t);
  const { checks, CREDENTIAL_READ_RULES } = await load('readfence');
  const NAME = 'credential-store Read() denies';
  const shipped = files.guardFile.permissions.deny.filter((r) => r.startsWith('Read('));

  // (1) THE FENCE: doctor's asserted set must BE the generator's set. A `Read(...)` rule added
  //     to settings-gen tomorrow without an assertion reddens here, loudly, instead of quietly
  //     joining the six that had none.
  assert.deepEqual([...shipped].sort(), [...CREDENTIAL_READ_RULES].sort(),
    'doctor asserts a different set of Read(...) rules than settings-gen ships — the difference is rules pinned by nothing');
  assert.equal(new Set(shipped).size, shipped.length, 'the generator ships a duplicate Read(...) rule');
  // …and a FLOOR, which the set equality cannot give: deleting a rule from settings-gen AND
  // from doctor's list keeps the two equal. This is the same guard the Bash fence uses.
  assert.ok(shipped.length >= 13, `only ${shipped.length} Read(...) rules — the generator lost some, and doctor's list followed it down`);

  // (2) LOAD-BEARING, PER RULE, measured rather than argued: deleting any ONE flips a doctor
  //     check true -> false. This is the property the 68 Bash deny rules already had.
  const drop = (rule) => ({ ...files.guardFile, permissions: { ...files.guardFile.permissions,
    deny: files.guardFile.permissions.deny.filter((d) => d !== rule) } });
  assert.equal(by(checks({}, healthy(files)), NAME).ok, true, 'the real generated guard file does not satisfy its own Read assertions');
  const survivors = shipped.filter((rule) => by(checks({}, healthy(files, { guardFile: () => drop(rule) })), NAME).ok !== false);
  assert.deepEqual(survivors, [],
    'these Read(...) rules can be deleted with every doctor check green — each needs to be in CREDENTIAL_READ_RULES');
  // …and the finding NAMES the rule, or an operator has 13 candidates and no next move.
  for (const rule of ['Read(~/.mozilla/**)', 'Read(~/Library/Application Support/**/Login Data*)']) {
    assert.match(by(checks({}, healthy(files, { guardFile: () => drop(rule) })), NAME).detail,
      new RegExp(rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `deleting ${rule} produced a finding that does not name it`);
  }
});

test('EVERY check prints what it resolved, not "ok"', async (t) => {
  // The requirement is "print the value you read", and it is not decoration: the four inert
  // breakers this build found were all invisible in a report that said `ok  <name>`, and the
  // one that mattered most — two config roots on one machine — is only diagnosable from the
  // resolved value. Pinned as a TABLE over every check rather than as hand-written matches
  // per test, because per-test matches is what left ELEVEN details unasserted: measured, by
  // replacing each check's detail in turn with a constant and finding that eleven of those
  // mutations killed no assertion at all.
  const files = await realFiles(t);
  const { checks, CHECKS } = await load('details');
  const results = checks({ CLAUDE_CODE_SESSION_ID: UUID }, healthy(files));

  // name -> a substring the HEALTHY detail must carry, taken from the probe's own answer.
  const RESOLVED = {
    'node>=24': '24',
    'tmux>=3.2': '3.6',
    'git>=2.31': '2.45.1',
    'claude auth': 'claude -p',
    'claude cd-compound read runs': '1:x',
    'gh auth': 'gh auth status',
    'workflows enabled': 'requirement 5',
    notifier: 'osascript',
    'SOMA_HOME absolute': '/abs/soma',
    'claude config root': '/h/.claude',
    '.claude.json location': '/h/.claude.json',
    'mcp enumeration readable': String(files.mcpServers.length),
    'lead settings readable': 'settings.json',
    'worktree guard file readable': 'settings.local.json',
    'every worktree guard file carries rules': '/abs/soma/worktrees/app/task-x',
    'lead mcp single-server': 'soma',
    // The FILE it read, not just the verdict — "no soma in user scope" is only worth anything
    // if the report says which config files that was concluded from.
    'no orch soma in user scope': '/h/.claude.json',
    "lead PreToolUse matcher '*'": "'*'",
    "worktree PreToolUse matcher '*'": "'*'",
    'no edit ban in settings files': 'no bare Edit/NotebookEdit/Write deny',
    // The check is inverted now: healthy means the argv carries NO --disallowedTools, so the
    // detail reports its absence (the lead's edit surface matches its teammates').
    'lead edit ban on argv': 'no --disallowedTools',
    'guard file self-protect': 'Edit(./.claude/**)',
    'no inert Write() rule': 'Edit(path)',
    'every Bash rule keeps a wildcard': 'wildcard',
    'guard file matches the generator': 'rules',
    'mcp deny drift': 'both config roots and every seat',
    'mcp deny mcp__claude_ai_*': 'mcp__claude_ai_*',
    'mcp deny mcp__plugin_*': 'mcp__plugin_*',
    'credential-store command denies': 'credential-store commands denied',
    'credential-store Read() denies': 'Read(...) rules present',
    'protected-ref single-command paths': 'single-command routes denied',
    'harness registry': '6 entries',
    'gh pr create --draft': '-d, --draft',
    'gh pr create draft negation': '--no-maintainer-edit',
    'lead PATH node vs engines.node': '/n/bin/node',
    CLAUDE_CODE_SESSION_ID: '0f1e2d3c',
    'session id matches hook payload': '0f1e2d3c',
    'budget flag path': '/abs/soma/leads/doctor-probe/BUDGET_TRIPPED',
    'state scratch files': '0 stale',
    // The floor under rotation, read off the file a running lead actually has.
    'lead auto-continue floor': 'autoContinueAtUsageLimit: true',
    'repos readable': '0 repos configured',
    // Not "ok": the count of commands read, and that every one runs an on-disk
    // lead-gate.mjs — the property whose absence produced three green inert gates.
    'lead PreToolUse command runs the gate': 'on-disk lead-gate.mjs',
    'worktree PreToolUse command runs the gate': 'on-disk lead-gate.mjs',
    // The seat pool: the resolved config_dir, the labels, the shared tree's realpath, and the
    // per-seat server count — each taken from the probe's own answer.
    'seats readable': '/h/.claude-seat-a',
    'every seat logged in': 'seat-a',
    'seat projects is the shared tree': '/h/.claude/projects',
    'mcp enumeration covers every seat': 'seat-a: 1',
    'seat pool state readable': '/abs/soma/state/seats.json',
  };
  // The table must cover every check, or a check added later gets no detail pin — the same
  // hole this test was written to close, one level up.
  assert.deepEqual(Object.keys(RESOLVED).sort(), [...CHECKS].sort(),
    'the resolved-detail table and CHECKS have drifted apart');
  for (const r of results) {
    assert.ok(r.detail.includes(RESOLVED[r.name]),
      `${r.name} does not print what it resolved (${JSON.stringify(RESOLVED[r.name])}): ${r.detail}`);
    // `length > 8` alone. The `&& !/^ok$/i.test(detail)` conjunct that used to be here was
    // implied by it — `'ok'.length === 2` — so it read as a second condition and was one that
    // could not fail.
    assert.ok(r.detail.length > 8, `${r.name}: bare detail ${JSON.stringify(r.detail)}`);
  }
});

test('the three "readable" checks carry the read, so the content checks can stay unobserved', async (t) => {
  // The split is deliberate and it is what avoids the "already determined by a line above"
  // shape: the readable check asserts THE READ, the content checks assert THE CONTENT and go
  // unobserved when there was no read. Without a dedicated test the readable checks had only
  // incidental coverage — measured: neutering each of them killed nothing but the two
  // whole-list assertions in the totality test.
  const files = await realFiles(t);
  const { checks } = await load('readable');

  // A probe that THREW is a FAIL naming the throw, and the content checks go unobserved
  // rather than green — a guard file nobody could read is not a guard file that is fine.
  const boom = () => { throw new Error('EACCES: permission denied'); };
  const broke = checks({}, healthy(files, { guardFile: boom, leadSettings: boom, repos: boom }));
  for (const name of ['worktree guard file readable', 'lead settings readable', 'repos readable']) {
    assert.equal(by(broke, name).ok, false, `${name} swallowed an unreadable file`);
    assert.match(by(broke, name).detail, /EACCES/, `${name} did not name the fault`);
  }
  for (const name of ['guard file self-protect', 'credential-store command denies', "lead PreToolUse matcher '*'",
    'mcp deny mcp__claude_ai_*', 'no edit ban in settings files']) {
    assert.equal(by(broke, name).ok, null, `${name} was judged against a file that could not be read`);
  }
  // …and `lead edit ban on argv` is NOT in that list, deliberately: its subject is the argv
  // the spawner builds, not a file, so an unreadable settings file leaves it fully observable.
  assert.equal(by(broke, 'lead edit ban on argv').ok, true,
    'the argv ban went unobserved because a file it does not read was unreadable');

  // A probe answer that is not a {live, reference} pair at all is a FAIL, not a crash.
  for (const junk of [42, 'nope']) {
    const r = checks({}, healthy(files, { guardFile: () => junk }));
    assert.equal(by(r, 'worktree guard file readable').ok, false, `${JSON.stringify(junk)} accepted as a guard file`);
  }
  // A live guard file that EXISTS and does not parse must NOT collapse into "no worktree
  // yet". That collapse is the module's own failure shape: doctor would fall back to the
  // generated reference, report it healthy, and every teammate in that worktree would be
  // running with no guardrails at all.
  for (const junk of [[], 42, 'nope', null]) {
    const r = checks({}, healthy(files, {
      guardFile: () => ({ live: junk, reference: files.guardFile, brokenPath: '/wt/x/.claude/settings.local.json' }) }));
    assert.equal(by(r, 'worktree guard file readable').ok, false,
      `a corrupt live guard file (${JSON.stringify(junk)}) read as a cold machine`);
    assert.match(by(r, 'worktree guard file readable').detail, /EXISTS but does not parse/);
    assert.match(by(r, 'worktree guard file readable').detail, /settings\.local\.json/, 'the operator needs the path');
  }
  const brokenLead = checks({}, healthy(files, {
    leadSettings: () => ({ live: null, reference: files.leadSettings, brokenPath: '/soma/leads/cr-1/settings.json' }) }));
  assert.equal(by(brokenLead, 'lead settings readable').ok, false);
  // Neither live nor reference is a FAIL — there is nothing for any rule check to judge.
  const neither = checks({}, healthy(files, { guardFile: () => ({ live: null, reference: null }) }));
  assert.equal(by(neither, 'worktree guard file readable').ok, false);
  assert.match(by(neither, 'worktree guard file readable').detail, /neither a live file nor a generated reference/);
  // …and a live file present says so, which is how an operator tells the two subjects apart.
  assert.match(by(checks({}, healthy(files)), 'worktree guard file readable').detail, /live file a teammate inherits/);

  // `repos readable` is the one that catches an unparseable soma.json, and it must still
  // enumerate the rows it did read.
  const rows = checks({}, healthy(files, { repos: () => ({ app: { ok: true, detail: 'x' } }) }));
  assert.equal(by(rows, 'repos readable').ok, true);
  assert.match(by(rows, 'repos readable').detail, /1 repos configured: app/);
});

test('an ARRAY is never a readable settings file — both copies of that guard, pinned', async (t) => {
  // The fix exists in TWO places (`pair()` and `readJson`) and NEITHER was pinned: reverting
  // either left 552/552 green. Reverting the production copy is the one that bites, and what it
  // produces is BUG 2'S SYMPTOM THROUGH BUG 1'S PATH — a live guard file holding a JSON array
  // reads as "no live file yet", doctor falls back to the generated reference, and the machine
  // is reported healthy while every teammate in that worktree runs the broken file.
  //
  // Why the covering test could not see it: its fixture ALSO set `brokenPath`, and `readable()`
  // checks `r.broken` BEFORE it checks the subject — so the bug-2 fix masked the bug-1 fix.
  // Neither fixture below sets `brokenPath`. That field is the bypass, and a pin that sets it
  // is a pin of the other guard.
  const files = await realFiles(t);
  const { checks, defaultProbes } = await load('arrayguard');

  // COPY 1 — `pair()`. An array passes a bare `typeof === 'object'` test, carries no
  // `permissions`, and was accepted as the live file: `ok` about something nothing could read.
  for (const shape of [[], [{ permissions: { deny: ['Bash(x*)'] } }]]) {
    const r = checks({}, healthy(files, { guardFile: () => ({ live: shape, reference: files.guardFile }) }));
    assert.match(by(r, 'worktree guard file readable').detail, /no live file yet/,
      `an array was accepted as the live guard file: ${JSON.stringify(shape)}`);
    // NOT `doesNotMatch(detail, /live file a teammate inherits/)`, which is where this pin
    // started: the two branches of that template are mutually exclusive, so once the line above
    // matched "no live file yet" the negative could not fail. The independent reading is the
    // `[generated reference]` marker the CONTENT checks carry — it says which subject they
    // judged, which is the thing an accepted array got wrong.
    assert.match(by(r, 'credential-store command denies').detail, /generated reference/,
      'the content checks judged an array as if it were the live file a teammate inherits');
    // …and they must judge it rather than going quietly unobserved, which is what an accepted
    // array produced for every one of them.
    assert.equal(by(r, 'credential-store command denies').ok, true, 'an accepted array left every content check unobserved');
    assert.equal(by(r, 'mcp deny mcp__claude_ai_*').ok, true);
  }
  // The lead's file shares the same helper, so it has the same hole.
  const leadArr = checks({}, healthy(files, { leadSettings: () => ({ live: [], reference: files.leadSettings }) }));
  assert.match(by(leadArr, 'lead settings readable').detail, /no live file yet/);
  assert.equal(by(leadArr, "lead PreToolUse matcher '*'").ok, true);

  // COPY 2 — `readJson`, the PRODUCTION path, against a real file on disk. This is the copy
  // whose reversion is measurable end to end.
  const fp = join(files.home, 'worktrees', 'app', 'task-arr', '.claude', 'settings.local.json');
  mkdirSync(join(files.home, 'worktrees', 'app', 'task-arr', '.claude'), { recursive: true });
  writeFileSync(fp, '[{"permissions":{"deny":["Bash(x*)"]}}]');
  const got = defaultProbes({}).guardFile();
  assert.equal(got.live, null, 'readJson handed an ARRAY on as a readable settings object');
  assert.equal(got.brokenPath, fp, 'an array-shaped guard file did not report as a file that EXISTS and does not parse');
  const end = checks({}, healthy(files, { guardFile: defaultProbes({}).guardFile }));
  assert.equal(by(end, 'worktree guard file readable').ok, false,
    'a live guard file holding a JSON array was reported healthy off the generated reference');
  assert.match(by(end, 'worktree guard file readable').detail, /EXISTS but does not parse/);
  assert.match(by(end, 'worktree guard file readable').detail, /task-arr/, 'the operator needs the path');
});

test('a worktree whose guard file was DELETED or EMPTIED is a FAIL, not a cold machine', async (t) => {
  // Two hazards meeting, neither of them visible anywhere else. `.claude/` is gitignored BY
  // DESIGN (`.claude/.gitignore` holds `*`), so `git clean -fdx` removes it and neither
  // `git status` nor the PR shows anything — a general hazard on this build, not this module's.
  // And an EMPTIED guard file FAILS OPEN: measured, a probe MCP server loaded and fired in a cwd
  // whose guard file was zero bytes. The newest-file check above cannot see either, because a
  // file that is not there is simply not a candidate — which reads exactly like a cold machine.
  const files = await realFiles(t);
  const { checks, defaultProbes } = await load('wtguards');
  const NAME = 'every worktree guard file carries rules';
  const armed = { worktree: '/w/app/task-a', path: '/w/app/task-a/.claude/settings.local.json', bytes: 4096, rules: 97 };
  assert.equal(by(checks({}, healthy(files)), NAME).ok, true);

  // Gone entirely.
  const gone = checks({}, healthy(files, { worktreeGuards: () => [armed,
    { worktree: '/w/app/task-b', path: '/w/app/task-b/.claude/settings.local.json', bytes: null, rules: 0 }] }));
  assert.equal(by(gone, NAME).ok, false, 'a worktree with no guard file at all read as healthy');
  assert.match(by(gone, NAME).detail, /task-b/, 'the operator needs to know WHICH worktree');
  assert.match(by(gone, NAME).detail, /git clean/, 'the finding must name the cause, or it looks like a mystery');

  // Present and disarmed — and the reading is DENY RULES, not bytes, because `{}` fails open
  // exactly as hard as a zero-byte file and is 2 bytes rather than 0.
  for (const w of [{ bytes: 0, rules: 0 }, { bytes: 2, rules: 0 }, { bytes: 41, rules: 0 }]) {
    const r = checks({}, healthy(files, { worktreeGuards: () => [{ worktree: '/w/app/task-c', path: '/w/app/task-c/.claude/settings.local.json', ...w }] }));
    assert.equal(by(r, NAME).ok, false, `a guard file of ${w.bytes} bytes with 0 deny rules read as healthy`);
    assert.match(by(r, NAME).detail, /fails OPEN/);
  }
  // NO worktrees is UNOBSERVED, never a pass: `[].every()` is `true`, and a vacuous truth
  // reported as health is the trap `bashRuleMatches` already guards against.
  assert.equal(by(checks({}, healthy(files, { worktreeGuards: () => [] })), NAME).ok, null);
  assert.equal(by(checks({}, healthy(files, { worktreeGuards: () => null })), NAME).ok, null);
  assert.equal(by(checks({}, healthy(files, { worktreeGuards: () => 42 })), NAME).ok, false);

  // FOR REAL: one armed worktree, and one whose `.claude/` a `git clean -fdx` removed.
  const s = await import(`../bin/lib/settings-gen.mjs?wtg-${Date.now()}`);
  const live = join(files.home, 'worktrees', 'app', 'task-armed');
  mkdirSync(live, { recursive: true });
  s.writeWorktreeGuardrails(live, { teammateAllow: [] });
  mkdirSync(join(files.home, 'worktrees', 'app', 'task-cleaned'), { recursive: true });
  const real = defaultProbes({}).worktreeGuards();
  assert.deepEqual(real.filter((w) => w.bytes === null).map((w) => w.worktree), [join(files.home, 'worktrees', 'app', 'task-cleaned')]);
  assert.ok(real.find((w) => w.worktree === live).rules > 60, 'the armed worktree did not report its rules');
  const r2 = checks({}, healthy(files, { worktreeGuards: defaultProbes({}).worktreeGuards }));
  assert.equal(by(r2, NAME).ok, false);
  assert.match(by(r2, NAME).detail, /task-cleaned/);
  // …and this is why it is a check of its own: the newest-file reading is perfectly happy.
  assert.equal(by(r2, 'worktree guard file readable').ok, true, 'the newest-file probe was expected to be blind to this');
});

test('an unreadable config, or a state root the sweep could not open, is UNOBSERVED', async (t) => {
  // The `?? ''` mechanism in two more spellings, both reporting health over a file they could
  // not open. `userScopeSomaServers` swallowed every read error to `null`, `continue`d, and
  // answered `[]` — so an unparseable `~/.claude.json` printed `ok  no soma bus in user scope`:
  // the RECURSION GUARD treating an absence as evidence. And `walk` swallowed `readdirSync`
  // failures and answered `[]`, which the check read as `0 stale` and passed.
  const files = await realFiles(t);
  const { checks, defaultProbes } = await load('unreadable');

  const blind = checks({}, healthy(files, { userScopeSomaServers: () => ({ servers: [], read: [], unreadable: ['/h/.claude.json'] }) }));
  assert.equal(by(blind, 'no orch soma in user scope').ok, null, 'an unreadable ~/.claude.json read as "no soma in user scope"');
  assert.match(by(blind, 'no orch soma in user scope').detail, /\/h\/\.claude\.json/, 'the operator needs the file');
  assert.match(by(blind, 'no orch soma in user scope').detail, /not observed here|assumed/);
  // A server FOUND is still a FAIL even when another candidate was unreadable: a finding beats
  // an incomplete read.
  assert.equal(by(checks({}, healthy(files, {
    userScopeSomaServers: () => ({ servers: ['soma'], read: ['/a'], unreadable: ['/b'] }) })), 'no orch soma in user scope').ok, false);
  // A bare ARRAY is refused rather than read as "…and nothing was unreadable", because a silent
  // "nothing was unreadable" is the defect itself.
  for (const junk of [[], ['soma'], null, 42, { servers: 'nope' }]) {
    assert.equal(by(checks({}, healthy(files, { userScopeSomaServers: () => junk })), 'no orch soma in user scope').ok, false,
      `${JSON.stringify(junk)} was accepted as a complete enumeration`);
  }
  // FOR REAL: a `.claude.json` that EXISTS and will not parse must not read as absent. `readJson`
  // folds ENOENT and a SyntaxError into one `null` on purpose, so `existsSync` is the separator.
  const cfg = join(process.env.HOME, '.claude.json');
  writeFileSync(cfg, '{ "mcpServers": { "soma": {} ');            // truncated, unparseable
  const got = defaultProbes({}).userScopeSomaServers();
  assert.deepEqual(got.servers, []);
  assert.deepEqual(got.unreadable, [cfg], 'an unparseable config was reported as read');
  assert.equal(by(checks({}, healthy(files, { userScopeSomaServers: defaultProbes({}).userScopeSomaServers })),
    'no orch soma in user scope').ok, null);

  // The scratch sweep, same shape.
  const partial = checks({}, healthy(files, { scratchFiles: () => ({ files: [], unreadable: ['/abs/soma/state (EACCES)'] }) }));
  assert.equal(by(partial, 'state scratch files').ok, null, 'a sweep that could not read the state root reported it clean');
  assert.match(by(partial, 'state scratch files').detail, /EACCES/);
  // …but a stale file FOUND is a finding whether or not the sweep finished.
  const some = checks({}, healthy(files, { scratchFiles: () => ({
    files: [{ path: '/s/fleet.json.99999.tmp', pid: 99999, live: false }], unreadable: ['/x (EACCES)'] }) }));
  assert.equal(by(some, 'state scratch files').ok, false);
  assert.match(by(some, 'state scratch files').detail, /99999/);

  // FOR REAL, and without a chmod: pointing SOMA_HOME at a FILE makes `readdirSync` fail with
  // ENOTDIR, which is the class the probe must report. ENOENT is deliberately NOT reported — a
  // directory that is gone holds no scratch files, and counting a lost race as unreadable would
  // flap this check to UNOBSERVED on a busy fleet for no finding at all.
  mkdirSync(join(files.home, 'state'), { recursive: true });
  const notADir = join(files.home, 'state', 'not-a-directory');
  writeFileSync(notADir, 'x');
  const saved = process.env.SOMA_HOME;
  let sweep;
  try {
    process.env.SOMA_HOME = notADir;
    sweep = defaultProbes({}).scratchFiles();
  } finally {
    process.env.SOMA_HOME = saved;
  }
  assert.deepEqual(sweep.files, []);
  assert.equal(sweep.unreadable.length, 1, 'a state root that would not enumerate was reported as swept');
  assert.match(sweep.unreadable[0], /ENOTDIR/, 'the code is what tells an operator ENOENT from EACCES');
  assert.equal(by(checks({}, healthy(files, { scratchFiles: () => sweep })), 'state scratch files').ok, null);
  // …and the ENOENT exclusion: a root that simply does not exist yields no finding either way.
  const gonePath = join(files.home, 'state', 'no-such-dir');
  try {
    process.env.SOMA_HOME = gonePath;
    assert.deepEqual(defaultProbes({}).scratchFiles(), { files: [], unreadable: [] },
      'an absent state root was reported as unreadable, which would flap this check on every fleet');
  } finally {
    process.env.SOMA_HOME = saved;
  }

  for (const junk of [[], null, 42, { files: 'nope' }]) {
    assert.equal(by(checks({}, healthy(files, { scratchFiles: () => junk })), 'state scratch files').ok, false,
      `${JSON.stringify(junk)} was accepted as a scratch sweep`);
  }
});

test('checks never throws for a probe that THROWS, and a missing probe is unobserved', async (t) => {
  // Doctor is the thing an operator runs when something is already wrong. A probe that
  // throws — `enumerateUserMcpServers` on an unreadable `.claude.json`, a `git fetch` that
  // times out, a tmux that is not installed — must become a FAILING LINE, never a stack
  // trace that loses the other thirty readings.
  //
  // THE CLAIM IS THAT, AND THE TITLE USED TO SAY MORE. "never throws, for any env and any
  // probe" is false as stated: 13 of 21 hostile inputs escape — a probe object whose property
  // ACCESS throws (`observe`'s `probe[key]` read sits outside its own `try`), a revoked Proxy,
  // and a throwing `Symbol.toPrimitive` or `ownKeys` reaching the `String()` coercions or
  // `Object.keys(env)`. None is reachable from `defaultProbes()` or `process.env`, so the
  // general case is deliberately not chased — but a title claiming totality is how a real gap
  // stays unfixed, so the title now says what the assertions below actually cover.
  const files = await realFiles(t);
  const { checks, CHECKS } = await load('total');

  const boom = () => { throw new Error('probe exploded'); };
  const allThrow = Object.fromEntries(Object.keys(healthy(files)).map((k) => [k, boom]));
  const thrown = checks({}, allThrow);
  assert.deepEqual(thrown.map((r) => r.name), [...CHECKS]);
  assert.ok(thrown.every((r) => r.ok !== true), 'a thrown probe produced a passing check');
  assert.ok(thrown.some((r) => r.detail.includes('probe exploded')), 'the throw was not reported');

  // A throw that is not an Error at all, and one whose `message` getter throws.
  for (const evil of [() => { throw null; }, () => { throw { get message() { throw new Error('x'); } }; }]) {
    const r = checks({}, Object.fromEntries(Object.keys(healthy(files)).map((k) => [k, evil])));
    assert.equal(r.length, CHECKS.length);
  }
  // No probe object at all.
  for (const nothing of [undefined, null, {}, 42, 'nope', []]) {
    const r = checks({}, nothing);
    assert.deepEqual(r.map((x) => x.name), [...CHECKS]);
    assert.ok(r.every((x) => x.ok === null), 'a missing probe was judged rather than reported unobserved');
  }
  // …and no `env` either.
  for (const nothing of [undefined, null, 42, 'nope']) assert.equal(checks(nothing, healthy(files)).length, CHECKS.length);

  // Strict `=== true`, never truthiness: the live probes shell out, and a shell answers in
  // strings. `"false"` is truthy, and so are `"0"`, `[]` and `{}`.
  for (const truthy of ['false', '0', 'true', [], {}, 1]) {
    assert.equal(by(checks({}, healthy(files, { ghAuth: () => truthy })), 'gh auth').ok, false,
      `${JSON.stringify(truthy)} was accepted as an observation of true`);
  }
});

test('defaultProbes answers the cheap questions for real, without spawning anything', async (t) => {
  // The probe wiring is where a doctor silently stops observing, and the sketch's version
  // hard-coded five `() => true`. These are the probes that can be exercised for real in a
  // unit test — no `claude -p`, no network, no tmux.
  const home = somaHome(t);
  const { defaultProbes } = await load('probes');
  const p = defaultProbes({});

  assert.equal(p.harnessCount(), 6, 'the shipped registry no longer holds six harnesses');
  assert.match(p.enginesNode(), /^>=\d+/);
  assert.equal(p.somaHome(), home);
  assert.equal(p.tripPath('cr-1'), join(home, 'leads', 'cr-1', 'BUDGET_TRIPPED'));
  assert.deepEqual(p.scratchFiles(), { files: [], unreadable: [] });
  assert.equal(p.leadMcpServers(), null, 'no lead exists yet, so there is nothing to read');
  assert.ok(Array.isArray(p.teammateAllow()));
  // No `worktrees/` root yet, so there is genuinely nothing to enumerate — and `[]` would pass
  // the check vacuously, so the probe says `null` instead.
  assert.equal(p.worktreeGuards(), null);

  // The cold-machine path, for real: no lead and no worktree exist, yet BOTH settings files
  // come back with a generated reference, so every rule check below has a subject.
  const cold = p.guardFile();
  assert.equal(cold.live, null, 'there is no worktree yet');
  assert.ok(cold.reference.permissions.deny.includes('mcp__claude_ai_*'), 'the reference was not generated');
  assert.ok(cold.reference.permissions.deny.includes('Read(~/.ssh/**)'));
  assert.equal(p.leadSettings().live, null);
  assert.equal(p.leadSettings().reference.hooks.PreToolUse[0].matcher, '*');
  // …and generating it left NOTHING in the real state root. A stray `leads/doctor-reference/`
  // would be read by `newestLead()` in preference to a real lead, and the watchdog's
  // reconcile pass would see a lead directory with no fleet row.
  assert.equal(process.env.SOMA_HOME, home, 'SOMA_HOME was not restored after the reference write');
  const under = (dir) => { try { return readdirSync(join(home, dir)); } catch { return []; } };
  assert.deepEqual(under('leads'), [], 'the reference lead was published into the real state root');
  assert.deepEqual(under('worktrees'), [], 'the reference worktree was published into the real state root');
  assert.deepEqual(under(''), [], 'the reference write left something in the real state root');

  // The `.claude.json` asymmetry, resolved for real, both ways — and this is the reading
  // the whole config-root section is about.
  const h = process.env.HOME;
  const dflt = defaultProbes({}).claudeConfig();
  assert.equal(dflt.override, false);
  assert.equal(dflt.root, join(h, '.claude'));
  assert.equal(dflt.file, join(h, '.claude.json'), '.claude.json sits BESIDE the default root');
  const over = defaultProbes({ CLAUDE_CONFIG_DIR: '/tmp/cfgroot' }).claudeConfig();
  assert.equal(over.override, true);
  assert.equal(over.root, '/tmp/cfgroot');
  assert.equal(over.file, join('/tmp/cfgroot', '.claude.json'), '…and INSIDE an overridden one');

  // A scratch file whose pid is this process is LIVE by construction; one with a pid
  // nothing can own is not.
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'state', `fleet.json.${process.pid}.tmp`), '{}');
  writeFileSync(join(home, 'state', 'fleet.json.4294967295.tmp'), '{}');
  writeFileSync(join(home, 'state', 'not-a-scratch.json'), '{}');
  const swept = defaultProbes({}).scratchFiles();
  assert.deepEqual(swept.unreadable, [], 'a readable state root reported directories it could not read');
  const found = swept.files.sort((a, b) => a.pid - b.pid);
  assert.deepEqual(found.map((f) => [f.pid, f.live]), [[process.pid, true], [4294967295, false]]);

  // The real generated files are readable once a lead and a worktree exist, which is the
  // production path for every rule-shaped check above.
  const { leadDir, ensureTree } = await import(`../bin/lib/paths.mjs?probes-${Date.now()}`);
  ensureTree(); mkdirSync(leadDir('cr-1'), { recursive: true });
  const s = await import(`../bin/lib/settings-gen.mjs?probes-${Date.now()}`);
  s.writeLeadMcpConfig('cr-1');
  s.writeLeadSettings('cr-1');
  // Sorted, because this asserts the SET a lead may reach, not the key order the generator
  // happens to emit. `sequential-thinking` joined `soma` on 2026-09-01; see
  // `writeLeadMcpConfig` for why it clears the recursion guard.
  assert.deepEqual(defaultProbes({}).leadMcpServers().slice().sort(), ['sequential-thinking', 'soma']);
  assert.equal(defaultProbes({}).leadSettings().live.hooks.PreToolUse[0].matcher, '*',
    'the LIVE lead settings must be preferred once one exists');
});

test('semverGte compares components, not strings', async () => {
  const { semverGte } = await load('semver');
  assert.equal(semverGte('3.10', '3.9'), true, '10 > 9 componentwise; "3.10" < "3.9" as strings');
  assert.equal(semverGte('2.45.1', '2.31'), true);
  assert.equal(semverGte('2.31.0', '2.31'), true);
  assert.equal(semverGte('2.30.9', '2.31'), false);
  assert.equal(semverGte('3.2', '3.2'), true);
  // A version this cannot parse must read as TOO OLD, not as new enough: the answer feeds
  // a gate, and an unparseable reading is not evidence the floor is met.
  for (const junk of ['', 'unknown', null, undefined, 'v', {}]) {
    assert.equal(semverGte(junk, '3.2'), false, `${JSON.stringify(junk)} passed the floor`);
  }
  // tmux ships letters: `tmux 3.6a`. The numeric prefix is what compares.
  assert.equal(semverGte('3.6a', '3.2'), true);
  assert.equal(semverGte('3.1a', '3.2'), false);
});

/* ----------------- a build that asks under bypass, caught before a lead is spawned on it */

/**
 * Claude Code 2.1.259 raised a bypass-immune permission prompt on `cd <dir> && grep <relative>`
 * whenever a `Read()` deny rule existed; leads carry several and nobody sits at their pane, so
 * unattended leads sat on that prompt for days. `tested_claude` admitted the build — it passes
 * patch releases by design — because a version number cannot say "this build prompts". A
 * measurement can: one haiku call, the exact shape, a throwaway cwd and settings file. What
 * the tests below hold is the READING of that measurement, over the transcripts the two real
 * binaries produced, in all three states — because a check that cannot tell "it asked" from
 * "the model never ran the command" is a check that passes on a machine where claude is broken.
 */
test('the cd-compound check reads RAN, ASKED and NOT OBSERVED as three different verdicts', async (t) => {
  const files = await realFiles(t);
  const { checks, CHECKS, classifyCdCompoundProbe } = await load('cdcompound');
  const NAME = 'claude cd-compound read runs';
  const run = (events) => by(checks({}, healthy(files, { cdCompoundRead: () => events })), NAME);

  // Beside `claude auth`: the other `claude -p` reading, and the one the runbook lists with it.
  assert.equal(CHECKS[CHECKS.indexOf('claude auth') + 1], NAME, 'the cd-compound check must sit beside claude auth');

  // RAN — the 2.1.263 shape, verbatim.
  const ran = run(RAN_EVENTS);
  assert.equal(ran.ok, true);
  assert.match(ran.detail, /1:x/, 'the detail must quote what the tool returned');
  // The command that actually ran, quoted from the transcript. The check's static label also
  // reads "`cd <other dir> && grep -n x y.txt`", so a /cd .*&& grep/ here was satisfied with the
  // executed command missing from the detail entirely (measured: a mutation that removed it
  // survived). The fixture's directory cannot come from the label.
  assert.ok(ran.detail.includes(CD_CMD), `the detail must quote the command that ran, ${CD_CMD}, not the check's static label`);

  // ASKED — the 2.1.259 shape, verbatim: FAIL, and the detail says what the operator does next.
  const asked = run(ASKED_EVENTS);
  assert.equal(asked.ok, false, 'a build that asks under bypass must FAIL doctor');
  assert.match(asked.detail, /permission prompt/i, 'the detail must say what happened');
  assert.match(asked.detail, /CD_COMPOUND_ASKS/, 'the detail must name the emergency lever');
  assert.match(asked.detail, /require approval/, 'and quote the prompt text the build produced');
  // Either signal alone is an ASK: the event without the text, and the text without the event.
  assert.equal(run([CD_INIT, cdUse(CD_CMD), cdDenied(), cdResult('', true), CD_END]).ok, false,
    'a permission_denied event for the call is an ASK on its own');
  assert.equal(run([CD_INIT, cdUse(CD_CMD), cdResult(ASK_TEXT, true), CD_END]).ok, false,
    'the approval text in an is_error result is an ASK on its own');
  for (const wording of ['Claude requested permissions to use Bash, but you haven\'t granted it yet.', 'only you can approve running it anyway']) {
    assert.equal(run([CD_INIT, cdUse(CD_CMD), cdResult(wording, true), CD_END]).ok, false, `not read as an ask: ${wording}`);
  }

  // NOT OBSERVED — `null`, never a pass, and the detail says which way the observation failed.
  const unobserved = [
    ['claude could not be run', null, /could not be run|not observable/i],
    ['nothing parseable came back', [], /no stream-json/i],
    ['no Bash tool_use', [CD_INIT, { type: 'assistant', message: { content: [{ type: 'text', text: 'I cannot do that.' }] } }, CD_END], /no Bash tool_use/i],
    // The measured trap: both haiku and sonnet silently drop a cd whose target is the cwd.
    ['the model dropped the cd', [CD_INIT, cdUse('grep -n x y.txt'), cdResult('1:x'), CD_END], /dropped the cd|lost its cd/i],
    ['a cd followed by a verb outside the set', [CD_INIT, cdUse('cd /tmp/x && cat y.txt'), cdResult('x'), CD_END], /dropped the cd|lost its cd|shape/i],
    ['no tool_result for the call', [CD_INIT, cdUse(CD_CMD), CD_END], /no tool_result/i],
    ['an unrelated error', [CD_INIT, cdUse(CD_CMD), cdResult('grep: y.txt: No such file or directory', true), CD_END], /neither/i],
    ['a clean result that is not 1:x', [CD_INIT, cdUse(CD_CMD), cdResult('', false), CD_END], /neither/i],
  ];
  for (const [label, events, why] of unobserved) {
    const r = run(events);
    assert.equal(r.ok, null, `${label}: an unobserved probe must not be read as a verdict (got ${r.ok})`);
    assert.match(r.detail, why, `${label}: the detail does not say why it was not observed`);
  }
  // A probe answering the wrong SHAPE is a FAIL naming the shape, like every other check here.
  const shapeless = run('ran fine');
  assert.equal(shapeless.ok, false);
  assert.match(shapeless.detail, /not an array/i);
  // …and no probe at all is UNOBSERVED (the `check` helper's contract), never a pass.
  assert.equal(by(checks({}, healthy(files, { cdCompoundRead: undefined })), NAME).ok, null);

  // The classifier's own contract, at the value level: the same three states, nothing else.
  assert.equal(classifyCdCompoundProbe(RAN_EVENTS).ran, true);
  assert.equal(classifyCdCompoundProbe(ASKED_EVENTS).ran, false);
  assert.equal(classifyCdCompoundProbe([]).ran, null);
  assert.equal(classifyCdCompoundProbe('not events').ran, null);
  assert.equal(classifyCdCompoundProbe(undefined).ran, null);

  // A tool_result whose content arrives as text BLOCKS — the other shape the SDK emits.
  assert.equal(run([CD_INIT, cdUse(CD_CMD), cdResult([{ type: 'text', text: '1:x' }]), CD_END]).ok, true,
    'array-shaped tool_result content must be read too');
  // The newline-joined compound (most of the freezes) is the same shape.
  assert.equal(run([CD_INIT, cdUse('cd /tmp/soma-doctor-cd-x/other\ngrep -n x y.txt'), cdResult('1:x'), CD_END]).ok, true);

  // Only the FIRST cd-shaped call is judged: a model that was denied and retried without the
  // cd must not launder an ASK into a pass through its second, cd-less call.
  const retried = [CD_INIT, cdUse(CD_CMD, 'a'), cdDenied('a'), cdResult(ASK_TEXT, true, 'a'),
    cdUse('grep -n x /tmp/soma-doctor-cd-x/other/y.txt', 'b'), cdResult('1:x', false, 'b'), CD_END];
  assert.equal(run(retried).ok, false, 'a successful retry without the cd must not launder the ask');
  // …and a permission_denied event for a DIFFERENT call does not condemn this one.
  assert.equal(run([CD_INIT, cdUse(CD_CMD, 'a'), cdDenied('zzz'), cdResult('1:x', false, 'a'), CD_END]).ok, true,
    'a denied event for another tool_use_id was read as this call\'s');
});

/* --------------------------------------- the floor under rotation, read off the file a lead HAS */

test('lead auto-continue floor: true in the live file is ok, a missing key is a FAIL naming the cycle, an unread file is UNOBSERVED', async (t) => {
  const files = await realFiles(t);
  const { checks } = await load('autocontinue');
  const NAME = 'lead auto-continue floor';

  // AGAINST THE REAL GENERATOR: `healthy()` hands over the file `writeLeadSettings` just wrote,
  // so deleting the key from settings-gen.mjs reddens this line too, not only its own suite.
  const ok = by(checks({}, healthy(files)), NAME);
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /autoContinueAtUsageLimit: true/);

  // THE MEASURED LIVE-FLEET SHAPE: a lead spawned before the key landed. A running fleet stays
  // in exactly this state until its leads relaunch — processes whose settings.json predates
  // the key — and `lead settings readable` says ok about the very same file, which is the blind
  // spot the RUNBOOK names (§5.2, "A generator change reaches a running lead only at its next
  // launch") and that nothing detected before this check.
  const { autoContinueAtUsageLimit: _drop, ...stale } = files.leadSettings;
  const old = checks({}, healthy(files, { leadSettings: () => stale }));
  assert.equal(by(old, NAME).ok, false, 'a running lead with no auto-continue floor was reported healthy');
  assert.match(by(old, NAME).detail, /soma kill/, 'the remedy is to cycle the lead, and the detail must say so');
  assert.equal(by(old, 'lead settings readable').ok, true, 'the readable check still passes — that is the blind spot this check closes');

  // Explicitly off is a FAIL, not unobserved: somebody turned the floor off.
  assert.equal(by(checks({}, healthy(files, { leadSettings: () => ({ ...files.leadSettings, autoContinueAtUsageLimit: false }) })), NAME).ok, false);
  // Strict `=== true`: a hand-edited file answers in strings, and truthiness is never the test here.
  for (const truthy of ['true', 1, {}, []]) {
    assert.notEqual(by(checks({}, healthy(files, { leadSettings: () => ({ ...files.leadSettings, autoContinueAtUsageLimit: truthy }) })), NAME).ok, true,
      `${JSON.stringify(truthy)} was accepted as the floor being armed`);
  }

  // Neither a live file nor a reference: nothing was read, so unobserved — never a pass.
  const nothing = by(checks({}, healthy(files, { leadSettings: () => ({ live: null, reference: null }) })), NAME);
  assert.equal(nothing.ok, null);
  assert.match(nothing.detail, /lead settings readable/, 'the check that carries the read must be named');
  // A probe that threw is the same third state here, and a FAIL on `lead settings readable`.
  const threw = checks({}, healthy(files, { leadSettings: () => { throw new Error('EACCES on leads/cr-1/settings.json'); } }));
  assert.equal(by(threw, NAME).ok, null, 'a settings.json that could not be read was judged');
  assert.equal(by(threw, 'lead settings readable').ok, false);
  // A live file that EXISTS but does not parse must NOT fall back to the generated reference and
  // read as armed — the rule `lead settings readable` already makes of `brokenPath`.
  assert.equal(by(checks({}, healthy(files, { leadSettings: () => ({ live: null, reference: files.leadSettings, brokenPath: '/abs/soma/leads/cr-1/settings.json' }) })), NAME).ok, null,
    'a corrupt live settings.json was judged through the generated reference');

  // With no live file at all, the generated reference IS what the next lead gets: a live reading,
  // marked as such so nobody reads it as a statement about a lead that is running now.
  const cold = by(checks({}, healthy(files, { leadSettings: () => ({ live: null, reference: files.leadSettings }) })), NAME);
  assert.equal(cold.ok, true);
  assert.match(cold.detail, /generated reference/);
});

/* ------------------------------------------------------------------ the seat pool (account rotation) */

test('seats readable: a directory per seat is ok, a missing one is a FAIL, a stat that failed is UNOBSERVED', async (t) => {
  const files = await realFiles(t);
  const { checks } = await load('seats-readable');
  const two = (over) => [{ label: 'seat-a', config_dir: '/h/.claude-seat-a', exists: true }, { label: 'seat-b', config_dir: '/h/.claude-seat-b', ...over }];

  const ok = by(checks({}, healthy(files)), 'seats readable');
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /2 seats configured/);
  assert.match(ok.detail, /seat-a \(\/h\/\.claude-seat-a\)/, 'the resolved config_dir is what an operator checks against soma.json');

  const gone = by(checks({}, healthy(files, { seats: () => two({ exists: false }) })), 'seats readable');
  assert.equal(gone.ok, false);
  assert.match(gone.detail, /seat-b \(\/h\/\.claude-seat-b\)/);
  assert.match(gone.detail, /not a directory/);

  const unknown = by(checks({}, healthy(files, { seats: () => two({ exists: null }) })), 'seats readable');
  assert.equal(unknown.ok, null, 'a stat that failed was read as a verdict');
  assert.match(unknown.detail, /seat-b/);
  assert.match(unknown.detail, /not observed/);

  // A finding beats an incomplete read: one missing and one unknown is a FAIL that names both.
  const both = by(checks({}, healthy(files, { seats: () => [
    { label: 'seat-a', config_dir: '/h/a', exists: false }, { label: 'seat-b', config_dir: '/h/b', exists: null }] })), 'seats readable');
  assert.equal(both.ok, false);
  assert.match(both.detail, /seat-a/);
  assert.match(both.detail, /seat-b/);

  // The config that would not load is the read itself failing — a FAIL naming the throw.
  const threw = by(checks({}, healthy(files, { seats: () => { throw new TypeError('seats: config_dir must be a non-empty string, absolute or ~-prefixed, got "" — a seat needs a config dir'); } })), 'seats readable');
  assert.equal(threw.ok, false);
  assert.match(threw.detail, /config_dir must be a non-empty string/);

  // A probe answer that is not a list is a FAIL, not a crash and not a pass.
  for (const junk of [null, 42, 'nope', { seats: [] }]) {
    assert.equal(by(checks({}, healthy(files, { seats: () => junk })), 'seats readable').ok, false, `${JSON.stringify(junk)} accepted as a seat list`);
  }
});

test('zero seats is a live reading on all four checks — ok with the count — never INCOMPLETE on a machine without a pool', async (t) => {
  const files = await realFiles(t);
  const { checks, formatDoctor } = await load('seats-zero');
  const seen = [];
  const none = checks({ CLAUDE_CODE_SESSION_ID: UUID }, healthy(files, {
    seats: () => [],
    seatsLoggedIn: (s) => { seen.push('seatsLoggedIn'); return s; },
    seatProjects: (s) => { seen.push('seatProjects'); return { fleet: { path: '/x' }, seats: s }; },
    seatMcpCoverage: (s) => { seen.push('seatMcpCoverage'); return { union: [], seats: s }; },
  }));
  for (const name of ['seats readable', 'every seat logged in', 'seat projects is the shared tree', 'mcp enumeration covers every seat']) {
    assert.equal(by(none, name).ok, true, `${name} is not a pass with no seats configured`);
    assert.match(by(none, name).detail, /0 seats configured/, `${name} must say how many seats it read`);
  }
  // The three dependent probes are not called for an empty pool: there is nothing to log in,
  // compare or enumerate, and `seatProjects` would otherwise resolve the fleet's projects/ on
  // every machine that has no pool at all.
  assert.deepEqual(seen, []);
  assert.match(formatDoctor(none), /doctor: PASS/);
});

test('seats readable carries the read: when the seat list threw, the three dependent checks are UNOBSERVED and their probes never run', async (t) => {
  const files = await realFiles(t);
  const { checks } = await load('seats-carry');
  const called = [];
  const spy = (key, value) => (seats) => { called.push(key); return value(seats); };
  const spies = {
    seatsLoggedIn: spy('seatsLoggedIn', (s) => s),
    seatProjects: spy('seatProjects', (s) => ({ fleet: { path: '/x' }, seats: s })),
    seatMcpCoverage: spy('seatMcpCoverage', (s) => ({ union: [], seats: s })),
  };
  const broke = checks({}, healthy(files, { ...spies, seats: () => { throw new Error('EACCES: permission denied, open soma.json'); } }));
  assert.equal(by(broke, 'seats readable').ok, false);
  assert.match(by(broke, 'seats readable').detail, /EACCES/);
  for (const name of ['every seat logged in', 'seat projects is the shared tree', 'mcp enumeration covers every seat']) {
    assert.equal(by(broke, name).ok, null, `${name} was judged against a seat list that could not be read`);
    assert.match(by(broke, name).detail, /seats readable/, `${name} must point at the check that carries the read`);
  }
  assert.deepEqual(called, [], 'a dependent probe ran without a seat list');
  // No probe at all is the same third state for all four.
  const absent = checks({}, healthy(files, { ...spies, seats: undefined }));
  for (const name of ['seats readable', 'every seat logged in', 'seat projects is the shared tree', 'mcp enumeration covers every seat']) {
    assert.equal(by(absent, name).ok, null, `${name} judged with no seats probe`);
  }
  assert.deepEqual(called, []);
  // …but a seat list that WAS read, with one seat whose directory is missing, still runs the
  // other three: each takes its own third state on that seat, which is a better report than
  // three blanket unobserved lines.
  const missing = checks({}, healthy(files, { ...spies, seats: () => [{ label: 'seat-a', config_dir: '/h/.claude-seat-a', exists: false }] }));
  assert.equal(by(missing, 'seats readable').ok, false);
  assert.deepEqual(called.sort(), ['seatMcpCoverage', 'seatProjects', 'seatsLoggedIn'], 'the dependent probes did not run on a read seat list');

  // …and the third state of the DEPENDENT probe, which is a different arm from every case
  // above: a seat list that WAS read, with that one probe missing. Both cases above short
  // circuit at `seatList === null` two lines earlier and never reach it, so nothing ran this
  // arm and both wrong verdicts survived mutation. Unreachable from
  // `defaultProbes()` today — all five keys are defined — so this is a regression pin.
  const one = () => [{ label: 'seat-a', config_dir: '/h/.claude-seat-a', exists: true }];
  for (const [name, key] of [['every seat logged in', 'seatsLoggedIn'],
    ['seat projects is the shared tree', 'seatProjects'], ['mcp enumeration covers every seat', 'seatMcpCoverage']]) {
    const gone = by(checks({}, healthy(files, { seats: one, [key]: undefined })), name);
    assert.equal(gone.ok, null, `${name} answered a verdict with a live seat list and no ${key} probe`);
    assert.match(gone.detail, new RegExp(`not observed \\(no ${key} probe\\)`), `${name} must name the probe it could not call`);
  }
});

test('every seat logged in: true per seat is ok, one false is a FAIL naming the login command, one null is UNOBSERVED', async (t) => {
  const files = await realFiles(t);
  const { checks } = await load('seats-login');
  const login = (a, b) => (seats) => seats.map((s, i) => ({ label: s.label, config_dir: s.config_dir, loggedIn: i === 0 ? a : b }));

  const ok = by(checks({}, healthy(files)), 'every seat logged in');
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /2 seats carry an oauthAccount/);
  assert.match(ok.detail, /seat-a, seat-b/);

  const out = by(checks({}, healthy(files, { seatsLoggedIn: login(true, false) })), 'every seat logged in');
  assert.equal(out.ok, false);
  assert.match(out.detail, /seat-b \(\/h\/\.claude-seat-b\)/);
  assert.match(out.detail, /CLAUDE_CONFIG_DIR=<config_dir> claude auth login/, 'the fix is a per-seat interactive login, and the detail must say so');
  assert.doesNotMatch(out.detail, /seat-a \(/, 'the seat that IS logged in was named as a finding');

  const unread = by(checks({}, healthy(files, { seatsLoggedIn: login(true, null) })), 'every seat logged in');
  assert.equal(unread.ok, null, 'an unreadable .claude.json was read as a login verdict');
  assert.match(unread.detail, /seat-b/);
  assert.match(unread.detail, /not observed/);

  // A seat with NO .claude.json at all has NEVER been logged in — a soma.json.seats entry added
  // without `soma init --seat`, the likeliest provisioning mistake there is. `seats.loggedIn`
  // folds that into the same null as a file that would not open (the shape the
  // watchdog needs), so the probe splits it back apart with `configFile` and only the ABSENT
  // half is a finding. Before: unobserved, and `soma doctor` exits 0 about it.
  const file = (a, b) => (seats) => seats.map((s, i) => ({ label: s.label, config_dir: s.config_dir, ...(i === 0 ? a : b) }));
  const never = by(checks({}, healthy(files, { seatsLoggedIn: file({ loggedIn: true, configFile: true }, { loggedIn: null, configFile: false }) })), 'every seat logged in');
  assert.equal(never.ok, false, 'a seat with no .claude.json at all read as unobserved — that seat has never been logged in and a rotation onto it exits 1');
  assert.match(never.detail, /seat-b \(\/h\/\.claude-seat-b\)/);
  assert.match(never.detail, /never been logged in/, 'the detail must say which of the two nulls this is, because the remedies read differently');
  assert.match(never.detail, /CLAUDE_CONFIG_DIR=<config_dir> claude auth login/);
  assert.doesNotMatch(never.detail, /seat-a \(/, 'the logged-in seat was named as a finding');
  // …and the other half of that null stays unobserved: a .claude.json that EXISTS and would not
  // open is not evidence that nobody ever logged in here.
  assert.equal(by(checks({}, healthy(files, { seatsLoggedIn: file({ loggedIn: true, configFile: true }, { loggedIn: null, configFile: null }) })), 'every seat logged in').ok, null,
    'an unreadable .claude.json was read as "never logged in"');
  // A finding beats an incomplete read — for the absent file as for the logged-out one.
  const mixed = by(checks({}, healthy(files, { seatsLoggedIn: file({ loggedIn: null, configFile: false }, { loggedIn: null, configFile: null }) })), 'every seat logged in');
  assert.equal(mixed.ok, false);
  assert.match(mixed.detail, /seat-a \(/);
  assert.match(mixed.detail, /seat-b \(\/h\/\.claude-seat-b\) could not be read/, 'the seat that could not be read must still be named beside the finding');
  // A finding beats an incomplete read.
  assert.equal(by(checks({}, healthy(files, { seatsLoggedIn: login(false, null) })), 'every seat logged in').ok, false);
  // Strict `=== true`: a probe answering a truthy value is not an observation of logged in.
  for (const truthy of ['true', 1, {}, []]) {
    assert.notEqual(by(checks({}, healthy(files, { seatsLoggedIn: login(true, truthy) })), 'every seat logged in').ok, true, `${JSON.stringify(truthy)} was accepted as logged in`);
  }
  // A probe that answered for fewer seats than it was given cannot pass.
  assert.equal(by(checks({}, healthy(files, { seatsLoggedIn: (seats) => [{ ...seats[0], loggedIn: true }] })), 'every seat logged in').ok, false);
  for (const junk of [null, 42, 'nope', { seats: [] }]) {
    assert.equal(by(checks({}, healthy(files, { seatsLoggedIn: () => junk })), 'every seat logged in').ok, false, `${JSON.stringify(junk)} accepted as a login reading`);
  }
});

test('seat projects is the shared tree: identical realpaths are ok, a different one is a FAIL with the symlink fix, an unresolvable one is UNOBSERVED', async (t) => {
  const files = await realFiles(t);
  const { checks } = await load('seats-projects');
  const FLEET = '/h/.claude/projects';
  const trees = (fleet, b) => (seats) => ({
    fleet,
    seats: seats.map((s, i) => ({ label: s.label, config_dir: s.config_dir, projects: i === 0 ? { path: FLEET } : b })),
  });

  const ok = by(checks({}, healthy(files)), 'seat projects is the shared tree');
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /all resolve to \/h\/\.claude\/projects/);

  const forked = by(checks({}, healthy(files, { seatProjects: trees({ path: FLEET }, { path: '/h/.claude-seat-b/projects' }) })), 'seat projects is the shared tree');
  assert.equal(forked.ok, false);
  assert.match(forked.detail, /seat-b \(\/h\/\.claude-seat-b\) → \/h\/\.claude-seat-b\/projects/);
  assert.ok(forked.detail.includes(`ln -s ${FLEET} <config_dir>/projects`), 'the fix is the symlink, spelled out');
  assert.doesNotMatch(forked.detail, /seat-a \(/, 'the shared seat was named as a finding');

  const unread = by(checks({}, healthy(files, { seatProjects: trees({ path: FLEET }, { error: 'EACCES on /h/.claude-seat-b/projects' }) })), 'seat projects is the shared tree');
  assert.equal(unread.ok, null, 'a projects/ that could not be resolved was read as a verdict');
  assert.match(unread.detail, /EACCES on \/h\/\.claude-seat-b\/projects/);

  // No fleet tree to compare against: nothing can be judged, so unobserved — even with a seat present.
  const noFleet = by(checks({}, healthy(files, { seatProjects: trees({ error: 'ENOENT on /h/.claude/projects' }, { path: FLEET }) })), 'seat projects is the shared tree');
  assert.equal(noFleet.ok, null);
  assert.match(noFleet.detail, /fleet's own projects\/ could not be resolved/);
  // An empty-string path is never a path: compared as one it would FAIL a seat for a probe defect.
  assert.equal(by(checks({}, healthy(files, { seatProjects: trees({ path: FLEET }, { path: '' }) })), 'seat projects is the shared tree').ok, null);
  // …and the same on the FLEET side, which is the half no assertion reached: an
  // empty fleet path accepted as a path makes EVERY seat a fork, so a probe defect reads as
  // five seats with the wrong tree.
  const emptyFleet = by(checks({}, healthy(files, { seatProjects: trees({ path: '' }, { path: FLEET }) })), 'seat projects is the shared tree');
  assert.equal(emptyFleet.ok, null, "an empty-string fleet path was compared as a path, so every seat read as forked");
  assert.match(emptyFleet.detail, /fleet's own projects\/ could not be resolved/);
  // A finding beats an incomplete read.
  assert.equal(by(checks({}, healthy(files, { seatProjects: (seats) => ({ fleet: { path: FLEET }, seats: [
    { ...seats[0], projects: { path: '/elsewhere' } }, { ...seats[1], projects: { error: 'EACCES' } }] }) })), 'seat projects is the shared tree').ok, false);
  // Fewer answers than seats cannot pass.
  assert.equal(by(checks({}, healthy(files, { seatProjects: (seats) => ({ fleet: { path: FLEET }, seats: [{ ...seats[0], projects: { path: FLEET } }] }) })), 'seat projects is the shared tree').ok, false);
  for (const junk of [null, 42, [], { fleet: { path: FLEET } }]) {
    assert.equal(by(checks({}, healthy(files, { seatProjects: () => junk })), 'seat projects is the shared tree').ok, false, `${JSON.stringify(junk)} accepted as a projects comparison`);
  }
});

test('mcp enumeration covers every seat: own ⊆ union is ok, a seat-only server missing from the union is a FAIL, an unreadable seat file is UNOBSERVED', async (t) => {
  const files = await realFiles(t);
  const { checks } = await load('seats-mcp');
  const coverage = (union, ownB) => (seats) => ({
    union,
    seats: seats.map((s, i) => ({ label: s.label, config_dir: s.config_dir, own: i === 0 ? { servers: ['seat-only-a'] } : ownB })),
  });

  const ok = by(checks({}, healthy(files)), 'mcp enumeration covers every seat');
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /2 server\(s\) defined across 2 seats/);
  assert.match(ok.detail, /seat-a: 1, seat-b: 1/);

  // The whole point of the check: a server only a seat defines, that the union does not carry.
  const missed = by(checks({}, healthy(files, { seatMcpCoverage: coverage([...files.mcpServers, 'seat-only-a'], { servers: ['srv_write'] }) })), 'mcp enumeration covers every seat');
  assert.equal(missed.ok, false);
  assert.match(missed.detail, /seat-b \(\/h\/\.claude-seat-b\) defines srv_write/);
  assert.match(missed.detail, /undenied/);
  assert.doesNotMatch(missed.detail, /seat-a \(/, 'the covered seat was named as a finding');

  const unread = by(checks({}, healthy(files, { seatMcpCoverage: coverage([...files.mcpServers, 'seat-only-a'], { error: '/h/.claude-seat-b/.claude.json is not valid JSON: Unexpected end' }) })), 'mcp enumeration covers every seat');
  assert.equal(unread.ok, null, 'an unreadable seat .claude.json was read as "defines nothing"');
  assert.match(unread.detail, /\/h\/\.claude-seat-b\/\.claude\.json is not valid JSON/);

  // A seat with no .claude.json at all defines nothing and is covered — a live reading, not a gap.
  assert.equal(by(checks({}, healthy(files, { seatMcpCoverage: coverage([...files.mcpServers, 'seat-only-a'], { servers: [], absent: true }) })), 'mcp enumeration covers every seat').ok, true);
  // A finding beats an incomplete read.
  assert.equal(by(checks({}, healthy(files, { seatMcpCoverage: coverage(files.mcpServers, { error: 'EACCES' }) })), 'mcp enumeration covers every seat').ok, false);
  // A probe that answered for fewer seats than it was given cannot pass, the twin of the
  // assertions the login and projects judges each carry: observing one of two
  // seats and reporting ok is how a coverage gap becomes a green line.
  assert.equal(by(checks({}, healthy(files, { seatMcpCoverage: (seats) => ({ union: [], seats: [{ ...seats[0], own: { servers: [] } }] }) })), 'mcp enumeration covers every seat').ok, false,
    'the coverage probe answered for 1 of 2 seats and the check passed: a seat nobody looked at read as covered');
  // The enumeration itself throwing is the FAIL `mcp enumeration readable` makes of it: no guard file can be written.
  const threw = by(checks({}, healthy(files, { seatMcpCoverage: () => { throw new SyntaxError('/h/.claude-seat-b/.claude.json is not valid JSON'); } })), 'mcp enumeration covers every seat');
  assert.equal(threw.ok, false);
  assert.match(threw.detail, /not valid JSON/);
  for (const junk of [null, 42, [], { union: [] }, { seats: [] }]) {
    assert.equal(by(checks({}, healthy(files, { seatMcpCoverage: () => junk })), 'mcp enumeration covers every seat').ok, false, `${JSON.stringify(junk)} accepted as a coverage reading`);
  }
});

test('seat pool state readable: no file yet is ok, rows are ok with counts, a torn pool is a FAIL that names the row', async (t) => {
  const files = await realFiles(t);
  const { checks } = await load('seat-pool');
  const NAME = 'seat pool state readable';
  const FP = '/abs/soma/state/seats.json';

  // The state a newly seated fleet is in: seats declared, no seat ever closed, so no pool file.
  // This is NOT "unreadable" and NOT a gap — it is the normal state of a seated fleet, and the
  // sentence has to differ from a corrupt file's because the remedies differ.
  const fresh = by(checks({}, healthy(files)), NAME);
  assert.equal(fresh.ok, true);
  assert.match(fresh.detail, /no seat has been closed yet/);
  assert.ok(fresh.detail.includes(FP));

  const rows = by(checks({}, healthy(files, { seatPool: () => ({ state: 'rows', path: FP, rows: 3, closed: 1, unverified: 1 }) })), NAME);
  assert.equal(rows.ok, true);
  assert.match(rows.detail, /3 rows/);
  assert.match(rows.detail, /1 closed/);
  assert.match(rows.detail, /1 unverified/);

  // THE SILENT STALL. A torn pool makes readSeatState answer UNREADABLE, pick() answer null, and
  // the watchdog say ROTATION_UNAVAILABLE {why:'seats_unreadable'} ONCE PER LEAD PER LAUNCH —
  // deduped off the durable log against the lead's newest launch, so a fleet nobody restarts is
  // told once and never again (measured in `test/watchdog.tick.test.mjs`, *the ONCE is
  // once per LAUNCH*). Doctor is the only thing that keeps saying it.
  const torn = by(checks({}, healthy(files, { seatPool: () => ({ state: 'torn', path: FP, why: `${FP}: seats[1] (/h/.claude-seat-b) closed_until is "soon" — must be a finite epoch-ms number >= 0` }) })), NAME);
  assert.equal(torn.ok, false);
  assert.match(torn.detail, /seats\[1\] \(\/h\/\.claude-seat-b\) closed_until is "soon"/, 'the detail must name WHICH row and field voided the pool — the bytes are kept so a human can repair them');
  assert.match(torn.detail, /once per lead per LAUNCH — a fleet nobody restarts is told on the first tick and then goes quiet/,
    'the operator must be told what the one-shot event is one-shot PER — "exactly once per lead" was false: a revived lead is told again');

  // A file that exists and will not open stalls rotation exactly as a torn one does, so it is a
  // FAIL, not unobserved: the consequence is definite even though the content was not read.
  const locked = by(checks({}, healthy(files, { seatPool: () => ({ state: 'unreadable', path: FP, why: `EACCES on ${FP}` }) })), NAME);
  assert.equal(locked.ok, false);
  assert.match(locked.detail, /EACCES/);

  // The third state is the probe, not the file: no probe, or one that threw.
  assert.equal(by(checks({}, healthy(files, { seatPool: undefined })), NAME).ok, null);
  assert.equal(by(checks({}, healthy(files, { seatPool: () => { throw new Error('boom'); } })), NAME).ok, false);
  for (const junk of [null, 42, 'nope', [], {}, { state: 'weird' }]) {
    assert.equal(by(checks({}, healthy(files, { seatPool: () => junk })), NAME).ok, false, `${JSON.stringify(junk)} accepted as a pool reading`);
  }
});

test('the seatPool probe reads the real state/seats.json, and takes its VERDICT from readSeatState so doctor cannot disagree with pick()', async (t) => {
  const home = somaHome(t);
  fakeHome(t, { mcpServers: {} });
  const { defaultProbes } = await load('seat-pool-real');
  const { ensureTree, p } = await import(`../bin/lib/paths.mjs?pool-${Date.now()}`);
  ensureTree();
  const probes = defaultProbes({});
  const fp = p('state', 'seats.json');

  // No file: every seated fleet before its first close.
  assert.deepEqual(probes.seatPool(), { state: 'absent', path: fp });

  // The missing FILE and the empty POOL are different sentences with different remedies, and
  // `readSeatState` answers `{seats: []}` for both — so the ENOENT of the probe's own read is
  // the only thing that may tell them apart, and it may not decide anything else: the
  // probe now takes its verdict from readSeatState on every path, and the file's existence
  // chooses between two OK lines.
  writeFileSync(fp, JSON.stringify({ seats: [] }));
  assert.deepEqual(probes.seatPool(), { state: 'rows', path: fp, rows: 0, closed: 0, unverified: 0 },
    'a pool file that exists and holds no rows read as "no file yet" — those have different remedies');
  rmSync(fp);
  assert.deepEqual(probes.seatPool(), { state: 'absent', path: fp }, 'and with the file gone again it is absent, not an empty pool');

  // Rows, with the two counts an operator acts on.
  writeFileSync(fp, JSON.stringify({ seats: [
    { config_dir: '/h/a', label: 'a' },
    { config_dir: '/h/b', label: 'b', closed_until: 1440433800000, closed_reason: 'five_hour' },
    { config_dir: '/h/c', label: 'c', unverified: true }] }));
  assert.deepEqual(probes.seatPool(), { state: 'rows', path: fp, rows: 3, closed: 1, unverified: 1 });

  // Torn, four ways, each located by row and field. The VERDICT is readSeatState's — severing
  // that call is what a mutation proves — and the `why` only says where to look.
  const tornBy = (body) => { writeFileSync(fp, body); return probes.seatPool(); };
  // The STATE first, so severing the readSeatState call reddens on a value rather than on an
  // undefined `.why` — a TypeError is a kill, but it does not say which claim broke.
  assert.equal(tornBy('{ "seats": [').state, 'torn', 'the verdict is not coming from readSeatState');
  assert.match(tornBy('{ "seats": [').why, /is not valid JSON/);
  assert.match(tornBy('[]').why, /does not hold a JSON object/);
  assert.match(tornBy('{"seats":{}}').why, /"seats" is an object, not an array/);
  assert.match(tornBy('{"seats":[{"config_dir":""}]}').why, /seats\[0\]\.config_dir is "" /);
  assert.match(tornBy('{"seats":[{"config_dir":"/h/a"},{"config_dir":"/h/b","closed_until":"soon"}]}').why,
    /seats\[1\] \(\/h\/b\) closed_until is "soon"/);
  assert.match(tornBy('{"seats":[{"config_dir":"/h/a","unverified":"yes"}]}').why,
    /seats\[0\] \(\/h\/a\) unverified is "yes"/);
  for (const body of ['{ "seats": [', '[]', '{"seats":{}}', '{"seats":[{"config_dir":""}]}']) {
    assert.equal(tornBy(body).state, 'torn', body);
  }

  // …and every one of those IS what production refuses, asserted against readSeatState itself
  // rather than against this reader's opinion of it.
  const { readSeatState } = await import(`../bin/lib/seats.mjs?pool-${Date.now()}`);
  for (const body of ['{ "seats": [', '[]', '{"seats":{}}', '{"seats":[{"config_dir":""}]}',
    '{"seats":[{"config_dir":"/h/b","closed_until":"soon"}]}', '{"seats":[{"config_dir":"/h/a","unverified":"yes"}]}']) {
    writeFileSync(fp, body);
    assert.equal(readSeatState().unreadable, true, `readSeatState accepts ${body}, so the probe must not call it torn`);
  }
});

test('the seat probes read the real filesystem: dir state, login, realpath, and the production enumeration with the seats as roots', async (t) => {
  const home = somaHome(t);
  fakeHome(t, { mcpServers: { extra_mcp: {} } });
  const { defaultProbes } = await load('seats-real');
  // A fleet root whose projects/ is the shared tree, and three seats beside it: one symlinked
  // to the tree and logged in, one with its own projects/ and no login, one that does not exist.
  const fleet = join(process.env.HOME, '.claude-second');
  mkdirSync(join(fleet, 'projects'), { recursive: true });
  const seatA = join(process.env.HOME, '.claude-seat-a');
  const seatB = join(process.env.HOME, '.claude-seat-b');
  const seatC = join(process.env.HOME, 'no-such-seat');
  mkdirSync(seatA);
  mkdirSync(seatB);
  symlinkSync(join(fleet, 'projects'), join(seatA, 'projects'));
  mkdirSync(join(seatB, 'projects'));
  writeFileSync(join(seatA, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'a@example.com' },
    mcpServers: { soma: { command: 'node' }, 'seat-only-a': {} },
    projects: { '/w': { mcpServers: { 'seat-proj-a': {} } } },
  }));
  writeFileSync(join(seatB, '.claude.json'), JSON.stringify({ mcpServers: {} }));
  writeFileSync(join(home, 'soma.json'), JSON.stringify({ seats: [
    { config_dir: seatA, label: 'seat-a' }, { config_dir: seatB, label: 'seat-b' }, { config_dir: seatC, label: 'seat-c' }] }));

  const p = defaultProbes({ CLAUDE_CONFIG_DIR: fleet });
  const seats = p.seats();
  assert.deepEqual(seats.map((s) => [s.label, s.exists]), [['seat-a', true], ['seat-b', true], ['seat-c', false]]);
  assert.equal(seats[0].config_dir, seatA, 'config_dir must come back resolved, as loadSeats resolves it');

  // Delegated to seats.loggedIn — sever the call and every entry reads the same value. The
  // second field is doctor's own: seat-a has an oauthAccount, seat-b a .claude.json without one,
  // and seat-c no file at all — which seats.loggedIn folds into the same null as a file that
  // will not open, and which `configFile: false` is what tells the check apart.
  assert.deepEqual(p.seatsLoggedIn(seats).map((s) => [s.loggedIn, s.configFile]), [[true, true], [false, true], [null, false]],
    'the login reading, and whether the .claude.json is there at all: absent must read false, so a seat nobody ever logged into is a finding rather than an unobserved line');

  const trees = p.seatProjects(seats);
  assert.equal(trees.fleet.path, realpathSync(join(fleet, 'projects')));
  assert.equal(trees.seats[0].projects.path, trees.fleet.path, 'the symlinked seat must resolve to the shared tree');
  assert.notEqual(trees.seats[1].projects.path, trees.fleet.path, 'a seat with its own projects/ directory is a fork');
  assert.match(trees.seats[2].projects.error, /ENOENT/);

  const cov = p.seatMcpCoverage(seats);
  assert.ok(cov.union.includes('seat-only-a'), 'THE SEAM: the union is not the production enumeration with the seats as roots');
  assert.ok(cov.union.includes('seat-proj-a'), 'per-project servers in a seat file are part of the union');
  assert.ok(cov.union.includes('extra_mcp'), 'the fixed pair is still read');
  assert.equal(cov.union.includes('soma'), false);
  assert.deepEqual(cov.seats[0].own.servers.slice().sort(), ['seat-only-a', 'seat-proj-a'], 'own must drop soma — init registers the bus in every seat');
  assert.deepEqual(cov.seats[1].own, { servers: [] });
  assert.deepEqual(cov.seats[2].own, { servers: [], absent: true });
  // …and `mcp deny drift`'s subject is the SAME enumeration, read through the probe that check
  // uses — pinned here so the two cannot be split apart later, which would re-open the measured
  // blind spot: a guard file missing a seat's servers reading as no drift.
  assert.ok(p.mcpServers().includes('seat-only-a'), 'the mcpServers probe enumerates without the seat roots — drift on a seat server is invisible');

  // An unparseable seat file: the enumeration refuses the root and the throw is the FAIL, as
  // `mcp enumeration readable` rules for the fixed pair.
  writeFileSync(join(seatB, '.claude.json'), '{ "mcpServers": { ');
  assert.throws(() => p.seatMcpCoverage(seats), /not valid JSON/);

  // THE OTHER SEAM: `~` expansion and the basename label are `seats.loadSeats`' work, not this
  // probe's. Sever the call — `(loadConfig().seats ?? [])` — and the RAW soma.json entry comes
  // back: an unexpanded `~/…` that `dirState` stats as absent, so `seats readable` FAILs a
  // healthy seat, and `label: undefined`, which the detail prints as `?`. This is the spelling
  // `soma init --seat`'s own success message and the RUNBOOK tell the operator to write, so the
  // fixture above — absolute config_dirs, explicit labels — is true with or without the call.
  const tildeSeat = join(process.env.HOME, '.claude-seat-tilde');
  mkdirSync(tildeSeat);
  writeFileSync(join(home, 'soma.json'), JSON.stringify({ seats: [{ config_dir: '~/.claude-seat-tilde' }] }));
  const [expanded] = p.seats();
  assert.equal(expanded.config_dir, tildeSeat, 'THE SEAM: ~ must be expanded through loadSeats/resolveConfigDir — a raw "~/…" stats as absent and FAILs a healthy seat');
  assert.equal(expanded.label, '.claude-seat-tilde', 'loadSeats defaults a missing label to the basename; without it the detail prints "?" where the seat name belongs');
  assert.equal(expanded.exists, true, 'the expanded path is the one stat\'ed');

  // `own`'s error classification, reached the one way production reaches it: a seat the COVERAGE
  // CALL was handed that soma.json does not list. For a listed seat the union enumerates the same
  // file and throws first (asserted above), which is why every mutation of these arms
  // survived — but the seat list `checks()` passes in and the config the union reads are two
  // reads at two instants, and a pool edited between them leaves exactly this seat: read by
  // `own`, absent from the union's roots. An unreadable file must not read as "defines nothing"
  // there either; the judge's unobserved arm is written for it.
  const ghost = (dir) => p.seatMcpCoverage([{ label: 'ghost', config_dir: dir }]).seats[0].own;
  assert.match(ghost(seatB).error, /is not valid JSON/, 'an unparseable seat .claude.json read as a server list');
  writeFileSync(join(seatB, '.claude.json'), '[]');
  assert.match(ghost(seatB).error, /does not hold a JSON object/, 'a .claude.json holding an array read as a server list');
  if (process.getuid?.() !== 0) {
    chmodSync(join(seatB, '.claude.json'), 0o000);
    assert.match(ghost(seatB).error, /EACCES/, 'a .claude.json that exists and would not open read as "defines nothing"');
    chmodSync(join(seatB, '.claude.json'), 0o644);
  }

  // `exists: null` for real: a seat under a directory this process may not search. EACCES on a
  // parent is not "the seat is missing", and every seat probe must say so, not guess.
  if (process.getuid?.() !== 0) {
    const locked = join(process.env.HOME, 'locked');
    const seatD = join(locked, 'seat-d');
    mkdirSync(seatD, { recursive: true });
    writeFileSync(join(home, 'soma.json'), JSON.stringify({ seats: [{ config_dir: seatD, label: 'seat-d' }] }));
    chmodSync(locked, 0o000);
    try {
      const [d] = p.seats();
      assert.equal(d.exists, null, 'EACCES on a parent was read as a verdict about the seat');
      assert.deepEqual(p.seatsLoggedIn([d]).map((s) => [s.loggedIn, s.configFile]), [[null, null]],
        'EACCES on a parent is not "there is no .claude.json here": that would report a seat as never logged in on a permissions fault');
      assert.match(p.seatProjects([d]).seats[0].projects.error, /EACCES/);
    } finally {
      chmodSync(locked, 0o755);
    }
  }
});

/* ------------------------------------------ the seam the fixture cannot see */

/**
 * `healthy()` proves every check has a healthy reading, and the "every check is observed" test
 * proves the fixture answers every key `checks()` reads. Neither compares those keys with the
 * ones `defaultProbes()` answers — two literal lists in two files that nothing held equal.
 * Rename `cdCompoundRead` in `defaultProbes` and `observe()` answers `{absent: true}`: the check
 * reads `unobserved` on every real `soma doctor`, `runDoctor` prints INCOMPLETE and exits 0, and
 * this file stayed 43/43 green (measured: that renaming mutation survived). So the
 * reading below records which keys `checks()` actually reaches for, through the fixture, and
 * holds that the REAL probe set answers each with a function — closing the class for every
 * check, not only the one that exposed it. Nothing on `defaultProbes({})` is CALLED:
 * `cdCompoundRead` spawns `claude -p`, `repos` runs `git fetch`; `typeof` is the whole measurement.
 */
test('every probe key checks() reads is a function on defaultProbes(), so a renamed probe cannot leave a check unobserved forever', async (t) => {
  somaHome(t);
  const files = await realFiles(t);
  const { checks, CHECKS, defaultProbes } = await load('probekeys');

  const fixture = healthy(files);
  const seen = new Set();
  const recording = new Proxy(fixture, {
    get(target, key, receiver) {
      if (typeof key === 'string') seen.add(key);
      return Reflect.get(target, key, receiver);
    },
  });
  const results = checks({ CLAUDE_CODE_SESSION_ID: UUID }, recording);

  // The third state, made loud rather than left green: a recording that saw nothing measured
  // nothing, and the assertions below would pass over an empty set.
  assert.equal(results.length, CHECKS.length, 'the recorded run did not produce the full report, so the keys it read are not the keys doctor reads');
  assert.ok(seen.size > 0, 'checks() read no key through the probe object — the recording saw nothing, and nothing below was measured');
  // On a healthy machine the checks read exactly the fixture's keys: nothing the fixture lacks
  // (an unobserved check, which the fence above catches) and nothing it carries unread.
  assert.deepEqual([...seen].sort(), Object.keys(fixture).sort(),
    'the keys checks() reads and the keys healthy() defines have drifted apart');

  // THE SEAM. `observe()` reads `probe[key]` and treats anything but a function as `{absent}`;
  // an absent probe is an unobserved check, never a FAIL, so a misspelling here is silent at
  // runtime and was silent in this suite.
  const real = defaultProbes({});
  const missing = [...seen].sort().filter((k) => typeof real[k] !== 'function');
  assert.deepEqual(missing, [],
    `defaultProbes() answers no function for: ${missing.join(', ')} — every check reading those keys is unobserved on every real soma doctor`);
  // …and the other direction: a probe no check reads is wiring nobody observes.
  const dead = Object.keys(real).filter((k) => !seen.has(k)).sort();
  assert.deepEqual(dead, [], `defaultProbes() carries probes no check reads: ${dead.join(', ')}`);
});

// --- the drift probe reads the seats the spawner writes guard files from ------------------
//
// `mcp deny drift` compares the newest guard file's bare `mcp__<server>` denies against
// `probe.mcpServers()`, and `guard file matches the generator` compares it against
// `probe.guardFile().reference`. The spawner now writes those denies from the fixed pair PLUS
// every seat's config dir, so a probe that still read only the fixed pair would report every
// seat-only server as "denied but not enumerated" / "unexpected" — a FAIL on a healthy fleet,
// on every worktree, from the first seat with a server the ambient root lacks.

test('defaultProbes().mcpServers enumerates every seat in soma.json — the same list the spawner writes guard files from', async (t) => {
  somaHome(t);
  fakeHome(t, { mcpServers: { ambient_user: {} } });
  const seat = mkdtempSync(join(tmpdir(), 'seat-c-'));
  t.after(() => rmSync(seat, { recursive: true, force: true }));
  writeFileSync(join(seat, '.claude.json'), JSON.stringify({ mcpServers: { seat_c_only: {} } }));
  const { writeConfig } = await import(`../bin/lib/config.mjs?seatprobe-${Date.now()}`);
  writeConfig({ seats: [{ config_dir: seat, label: 'seat-c' }] });
  // Could-not-observe, checked first: with no roots the ambient pair must not know the name,
  // or its presence below would not mean the probe read soma.json's seats.
  const sg = await import(`../bin/lib/settings-gen.mjs?seatprobe-${Date.now()}`);
  assert.ok(!sg.enumerateUserMcpServers().includes('seat_c_only'),
    'could not observe: the ambient config pair already enumerates seat_c_only');
  const { defaultProbes } = await load('seatprobe');
  const got = defaultProbes().mcpServers();
  assert.ok(got.includes('seat_c_only'),
    `the drift check would flag the spawner's own seat denies as "denied but not enumerated"; probe returned ${JSON.stringify(got)}`);
});

test('a seat soma.json cannot resolve makes the probe THROW, so doctor reads FAIL, never "0 servers"', async (t) => {
  somaHome(t);
  fakeHome(t, { mcpServers: { ambient_user: {} } });
  const { writeConfig } = await import(`../bin/lib/config.mjs?seatbad-${Date.now()}`);
  writeConfig({ seats: [{ config_dir: '', label: 'broken' }] });
  const { defaultProbes } = await load('seatbad');
  // `checks()` turns a throwing probe into `mcp enumeration readable: FAIL` and
  // `mcp deny drift: unobserved`; a probe that caught this and returned the fixed pair would
  // report a healthy boundary on a fleet whose spawner refuses every launch. config.mjs
  // validates nothing about `seats` (that is left to seats.mjs), so the refusal is
  // `loadSeats` → `resolveConfigDir('')`, the same TypeError the spawner's `seatRoots` raises.
  assert.throws(() => defaultProbes().mcpServers(), TypeError,
    'the spawner refuses seatRoots(cfg) on this config, and the probe must surface the same refusal');
});

test('defaultProbes().guardFile().reference denies a seat-only server, so a healthy live guard file is not reported as drift', async (t) => {
  somaHome(t);
  fakeHome(t, { mcpServers: { ambient_user: {} } });
  const seat = mkdtempSync(join(tmpdir(), 'seat-c-'));
  t.after(() => rmSync(seat, { recursive: true, force: true }));
  writeFileSync(join(seat, '.claude.json'), JSON.stringify({ mcpServers: { seat_c_only: {} } }));
  const { writeConfig } = await import(`../bin/lib/config.mjs?seatref-${Date.now()}`);
  writeConfig({ seats: [{ config_dir: seat, label: 'seat-c' }] });
  const { defaultProbes } = await load('seatref');
  const { reference } = defaultProbes().guardFile();
  assert.ok(reference.permissions.deny.includes('mcp__seat_c_only'),
    '`guard file matches the generator` would report the spawner\'s seat deny as "unexpected" on every worktree — the reference is generated inside a scratch state root where soma.json does not exist, so seats must be read before the swap');
});

test('defaultProbes().guardFile().reference honours soma.json teammate_mcp_allow, like every live guard file does', async (t) => {
  somaHome(t);
  fakeHome(t, { mcpServers: { ambient_user: {}, exempt_one: {} } });
  const { writeConfig } = await import(`../bin/lib/config.mjs?allowref-${Date.now()}`);
  writeConfig({ teammate_mcp_allow: ['exempt_one'] });
  const { defaultProbes } = await load('allowref');
  const { reference } = defaultProbes().guardFile();
  assert.ok(reference.permissions.deny.includes('mcp__ambient_user'), 'could not observe: the reference carries no personal denies at all');
  assert.ok(!reference.permissions.deny.includes('mcp__exempt_one'),
    'the reference read the SCRATCH root\'s empty allowlist, so every operator with an allowlist sees "missing: mcp__<exempt>" drift on every worktree');
});

test('defaultProbes(env).mcpServers reads the fixed pair from the env it was HANDED, not from process.env', async (t) => {
  somaHome(t);
  fakeHome(t, { mcpServers: { ambient_user: {} } });
  const root = mkdtempSync(join(tmpdir(), 'cfgroot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.claude.json'), JSON.stringify({ mcpServers: { env_root_only: {} } }));
  // Could-not-observe, checked first: the process env (CLAUDE_CONFIG_DIR is deleted at the top
  // of this file) must not already reach `root`, or presence below would not mean `env` was read.
  const sg = await import(`../bin/lib/settings-gen.mjs?envprobe-${Date.now()}`);
  assert.ok(!sg.enumerateUserMcpServers().includes('env_root_only'),
    'could not observe: the process environment already enumerates env_root_only');
  const { defaultProbes } = await load('envprobe');
  const got = defaultProbes({ CLAUDE_CONFIG_DIR: root }).mcpServers();
  assert.ok(got.includes('env_root_only'),
    `\`checks(env, probe)\` is handed one env and the probes must answer about that env — a probe reading process.env answers about the doctor process's own root instead; probe returned ${JSON.stringify(got)}`);
});

// --- what the operator actually READS, and the env the reference is generated about -------

test('the two mcp detail lines say "and every seat" — the sentence that tells an operator the seats were read', async (t) => {
  // Both strings were unpinned: reverting them to the pre-seats wording left this file 49/49
  // green, because the render table at :1371 matches only `both config roots`, which survives
  // the revert. A detail line is the entire output of a check; an operator who sees "across
  // both config roots" has been told the seats were NOT enumerated.
  const files = await realFiles(t);
  const { checks } = await load('seatdetail');
  const green = checks({}, healthy(files));
  assert.match(by(green, 'mcp enumeration readable').detail, /and every seat/,
    'the healthy enumeration line must name the seats it read, or a probe that silently stopped reading them looks identical');
  assert.match(by(green, 'mcp deny drift').detail, /and every seat/,
    'the healthy drift line names what the guard file was compared AGAINST');
  // The drifting branch is a different string and needs its own reading.
  const drifting = checks({}, healthy(files, { mcpServers: () => [...files.mcpServers, 'srv_write'] }));
  assert.equal(by(drifting, 'mcp deny drift').ok, false, 'could not observe: the drift branch did not fire, so its detail is not under test');
  assert.match(by(drifting, 'mcp deny drift').detail, /every seat/,
    'the FAILING line is the one an operator acts on; it must say which union the guard file disagrees with');
});

test('the reference guard is generated about the env doctor was HANDED, not about the doctor process\'s own root', async (t) => {
  // The narrow throw path the seats work opened: `mcpDenies` came from the handed `env`, while
  // `writeWorktreeGuardrails`' own empty-mcpDenies refusal re-enumerated from `process.env`. On
  // a fleet root with no servers and a doctor process whose own root has some, the two disagree
  // and `guardFile()` THROWS — `worktree guard file readable: FAIL` about a machine nobody
  // asked about. Loud rather than fail-open, but still a wrong reading, and it is the seat checks'
  // `defaultProbes({ CLAUDE_CONFIG_DIR: fleet })` that reaches it.
  somaHome(t);
  const home = fakeHome(t);                                  // no ~/.claude.json at all
  const quiet = mkdtempSync(join(tmpdir(), 'fleetroot-'));    // the root doctor is ASKED about: bare
  const loud = mkdtempSync(join(tmpdir(), 'cfgroot-'));       // the doctor PROCESS's own root: one server
  const saved = process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
    for (const d of [quiet, loud]) rmSync(d, { recursive: true, force: true });
  });
  writeFileSync(join(loud, '.claude.json'), JSON.stringify({ mcpServers: { process_env_only: {} } }));
  process.env.CLAUDE_CONFIG_DIR = loud;
  // Could-not-observe, checked first and in both directions: the process root must hold a server
  // the handed root does not, or the two enumerations agree by accident and this proves nothing.
  const sg = await import(`../bin/lib/settings-gen.mjs?envref-${Date.now()}`);
  assert.ok(sg.enumerateUserMcpServers().includes('process_env_only'),
    'could not observe: the doctor process\'s own root does not hold the server that makes the two enumerations disagree');
  assert.deepEqual(sg.enumerateUserMcpServers(home, { CLAUDE_CONFIG_DIR: quiet }), [],
    'could not observe: the handed fleet root is not bare, so an empty deny list is not what this asks about');
  const { defaultProbes } = await load('envref');
  const { reference } = defaultProbes({ CLAUDE_CONFIG_DIR: quiet }).guardFile();
  const personal = reference.permissions.deny.filter((d) => d.startsWith('mcp__') && !d.includes('*') && !d.slice(5).includes('__'));
  assert.deepEqual(personal, [],
    'a bare fleet root has no personal server to deny, and saying so is the honest reading — a throw here reads as "worktree guard file readable: FAIL" on a healthy fleet');
});

// ---------------------------------------------------------------------------
// The runbook quotes the check count as a literal in five places. `test/settings-gen.test.mjs`
// records why a literal repeated in prose is pinned to the RELATION and never to another
// literal: three documents quoted a deny-rule count and all three were wrong by 37. Same
// shape here — the count went 42 -> 48 with the auto-continue floor and the seat checks,
// all five sites still said 42, and nothing reddened.
// ---------------------------------------------------------------------------

/**
 * What one RUNBOOK site quotes as the check count — a THREE-STATE reading, not a number.
 *
 * Hoisted out of the test below so the pin's own matcher can itself be pinned: a defect in
 * *which line* a pin reads is invisible from that pin's green, because a reader that takes a
 * neighbour's number still takes a plausible one.
 *
 * The number is matched against the ANCHORED LINE ALONE. It used to be matched against
 * `lines[i-2 … i+2]` joined, and a non-global `.match()` on that returns the FIRST occurrence in
 * reading order, which need not be the one on the anchored line. MEASURED: with
 * `- The 48 checks are listed in §5.2` inserted two lines above a §13 site reading
 * `**The 42 checks**`, this pin stayed green at 63 / 63 while a stale literal stood at the site
 * it names. All five sites carry their number on the anchor line, so the neighbourhood bought
 * nothing and hid that. The narrowing also moves a reflow that pushes the number onto the next
 * line from "silently read the neighbour" to `number` below — a re-anchor request, which is the
 * safe direction for a pin whose whole value is future edits.
 *
 * `anchor`: the noun phrase is gone. `number`: the site is there and its own line no longer
 * quotes a count. Otherwise the reading, with `n` and the line it came from.
 */
const quotedCount = (lines, anchor, says) => {
  const i = lines.findIndex((l) => anchor.test(l));
  if (i === -1) return { state: 'anchor', i: -1, line: null, n: null };
  const m = lines[i].match(says);
  if (m === null) return { state: 'number', i, line: lines[i], n: null };
  return { state: 'read', i, line: lines[i], n: Number(m[1]) };
};

test('the doctor check count the runbook quotes is CHECKS.length, at every site that quotes it', async () => {
  const { CHECKS } = await load('runbookcount');
  const lines = readFileSync(new URL('../RUNBOOK.md', import.meta.url), 'utf8').split('\n');
  // Scoped to the anchored LINE, never the whole file: a whole-file /48/ is satisfied by a line
  // number or a byte count, and a windowed one by the sentence next door (`quotedCount` above).
  // Anchors are the NOUN PHRASE beside the number, never the number, so an honest reword of the
  // verb does not redden — and a wrong count at an anchored site always does.
  const SITES = [
    ['§4 dead-config-keys note', /in the shipped doctor — `CHECKS` has/, /`CHECKS` has (\d+) entries/],
    ['§5.2 opening line',        /named checks plus one row per configured repo/, /(\d+) named checks/],
    ['§5.2 summary table',       /checks hold on this machine` \| 0 \|/, /all (\d+) checks hold/],
    ['§7 verb table',            /checks \+ per-repo rows; stdout/, /(\d+) checks \+ per-repo rows/],
    ['§13 reference',            /— `bin\/lib\/doctor\.mjs` \(`CHECKS`\)/, /The (\d+) checks/],
  ];
  for (const [where, anchor, says] of SITES) {
    const got = quotedCount(lines, anchor, says);
    // Three states, and the two that are not a reading redden rather than skipping: a pin whose
    // subject has gone missing is not "unobserved, carry on" — it is the one moment someone can
    // re-anchor it. Says the right number / says a number that is wrong / no longer says one.
    assert.notEqual(got.state, 'anchor', `RUNBOOK anchor ${anchor} vanished — re-anchor this pin, do not delete it`);
    assert.notEqual(got.state, 'number',
      `${where}: the sentence near ${anchor} no longer quotes a check count on its own line (${JSON.stringify(got.line)})`);
    assert.equal(got.n, CHECKS.length,
      `${where} says ${got.n} checks; doctor.mjs CHECKS has ${CHECKS.length} — re-count from CHECKS, never from another sentence`);
  }
});

// ---------------------------------------------------------------------------
// The pin above is only as good as which LINE it reads, and that is not visible from its green.
// So the reader is pinned on a fixture, with the decoy a mutation run actually found: a correct
// count on a neighbouring line, two above a site whose own number is stale.
// ---------------------------------------------------------------------------

test('the check-count reader takes the number from the ANCHORED line, never from a neighbour', () => {
  const ANCHOR = /— `bin\/lib\/doctor\.mjs` \(`CHECKS`\)/;
  const SAYS = /The (\d+) checks/;
  const decoyed = [
    '- **The nine invariants, in full** — `bin/lib/canary.mjs`',
    '- The 48 checks are listed in §5.2',
    '- **The 42 checks** — `bin/lib/doctor.mjs` (`CHECKS`)',
    '- **Account rotation, design** — `docs/superpowers/specs/2026-09-15-account-rotation-design.md`',
  ];
  assert.deepEqual(quotedCount(decoyed, ANCHOR, SAYS), { state: 'read', i: 2, line: decoyed[2], n: 42 },
    'the reader took a neighbouring line\'s count, so a stale literal at the anchored site passes');
  // The two could-not-observe states, kept apart from each other and from a reading.
  assert.equal(quotedCount(['- nothing that matches'], ANCHOR, SAYS).state, 'anchor',
    'a site whose noun phrase is gone must read `anchor` — the state that asks for a re-anchor');
  assert.equal(quotedCount(['- **The checks** — `bin/lib/doctor.mjs` (`CHECKS`)'], ANCHOR, SAYS).state, 'number',
    'a site that stopped quoting a number is not the same state as a site that is gone');
  // …and a site that does quote one is read, so the three states above are not the only outcome.
  assert.equal(quotedCount(['- **The 48 checks** — `bin/lib/doctor.mjs` (`CHECKS`)'], ANCHOR, SAYS).n, 48,
    'a site that does quote its count must be READ — without this the three states above are satisfied by a reader that never reads');
});

// ---------------------------------------------------------------------------
// The names, not just the count. A count pin is satisfied by six checks nobody documented and
// six lines of prose about something else; §5.2 is where an operator reads what the doctor is
// about to print, so every name `CHECKS` carries has to appear there.
// ---------------------------------------------------------------------------

test('every name in CHECKS is written somewhere in RUNBOOK §5.2', async () => {
  const { CHECKS } = await load('runbooknames');
  const runbook = readFileSync(new URL('../RUNBOOK.md', import.meta.url), 'utf8');
  const start = runbook.indexOf('named checks plus one row per configured repo');
  const end = runbook.indexOf('**Read the summary word');
  // Could-not-observe, checked first: if either boundary moved this pin is reading the wrong
  // window and must say so, not quietly pass over a section it never found.
  assert.ok(start !== -1 && end > start,
    'could not observe: RUNBOOK §5.2 no longer runs from the "named checks" line to "Read the summary word" — re-anchor this pin');
  const section = runbook.slice(start, end);
  const missing = CHECKS.filter((name) => !section.includes('`' + name + '`'));
  assert.deepEqual(missing, [],
    '§5.2 lists what the doctor prints; these CHECKS names are not in it — add them to the grouped list in CHECKS order');
});
