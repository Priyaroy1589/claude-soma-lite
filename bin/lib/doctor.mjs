/**
 * `soma doctor` — the preflight, and the only thing in this system that can SEE the
 * mechanisms which fail silently.
 *
 * The design lists doctor as a golden-path step ("the queue refuses to open until all
 * three pass"), which undersells what it is for. Almost every safety mechanism in
 * claude-soma-lite **fails silently when it breaks**, and this build found four separate
 * inert breakers by measurement rather than by symptom: a PreToolUse matcher too narrow to
 * reach the tools that spend, a token meter reading a stale config root, a spend cap blind
 * to 60% of actual spend, and a `?? 0` fallback that reported every lead at 0% of budget
 * and disabled the cap fleet-wide. Not one of those produced an error, a log line, or a
 * failed test. Doctor is the instrument for that class, which fixes what it must do:
 *
 *   **ASSERT THE THINGS WHOSE ABSENCE PRODUCES NO ERROR.** A missing `tmux` announces
 *   itself on the first spawn. A `PreToolUse` matcher narrowed from `'*'` to `'Bash'`
 *   announces nothing, ever — the hook is still in the file and its command still points at
 *   a script that exists. The second kind is what earns a check here.
 *
 *   ⚠ **AND THAT SENTENCE USED TO ASSERT THE WRONG HALF.** For most of this build nothing
 *   in this module read a hook's *command* at all — only its matcher — so "its command
 *   still points at a script that exists" was a property doctor described and never
 *   observed. Three spellings of a wholly inert gate (a command pointing at a missing
 *   script, `hooks: []` with the matcher intact, and `command: "true"`) each produced a
 *   full green report with zero rows moving. `… command runs the gate` is now the check
 *   that takes it. (It once also policed a `--session-guard` argument, back when that flag
 *   switched on the gate's session-discriminated edit arm; the arm and the flag are
 *   retired, and a registration still carrying the flag is ignored, not failed.)
 *
 *   **PRINT WHAT WAS RESOLVED, NEVER "ok".** Every `detail` below carries the value the
 *   check actually read: the config root and whether the override is active, the node the
 *   PATH resolves to and where, the count of personal MCP denies, the trip path. A report
 *   that says `ok  claude config root` is unreadable against the one failure mode that
 *   matters, which is two roots on one machine and the wrong one being read.
 *
 *   **AN UNOBSERVED CHECK IS NOT A PASS.** `ok` is three-valued: `true` asserted and holds,
 *   `false` asserted and does not, `null` **could not be observed here**. A check that
 *   silently degrades to green when its subject is absent is the defect this module exists
 *   to catch, wearing doctor's own hat — and the canary's rule applies verbatim: an absence
 *   is evidence only once something present has proved the observation was live. So
 *   `null` is loud in the report, named in the summary, and never counted as a pass.
 *   It does not on its own refuse the machine: doctor is usually run from a plain shell
 *   where the in-session readings genuinely cannot be taken.
 *
 *   **THEREFORE: NEVER `?? ''`, `?? 0` OR `|| ''` A PROBE RESULT.** The `?? 0` named above
 *   is not a historical curiosity — the same idiom shipped *here*, in the module that warns
 *   about it. `ghPrCreateHelp` read `tryRun('gh', …) ?? ''`, so `gh` absent from PATH, a
 *   non-zero exit and the 20 s timeout all collapsed to the empty string; the negation check
 *   found a string, extracted zero draft-negation flags from it, and reported **ok** —
 *   doctor certifying the draft-only guarantee on a help surface it never read. Measured:
 *   the real probe with an empty `PATH` returned `''`. A fallback turns "could not observe"
 *   into "observed nothing", and "observed nothing" is what most of these checks call
 *   health. The rule is one line either way: an unrunnable probe answers `null`, and its
 *   check answers `null`. See `tryRun` and `ghHelp` below.
 *
 * ---
 * WHAT THIS MODULE MUST NOT CLAIM, because a check that overstates is worse than none:
 *
 * - **The protected-ref class is NOT closed and doctor must not imply it is.** Measured
 *   routes that all landed `main` on a real remote *while these rules were in force*:
 *   `gh api --method PATCH …/git/refs/heads/main`, `git push "$(git remote get-url origin)"
 *   main`, `git push upstream main` (the rule anchors the literal word `origin`, so it is a
 *   remote-NAME anchor), `git send-pack`, `git push origin HEAD` while standing on `main`,
 *   partial quoting (`git push origin "ma"in`), and a git alias. The honest claim is
 *   "the named single-command paths are closed"; the class needs the PreToolUse gate plus
 *   the OS sandboxing the roadmap names. Same for the credential family.
 * - **Doctor reads TEXT.** A Claude Code release that changed its glob semantics would
 *   leave every rule assertion here green and every rule inert. That half belongs to the
 *   canary, which measures enforcement per version. The two are deliberate redundancy:
 *   doctor asserts presence across the life of a machine (drift, a hand edit, a generator
 *   regression), the canary asserts enforcement for one Claude Code version.
 * - **Doctor never executes what it denies.** The credential checks are asserted by putting
 *   SYNTHETIC command strings through the re-derived matcher. No keychain read, no
 *   credential file read, no push. Verifying a deny by performing it is not a test.
 *
 * ---
 * STDOUT. `formatDoctor`'s text goes to an injected writer that defaults to
 * `process.stdout`, because `soma doctor | tee` is what an operator does with a diagnostic.
 * That is the OPPOSITE default from `canary.mjs`, deliberately and with a live hazard: in
 * this system stdout is a JSON-RPC frame channel (`jsonrpc.mjs` writes one
 * `JSON.stringify(msg) + '\n'` per message), so **a caller running inside the bus process
 * must inject stderr**. Nothing here imports the bus and the bus has no reason to import
 * this, but the day one of those changes, this is the line that matters.
 *
 * Doctor also deliberately **does not capture stderr**: `config.loadConfig`'s
 * `dropLegacyKeys` writes a retired-key notice there once per process, and capturing it
 * would land the operator's notice inside doctor's own stream instead of on the terminal.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { SOMA_HOME, claudeConfigRoot, leadDir, p } from './paths.mjs';
import { loadConfig } from './config.mjs';
import { loadSeats, loggedIn, readSeatState, seatsPath } from './seats.mjs';
import { loadHarnesses } from './harness.mjs';
import { enumerateUserMcpServers, writeLeadSettings, writeWorktreeGuardrails } from './settings-gen.mjs';
// `buildLeadArgv` and `seatRoots` only — the lead's no-code ban is on argv now, and a check
// that cannot see the mechanism it names is the "reports health it never measured" shape; and
// the drift probe must enumerate from the seat list the spawner writes guard files from. Both
// are pure: importing the spawner does not make this read-only report able to start one.
import { buildLeadArgv, seatRoots } from './spawn.mjs';
import { tripPath } from './wd/budget.mjs';

/**
 * `.claude.json`'s absolute path for `home`/`env`.
 *
 * **TEMPORARY LOCAL DEFINITION.** This belongs beside `paths.claudeConfigRoot`, where a planned
 * consolidation is to add it; it is defined here rather than joined onto the root because the two
 * are NOT the same join. **The file sits BESIDE the default config dir and INSIDE an
 * overridden one** — measured: a run under `CLAUDE_CONFIG_DIR=<tmp>` created
 * `<tmp>/.claude.json`, while with the variable unset the live file is `$HOME/.claude.json`
 * and `$HOME/.claude/.claude.json` does not exist. So `join(claudeConfigRoot(env),
 * '.claude.json')` is wrong in the default case, which is the common one, and wrong in the
 * quiet direction: it names a file that is simply absent, so every read of it is an ENOENT
 * that a `catch { return [] }` turns into "this machine has no MCP servers".
 *
 * When that consolidation lands `paths.claudeConfigFile`, delete this and import it.
 */
const claudeConfigFile = (home, env) =>
  (env?.CLAUDE_CONFIG_DIR ? join(claudeConfigRoot(env), '.claude.json') : join(home, '.claude.json'));

/* ------------------------------------------------------------------ small predicates */

/**
 * Is `v` at least `min`, comparing dotted numeric components?
 *
 * Componentwise rather than lexicographic because `'3.10' < '3.9'` as strings and tmux is
 * on 3.x. A version that cannot be parsed answers **false**: the result feeds a gate, and
 * an unreadable reading is not evidence the floor is met. `tmux -V` prints `tmux 3.6a`, so
 * the numeric prefix of each component is what compares — `parseInt`, not `Number`, or
 * `'6a'` reads as `NaN` and collapses to 0.
 */
