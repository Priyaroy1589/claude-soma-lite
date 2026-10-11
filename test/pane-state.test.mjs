import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `bin/lib/wd/pane-state.mjs` — the pure pane classifier and the census helper over it.
 *
 * Every frame below is a measured Claude Code screen (2.1.259 / 2.1.263, tmux 3.6a, probe socket
 * `probe-wd`, 2026-09-07), copied byte-for-byte on the lines the classifier reads — the two
 * `────` rules, the composer line, the status line, the dialog block — with only the transcript
 * filler and the absolute paths shortened, and lead names and the AskUserQuestion dialog's texts
 * replaced by placeholders (the layout around them is the measured one). A fixture invented from
 * memory would pin the rule to the author's idea of the screen rather than to the screen.
 *
 * The one property every test here defends: the classifier has THREE kinds of answer, not two.
 * A verdict (`working`/`idle`/`blocked_on_prompt`/`dead_shell`/`dead_pane`), a non-verdict
 * (`unobservable` — the frame could not be read), and a shrug (`unrecognised` — read, matched
 * nothing). Collapsing the second into either of the others is the two-state regression this
 * project keeps shipping, and the tick acts on the first only.
 */
const load = (tag) => import('../bin/lib/wd/pane-state.mjs?' + tag);

const RULE = '─'.repeat(80);
const STATUS_IDLE = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents';
const STATUS_WORKING = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for ag…';
const STATUS_DRAFT = '  ⏵⏵ bypass permissions on (shift+tab to cycle)';
/**
 * The three status-line wordings on the LIVE fleet, 2026-09-07 22:01, copied from the captured
 * screens with the right-aligned `/rc` where it stood:
 *   a lead (2.1.259, socket `soma`)              — the probe's wording plus `/rc`;
 *   the `soma` orchestrator (2.1.263, lease pane %25) — background shells running: NO
 *                                                    `(shift+tab to cycle)` hint at all;
 *   the `soma_pers` orchestrator (2.1.258, pane %1)  — auto mode.
 * The second one read `unrecognised` under a `shift+tab to cycle` match, while idle.
 */
const STATUS_LEAD_LIVE = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents             /rc';
const STATUS_BYPASS_SHELLS = '  ⏵⏵ bypass permissions on · 5 shells, 1 monitor · ← for agents · ↓ to manage                                                                     /rc';
const STATUS_AUTO = '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents                                                                                             /rc';

/** frame 006-idle-clean: the composer is `❯ ` — glyph, one space, nothing — between two rules. */
const IDLE_CLEAN = [
  '',
  ' ▐▛███▛█   Claude Code v2.1.263',
  '▝▜██████▀  Haiku 4.5 · Claude Team',
  '  ▝▝ ▝▝    /…/scratchpad/rr17/wt',
  '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
  RULE,
  '❯ ',
  RULE,
  STATUS_IDLE,
].join('\n');

/** frame 007-working-1: spinner title `◐ Claude Code`, status line carries `esc to interrupt`. */
const WORKING_1 = [
  ' ▐▛███▛█   Claude Code v2.1.263',
  '▝▜██████▀  Haiku 4.5 · Claude Team',
  '  ▝▝ ▝▝    /…/scratchpad/rr17/wt',
  '',
  '',
  '❯ Run exactly this shell command with the Bash tool and nothing else, no',
  '  explanation before or after: cd /tmp/probe/rr17/wt && grep -n x',
  '  somefile.txt',
  '', '', '', '', '', '', '',
  '✶ Envisioning…',
  '',
  RULE,
  '❯ ',
  RULE,
  STATUS_WORKING,
].join('\n');

