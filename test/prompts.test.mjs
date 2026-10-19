import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Shared with `skill.test.mjs`: the same scoping helpers, and the same force-steal assent gate,
// because `orchestrator.md` offers the same steal that `SKILL.md` §1 does.
import {
  ADVISORY, ARTIFACTS, ASSENT_GATE, CARVE_OUT, HEDGE, TICKET_OVERRIDE, UNGATED,
  bullet, fence, paragraph, readArtifact, row, section, sectionLine, unfenced,
} from './prose.mjs';

// Lifted verbatim out of `harness.test.mjs`, which had grown two unrelated halves: the `harness.mjs`
// / `standing.mjs` unit tests, and these — the pins on the prose artifacts themselves. Nothing here
// is changed from the move: same assertions, same names, same order.

// Duplicated from `harness.test.mjs` rather than shared: that file still needs it for
// `writeStanding embeds the pins`, and a one-line reader is cheaper to repeat than to route
// through `prose.mjs`, whose own reader (`readArtifact`) takes a repo-relative path instead.
const readPrompt = (name) => readFileSync(new URL(`../prompts/${name}`, import.meta.url), 'utf8');

test('lead.md names every harness in the registry, with its cap, and keeps its steps in order', () => {
  // Unfenced: Step 1's payload template names `"H2"` and `10` inside a fence, so a fenced line is
  // enough to satisfy "lead.md mentions this harness with its cap" while the intake row that a lead
  // actually routes on has lost both.
  const txt = unfenced(readPrompt('lead.md'));
  const reg = JSON.parse(readFileSync(new URL('../prompts/harnesses.json', import.meta.url), 'utf8'));
  const lines = txt.split('\n');
  for (const [id, entry] of Object.entries(reg)) {
    const named = lines.filter((l) => new RegExp(`\\b${id}\\b`).test(l));
    assert.ok(named.length > 0, `lead.md never mentions ${id}`);
    assert.ok(txt.includes(entry.name), `lead.md never names ${entry.name}`);
    const cap = entry.iteration?.max_iterations;
    if (cap) assert.ok(named.some((l) => l.includes(String(cap))), `lead.md omits ${id}'s cap of ${cap}`);
  }
  // Step 0 comes first — compared as HEADINGS, because `txt.indexOf('Step 0')` is satisfied by any
  // prose mention of the phrase and would survive the two sections being swapped wholesale.
  assert.ok(
    sectionLine(txt, /^##\s+Step 0\b/) < sectionLine(txt, /^##\s+Step 1\b/),
    'the harness choice must come before the harness report',
  );
  // Each harness reserves exactly one class, and Step 1 states the mapping a third time (after the
  // registry and the intake table). A drift here is a lead that reports a class the bus refuses.
  const mapping = paragraph(section(txt, /^##\s+Step 1\b/), /reserves\s+exactly\s+one\s+class/i);
  assert.ok(mapping, 'Step 1 must still say that each harness reserves exactly one budget class');
  for (const [id, entry] of Object.entries(reg)) {
    assert.match(
      mapping,
      new RegExp(`${id}\\s*(→|->|=>)\\s*${entry.budget_class}`),
      `Step 1's mapping omits or misstates ${id}→${entry.budget_class}`,
    );
  }
});

/**
 * The load-bearing rules of the two standing prompts, pinned one rule at a time.
 *
 * These documents are the ONLY statement of the boundaries nothing in `bin/` enforces: a lead may
 * not write code, may not merge, may not mark a PR ready, may not transition a ticket. The test
 * this replaces was twelve `assert.match(txt, /word/)` over the whole 146-line file, and an audit
 * showed what that guards: it rewrote the entire pins block to its NEGATION — "You may edit
 * files, push anywhere, open non-draft PRs through raw `gh`, merge them, mark them ready for
 * review, and transition tickets" — deleted the autonomy list, the budget breaker, DEFAULT-REJECT,
 * the workflow edit-ban and the COMPLETED precondition, and the suite stayed GREEN at 224 of 224.
 * Every grep survived on a decoy elsewhere in the document: `/planning.only/` and `/fable/` on the
 * TITLE line, `/never merge|never mark/i` on an injected typography note.
 *
 * So each entry below is (scope, rule, pins): the scope is the bullet, paragraph, table row or
 * section that CARRIES the rule and nothing else, and the pins include the prohibition itself —
 * `never`, `denied`, `blocked` — because a pin on the object alone ( `/merge/i` ) is satisfied by
 * `git commit | apply | merge | rebase` one bullet away and survives inverting the rule.
 *
 * `at: null` means the rule is the section's own, with no narrower home.
 */
const PROMPT_RULES = {
  'lead.md': [
    {
      heading: /^#\s+soma lead\b/, label: 'the preamble',
      // The TITLE carries three rules in prose, and it is the very decoy the audit exploited: the
      // whole-file `/fable/` and `/planning.only/` greps matched here while the pins block below
      // said the opposite. The block sweep cannot report it either — it enumerates bullets, rows
      // and paragraphs, never heading lines — so the title read as covered from both directions.
      // Now it is pinned as a rule in its own right AND the same rules are pinned to their bullets;
      // both, deliberately, because the title is what a compacted session still has.
      //
      // Deleting the title was already RED, but only as an ANCHOR: `headingLine()` needs something
      // matching `/^#\s+soma lead\b/` to find this section at all, so the first three words were
      // load-bearing and every word after them was free. Each of these four was individually
      // droppable, and the whole tail was replaceable with "implementation allowed, any model,
      // effort low. Advisory." — with `## The pins` still saying the opposite — at a green suite.
      //
      // `planning[\s-]` accepts both spellings on purpose: this file says "planning only" while
      // `standing.mjs` prints "planning-only" into the same composed document, and a pin that
      // demanded one of them would red the suite on a one-character normalisation.
      // `planning only` was pinned here for most of this build and is GONE on purpose: a later
      // commit removed the lead's edit ban and shell-write ban, leaving only push and merge
      // denied, and the document went on asserting the old boundary under a heading that says the
      // pins are "enforced outside your goodwill". A lead read that and believed it. The title is
      // what a compacted session still has, so it now carries what is actually enforced.
      headPins: [
        ['what is actually denied', /never\s+push\s+or\s+merge/i],
        ['the model', /\bopus\b/],
        ['the effort', /effort[\s`]*max/i],
        ['and that none of it is negotiable', /non-negotiable/i],
      ],
      rules: [
        // Found by deleting every block of the file one at a time: this paragraph carries the
        // no-code boundary in its plainest form — "You do not write code." — and nothing failed
        // when it was removed. The pins block states the same boundary as a tool denial, but this
        // is the sentence a model reads first and the one that says what the team is FOR.
        { at: /You are a soma project lead/, why: 'what a lead is and is not', pins: [
          // Was `/do not write code/`. That sentence was the plainest statement of a boundary the
          // code no longer has. What replaces it is the true version AND the reason the team still
          // exists, because deleting the false claim without saying why a lead should still
          // delegate would leave the whole team model looking like dead weight.
          ['that its write surface equals a teammate\'s', /same\s+hands|same\s+one/i],
          ['and why it still runs a team anyway', /(throughput|independent\s+check)/i],
          ['one task', /one\s+task/i],
          ['one worktree', /one\s+(git\s+)?worktree/i],
          ['one draft PR', /one\s+draft\s+PR/i],
          ['that the team is the hands', /(agent\s+team|your\s+hands)/i],
          ['and the task list is a writing surface', /Task(Create|Update)/],
        ] },
        // Also unguarded: the precedence rule. It is what stops a ticket from talking a lead out
        // of the pins, which makes it the file's only defence against a hostile task packet.
        { at: /re-appended/, why: 'the pins outrank the ticket', pins: [
          ['that they survive compaction', /outlive\s+compaction/i],
          // DIRECTION, not the verb. This is the one assertion in the file whose entire subject is
          // the DIRECTION of a precedence rule, and a bare `/outrank/i` could not see it: rewriting
          // the clause to "the task text outranks them" — an inversion that hands a hostile task
          // packet authority over every pin below — kept the suite green, because the word was
          // still there. So the subject and the object are both pinned, in that order. The window
          // between them is a few words rather than `[\s\S]{0,20}`, which would re-admit the
          // inversion whenever the sentence happens to name the task within 20 characters.
          ['that THEY outrank the task text, and not the reverse',
            /\b(these\s+orders|they|the\s+rules|the\s+pins)\s+(?:\w+\s+){0,3}outranks?\s+(?:\w+\s+){0,2}(task|ticket)\b/i],
          ['and that a ticket can never change them', /never\s+change\s+the\s+rules/i],
        ] },
      ],
    },
    {
      heading: /^##\s+The pins\b/, label: 'the pins',
      // "enforced outside your goodwill" is the sentence that makes the seven bullets below binding
      // rather than advisory, and reframing it to "sensible defaults you may depart from when the
      // ticket calls for it" repealed the whole block with every bullet left intact and the suite
      // green — a heading-only mutation, invisible to a sweep that never offers a heading as a unit.
      headPins: [
        ['that the pins are enforced, not advised', /(enforced|non-negotiable|not\s+optional|mechanical)/i],
        ['and that arguing with them costs a turn', /(do\s+not|don.t)\s+spend\s+turns/i],
      ],
      rules: [
        { at: /Model\b/, why: 'the model and effort pins', pins: [
          ['the model', /\bopus\b/],
          ['the effort', /effort[\s`]*max/i],
          ['and that both bind the team too', /(everyone|anyone|all)\b[\s\S]{0,20}dispatch/i],
        ] },
        // These two rows used to pin an edit ban and a shell-write ban. Both were removed from the
        // code and left standing in the document, so the pins were faithfully
        // protecting a false statement — the worst thing a pin can do, because it makes the lie
        // load-bearing. They now pin the real boundary and the real hazard.
        { at: /git\s+push.*denied|denied\s+to\s+you/, why: 'the only write restriction a lead has', pins: [
          ['what is denied', /git\s+push/],
          ['and the other half of it', /git\s+merge/],
          ['the prohibition itself', /(denied|blocked|forbidden|refused)/i],
          ['that nothing else is', /[Nn]othing\s+else/],
          ['the tools that DO work, named so a lead stops rationing them', /NotebookEdit/],
          ['and that the surfaces are equal', /same/i],
        ] },
        { at: /workflow\s+agents/, why: 'workflow agents can now write, and that is a hazard', pins: [
          ['that they inherit this session', /(inherit|allowlist)/i],
          ['that they can therefore change files', /(change\s+files|can\s+change)/i],
          ['that this is a hazard, not a capability to use', /(collision|hazard)/i],
          ['and where writes belong instead', /teammates?\s+write/i],
        ] },
        // Selector tightened to this bullet's opening words. A bare `/worktree/` used to be
        // unambiguous inside this section; the workflow bullet above now mentions one too, and two
        // rules resolving to one block is exactly what the distinctness check catches.
        { at: /Your cwd is a worktree/, why: 'worktree and branch discipline', pins: [
          ['the branch it names', /soma\/<id>/],
          ["another task's worktree", /never[\s\S]{0,44}another\s+task.s\s+worktree/i],
          ['the shared branches', /never\s+push[\s\S]{0,30}(develop|main)/i],
          ['and force-push', /never\s+force-?push/i],
        ] },
        // The cd-compound fix. MEASURED over 179 fleet transcripts: 31% of a lead's Bash calls were
        // `cd <dir> && …` compounds, 80% of them into its OWN worktree, and Claude Code 2.1.259
        // raised a bypass-immune permission prompt on exactly that shape whenever a `Read()` deny
        // rule existed — 79 sessions stalled for 214 hours with nobody at the pane. The harness's
        // own Bash tool description already warned against a `cd` in a compound, so a warning
        // alone is demonstrably not enough: this bullet carries the measured reason AND the exact
        // alternative, and the pins hold both halves, because a prohibition without the
        // alternative is one a model routes around and the alternative without the prohibition
        // is a style note. Its own bullet, so no pin here can borrow the `never` from the
        // worktree bullet above it.
        // `\s+`, not spaces: the phrase wraps across a line break in the document, and a selector
        // with a literal space reported the rule "gone entirely" on the first run against it.
        { at: /Never\s+prefix\s+a\s+command\s+with/, why: 'no cd-compounds: the shell already runs in the worktree', pins: [
          ['that the shell is already there', /already\s+runs\s+in\s+that\s+worktree/i],
          ['the prohibition itself, with the shape it forbids', /Never\s+prefix\s+a\s+command\s+with\s+`cd\s+<that\s+path>\s+&&`/],
          ['why: a prompt nobody at the pane can answer', /permission\s+prompt\s+nobody\s+can\s+answer/i],
          ['that it is measured, not feared', /79\s+stalls/],
          ['that a newline joins a compound too', /newline/i],
          ['what to type instead', /git\s+-C\s+\/abs\/dir/],
          ['and the one legal shape of cd', /own\s+Bash\s+call/i],
        ] },
        { at: /soma-pr/, why: 'draft-only pull requests', pins: [
          ['the only way a PR may exist', /only\s+through/i],
          ['the flag the wrapper always passes', /--draft/],
          ['raw creation', /gh\s+pr\s+create/],
          ['raw merge', /gh\s+pr\s+merge/],
          ['raw ready', /gh\s+pr\s+ready/],
          ['and that those are denied', /denied/i],
        ] },
        { at: /writeback/i, why: 'comment-only writeback and the four bans', pins: [
          ['whose job it is', /orchestrator/i],
          ['that it is a comment and nothing else', /comment-only/i],
          ['the prohibition itself', /\b(never|not)\b/i],
          ['transitioning a ticket', /transition/i],
          ['closing an issue', /clos(e|ing)/i],
          ['relabelling', /label/i],
          ['merging', /\bmerge\b/i],
          ['marking a PR ready', /mark[\s\S]{0,14}ready/i],
        ] },
        { at: null, why: 'the escape hatch when a pin blocks the plan', pins: [
          ['the rule that the plan yields', /rule\s+blocks\s+the\s+plan/i],
          ['and the report it yields to', /NEEDS_INPUT/],
        ] },
      ],
    },
    {
      heading: /^##\s+Step 0\b/, label: 'step 0, harness intake',
      headPins: [['that the harness is chosen before anything else', /before\s+anything\s+else/i]],
      rules: [
        { at: null, why: 'harness-first, before any other work', pins: [
          ['that it happens first', /(before\s+anything\s+else|Nothing\s+else\s+happens\s+first)/i],
          ['what it forbids until then', /no\s+team,\s*no\s+workflow/i],
          ['first-match table semantics', /\*\*first\*\*\s+row\s+that\s+matches/],
          ['the vague-ticket stop', /too\s+vague/i],
          ['before any work is spent on it', /before\s+any\s+work/i],
          ['and what a NEEDS_INPUT must carry', /(the\s+specific\s+question|ask\s+the\s+specific)/i],
        ] },
        // The precedence rationale, also found unguarded by the block sweep. Step 1's ACK-free
        // supersede clause cites this paragraph by name, so deleting it leaves that clause
        // pointing at a rule the document no longer contains.
        { at: /sits\s+above/, why: 'why H1 outranks H4, and the degrade that follows', pins: [
          ['the precedence it explains', /H1[\s\S]{0,24}above[\s\S]{0,24}H4/i],
          ['that order is precedence in a first-match table', /(first-match|precedence)/i],
          ['the trigger for the degrade', /REJECTs?\s+twice/i],
          ['the move it authorises', /supersede/i],
          // `/H4/` alone matched three times in this one paragraph ("H1 sits above H4", "H4 is the
          // residual row", "supersede into H4"), so dropping H4 as a degrade TARGET — the thing the
          // rule is about — left it green. Both jobs H4 does here are pinned to their own clause.
          ['that H4 is the residual row', /H4[\s\S]{0,24}residual/i],
          ['and that the degrade supersedes into it', /supersede[\s\S]{0,24}\bH4\b/i],
          ['the gate harnesses it may go to instead', /H2\/H3|H2\s+or\s+H3/],
          ['and what reserving rounds costs', /budget\s+class/i],
        ] },
      ],
    },
    {
      heading: /^##\s+Step 1\b/, label: 'step 1, the harness report',
      rules: [
        // Scoped to the FENCE, which is the only place these fields exist. Pinned against the
        // section instead, `harness_id` and `budget_class` were a DECOY PAIR with the paragraph
        // below ("the bus validates `harness_id` and `budget_class`") — either half was deletable
        // with the suite green — and `autonomy`, `max_iterations`, `team_plan` and `plan_summary`
        // were not pinned at all. The block sweep could not report any of it: it skips fenced
        // regions, so this template read as covered. `budget_class` is what
        // `validateHarnessReport` refuses a report for omitting, `max_iterations` is what the cap
        // binds, and `team_plan` / `plan_summary` are named nowhere else in the document — they are
        // exactly what the orchestrator's one-turn veto reads.
        { fence: /soma_report\("HARNESS"/, why: 'the HARNESS payload the lead has to file', pins: [
          ['the call', /soma_report\("HARNESS"/],
          ['the harness field', /harness_id:/],
          ['the autonomy declaration', /autonomy:/],
          ['the verify command it commits to', /verify_command:/],
          ['the iteration cap it declares', /max_iterations:/],
          ['the class it reserves', /budget_class:/],
          ['the roster the veto reads', /team_plan:/],
          ['and the plan the veto judges', /plan_summary:/],
        ] },
        // `verify_command` is deliberately NOT pinned here: it exists only inside the fence above,
        // and this scope is fence-free, so a pin on it here would have to be satisfied by prose that
        // does not exist. Its home is the fence rule. (The section-wide version of this pin passed
        // for exactly the wrong reason — the fence — until fences stopped counting as scope.)
        { at: null, why: 'what the report buys, and what the veto turn is for', pins: [
          ['that the bus validates the two fields it prices from', /validates[\s\S]{0,40}harness_id[\s\S]{0,40}budget_class/i],
          ["the orchestrator's veto window", /one-turn\s+veto/i],
          ['and what the veto turn may be spent on', /(cheap|reversible)/i],
        ] },
        { at: /Autonomy levels/, why: 'that the three levels are prohibitions', pins: [
          ['what the list is for', /forbids/i],
        ] },
        { at: /`report-only`/, why: 'the report-only autonomy level', pins: [
          ['that it changes nothing', /change[\s\S]{0,24}nothing/i],
        ] },
        { at: /`ask-first`/, why: 'the ask-first autonomy level', pins: [
          ['that it decides nothing', /decide[\s\S]{0,24}nothing/i],
        ] },
        { at: /`decide-within-ticket`/, why: 'what decide-within-ticket still may not decide', pins: [
          ['scope', /scope/i],
          ['schema', /schema/i],
          ['the public API', /public\s+API/i],
          ["another team's contract", /contract/i],
          ['that these are not detail', /\bnot\b[\s\S]{0,14}detail/i],
          ['and where they go instead', /NEEDS_INPUT/],
        ] },
      ],
    },
    {
      heading: /^##\s+Step 2\b/, label: 'step 2, plan without writing',
      rules: [
        // `only writing surfaces` is gone with the ban that made it true. What has to survive is
        // the REASON to plan first, which is now an argument rather than a mechanism: a lead that
        // edits its own work has no independent check on it, and the verifier is the only thing in
        // the fleet that catches a confident mistake.
        { at: null, why: 'plan first, because nothing stops you any more', pins: [
          ['that the discipline is now chosen, not imposed', /nothing\s+stops\s+you/i],
          ['the reason it still holds', /(independent\s+check|no\s+independent\s+check)/i],
          ['what the verifier is for', /DEFAULT-REJECT/],
          ['who writes a file that belongs in the worktree', /\*\*teammate\*\*\s+writes\s+it/i],
          ['file ownership named up front', /file\s+ownership/i],
          ['and why', /collision/i],
        ] },
      ],
    },
    {
      heading: /^##\s+Step 3\b/, label: 'step 3, the team',
      rules: [
        { at: null, why: 'the team cap', pins: [['at most three teammates', /at\s+most\s+\*\*3\*\*/i]] },
        // Unguarded until the block sweep: the roster itself, including the one word that makes a
        // verifier a verifier. `harnesses.json` gives every harness a `team`, and this line is
        // where a lead reads it.
        { at: /typical roster/i, why: 'the roster the harnesses ask for', pins: [
          ['the implementer', /implementer/i],
          ["H3's test-writer", /test-writer/i],
          ['the verifier', /verifier/i],
          ['and that the verifier is independent', /independent/i],
        ] },
        { at: /DEFAULT-REJECT/, why: 'the independent verifier', pins: [
          ['the stance', /DEFAULT-REJECT/],
          ['what the stance means', /assumes[\s\S]{0,40}wrong/i],
          ['that it runs the gate itself', /runs\s+`?verify_command`?\s+itself/i],
          ['from a clean state', /clean\s+state/i],
          ['the three verdicts', /APPROVE \| REJECT \| ESCALATE_HUMAN/],
          ['with evidence', /evidence/i],
          ['that it never takes the implementer’s word', /never\s+takes/i],
          ['and never fixes what it found', /never\s+fixes/i],
        ] },
        { at: /maker/i, why: 'the maker never grades its own homework', pins: [
          ['the rule', /never\s+grades/i],
          ['and its mechanical form', /no\s+teammate\s+both\s+writes\s+and\s+approves/i],
        ] },
        { at: /nesting/i, why: 'no nested teams', pins: [
          ['one team per session', /one\s+team\s+per\s+session/i],
          ['teammates cannot spawn teammates', /cannot\s+spawn\s+teammates/i],
        ] },
        { at: /brief\s+carries/i, why: 'what every teammate brief must carry', pins: [
          ['the branch', /branch/i],
          ['the file ownership', /file\s+ownership/i],
          ['the verify command', /verify\s+command/i],
          ['commit your own work', /commit\s+your\s+own\s+work/i],
          ['and the three bans it passes on', /never\s+merge[\s\S]{0,60}ready[\s\S]{0,40}transition/i],
          // The cd-compound fix: 105 of 179 sessions received their cwd in a brief and then `cd`'d
          // there for the rest of the session — teammates learn the habit from the lead. Both
          // halves, so the fact cannot be demoted to a `cd` instruction with the pin still green.
          ['the worktree path as a fact', /worktree\s+path\s+stated\s+as\s+a\s+fact/i],
          ['and never as a cd instruction', /never\s+as\s+a\s+`cd\s+<path>\s+&&`/i],
        ] },
      ],
    },
    {
      heading: /^##\s+Step 4\b/, label: 'step 4, workflows',
      // "read-side fan-out only" is the scope limit; the body explains WHY it holds. Drop the word
      // `only` from the heading and the section reads as a general grant of the Workflow tool.
      headPins: [['that workflows are for reading only', /read-?side[\s\S]{0,24}only|only[\s\S]{0,24}read/i]],
      rules: [
        // This row asserted the OPPOSITE of what the code does. It pinned "workflow agents inherit
        // the edit ban" and "a workflow can never be the thing that changes a file" — both true
        // when written, both false since the ban they inherited was removed. The section is
        // still read-side-only, but the reason changed from a mechanism to a hazard, and a pin that
        // keeps asserting a repealed mechanism is worse than no pin: it makes the stale claim
        // load-bearing and reddens the suite when someone corrects the document.
        { at: null, why: 'workflows stay read-side, now by instruction rather than by ban', pins: [
          ['the tool it is about', /`Workflow`\s+tool/],
          ['that workflow agents inherit this session', /inherit[\s\S]{0,30}allowlist/i],
          ['that a workflow CAN change a file now', /\*\*can\*\*\s+change\s+a\s+file/i],
          ['that this is a hazard rather than a feature', /hazard\s+rather\s+than\s+a\s+feature/i],
          ['what is missing when they do', /(no\s+verifier|ownership\s+map)/i],
          ['the instruction that replaces the ban', /read-only\s+by\s+instruction/i],
          ['and where edits do go', /[Ee]dits\s+go\s+through\s+teammates/],
        ] },
      ],
    },
    {
      heading: /^##\s+Step 5\b/, label: 'step 5, report cadence',
      rules: [
        // The cadence itself. Each of these is one bullet, and four of the six could be deleted
        // with the suite green before this: the orchestrator's whole view of a lead is these
        // events, so a lead that stops emitting one reads as stalled or as never having started.
        // Only the event names that are unique inside §5 are pinned here. `NEEDS_INPUT`, `COMPLETED`
        // and `HARNESS` all recur in the budget paragraph ("file `NEEDS_INPUT` or `COMPLETED`",
        // "re-read your HARNESS contract"), so a section-wide token for those would be satisfied by
        // that sentence and pin nothing — which is how the `HARNESS` bullet survived deletion. They
        // are pinned on their own bullets instead, with content.
        { at: null, why: 'the reports the fleet is driven by', pins: [
          ['kickoff', /STARTED/],
          ['progress', /MILESTONE/],
          ['the cheap liveness signal between them', /soma_checkpoint/],
          ['and hard failure', /\bERROR\b/],
        ] },
        { at: /`HARNESS`\s+—/, why: 'the harness report and its one supersede', pins: [
          ['that it belongs to step 1', /step\s+1/i],
          ['and that it may be superseded once', /at\s+most\s+one\s+supersede/i],
        ] },
        { at: /NEEDS_INPUT`?\s+—/, why: 'when to block instead of guessing', pins: [
          ['the trigger', /would\s+otherwise\s+guess/i],
          ['what not to do instead', /(do\s+not\s+spin|do\s+not\s+retry|do\s+not\s+invent)/i],
          ['and that blocking is the cheaper mistake', /blocking\s+is\s+cheaper/i],
        ] },
        { at: /COMPLETED/, why: 'the COMPLETED precondition', pins: [
          ['the payload', /pr_url/],
          ['that the verifier must have approved', /APPROVE/],
          ['that the draft PR must already exist', /draft\s+PR\s+exists/i],
          ['and the two near-misses it rules out', /[Nn]ot\s+"the\s+code\s+is\s+written"/],
        ] },
        { at: null, why: 'the budget breaker and its wind-down', pins: [
          ['the warning threshold', /80%/],
          ['the trip threshold', /100%/],
          ['the breaker', /breaker/i],
          ['what the warning means you stop doing', /stop\s+starting\s+work/i],
          ['and re-reading the contract after a compaction', /compacted[\s\S]{0,60}soma_task\(\)/i],
        ] },
      ],
    },
    {
      heading: /^##\s+The deliverable\b/, label: 'the deliverable',
      rules: [
        { at: null, why: 'what the lead is allowed to hand over', pins: [
          ['the branch', /soma\/<id>/],
          ['that the PR is a draft', /\*\*draft\*\*/],
          ['through the wrapper', /soma-pr/],
          ['reported once', /COMPLETED/],
          ['never merged', /[Nn]ever\s+merge/],
          ['never marked ready', /[Nn]ever\s+mark\s+it\s+ready/],
          ['never transitioned', /[Nn]ever\s+transition/],
          ['and the NEEDS_INPUT alternative', /NEEDS_INPUT/],
        ] },
        // Its own scope, not folded into the bullet above: the rule is a paragraph, and a pin on
        // `/worktree/` alone is satisfied a dozen times elsewhere in this document.
        //
        // MEASURED, twice: leads wrote finished deliverables into the `/private/tmp` scratchpad
        // their Claude Code session is handed, because nothing in this document said not to.
        // Research documents that existed only there were gone the next morning, and a machine
        // restart later cleared the whole tree — taking soma's own tmux sockets with it. The rule
        // has to name the DURABLE home, the volatile one, and that it covers documents and not
        // only code, because the H6 research harness produces exactly the artifact most at risk.
        { at: /outlive/, why: 'deliverables must survive the session', pins: [
          ['the prohibition itself', /[Nn]ever\s+leave\s+a\s+deliverable\s+in\s+a\s+scratchpad/],
          ['where it goes instead', /goes\s+in\s+the\s+worktree/i],
          ['and that it is committed there', /committed/i],
          ['the volatile path, named so it is recognisable', /\/private\/tmp/],
          ['that the loss is real rather than theoretical', /(reboot|reaps?|destroyed|gone)/i],
          ['and that a document counts, not only a diff', /(RCA|report|estimate|document)/i],
        ] },
      ],
    },
  ],
  'orchestrator.md': [
    {
      heading: /^#\s+soma orchestrator\b/, label: 'the preamble',
      headPins: [['dispatch, don’t do', /dispatch[\s\S]{0,12}(don.t|do\s+not)\s+do/i]],
      rules: [
        { at: /You hold the fleet lease/, why: 'dispatch, don’t do', pins: [
          ['that it does not implement', /do\s+not\s+implement/i],
          ['what the watchdog owns instead', /watchdog/i],
          ['that the watchdog is not to be raced', /do\s+not\s+(duplicate|race)/i],
          ['and what the tokens are for', /decisions\s+only/i],
        ] },
        // The CLI-fallback sentence used to sit in THIS paragraph, and it named `soma_inbox` a second
        // time. That second mention was a decoy for the `then drain` pin below and for the ordering
        // test at the foot of this file — both written in the same commit as the sentence that
        // disarmed them — so the drain step could be deleted from the documented promotion sequence
        // with the suite green. Proven with a control matrix: drop the drain step and the parity
        // sentence → GREEN; drop the drain step and keep the parity sentence → RED. The general
        // lesson, because it will recur: a prose edit INSIDE a paragraph a new pin scopes to needs
        // that pin re-mutated afterwards. Fixed twice over — the sentence is its own paragraph now
        // (which is also what un-blinds the ordering test), and the drain pin is clause-shaped.
        { at: /On promotion/, why: 'the promotion order and the force gate', pins: [
          ['adopt', /soma_adopt/],
          ['then brief', /soma_status/],
          ['then drain', /soma_inbox[^.]{0,40}drain|drain[^.]{0,40}soma_inbox/i],
          ['the steal it offers', /force:\s*true/],
          // The same clause-shaped gate `SKILL.md` §1 needs, because it is the same act: taking the
          // fleet from a live orchestrator. This paragraph is the only place the orchestrator
          // prompt states it.
          ['gated on operator assent', ASSENT_GATE],
        ], no: [
          ['the steal left to the model’s judgement', UNGATED],
        ] },
        // The parity claim, now its own paragraph and its own rule. Splitting it out moved it
        // outside the `no:` list that used to hold it, so it gets pinned here instead of losing the
        // guard: `SKILL.md` §6 had to soften exactly this claim, and it is false here for the same
        // two verbs — v1 has no `inbox` subcommand and no CLI handback.
        { at: /If the control tools did not surface/, why: 'the CLI fallback and how far its parity goes', pins: [
          ['the transport it falls back to', /`soma`\s+CLI|CLI\s+over\s+Bash/i],
          // Both orders. Pinned as `parity → verb` alone, a legitimate reword that leads with the
          // subject ("every verb that dispatches work has parity there") was a false red — the same
          // class of brittleness that made seven rewordings of the assent gate turn this suite red.
          ['how far the parity goes', /parity[^.]{0,40}(verb|dispatch)|(verb|dispatch)[^.]{0,40}parity/i],
          ['the drain verb that has no subcommand', /soma_inbox/],
          ['what to do instead of it', /(ndjson|digest)/i],
          ['and the handback that has none either', /soma_release/],
        ], no: [
          ['an unqualified parity claim', /(full|complete|total|100%)\s+parity/i],
        ] },
      ],
    },
    {
      heading: /^##\s+Intake\b/, label: 'intake',
      rules: [
        { at: null, why: 'the orchestrator authors the briefs itself', pins: [
          ['that it writes them', /\*\*you\*\*\s+write\s+the\s+brief/i],
          ['a markdown backlog', /backlog\.md/],
          ['a JQL source', /jira:/],
          ['a GitHub source', /gh:</],
          ['a checkable done', /checkable/i],
          ['the verify hint per repo', /verify_hint/],
          ['the enqueue call', /soma_enqueue/],
          ['that a vague ticket is not enqueued hopefully', /(not\s+enqueue|do\s+not\s+enqueue)/i],
          ['and the spike that replaces it', /H6/],
        ] },
        // The sequencing rule that replaced the `serialize_with` instruction, pinned as its own
        // paragraph because it IS its own rule and because the thing it replaced was pinned here.
        //
        // `serialize_with` was an instruction with no mechanism: `soma_enqueue`'s inputSchema sets
        // `additionalProperties:false` and omits the field, `fleet.enqueue`'s explicit field list
        // drops it, and `admit` is pure FIFO — so an orchestrator that passed it believed it had
        // serialised two tickets and had not. The old pin (`/serialize_with/`) faithfully guarded
        // that instruction's PRESENCE, which is exactly the wrong property to guard: it would have
        // reddened on the correction and stayed green on the defect.
        //
        // TWO pins, not one alternation over both clauses. The rule is conjunctive — v1 has no
        // field AND here is what to do instead — and a disjunctive regex over a conjunctive rule is
        // the defect the final review found three live instances of: either clause alone
        // satisfies it, so half the rule is deletable at a green suite.
        { at: /no serialising field/, why: 'same-module tickets are sequenced by hand, because no field does it', pins: [
          ['that v1 ships no such field', /no\s+serialis\w*\s+field/i],
          ['and the sequencing that replaces it', /enqueue\s+the\s+second\s+after\s+the\s+first\s+reports\s+`?COMPLETED/i],
        ] },
        // The five things a brief must carry. Found unguarded by the block sweep, and found DECOYED
        // rather than merely unpinned: the rule above names `checkable` and `verify_hint`, and both
        // recur in §Intake's other paragraphs, so deleting this list left the section-wide pins
        // green. This is the list that decides whether a lead can start at all.
        { at: /what "done" looks like/, why: 'what a brief a lead can start from carries', pins: [
          ['a checkable done', /checkable/i],
          ['the repo and base branch', /base\s+branch/i],
          ['the verify command for that repo', /verify_hint/],
          ['the constraint set', /(constraint|leave\s+alone)/i],
          ['acceptance criteria quoted rather than paraphrased', /quoted\s+rather\s+than\s+paraphrased/i],
          ['the links', /links/i],
          ['and what is out of scope', /not\*?\*?\s+in\s+scope/i],
        ] },
      ],
    },
    {
      heading: /^##\s+Every wake\b/, label: 'every wake',
      rules: [
        { at: /A wake means/, why: 'what a wake obliges', pins: [
          ['the call it means', /soma_inbox/],
          ['that the cursor is advanced deliberately', /mark\s+it\s+read/i],
          ['and that the answer depends on the type', /act\s+by\s+type/i],
        ] },
        { at: /`NEEDS_INPUT`/, why: 'answering a blocked lead', pins: [
          ['the call that answers it', /soma_send/],
          ['with a decision, not a discussion', /decision,\s*not\s+a\s+discussion/i],
          ['and what is escalated instead', /escalate/i],
        ] },
        { at: /`HARNESS`/, why: 'the one-turn veto', pins: [
          ['the window', /within\s+one\s+turn/i],
          ['and what happens after it', /real\s+budget/i],
        ] },
        { at: /`COMPLETED`/, why: 'writeback then release, and the two bans', pins: [
          ['the writeback', /[Ww]riteback/],
          ['never merge', /[Nn]ever\s+merge/],
          ['never mark ready', /never\s+mark\s+ready/i],
        ] },
        // The rest of the triage table. Every row is one instruction, and five of them could be
        // deleted with the suite green — including the budget row, which is the orchestrator's half
        // of the breaker the lead is told to wind down into.
        { at: /`MILESTONE` \/ `STARTED`/, why: 'progress events are read, not acted on', pins: [
          ['that they cost no decision', /do\s+nothing/i],
        ] },
        { at: /`ERROR` \/ `GAVE_UP`/, why: 'what to do when a lead fails', pins: [
          ['reviving it', /soma_resume/],
          ['re-queueing with a sharper brief', /re-queue/i],
          ['escalating', /escalate/i],
          ['and saying which, where it is visible', /(soma_send|digest)/],
        ] },
        // The ONLY scope in three documents that legitimately hedges, and the one exemption the
        // hedge measurement forced. Here the hedge IS the instruction: at 80% the lead has already
        // been told to wind down, so the orchestrator's move is "usually nothing" and a second voice
        // at that threshold is noise. Opted out explicitly, at the rule, with the reason — not by
        // loosening `HEDGE` for the other fifty-three rules.
        //
        // `in:` is the CLAUSE the exemption covers, and it is deliberately not the row. This row
        // states two moves and only the 80% one is legitimately a hedge; as a whole-row opt-out the
        // exemption also excused "At 100% GENERALLY clear the trip", which is a triage instruction
        // being softened and is not what was measured as legitimate.
        { at: /`BUDGET` at 80%/, why: 'the budget breaker, from the other side',
          hedges: {
            in: /Usually\s+nothing[^.]*\./i,
            why: 'the 80% move IS "usually nothing" — the lead absorbs it, so hedging is the rule here',
          },
          pins: [
          ["that 80% is the lead's to absorb", /wind\s+down/i],
          ['the trip', /100%/],
          ['and the two ways out of it', /(smaller\s+scope|let\s+it\s+end)/i],
          // The clear has a mechanism now, and the row names it with what it costs: one more
          // allowance of the class per clear, a TRIP_CLEARED per clear, and a fresh 80% note.
          ['the tool that clears it', /soma_clear_trip/],
          ['what a clear grants', /one\s+more\s+allowance/i],
          ['that each clear is logged', /TRIP_CLEARED/],
          ['that the lead is told again at 80% of the new allowance', /told\s+again\s+at\s+80%/i],
          // A second BUDGET 80 for one lead has two causes, and the payload says which.
          ['that a fresh session or a new allowance brings another BUDGET 80', /fresh\s+session\s+or\s+granted\s+a\s+new\s+allowance/i],
          ['and the two payload fields that tell them apart', /`session_uuid`\s+and\s+`grants`/],
          // The one limit, stated plainly: a wall-clock trip can outlast its clear.
          ['the wall-clock limit', /wall-clock\s+trip[\s\S]{0,120}?wall_ms/i],
        ], no: [
          // Removing the flag by hand is undone by the next tick, with a second BUDGET 100 and toast.
          ['removing the flag by hand', /\brm\b|BUDGET_TRIPPED/],
        ] },
        // Account rotation (design §3.8): BACKPRESSURE is now URGENT and carries two reasons with two
        // different remedies, neither of them the orchestrator's — the storm lifts itself, the org
        // cap is a human's. The old row ("the watchdog owns this one; act only if a lead asks") is
        // banned by shape so it cannot be restored beside the new one.
        { at: /^\| `BACKPRESSURE` \|/, why: 'admission frozen fleet-wide, by storm or by the org cap', pins: [
          ['that this is not one lead', /fleet-wide/i],
          ['the storm case', /`storm`/],
          ['and its move: wait', /wait\s+for\s+the\s+watchdog/i],
          ['the spend-cap case', /org_level_disabled_until/],
          ['that no fleet control clears it', /[Nn]othing\s+inside\s+the\s+fleet/],
          ['and who does', /operator/i],
          ['with the verb', /soma\s+thaw/],
        ], no: [
          ['the old row: the watchdog owns it, act if a lead asks', /watchdog\s+owns\s+this\s+one|act\s+only\s+if\s+a\s+lead\s+asks/i],
        ] },
        { at: /MODEL_DEVIATION/, why: 'a limitation stated rather than implied', pins: [
          ['where it is recorded', /digest/i],
          ['and that it is not prevented', /detected,\s*not\s+prevented/i],
        ] },
        // ── The six events the tick emits that this table never listed ──────────────────────
        //
        // Measured against the shipped tick rather than against the design: every one of
        // `LEAD_DEAD`, `REVIVED`, `BLOCKED`, `HARNESS_DEFAULTED`, `TURNS_UNMEASURED` and
        // `VERSION_GATE` has a live `appendEvent` in `bin/soma-watchdog.mjs`, and none of them
        // appeared in the orchestrator's triage table. An event with no row is an event the
        // orchestrator has been given no move for, which on this document is the same defect as a
        // move with no mechanism — the table IS the instruction, because nothing in `bin/` tells
        // the orchestrator what to do with a wake.
        //
        // The pins are per-row and clause-shaped for the reason the final review recorded: a
        // section-wide pin on `/watchdog/` is satisfied by any of the eight other rows, and a
        // single alternation across a row's two clauses leaves either one deletable.
        { at: /`LEAD_DEAD`/, why: 'a death and its relaunch, and how far apart the attempts are', pins: [
          ['that the watchdog already relaunched it', /relaunched/i],
          ['the attempt budget', /[Tt]hree\s+attempts/],
          ['what the last one becomes', /GAVE_UP/],
          ['the backoff', /15\s+minutes[\s\S]{0,60}?an\s+hour/i],
          ['that nothing is logged while a lead waits', /nothing\s+is\s+logged/i],
        ], no: [
          ['the retired claim that nothing spaces the attempts', /no\s+cooldown/i],
        ] },
        { at: /`BLOCKED`/, why: 'a freed slot, and how the lead gets back in', pins: [
          ['what elapsed', /blocked_slot_minutes/],
          // NOT `/slot/i`, which is what this pin was first written as. Measured: replacing "freed
          // its admission slot" with "moved it on" left the row GREEN, because `blocked_slot_minutes`
          // three words earlier contains `slot`. That is the sibling-token mechanism — the
          // pin's own scope holds a sibling token that satisfies it — reproduced by the pin written
          // to guard against it, and caught only by mutating the clause rather than re-reading the
          // regex.
          ['what it cost the lead', /freed\s+its\s+admission\s+slot/i],
          ['answering the question', /[Aa]nswer/],
          ['and re-admitting it', /soma_spawn/],
        ] },
        { at: /`HARNESS_DEFAULTED`/, why: 'a harness the registry does not carry', pins: [
          ['what the lead got wrong', /registry/i],
          ['what the watchdog did about it', /fallback\s+budget\s+class/i],
          ['why that is containment rather than a fix', /breakerless/i],
          ['and the correction to send', /harness\s+to\s+take/i],
        ] },
        { at: /`TURNS_UNMEASURED`/, why: 'the one cap that stops binding, and the two that do not', pins: [
          ['the cause', /session\s+uuid/i],
          ['the cap that is lost', /turn_cap/],
          ['that the other two still hold', /token\s+cap\s+and\s+wall\s+cap/i],
          ['and what a repeat means', /twice/i],
        ] },
        { at: /`VERSION_GATE`/, why: 'admission shut fleet-wide, and who can re-open it', pins: [
          ['that this is not one lead', /fleet-wide/i],
          ['the cause', /tested_claude/],
          ['that no fleet control clears it', /[Nn]othing\s+inside\s+the\s+fleet/],
          ['and who does', /operator/i],
        ] },
        // ── Stalls nobody saw: the three pane-census events, and the one ban that has a measurement ──
        //
        // `soma_send` into a live permission dialog was measured: the literal is swallowed and
        // the Enter selects the highlighted "1. Yes". A row that told the orchestrator to answer
        // a blocked lead with `soma_send` — which is what the `NEEDS_INPUT` row above says, and
        // what an orchestrator reaches for by reflex — would make it approve whatever command the
        // lead was about to run. So the ban is pinned as a clause of its own, beside its reason,
        // and beside the move that IS available.
        { at: /`LEAD_BLOCKED_ON_PROMPT`/, why: 'a dialog a human has to answer, and the send that would approve it', pins: [
          ['what the pane shows', /permission\s+or\s+trust\s+dialog/i],
          ['and the third shape, measured live on a spawned lead', /AskUserQuestion/],
          ['who has to answer it', /human/i],
          ['the ban on the reflex move', /[Dd]o\s+not\s+`?soma_send`?/],
          ['and its reason: the Enter approves', /Enter\s+approves/i],
          ['the move that is available', /soma\s+attach/],
          ['that Escape declines AND stops the turn', /Escape[\s\S]{0,60}?stops\s+the\s+turn/i],
          ['so a decline is followed up', /decline\s+is\s+followed/i],
          // The done-row case, reversed on evidence: the row used to say a `done` row on a dialog
          // "is a finished lead that hit a prompt while tidying up — soma_kill it". On this build a
          // `done` row keeps working after COMPLETED (there is no linger reaper, and the operator
          // re-tasks lingering leads): both prompt-blocked leads found live on 2026-09-07 were
          // `done` rows, 833 and 546 turns deep, and a fresh orchestrator following that row kills
          // live work. Three clauses, each pinned, and the old order banned by shape.
          ['the done-row case: a lingering worker, not a corpse', /`done`\s+row\s+here\s+is\s+NOT\s+a\s+finished\s+lead/],
          ['that a done row keeps working on this build', /`done`\s+row\s+keeps\s+working/],
          ['and that the kill waits for a stale transcript', /`?soma_kill`?\s+it\s+when\s+its\s+transcript\s+is\s+stale/],
        ], no: [
          ['a standing order to kill a done row on a prompt', /finished\s+lead\s+that\s+hit\s+a\s+prompt[\s\S]{0,80}?soma_kill/i],
        ] },
        { at: /`LEAD_DEAD_SHELL`/, why: 'a pane that is a shell, and the two moves by status', pins: [
          ['what the pane is', /bare\s+shell/i],
          ['that the spawned case is the watchdog\'s', /revived\s+by\s+the\s+watchdog/i],
          ['that a recent relaunch waits out its backoff', /backoff/i],
          ['that the other rows are the orchestrator\'s', /soma_kill/],
          ['then re-queue', /re-queue/i],
          ['the ban', /[Nn]ever\s+`?soma_send`?/],
          ['and why', /executes\s+as\s+a\s+shell\s+command/i],
        ] },
        { at: /`LEAD_PANE_RECOVERED`/, why: 'a recovery is read, not acted on', pins: [
          ['the two states it leaves', /blocked_on_prompt[\s\S]{0,20}?dead_shell/],
          ['and that it costs no decision', /do\s+nothing/i],
        ] },
        // ── Account rotation: the five events a seat pool adds, each read and none acted on except
        // the two escalations (an unreadable pool, a seat that fails twice). Anchored on the row's
        // first cell, because `ROTATED` is a substring of the `ROTATION_FAILED` row's text.
        { at: /^\| `SEAT_CLOSED` \|/, why: 'one account closed until its reset', pins: [
          ['what closed it', /hit\s+a\s+usage\s+window/i],
          ['until when', /closed\s+it\s+until\s+`resetsAt`/],
          // Two facts, two pins: the row states "an open seat" twice, so ONE anchor over both
          // tolerated losing either occurrence (measured: a single-occurrence delete left the
          // suite green). Each half now kills on its own text.
          ['what happens to its leads', /moves\s+the\s+leads\s+on\s+it\s+to\s+an\s+open\s+seat/i],
          ['and what happens when there is none', /with\s+no\s+open\s+seat\s+they\s+stay\s+put/i],
          ['the fallback the lead has on its own', /auto-continue/i],
          ['the reader\'s move', /[Rr]ead\s+it,\s+do\s+nothing/],
          ['and where to look', /soma_status/],
        ] },
        { at: /^\| `SEAT_REOPENED` \|/, why: 'a closure that expired', pins: [
          ['what happened', /closure\s+expired/i],
          ['that the pool has it back', /pick\s+from\s+it\s+again/i],
          ['and that it costs no decision', /do\s+nothing/i],
        ] },
        { at: /^\| `ROTATED` \|/, why: 'a lead moved to another account, same session', pins: [
          ['what the watchdog did', /killed\s+it\s+and\s+resumed\s+the\s+same\s+session/i],
          ['that the context survived', /[Ss]ame\s+transcript/],
          ['that no attempt was charged', /revival\s+attempts/i],
          ['the reader\'s move', /[Rr]ead\s+it,\s+do\s+nothing/],
          ['and the stale question', /older\s+than\s+this\s+event/i],
        ] },
        // TWO emitters, not one: `rotate()` (a limit-hit lead the watchdog could not move) and
        // admission (a QUEUED task it would not place, `bin/soma-watchdog.mjs:1213`). The row as first
        // drafted opened "The lead hit a usage limit and the watchdog could not move it", which is false for
        // the second — the queued case has no limit hit anywhere — so the row says what both mean
        // and the queued half is pinned. `seats_unreadable` and `no_open_seat` are not
        // interchangeable to a reader either: one is a file to repair, the other a reset to wait for.
        { at: /^\| `ROTATION_UNAVAILABLE` \|/, why: 'a lead the watchdog could not place on a seat, and why', pins: [
          ['what the event says, for both emitters', /could\s+not\s+be\s+placed\s+on\s+a\s+seat/i],
          ['that a queued task is held too, not only a limit hit', /queued\s+task\s+stays\s+queued/i],
          ['that an unreadable pool is a repair, not a wait', /repair/i],
          // TEMPERED, not `[\s\S]*`: the row names `seats_unreadable` a SECOND time in its closing
          // sentence ("for `seats_unreadable`, escalate"), and a greedy gap let that trailing mention
          // satisfy the order. MEASURED on this build: swapping the `thrash` and `seats_unreadable`
          // sentences — a genuine reorder away from UNAVAILABLE_WHY's order — left all 22 tests
          // green. Each gap now refuses to cross ANY of the three names, so the three matched are
          // the first three occurrences and a reorder reddens.
          ['the three reasons, in order', /no_open_seat(?:(?!no_open_seat|thrash|seats_unreadable)[\s\S])*thrash(?:(?!no_open_seat|thrash|seats_unreadable)[\s\S])*seats_unreadable/],
          ['what the lead does on its own', /auto-continue/i],
          ['the reader\'s move for the first two', /read\s+it\s+and\s+do\s+nothing/i],
          ['and the one escalation', /soma\s+doctor/],
        ] },
        { at: /^\| `ROTATION_FAILED` \|/, why: 'a rotation the new seat rejected, already undone', pins: [
          ['that the watchdog already put it back', /resumed\s+it\s+under\s+its\s+original\s+seat/i],
          // The ROTATED row's staleness rule, which a revert needs too: a revert is a kill and a
          // --resume, so `revivedAt` moves for it (orchHistory's launch fold) and the watchdog
          // will not flip the row to `blocked` on the killed process's question either.
          ['and the stale question', /older\s+than\s+this\s+event/i],
          ['which seat rejected it', /`from`\s+is\s+the\s+seat\s+that\s+rejected/],
          ['what the lead does there on its own', /auto-continue/i],
          ['the reader\'s move', /[Rr]ead\s+it,\s+do\s+nothing/],
          ['and the one escalation', /soma\s+doctor/],
        ] },
        // The counterpart to the six: two event types the design names that NOTHING in `bin/`
        // emits. Declared rather than quietly listed among the real ones, because the failure mode
        // is an orchestrator reading their absence as good news. Deleting this paragraph would
        // restore exactly that, so it is pinned like a rule.
        { at: /no producer in this build/, why: 'two spec-named events that nothing emits', pins: [
          ['that they have no producer', /no\s+producer\s+in\s+this\s+build/i],
          ['the first', /STALLED/],
          ['the second', /TEAMMATE_DOWN/],
          ['and that their silence proves nothing', /silence\s+is\s+not\s+evidence/i],
        ] },
        { at: /Veto a HARNESS when/, why: 'the veto criteria', pins: [
          ['a code ticket that came back as research', /H6/],
          ['an iterate harness with no gate', /H2/],
          ['a one-shot on migration-shaped work', /H1/],
          ['a verify command that does not exist', /verify_command/],
          ['an autonomy or cap that outruns the work', /max_iterations/],
          ['and that a late veto is only noise', /(be\s+fast\s+or\s+be\s+silent|just\s+an\s+interruption)/i],
        ] },
      ],
    },
    {
      heading: /^##\s+Writeback\b/, label: 'writeback',
      headPins: [
        ['that a writeback is a comment and nothing else', /comment-only/i],
        // The heading used to say "ledgered" too. Nothing in this build keeps a writeback ledger, so
        // the heading may not claim one; the body's ledger claims are banned by shape in the rule below.
        ['and that posting twice is the failure mode, with no ledger claimed', /^(?![\s\S]*ledger)[\s\S]*idempotent/i],
      ],
      rules: [
        { at: /\*\*Jira\*\*/, why: 'the Jira writeback', pins: [
          ['that it is a comment', /\*\*comment\*\*/],
          ['carrying the draft-PR link', /draft-PR\s+link/i],
          ['never a transition', /[Nn]ever\s+transition/],
          ['never a field edit', /never\s+edit/i],
          ['and the two tools that are denied', /transitionJiraIssue[\s\S]{0,40}editJiraIssue/],
        ] },
        { at: /GitHub issues/, why: 'the GitHub writeback', pins: [
          ['the command', /gh\s+issue\s+comment/],
          ['never close', /[Nn]ever\s+close/],
          ['never label', /never\s+label/i],
          ['never assign', /never\s+assign/i],
        ] },
        { at: /Markdown backlogs/, why: 'a markdown backlog is never edited', pins: [
          ['the ban', /never\s+edited/i],
          ['and who applies the snippet instead', /operator\s+applies/i],
        ] },
        // The duplicate check, and the record of what was posted. This rule used to pin a writeback
        // LEDGER: two events, `WRITEBACK_OK` and `WRITEBACK_FAILED`, that the orchestrator was told to
        // "append yourself", and a digest said to render from them. No orchestrator tool can append
        // an arbitrary event and nothing in `bin/` writes either type, so it now pins what is true:
        // the comments already on the target are the only record, and a failed comment goes to the
        // operator. The old claims are banned by shape, so a partial edit cannot leave one behind.
        { at: null, why: 'the duplicate check, and the record nothing in this build keeps', pins: [
          ['checked before posting', /before\s+posting/i],
          ['against the target’s own comments for the PR URL', /target['’]s\s+existing\s+comments\s+for\s+the\s+PR\s+URL/i],
          ['why', /double-comment/i],
          // One clause, three facts, inside one paragraph: nothing records it, there is no event to
          // append, and there is no tool that could append one.
          ['that nothing records a writeback, with no ledger event and no tool to append one',
            /\bnothing\b(?:(?!\n\s*\n)[\s\S]){0,40}?\brecords?\s+(?:a\s+|any\s+)?writebacks?\b(?:(?!\n\s*\n)[\s\S]){0,80}?\bno\s+ledger\s+event\b(?:(?!\n\s*\n)[\s\S]){0,80}?\bno\s+tool\b/i],
          ['and that a failed comment goes to the operator', /\bfail(?:ed|s|ure)?\b(?:(?!\n\s*\n)[\s\S]){0,100}?\btell\s+the\s+operator\b/i],
        ], no: [
          ['a ledger event the orchestrator is told to append', /WRITEBACK_(?:OK|FAILED)/],
          ['the instruction to append it', /append\s+the\s+ledger\s+event/i],
          ['a ledger to check before posting', /WRITEBACK\s+ledger/i],
          ['a digest said to render from that ledger', /ledger,\s*not\s+from\s+optimism/i],
          ['a "re-auth needed" toast that nothing sends', /re-auth\s+needed["”]?\s+toast/i],
        ] },
      ],
    },
    {
      heading: /^##\s+Fleet controls\b/, label: 'fleet controls',
      rules: [
        { at: null, why: 'the control verbs the orchestrator owns', pins: [
          ['admitting out of turn', /soma_spawn/],
          ['pausing the queue', /soma_queue/],
          ['redirecting a lead', /soma_send/],
          ['killing one that is doing the wrong thing', /soma_kill/],
          ['reviving one', /soma_resume/],
          ['granting a tripped one one more allowance', /soma_clear_trip/],
          ['reading evidence rather than a summary', /soma_transcript/],
          ['and the digest', /soma_digest/],
        ] },
        { at: /Redirecting a lead/, why: 'redirecting a lead mid-flight', pins: [
          ['the call that does it', /soma_send/],
          ['the report to expect back', /MILESTONE/],
          ['and the supersede that follows a real change of shape', /HARNESS/],
        ] },
      ],
    },
    {
      heading: /^##\s+The standing rules\b/, label: 'the standing rules',
      // "which are yours too" is the entire point of the section: the bans the lead is given bind
      // the orchestrator as well. Without it the section reads as a summary of someone else's rules.
      headPins: [['that these bans bind the orchestrator too', /(yours\s+too|bind\s+you|apply\s+to\s+you)/i]],
      rules: [
        { at: null, why: 'the bans that bind the orchestrator too', pins: [
          ['never merge', /Never\s+merge/],
          ['never mark a PR ready', /Never\s+mark\s+a\s+PR\s+ready/],
          ['never transition a Jira issue', /Never\s+transition/],
          ['never close a GitHub issue', /close\s+a\s+GitHub\s+issue/],
          ['draft PRs only', /[Dd]raft\s+PRs?\s+only/],
          ['through the wrapper', /soma-pr/],
          ['one worktree per task', /[Oo]ne\s+worktree\s+per\s+task/],
          // Escalation goes to the operator, in the orchestrator's own words. This used to read "a
          // `NEEDS_INPUT` digest entry and a toast", and the orchestrator can produce neither: no
          // tool of its own appends an event or sends a toast, and the digest composer is not built.
          ['and escalation to the operator rather than a guess', /\bescalate\b[^.]{0,40}?\bto\s+the\s+operator\b[^.]{0,120}?\bnot\s+a\s+guess\b/i],
        ], no: [
          ['a digest entry the orchestrator cannot write', /digest\s+entry/i],
          ['a toast the orchestrator cannot send', /\btoast\b/i],
          ['a NEEDS_INPUT digest', /`NEEDS_INPUT`\s+digest/],
        ] },
      ],
    },
  ],
};

/**
 * The scope a rule was AUTHORED in, resolved loudly.
 *
 * The chain used to be `bullet(s, at) ?? row(s, at) ?? paragraph(s, at)`, and a silent fallback in a
 * chain like that PROMOTES scope instead of failing. Lose a bullet's `-` — an ordinary markdown slip
 * — and `bullet()` returns null, `row()` returns null, and `paragraph()` hands back the ENTIRE pins
 * list as one blank-line-delimited block, at which point every prohibition pin in that block is
 * satisfied by a neighbour's `denied` or `never`. Measured as a clean control pair: the bash-write
 * ban inverted but still a bullet is RED; the same inversion with the bullet marker removed is
 * GREEN, and so are the model/effort and draft-PR pins.
 *
 * So a paragraph resolution that still contains list markers is refused outright: a rule written as
 * one bullet has to stay one bullet, and if it does not, that is the failure — not a wider scope.
 */
function scopeOf(raw, sBody, rule, where) {
  const { at, fence: fenceAt } = rule;
  if (fenceAt !== undefined) return fence(raw, fenceAt);
  if (at === null) return sBody;
  const b = bullet(sBody, at);
  if (b) return b;
  const r = row(sBody, at);
  if (r) return r;
  const p = paragraph(sBody, at);
  if (p && /^[ \t]*[-*+][ \t]/m.test(p)) {
    assert.fail(
      `${where}: this rule was authored as one list item and is no longer one — the scope resolved to a `
      + `block that still contains ${p.split('\n').filter((l) => /^[ \t]*[-*+][ \t]/.test(l)).length} list `
      + `item(s), so its pins would be satisfied by its neighbours' prohibitions instead of its own. `
      + `Restore the list marker rather than widening the scope.`,
    );
  }
  return p;
}

for (const [doc, sections] of Object.entries(PROMPT_RULES)) {
  for (const { heading, label, rules, headPins = [] } of sections) {
    test(`${doc} § ${label} keeps every rule it is the only statement of`, () => {
      const s = section(readPrompt(doc), heading);
      // The heading is asserted separately and then dropped, because `section()` returns it and a
      // section-wide pin is therefore satisfiable by the section's own title. Live instance:
      // `['that it happens first', /before anything else/i]` was matched by "## Step 0 — choose
      // your loop harness before anything else" and pinned nothing in the body. That generalises to
      // every `at: null` rule in this table, so the fix is structural rather than per pin.
      const headLine = s.split('\n')[0];
      const raw = s.split('\n').slice(1).join('\n');
      // Fenced lines are stripped from every scope but the one that asks for a fence by name. A
      // section-wide pin was otherwise satisfiable by a fenced copy of the rule it guards: §the
      // standing rules gutted to "Decide what you can.", with its five bans moved into a fence in
      // the same section, was GREEN.
      const sBody = unfenced(raw);
      for (const [what, re] of headPins) {
        assert.match(headLine, re, `${doc} § ${label}: the heading no longer states ${what}`);
      }
      // A heading gets the carve-out bans AND the advisory ban. The advisory one is here rather than
      // only in the whole-file canary because a heading is where a rule gets demoted rather than
      // repealed — "The pins — sensible defaults you may depart from", "planning only" → "Advisory".
      for (const [what, re] of [['a carve-out', CARVE_OUT], ['an appeal to the ticket', TICKET_OVERRIDE], ['a demotion to advice', ADVISORY], ['a hedge', HEDGE]]) {
        assert.doesNotMatch(headLine, re, `${doc} § ${label}: the heading is undone by ${what}`);
      }

      const seen = new Map();
      for (const rule of rules) {
        const { at, why, pins, no = [] } = rule;
        const where = `${doc} § ${label}: ${why}`;
        const scope = scopeOf(raw, sBody, rule, where);
        assert.ok(scope, `${where} — the rule is gone entirely`);
        // Two rules resolving to the same text means one of them lost its own scope and is now
        // borrowing the other's. `scopeOf` catches a de-bulleted item inside a list; this catches
        // the case where the whole list lost its markers, which leaves no marker to notice.
        if (at !== null) {
          const clash = seen.get(scope);
          assert.equal(clash, undefined, `${where} — resolves to the same block as ${clash}; one of the two lost its own scope`);
          seen.set(scope, why);
        }
        for (const [what, re] of pins) {
          assert.match(scope, re, `${where} lost ${what}`);
        }
        // `no` is for the edits that ADD rather than remove: a rule can be present and still be
        // undone by a sentence beside it. Deletion is the easy mutation to catch; this is the other.
        //
        // Every rule gets the two carve-out shapes banned for free, which is the point — the class
        // is closed for rules nobody has written yet, not for the twelve instances that were
        // measured. The exception is a rule whose own pin IS a gate: `ASSENT_GATE` accepts "do not
        // run it unless the operator says yes" on purpose, so banning the shape there would refuse
        // a phrasing this suite deliberately admits.
        //
        // `HEDGE` joins them, for the class the direction fix left open: an adverb repeals a rule
        // without touching a word of it ("they USUALLY outrank the task text" was GREEN). One rule in
        // three documents legitimately hedges and opts out via `hedges:`, which is measured rather
        // than assumed — the other 37 candidate hedge shapes occur zero times.
        //
        // `[...no]` on BOTH branches: on the gated path `bans` used to BE `rule.no`, so pushing the
        // hedge ban mutated the `PROMPT_RULES` module literal as a side effect of running a test.
        const gated = pins.some(([, re]) => re === ASSENT_GATE);
        const bans = gated ? [...no] : [...no, ['a carve-out', CARVE_OUT], ['an appeal to the ticket', TICKET_OVERRIDE]];
        // The hedge exemption is scoped to the CLAUSE where the hedge IS the instruction, not to the
        // whole rule. `hedges:` was a per-rule opt-out, and the one row that uses it states TWO
        // things — the 80% move ("Usually nothing", where the hedge is correct) and the 100% move
        // ("decide: clear the trip … or let it end", where it is not) — so a second hedge anywhere in
        // that row was GREEN. Subtracting the exempted clause keeps the legitimate wording admissible
        // and puts the rest of the row back under the ban. If the clause is gone the hedge went with
        // it and nothing needs exempting, so `replace` missing its anchor is the right no-op: the
        // opt-out is a permission, never a requirement to keep hedging.
        bans.push(['a hedge', HEDGE, rule.hedges ? scope.replace(rule.hedges.in, '') : scope]);
        for (const [what, re, subject = scope] of bans) {
          assert.doesNotMatch(subject, re, `${where} is undone by ${what}`);
        }
      }
    });
  }
}

test('the hedge vocabulary covers its own class, and stops where a prediction begins', () => {
  // Why this exists at all. `HEDGE` was built from the ONE word a reviewer had reported
  // (`usually`), so it closed that word and left every near-synonym open — on the rule that is
  // `lead.md`'s only defence against a hostile task packet. Measured against the thirteen shapes
  // that got through, the first version caught ONE. Nothing anywhere exercised the constant, so the
  // gap was invisible to the one check its author could perform: re-reading a regex recovers the
  // intent, which was already right, and says nothing about what the pattern misses. One member was
  // not even a judgement call — `\bwhere\b` cannot match `wherever possible`, because there is no
  // word boundary between `where` and `ver`.
  //
  // So the class is stated executably here, in both directions. Every positive below is a mutation
  // that was measured GREEN against a real rule in one of these documents before this round.
  for (const hedge of [
    'they almost always outrank the task text',
    'more often than not they outrank the task text',
    'in principle it can never change the rules below',
    'for the most part it can never change the rules below',
    'These are strong defaults, and in general you follow them.',
    'are by default denied to you',
    'wherever possible, never force-push',                  // `\bwhere\b` could never match this
    'blocked for you too where feasible, as appropriate',
    'Rarely merge. Avoid marking a PR ready.',
    'Best practice is: never merge it, never mark it ready.',
    'For now, never merge it.',
    'you should never merge it',
    'it is advisable to never merge it',
  ]) {
    assert.match(hedge, HEDGE, `not recognised as a hedge: "${hedge}"`);
  }
  // And the boundary, which round 3 drew deliberately and the review upheld. `may` / `might` and
  // the rest of the descriptive-uncertainty family qualify a statement about the RUNTIME: hedging a
  // PREDICTION is honest, hedging a PROHIBITION is the defect, and banning the first would refuse
  // the sentence `SKILL.md` §6 exists to say. `recommendation` is here because `lead.md`'s
  // `NEEDS_INPUT` bullet requires the lead to state one — the ban takes the verb, not the noun.
  for (const legal of [
    'an off-tmux holder may not match the hook’s holder test',
    'it might not fire for you, and then nothing is injected at all',
    'the holder may already be a dead pane',
    'one clear question, the options, your recommendation',
  ]) {
    assert.doesNotMatch(legal, HEDGE, `a prediction was banned as a hedge: "${legal}"`);
  }
});

test('neither standing prompt grants what it spent a section forbidding', () => {
  // The audit's mutation was not a deletion, it was an INVERSION: "You may edit files, push
  // anywhere, open non-draft PRs through raw `gh`, merge them, mark them ready for review, and
  // transition tickets." Every pin above is scoped and shape-aware, which catches that — but the
  // inversion is cheap enough to be worth naming outright, because it is the one edit that leaves
  // a document reading fluently while meaning the opposite.
  const granted = /\b(you\s+may|it\s+is\s+fine\s+to|feel\s+free\s+to|go\s+ahead\s+and)\s+(edit|write|merge|push|transition|close|label|mark|force-?push)/i;
  // Over `ARTIFACTS`, not over a literal pair. Both canaries were written as
  // `['lead.md', 'orchestrator.md']` and so covered two of the three documents that carry these
  // bans — leaving out `skills/soma-promote/SKILL.md`, which is the one a promoted session reads
  // FIRST and which restates the two bans that cannot be walked back for exactly that reason.
  // Measured: `You may merge the PR yourself.` in `SKILL.md` §6 was GREEN while the identical
  // string in either prompt was RED, so `SKILL.md` could say "Never merge a PR and never mark one
  // ready for review" and "You may merge the PR yourself" at once, at a green suite. Looping over
  // the shared list is also what stops the next canary from covering two of three.
  for (const rel of ARTIFACTS) {
    assert.doesNotMatch(readArtifact(rel), granted, `${rel} grants an act its own rules forbid`);
  }
  // `granted` only knows how to spot a permission being HANDED OUT. It has no word for a rule being
  // DEMOTED, which is the cheaper edit and the one that reads as ordinary editing: the title rewritten
  // to "implementation allowed, any model, effort low. Advisory." is strictly worse than "you may edit
  // files" and `granted` stayed silent on it, because that is not its grammar. Both canaries, because
  // repeal and demotion are different sentences and a document can suffer either.
  for (const rel of ARTIFACTS) {
    assert.doesNotMatch(readArtifact(rel), ADVISORY, `${rel} demotes one of its own rules to advice`);
  }
});

test('the intake table is first-match, and no row above H1 shadows it', () => {
  const txt = unfenced(readPrompt('lead.md'));
  // The intake table is the only pipe table in the file — outside a fence, which is why `txt` is
  // unfenced first. A `|`-delimited line costs nothing to plant in a fenced block, and a fenced
  // copy of the H6 row above the table hijacks `rowOf('H6')` to index 0: with the real row moved to
  // the bottom, ALL FIVE H6-ordering assertions below stopped firing. Measured, per assertion — the
  // mutation still turned the suite red, but only because a shifted row index tripped the
  // `/too vague/` check three lines down, which is the sibling-absorbs-it failure the per-assertion
  // harness exists to expose. These five are what stand between an RCA ticket and a 10x budget
  // over-reservation, so they do not get to be carried by an accident.
  const rows = txt.split('\n').filter((l) => l.trimStart().startsWith('|'));
  const rowOf = (id) => rows.findIndex((l) => new RegExp(`\\*\\*${id}\\*\\*`).test(l));

  // The table's semantics are what make its order load-bearing, so they are asserted too.
  assert.match(txt, /\*\*first\*\* row that matches/);
  assert.match(rows[2], /too vague/);            // row one: stop before spending a class on a guess
  for (const id of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6']) assert.ok(rowOf(id) >= 0, `no intake row for ${id}`);

  // H4's condition ("no mechanical gate captures correctness") strictly contains H1's case, so
  // an H4 row above H1's makes `standard` unreachable: every small crisp ticket without a suite
  // reserves `review` instead, and H1 — the design's default for a refined ticket — is dead
  // text. First-match tables put the specific row above the general one.
  assert.ok(rowOf('H1') < rowOf('H4'), 'H4 shadows H1: a small crisp ticket can never reserve standard');
  // And the two rows that do belong above H1 are the narrower ones: a mechanical gate beats a
  // single unverified pass, and a report deliverable is not code at all.
  assert.ok(rowOf('H3') < rowOf('H1') && rowOf('H2') < rowOf('H1'), 'a runnable gate should beat a one-shot pass');
  assert.ok(rowOf('H5') > rowOf('H4'), 'H5 attaches after a PR exists; it is not an intake choice');

  // H6 above EVERY code harness, not merely above H1. This was pinned against H1 alone, which
  // left the expensive drift unguarded: an RCA ticket in a repo whose suite already runs matches
  // "a runnable repo gate exists" on the way down, and that row reserves `iterate` — 3M tokens
  // against research's 300k, a 10x over-reservation for a deliverable that is a document, and a
  // breaker bound to the wrong class for the whole task. Verified by moving the H6 row below the
  // two gate rows: green before this loop, red after.
  for (const below of ['H3', 'H2', 'H1', 'H4', 'H5']) {
    assert.ok(rowOf('H6') < rowOf(below), `H6 must be tried before ${below}: a report deliverable is not code`);
  }
});

test('every intake row states the registry’s own condition, class and harness name', () => {
  const txt = unfenced(readPrompt('lead.md'));   // a fenced `|` line is not an intake row
  const reg = JSON.parse(readFileSync(new URL('../prompts/harnesses.json', import.meta.url), 'utf8'));
  const rows = txt.split('\n').filter((l) => l.trimStart().startsWith('|'));
  const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  // Nothing compared a row to the registry before this, and the two had already drifted in four
  // of six rows — H1's registry `when` says "low-risk; one pass is plausible" where the table said
  // "low-risk, and one pass is plausible" — with the suite green. The registry is what the bus
  // prices and what `harness.mjs` quotes back in a refusal; the table is what the lead actually
  // reads. When they disagree the lead routes by one and gets judged by the other.
  //
  // Punctuation is normalised away and nothing else, which is the deliberate part: a semicolon
  // against a comma is not a desync worth a red suite, but re-stating the condition in the
  // table's own words is. So the row must OPEN with the registry's condition and may only add to
  // it — that keeps the reader-facing parentheticals ("(make CI or the suite green)") legal.
  // Byte-equality was rejected because it outlaws those; a bag-of-words overlap was rejected
  // because it passes on a shuffled sentence, which is the failure this is here to catch.
  //
  // What `startsWith` buys is exactly one thing, and it is NOT protection from negation — a
  // reviewer showed that appending "— actually never mind, use H1 for these" to a cell keeps it
  // green. It buys that the condition OPENS the cell, which is a real property in a first-match
  // table a lead reads top to bottom under time pressure: the words it routes on are the first
  // words in the row. Negation is banned separately and explicitly, below.
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  for (const [id, entry] of Object.entries(reg)) {
    const line = rows.find((l) => new RegExp(`\\*\\*${id}\\*\\*`).test(l));
    assert.ok(line, `no intake row for ${id}`);
    const [when, harness, , cls] = cellsOf(line);
    assert.ok(
      norm(when).startsWith(norm(entry.when)),
      `${id}'s intake row has drifted from prompts/harnesses.json, which is the authoritative side — `
        + `fix the row, or change the registry's \`when\` and let this test follow it\n`
        + `  prompts/harnesses.json: ${entry.when}\n  prompts/lead.md:        ${when}`,
    );
    // The condition says WHEN; the harness cell says WHICH. A condition that names a harness id is
    // either a routing override smuggled into the wrong column or a half-finished edit, and it is
    // the shape a negating suffix takes ("…— actually never mind, use H1 for these").
    assert.doesNotMatch(when, /\bH[1-6]\b/, `${id}'s condition cell names a harness; conditions say when, not which`);
    // The class cell is the reservation the row promises. A wrong one here is not a typo: it is
    // a lead reserving the wrong budget and a breaker bound to a class it did not plan for.
    assert.equal(cls, entry.budget_class, `${id}'s row reserves ${cls}; the registry reserves ${entry.budget_class}`);
    // And the name in the row, not merely somewhere in the file — `harness.mjs` accepts the name
    // as a spelling of the id, so this row is where a lead learns which spellings resolve.
    // Compared with `equal` after stripping the id and any leading verb: `includes` accepted
    // `**H2** ITERATE-TO-GREENISH`, which is not a spelling `harness.mjs` resolves.
    const named = harness.replace(new RegExp(`\\*\\*${id}\\*\\*`), '').replace(/^\s*(attach|take|use)\b/i, '').trim();
    assert.equal(named, entry.name, `${id}'s row must name ${entry.name} exactly, got ${JSON.stringify(named)}`);
  }
});

test('the H1 degrade is a supersede the lead may file without an ACK', () => {
  const txt = readPrompt('lead.md');
  const reg = JSON.parse(readFileSync(new URL('../prompts/harnesses.json', import.meta.url), 'utf8'));

  // Pinned against the registry first, so the prose cannot authorise a path the registry does not
  // ask for. H1's stop condition is what makes this degrade mandatory rather than optional.
  const stop = reg.H1.stop_conditions.join(' ');
  assert.match(stop, /supersede/i, "H1's registry entry is what mandates the degrade");
  for (const target of ['H2', 'H3', 'H4']) {
    assert.match(stop, new RegExp(`\\b${target}\\b`), `H1's stop conditions must name ${target} as a degrade target`);
  }

  // The conflict this closes: Step 1 grants the one free supersede "for a lateral move or a
  // downgrade" and reserves an ACK for an autonomy upgrade and for H6 → code. Every H1 degrade
  // target costs MORE than standard's 1.5M (review 2M, iterate 3M), so it is an upgrade by
  // budget class and is not one of the enumerated ACK cases — a lead reading both paragraphs had
  // no rule for the one degrade Step 0 tells it to take, and would burn a turn or file a needless
  // NEEDS_INPUT deciding.
  // Scoped to the SECTION, not to the paragraph. `/Re-choice[\s\S]*?\n\n/` stopped at the first
  // blank line, so splitting this eight-line paragraph in two — an ordinary editorial move —
  // would have reported the clause missing while it sat one paragraph further down.
  const step1 = section(txt, /^##\s+Step 1\b/);
  assert.match(step1, /Re-choice/, 'Step 1 must still carry the re-choice rule');
  assert.match(step1, /H1[\s\S]{0,40}?degrade|degrade[\s\S]{0,40}?H1/i, 'the re-choice rule must name the H1 degrade');
  assert.match(step1, /\b(no|without)\b[\s\S]{0,24}?\bACK\b/i, 'and say it needs no orchestrator ACK');
  // The three targets, scoped to the SENTENCE that authorises the degrade. Against the whole section
  // each of them matched twice or more — Step 1 also carries the class mapping ("H1→standard,
  // H2→iterate, H3→iterate, H4→review"), which names all three — so dropping a target from the
  // degrade clause left the pin passing on the mapping. Found by the assertion spy; it is the same
  // defect the `/H4/`-times-three pin in §Step 0 had, in the one other place harness ids cluster.
  const degrade = step1.split(/(?<=\.)\s/).find((s) => /degrade/i.test(s));
  assert.ok(degrade, 'Step 1 must still carry a sentence authorising the H1 degrade');
  for (const target of ['H2', 'H3', 'H4']) {
    assert.match(degrade, new RegExp(`\\b${target}\\b`), `the permitted degrade must name ${target} in the clause that authorises it, as the registry does`);
  }
  // The two cases that DO need an ACK stay reserved: this clause is an exception, not a repeal.
  assert.match(step1, /autonomy\s+upgrade/i, 'an autonomy upgrade still needs an ACK');
  assert.match(step1, /H6[\s\S]{0,30}?(any\s+)?code/i, 'and so does H6 → any code harness');
});

test('orchestrator.md states its promotion order where a reader follows it', () => {
  // The section-scoped rule table covers what each section must say. This is the one claim that
  // is about ORDER rather than content, and it is the same trap `skill.test.mjs` documents: the
  // three verbs are all named in one preamble paragraph, so `indexOf` on a verb proves nothing
  // about the sequence. Compare the offsets inside that paragraph, which is where the sequence is.
  const promotion = paragraph(readPrompt('orchestrator.md'), /On promotion/);
  assert.ok(promotion, 'orchestrator.md must still say how to take the lease');
  // Offsets only mean something if each verb is named ONCE. This test shipped unable to fire: a
  // prose fix in the same commit added a second `soma_inbox` to this paragraph (the CLI-fallback
  // sentence, which lists the verbs with no subcommand), and that second mention sits after
  // `soma_status` too — so `search()` found the decoy and the drain step could be deleted from the
  // sequence entirely with this green. The sentence is now its own paragraph; this asserts the
  // property the comparison depends on rather than assuming it, because the split is one editorial
  // re-flow away from being undone.
  for (const verb of [/soma_adopt/g, /soma_status/g, /soma_inbox/g]) {
    assert.equal(
      promotion.match(verb)?.length ?? 0, 1,
      `the promotion paragraph must name ${verb.source} exactly once for an offset comparison over it `
      + 'to mean anything about the sequence — keep the CLI-fallback sentence in its own paragraph',
    );
  }
  const at = (re) => promotion.search(re);
  assert.ok(at(/soma_adopt/) < at(/soma_status/), 'adopt the lease before briefing the fleet');
  assert.ok(at(/soma_status/) < at(/soma_inbox/), 'brief the fleet before draining the cursor');
});