export const semverGte = (v, min) => {
  if (typeof v !== 'string') return false;
  const part = (s, i) => {
    const n = parseInt(String(s).split('.')[i], 10);
    return Number.isFinite(n) ? n : null;
  };
  if (part(v, 0) === null) return false;               // nothing numeric at all
  for (let i = 0; i < 3; i++) {
    const a = part(v, i) ?? 0;
    const b = part(min, i) ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
};

/** A uuid, case-insensitively — the shape of both `CLAUDE_CODE_SESSION_ID` and a hook's `session_id`. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v.trim());

/**
 * Claude Code's `Bash(...)` rule matching, re-derived from measurement.
 *
 * The same table `test/settings-gen.test.mjs` pins, carried here so doctor can assert what
 * the rules DO rather than which strings are present — a doctor that hard-codes rule
 * strings drifts the moment a protected branch is added, since twenty of them are
 * generated. Two copies exist on purpose (each independently pinned to the measurements in
 * its own test); they must not disagree.
 *
 * Established live against claude 2.1.220, every verdict classified from the Bash
 * `tool_result` string and never from the effect — a first pass that classified by effect
 * produced **12 false DENIEDs**, because the model refused legal commands and a refusal
 * leaves no ref behind either:
 *
 *   - inside `Bash(...)`, `*` is "any run of characters"; everything else is literal.
 *     Braces are NOT alternation and the command is NOT shell-unquoted.
 *   - matching is PER SEGMENT on BOTH SIDES, and a wildcard does not span a segment
 *     boundary (`Bash(echo a*echo z)` let `echo a && echo z` RUN).
 *   - whitespace insensitivity is **conditional on the rule containing a `*`**: a rule with
 *     none is compared to the raw segment, so a doubled space defeats it. Every `Bash(...)`
 *     rule the generator ships contains one, which is now an enforced invariant and is
 *     checked below.
 *
 * TWO CORRECTIONS ON TOP OF THAT, both measured after the table above was recorded:
 *
 *   1. **A NEWLINE SEGMENTS TOO**, and it was absent from the recorded set (`;` `&&` `||`
 *      `|` `&`). Measured DENIED twice, once against a shipped rule. A checker built from
 *      the recorded five predicts ALLOW for a protected push on LINE 2.
 *   2. **The quantifier over the RULE's own segments is `every`, not `some`.** `Bash(echo
 *      one && echo two)` was measured denying `echo one && echo two` — which needs both its
 *      segments matched — and nothing was ever measured saying it also denies `echo one`
 *      alone. Inert today (no shipped rule body contains a separator, re-verified), but the
 *      direction matters: `some` OVER-predicts DENY, and over-predicting DENY in a safety
 *      checker is a false OK.
 */
const SEGMENT_RE = /&&|\|\||[;|&\n]/;
const segmentsOf = (s) => String(s).split(SEGMENT_RE).map((seg) => seg.trim()).filter(Boolean);
const squeeze = (s) => s.replace(/\s+/g, ' ');

const segmentMatches = (ruleSeg, cmdSeg) => {
  if (!ruleSeg.includes('*')) return ruleSeg === cmdSeg;
  const rx = squeeze(ruleSeg).split('*').map((lit) => lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${rx}$`, 's').test(squeeze(cmdSeg));
};

/** Would the single rule `rule` refuse `cmd`? Non-`Bash(...)` rules are not command rules. */
export const bashRuleMatches = (rule, cmd) => {
  if (typeof rule !== 'string') return false;
  const body = /^Bash\((.*)\)$/s.exec(rule)?.[1];
  if (body === undefined) return false;
  const ruleSegs = segmentsOf(body);
  const cmdSegs = segmentsOf(cmd);
  // The length guard is what stops a body that is empty or all separators from vacuously
  // denying every command there is — `[].every()` is `true`.
  return ruleSegs.length > 0 && ruleSegs.every((r) => cmdSegs.some((c) => segmentMatches(r, c)));
};

/** Would this rule list refuse `cmd`? */
export const deniesCommand = (rules, cmd) => Array.isArray(rules) && rules.some((r) => bashRuleMatches(r, cmd));

/* -------------------------------------------------------------- the assertion tables */

/**
 * Synthetic commands that MUST be refused, and ordinary ones that must NOT be.
 *
 * Both directions, always. A deny list is judged on two failures and only one of them is a
 * leak: the other is a rule broad enough to refuse real work, which dead-ends a task with a
 * refusal that misdescribes itself as a policy hit. That happened on this build — ordinary
 * `soma/<task>` branches were unpushable for three rounds while the positive assertions
 * stayed green — so the control list is not decoration.
 *
 * NOTHING HERE IS EXECUTED. These are strings put through `bashRuleMatches`.
 */
export const CREDENTIAL_VECTORS = Object.freeze([
  'security find-generic-password -s "Claude Code-credentials" -w',
  '/usr/bin/security find-generic-password -w -s x',
  'sudo security dump-keychain -d',
  'security find-internet-password -s github.com',
  'keyring get claude token',
  'secret-tool lookup service claude',
  'pass show personal/aws',
  'gpg --decrypt secrets.gpg',
  'gpg -d secrets.gpg',
  'echo start && security find-generic-password -w -s x',
  'cat ~/.aws/credentials',
  'head -5 /Users/o/.aws/credentials',
  'cat ~/.aws/sso/cache/abc.json',
  'cat ~/.ssh/id_ed25519',
  'xxd ~/.ssh/id_rsa | head',
  'cat ~/.netrc',
  'grep oauth_token ~/.config/gh/hosts.yml',
  'cat ~/.docker/config.json',
  'cat ~/.claude/.credentials.json',
  'cat ~/.claude-work/.credentials.json',
  'sqlite3 ~/Library/Cookies/Cookies.binarycookies .dump',
  'cp "$HOME/Library/Application Support/Google/Chrome/Default/Cookies" /tmp/c',
  'sqlite3 ~/.mozilla/firefox/x.default/cookies.sqlite "select * from moz_cookies"',
  'strings "/Users/o/Library/Application Support/Google/Chrome/Default/Login Data"',
  // The rest of this table exists so that EVERY credential rule is individually
  // load-bearing. Measured: with the obvious vectors only, deleting any ONE of 35 Bash rules
  // left doctor green, because two overlapping rules both caught the same vector and neither
  // was therefore detectable on its own. Each line below is a command that exactly one rule
  // refuses, so a "tidy the deny list" edit cannot remove a rule silently.
  'security list-keychains',                          // only Bash(security *)
  '/usr/bin/security list-keychains',                 // only Bash(*/security *)
  'sudo security find-generic-password -w -s x',           // only Bash(*find-generic-password*)
  'sudo security find-internet-password -s github.com',
  'sudo security find-certificate -a -p',
  '/opt/homebrew/bin/keyring get a b',                // only Bash(*/keyring *)
  '/usr/bin/secret-tool lookup a b',
  '/usr/local/bin/pass show x',
  'gpg secrets.gpg -d',                               // only Bash(gpg*-d), the end-anchored form
  '/usr/bin/gpg --decrypt secrets.gpg',
  'ls ~/Library/Cookies/',                            // only Bash(*Library/Cookies*)
  'cp /tmp/Cookies.binarycookies /tmp/y',
  'cp /tmp/cookies.sqlite /tmp/y',
  'cp "$HOME/.config/Chromium/Default/Cookies" /tmp/c',
  'ls ~/.mozilla/firefox',
  'rm -rf .claude/settings.local.json',               // the guard file protects itself
  'mv .claude/settings.local.json /tmp/x',
]);

export const CREDENTIAL_CONTROLS = Object.freeze([
  'securityscan --help', 'npm run pass', 'cat src/Cookies.tsx', 'cat app/cookies.ts',
  'ls ~/.ssh', 'cat package.json', 'gpg --list-keys', 'gh auth status',
  'cat .npmrc', 'cat ~/.kube/config', 'cat docs/aws/credentials-design.md',
]);

/**
 * The `Read(...)` half, which no `Bash(...)` rule can reach — the Read tool has no command
 * string. **THIS LIST IS LOAD-BEARING AND IT IS FENCED; both halves of that matter.**
 *
 * It shipped holding SEVEN of the thirteen rules `settings-gen` writes, and
 * `settings-gen.test.mjs` pinned the same seven — so the six browser cookie and
 * saved-password rules were pinned by nothing at all, and **deleting `Read(~/.mozilla/**)`
 * left the whole suite green.** A hardcoded list wearing a better name, on the one surface no
 * `Bash(...)` rule reaches: `Bash(cat*credentials*)` loses to `head`, `less` and `python`, so
 * for a credential file at rest the `Read` rule is the half that carries the weight.
 *
 * Two properties now hold, and NEITHER of them is "the list is longer":
 *
 *   1. **Every rule here is load-bearing.** Delete any single `Read(...)` rule from
 *      `settings-gen` and `credential-store Read() denies` flips true → false. Measured
 *      per rule, not asserted as a set (`test/doctor.test.mjs`, the Read fence).
 *   2. **The list cannot silently drift from the generator.** A test compares it against the
 *      `Read(...)` rules of the real generated guard file, so a rule added to `settings-gen`
 *      tomorrow WITHOUT coverage reddens the suite instead of quietly joining the six.
 *
 * Why it stays hardcoded rather than derived from the generator: doctor's subject on a cold
 * machine IS the generator's output, so a list read out of that output would assert that
 * `settings-gen` agrees with itself — vacuous exactly where a generator regression is
 * cheapest to catch. This list is the independent witness; the fence keeps it honest.
 */
export const CREDENTIAL_READ_RULES = Object.freeze([
  'Read(~/.aws/**)', 'Read(~/.ssh/**)', 'Read(~/.netrc)', 'Read(~/.config/gh/**)',
  'Read(~/.docker/config.json)', 'Read(~/.claude/.credentials.json)', 'Read(~/.claude*/.credentials.json)',
  // The credential-at-rest class this family was added for, and the half that had no coverage
  // on either surface. A browser cookie jar is a live session for every site the operator is
  // logged into, and a Chrome "Login Data" file is the saved-password store itself.
  'Read(~/Library/Cookies/**)',
  'Read(~/Library/Application Support/**/Cookies*)',
  'Read(~/Library/Application Support/**/Login Data*)',
  'Read(~/.mozilla/**)',
  'Read(~/.config/google-chrome/**)',
  'Read(~/.config/chromium/**)',
]);

/** Every one of these reached a protected branch, a force or a delete in a live run. */
export const PROTECTED_VECTORS = Object.freeze([
  'git push origin main', 'git push origin develop', 'git push -u origin main',
  'git push origin HEAD:main', 'git push origin +HEAD:develop', 'git push origin soma/task-x:main',
  'git push origin +main', 'git push origin refs/heads/main', "git push origin 'main'",
  'git push origin "develop"', 'git push origin --delete main', 'git push -d origin main',
  'git push --all origin', 'git push --mirror origin', 'git push --force origin soma/task-x',
  'git push origin soma/task-x -f', 'git push origin  main',
  'cd /repo\ngit push origin main',                       // the newline correction, on a real rule
  'git add -A && git commit -m x && git push origin main',
  'gh api --method PATCH /repos/o/r/git/refs/heads/main -f sha=abc',
  'gh api --method PUT /repos/o/r/contents/x.txt -f branch=main',
  'gh pr create --title t --body b', 'gh pr merge 1', 'gh pr ready 1',
  // …and the same completeness pass as the credential table above: one vector per rule that
  // no other rule catches, so no protected-ref rule can be deleted with doctor green.
  'gh pr edit 1 --add-label x',
  'gh api --method PUT /repos/o/r/pulls/1/merge',
  'gh api --method POST /repos/o/r/merges -f base=x -f head=y',   // only Bash(gh api */merge*)
  'gh api --method POST /repos/o/r/pulls -f draft=false',
  'git push origin main --tags',                       // the `<branch> ` boundary form
  'git push origin HEAD:main -v',
  'git push origin +main -v',
  'git push origin refs/heads/main -v',
  'git push origin "main"',
  'git push origin develop --tags',
  'git push origin HEAD:develop -v',
  'git push origin +develop',
  'git push origin +develop -v',
  'git push origin refs/heads/develop',
  'git push origin refs/heads/develop -v',
  "git push origin 'develop'",
  'git push -d origin soma/task-x',                   // the declared -d/-f over-reach, pinned
  'git push origin soma/task-x -d',
  'git push -f origin soma/task-x',
]);

/** …and the pushes a teammate actually needs, which must all still run. */
export const PROTECTED_CONTROLS = Object.freeze([
  'git push origin soma/task-x', 'git push -u origin soma/task-x', 'git push origin soma/fix-main-nav',
  'git push origin soma/developer-docs', 'git push origin mainline', 'git push origin maintenance',
  'git push origin soma/remain', 'git push origin HEAD:soma/main-menu',
  'git add -A && git commit -m x && git push origin soma/task-x',
  'gh pr view 1', 'gh api /repos/cli/cli --jq .name', 'git ls-remote origin refs/heads/main',
]);

/**
 * The three write tools the lead's ban is made of — **doctor's own spelling of them**.
 *
 * Deliberately a second, independent statement rather than a re-export of
 * `spawn.BANNED_TOOLS`. Both checks that use it judge soma's real output against THIS list,
 * so shortening `BANNED_TOOLS` reddens `lead edit ban on argv` instead of moving both sides
 * of the comparison at once — a comparison of a constant with itself is the "check that
 * cannot fail" shape this module has already had to remove twice. `test/doctor.test.mjs`
 * pins the two spellings equal, which is where an intentional change to the ban is declared.
 *
 * Sorted, because the file check reports them and a stable order keeps the detail readable.
 */
export const LEAD_BANNED_TOOLS = Object.freeze(['Edit', 'NotebookEdit', 'Write']);

/**
 * The servers a lead's `mcp.json` may name — **doctor's own spelling of them**, for the
 * reason `LEAD_BANNED_TOOLS` is one: a re-export of what `settings-gen.writeLeadMcpConfig`
 * writes would let a third server join both sides of `lead mcp single-server` at once.
 * `test/doctor.test.mjs` pins this list equal to the servers the generator really writes,
 * which is where adding one is declared. `soma` is the lead's own bus; `sequential-thinking`
 * is stateless and carries no credential (`writeLeadMcpConfig` says why that clears the
 * recursion guard).
 *
 * Sorted, because the check compares a sorted copy of what it read against it.
 */
export const LEAD_MCP_SERVERS = Object.freeze(['sequential-thinking', 'soma']);

/**
 * The published check names, in report order.
 *
 * A contract, like `canary.INVARIANTS`: the runbook and `soma up` quote them, and renaming
 * one is a breaking change rather than a tidy-up. Frozen because a consumer that spliced
 * this list would be editing the preflight. Per-repo rows are appended after these.
 */
export const CHECKS = Object.freeze([
  'node>=24',
  'tmux>=3.2',
  'git>=2.31',
  'claude auth',
  'claude cd-compound read runs',
  'gh auth',
  'workflows enabled',
  'notifier',
  'SOMA_HOME absolute',
  'claude config root',
  '.claude.json location',
  'mcp enumeration readable',
  'lead settings readable',
  'worktree guard file readable',
  'every worktree guard file carries rules',
  'lead mcp single-server',
  'no orch soma in user scope',
  "lead PreToolUse matcher '*'",
  "worktree PreToolUse matcher '*'",
  'lead PreToolUse command runs the gate',
  'worktree PreToolUse command runs the gate',
  'no edit ban in settings files',
  'lead edit ban on argv',
  'guard file self-protect',
  'no inert Write() rule',
  'every Bash rule keeps a wildcard',
  'guard file matches the generator',
  'mcp deny drift',
  'mcp deny mcp__claude_ai_*',
  'mcp deny mcp__plugin_*',
  'credential-store command denies',
  'credential-store Read() denies',
  'protected-ref single-command paths',
  'harness registry',
  'gh pr create --draft',
  'gh pr create draft negation',
  'lead PATH node vs engines.node',
  'CLAUDE_CODE_SESSION_ID',
  'session id matches hook payload',
  'budget flag path',
  'state scratch files',
  'lead auto-continue floor',
  'seats readable',
  'every seat logged in',
  'seat projects is the shared tree',
  'mcp enumeration covers every seat',
  'seat pool state readable',
  'repos readable',
]);

/* ------------- the cd-compound probe (a Claude Code build that prompts under bypass) */

/**
 * Claude Code 2.1.259 shipped a bypass-immune safety check that raised a permission prompt on
 * `cd <dir> && <one of these verbs> <relative operand>` whenever any `Read()` deny rule existed.
 * Leads carry 13 such rules and nobody sits at their pane, so 79 sessions sat on that prompt for
 * 214 hours (measured over 179 transcripts; the worst 40.3 h). 2.1.263 removed the check.
 * `tested_claude` admitted 2.1.259 because it passes patch releases by design — a version number
 * cannot say "this build prompts", and a measurement can: `defaultProbes().cdCompoundRead` runs
 * the exact shape once, with haiku, in a throwaway cwd with a throwaway `--settings` carrying one
 * `Read()` deny, and `classifyCdCompoundProbe` reads the transcript into one of THREE states.
 *
 * The set is 2.1.259's own, verbatim; the gate's arm (e) mirrors it (`bin/hooks/lead-gate.mjs`).
 */
export const CD_COMPOUND_VERBS = Object.freeze(['grep', 'egrep', 'fgrep', 'rg', 'diff', 'git', 'cp', 'mv']);

/**
 * The shape the probe instructs, as the model must have KEPT it: a leading `cd` (or `pushd`), and a
 * later command from the set. Anchored at the start on purpose — a tool_use that begins with `grep`
 * is the measured trap, not the measurement: both haiku and sonnet silently delete a `cd` whose
 * target equals the cwd even when told byte-for-byte not to, and such a call proves nothing about
 * the compound the check exists to run. (The probe `cd`s to a SIBLING directory for that reason.)
 */
const CD_COMPOUND_SHAPE = new RegExp(String.raw`^\s*\(?\s*(?:cd|pushd)\s[\s\S]*?(?:&&|;|\|\||\||\n)\s*(?:${CD_COMPOUND_VERBS.join('|')})\b`);

/**
 * How an unanswerable prompt reads once `-p` has turned it into an `is_error` tool_result: the
 * 2.1.259 wording ("…parts require approval: cd …, grep …" / "only you can approve running it
 * anyway") and the generic "requested permissions" one. Deliberately NOT a bare /permission/ —
 * soma's own gate reasons contain that word, and a hook deny is not an ask.
 */
const CD_ASK_RE = /require approval|requested permissions|only you can approve/i;

/** A tool_result's `content` as one string — the SDK emits a plain string or an array of text blocks. */
const resultText = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '')).join('\n');
  return '';
};

/** One line, capped, for a detail: a tool_result can be a whole file listing. */
const excerpt = (s) => {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
};

/**
 * Read a stream-json transcript of the cd-compound probe into `{ran, why}`:
 *
 *   ran: true   — the FIRST cd-shaped Bash call has a tool_result carrying `1:x`: the compound RAN.
 *   ran: false  — that call was ASKED about: a `system`/`permission_denied` event names its
 *                 `tool_use_id`, or its tool_result text is a permission prompt (`CD_ASK_RE`).
 *   ran: null   — NOT OBSERVED: no events, no Bash tool_use, no tool_use that kept its `cd`, no
 *                 tool_result for it, or a result that is neither `1:x` nor a prompt (a grep that
 *                 failed for another reason, an empty result). Unproven, never a pass.
 *
 * Only the first cd-shaped call is judged, so a model that was denied and then retried WITHOUT
 * the `cd` cannot launder an ask into a pass through its second, cd-less call. Pure; never
 * throws for any input — a garbage transcript is `ran: null` with a reason, like `evaluateCanary`.
 */
export function classifyCdCompoundProbe(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return { ran: null, why: 'no stream-json events — claude did not start, or printed nothing parseable' };
  }
  const uses = [];
  const results = new Map();
  const denied = new Map();
  for (const e of events) {
    if (e === null || typeof e !== 'object') continue;
    const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
    if (e.type === 'assistant') {
      for (const b of blocks) {
        if (b?.type === 'tool_use' && b.name === 'Bash') uses.push({ id: b.id, command: typeof b.input?.command === 'string' ? b.input.command : '' });
      }
    } else if (e.type === 'user') {
      for (const b of blocks) {
        if (b?.type === 'tool_result' && !results.has(b.tool_use_id)) results.set(b.tool_use_id, { text: resultText(b.content), isError: b.is_error === true });
      }
    } else if (e.type === 'system' && e.subtype === 'permission_denied' && typeof e.tool_use_id === 'string') {
      denied.set(e.tool_use_id, typeof e.message === 'string' ? e.message : '');
    }
  }
  if (uses.length === 0) return { ran: null, why: 'no Bash tool_use in the transcript — the model never ran a command' };
  const shaped = uses.find((u) => CD_COMPOUND_SHAPE.test(u.command));
  if (!shaped) return { ran: null, why: `the model dropped the cd — no Bash call kept the \`cd … && grep\` shape (it ran: ${excerpt(uses[0].command)})` };
  const cmd = excerpt(shaped.command);
  if (denied.has(shaped.id)) return { ran: false, why: `Claude Code raised a permission prompt on \`${cmd}\`: ${excerpt(denied.get(shaped.id))}` };
  const r = results.get(shaped.id);
  if (!r) return { ran: null, why: `no tool_result for \`${cmd}\` — claude stopped before the tool returned` };
  if (CD_ASK_RE.test(r.text)) return { ran: false, why: `\`${cmd}\` came back is_error=${r.isError} with a permission prompt: ${excerpt(r.text)}` };
  if (/(^|\n)1:x\b/.test(r.text)) return { ran: true, why: `\`${cmd}\` ran and returned 1:x` };
  return { ran: null, why: `\`${cmd}\` returned neither 1:x nor a permission prompt (is_error=${r.isError}): ${excerpt(r.text) || '(empty)'}` };
}

/* ------------------------------------------------------------------------- machinery */

/**
 * One line of text for whatever a probe threw — the same total guard, for the same reason,
 * as `canary.reason` and `jsonrpc.mjs`'s: `e.message` on a `throw null` is itself a
 * TypeError, raised inside the handler that exists to stop a crash.
 */
const reason = (e) => {
  try {
    const m = e?.message;
    if (typeof m === 'string' && m !== '') return m;
    const s = String(e);
    return s === '' ? 'unknown error' : s;
  } catch {
    return 'unknown error';
  }
};