/** frame 138-probe-v1-PROMPT (2.1.259): THE permission dialog. No composer, no status line. */
const PERMISSION_DIALOG = [
  '  cd: cd /tmp/probe/rr17/wt && grep -n x somefile.txt   Do not',
  '  simplify it, do not drop the cd, do not explain.',
  '',
  '  Running grep in specified directory',
  '  ⎿  $ cd /tmp/probe/rr17/wt && grep -n x somefile.txt',
  '',
  RULE,
  ' Bash command',
  '',
  '   │ cd /tmp/probe/rr17/wt && grep -n x somefile.txt',
  '   Run grep in specified directory',
  '',
  " │ grep on 'somefile.txt' after a cd would search a directory that cannot be",
  ' │ determined here, and a Read() deny rule is configured; only you can approve',
  ' │ running it anyway.',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n');

/** frame 000-trust-dialog: the other blocked shape. Title is still the hostname here. */
const TRUST_DIALOG = [
  '',
  RULE,
  ' Accessing workspace:',
  '',
  ' /tmp/probe/probe-wd/cwd',
  '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your',
  ' own code, a well-known open source project, or work from your team). If not,',
  ' take a moment to review what\'s in this folder first.',
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' Security guide',
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

/**
 * frame 004-after-esc-dead: a DEAD pane whose screen still shows the trust dialog above tmux's
 * own `Pane is dead` line. `pane_dead=1`, `pane_current_command=env`. The dialog text is a decoy
 * here: the pane flag outranks the frame.
 */
const DEAD_PANE_SCREEN = `${TRUST_DIALOG}\n\n\n\n\nPane is dead (status 0, Mon Sep  7 20:33:38 2026)`;

/** frame 079-shell-bare: what tmux-resurrect leaves behind. `pane_dead=0`, `pane_current_command=zsh`. */
const SHELL_BARE = 'host%';

/** frame 191-v2-now: an interrupted turn put its text back in the composer — wrapped over two lines. */
const IDLE_DRAFT = [
  '⏺ somefile.txt:2: x marks the spot',
  '',
  '✻ Crunched for 5s · done 8:49 PM',
  '',
  RULE,
  '❯ Use the AskUserQuestion tool once to ask me a single question: "Which',
  '  colour?" with options Red and Blue. Do nothing else.',
  RULE,
  STATUS_DRAFT,
].join('\n');

/**
 * THE NEGATIVE. A lead's own transcript quoting the dialog — question, options, footer, all at
 * line start where Claude Code indents tool output — above a LIVE idle composer. Every string
 * the dialog rule looks for is on this screen, and the pane is idle.
 */
const QUOTED_DIALOG_ABOVE_COMPOSER = [
  '⏺ The permission dialog on the old build read:',
  '',
  '  Do you want to proceed?',
  '  ❯ 1. Yes',
  '    2. No',
  '',
  '  Esc to cancel · Tab to amend',
  '',
  '✻ Baked for 3s · done 9:01 PM',
  '',
  RULE,
  '❯ ',
  RULE,
  STATUS_IDLE,
].join('\n');

/**
 * The AskUserQuestion dialog: a synthetic frame with the dialog layout measured on Claude Code
 * 2.1.263 — the question and option texts are invented, the structure is the captured one. The
 * composer is gone, the highlighted option carries the `❯` glyph, a rule separates the lead's
 * options from the built-in ones, and the footer is
 * `Enter to select · Tab/Arrow keys to navigate · Esc to cancel` — NOT `Enter to confirm`, which
 * is what this module had inferred. Under that inference the measured frame read `unrecognised`
 * and both send gates typed into it, reporting `delivered: true`.
 */
const QUESTION_DIALOG = [
  '│ The changelog already lists the new flag and its tests pass, but the README',
  '│ still documents the old default, so the two disagree. The fix is one',
  '│ paragraph. May I update the README?',
  '',
  '❯ 1. Yes — update the README',
  '     Rewrite the paragraph so it states the new default and links the changelog.',
  '  2. Yes, but show me the diff first',
  '     Same as above, but I post the diff and wait before committing.',
  '  3. Not yet — leave the README',
  '     I finish the other files and leave this paragraph unchanged.',
  '  4. Type something.',
  RULE,
  '  5. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n');

/**
 * LIVE frame (2.1.259, socket `soma`, 2026-09-07 22:01), the last six rows, with the lead's name
 * replaced by the placeholder `lead-task-2`: every lead is spawned with `--name lead-<id>`
 * (spawn.mjs) and Claude Code draws that name INTO the top rule — `──── lead-task-2 ─`
 * (codepoints … 2d 32 20 2500). The composer is `❯` + U+00A0, not `❯` + space. A plain-rule
 * matcher never found this composer, so `draft` was `null` on every pane of the fleet and
 * `idle_draft` could not fire anywhere; the orchestrator draws the same shape (`… soma-orch ─`).
 */
const NAMED_IDLE_LIVE = [
  '✻ Crunched for 52s · done 3:31 PM',
  '                                        new task? /clear to save 266.7k tokens',
  '─'.repeat(66) + ' lead-task-2 ─',
  '❯\u00a0',
  RULE,
  STATUS_LEAD_LIVE,
].join('\n');
/** The same composer with an unsent draft in it: frame 191's measured draft on the fleet's measured rule. */
const NAMED_DRAFT = [
  '✻ Crunched for 52s · done 3:31 PM',
  '─'.repeat(66) + ' lead-task-2 ─',
  '❯ Use the AskUserQuestion tool once to ask me a single question: "Which',
  '  colour?" with options Red and Blue. Do nothing else.',
  RULE,
  STATUS_LEAD_LIVE,
].join('\n');

/** A live claude pane as `tmux.paneStates` reports it: the version string, never `claude`. */
const claude = (over = {}) => ({ dead: false, cmd: '2.1.263', title: '✳ Claude Code', ...over });

// ─────────────────────────── blocked_on_prompt ───────────────────────────

test('the permission dialog is blocked_on_prompt/permission: the footer and the absent composer decide the verdict, the question line decides the kind', async () => {
  const { classifyPane } = await load('perm-' + Date.now());
  // Measured at the dialog: `pane_title` is `✳ Permission system test` — the SAME glyph as idle —
  // so the title cannot tell blocked from idle; only the frame can.
  const at = classifyPane(claude({ cmd: '2.1.259', title: '✳ Permission system test', frame: PERMISSION_DIALOG }));
  assert.equal(at.fine, 'blocked_on_prompt');
  assert.equal(at.coarse, 'blocked_on_prompt');
  assert.equal(at.kind, 'permission');

  // Two signals decide the verdict, each load-bearing, so the rule is not a single-string grep
  // of the frame: the dialog footer must be there AND the composer status line must not.
  const noFooter = PERMISSION_DIALOG.replace(' Esc to cancel · Tab to amend', ' Tab to amend');
  assert.notEqual(classifyPane(claude({ frame: noFooter })).fine, 'blocked_on_prompt', 'without the footer the dialog is not recognised');
  const withComposer = `${PERMISSION_DIALOG}\n${RULE}\n❯ \n${RULE}\n${STATUS_IDLE}`;
  assert.notEqual(classifyPane(claude({ frame: withComposer })).fine, 'blocked_on_prompt', 'a composer status line on screen means the dialog is not up');
  // The question line is the KIND, not the verdict. Requiring a known question was what let the
  // live AskUserQuestion dialog through as `unrecognised` (its footer says `Enter to select`),
  // and the next dialog wording Claude Code ships would go the same way. A dialog footer with no
  // composer on screen is a dialog whatever it asks; when the classifier cannot name it, it says so.
  const noQuestion = PERMISSION_DIALOG.replace(' Do you want to proceed?', ' (question redacted)');
  const unknown = classifyPane(claude({ frame: noQuestion }));
  assert.equal(unknown.fine, 'blocked_on_prompt', 'a footer with no composer is a dialog even when its question is not known');
  assert.equal(unknown.kind, 'unknown');
  assert.notEqual(unknown.fine, 'unrecognised', 'the critical failure: a dialog read as a shrug, and typed into');
});

test('the AskUserQuestion dialog (layout measured live on 2.1.263) is blocked_on_prompt/question', async () => {
  const { classifyPane, SELECT_FOOTER } = await load('askq-' + Date.now());
  // The title at the dialog is `✳ …` (finished-turn glyph), as at the permission dialog.
  const at = classifyPane(claude({ title: '✳ Claude Code', frame: QUESTION_DIALOG }));
  assert.equal(at.fine, 'blocked_on_prompt');
  assert.equal(at.coarse, 'blocked_on_prompt');
  assert.equal(at.kind, 'question');
  assert.notEqual(at.fine, 'unrecognised', 'read as unrecognised, this frame was typed into with delivered: true');
  // The footer literal is pinned to the screen, not to memory: `Enter to select`, and it is what
  // names the kind. Without it the frame is still a dialog — of a kind the classifier cannot name.
  assert.equal(SELECT_FOOTER, 'Enter to select');
  assert.ok(QUESTION_DIALOG.includes(SELECT_FOOTER));
  const noSelect = QUESTION_DIALOG.replace('Enter to select · Tab/Arrow keys to navigate · ', '');
  assert.equal(classifyPane(claude({ frame: noSelect })).fine, 'blocked_on_prompt');
  assert.equal(classifyPane(claude({ frame: noSelect })).kind, 'unknown');
  // The same dialog quoted in a transcript above a live composer is idle — the corroboration rule.
  const quoted = `${QUESTION_DIALOG}\n${RULE}\n❯ \n${RULE}\n${STATUS_IDLE}`;
  assert.equal(classifyPane(claude({ frame: quoted })).fine, 'idle');
});

test('the trust dialog is blocked_on_prompt/trust even though the title is still the hostname', async () => {
  const { classifyPane } = await load('trust-' + Date.now());
  const at = classifyPane(claude({ title: 'host.local', frame: TRUST_DIALOG }));
  assert.equal(at.fine, 'blocked_on_prompt');
  assert.equal(at.kind, 'trust');
  // `Enter to confirm` with neither the permission question nor the trust header was INFERRED to
  // be the AskUserQuestion dialog. Measured 2026-09-07 on a live lead: that dialog's footer is
  // `Enter to select …` (see QUESTION_DIALOG), so this shape is a dialog of a kind the classifier
  // cannot name — still blocked, never `question`, and never a shrug.
  const other = classifyPane(claude({ frame: TRUST_DIALOG.replace(/Quick safety check/, 'Which colour?') }));
  assert.equal(other.fine, 'blocked_on_prompt');
  assert.equal(other.kind, 'unknown');
});

test('a transcript quoting the dialog above a live composer is idle, not blocked', async () => {
  const { classifyPane } = await load('quoted-' + Date.now());
  // The corroboration discipline `wd/backpressure.mjs` uses against a lead quoting a 429: the
  // operator's backlog contains tickets ABOUT this dialog, so a lead reading or writing about it
  // will put every one of its strings on screen. The composer status line is what settles it.
  const at = classifyPane(claude({ frame: QUOTED_DIALOG_ABOVE_COMPOSER }));
  assert.equal(at.fine, 'idle');
  assert.equal(at.coarse, 'alive');
  assert.equal(at.kind, null);
});

test('the composer status line is the ⏵⏵ mode indicator on the LAST line, in every live wording — including the one with no shift+tab hint', async () => {
  const { classifyPane, COMPOSER_STATUS_RE } = await load('status-' + Date.now());
  const composer = (status) => [RULE, '❯ ', RULE, status].join('\n');
  for (const status of [STATUS_IDLE, STATUS_LEAD_LIVE, STATUS_BYPASS_SHELLS, STATUS_AUTO]) {
    const at = classifyPane(claude({ frame: composer(status) }));
    assert.equal(at.fine, 'idle', status);
    assert.equal(at.coarse, 'alive', status);
    assert.notEqual(at.fine, 'unrecognised', 'an idle pane read as a shrug is typed into with a warning every time — the warning habituates');
  }
  assert.match(STATUS_BYPASS_SHELLS, COMPOSER_STATUS_RE, 'the wording with background shells running');
  assert.doesNotMatch(STATUS_BYPASS_SHELLS, /shift\+tab/, 'and it has no shift+tab hint — that hint was the whole of the old match');

  // A false positive found in review: the dialog's every string quoted in the transcript (a
  // `soma peek` of a blocked lead prints exactly them) above a composer whose status line is the
  // shells wording. With that wording unmatched, the exclusion signal is gone and this healthy pane
  // is a dialog.
  const peeked = [
    '⏺ Bash(soma peek task-1)', '  ⎿   Do you want to proceed?', '      ❯ 1. Yes', '        2. No', '', '      Esc to cancel · Tab to amend', '',
    '✻ Brewed for 1m 10s · done 10:00 PM · 5 shells, 1 monitor still running', RULE, '❯ ', RULE, STATUS_BYPASS_SHELLS,
  ].join('\n');
  const at = classifyPane(claude({ title: '✳ soma-main', frame: peeked }));
  assert.equal(at.fine, 'idle', 'the orchestrator quoting a lead\'s dialog is idle, not blocked');
  assert.equal(at.kind, null);
});

test('the status line is read from the LAST line only: a status line quoted in the transcript cannot hide a real dialog drawn below it', async () => {
  const { classifyPane } = await load('status-last-' + Date.now());
  // A lead working on this very module cats the fixtures, so its transcript shows a status line;
  // then it hits a permission dialog. The dialog is drawn last and the composer is gone. A match
  // anywhere in the frame would read the quoted line as a live composer and call this idle —
  // and `soma_send` would approve the pending command.
  const quotedStatusThenDialog = [
    '⏺ Read(test/pane-state.test.mjs)', '  ⎿  ' + STATUS_IDLE.trim(), '     ' + STATUS_BYPASS_SHELLS.trim(), '',
    ...PERMISSION_DIALOG.split('\n'),
  ].join('\n');
  const at = classifyPane(claude({ cmd: '2.1.259', frame: quotedStatusThenDialog }));
  assert.equal(at.fine, 'blocked_on_prompt');
  assert.equal(at.kind, 'permission');
  // Trailing blank rows are stripped by `capturePane`; a frame that still carries them reads the same.
  assert.equal(classifyPane(claude({ frame: `${IDLE_CLEAN}\n\n\n` })).fine, 'idle');
  // The normal-mode wording `? for shortcuts` is INFERRED (no lead on this fleet runs without a
  // permission mode) and is only ever an exclusion signal: with it on the last line, a quoted
  // dialog above is not a dialog. A wrong guess here makes the dialog rule stricter, never looser.
  const normalMode = `${QUOTED_DIALOG_ABOVE_COMPOSER.split('\n').slice(0, -1).join('\n')}\n  ? for shortcuts`;
  assert.equal(classifyPane(claude({ frame: normalMode })).fine, 'idle');
});

// ─────────────────────────── working / idle / idle_draft ───────────────────────────

test('working is a spinner in the title OR `esc to interrupt` in the status line', async () => {
  const { classifyPane, SPINNERS } = await load('working-' + Date.now());
  // frame 007: both signals at once.
  assert.equal(classifyPane(claude({ title: '◐ Claude Code', frame: WORKING_1 })).fine, 'working');
  // frame 029-idle-after: the status line says `esc to interrupt` while the title has already
  // flipped — either signal alone is enough, because the two are not updated in the same instant.
  assert.equal(classifyPane(claude({ title: '✳ Run grep command on somefile.txt', frame: WORKING_1 })).fine, 'working');
  const idleShaped = IDLE_CLEAN;
  for (const glyph of SPINNERS) {
    assert.equal(classifyPane(claude({ title: `${glyph} Run grep`, frame: idleShaped })).fine, 'working', `spinner ${glyph}`);
  }
  assert.deepEqual([...SPINNERS].sort(), ['◐', '◑', '◒', '◓']);
  // `✳` is NOT a spinner: it is the glyph of a finished turn, and it is what the title shows at
  // the permission dialog too. Reading it as working would hide every blocked lead as busy.
  assert.equal(classifyPane(claude({ title: '✳ Claude Code', frame: IDLE_CLEAN })).fine, 'idle');
  assert.equal(classifyPane(claude({ title: '◐ Claude Code', frame: WORKING_1 })).coarse, 'alive');
});

test('idle is the empty composer between two rules; text on it is idle_draft (a message left unsubmitted is observable)', async () => {
  const { classifyPane } = await load('idle-' + Date.now());
  const idle = classifyPane(claude({ frame: IDLE_CLEAN }));
  assert.equal(idle.fine, 'idle');
  assert.equal(idle.coarse, 'alive');
  assert.equal(idle.draft, false);

  const draft = classifyPane(claude({ frame: IDLE_DRAFT }));
  assert.equal(draft.fine, 'idle_draft');
  assert.equal(draft.coarse, 'alive', 'a draft is a live lead with unsent text, not an alarm');
  assert.equal(draft.draft, true);

  // The opus frame (081): an effort indicator sits above the top rule. Still idle.
  const opus = IDLE_CLEAN.replace(`${RULE}\n❯ `, `                                                               ○ low · /effort\n${RULE}\n❯ `);
  assert.equal(classifyPane(claude({ frame: opus })).fine, 'idle');
});

test('the composer is found under the NAMED rule every --name\'d session draws, so idle_draft can fire on this fleet', async () => {
  const { classifyPane } = await load('named-' + Date.now());
  // Before: `draft: null` — the composer was never located on a named session, so `PANE draft`
  // (soma.mjs, RUNBOOK), the flag that makes a long `soma send` left sitting unsubmitted in a
  // lead's composer at least visible, was a documented flag that could not fire.
  const idle = classifyPane(claude({ title: '✳ lead-task-2', frame: NAMED_IDLE_LIVE }));
  assert.equal(idle.fine, 'idle');
  assert.equal(idle.draft, false, 'the composer WAS located: false, not the could-not-locate null');
  const draft = classifyPane(claude({ title: '✳ lead-task-2', frame: NAMED_DRAFT }));
  assert.equal(draft.fine, 'idle_draft');
  assert.equal(draft.coarse, 'alive');
  assert.equal(draft.draft, true);
  // The orchestrators' rules carry their names too (`soma-main`, `soma-orch`), at the wider pane.
  const orch = ['✻ Brewed for 1m 10s · done 10:00 PM', '─'.repeat(139) + ' soma-main ─', '❯\u00a0', '─'.repeat(151), STATUS_BYPASS_SHELLS].join('\n');
  assert.equal(classifyPane(claude({ title: '✳ soma-main', frame: orch })).draft, false);
  // A rule is still a rule only with the name between one space and a closing `─`: text that
  // merely starts with dashes is not the composer's edge.
  const notRule = NAMED_DRAFT.replace(' lead-task-2 ─', ' lead-task-2');
  assert.equal(classifyPane(claude({ frame: notRule })).draft, null, 'no closing ─: the composer is not located, and that is said as null');
});

// ─────────────────────────── dead_shell / dead_pane and their precedence ───────────────────────────

test('dead_shell is a denylist of shells on a live pane, judged before the frame is read', async () => {
  const { classifyPane, SHELLS } = await load('shell-' + Date.now());
  const at = classifyPane({ dead: false, cmd: 'zsh', title: '', frame: SHELL_BARE });
  assert.equal(at.fine, 'dead_shell');
  assert.equal(at.coarse, 'dead_shell');
  // Every shell tmux-resurrect or a `/exit` can leave behind, in its login and path spellings.
  for (const cmd of ['zsh', 'bash', 'sh', 'dash', 'fish', 'ksh', 'tcsh', 'csh', '-zsh', '-bash', '/bin/zsh', '/usr/local/bin/fish']) {
    assert.equal(classifyPane({ dead: false, cmd, title: '', frame: '' }).fine, 'dead_shell', cmd);
  }
  assert.deepEqual([...SHELLS].sort(), ['bash', 'csh', 'dash', 'fish', 'ksh', 'sh', 'tcsh', 'zsh']);
  // A shell is a shell whatever its screen says — a dialog quoted in scrollback does not revive it.
  assert.equal(classifyPane({ dead: false, cmd: 'zsh', title: '', frame: PERMISSION_DIALOG }).fine, 'dead_shell');
  // ...and whatever its TITLE says. tmux-resurrect restores the saved pane title with the session:
  // a resurrected ghost such as `lead-task-3` is `zsh` under the title `◐ lead-task-3`, a spinner
  // glyph on a pane no claude has run in for a week. The shell rule runs before the title
  // rule (header: "a shell outranks the screen"); hoisting the free title check above it — the
  // natural "avoid the capture" refactor — turns every resurrected ghost back into a working lead.
  const ghost = classifyPane({ dead: false, cmd: 'zsh', title: '◐ lead-task-3', frame: null });
  assert.equal(ghost.fine, 'dead_shell', 'a spinner title on a shell pane is resurrect\'s memory, not a turn');
  assert.equal(ghost.coarse, 'dead_shell');
  assert.notEqual(ghost.coarse, 'alive');
  // And a live shell reads shell with NO frame at all: the census never captures a shell pane.
  assert.equal(classifyPane({ dead: false, cmd: 'zsh', title: '', frame: null }).fine, 'dead_shell');
});

test('"not the claude version string" is NOT dead: node, a stray name and an unknown frame are unrecognised', async () => {
  const { classifyPane } = await load('unrec-' + Date.now());
  // The `soma-watchdog` session reads `node`; a claude launched from inside a shell reads the same
  // version string as a spawned one (measured); install shapes change. So only a positive shell
  // match is dead, and everything else that matches no marker is reported, never acted on.
  for (const cmd of ['node', 'zshrc', 'python3', 'claude', '2.1.263']) {
    const at = classifyPane({ dead: false, cmd, title: 'x', frame: 'hello world\nnothing to see here' });
    assert.equal(at.fine, 'unrecognised', cmd);
    assert.equal(at.coarse, 'unrecognised', cmd);
  }
});

test('dead_pane outranks everything on the screen, and only the exact dead flag counts', async () => {
  const { classifyPane } = await load('deadpane-' + Date.now());
  // frame 004: the pane is dead, the command fell back to `env`, and the trust dialog is still
  // painted above `Pane is dead`. The flag decides; the decoy text does not.
  const at = classifyPane({ dead: true, cmd: 'env', title: '', frame: DEAD_PANE_SCREEN });
  assert.equal(at.fine, 'dead_pane');
  assert.equal(at.coarse, 'dead_pane');
  assert.equal(classifyPane({ dead: true, cmd: 'zsh', title: '', frame: '' }).fine, 'dead_pane', 'dead beats shell');
  assert.equal(classifyPane({ dead: '1', cmd: 'env', title: '', frame: '' }).fine, 'dead_pane', 'the raw tmux flag spelling');
  assert.equal(classifyPane({ dead: 1, cmd: 'env', title: '', frame: '' }).fine, 'dead_pane');
  // `false`, `'0'` and an absent flag are all "not dead" — the frame is then consulted.
  for (const dead of [false, '0', undefined, null, 'false']) {
    assert.notEqual(classifyPane({ dead, cmd: '2.1.263', title: '✳ Claude Code', frame: IDLE_CLEAN }).fine, 'dead_pane', String(dead));
  }
});

// ─────────────────────────── the third state ───────────────────────────

test('unobservable is its own answer: no frame for a live non-shell pane, or unusable input — never alive, never dead', async () => {
  const { classifyPane } = await load('unobs-' + Date.now());
  for (const frame of ['', '   \n\n', null, undefined, 42, {}]) {
    const at = classifyPane(claude({ frame }));
    assert.equal(at.fine, 'unobservable', `frame ${JSON.stringify(frame)}`);
    assert.equal(at.coarse, 'unobservable', `frame ${JSON.stringify(frame)}`);
  }
  for (const input of [null, undefined, 42, 'zsh', [], true]) {
    const at = classifyPane(input);
    assert.equal(at.fine, 'unobservable', `input ${JSON.stringify(input)}`);
    assert.equal(at.coarse, 'unobservable', `input ${JSON.stringify(input)}`);
  }
  // Never throws, even for a shape that fights enumeration — the tick runs this per lead per
  // tick, and a throw would cost every other lead its census.
  const hostile = new Proxy({}, { get() { throw new Error('boom'); }, has() { throw new Error('boom'); } });
  const at = classifyPane(hostile);
  assert.equal(at.fine, 'unobservable');
  assert.equal(at.coarse, 'unobservable');
});

test('every fine state has one coarse state, and the three that are not verdicts stay distinct', async () => {
  const { coarseOf, FINE_STATES, COARSE_STATES } = await load('coarse-' + Date.now());
  const expected = {
    working: 'alive', idle: 'alive', idle_draft: 'alive',
    blocked_on_prompt: 'blocked_on_prompt', dead_shell: 'dead_shell', dead_pane: 'dead_pane',
    absent: 'absent', unobservable: 'unobservable', unrecognised: 'unrecognised',
  };
  assert.deepEqual([...FINE_STATES].sort(), Object.keys(expected).sort());
  for (const [fine, coarse] of Object.entries(expected)) assert.equal(coarseOf(fine), coarse, fine);
  assert.deepEqual([...COARSE_STATES].sort(), [...new Set(Object.values(expected))].sort());
  // An unknown word is not silently `alive`.
  assert.equal(coarseOf('busy'), 'unrecognised');
  assert.equal(coarseOf(undefined), 'unrecognised');
  // The pin against the two-state collapse, stated as a property rather than a table entry:
  // `unobservable` is neither of the states the tick acts on and not the one it trusts.
  assert.notEqual(coarseOf('unobservable'), 'alive');
  assert.notEqual(coarseOf('unobservable'), 'dead_pane');
  assert.notEqual(coarseOf('unobservable'), 'dead_shell');
});

// ─────────────────────────── takeCensus ───────────────────────────

/** A `tmux.paneStates()` Map, one active pane per session. */
const panesOf = (entries) => new Map(Object.entries(entries).map(([name, p]) => [name, {
  dead: false, cmd: '2.1.263', pid: 100, title: '✳ Claude Code', pane_id: '%9', active: true,
  panes: [{ pane_id: '%9', dead: false, cmd: '2.1.263', pid: 100, title: '✳ Claude Code', active: true }],
  ...p,
}]));

test('takeCensus classifies every row, captures only live non-shell panes, and answers by row id', async () => {
  const { takeCensus } = await load('census-' + Date.now());
  const captured = [];
  const frames = { 'lead-a': IDLE_CLEAN, 'lead-b': PERMISSION_DIALOG };
  const panes = panesOf({
    'lead-a': {},
    'lead-b': { title: '✳ Permission system test', cmd: '2.1.259' },
    'lead-c': { cmd: 'zsh', title: '' },
    'lead-d': { dead: true, cmd: 'env', title: '' },
  });
  const census = takeCensus(
    [{ id: 'a', name: 'lead-a' }, { id: 'b', name: 'lead-b' }, { id: 'c', name: 'lead-c' }, { id: 'd', name: 'lead-d' }, { id: 'e', name: 'lead-e' }],
    { panes, capture: (name, lines) => { captured.push([name, lines]); return frames[name]; }, now: () => 0 },
  );
  assert.ok(census instanceof Map);
  assert.equal(census.get('a').fine, 'idle');
  assert.equal(census.get('b').fine, 'blocked_on_prompt');
  assert.equal(census.get('b').kind, 'permission');
  assert.equal(census.get('c').fine, 'dead_shell');
  assert.equal(census.get('d').fine, 'dead_pane');
  assert.equal(census.get('e').fine, 'absent', 'a session not in the listing');
  assert.equal(census.get('e').coarse, 'absent');
  // The cost rule: one capture per LIVE NON-SHELL pane and none for a shell, a corpse or a
  // missing session — measured 4 ms each, so this is what keeps 34 rows inside 150 ms.
  assert.deepEqual(captured, [['lead-a', 40], ['lead-b', 40]]);
  // What rides on each record: the pane facts the events need, and the frame for the excerpt.
  assert.equal(census.get('c').cmd, 'zsh');
  assert.equal(census.get('a').pid, 100);
  assert.equal(census.get('b').frame, PERMISSION_DIALOG);
  assert.equal(census.get('c').frame, null);
  assert.equal(census.get('a').error, null);
  assert.equal(census.get('a').name, 'lead-a');
});

test('takeCensus with no pane listing marks every row unobservable and captures nothing', async () => {
  const { takeCensus } = await load('census-null-' + Date.now());
  let captures = 0;
  for (const panes of [null, undefined]) {
    const census = takeCensus([{ id: 'a', name: 'lead-a' }], { panes, capture: () => { captures += 1; return IDLE_CLEAN; }, now: () => 0 });
    assert.equal(census.get('a').fine, 'unobservable', String(panes));
    assert.equal(census.get('a').coarse, 'unobservable', String(panes));
  }
  assert.equal(captures, 0, 'nothing is captured against a server that could not be listed');
});

test('a capture that throws makes THAT row unobservable with the reason, and the others still get their verdict', async () => {
  const { takeCensus } = await load('census-throw-' + Date.now());
  const panes = panesOf({ 'lead-a': {}, 'lead-b': {} });
  const census = takeCensus(
    [{ id: 'a', name: 'lead-a' }, { id: 'b', name: 'lead-b' }],
    { panes, capture: (name) => { if (name === 'lead-a') throw new Error('tmux killed by SIGKILL'); return IDLE_CLEAN; }, now: () => 0 },
  );
  assert.equal(census.get('a').fine, 'unobservable');
  assert.match(census.get('a').error, /SIGKILL/);
  assert.equal(census.get('b').fine, 'idle');
  assert.equal(census.get('b').error, null);
});

test('after the first capture that hits the tmux timeout, the rest of the tick is not captured and says so', async () => {
  const { takeCensus } = await load('census-timeout-' + Date.now());
  // `defaultRun` SIGKILLs tmux at 5 s, so a wedged server costs N x 5 s per tick unless the census
  // stops after the first one. The clock is injected: each call advances it by 5 s.
  let clock = 0;
  const captured = [];
  const panes = panesOf({ 'lead-a': {}, 'lead-b': {}, 'lead-c': {} });
  const census = takeCensus(
    [{ id: 'a', name: 'lead-a' }, { id: 'b', name: 'lead-b' }, { id: 'c', name: 'lead-c' }],
    { panes, capture: (name) => { captured.push(name); clock += 5000; return ''; }, now: () => clock, timeoutMs: 5000 },
  );
  assert.deepEqual(captured, ['lead-a'], 'one slow capture, then no more this tick');
  assert.equal(census.get('a').fine, 'unobservable');
  assert.equal(census.get('b').fine, 'unobservable');
  assert.match(census.get('b').error, /skipped/);
  assert.equal(census.get('c').coarse, 'unobservable', 'skipped rows are unobservable, never alive');
  // A fast capture never trips it.
  clock = 0;
  const fast = takeCensus([{ id: 'a', name: 'lead-a' }, { id: 'b', name: 'lead-b' }],
    { panes, capture: () => { clock += 10; return IDLE_CLEAN; }, now: () => clock, timeoutMs: 5000 });
  assert.equal(fast.get('b').fine, 'idle');
});

test('takeCensus skips rows it cannot name and keys Object.prototype ids like any other', async () => {
  const { takeCensus } = await load('census-shape-' + Date.now());
  const panes = panesOf({ 'lead-constructor': {}, 'lead-__proto__': { cmd: 'zsh', title: '' } });
  const census = takeCensus(
    [null, { id: 42, name: 'lead-x' }, { id: 'constructor', name: 'lead-constructor' }, { id: '__proto__', name: 'lead-__proto__' }, { id: 'ok' }],
    { panes, capture: () => IDLE_CLEAN, now: () => 0 },
  );
  assert.deepEqual([...census.keys()].sort(), ['__proto__', 'constructor']);
  assert.equal(census.get('constructor').fine, 'idle');
  assert.equal(census.get('__proto__').fine, 'dead_shell');
  // Never throws on hostile containers either: the tick owns the WATCHDOG_ERROR path.
  assert.doesNotThrow(() => takeCensus('not rows', { panes, capture: () => IDLE_CLEAN, now: () => 0 }));
  assert.doesNotThrow(() => takeCensus([{ id: 'a', name: 'lead-a' }], null));
});

// ─────────────────────────── readPane ───────────────────────────

test('readPane is the synchronous reading a typist takes first, and it names why when it could not look', async () => {
  const { readPane } = await load('read-' + Date.now());
  const panes = panesOf({ 'lead-a': {}, 'lead-b': { cmd: 'zsh', title: '' }, 'lead-c': { dead: true, cmd: 'env', title: '' } });
  let captures = 0;
  const capture = (target) => { captures += 1; return target === 'lead-a' ? IDLE_CLEAN : PERMISSION_DIALOG; };
  const idle = readPane('lead-a', { panes, capture });
  assert.deepEqual(idle, { state: 'alive', fine: 'idle', kind: null, cmd: '2.1.263', source: 'live', why: null });
  // A shell and a corpse are read from the listing; no screen capture is spent on them.
  assert.equal(readPane('lead-b', { panes, capture }).state, 'dead_shell');
  assert.equal(readPane('lead-b', { panes, capture }).cmd, 'zsh');
  assert.equal(readPane('lead-c', { panes, capture }).state, 'dead_pane');
  assert.equal(captures, 1);
  // The listing may be handed over as a function (a caller listing fresh) or as the Map itself
  // (a caller that already holds this tick's listing).
  assert.equal(readPane('lead-a', { panes: () => panes, capture }).fine, 'idle');
  assert.equal(readPane('lead-zz', { panes, capture }).state, 'absent');
  // The three ways of not knowing, each with its cause, none of them alive and none of them dead.
  const unlisted = readPane('lead-a', { panes: null, capture });
  assert.equal(unlisted.state, 'unobservable');
  assert.match(unlisted.why, /listing could not be read/);
  const blank = readPane('lead-a', { panes, capture: () => '' });
  assert.equal(blank.state, 'unobservable');
  assert.match(blank.why, /empty/);
  const threw = readPane('lead-a', { panes, capture: () => { throw new Error('SIGKILL'); } });
  assert.equal(threw.state, 'unobservable');
  assert.match(threw.why, /threw.*SIGKILL/);
  assert.equal(new Set([unlisted.why, blank.why, threw.why]).size, 3, 'three causes, three sentences');
  // Synchronous by contract: a reader that answers with a promise is "not read" — `wake()` is void
  // and cannot await — never a value and never a licence to type.
  const asyncListing = readPane('lead-a', { panes: async () => panes, capture });
  assert.equal(asyncListing.state, 'unobservable');
  assert.match(asyncListing.why, /asynchronously/);
  const asyncCapture = readPane('lead-a', { panes, capture: async () => IDLE_CLEAN });
  assert.equal(asyncCapture.state, 'unobservable');
  // Never throws.
  assert.doesNotThrow(() => readPane('lead-a', { panes: () => { throw new Error('boom'); }, capture }));
  assert.equal(readPane('lead-a', { panes: () => { throw new Error('boom'); }, capture }).state, 'unobservable');
  assert.doesNotThrow(() => readPane(undefined, undefined));
});

// ─────────────────────────── findPane ───────────────────────────

test('findPane resolves a session name directly and a %-pane id across every session\'s panes', async () => {
  const { findPane } = await load('find-' + Date.now());
  const panes = panesOf({
    orch: {
      pane_id: '%1', cmd: '2.1.263', title: '✳ orchestrator',
      panes: [
        { pane_id: '%1', dead: false, cmd: '2.1.263', pid: 7, title: '✳ orchestrator', active: true },
        { pane_id: '%4', dead: false, cmd: 'zsh', pid: 8, title: '', active: false },
      ],
    },
    'lead-a': { pane_id: '%2' },
  });
  assert.equal(findPane(panes, 'lead-a').pane_id, '%2');
  assert.equal(findPane(panes, '%1').session, 'orch');
  // The lease records the orchestrator's pane by id, and that pane need not be the session's
  // active one — an operator who split the window has a shell in %4 and claude in %1.
  assert.equal(findPane(panes, '%4').cmd, 'zsh');
  assert.equal(findPane(panes, '%4').session, 'orch');
  assert.equal(findPane(panes, '%99'), null);
  assert.equal(findPane(panes, 'lead-zz'), null);
  assert.equal(findPane(null, 'lead-a'), null);
  assert.equal(findPane(panes, ''), null);
  assert.equal(findPane(panes, 'constructor'), null, 'a Map lookup, never a property lookup');
});