/** What arrived instead of an observation, for a detail line. Must never throw. */
const shown = (v) => {
  try {
    if (v === null) return 'null';
    if (typeof v === 'string') return JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}…` : v);
    if (typeof v === 'object') return Array.isArray(v) ? `an array of ${v.length}` : 'an object';
    return String(v);
  } catch {
    return 'an unprintable value';
  }
};

/**
 * Read one observation: `{got}`, `{failed}` (the probe threw) or `{absent}` (no probe).
 *
 * Plain property access rather than `Object.hasOwn` is safe here and only here: every key
 * passed in is a literal in this file, none of them is an `Object.prototype` name, and none
 * comes from data. The hazard `harness.mjs` and `config.mjs` guard against needs a key an
 * outsider chooses.
 */
const observe = (probe, key, ...args) => {
  const fn = probe === null || typeof probe !== 'object' ? undefined : probe[key];
  if (typeof fn !== 'function') return { absent: true };
  try {
    return { got: fn(...args) };
  } catch (e) {
    return { failed: reason(e) };
  }
};

/**
 * Evaluate every check against `probe` and return `[{name, ok, detail}]`.
 *
 * **A PROBE THAT THROWS BECOMES ONE FAILING LINE, never a stack trace.** Doctor is what an
 * operator runs when something is already wrong, so `enumerateUserMcpServers` on an
 * unreadable `.claude.json`, a wedged `git fetch` or a `tmux` that is not installed has to
 * cost ONE reading and leave every other one intact. A throw out of here loses the
 * whole report to fix one line of it. Covered: a probe that throws when CALLED, a throw of a
 * non-`Error` (`throw null`), a throwing `message` getter, and `undefined`/`null`/`42`/
 * `'nope'`/`[]` as the probe object or as `env`.
 *
 * **The claim is that, and not more.** An earlier version of this comment said "never
 * throws, for any `env` and any `probe`", and that is FALSE as stated — measured, 13 of 21
 * hostile inputs escape: a probe object whose property ACCESS throws (`observe`'s
 * `probe[key]` read sits outside its own `try`), a revoked `Proxy`, and a throwing
 * `Symbol.toPrimitive` or `ownKeys` reaching the `String()` coercions or `Object.keys(e)`
 * below. None is reachable from `defaultProbes()` or `process.env`, and hardening against a
 * hostile getter is not what this module is for — but an overclaim in the header of the
 * module that exists to refuse overstatement is how a real gap stays unfixed, so the claim
 * is scoped to what was measured rather than left total.
 *
 * `ok` is `true` / `false` / `null` (unobserved) — see the module header.
 *
 * Every boolean observation is compared `=== true`, never for truthiness. These readings
 * come off shell commands and environment variables, and both of those are strings:
 * `"false"` is truthy, and so are `"0"`, `[]` and `{}`. That exact mistake turned the
 * canary's sketch into a rubber stamp in the one case it exists for.
 */
export function checks(env, probe) {
  const e = env !== null && typeof env === 'object' ? env : {};
  const out = [];
  const push = (name, ok, detail) => { out.push({ name, ok, detail }); };

  /** Absent → unobserved; threw → FAIL naming the throw; otherwise `judge(value)`. */
  const check = (name, key, what, judge) => {
    const o = observe(probe, key);
    if (o.absent) return push(name, null, `${what} — not observed (no ${key} probe)`);
    if (o.failed) return push(name, false, `${what} — the ${key} probe threw: ${o.failed}`);
    const [ok, detail] = judge(o.got);
    return push(name, ok, detail);
  };

  /** A strict-`true` boolean observation. `null` from the probe means "cannot be observed". */
  const boolCheck = (name, key, what) => check(name, key, what, (got) => {
    if (got === null) return [null, `${what} — not observable on this machine`];
    return [got === true, `${what} — ${got === true ? 'yes' : `got ${shown(got)}`}`];
  });

  // --- the things that strand a run outright -------------------------------------------
  check('node>=24', 'nodeMajor', 'node major version', (n) =>
    [typeof n === 'number' && n >= 24, `node ${shown(n)} (need >= 24)`]);
  check('tmux>=3.2', 'tmuxVersion', 'tmux version', (v) => [semverGte(v, '3.2'), `tmux ${shown(v)} (need >= 3.2)`]);
  check('git>=2.31', 'gitVersion', 'git version', (v) => [semverGte(v, '2.31'), `git ${shown(v)} (need >= 2.31)`]);
  boolCheck('claude auth', 'claudePing', 'claude -p smoke');
  // The cd-compound probe: does THIS Claude Code build stop a lead on
  // `cd <dir> && grep <relative>` under bypass? Three states, kept apart on purpose: RAN is the
  // pass, ASKED is the FAIL that says do not spawn leads on this build (or arm the gate's lever),
  // and NOT OBSERVED — claude could not run, the model dropped the cd, the grep failed for another
  // reason — is unobserved, never a pass. The transcript is judged by `classifyCdCompoundProbe`;
  // the probe only produces it.
  {
    const what = 'claude -p: `cd <other dir> && grep -n x y.txt` under --dangerously-skip-permissions with a Read() deny in force';
    check('claude cd-compound read runs', 'cdCompoundRead', what, (got) => {
      if (got === null) return [null, `${what} — not observable on this machine (claude could not be run)`];
      if (!Array.isArray(got)) return [false, `the cdCompoundRead probe returned ${shown(got)}, not an array of stream-json events`];
      const c = classifyCdCompoundProbe(got);
      if (c.ran === true) return [true, `${what} — ran: ${c.why}`];
      if (c.ran === false) {
        return [false, `${what} — ASKED: ${c.why}. This build stops unattended leads on an unanswerable permission prompt (2.1.259 did, 79 sessions for 214 hours; 2.1.263 does not). Do not spawn leads on it; if the fleet must keep running on it, arm the gate's lever per lead with \`touch $SOMA_HOME/leads/<id>/CD_COMPOUND_ASKS\` and remove the flag once the lead is on a fixed build`];
      }
      return [null, `${what} — not observed: ${c.why}`];
    });
  }
  boolCheck('gh auth', 'ghAuth', 'gh auth status');
  // NOT defaulted to `true`. Whether dynamic workflows are enabled for a spawned lead is a
  // named bring-up experiment that no local file answers, so the honest reading is
  // "unobserved" — and the sketch's `() => true` was a check that could not fail.
  boolCheck('workflows enabled', 'workflowsEnabled', 'dynamic workflows available to a spawned lead (design requirement 5)');
  check('notifier', 'notifier', 'desktop notifier', (n) => {
    if (n === null) return [null, 'desktop notifier — not observable on this machine'];
    const ok = n !== null && typeof n === 'object' && n.ok === true;
    return [ok, `desktop notifier — ${typeof n?.detail === 'string' ? n.detail : shown(n)}`];
  });

  // --- the two roots, and the file that is beside one and inside the other -------------
  check('SOMA_HOME absolute', 'somaHome', 'state root', (root) =>
    [typeof root === 'string' && isAbsolute(root), `state root ${shown(root)}`]);

  const cfg = observe(probe, 'claudeConfig');
  const cfgOk = !cfg.absent && !cfg.failed && cfg.got !== null && typeof cfg.got === 'object';
  if (cfg.absent) push('claude config root', null, 'claude config root — not observed (no claudeConfig probe)');
  else if (cfg.failed) push('claude config root', false, `claude config root — the claudeConfig probe threw: ${cfg.failed}`);
  else if (!cfgOk) push('claude config root', false, `claude config root — got ${shown(cfg.got)}`);
  else {
    const { root, override, rootExists } = cfg.got;
    const how = override === true ? 'CLAUDE_CONFIG_DIR override active' : 'default, no CLAUDE_CONFIG_DIR';
    // A root that does not exist is the measured silent-zero defect: a stale `~/.claude`
    // usually still exists, so nothing throws, no session uuid matches inside it, every
    // lead reads as 0 tokens, and the budget breaker never trips.
    push('claude config root', rootExists === true,
      `${root} (${how})${rootExists === true ? '' : ' — does not exist, so every transcript lookup reads zero'}`);
  }
  if (!cfgOk) push('.claude.json location', cfg.failed ? false : null, '.claude.json — the config root was not read');
  else {
    const { home, root, file, override } = cfg.got;
    const want = override === true ? join(String(root), '.claude.json') : join(String(home), '.claude.json');
    const where = override === true ? 'INSIDE an overridden root' : 'BESIDE the default root';
    push('.claude.json location', file === want,
      file === want ? `${file} — ${where}, as measured` : `${file} — expected ${want}: it belongs ${where}`);
  }

  // --- the personal-MCP boundary -------------------------------------------------------
  const servers = observe(probe, 'mcpServers');
  if (servers.absent) push('mcp enumeration readable', null, 'user + local + plugin MCP scopes — not observed (no mcpServers probe)');
  else if (servers.failed) {
    // A real finding, not a zero: an unreadable `.claude.json` means every spawn writes a
    // guard file with no personal denies in it, which is the whole secrets boundary.
    push('mcp enumeration readable', false, `MCP enumeration failed, so guard files deny no personal server: ${servers.failed}`);
  } else if (!Array.isArray(servers.got)) push('mcp enumeration readable', false, `MCP enumeration returned ${shown(servers.got)}`);
  else push('mcp enumeration readable', true, `${servers.got.length} MCP servers across both config roots and every seat (user + local + plugin)`);

  /**
   * The two settings files, each as `{live, reference}` — and the SUBJECT is `live ??
   * reference`.
   *
   * The fallback is not a convenience, it is what makes doctor useful on a COLD MACHINE.
   * Measured on this one: with no lead and no worktree yet, an implementation that read only
   * the live files reported **twelve** checks unobserved — every rule-shaped one, including
   * the credential family, both PreToolUse matchers and the two account-side wildcards. That
   * is the run an operator makes on a fresh install, i.e. exactly when a generator
   * regression is cheapest to catch and doctor was blind to it.
   *
   * `reference` is what `settings-gen` produces RIGHT NOW, so asserting against it is a
   * statement about every file the next spawn will write. `live` is what a teammate in an
   * existing worktree actually inherits, so it is preferred when it exists — a hand edit or
   * a worktree written before a rule landed is a real finding that the generator cannot
   * show. `guard file matches the generator` is the check that compares the two.
   */
  const pair = (key) => {
    const o = observe(probe, key);
    if (o.absent) return { absent: true };
    if (o.failed) return { failed: o.failed };
    const v = o.got;
    // `!Array.isArray`, not just `typeof === 'object'`. An array passes a bare typeof test,
    // has no `permissions`, and so was accepted as a readable settings file while every
    // content check went unobserved — a readable-check saying `ok` about something nothing
    // could read, which is the exact shape this module exists to refuse. Found by mutation.
    const obj = (x) => (x !== null && typeof x === 'object' && !Array.isArray(x) ? x : null);
    if (obj(v) === null) return { bad: shown(v) };
    const live = obj(v.live);
    const reference = obj(v.reference);
    // A path that EXISTS but did not parse is its own finding, and it must not collapse into
    // "no live file yet". Without this field a corrupt guard file in a live worktree read
    // exactly like a cold machine: doctor fell back to the generated reference, reported it
    // healthy, and every teammate in that worktree had NO guardrails at all. Found by
    // mutation, and it is the module's own failure shape — a green report over a broken file.
    const broken = typeof v.brokenPath === 'string' && v.brokenPath !== '' ? v.brokenPath : null;
    return { live, reference, broken, subject: live ?? reference, source: live ? 'live' : reference ? 'generated' : null };
  };
  const readable = (name, what, r) => {
    if (r.absent) return push(name, null, `${what} — not observed`);
    if (r.failed) return push(name, false, `${what} — ${r.failed}`);
    if (r.bad !== undefined) return push(name, false, `${what} — got ${r.bad}`);
    if (r.broken) return push(name, false, `${what} — ${r.broken} EXISTS but does not parse as a settings object, so everything reading it from cwd has no rules at all`);
    if (r.subject === null) return push(name, false, `${what} — neither a live file nor a generated reference`);
    return push(name, true, r.source === 'live'
      ? `${what} — read from the live file a teammate inherits`
      : `${what} — no live file yet, so the checks below judge what settings-gen would write NOW`);
  };

  const lead = pair('leadSettings');
  readable('lead settings readable', 'leads/<id>/settings.json', lead);
  const leadJson = lead.subject ?? null;

  const guard = pair('guardFile');
  readable('worktree guard file readable', '<worktree>/.claude/settings.local.json', guard);
  const guardJson = guard.subject ?? null;

  /**
   * Every worktree, not just the newest — is its guard file THERE, and does it carry rules?
   *
   * The check above reads ONE file (the newest, which is what the next teammate inherits) and
   * every content check below judges that one. This one asks the cheaper question of ALL of
   * them, because the two ways a guard file stops existing are invisible to everything else:
   *
   *   - **`.claude/` is ignored by design** (`.claude/.gitignore` holds `*`), so
   *     `git clean -fdx` deletes it, `git status` says nothing, and the worktree keeps running
   *     teammates with no rules at all. That hazard is general, not this module's: it has bitten
   *     an ignored-by-design directory on this build before.
   *   - **An EMPTIED guard file fails OPEN.** Measured: in a cwd whose guard file was zero
   *     bytes, a probe MCP server loaded and fired. `{}` and `{"permissions":{"deny":[]}}` are
   *     the same fail-open with more bytes, so the reading is "how many deny rules", not "how
   *     many bytes" — bytes are reported too, because 0 is the spelling an operator recognises.
   *
   * No worktree at all is UNOBSERVED, not a pass: `[].every()` is `true`, and a vacuous truth
   * reported as health is the trap `bashRuleMatches` already guards against one screen up.
   */
  check('every worktree guard file carries rules', 'worktreeGuards', 'each worktree .claude/settings.local.json', (list) => {
    if (list === null) return [null, 'each worktree .claude/settings.local.json — no worktrees/ directory yet, so there is no guard file to find'];
    if (!Array.isArray(list)) return [false, `each worktree .claude/settings.local.json — the worktreeGuards probe returned ${shown(list)}`];
    if (list.length === 0) return [null, 'each worktree .claude/settings.local.json — 0 worktrees exist, so this asserts nothing (an empty list passes vacuously, which is not evidence)'];
    const name = (w) => (typeof w?.worktree === 'string' ? w.worktree : shown(w));
    const gone = list.filter((w) => w?.bytes === null || w?.bytes === undefined);
    const empty = list.filter((w) => w?.bytes === 0 || !(Number.isInteger(w?.rules) && w.rules > 0));
    if (gone.length) return [false, `${gone.length}/${list.length} worktrees have NO .claude/settings.local.json: ${gone.slice(0, 3).map(name).join(', ')} — .claude/ is gitignored by design, so git clean -fdx removes it silently and every teammate in that worktree runs with no rules`];
    if (empty.length) return [false, `${empty.length}/${list.length} worktrees carry a guard file with NO deny rules (${empty.slice(0, 3).map((w) => `${name(w)} — ${w?.bytes} bytes, ${shown(w?.rules)} rules`).join('; ')}) — an emptied guard file fails OPEN: measured, an MCP server loaded and fired in a zero-byte-guard cwd`];
    const least = list.reduce((a, w) => (w.rules < a.rules ? w : a));
    return [true, `${list.length} worktree(s), each carrying a guard file with deny rules (fewest: ${least.rules} rules / ${least.bytes} bytes in ${name(least)})`];
  });

  const deny = Array.isArray(guardJson?.permissions?.deny) ? guardJson.permissions.deny : null;
  const allow = Array.isArray(guardJson?.permissions?.allow) ? guardJson.permissions.allow : [];
  const src = guard.source === 'live' ? '' : ' [generated reference]';
  /** Judge a guard-file property, or report it unobserved when there was no guard file. */
  const guardCheck = (name, what, judge) => {
    if (deny === null) return push(name, null, `${what} — no guard file was read`);
    const [ok, detail] = judge(deny);
    return push(name, ok, `${detail}${src}`);
  };

  // --- the recursion guard -------------------------------------------------------------
  // The row's name predates the second server and stays, because CHECKS is a published
  // contract. What it judges is the SET of names: exactly LEAD_MCP_SERVERS in any order, so a
  // server missing, added or duplicated FAILs. Names only — what a server runs is not read here.
  check('lead mcp single-server', 'leadMcpServers', "the lead's whole MCP surface", (names) => {
    if (names === null) return [null, "the lead's MCP surface — no lead exists yet, so there is nothing to read"];
    if (!Array.isArray(names)) return [false, `the lead's MCP surface — got ${shown(names)}`];
    const got = [...names].sort();
    const ok = got.length === LEAD_MCP_SERVERS.length && got.every((n, i) => n === LEAD_MCP_SERVERS[i]);
    return [ok, `lead mcp.json serves ${names.length ? names.join(', ') : '(nothing)'} — must be exactly ${LEAD_MCP_SERVERS.map((n) => `"${n}"`).join(' and ')}, in any order: another server could reach an orchestrator bus, and a lead that reaches one can spawn leads`];
  });
  /**
   * `{servers, unreadable}`, and the second field is why the shape is an object.
   *
   * The probe reads both `.claude.json` candidates. It used to swallow every read error to
   * `null`, `continue`, and answer `[]` — so an unreadable or unparseable `~/.claude.json`
   * reported **`ok  no soma bus in user scope`**: the recursion guard treating an absence as
   * evidence, on a check whose whole subject is a file it could not open. Same mechanism as
   * the `?? ''` in the module header, one spelling along. An ARRAY is refused rather than read
   * as "nothing unreadable", because a silent "nothing unreadable" is the defect itself.
   */
  check('no orch soma in user scope', 'userScopeSomaServers', 'user-scope soma servers', (got) => {
    if (got === null || typeof got !== 'object' || Array.isArray(got) || !Array.isArray(got.servers)) {
      return [false, `user-scope soma servers — the userScopeSomaServers probe returned ${shown(got)}, not {servers, unreadable}`];
    }
    const found = got.servers;
    const unreadable = Array.isArray(got.unreadable) ? got.unreadable : [];
    const read = Array.isArray(got.read) ? got.read : [];
    if (found.length) {
      // Not one finding — three. `soma init` DELIBERATELY registers the bus at user scope:
      // that is how a promoted operator session drives the fleet at all. A lead never
      // inherits user scope (`--strict-mcp-config` plus an mcp.json of exactly `soma` and
      // `sequential-thinking`, asserted one row up), and a teammate that discovers this bus
      // holds the role-less CANDIDATE surface, which the gate's bus arm denies to every
      // non-lead session. So the registration init writes, with its state root pinned, is
      // EXPECTED — and this check FAILing on it taught the operator to skim past the row,
      // which is how a real finding here would have died. What stays a finding:
      //   - a PIN-LESS registration: a promoted session then drives whatever root its own
      //     environment resolves — the measured wrong-fleet failure `soma init` was fixed for;
      //   - a soma-shaped server that does not run soma's own bus, which nothing audited.
      const entry = (s) => (s !== null && typeof s === 'object' && typeof s.name === 'string'
        ? s : { name: shown(s), runsBus: false, root: null });
      const detailed = found.map(entry);
      const foreign = detailed.filter((s) => s.runsBus !== true);
      if (foreign.length) {
        return [false, `user scope carries ${foreign.map((s) => s.name).join(', ')} — soma-shaped but not running soma's own bus (soma-bus.mjs), so it is not the registration \`soma init\` writes and nothing has audited what it serves`];
      }
      const unpinned = detailed.filter((s) => typeof s.root !== 'string' || s.root === '');
      if (unpinned.length) {
        return [false, `user scope carries ${unpinned.map((s) => s.name).join(', ')} with NO SOMA_HOME pinned into the registration — a promoted operator session would drive whatever state root its own environment resolves, which is the measured wrong-fleet failure. Re-run \`soma init\` to pin the root`];
      }
      const here = observe(probe, 'somaHome');
      const root = !here.absent && !here.failed && typeof here.got === 'string' ? here.got : null;
      const elsewhere = root === null ? [] : detailed.filter((s) => resolve(String(s.root)) !== root);
      if (elsewhere.length) {
        return [true, `user scope carries ${elsewhere.map((s) => `${s.name} (pinned to ${s.root})`).join(', ')} — soma's own bus registration, but for a different state root than this run inspects (${root}), so it drives that fleet and cannot hand this one to anybody. Expected on a machine with more than one root; if it is stale, re-run \`soma init\` under the root you mean`];
      }
      return [true, `user scope carries ${detailed.map((s) => s.name).join(', ')} — the bus registration \`soma init\` writes (runs soma-bus.mjs${root ? `, SOMA_HOME pinned to this state root ${root}` : ', SOMA_HOME pinned'}). Expected: a promoted operator session drives this fleet through it, a lead never inherits user scope (--strict-mcp-config), and the gate denies the bus to every non-lead session in a worktree`];
    }
    // Absence is evidence only once the read is known to have happened. A file that is simply
    // NOT THERE is a live reading (it defines no servers); a file that is there and would not
    // open is not, and the two used to be the same `[]`.
    if (unreadable.length) return [null, `no soma bus found, but ${unreadable.join(', ')} could not be read — so "no soma in user scope" was not observed here, it was assumed`];
    return [true, read.length === 0
      ? 'no soma bus in user scope: neither .claude.json candidate exists, so no user scope defines a server for a lead to inherit'
      : `no soma bus in user scope in the ${read.length} config file(s) read (${read.join(', ')}) — a lead would inherit one and could spawn leads`];
  });

  // --- both PreToolUse matchers -------------------------------------------------------
  /**
   * A narrowed matcher is invisible every other way: the hook is still in the file and its
   * command still points at a script that exists. Measured consequences of the two wrong
   * values — lead settings under `'Bash'` left `Task` (where most spend goes) outside the
   * budget breaker; the worktree file under the three Edit tools left teammates' Bash
   * unhooked, and a real bypassed teammate emptied its own guard file with `tee`.
   */
  const matcherCheck = (name, json, what) => {
    if (json === null) return push(name, null, `${what} PreToolUse matcher — no file was read`);
    const entries = json.hooks?.PreToolUse;
    if (!Array.isArray(entries) || entries.length === 0) {
      return push(name, false, `${what} has no PreToolUse entry at all — the gate is never consulted`);
    }
    const bad = entries.filter((h) => h?.matcher !== '*').map((h) => shown(h?.matcher));
    return push(name, bad.length === 0, bad.length === 0
      ? `${what} PreToolUse matcher '*' on ${entries.length} entry/entries — the gate is asked about every tool`
      : `${what} PreToolUse matcher is ${bad.join(', ')}, not '*' — a hook that is not consulted denies nothing`);
  };
  matcherCheck("lead PreToolUse matcher '*'", leadJson, 'lead settings');
  matcherCheck("worktree PreToolUse matcher '*'", guardJson, 'worktree guard file');

  // --- The matcher is half the registration. This is the other half. -------------------
  /**
   * ⚠ **NOTHING IN DOCTOR EVER READ A HOOK'S COMMAND, AND THE HEADER CLAIMED IT DID.**
   *
   * `matcherCheck` above reads `matcher` and nothing else, then prints "the gate is asked
   * about every tool" — a claim about *consultation* it did not observe. Measured before
   * this check existed: **three separate spellings of a wholly inert gate** — a command
   * pointing at a script that does not exist, `hooks: []` with the matcher intact, and
   * `command: "true"` (which allows everything) — applied to **both** files, each produced
   * `doctor: PASS — all 39 checks hold` with **zero** rows moving. In that same green
   * report the credential and protected-ref rows defer their residual class *to the gate
   * those two rows had just certified without observing*. The module header at `:16` even
   * asserts the wrong half: "still in the file *and its command still points at a script
   * that exists*". Only the matcher was.
   *
   * Nothing else covered it. `guard file matches the generator` diffs `permissions.deny`
   * and `permissions.allow` only — the `hooks` block is outside the comparison. `budget
   * flag path` reads `lead-gate.mjs` through doctor's own module URL, so it confirms the
   * script exists in the *install* and never that the settings file points at it. And
   * `canary.mjs` has no gate invariant at all, so the redundancy the header claims for it
   * does not hold.
   *
   * **AND IT WAS WHY THE TWO-REGISTRATION DEFECT SHIPPED WITH NO DETECTOR.** A check that
   * verifies a hook is registered but not *how it is invoked* could not see a missing
   * `--session-guard` — the argument that switched on the gate's session-discriminated edit
   * arm, back when the lead was edit-banned. That arm is retired and the flag with it, so this
   * check no longer requires or counts any argument: what it still owes the operator is that
   * every registration RUNS the real gate, from a script that is really on disk. Registrations
   * written before the retirement may still carry the flag; the gate ignores argv it does
   * not know, and so does this check.
   */
  /**
   * The command's words, with POSIX single-quoting undone — the generators build these with
   * `shq`, so the script path arrives quoted and may legitimately contain a space.
   */
  const shTokens = (cmd) => {
    const out = [];
    const re = /'((?:[^']|'\\'')*)'|"([^"]*)"|(\S+)/g;
    for (let m = re.exec(cmd); m !== null; m = re.exec(cmd)) {
      out.push(m[1] !== undefined ? m[1].replaceAll("'\\''", "'") : m[2] !== undefined ? m[2] : m[3]);
    }
    return out;
  };

  /**
   * `{script, args}` for the gate inside a hook command, or `null` if the command does not
   * run the gate at all.
   *
   * It finds `lead-gate.mjs` by scanning the words rather than assuming the shape
   * `node <script>`. A hand-wired `/usr/local/bin/node --enable-source-maps '<path>'` is a
   * correct registration, and a check that read only the second word would call it inert —
   * reporting a false FAIL on a working gate, which is how an operator learns to ignore a
   * report.
   */
  const parseHookCommand = (cmd) => {
    const tokens = shTokens(cmd);
    const i = tokens.findIndex((t) => /(^|[/\\])lead-gate\.mjs$/.test(t));
    return i === -1 ? null : { script: tokens[i], args: tokens.slice(i + 1) };
  };

  const scriptProbe = observe(probe, 'hookScriptExists');
  const commandCheck = (name, json, what) => {
    if (json === null) return push(name, null, `${what} PreToolUse command — no file was read`);
    const entries = Array.isArray(json.hooks?.PreToolUse) ? json.hooks.PreToolUse : [];
    if (entries.length === 0) return push(name, false, `${what} has no PreToolUse entry, so there is no command to read`);
    if (scriptProbe.absent) return push(name, null, `${what} PreToolUse command — not observed (no hookScriptExists probe), and half of this check is "the script is really there"`);
    if (scriptProbe.failed) return push(name, false, `${what} PreToolUse command — the hookScriptExists probe threw: ${scriptProbe.failed}`);
    const exists = scriptProbe.got;
    if (typeof exists !== 'function') return push(name, false, `${what} PreToolUse command — the hookScriptExists probe is ${shown(exists)}, not a predicate`);

    const faults = [];
    let commands = 0;
    for (const entry of entries) {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : null;
      if (hooks === null || hooks.length === 0) {
        // The matcher survives, the hook does not run, and every other check is green.
        faults.push(`an entry whose hooks list is ${shown(entry?.hooks)} — the matcher is there and NOTHING runs`);
        continue;
      }
      for (const h of hooks) {
        commands += 1;
        if (h?.type !== 'command' || typeof h.command !== 'string' || h.command.trim() === '') {
          faults.push(`a hook of type ${shown(h?.type)} with command ${shown(h?.command)}`);
          continue;
        }
        const parsed = parseHookCommand(h.command);
        if (parsed === null) {
          // `command: "true"` and every other stand-in lands here: registered, consulted,
          // and allowing everything.
          faults.push(`a command that does not run lead-gate.mjs: ${shown(h.command)}`);
          continue;
        }
        let there;
        try {
          there = exists(parsed.script) === true;
        } catch (e) {
          faults.push(`the script could not be probed (${e?.code ?? e?.message ?? 'threw'})`);
          continue;
        }
        if (!there) faults.push('a command pointing at a lead-gate.mjs that is NOT on disk — the hook fires, node exits non-zero, and the gate denies nothing');
      }
    }
    return push(name, faults.length === 0, faults.length === 0
      ? `${what}: ${commands} PreToolUse command(s), all running an on-disk lead-gate.mjs`
      : `${what}: ${faults.join('; ')}`);
  };
  commandCheck('lead PreToolUse command runs the gate', leadJson, 'lead settings');
  commandCheck('worktree PreToolUse command runs the gate', guardJson, 'worktree guard file');

  // --- INVERTED: the edit ban lives on argv, never in a file ---------------------------
  /**
   * The ban boundary is exactly "the lead session INCLUDING its workflow agents, EXCLUDING
   * its teammates" (spec § 9), and these two checks are the halves of it that doctor can
   * honestly take. Neither of them observes a running lead — doctor cannot see a session's
   * tool list — so neither says it did.
   *
   * **Half one: no settings file may carry the ban.** For most of this build this check
   * asserted the exact opposite: that `leads/<id>/settings.json` carried `Edit`, `Write` and
   * `NotebookEdit` as bare denies. That premise was false and it cost the whole fleet its
   * hands. `settings.json` is the base of `settings.launch.json`, which is the value of
   * `--settings`, and `--settings` is inherited by every split-pane teammate — measured
   * against claude 2.1.220 from a real teammate's own argv, where `--settings` carried the
   * parent's exact path while `--disallowedTools`, `--mcp-config`, `--strict-mcp-config` and
   * `--setting-sources` were all dropped. The worktree guard file reaches teammates the other
   * way, from cwd. So **both files bind teammates**, one bare name in either takes all the
   * hands off the fleet, and it presents as a model limitation rather than a settings bug —
   * which is how it survived four reviews. This is the only place that would notice it coming
   * back, and it names every file it actually read rather than claiming the pair.
   */
  {
    const NAME = 'no edit ban in settings files';
    const bareDenies = (json) => {
      const d = json?.permissions?.deny;
      return Array.isArray(d) ? LEAD_BANNED_TOOLS.filter((t) => d.includes(t)) : [];
    };
    const subjects = [
      ['the lead settings file', leadJson, lead.source],
      ['the worktree guard file', guardJson, guard.source],
    ].filter(([, json]) => json !== null);
    if (subjects.length === 0) {
      push(NAME, null, 'the bare-name write-tool denies — neither a lead settings file nor a worktree guard file was read, so nothing was judged');
    } else {
      const offenders = subjects.map(([what, json]) => [what, bareDenies(json)]).filter(([, hits]) => hits.length);
      push(NAME, offenders.length === 0, offenders.length
        ? `${offenders.map(([what, hits]) => `${what} denies ${hits.join(', ')}`).join('; ')} by BARE TOOL NAME — every settings file on disk reaches teammates (--settings propagates to a split-pane teammate; the guard file is loaded from cwd), so this takes Edit/Write/NotebookEdit off the whole fleet and the lead has nobody left to implement anything. The lead's own ban belongs on argv, not here`
        : `${subjects.map(([what, , source]) => `${what} (${source})`).join(' and ')} carry no bare ${LEAD_BANNED_TOOLS.join('/')} deny — teammates keep their hands. Files only; the lead's own ban is judged separately, against its argv`);
    }
  }

  /**
   * **Half two, INVERTED: the argv carries NO edit ban.** The lead-only edit ban has been
   * lifted so a lead's Edit/Write/NotebookEdit surface matches its teammates'. `buildLeadArgv`
   * must therefore no longer emit `--disallowedTools` banning those tools — and doctor guards
   * the regression: a re-imposed `--disallowedTools Edit,…` on the next spawn is now a FAIL.
   *
   * `buildLeadArgv` is a pure function that touches no disk and starts nothing, so doctor can
   * call it with a fixture and read the argv the spawner would hand `execFile`. That is a
   * statement about **the next spawn**, not about a live session, and the detail says so. The
   * companion "no edit ban in settings files" check (above) is unchanged: the fleet-wide
   * `--settings` file must still carry no bare edit deny, because that one binds teammates too.
   */
  check('lead edit ban on argv', 'leadArgv', 'the lead is not argv-edit-banned', (argv) => {
    if (!Array.isArray(argv)) return [false, `the lead's argv — the leadArgv probe returned ${shown(argv)}, not an argv array`];
    const at = argv.indexOf('--disallowedTools');
    if (at === -1) return [true, "buildLeadArgv() emits no --disallowedTools element — the lead's Edit/Write/NotebookEdit surface matches its teammates'. Read from the generator, NOT from a running lead: doctor cannot see a live session's tool list, and this says nothing about one"];
    // A --disallowedTools is present: it re-imposes the lifted ban only if it names an edit tool.
    const value = argv[at + 1];
    const names = typeof value === 'string' ? value.split(',').map((s) => s.trim()) : [];
    const banned = LEAD_BANNED_TOOLS.filter((t) => names.includes(t));
    return [banned.length === 0, banned.length === 0
      ? `buildLeadArgv() emits --disallowedTools ${shown(value)}, which bans none of ${LEAD_BANNED_TOOLS.join('/')} — the lead keeps its edit surface`
      : `buildLeadArgv() emits --disallowedTools ${shown(value)} banning ${banned.join(', ')} — the lead-only edit ban was supposed to be LIFTED so a lead matches its teammates; this re-imposes it`];
  });

  // --- Edit, never the inert Write -----------------------------------------------------
  guardCheck('guard file self-protect', 'the guard file protects itself', (d) => [
    d.includes('Edit(./.claude/**)'),
    d.includes('Edit(./.claude/**)')
      ? 'Edit(./.claude/**) present — covers Edit, Write and NotebookEdit on the guard file'
      : 'Edit(./.claude/**) is MISSING — the guard file can be emptied, which fails OPEN to the personal MCP fleet for every later spawn in that worktree',
  ]);
  // A `Write(...)` file rule is INERT: Claude Code prints, once per session in every guarded
  // worktree, that only `Edit(path)` rules are matched by file permission checks. So it
  // looks like coverage, warns every teammate, and refuses nothing.
  guardCheck('no inert Write() rule', 'no inert Write() file rule', (d) => {
    const inert = d.filter((r) => r.startsWith('Write('));
    return [inert.length === 0, inert.length === 0
      ? 'no Write(...) file rule (Claude Code honours only Edit(path) for file permission checks)'
      : `${inert.join(', ')} is inert — Claude Code matches only Edit(path) rules for file permissions, and warns once per session about this`];
  });

  // --- the rule-authoring invariant ----------------------------------------------------
  /**
   * Measured with the rule as the only variable: a rule containing `*` matches
   * whitespace-INSENSITIVELY, a rule with none is compared to the RAW segment. So
   * `Bash(echo alpha beta)` lets `echo alpha  beta` RUN. A wildcard-free rule added later is
   * a one-keystroke bypass, invisible in review, in a way nothing else in the file is.
   */
  guardCheck('every Bash rule keeps a wildcard', 'wildcard invariant', (d) => {
    const brittle = [...d, ...allow]
      .filter((r) => typeof r === 'string' && r.startsWith('Bash('))
      .filter((r) => !(/^Bash\((.*)\)$/s.exec(r)?.[1] ?? '*').includes('*'));
    const total = [...d, ...allow].filter((r) => typeof r === 'string' && r.startsWith('Bash(')).length;
    return [brittle.length === 0, brittle.length === 0
      ? `all ${total} Bash rules keep a wildcard, so the guard file is whitespace-insensitive`
      : `whitespace-brittle (no wildcard, so a doubled space is a bypass): ${brittle.join(', ')}`];
  });

  /**
   * The live guard file against what the generator would write now.
   *
   * This is the drift a respawn fixes and nothing else reports: a worktree written before a
   * rule landed keeps the OLD rules for every teammate spawned into it, and the `*` in
   * `.claude/.gitignore` means the difference shows up in neither `git status` nor the PR.
   * A hand edit lands here too. Unobserved when there is no live file, because then there is
   * nothing to compare and the reference is already the subject of every check above.
   */
  // `!x`, not `=== null`: `pair()` omits both keys entirely when the probe was absent or
  // threw, so an `=== null` test reads `undefined` as "present" and dereferences it. The
  // "checks never throws" test caught exactly that, which is the whole reason it exists.
  if (!guard.live || !guard.reference) {
    push('guard file matches the generator', null, !guard.live
      ? 'no live guard file yet, so there is nothing to compare against the generator'
      : 'no generated reference to compare against');
  } else {
    const rules = (j) => [...(Array.isArray(j.permissions?.deny) ? j.permissions.deny : []),
      ...(Array.isArray(j.permissions?.allow) ? j.permissions.allow : [])];
    // The soma-pr allow rules embed the ABSOLUTE path of the copy of soma that wrote them,
    // so a doctor run from any other copy (a worktree checkout of this very repo, a second
    // clone) reported drift on a guard file that is byte-for-byte what the live spawner
    // writes. Canonicalise that one prefix on both sides before diffing: a difference ONLY
    // there is "two copies of soma exist on this machine", not "the guard file is stale" —
    // and it is still named in the detail, because the absolute path decides which soma-pr
    // a teammate may run. Everything else is compared verbatim, so a rule really lost or
    // really added fails exactly as before. The glob rule (`Bash(node */bin/soma-pr.mjs*)`)
    // starts with `*`, not `/`, and passes through untouched.
    const canon = (r) => (typeof r === 'string' ? r.replace(/^(Bash\((?:node )?)\/.*\/bin\/soma-pr\.mjs/, '$1<install>/bin/soma-pr.mjs') : r);
    const installOf = (list) => list
      .map((r) => (typeof r === 'string' ? /^Bash\(node (\/.*)\/bin\/soma-pr\.mjs\*\)$/.exec(r)?.[1] : undefined))
      .find((p) => p !== undefined) ?? null;
    const liveRules = rules(guard.live);
    const refRules = rules(guard.reference);
    const liveCanon = liveRules.map(canon);
    const refCanon = refRules.map(canon);
    const lost = refCanon.filter((r) => !liveCanon.includes(r));
    const gained = liveCanon.filter((r) => !refCanon.includes(r));
    const liveInstall = installOf(liveRules);
    const refInstall = installOf(refRules);
    const repinned = liveInstall !== null && refInstall !== null && liveInstall !== refInstall;
    push('guard file matches the generator', lost.length === 0 && gained.length === 0,
      lost.length === 0 && gained.length === 0
        ? (repinned
          ? `the live guard file carries the same ${liveRules.length} rules settings-gen would write now; its soma-pr allow rules are pinned to ${liveInstall} while this doctor runs from ${refInstall} — expected when doctor runs from a different copy of soma than the one that spawned the worktree, and a respawn re-pins them`
          : `the live guard file carries the same ${liveRules.length} rules settings-gen would write now`)
        : `the live worktree's guard file is not what settings-gen writes today — ${lost.length ? `missing: ${lost.slice(0, 4).join(', ')}` : ''}${lost.length && gained.length ? '; ' : ''}${gained.length ? `unexpected: ${gained.slice(0, 4).join(', ')}` : ''}. A respawn rewrites it; a hand edit is invisible in git thanks to .claude/.gitignore`);
  }

  // --- drift against the UNION, and the two wildcards ----------------------------------
  const allowList = observe(probe, 'teammateAllow');
  if (deny === null || servers.absent || servers.failed || !Array.isArray(servers.got)
      || allowList.absent || allowList.failed || !Array.isArray(allowList.got)) {
    push('mcp deny drift', null, 'personal MCP denies — the guard file, the enumeration or the allowlist was not read');
  } else {
    const exempt = new Set(allowList.got);
    const want = [...new Set(servers.got.filter((n) => typeof n === 'string' && n && !exempt.has(n)).map((n) => `mcp__${n}`))].sort();
    // A PERSONAL deny is a bare `mcp__<server>`: no `__` after the server name (which would
    // make it one of the standing named-tool denies) and no wildcard.
    const have = deny.filter((d) => typeof d === 'string' && d.startsWith('mcp__') && !d.includes('*') && !d.slice(5).includes('__')).sort();
    const missing = want.filter((w) => !have.includes(w));
    const extra = have.filter((h) => !want.includes(h));
    push('mcp deny drift', missing.length === 0 && extra.length === 0,
      missing.length === 0 && extra.length === 0
        ? `${have.length} personal MCP denies match the UNION of both config roots and every seat (${servers.got.length} enumerated, ${exempt.size} allowlisted)`
        : `drift vs the union of both roots and every seat — ${missing.length ? `not denied: ${missing.join(', ')}` : ''}${missing.length && extra.length ? '; ' : ''}${extra.length ? `denied but not enumerated: ${extra.join(', ')}` : ''}`);
  }
  /**
   * The two wildcards guard an ACCOUNT-SIDE surface that grows with no local change: 16
   * connectors on the bring-up machine, three already authenticated with real send/write
   * tools, and NOT ONE of them appears anywhere in `~/.claude.json`. So no enumeration can
   * reach them, the drift check above cannot see them, and a doctor that confirmed the
   * local config was denied would pass forever while a connector authorised last week sat
   * open. Asserted VERBATIM: a near-miss glob is a different glob.
   */
  for (const rule of ['mcp__claude_ai_*', 'mcp__plugin_*']) {
    guardCheck(`mcp deny ${rule}`, `the ${rule} wildcard`, (d) => [d.includes(rule), d.includes(rule)
      ? `${rule} present verbatim — the only defence for connectors that appear in no local file`
      : `${rule} is MISSING (verbatim) — an account connector authorised at any time is reachable by every teammate; no local enumeration can see this`]);
  }

  // --- the credential-store family -----------------------------------------------------
  guardCheck('credential-store command denies', 'credential stores', (d) => {
    const open = CREDENTIAL_VECTORS.filter((c) => !deniesCommand(d, c));
    const collateral = CREDENTIAL_CONTROLS.filter((c) => deniesCommand(d, c));
    if (open.length) return [false, `${open.length}/${CREDENTIAL_VECTORS.length} credential-store commands are NOT denied: ${open.slice(0, 3).map((c) => JSON.stringify(c)).join(', ')}`];
    if (collateral.length) return [false, `over-broad — ${collateral.length} ordinary commands are collateral damage: ${collateral.slice(0, 3).map((c) => JSON.stringify(c)).join(', ')}`];
    return [true, `${CREDENTIAL_VECTORS.length}/${CREDENTIAL_VECTORS.length} credential-store commands denied, ${CREDENTIAL_CONTROLS.length}/${CREDENTIAL_CONTROLS.length} ordinary commands still allowed — single-command paths only; a subprocess that assembles the path at runtime is invisible to a text rule and needs the PreToolUse gate plus OS sandboxing`];
  });
  guardCheck('credential-store Read() denies', 'the Read-tool surface', (d) => {
    const missing = CREDENTIAL_READ_RULES.filter((r) => !d.includes(r));
    return [missing.length === 0, missing.length === 0
      ? `${CREDENTIAL_READ_RULES.length} Read(...) rules present — measured to bite: Read(~/dir/**) and Read(~/dir/file) were both DENIED 2/2 against a synthetic fixture, control arm read the marker`
      : `the Read tool can reach ${missing.length} credential path(s) — missing: ${missing.join(', ')}. No Bash rule covers the Read tool, which produces no command string`];
  });

  // --- the honest protected-ref claim --------------------------------------------------
  guardCheck('protected-ref single-command paths', 'protected refs', (d) => {
    const open = PROTECTED_VECTORS.filter((c) => !deniesCommand(d, c));
    const collateral = PROTECTED_CONTROLS.filter((c) => deniesCommand(d, c));
    if (open.length) return [false, `${open.length}/${PROTECTED_VECTORS.length} single-command routes to a protected ref are NOT denied: ${open.slice(0, 3).map((c) => JSON.stringify(c)).join(', ')}`];
    if (collateral.length) return [false, `over-broad — a teammate cannot push its own branch, which dead-ends the task: ${collateral.slice(0, 3).map((c) => JSON.stringify(c)).join(', ')}`];
    return [true, `${PROTECTED_VECTORS.length} single-command routes denied, ${PROTECTED_CONTROLS.length} ordinary task pushes still allowed. The CLASS is not closed by string rules: an alternate remote name, git send-pack, HEAD-while-on-main, partial quoting and a git alias were all measured landing main — that needs the PreToolUse gate plus OS sandboxing`];
  });

  // --- the registry that degrades to {} by design -------------------------------------
  check('harness registry', 'harnessCount', 'the six loop harnesses', (n) =>
    [n === 6, `loadHarnesses() holds ${shown(n)} entries (need exactly 6; a broken registry degrades to {} BY DESIGN so it cannot take down the bus, which makes silence its failure mode)`]);

  // --- the gh flag surface, and the lead's own node ------------------------------------
  /**
   * Both gh-flag checks refuse to answer without a help text, and that is the whole point.
   *
   * **THE DEFECT THIS EXISTS TO CLOSE.** The probe used to be `tryRun(…) ?? ''`. `gh` absent
   * from PATH, a non-zero exit and the 20 s timeout all became `''`; the negation check saw a
   * string, found no draft-negation flag in it, and reported `ok  gh pr create draft
   * negation`. So on every machine without `gh`, doctor certified the draft-only guarantee
   * against a surface it had never read — this module's own headline defect, in this module.
   * It survived review once because the sibling `--draft` check FAILED in the same run, which
   * made the REPORT red while the ASSERTION was a rubber stamp.
   *
   * An empty or whitespace-only help text is not an observation of anything: real `gh pr
   * create --help` is never blank, so blank means the read did not happen. `null` — UNOBSERVED
   * — is the honest answer for BOTH halves, the same answer `lead PATH node vs engines.node`
   * gives for an `engines.node` spec it cannot parse ("guessing would be a check that reports
   * health it never measured"). Nothing is lost by not FAILING here: a missing `gh` is
   * `gh auth`'s finding, and it FAILS there.
   */
  const ghHelp = (name, what, judge) => check(name, 'ghPrCreateHelp', what, (help) => {
    if (typeof help !== 'string' || help.trim() === '') {
      return [null, `${what} — gh pr create --help produced no text (${shown(help)}), so this was not read at all: gh absent from PATH, a non-zero exit and the 20s timeout are one value here. See gh auth for whether gh works`];
    }
    return judge(help);
  });
  /**
   * The one flag `soma-pr`'s guarantee rests on. ONE constant, read by BOTH gh checks on
   * purpose: the negation check below keys its "is this really gh's help?" guard off exactly
   * the spelling the `--draft` check validates, and two copies of this regex could drift into
   * a state where the negation check goes UNOBSERVED on every healthy machine and nobody sees
   * it — a check that stops running is this module's own defect class.
   */
  const DRAFT_FLAG = /(^|\s)-d,\s*--draft(\s|$)/m;
  ghHelp('gh pr create --draft', 'gh pr create flags', (help) => {
    const ok = DRAFT_FLAG.test(help);
    return [ok, ok ? "gh pr create still spells it '-d, --draft' — soma-pr's only guarantee is pinned to this"
      : "gh pr create no longer spells '-d, --draft' — the soma-pr wrapper injects a flag this gh does not have, so every PR it opens may be NON-DRAFT"];
  });
  ghHelp('gh pr create draft negation', 'gh pr create negation flags', (help) => {
    // THE LAST RESIDUAL OF THE DEFECT ABOVE. A blank help text is already reported unread —
    // but a NON-blank one that is not gh's help was still judged, and answered `ok  no draft
    // negation flag`: honest about the text it read, and that text was never gh's. The read
    // has to carry the `-d, --draft` the sibling check validates or there is nothing here
    // whose `--no-*` flags mean anything, so an unrecognised surface is UNOBSERVED, not clean.
    // Reachability is close to nil — `tryRun` answers `null` on a non-zero exit, so reaching
    // this needs a shim or wrapper named `gh` that exits 0 printing something else — which is
    // roughly what the original defect's reachability looked like from inside this module.
    // The sibling FAILs on the very same read, so a shimmed machine is still red; see the
    // `ghHelp` doc for why that is a property here rather than sibling-masking.
    if (!DRAFT_FLAG.test(help)) {
      return [null, `not gh pr create's help — no '-d, --draft' anywhere in the ${help.length} chars read (${shown(help)}), so its --no-* flags say nothing about drafts. Only a shim or wrapper named gh that exits 0 reaches this; gh pr create --draft FAILs on the same read`];
    }
    // Only a DRAFT negation counts. `--no-maintainer-edit` ships today and has nothing to do
    // with drafts, so a blanket `--no-*` scan false-alarms on every healthy machine.
    // Deduped: `gh` prints some flags more than once (measured — `--no-maintainer-edit`
    // appears twice in the real help), and a detail that says `--x, --x` is a detail an
    // operator stops trusting.
    const negations = [...new Set([...help.matchAll(/--[a-z0-9-]+/g)].map((m) => m[0]))]
      .filter((f) => f !== '--draft' && /draft/.test(f));
    const benign = [...new Set([...help.matchAll(/--no-[a-z0-9-]+/g)].map((m) => m[0]))].filter((f) => !/draft/.test(f));
    return [negations.length === 0, negations.length === 0
      ? `no draft negation flag (benign --no-* flags ignored: ${benign.length ? benign.join(', ') : 'none'})`
      : `gh grew ${negations.join(', ')} — anything appended after soma-pr's injected --draft could un-draft the PR`];
  });
  check('lead PATH node vs engines.node', 'leadNode', "the node a lead's PATH resolves to", (n) => {
    const spec = observe(probe, 'enginesNode');
    if (spec.absent || spec.failed || typeof spec.got !== 'string') return [false, `engines.node could not be read (${spec.failed ?? shown(spec.got)})`];
    const min = /^>=\s*([0-9][0-9.]*)$/.exec(spec.got.trim())?.[1];
    // An engines spec this cannot parse is UNOBSERVED rather than a pass: guessing at a
    // range would be a check that reports health it never measured.
    if (min === undefined) return [null, `engines.node is ${JSON.stringify(spec.got)}, which this check does not know how to compare (only ">=N" is understood)`];
    if (n === null) return [false, `no node on the PATH a lead is given (engines.node ${spec.got}) — the machine default here is Node 20 and the suite's glob fails silently on it`];
    if (n === null || typeof n !== 'object') return [false, `the leadNode probe returned ${shown(n)}`];
    const v = String(n.version ?? '').replace(/^v/, '');
    return [semverGte(v, min), `${n.path ?? '(unknown path)'} is node ${n.version ?? '(unknown)'} (engines.node ${spec.got})${semverGte(v, min) ? '' : ' — a lead spawned with this PATH runs the wrong node'}`];
  });

  // --- the session id, and the hook payload that must match it -------------------------
  /**
   * A rename of `CLAUDE_CODE_SESSION_ID` is the one event that unpins the whole
   * event-injection path, and it fails closed but QUIETLY. The discriminator is what makes
   * this sound: measured on this machine, a Bash subprocess of a live session carries
   * `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_CODE_VERSION` **alongside** the
   * session id — so those three, BY NAME, are an INDEPENDENT witness that we are inside a
   * session, and their presence WITHOUT the session id is exactly the rename. Without the
   * witness, a rename and "doctor was run from a plain shell" are the same observation, and
   * the check would go green on the rename.
   *
   * BY NAME, never by the `CLAUDE` prefix. `CLAUDE_CONFIG_DIR` is operator CONFIGURATION,
   * exported from a shell profile on exactly the machines that run a second config root —
   * and matching the prefix counted it as session evidence, so every plain-shell doctor run
   * on such a machine reported a rename that never happened. Config an operator sets by hand
   * is not evidence claude is running; the three above are set by no hand and travel with
   * every real session's subprocesses.
   */
  const sid = typeof e.CLAUDE_CODE_SESSION_ID === 'string' ? e.CLAUDE_CODE_SESSION_ID : null;
  const SESSION_WITNESS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_VERSION'];
  const claudeVars = SESSION_WITNESS.filter((k) => typeof e[k] === 'string').sort();
  if (sid === null && claudeVars.length === 0) {
    push('CLAUDE_CODE_SESSION_ID', null, 'not inside a Claude Code session (no CLAUDE* variable in the environment), so the session id could not be read');
  } else if (sid === null) {
    push('CLAUDE_CODE_SESSION_ID', false, `CLAUDE_CODE_SESSION_ID is ABSENT while ${claudeVars.join(', ')} are set — this is a session, so the variable has been renamed and the event-injection path is unpinned`);
  } else {
    push('CLAUDE_CODE_SESSION_ID', isUuid(sid), isUuid(sid)
      ? `CLAUDE_CODE_SESSION_ID is uuid-shaped (${sid.trim().slice(0, 8)}…)`
      : `CLAUDE_CODE_SESSION_ID is ${shown(sid)}, which is not uuid-shaped — a hook payload's session_id is a uuid, so no comparison against one can succeed`);
  }
  const hook = observe(probe, 'hookSessionId');
  if (sid === null || !isUuid(sid)) push('session id matches hook payload', null, 'no uuid-shaped CLAUDE_CODE_SESSION_ID to compare');
  else if (hook.absent) push('session id matches hook payload', null, 'not observed (no hookSessionId probe)');
  else if (hook.failed) push('session id matches hook payload', false, `the hookSessionId probe threw: ${hook.failed}`);
  else if (hook.got === null) push('session id matches hook payload', null, "no hook payload recorded yet, so the env var and a hook's session_id were not compared");
  else {
    const same = isUuid(hook.got) && String(hook.got).trim().toLowerCase() === sid.trim().toLowerCase();
    push('session id matches hook payload', same, same
      ? `CLAUDE_CODE_SESSION_ID equals the recorded hook payload's session_id (${sid.trim().slice(0, 8)}…)`
      : `CLAUDE_CODE_SESSION_ID ${shown(sid)} != the hook payload's session_id ${shown(hook.got)} — the session-discriminated edit guard compares these two`);
  }

  // --- one breaker flag path, agreed on by writer and reader ---------------------------
  //
  // ⚠ The reader's half is judged by RUNNING the real gate, never by grepping its source for
  // an import. This check used to demand the gate resolve through `tripPath`/`leadDir` — but
  // the gate is DEPENDENCY-FREE BY DESIGN (its own header: a typo in a shared module must not
  // be able to disarm the breaker), so "imports soma's path helpers" is a property it must
  // NOT have, and the check failed on every correct install of this repo, forever. What
  // writer and reader must share is not a helper, it is an ANSWER: with the flag the writer
  // would write sitting in a scratch root, the real hook process must deny — and with it
  // removed, the same gate must fall silent. Agreement is measured, not inferred from text.
  const home = observe(probe, 'somaHome');
  const trip = observe(probe, 'tripPath', 'doctor-probe');
  if (home.absent || trip.absent) push('budget flag path', null, 'the BUDGET_TRIPPED flag path — not observed (no somaHome/tripPath probe)');
  else if (home.failed || trip.failed) push('budget flag path', false, `the BUDGET_TRIPPED flag path — probe threw: ${home.failed ?? trip.failed}`);
  else {
    // Built from the state root and three literals, NOT from `leadDir` — comparing
    // `tripPath` against its own helper would be a check that cannot fail.
    const want = join(String(home.got), 'leads', 'doctor-probe', 'BUDGET_TRIPPED');
    if (trip.got !== want) {
      push('budget flag path', false, `tripPath resolves ${shown(trip.got)}, not ${want} — the gate only ever probes <SOMA_HOME>/leads/<id>/BUDGET_TRIPPED, so a flag written anywhere else is a breaker nobody enforces`);
    } else {
      const gate = observe(probe, 'gateBudgetProbe');
      if (gate.absent) {
        push('budget flag path', null, `${want} resolves under the state root; the gate's behaviour was not probed (no gateBudgetProbe probe), so writer/reader agreement on the root was not observed`);
      } else if (gate.failed) {
        push('budget flag path', false, `${want} resolves under the state root, but the real gate could not be run to confirm it reads the same root: ${gate.failed}`);
      } else {
        const g = gate.got;
        const denied = (s) => {
          try {
            const d = JSON.parse(String(s))?.hookSpecificOutput;
            return d?.permissionDecision === 'deny' && /BUDGET_TRIPPED|budget/i.test(String(d?.permissionDecisionReason));
          } catch {
            return false;
          }
        };
        if (g === null || typeof g !== 'object' || typeof g.withFlag !== 'string' || typeof g.withoutFlag !== 'string') {
          push('budget flag path', false, `the gateBudgetProbe probe returned ${shown(g)}, not {withFlag, withoutFlag}`);
        } else if (!denied(g.withFlag)) {
          push('budget flag path', false, `${want} — the writer resolves it there, but the real gate process, handed a scratch root carrying exactly that flag, did NOT deny (stdout: ${shown(g.withFlag)}) — the reader derives a different state root than the writer, which is a breaker nobody enforces`);
        } else if (g.withoutFlag.trim() !== '') {
          push('budget flag path', false, `the real gate denied with NO flag on disk (stdout: ${shown(g.withoutFlag)}) — a breaker that trips on nothing wedges every lead`);
        } else {
          push('budget flag path', true, `${want} — and the real gate process, run against a scratch root, denied while exactly that flag existed and fell silent once it was removed: writer and reader agree on the derivation (the gate stays dependency-free by design; agreement is measured, not inferred from its source)`);
        }
      }
    }
  }

  // --- a scratch sweep must skip a live pid --------------------------------------------
  /**
   * Doctor REPORTS and never deletes — but it must not report a live peer either. A sweep
   * that ignores pid liveness deletes a peer's in-flight scratch file and turns that peer's
   * lock proof into a false timeout, and a *report* that calls it debris is the first step
   * to someone deleting it by hand.
   */
  check('state scratch files', 'scratchFiles', 'leftover tmp+rename scratch files', (got) => {
    if (got === null || typeof got !== 'object' || Array.isArray(got) || !Array.isArray(got.files)) {
      return [false, `the scratchFiles probe returned ${shown(got)}, not {files, unreadable}`];
    }
    const files = got.files;
    // `walk` used to swallow every `readdirSync` failure and answer `[]`, which the check read
    // as `0 stale` and passed — a sweep that could not open the state root reporting the state
    // root clean. Lower stakes than the gh case (this is a report about debris, and doctor
    // never deletes), identical mechanism, so it gets the identical answer: UNOBSERVED.
    const unreadable = Array.isArray(got.unreadable) ? got.unreadable : [];
    const live = files.filter((f) => f?.live === true);
    const stale = files.filter((f) => f?.live !== true);
    // A stale file FOUND is a finding whether or not the sweep was complete; "0 stale" is the
    // only verdict a partial sweep cannot support.
    if (stale.length) {
      return [false, `${stale.length} stale scratch file(s) from a crashed publish: ${stale.slice(0, 3).map((f) => `${f?.path} (pid ${f?.pid})`).join(', ')}; ${live.length} in flight (live pid, skipped)`];
    }
    if (unreadable.length) return [null, `0 stale found, but ${unreadable.length} director(y/ies) under the state root could not be read (${unreadable.slice(0, 2).join(', ')}) — the sweep was partial, so "0 stale" is not something this run observed`];
    return [true, `0 stale; ${live.length} in flight (live pid, skipped)`];
  });

  // --- the floor under rotation (account rotation, design §2) --------------------------
  /**
   * `autoContinueAtUsageLimit: true` in the lead settings file a RUNNING lead actually has.
   *
   * It is the floor the whole feature rests on: when rotation cannot run — no open seat, the
   * pool unreadable, the org cap hit — a `five_hour` lead still recovers inside its own window
   * only because Claude Code armed itself off this boolean. `writeLeadSettings` has emitted it
   * since the seat work landed, and two tests pin the generator and the launch file.
   *
   * NEITHER SAYS ANYTHING ABOUT A LEAD THAT WAS ALREADY RUNNING WHEN IT LANDED. A generator
   * change reaches a lead only at its next launch, `pair()` hands every lead-settings check
   * `live ?? reference`, and no other check compares the live file against the generator
   * (`guard file matches the generator` is the worktree file). So a fleet whose leads all
   * predate the key has no floor at all while `lead settings readable` reports ok — the blind
   * spot RUNBOOK §5.2 states in prose, names the remedy for (cycle the lead), and that nothing
   * detected. This is the detector.
   *
   * Three states, and the middle one is the point. UNOBSERVED when the file was not read at
   * all — `lead settings readable` owns that finding, and this check must not turn "could not
   * read" into either verdict. Strict `=== true`, never truthiness: a hand-edited settings.json
   * answers in strings, and `"false"` is truthy. A live file that EXISTS but does not parse is
   * unobserved too, not judged through the generated reference it falls back to — the same rule
   * `lead settings readable` already makes of `brokenPath`, and for the same reason: the
   * generator is healthy in exactly the case where the file a lead inherits is not.
   */
  {
    const NAME = 'lead auto-continue floor';
    const what = 'leads/<id>/settings.json autoContinueAtUsageLimit';
    const got = leadJson === null ? undefined : leadJson.autoContinueAtUsageLimit;
    if (lead.absent || lead.failed || lead.bad !== undefined || lead.broken || leadJson === null) {
      push(NAME, null, `${what} — not observed: the settings file was not read (see 'lead settings readable')`);
    } else if (got === true) {
      push(NAME, true, `${what}: true — the auto-continue floor under account rotation, read from ${lead.source === 'live'
        ? 'the live file a running lead inherits' : 'the generated reference (no live lead settings file yet)'}`);
    } else {
      push(NAME, false, `${what} — got ${shown(got)}, not true, in ${lead.source === 'live'
        ? 'the live file a running lead inherits' : 'the generated reference'}. Without it a lead that hits a five_hour`
        + ' window and cannot be rotated (no open seat, an unreadable pool, or the org cap) never resumes on its own:'
        + ' Claude Code arms `continuing automatically at <reset>` off this boolean and nothing else.'
        + ' A generator change reaches a lead only at its NEXT launch, so a lead already running keeps the old file —'
        + ' cycle it (`soma kill <id>` then `soma_resume`, RUNBOOK §9) when it must not wait.');
    }
  }

  // --- the seat pool (account rotation, design §3.7) -----------------------------------
  /**
   * Four checks over `soma.json.seats`, and the first CARRIES THE READ for the other three —
   * the shape `mcp enumeration readable` has with `mcp deny drift`: when the seat list itself
   * could not be read there is nobody to log in, no tree to compare and no root to enumerate,
   * so those three go UNOBSERVED rather than FAIL or green. Zero seats is a live reading and
   * not a gap — rotation is off, the fleet runs on its own root — and every one of the four
   * says so with the count, as `repos readable` says `0 repos configured`; an INCOMPLETE
   * report on every machine without a pool would teach the operator to skim the summary.
   *
   * Within a check FAIL beats unobserved: one seat definitely wrong is a finding whether or
   * not another seat could be read, and the detail names both — the ruling `no orch soma in
   * user scope` already makes ("a finding beats an incomplete read").
   */
  const seatsRead = observe(probe, 'seats');
  const seatList = !seatsRead.absent && !seatsRead.failed && Array.isArray(seatsRead.got) ? seatsRead.got : null;
  const seatName = (s) => `${s?.label ?? '?'} (${s?.config_dir ?? '?'})`;
  const seatLabels = (rows) => rows.map((s) => s?.label ?? '?').join(', ');
  if (seatsRead.absent) push('seats readable', null, 'soma.json.seats — not observed (no seats probe)');
  else if (seatsRead.failed) push('seats readable', false, `soma.json.seats could not be read, so no seat can be picked and no lead can rotate: ${seatsRead.failed}`);
  else if (seatList === null) push('seats readable', false, `soma.json.seats — the seats probe returned ${shown(seatsRead.got)}, not an array of {label, config_dir, exists}`);
  else if (seatList.length === 0) push('seats readable', true, "0 seats configured (soma.json.seats is empty) — rotation is off; leads run on the fleet's own config root");
  else {
    const missing = seatList.filter((s) => s?.exists === false);
    const unknown = seatList.filter((s) => s?.exists !== true && s?.exists !== false);
    if (missing.length) {
      push('seats readable', false, `${missing.map(seatName).join(', ')} — config_dir is not a directory, so a rotation onto it resumes into nothing (\`claude --resume\` finds no transcript, exits 1, and the lead stays down)${unknown.length ? `; ${unknown.map(seatName).join(', ')} could not be stat'ed` : ''}`);
    } else if (unknown.length) {
      push('seats readable', null, `${unknown.map(seatName).join(', ')} — config_dir could not be stat'ed, so whether the seat exists was not observed`);
    } else {
      push('seats readable', true, `${seatList.length} seats configured, every config_dir is a directory: ${seatList.map(seatName).join(', ')}`);
    }
  }

  /**
   * A check that needs the seat list: unobserved while the list is unread, a live `0 seats`
   * reading while it is empty, and otherwise its probe is called WITH the list — the
   * argument-taking shape `tripPath(id)` already has — so the three probes cannot disagree
   * with `seats` about which seats exist. A probe that answers for fewer seats than it was
   * given is refused by each judge below: it cannot pass by observing less than asked.
   */
  const seatCheck = (name, key, what, judge) => {
    if (seatList === null) return push(name, null, `${what} — not observed: the seat list was not read (see 'seats readable')`);
    if (seatList.length === 0) return push(name, true, `${what} — 0 seats configured (soma.json.seats is empty), nothing to check`);
    const o = observe(probe, key, seatList);
    if (o.absent) return push(name, null, `${what} — not observed (no ${key} probe)`);
    if (o.failed) return push(name, false, `${what} — the ${key} probe threw: ${o.failed}`);
    const [ok, detail] = judge(o.got, what);
    return push(name, ok, detail);
  };

  seatCheck('every seat logged in', 'seatsLoggedIn', "oauthAccount in every seat's .claude.json", (got, what) => {
    if (!Array.isArray(got)) return [false, `${what} — the seatsLoggedIn probe returned ${shown(got)}, not an array of {label, config_dir, loggedIn}`];
    if (got.length !== seatList.length) return [false, `${what} — the seatsLoggedIn probe answered for ${got.length} of ${seatList.length} seats`];
    const out = got.filter((s) => s?.loggedIn === false);
    // A seat whose `.claude.json` is ABSENT is not an incomplete reading: it has never been
    // logged in, and a rotation onto it fails exactly as an oauthAccount-less one does. Only
    // `configFile === false` promotes out of `unread`; a probe that does not answer the field
    // (or answers `null` — the file is there and would not open) leaves the seat unobserved,
    // which is the reading `seats.loggedIn`'s own null supports on its own.
    const stateless = got.filter((s) => s?.loggedIn !== true && s?.loggedIn !== false);
    const never = stateless.filter((s) => s?.configFile === false);
    const unread = stateless.filter((s) => s?.configFile !== false);
    if (out.length || never.length) {
      const said = [];
      if (out.length) said.push(`${out.map(seatName).join(', ')} — no oauthAccount in <config_dir>/.claude.json`);
      if (never.length) said.push(`${never.map(seatName).join(', ')} — no <config_dir>/.claude.json at all, so this seat has never been logged in (a soma.json.seats entry added without \`soma init --seat\`)`);
      return [false, `${said.join('; ')}: a rotation onto such a seat resumes the lead into \`Not logged in · Please run /login\` and exits 1. Run \`CLAUDE_CONFIG_DIR=<config_dir> claude auth login\` for each${unread.length ? `; ${unread.map(seatName).join(', ')} could not be read` : ''}`];
    }
    if (unread.length) {
      return [null, `${unread.map(seatName).join(', ')} — <config_dir>/.claude.json could not be read, so login was not observed (not read as logged out: the watchdog marks such a seat unverified rather than closed, and never picks it)`];
    }
    return [true, `${got.length} seats carry an oauthAccount in their .claude.json: ${seatLabels(got)}`];
  });

  seatCheck('seat projects is the shared tree', 'seatProjects', "every seat's projects/ resolves to the fleet's", (got, what) => {
    if (got === null || typeof got !== 'object' || Array.isArray(got) || !Array.isArray(got.seats)) {
      return [false, `${what} — the seatProjects probe returned ${shown(got)}, not {fleet, seats}`];
    }
    const fleet = typeof got.fleet?.path === 'string' && got.fleet.path !== '' ? got.fleet.path : null;
    if (fleet === null) {
      return [null, `${what} — the fleet's own projects/ could not be resolved (${got.fleet?.error ?? 'no path'}), so no seat's tree can be compared against it`];
    }
    if (got.seats.length !== seatList.length) return [false, `${what} — the seatProjects probe answered for ${got.seats.length} of ${seatList.length} seats`];
    const rows = got.seats.map((s) => ({ ...s, path: typeof s?.projects?.path === 'string' && s.projects.path !== '' ? s.projects.path : null }));
    const forked = rows.filter((s) => s.path !== null && s.path !== fleet);
    const unread = rows.filter((s) => s.path === null);
    if (forked.length) {
      return [false, `${forked.map((s) => `${seatName(s)} → ${s.path}`).join(', ')} — not ${fleet}: a lead rotated onto this seat cannot find its transcript (\`claude --resume\` looks only under $CLAUDE_CONFIG_DIR/projects) and the token meter reads it at 0. Replace it with the shared tree: \`rm -rf <config_dir>/projects && ln -s ${fleet} <config_dir>/projects\`${unread.length ? `; ${unread.map(seatName).join(', ')} could not be resolved` : ''}`];
    }
    if (unread.length) {
      return [null, `${unread.map((s) => `${seatName(s)}: ${s.projects?.error ?? 'no path'}`).join(', ')} — projects/ could not be resolved, so whether it is the shared tree ${fleet} was not observed`];
    }
    return [true, `${rows.length} seats' projects/ all resolve to ${fleet}: ${seatLabels(rows)}`];
  });

  seatCheck('mcp enumeration covers every seat', 'seatMcpCoverage', "every server a seat's .claude.json defines is in the enumeration guard files are written from", (got, what) => {
    if (got === null || typeof got !== 'object' || Array.isArray(got) || !Array.isArray(got.union) || !Array.isArray(got.seats)) {
      return [false, `${what} — the seatMcpCoverage probe returned ${shown(got)}, not {union, seats}`];
    }
    if (got.seats.length !== seatList.length) return [false, `${what} — the seatMcpCoverage probe answered for ${got.seats.length} of ${seatList.length} seats`];
    const union = new Set(got.union);
    const rows = got.seats.map((s) => ({ ...s, servers: Array.isArray(s?.own?.servers) ? s.own.servers : null }));
    const uncovered = rows.map((s) => ({ ...s, missing: (s.servers ?? []).filter((n) => !union.has(n)) })).filter((s) => s.missing.length);
    const unread = rows.filter((s) => s.servers === null);
    if (uncovered.length) {
      return [false, `${uncovered.map((s) => `${seatName(s)} defines ${s.missing.join(', ')}`).join('; ')} — not in the ${union.size}-server enumeration, so a teammate in any worktree reaches it undenied: enumerateUserMcpServers is not reading every seat's .claude.json (roots)${unread.length ? `; ${unread.map(seatName).join(', ')} could not be read` : ''}`];
    }
    if (unread.length) {
      return [null, `${unread.map((s) => `${seatName(s)}: ${s.own?.error ?? 'no servers'}`).join(', ')} — .claude.json could not be read, so what that seat defines, and whether it is denied, was not observed`];
    }
    const defined = rows.reduce((n, s) => n + s.servers.length, 0);
    return [true, `${defined} server(s) defined across ${rows.length} seats' .claude.json are all in the ${union.size}-server enumeration (${rows.map((s) => `${s.label ?? '?'}: ${s.servers.length}`).join(', ')})`];
  });

  /**
   * `state/seats.json` — the pool's runtime state, and the one file whose corruption stalls
   * rotation in SILENCE.
   *
   * The four checks above read what the operator DECLARED (`soma.json.seats`) and the seats'
   * own directories. None of them reads the pool state, and a torn pool is the failure with no
   * other voice: `readSeatState` answers UNREADABLE, `pick()` answers null, and the watchdog
   * emits `ROTATION_UNAVAILABLE {why:'seats_unreadable'}` ONCE PER LEAD PER LAUNCH — deduped off
   * the durable event log against that lead's newest SPAWNED / REVIVED / ROTATED /
   * ROTATION_FAILED (`saidUnavailable`, `bin/soma-watchdog.mjs`), so a fleet held for a week says
   * it on the first tick and never again, and a revived lead is told once more and then goes
   * quiet too (`test/watchdog.tick.test.mjs`, *the ONCE is once per LAUNCH*). Neither is a
   * reminder anyone can wait for. Repairing the file is the fix. This is the only thing that
   * keeps saying so.
   *
   * THREE STATES, and the middle one is the state both live fleets are in: no file at all,
   * because no seat has ever been closed. That is healthy and must not read like corruption —
   * "you have not closed a seat yet" and "your pool file is corrupt" have different remedies.
   *
   * A file that EXISTS and will not open is a FAIL, not unobserved. The content was not read,
   * but the consequence is not in doubt: `readSeatState` returns UNREADABLE for an EACCES
   * exactly as it does for a torn one, so rotation is definitely stalled. Unobserved here is
   * reserved for the probe — absent, or thrown. The same ruling `mcp enumeration readable`
   * makes of an unparseable `.claude.json`.
   */
  check('seat pool state readable', 'seatPool', 'state/seats.json, the rotation pool', (got) => {
    const what = 'state/seats.json, the rotation pool';
    if (got === null || typeof got !== 'object' || Array.isArray(got)) {
      return [false, `${what} — the seatPool probe returned ${shown(got)}, not {state, path}`];
    }
    const at = typeof got.path === 'string' && got.path !== '' ? got.path : '<unknown path>';
    if (got.state === 'absent') {
      return [true, `${at} does not exist — no seat has been closed yet, so every configured seat is open. That is the normal state of a seated fleet before its first rotation, not a missing file.`];
    }
    if (got.state === 'rows') {
      const n = (v) => (Number.isInteger(v) && v >= 0 ? v : '?');
      return [true, `${at}: ${n(got.rows)} rows, ${n(got.closed)} closed, ${n(got.unverified)} unverified`];
    }
    if (got.state === 'torn' || got.state === 'unreadable') {
      return [false, `${got.why ?? at} — the pool cannot be read, so seats.pick() answers null and NO lead can rotate.`
        + " The watchdog says ROTATION_UNAVAILABLE {why:'seats_unreadable'} once per lead per LAUNCH — a fleet nobody"
        + ' restarts is told on the first tick and then goes quiet for ever — so this line is the only thing that will'
        + ' keep telling you. The bytes are left exactly as they are so the'
        + ` faulty row can be repaired by hand; deleting ${at} also works, and forgets every live closure — reopening seats`
        + ' the fleet closed for a reason.'];
    }
    return [false, `${what} — the seatPool probe answered state ${shown(got.state)}, which is none of absent/rows/torn/unreadable`];
  });

  // --- per-repo reachability ----------------------------------------------------------
  const repos = observe(probe, 'repos');
  if (repos.absent) push('repos readable', null, 'soma.json repos — not observed (no repos probe)');
  else if (repos.failed) push('repos readable', false, `soma.json could not be read: ${repos.failed}`);
  else if (repos.got === null || typeof repos.got !== 'object') push('repos readable', false, `the repos probe returned ${shown(repos.got)}`);
  else {
    const names = Object.keys(repos.got);
    push('repos readable', true, names.length ? `${names.length} repos configured: ${names.join(', ')}` : '0 repos configured — nothing to fetch-probe');
    for (const name of names) {
      const r = repos.got[name];
      push(`repo ${name} base reachable`, r?.ok === true, typeof r?.detail === 'string' ? r.detail : shown(r));
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- the report */

/**
 * Body label. Compared `=== true` / `=== false` rather than keyed on `String(r.ok)`, which
 * rendered the STRING `'true'` as `ok  ` in the body while the summary counted it unobserved —
 * one report disagreeing with itself about whether an assertion held. Unreachable from
 * `checks()` (it only ever emits `true`/`false`/`null`, verified at every push site), which is
 * exactly why it would have gone on being true until the day it wasn't.
 */
const label = (ok) => (ok === true ? 'ok  ' : ok === false ? 'FAIL' : '????');

/**
 * Render a result list for a human.
 *
 * Three states in the body and three counts in the summary, because the operator's next
 * move differs. The failed and unobserved checks are NAMED in the summary rather than left
 * to be found by scanning: a report whose only summary is a number is one an operator stops
 * reading. And the last line says out loud that an unobserved check is not a pass, because
 * every silent-failure defect this module exists for looked like coverage first.
 */
export function formatDoctor(results) {
  if (!Array.isArray(results)) return 'doctor: ERROR — no results to report; nothing was checked\n';
  const body = results.map((r) => `${label(r?.ok)} ${r?.name} — ${r?.detail}\n`).join('');
  const failed = results.filter((r) => r?.ok === false).map((r) => r.name);
  const unobserved = results.filter((r) => r?.ok !== true && r?.ok !== false).map((r) => r.name);
  if (failed.length === 0 && unobserved.length === 0) {
    return `${body}doctor: PASS — all ${results.length} checks hold on this machine\n`;
  }
  // **NOT `PASS` when something went unobserved.** PASS is the word an operator skims, and
  // `doctor: PASS — 0 of 1 checks hold, 1 unobserved` is this module's own defect in this
  // module's own summary line. INCOMPLETE says the one thing the operator needs: some
  // assertion did not run. `runDoctor` still returns `true` — see its doc for why unobserved
  // must not refuse a machine — so the word is the only thing that changes.
  const head = failed.length === 0
    ? `doctor: INCOMPLETE — ${results.length - unobserved.length} of ${results.length} checks hold`
    : `doctor: FAIL — ${failed.length} of ${results.length} checks failed`;
  return `${body}${head}${unobserved.length ? `, ${unobserved.length} unobserved` : ''}\n`
    + (failed.length ? `  failed: ${failed.join(', ')}\n` : '')
    + (unobserved.length ? `  unobserved: ${unobserved.join(', ')}\n` : '')
    + (unobserved.length ? '  (unobserved is not a pass — those assertions did not run; re-run where they can be taken)\n' : '');
}

/* -------------------------------------------------------------------------- the probes */

/**
 * Run `argv` and return its stdout, or `null` if it failed for any reason.
 *
 * **`null` MEANS "COULD NOT RUN", AND NOTHING MAY COLLAPSE IT.** Absent binary, non-zero
 * exit and the 20 s timeout are one value here on purpose — the caller cannot tell them
 * apart and must not pretend to. So: **never `?? ''` or `?? 0` a `tryRun` result into a
 * check's subject.** That exact line shipped on `ghPrCreateHelp` and made the draft-negation
 * check report health on a help text it had never read; see the module header. A probe whose
 * command did not run returns `null`, which `defaultProbes` documents as UNOBSERVED, and the
 * check says so. The two callers that legitimately reduce a `null` are `claudePing` and
 * `ghAuth`, where "the command failed" IS the observation being taken.
 */
const tryRun = (file, args, opts = {}) => {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'], ...opts });
  } catch {
    return null;
  }
};

const firstMatch = (text, re) => (typeof text === 'string' ? (re.exec(text)?.[0] ?? null) : null);

/** Parse a JSON file, or `null` if it is absent or unreadable. `throwOn` re-raises instead. */
const readJson = (fp) => {
  try {
    const v = JSON.parse(readFileSync(fp, 'utf8'));
    // `!Array.isArray` for the same reason `pair()` needs it: an array is `typeof 'object'`,
    // carries no `permissions`, and would be handed on as a readable settings file.
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

/** Is `pid` a process that exists right now? */
const pidLive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else — which is still ALIVE, and reading
    // it as dead is precisely how a sweep deletes a peer's in-flight scratch file.
    return err?.code === 'EPERM';
  }
};

/**
 * The real probe set.
 *
 * Exported so the cheap half can be exercised for real in a unit test rather than only
 * through injected doubles. That matters here more than usual: the probe wiring is where a
 * doctor silently stops observing, and the original sketch of this module wired five checks
 * to a literal `() => true` — five checks that could not fail, in the module whose whole
 * job is finding checks that cannot fail.
 *
 * Anything unobservable returns `null` (→ an UNOBSERVED check), never `true`.
 */
/**
 * WHICH row or field made `readSeatState` refuse `state/seats.json`, mirroring its validation.
 *
 * Only ever called after `readSeatState` has already said UNREADABLE, so it never decides
 * anything — it locates. The final return is the honest answer when this reader and production's
 * validator disagree: a confident wrong location sends an operator to repair a row that is fine.
 */
const locateSeatFault = (raw, fp) => {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return `${fp} is not valid JSON: ${reason(e)}`;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return `${fp} does not hold a JSON object`;
  if (!Array.isArray(parsed.seats)) return `${fp}: "seats" is ${shown(parsed.seats)}, not an array`;
  for (const [i, r] of parsed.seats.entries()) {
    const at = `${fp}: seats[${i}]`;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) return `${at} is ${shown(r)}, not an object`;
    if (typeof r.config_dir !== 'string' || r.config_dir === '') return `${at}.config_dir is ${shown(r.config_dir)} — every row needs a non-empty config_dir`;
    if (r.closed_until !== undefined && !(Number.isFinite(r.closed_until) && r.closed_until >= 0)) {
      return `${at} (${r.config_dir}) closed_until is ${shown(r.closed_until)} — must be a finite epoch-ms number >= 0`;
    }
    if (r.unverified !== undefined && typeof r.unverified !== 'boolean') {
      return `${at} (${r.config_dir}) unverified is ${shown(r.unverified)} — must be a boolean`;
    }
  }
  return `${fp} was refused by readSeatState, but this reader found no faulty row — the two validations have drifted apart, so repair it by reading the file rather than by trusting this line`;
};

/** `true` a directory, `false` absent or not one, `null` the stat itself failed — nothing known. */
const dirState = (dir) => {
  try {
    return statSync(dir).isDirectory();
  } catch (e) {
    return e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? false : null;
  }
};

/**
 * `true` the file is there, `false` it is not, `null` the stat itself failed — nothing known.
 *
 * The companion `dirState` keeps for a directory. It exists because `seats.loggedIn` answers
 * `null` for a `.claude.json` that is ABSENT and for one that would not open, and those are
 * different findings for an operator even though the watchdog treats them alike.
 */
const fileState = (fp) => {
  try {
    statSync(fp);
    return true;
  } catch (e) {
    return e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? false : null;
  }
};

/** `{path}` or `{error}` — never a throw and never `''`, which a check would compare as a path. */
const realpathOf = (fp) => {
  try {
    return { path: realpathSync(fp) };
  } catch (e) {
    return { error: `${e?.code ?? reason(e)} on ${fp}` };
  }
};

/**
 * One `.claude.json`'s own MCP server names — top-level `mcpServers` plus every
 * `projects[*].mcpServers`, the two scopes `enumerateUserMcpServers` reads — minus `soma`.
 * ENOENT is a live reading (the file defines nothing) and is marked `absent`; any other
 * failure is `{error}`, because a file that exists and will not open is not "defines nothing".
 *
 * WHEN THE `{error}` ARMS ARE REACHED, measured. For a seat `soma.json` lists they are dead:
 * `seatMcpCoverage` evaluates `union: allPersonalServers()` first, `configFiles` joins
 * `<root>/.claude.json` for EVERY seat root, and `enumerateUserMcpServers` throws `SyntaxError`
 * for an unparseable one, `Error` for a non-object, and rethrows any non-ENOENT read error —
 * so the probe throws and the check FAILs before this function is consulted about that file.
 * That FAIL is the right verdict and is pinned (`assert.throws(() => p.seatMcpCoverage(seats),
 * /not valid JSON/)`). They are reached on the one path where the two lists differ: the seat
 * list `checks()` passes in was read at a different instant from the config the union
 * enumerates, so a pool edited between the two hands this function a seat the union never
 * looked at. There, `{servers: []}` would be "the unreadable file defines nothing" — the exact
 * reading the coverage check exists to refuse — so the arms stay and are pinned through that
 * path in the real-probe test.
 */
const ownMcpServers = (fp) => {
  let raw;
  try {
    raw = readFileSync(fp, 'utf8');
  } catch (e) {
    return e?.code === 'ENOENT' ? { servers: [], absent: true } : { error: `${e?.code ?? reason(e)} on ${fp}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: `${fp} is not valid JSON: ${reason(e)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: `${fp} does not hold a JSON object` };
  const names = new Set();
  const add = (servers) => {
    if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return;
    for (const name of Object.keys(servers)) if (name && name !== '__proto__' && name !== 'soma') names.add(name);
  };
  add(parsed.mcpServers);
  if (parsed.projects !== null && typeof parsed.projects === 'object' && !Array.isArray(parsed.projects)) {
    for (const project of Object.values(parsed.projects)) if (project !== null && typeof project === 'object') add(project.mcpServers);
  }
  return { servers: [...names] };
};

export function defaultProbes(env = process.env) {
  const cfgRoot = () => claudeConfigRoot(env);
  /** The newest `leads/<id>/` — doctor reads whichever lead most recently had files written. */
  const newestLead = () => {
    try {
      const dirs = readdirSync(p('leads'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      let best = null;
      for (const id of dirs) {
        const mtime = statSync(leadDir(id)).mtimeMs;
        if (best === null || mtime > best.mtime) best = { id, mtime };
      }
      return best?.id ?? null;
    } catch {
      return null;
    }
  };
  const leadFile = (base) => {
    const id = newestLead();
    return id === null ? null : readJson(join(leadDir(id), base));
  };
  /** Every `.claude.json` that could be live — the same two candidates settings-gen reads. */
  const configCandidates = () => [...new Set([join(homedir(), '.claude.json'), join(cfgRoot(), '.claude.json')])];

  /**
   * Run `fn` with the state root pointed at a throwaway directory, then restore it.
   *
   * Used only to make the generator write its reference files somewhere the fleet will never
   * look. Restored in a `finally` including on a throw, and the throw is re-raised: a
   * reference that could not be generated is a finding (`enumerateUserMcpServers` refuses an
   * unreadable `.claude.json`, which means every spawn would write a guard file with no
   * personal denies), not something to swallow into a `null`.
   */
  const inScratchRoot = (fn) => {
    const saved = process.env.SOMA_HOME;
    const scratch = mkdtempSync(join(tmpdir(), 'soma-doctor-'));
    try {
      process.env.SOMA_HOME = scratch;
      return fn(scratch);
    } finally {
      if (saved === undefined) delete process.env.SOMA_HOME;
      else process.env.SOMA_HOME = saved;
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  /** What `writeLeadSettings` would publish for a lead spawned right now. */
  const referenceLead = () => inScratchRoot((scratch) => {
    mkdirSync(join(scratch, 'leads', 'doctor-reference'), { recursive: true });
    return readJson(writeLeadSettings('doctor-reference'));
  });
  /**
   * Every personal MCP server across both config roots AND every seat in soma.json — the list
   * the spawner writes guard files from (`spawn.launch` → `seatRoots(cfg)`), so the drift
   * probe and the reference guard file below are built from the identical enumeration. The
   * fixed pair is read from `env`, this function's parameter, not `process.env`: `checks(env,
   * probe)` is handed one environment, and a probe that answered about the doctor process's
   * own root would report drift on a fleet root it was never asked about.
   */
  const allPersonalServers = (cfg = loadConfig()) => enumerateUserMcpServers(homedir(), env, { roots: seatRoots(cfg) });
  /** What `writeWorktreeGuardrails` would publish into a fresh worktree right now. */
  const referenceGuard = () => {
    // All three read BEFORE the state root is swapped for the scratch one: inside
    // `inScratchRoot`, `loadConfig()` finds no soma.json and answers with no seats and an empty
    // allowlist — a reference that reports "unexpected: mcp__<seat server>" and "missing:
    // mcp__<allowlisted server>" on every worktree the live spawner wrote correctly.
    // ONE read of soma.json for all three, not three: two reads could straddle a write and
    // hand the writer denies from one pool and a refusal counted against another — the shape
    // below, in miniature.
    const cfg = loadConfig();
    const mcpDenies = allPersonalServers(cfg);
    const teammateAllow = cfg.teammate_mcp_allow ?? [];
    const roots = seatRoots(cfg);
    return inScratchRoot((scratch) => {
      const wt = join(scratch, 'reference-worktree');
      mkdirSync(wt, { recursive: true });
      // `home`/`env`/`roots` as well as the denies, so the writer's own empty-`mcpDenies`
      // refusal enumerates the SAME machine-view the denies came from. Without them it
      // re-enumerated from `process.env`: on a fleet root with no servers and a doctor process
      // whose own root has some, `mcpDenies` was legitimately `[]`, the refusal fired about a
      // root nobody asked about, and `worktree guard file readable` read FAIL on a healthy
      // fleet. `checks(env, probe)` is handed one environment; every answer must be about it.
      return readJson(writeWorktreeGuardrails(wt, { mcpDenies, teammateAllow, home: homedir(), env, roots }));
    });
  };

  /**
   * Every worktree soma has created, as `{dir, guard}` — or `null` when there is no
   * `worktrees/` root at all, which is a cold machine and not a finding.
   *
   * ONE definition of "a worktree", shared by `guardFile` (which reads the newest guard file,
   * the one the next teammate inherits) and `worktreeGuards` (which asks whether every
   * worktree still HAS one). Two walks would be two definitions, and this is precisely the
   * pair that must not disagree: one decides which file the content checks judge, the other
   * decides whether a file is missing. An unreadable repo directory is skipped rather than
   * thrown, because a report that dies on one bad directory reports nothing.
   */
  const eachWorktree = () => {
    let repos;
    try {
      repos = readdirSync(p('worktrees'), { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return null;
    }
    const out = [];
    for (const repo of repos) {
      let tasks;
      try {
        tasks = readdirSync(join(p('worktrees'), repo.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const task of tasks) {
        if (!task.isDirectory()) continue;
        const dir = join(p('worktrees'), repo.name, task.name);
        out.push({ dir, guard: join(dir, '.claude', 'settings.local.json') });
      }
    }
    return out;
  };

  return {
    nodeMajor: () => Number(process.versions.node.split('.')[0]),
    tmuxVersion: () => firstMatch(tryRun('tmux', ['-V']), /\d+\.\d+[a-z]?/) ?? 'not installed',
    gitVersion: () => firstMatch(tryRun('git', ['--version']), /\d+\.\d+\.\d+/) ?? 'not installed',
    // The only way to prove AUTH rather than presence. Kept cheap and given a hard timeout;
    // a failure here is a fleet that spawns leads which cannot start.
    claudePing: () => tryRun('claude', ['-p', 'ping', '--model', 'sonnet'], { timeout: 120000 }) !== null,
    /**
     * The cd-compound probe: the exact shape Claude Code 2.1.259 stopped 79 leads on, run ONCE
     * with haiku (~15 s, ~$0.02) so a build that asks under bypass is caught here and not by a lead
     * sitting on the prompt for 40 hours. Everything about it is throwaway and pinned: a mkdtemp
     * holding `cwd/` and `other/y.txt` (a SIBLING — the model silently drops a `cd` to its own cwd,
     * so a probe of that shape measures nothing), a `--settings` file carrying the one `Read()` deny
     * that arms the check (leads carry 13), `--setting-sources project,local` so the operator's
     * user-level hooks and rules stay out of the measurement, `--strict-mcp-config` so no MCP
     * server is mounted, and the lead's own `--permission-mode acceptEdits
     * --dangerously-skip-permissions` pair (measured: the second wins, the hook sees
     * `bypassPermissions`). The instruction is the one that kept haiku and sonnet from
     * "helpfully" rewriting the command in 15 of 15 probes.
     *
     * Returns the parsed stream-json frames, or `null` when claude printed nothing parseable —
     * which `checks` reads as NOT OBSERVED, never as a pass. A non-zero exit still hands over the
     * frames it did print (`e.stdout`), because an unanswerable ask ends the turn cleanly and it
     * is the transcript, not the exit code, that carries the verdict.
     */
    cdCompoundRead: () => {
      const dir = mkdtempSync(join(tmpdir(), 'soma-doctor-cd-'));
      try {
        const cwd = join(dir, 'cwd');
        const other = join(dir, 'other');
        mkdirSync(cwd);
        mkdirSync(other);
        writeFileSync(join(other, 'y.txt'), 'x\n');
        const settings = join(dir, 'settings.json');
        writeFileSync(settings, JSON.stringify({ permissions: { deny: ['Read(~/.ssh/**)'] } }));
        const command = `cd ${other} && grep -n x y.txt`;
        const prompt = 'This is a harness test of how the Bash tool handles a leading cd. Call the Bash tool EXACTLY ONCE with this exact command string, byte for byte. Do NOT remove the cd even if it looks redundant, do NOT change relative paths to absolute ones, do NOT add quotes:\n'
          + `${command}\n`
          + 'If the tool refuses, errors, or asks for permission, do NOT retry and do NOT run any other command. Reply with the tool result text verbatim, then on a new line write DONE.';
        const argv = ['-p', '--model', 'haiku', '--permission-mode', 'acceptEdits', '--dangerously-skip-permissions',
          '--setting-sources', 'project,local', '--strict-mcp-config', '--settings', settings,
          '--output-format', 'stream-json', '--verbose', '--', prompt];
        let out = '';
        try {
          out = execFileSync('claude', argv, { cwd, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (e) {
          out = typeof e?.stdout === 'string' ? e.stdout : '';
        }
        const events = [];
        for (const line of out.split('\n')) {
          const t = line.trim();
          if (t === '') continue;
          try { events.push(JSON.parse(t)); } catch { /* not a frame */ }
        }
        return events.length ? events : null;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    ghAuth: () => tryRun('gh', ['auth', 'status']) !== null,
    // NOT `() => true`. Whether dynamic workflows are available to a *spawned* lead is a
    // named bring-up experiment and no local file answers it. `null` → UNOBSERVED.
    workflowsEnabled: () => null,
    notifier: () => {
      const isWsl = process.platform === 'linux' && /microsoft/i.test(tryRun('uname', ['-r']) ?? '');
      const want = process.platform === 'darwin' ? 'osascript' : isWsl ? 'powershell.exe' : 'notify-send';
      const found = tryRun('sh', ['-c', `command -v ${want}`]);
      return { ok: found !== null, detail: found === null ? `${want} not found on PATH` : `${want} at ${found.trim()}` };
    },
    repos: () => {
      const repos = loadConfig().repos ?? {};
      const out = {};
      for (const [name, r] of Object.entries(repos)) {
        const path = typeof r?.path === 'string' ? r.path : null;
        const base = typeof r?.base_branch === 'string' ? r.base_branch : null;
        if (path === null || base === null) { out[name] = { ok: false, detail: 'soma.json entry lacks path or base_branch' }; continue; }
        if (!existsSync(path)) { out[name] = { ok: false, detail: `${path} does not exist` }; continue; }
        const r2 = tryRun('git', ['-C', path, 'fetch', '--dry-run', 'origin', base], {
          timeout: 60000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' },
        });
        out[name] = { ok: r2 !== null, detail: r2 !== null ? `origin/${base} reachable from ${path}` : `git fetch --dry-run origin ${base} failed in ${path}` };
      }
      return out;
    },
    leadMcpServers: () => {
      const j = leadFile('mcp.json');
      return j === null ? null : Object.keys(j.mcpServers ?? {});
    },
    /**
     * `{servers, read, unreadable}` — and the last two exist so the check can tell "this
     * machine has no soma bus in user scope" from "I could not open the file that would say".
     *
     * A file that is simply ABSENT is a live reading: it defines no MCP server, so it cannot
     * hand a lead an orchestrator bus. A file that EXISTS and will not parse is not a reading
     * at all, and it used to produce the same `[]` — a green recursion guard over an
     * unreadable config. `existsSync` is what separates them, because `readJson` folds ENOENT
     * and a SyntaxError into one `null` on purpose.
     *
     * Each server is `{name, runsBus, root}`, not a bare name, so the check can tell the
     * registration `soma init` writes on purpose (runs soma-bus.mjs, SOMA_HOME pinned — how a
     * promoted operator session drives the fleet) from the two real findings: a pin-less
     * registration, and a soma-shaped server that runs something else entirely.
     */
    userScopeSomaServers: () => {
      const found = new Map();
      const read = [];
      const unreadable = [];
      for (const fp of configCandidates()) {
        const j = readJson(fp);
        if (j === null) {
          if (existsSync(fp)) unreadable.push(fp);
          continue;
        }
        read.push(fp);
        for (const [name, def] of Object.entries(j.mcpServers ?? {})) {
          // By name, and by what it runs: a server called anything at all whose command
          // points at soma's bus is an orchestrator surface.
          if (name !== 'soma' && !JSON.stringify(def ?? null).includes('soma-bus')) continue;
          const words = [def?.command, ...(Array.isArray(def?.args) ? def.args : [])];
          const runsBus = words.some((w) => typeof w === 'string' && /(^|[/\\])soma-bus\.mjs$/.test(w));
          const root = typeof def?.env?.SOMA_HOME === 'string' && def.env.SOMA_HOME !== '' ? def.env.SOMA_HOME : null;
          // Keyed on the whole shape: one name registered differently in the two config
          // files is two observations, and collapsing them would hide the one that fails.
          found.set(`${name}|${runsBus}|${root}`, { name, runsBus, root });
        }
      }
      return { servers: [...found.values()], read, unreadable };
    },
    /**
     * `{live, reference}` — the lead's real settings file, plus what the generator writes now.
     *
     * The reference is generated into a THROWAWAY state root, which is why `SOMA_HOME` is
     * swapped around the call and restored in a `finally`. `writeLeadSettings` publishes into
     * `leads/<id>/`, and a stray `leads/doctor-probe/` in the real root is not a harmless
     * artefact: `newestLead()` above would then read it in preference to a real lead, and the
     * watchdog's reconcile pass would see a lead directory with no fleet row. Doctor is
     * synchronous and single-threaded, so the swap cannot be observed by anything else in
     * this process.
     */
    leadSettings: () => {
      const id = newestLead();
      const fp = id === null ? null : join(leadDir(id), 'settings.json');
      const live = fp === null ? null : readJson(fp);
      return { live, reference: referenceLead(), brokenPath: fp !== null && live === null && existsSync(fp) ? fp : null };
    },
    /**
     * Is the script a `PreToolUse` command names really on disk?
     *
     * A predicate rather than a boolean, because the paths come out of the settings files
     * being judged and there can be several. It is injected rather than closed over so a
     * test can drive "the command points at a script that is not there" — the spelling of
     * an inert gate that produced `doctor: PASS — all 39 checks hold` before doctor read a
     * hook's command, and the one the module header at `:16` has always claimed to check.
     */
    hookScriptExists: () => (fp) => typeof fp === 'string' && fp !== '' && existsSync(fp),
    /**
     * `{live, reference}` — the newest worktree's guard file (the one the next teammate in it
     * inherits), plus what the generator writes now for a fresh worktree.
     */
    guardFile: () => {
      const worktrees = eachWorktree();
      let best = null;
      // `null` (no `worktrees/` root) and `[]` (a root holding nothing) are the SAME answer for
      // this probe — there is no live file either way, and the reference is what the checks
      // judge. `every worktree guard file carries rules` is the check that tells them apart.
      // This is not a fallback on a probe result; see the module header on that.
      for (const { guard } of worktrees === null ? [] : worktrees) {
        if (!existsSync(guard)) continue;
        let mtime;
        try {
          mtime = statSync(guard).mtimeMs;
        } catch {
          continue;
        }
        if (best === null || mtime > best.mtime) best = { fp: guard, mtime };
      }
      const found = best === null ? null : best.fp;
      const live = found === null ? null : readJson(found);
      return { live, reference: referenceGuard(), brokenPath: found !== null && live === null ? found : null };
    },
    /**
     * Every worktree, and whether its guard file is THERE and carries deny rules.
     *
     * `rules` rather than only `bytes`, because the hazard is fail-open and `{}` fails open
     * exactly as hard as a zero-byte file — measured, an MCP server loaded and fired in a
     * zero-byte-guard cwd. Bytes are reported alongside because `0 bytes` is the spelling an
     * operator recognises. `null` when there is no `worktrees/` root: nothing to observe, and
     * an empty list would pass vacuously.
     */
    worktreeGuards: () => {
      const worktrees = eachWorktree();
      if (worktrees === null) return null;
      return worktrees.map(({ dir, guard }) => {
        let bytes = null;
        try {
          bytes = statSync(guard).size;
        } catch {
          bytes = null;                          // absent, or not a file we can stat at all
        }
        const j = bytes === null ? null : readJson(guard);
        return { worktree: dir, path: guard, bytes, rules: Array.isArray(j?.permissions?.deny) ? j.permissions.deny.length : 0 };
      });
    },
    /**
     * The argv the spawner would build for a lead started right now.
     *
     * `buildLeadArgv` is pure: it touches no disk, spawns nothing, and its arguments only have
     * to satisfy its own refusals — nothing here is read back, and no `leads/doctor-probe/`
     * directory is created (which would make `newestLead()` above prefer a probe over a real
     * lead, the trap `referenceLead` uses a throwaway state root to avoid).
     */
    leadArgv: () => buildLeadArgv({
      id: 'doctor-probe',
      sessionUuid: 'doctor-probe',
      brief: 'doctor probe — never launched',
      settingsPath: '/doctor-probe/settings.launch.json',
      mcpPath: '/doctor-probe/mcp.json',
      standingPath: '/doctor-probe/standing.md',
    }),
    // Both config roots AND every seat — the production path, and the one a guard file is
    // written from. Passing one root reports drift on every worktree, and so would omitting
    // the seats: the spawner writes every guard file from `seatRoots(cfg)`. The seat
    // probes read this same probe for their coverage check; none of them re-enumerates.
    mcpServers: () => allPersonalServers(),
    teammateAllow: () => loadConfig().teammate_mcp_allow ?? [],
    /**
     * The seat pool as `soma.json.seats` declares it, each config_dir stat'ed. `exists` is
     * `true` (a directory), `false` (absent, or a file), or `null` — the stat itself failed,
     * EACCES on a parent, so nothing is known and the check reads it as unobserved. `loadSeats`
     * throws on a malformed entry (`config_dir: ''`), and the throw IS the finding, the way an
     * unparseable `.claude.json` is `mcp enumeration readable`'s.
     */
    seats: () => loadSeats(loadConfig()).map((s) => ({ label: s.label, config_dir: s.config_dir, exists: dirState(s.config_dir) })),
    /**
     * `seats.loggedIn` per seat: a file read, never an API call, and `null` when it could not be
     * read. `configFile` SPLITS that null, because `loggedIn` folds two states into one — ENOENT
     * (there is no `.claude.json`, so this seat was never logged in) and EACCES or a corrupt file
     * (the reading did not happen). The watchdog wants the fold: it marks either seat unverified
     * and never picks it. An operator does not — the first is the likeliest provisioning mistake
     * there is, a `soma.json.seats` entry added without ever running `soma init --seat`, and it
     * is a finding, not an unobserved line that leaves `soma doctor` exiting 0.
     */
    seatsLoggedIn: (seats) => seats.map((s) => ({
      label: s.label,
      config_dir: s.config_dir,
      loggedIn: loggedIn(s.config_dir),
      configFile: fileState(join(s.config_dir, '.claude.json')),
    })),
    /**
     * `realpath` of the fleet's `projects/` — the tree the token meter reads and `claude --resume`
     * searches — beside every seat's. A shared symlink resolves to one path; `{error}` where
     * realpath threw, which the check reads as unobserved, never as "not shared".
     */
    seatProjects: (seats) => ({
      fleet: realpathOf(join(cfgRoot(), 'projects')),
      seats: seats.map((s) => ({ label: s.label, config_dir: s.config_dir, projects: realpathOf(join(s.config_dir, 'projects')) })),
    }),
    /**
     * `union` is `allPersonalServers()` — the closure above, the production enumeration
     * (`spawn.launch` → `enumerateUserMcpServers(…, { roots: seatRoots(cfg) })`) that the
     * `mcpServers` probe and the reference guard file are also built from — beside each seat's
     * OWN servers read straight from its `.claude.json`. One enumeration, deliberately not a
     * second one built here from `seats`: this check exists to catch production reading fewer
     * roots than the pool has, and a union computed from this probe's own argument would pass
     * while production's did not. `soma` is dropped from `own` for the reason the enumeration
     * drops it: `soma init --seat` registers the bus in every seat and it must never be denied.
     */
    seatMcpCoverage: (seats) => ({
      union: allPersonalServers(),
      seats: seats.map((s) => ({ label: s.label, config_dir: s.config_dir, own: ownMcpServers(join(s.config_dir, '.claude.json')) })),
    }),
    /**
     * `state/seats.json` as it is on disk. Lock-free: `readSeatState` takes no fleet lock (only
     * `mutateSeats` does), so `soma doctor` cannot block behind a watchdog tick.
     *
     * THE VERDICT IS PRODUCTION'S OWN, ON EVERY PATH. Whether the pool is usable is decided by
     * `readSeatState` — the same call `pick()` makes — so doctor can never say "fine" about a
     * file rotation refuses, or the reverse. The bytes below only LOCATE the fault for the
     * report, and when locator and validator disagree it says THAT rather than inventing a
     * location.
     *
     * Two reads of one file, and NOTHING returns before the second: the earlier shape asked the
     * bytes first and returned `absent` on their ENOENT without ever consulting production, so a
     * publish landing between the two reads — the fleet's first seat closure, or an outside edit
     * — printed the ok line "no seat has been closed yet" about a pool `pick()` was already
     * refusing (measured by hand-driving the interleave; see the fix report). The remaining
     * staleness is one publish wide and can only make the located row or the row COUNT old: it
     * cannot turn a FAIL into an ok, because the verdict is the later read.
     */
    seatPool: () => {
      const fp = seatsPath();
      let raw = null;
      let readErr = null;
      try {
        raw = readFileSync(fp, 'utf8');
      } catch (e) {
        readErr = e;
      }
      const verdict = readSeatState();
      if (verdict.unreadable === true) {
        // Refused by production. The bytes say WHERE; without them all that can be said is why
        // they could not be read — and an ENOENT here means the file changed between the reads,
        // not that there is no pool (`readSeatState` answers `{seats: []}`, not UNREADABLE, for
        // a file that is simply absent).
        if (raw !== null) return { state: 'torn', path: fp, why: locateSeatFault(raw, fp) };
        return {
          state: 'unreadable',
          path: fp,
          why: `${readErr?.code ?? reason(readErr)} on ${fp}${readErr?.code === 'ENOENT'
            ? ' — absent when this report read it and refused by readSeatState a moment later, so the pool changed mid-read and what is in it now was never seen; re-run `soma doctor`'
            : ''}`,
        };
      }
      // Usable. `readSeatState` answers `{seats: []}` for a missing file and for a file holding
      // no rows alike; the ENOENT of the read above is what tells those two apart, and the two
      // have different sentences because they have different remedies. It chooses between two
      // OK lines and never between ok and FAIL.
      if (verdict.seats.length === 0 && readErr?.code === 'ENOENT') return { state: 'absent', path: fp };
      return {
        state: 'rows',
        path: fp,
        rows: verdict.seats.length,
        closed: verdict.seats.filter((s) => Number.isFinite(s?.closed_until) && s.closed_until > 0).length,
        unverified: verdict.seats.filter((s) => s?.unverified === true).length,
      };
    },

    claudeConfig: () => {
      const home = homedir();
      const root = cfgRoot();
      return {
        home,
        root,
        file: claudeConfigFile(home, env),
        override: Boolean(env?.CLAUDE_CONFIG_DIR),
        rootExists: existsSync(root),
      };
    },
    harnessCount: () => Object.keys(loadHarnesses()).length,
    // NO `?? ''`. See the module header: that fallback made every gh-less machine report the
    // draft-only guarantee intact. `null` is what "could not read the help" is called here.
    ghPrCreateHelp: () => tryRun('gh', ['pr', 'create', '--help']),
    /**
     * The node a LEAD's PATH resolves to — not the one running doctor.
     *
     * `process.version` is the wrong subject: doctor is usually launched from a shell with
     * nvm active, while the risk is a lead whose PATH resolves `node` to the machine
     * default. Resolved through `env.PATH` because that is the value a lead inherits (the
     * spawner's `env -i` allowlist forwards PATH, and `tmux.mjs` has a precondition on it),
     * and via `sh -c` so the lookup is unambiguously the PATH's and not this process's.
     */
    leadNode: () => {
      const out = tryRun('sh', ['-c', 'command -v node && node -v'], { env: { PATH: env?.PATH ?? '' } });
      if (out === null) return null;
      const [path, version] = out.trim().split('\n');
      return path && version ? { path: path.trim(), version: version.trim() } : null;
    },
    enginesNode: () => String(readJson(new URL('../../package.json', import.meta.url))?.engines?.node ?? ''),
    /** The `session_id` of the most recent hook payload soma recorded, if any. */
    hookSessionId: () => {
      const j = readJson(p('state', 'last-hook-payload.json'));
      return typeof j?.session_id === 'string' ? j.session_id : null;
    },
    somaHome: () => SOMA_HOME(),
    tripPath: (id) => tripPath(id),
    /**
     * The budget breaker, measured end to end: the REAL hook process, a scratch state root,
     * the exact flag the writer would write. `{withFlag, withoutFlag}` — each the hook's raw
     * stdout, judged by the check, never here.
     *
     * A behavioural probe rather than a source read, because the gate is dependency-free by
     * design: it must NOT import `tripPath`/`leadDir`, so no text assertion about helpers can
     * distinguish "derives the same root" from "derives its own, differently" — and the text
     * assertion this replaced failed every correct install. Two spawns (~50 ms together) buy
     * the only claim that matters: the root the writer writes under is the root the reader
     * probes. The env is pinned in full — no HOME, no inherited SOMA_HOME — so the subprocess
     * cannot pass by reading this process's environment, and a throw out of either spawn is
     * the check's FAIL, not doctor's crash (`observe` catches it).
     */
    gateBudgetProbe: () => {
      const scratch = mkdtempSync(join(tmpdir(), 'soma-doctor-gate-'));
      try {
        const id = 'doctor-gate-probe';
        mkdirSync(join(scratch, 'leads', id), { recursive: true });
        const gateScript = fileURLToPath(new URL('../hooks/lead-gate.mjs', import.meta.url));
        const input = JSON.stringify({ session_id: 'doctor-gate-probe', tool_name: 'Bash', tool_input: { command: 'echo doctor probe' } });
        const run = () => execFileSync(process.execPath, [gateScript], {
          input,
          encoding: 'utf8',
          timeout: 20000,
          stdio: ['pipe', 'pipe', 'ignore'],
          env: { SOMA_HOME: scratch, SOMA_LEAD_NAME: id, SOMA_HOOK_TIMEOUT_MS: '5000' },
        });
        writeFileSync(join(scratch, 'leads', id, 'BUDGET_TRIPPED'), 'written by soma doctor, into a scratch root, to watch the real gate find it\n');
        const withFlag = run();
        rmSync(join(scratch, 'leads', id, 'BUDGET_TRIPPED'));
        const withoutFlag = run();
        return { withFlag, withoutFlag };
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    /**
     * Every `<file>.<pid>.tmp` under the state root, with pid liveness.
     *
     * Liveness is not optional even for a read-only report: the house publish idiom names
     * its scratch after the writer's pid precisely so a peer's in-flight file can be told
     * from a crashed publish's debris, and calling a live peer's scratch "stale" is the
     * first step to someone removing it and turning that peer's lock proof into a false
     * timeout.
     */
    scratchFiles: () => {
      const files = [];
      // Every directory the sweep could NOT open, so the check can refuse to say "0 stale"
      // about a tree it did not read. ENOENT is excluded deliberately: a directory that is
      // gone holds no scratch files, and counting a lost race as "unreadable" would make this
      // check flap to UNOBSERVED on a busy fleet for no finding at all.
      const unreadable = [];
      const walk = (dir, depth) => {
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch (e) {
          if (e?.code !== 'ENOENT') unreadable.push(`${dir} (${e?.code ?? reason(e)})`);
          return;
        }
        for (const entry of entries) {
          const fp = join(dir, entry.name);
          if (entry.isDirectory()) { if (depth > 0) walk(fp, depth - 1); continue; }
          const m = /\.(\d+)\.tmp$/.exec(entry.name);
          if (m === null) continue;
          const pid = Number(m[1]);
          files.push({ path: fp, pid, live: pidLive(pid) });
        }
      };
      walk(SOMA_HOME(), 3);
      return { files, unreadable };
    },
  };
}

/**
 * Run every check and report. Returns `true` when NO check failed.
 *
 * A strict boolean, for the reason `runCanary` returns one: the caller writes
 * `if (!await runDoctor()) return`, and a richer object would make that check pass on the
 * object's truthiness. A caller that needs the detail calls `checks` and `formatDoctor` —
 * the same path this takes.
 *
 * An UNOBSERVED check does not refuse the machine. It cannot: doctor is normally run from a
 * plain shell, where the in-session readings genuinely cannot be taken, and refusing there
 * would train an operator to ignore the one command that can see a silent breaker. It is
 * loud instead — its own label in the body, its own line in the summary, and a sentence
 * saying it is not a pass.
 *
 * `write` defaults to `process.stdout` — see the module header for the hazard that carries
 * inside the bus process, and for why stderr is deliberately not captured.
 */
export async function runDoctor({ env = process.env, probe = null, write = (text) => process.stdout.write(text) } = {}) {
  if (typeof write !== 'function') {
    throw new TypeError('runDoctor: `write` must be a (text) => void writer');
  }
  const results = checks(env, probe ?? defaultProbes(env));
  // A broken writer must not be able to turn a verdict into a crash — an EPIPE on stdout is
  // the ordinary end of `soma doctor | head`.
  try {
    write(formatDoctor(results));
  } catch { /* nothing left to report it to */ }
  return results.every((r) => r.ok !== false);
}
