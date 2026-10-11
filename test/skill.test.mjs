/**
 * `skills/soma-promote/SKILL.md` — the `/soma:promote` skill.
 *
 * The artifact under test is a prompt, not a program: its reader is the model Claude Code
 * loads when the operator asks to take over the fleet. There is no return value to assert,
 * so what is pinned here is the set of facts that, if they fell out of the file, would
 * strand the operator at the exact moment the fleet is theirs to run:
 *
 *   - the frontmatter (a skill Claude Code cannot see is a skill that does not exist);
 *   - the refusal path (`adopted:false` must name the holder and offer force, not just fail);
 *   - brief-then-drain order (`soma_status` before `soma_inbox`) — the summary is what the
 *     operator decides on, and `soma_inbox` moves the cursor, so a body that drained first
 *     would hand them a briefing composed of events they can no longer re-read;
 *   - the CLI fallback, which is the whole reason a warm promotion is safe to offer: the
 *     mid-session role upgrade is unverified against the running Claude Code build, and
 *     without a fallback a session that adopted successfully would look broken;
 *   - the staleness trap, because losing the lease by sitting quiet is silent;
 *   - the writeback bans, which must survive `prompts/orchestrator.md` being unreachable.
 *
 * Regexes are deliberately loose on prose and tight on identifiers: rewording the skill
 * should not turn the suite red, but dropping `soma_adopt`, `force`, the fallback, or the
 * "never merge" ban should. Every multi-word phrase is matched across `\s+` (and spans use
 * `[\s\S]`, not `.`) so that re-wrapping a paragraph — which a prose file invites — cannot
 * fail an assertion about content. The first draft of this file failed exactly that way.
 *
 * Loose on prose is not licence to be loose about WHERE. A prompt repeats its own vocabulary
 * — `holder`, `force`, `operator`, `soma_status` each appear in three or four sections — so a
 * whole-body `assert.match` is satisfied by any one of them and pins none of them. Two
 * assertions here shipped vacuous for exactly that reason: an ordering check read the
 * preamble's mention instead of the step, and an operator-assent alternation carrying a bare
 * `ask` matched inside the word "task". So: scope content assertions to the `section()` they
 * belong to, compare positions via `sectionLine()` (headings) and never via `indexOf` on a
 * verb, and give every single-word canary a phrase or a shape to stand on.
 *
 * The corollary that pass missed: a pin can be too tight and its structural backstop vacuous at
 * the same time, and then the tightness is all that is holding the line. `only if the operator`
 * demanded one exact token run — seven rewordings that all still gate the steal on explicit
 * operator assent turned this file red, against the intent stated two paragraphs up — while its
 * companion "the gate sits with the offer" check accepted any `operator` within 200 characters
 * of `force: true`, which the reporting sentence one line earlier already supplies. Deleting the
 * gate outright left that backstop green. A proximity check must therefore carry the CLAUSE it
 * is localising and never a word the clause happens to contain; where a section is scoped by a
 * heading, the scan that finds that heading must also know what a fenced code block is.
 *
 * And knowing where a fence STARTS is not the same as keeping its contents out of scope. Every
 * `section()` here is wrapped in `unfenced()`, because a fenced block is an example and never the
 * statement of a rule: measured on the sibling artifact, a section reduced to one harmless sentence
 * with its real rules moved verbatim into a fence in the same section stayed GREEN. `SKILL.md` ships
 * four fences, one of them a `#`-commented shell block, so the hazard is live here rather than
 * hypothetical.
 */
import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Shared with `harness.test.mjs`, because `prompts/lead.md` and `prompts/orchestrator.md` need the
// same scoping and the same force-steal gate, and a fence parser duplicated across two test files
// is a fence parser that gets fixed in one of them.
import {
  ASSENT_GATE, CARVE_OUT, GATE_NEAR, HEDGE, TICKET_OVERRIDE, UNGATED,
  fence, paragraph, row, section, sectionLine, unfenced,
} from './prose.mjs';

const SKILL_URL = new URL('../skills/soma-promote/SKILL.md', import.meta.url);
const read = () => readFileSync(SKILL_URL, 'utf8');

/**
 * Split YAML frontmatter from body without a YAML parser (zero runtime deps, and the
 * frontmatter Claude Code accepts here is a flat `key: value` map anyway).
 *
 * The delimiter regex is anchored at byte 0 on purpose: frontmatter that does not open the
 * file is not frontmatter, and a skill whose `---` sits after a stray blank line loads with
 * no name at all.
 */
function parse(txt) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(txt);
  assert.ok(m, 'SKILL.md must open with a --- delimited frontmatter block at byte 0');
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: txt.slice(m[0].length) };
}

// The original spec test, verbatim: the two facts every other assertion here builds on.
test('skill frontmatter is user-invocable and names soma_adopt', () => {
  const txt = read();
  assert.match(txt, /name:\s*soma-promote/);
  assert.match(txt, /soma_adopt/);
});

test('frontmatter is well-formed and the name matches the skill directory', () => {
  const { fm } = parse(read());

  assert.equal(fm.name, 'soma-promote');
  // Claude Code's skill-name grammar. A capital or an underscore here does not warn — the
  // skill is simply skipped, and `/soma:promote` silently does nothing.
  assert.match(fm.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  // The loader keys the skill on its directory; a name that disagrees is a rename accident.
  assert.equal(basename(dirname(fileURLToPath(SKILL_URL))), fm.name);

  assert.ok(fm.description, 'frontmatter needs a description — it is the whole discovery surface');
  assert.ok(
    fm.description.length >= 40 && fm.description.length <= 1024,
    `description must be substantive and under the 1024-char cap, got ${fm.description.length}`,
  );
});

test('the description carries the phrases the operator actually says', () => {
  const { fm } = parse(read());
  // Discovery is fuzzy matching against this one string; each of these is a documented way
  // the operator reaches for promotion (spec §5).
  for (const trigger of [/\/soma:promote/, /\bpromote\b/i, /take\s+over\s+the\s+fleet/i, /orchestrator/i]) {
    assert.match(fm.description, trigger, `description must be discoverable via ${trigger}`);
  }
});

test('step one adopts, and a refusal names the holder and offers force on the operator’s yes', () => {
  const { body } = parse(read());
  // Scoped to §1, because `holder`, `force` and `operator` all recur further down the file:
  // a whole-body match here can be satisfied by §5's DEMOTED advice or §6's parity table
  // while §1 itself has gone quiet. The section is the unit that has to be right.
  const s1 = unfenced(section(body, /adopt the lease/i));

  assert.match(s1, /soma_adopt/);
  // The unforced call is the DEFAULT, and saying so is what keeps `force: true` exceptional. The
  // sentence that says it ("Call `soma_adopt` with no arguments.") was deletable with the suite green.
  assert.match(s1, /with\s+no\s+arguments/i, 'the plain adopt takes no arguments — otherwise `force` reads as routine');
  assert.match(s1, /adopted:\s*false/, 'the refusal case must be named in the reply shape the tool returns');
  // A bare `/holder/i` also matches "the old holder's pane" one sentence later, so the
  // reply-shape sentence could be deleted whole with this green. Pin the shape itself, plus
  // the field the operator is told to read out (how long since that holder was alive).
  assert.match(
    s1,
    /holder:\s*\{[^}]*session_id[^}]*\}/,
    'a refusal must tell the operator WHO holds the lease, in the shape the tool returns',
  );
  assert.match(s1, /heartbeat_at/, 'including the heartbeat age — the operator decides on it');

  // Carried forward from the `soma_adopt` work. §1 told the operator that `adopted: false` PROVES
  // the holder is live, and that is true only when `holder_live === true`: the bus answers
  // `holder_live: null` when the staleness check could not run, and that work measured a DEAD
  // orchestrator pane reading as live. So this file was making a false guarantee to an operator
  // about the most destructive action in the system — force-stealing a live lease — and the
  // guarantee is exactly what an operator would say yes on. The prose deliberately treats `null`
  // and ABSENT as the same case, which is what makes it true on this branch too: `holder_live` is
  // not in `bin/` here (see the report), so a model reading this today falls into the "could not
  // check" arm, which is the safe one.
  const refusal = paragraph(s1, /adopted:\s*false/);
  assert.ok(refusal, 'the refusal case must still be explained where the reader meets it');
  assert.match(refusal, /holder_live/, 'the liveness claim must name the field it actually depends on');
  assert.match(refusal, /holder_live[^.]{0,80}\btrue\b/, 'the value that makes the refusal proof of liveness');
  assert.match(refusal, /\bnull\b[\s\S]{0,60}absent|absent[\s\S]{0,60}\bnull\b/i, 'and that a missing field is the same case as null, not a pass');
  assert.match(
    refusal,
    /(could\s+not\s+(?:run|check)|cannot\s+(?:run|check)|does\s+not\s+prove|proves\s+only)/i,
    'plus what the refusal does NOT prove when the check did not run',
  );
  // The unqualified guarantee must not creep back. Every claim that a refusal proves liveness has to
  // sit beside the field that establishes it — windowed rather than banned outright, because on
  // `holder_live: true` the claim is TRUE and a rewrite is allowed to say so.
  for (const m of refusal.matchAll(/\bprove[sd]?\b[\s\S]{0,40}?\blive/gi)) {
    assert.match(
      refusal.slice(Math.max(0, m.index - 200), m.index + 200),
      /holder_live/,
      'a refusal is only proof of liveness next to `holder_live` — an unconditional version of this claim is the false guarantee this check was added for',
    );
  }
  assert.match(s1, /force:\s*true/, 'the skill must offer the documented steal, soma_adopt({force: true})');

  // The most safety-critical line in the artifact. A force-steal send-keys a demotion notice
  // into a live session, appends DEMOTED, and cuts that session's event feed mid-flight: the
  // operator's call, never the model's. Asserted twice, and the second is the load-bearing one:
  // `near` is a substring of `s1`, so the windowed match implies the section-wide one and the
  // first assertion can never be the sole failure. It is kept for its message — "no gate at all"
  // and "gate stranded away from the offer" are different repairs, and a reader who sees only
  // the windowed failure would go looking for a sentence that is genuinely missing.
  assert.match(s1, ASSENT_GATE, 'the force-steal must be gated on an explicit operator yes');

  // Attached. The check this replaces accepted any `\boperator\b` within 200 characters of
  // `force: true` — which the reporting sentence one line up ("Tell the operator **who** holds
  // it") already supplies, so it stayed green with the gate sentence deleted outright and it
  // stayed green with the gate moved to the far end of §1. Localising the CLAUSE rather than a
  // word inside it is the whole difference; the window is measured on GATE_NEAR.
  //
  // EVERY occurrence of the flag is windowed, and one carrying the gate is enough. Keying off
  // `search()` — the first — meant a legitimate edit that named `force: true` earlier in §1 (in
  // the refusal's reply shape, say) slid the window off the gate and reported a missing gate
  // that was in fact right where it belongs.
  const offers = [...s1.matchAll(/force:\s*true/g)];
  assert.ok(offers.length, 'the skill must offer the documented steal, soma_adopt({force: true})');
  const windows = offers.map((m) => s1.slice(Math.max(0, m.index - GATE_NEAR), m.index + GATE_NEAR));
  assert.ok(
    windows.some((w) => ASSENT_GATE.test(w)),
    `the gate must sit with the offer of the steal, not stranded elsewhere in the section (checked ${offers.length} offer site(s))`,
  );
  // A gate nearby does not undo an explicit ungating. The one destructive edit the pair above
  // still admitted: leave a real gate clause 40 characters away but attached to the REPORTING
  // act, and hand the steal itself to the model's judgement.
  for (const w of windows) {
    assert.doesNotMatch(w, UNGATED, 'the steal must not be left to the model’s discretion beside its own gate');
  }
  assert.match(s1, /DEMOTED/, 'and the cost of a steal must be stated, so the yes is informed');
});

test('the briefing step says what to summarize, and what to lead with', () => {
  const { body } = parse(read());
  // §2 shipped with no content pin at all — the ordering test holds its heading in place, and
  // §3 got a content pin, but every instruction inside §2 could be deleted with the suite green.
  // Verified by emptying it: heading kept, all guidance gone, ten of ten tests passing.
  const s2 = unfenced(section(body, /brief the fleet/i));

  assert.match(s2, /soma_status/, 'the step must name the call it is about');
  // The failure mode is not silence, it is a wall of JSON: the tool returns a large object and
  // the reader is a human watching a pane, so the instruction is to summarize and the ban on
  // dumping the payload is separate from it.
  assert.match(s2, /summariz|summaris/i, 'the briefing is a summary — the skill must say so');
  assert.match(s2, /(do\s+not|don't|never)[\s\S]{0,24}dump[\s\S]{0,16}JSON/i, 'and it must forbid dumping the raw payload');

  // What one per-lead line has to carry before the operator can decide anything. `\b` on each,
  // because `status` is a substring of `soma_status` two words earlier and would have pinned
  // nothing (`_` is a word character, so the boundary is real).
  for (const [what, re] of [['the lead id', /\bid\b/], ['its status', /\bstatus\b/], ['its harness', /\bharness\b/i]]) {
    assert.match(s2, re, `a per-lead line must carry ${what}`);
  }
  // The fleet-level facts no per-lead line shows. Phrases, not words: a bare /watchdog/i is
  // already satisfied by `watchdog_alive` in the next sentence and would pin nothing here.
  for (const [what, re] of [['queue depth', /queue\s+depth/i], ['backpressure', /backpressure/i], ['watchdog health', /watchdog\s+health/i]]) {
    assert.match(s2, re, `the briefing must cover ${what}`);
  }

  // The one item that is an action and not information: with the watchdog down nothing spawns,
  // revives or drains, so a fleet that reads as idle is inert and the operator has to be told to
  // start it. Both halves pinned — the field the tool returns, and the command that fixes it.
  assert.match(s2, /watchdog_alive:\s*false/, 'the dead-watchdog case must be named in the field the tool returns');
  assert.match(s2, /soma\s+up/, 'and the command that revives it — nothing spawns or drains without it');

  // Ordering advice, because a briefing that buries the decision is one the operator acts on late.
  assert.match(s2, /(lead\s+with|first)[\s\S]{0,40}?decision/i, 'the briefing must lead with whatever needs a decision');
});

test('a granted lease is briefed with soma_status and only then drained with soma_inbox', () => {
  const { body } = parse(read());
  assert.match(body, /adopted:\s*true/);
  assert.match(body, /soma_status/);
  assert.match(body, /soma_inbox/);

  // Both positions come from the HEADING scan, not from the first prose mention. The preamble
  // names `soma_status` in its opening sentence, so the old
  // `body.indexOf('soma_status') < body.indexOf('soma_inbox')` was satisfied by that mention
  // at offset ~146 whichever order the steps ran in: swapping §2 and §3 wholesale — the exact
  // drain-before-brief body this test exists to reject — left it green.
  const briefAt = sectionLine(body, /soma_status/);
  const drainAt = sectionLine(body, /soma_inbox/);
  assert.ok(
    briefAt < drainAt,
    `summarize the fleet (§ at line ${briefAt}) before draining events (§ at line ${drainAt}) — the drain moves the cursor`,
  );
  // …and the reason travels with the step, so the order is a rule and not folklore.
  assert.match(unfenced(section(body, /soma_inbox/)), /cursor/i, 'the drain step must say that it advances the cursor');
});

test('§4 hands off to prompts/orchestrator.md with all four duties named', () => {
  const { body } = parse(read());
  assert.match(body, /prompts\/orchestrator\.md/);

  // Scoped to §4, which is what the message has always claimed. Found with an assertion spy that
  // counts a regex's matches INSIDE the subject the test passed it: all four duty words already sit
  // in §3's ordering instruction ("answer with `soma_send`", "then `COMPLETED` (writeback)", "then
  // `HARNESS` (veto…)"), so a whole-body match measured §3 and left §4 — the section the message
  // names — untested. That is a wrong-block pin with a false message, which is the one defect class
  // a deletion sweep can never surface.
  const loop = unfenced(section(body, /Run the orchestrator loop/i));
  // The four are `intake`, not `dispatch`. I wrote `/dispatch/i` here and the spy caught it in the
  // same round: it matched TWICE inside §4 — "Read it before dispatching" as well as "You dispatch;
  // you do not implement" — so the duty it was standing for could be gutted while the pin passed on
  // the handoff sentence. `intake` is the word §4's own list uses, and the dispatch/implement
  // boundary is a different rule, pinned as one below.
  for (const duty of [/intake/i, /veto/i, /answer/i, /writeback/i]) {
    assert.match(loop, duty, `§4, the orchestrator loop, must name its ${duty} duty`);
  }
  assert.match(
    loop,
    /dispatch[^.]{0,30}(do\s+not|don.t)\s+implement/i,
    '§4 must keep the boundary itself, not just the verb: you dispatch, you do not implement',
  );

  // §4 is the ONLY heading across the three documents with no structural anchor holding it: no test
  // scopes to it by heading, so deleting the heading line silently merges the loop contract — "you do
  // not implement", "never merge a PR" — into §3's drain step, where a reader following numbered
  // steps stops before reaching it. The section scope above now anchors it; these assert the merge
  // itself, because that is the damage rather than the missing line.
  assert.ok(
    sectionLine(body, /Run the orchestrator loop/i) > sectionLine(body, /Drain the inbox/i),
    '§4 must be its own section and must follow the drain step',
  );
  assert.doesNotMatch(
    unfenced(section(body, /Drain the inbox/i)),
    /do\s+not\s+implement/i,
    "§4 has been absorbed into §3 — its heading is gone and the loop contract is now inside the drain step",
  );

  // And that the prompt is to be read BEFORE dispatching, which is the instruction rather than the
  // path. Found by the deletion sweep: this sentence — "That prompt is the contract; this skill is
  // only the on-ramp. Read it before dispatching" — was deletable with the suite green, because the
  // three whole-body pins above are all satisfied elsewhere in the file.
  const handoff = paragraph(body, /on-ramp|is the contract/i);
  assert.ok(handoff, 'the skill must still say that orchestrator.md, not this file, is the contract');
  assert.match(handoff, /(contract|on-ramp)/i, 'the skill is the on-ramp; the prompt is the contract');
  assert.match(handoff, /before\s+dispatch/i, 'and it is read BEFORE dispatching, not after the first mistake');

  // The fence under it is where the reader learns WHERE the prompt and the bus actually are. Both
  // lines were deletable with the suite green — the path only ever matched §4's own heading — so the
  // section could say "read the contract" while naming nowhere to read it from.
  const discovery = fence(section(body, /Run the orchestrator loop/i), /soma-bus/);
  assert.ok(discovery, '§4 must still show how to find the bus and the prompt on disk');
  assert.match(discovery, /claude\s+mcp\s+get\s+soma|\.claude\.json/, 'the registered-server lookup');
  assert.match(discovery, /soma-bus\.mjs/, 'the bus path it yields');
  assert.match(discovery, /prompts\/orchestrator\.md/, 'and the prompt path beside it, which is the point of the step');
});

test('the two refusals the skill has to state up front survive', () => {
  const { body } = parse(read());
  // Both found by the deletion sweep, both deletable with the suite green before this, and both are
  // preamble paragraphs no section-scoped test reached.
  //
  // The first is a hard boundary of the same kind as "never merge": a lead promoted into its own
  // orchestrator answers its own NEEDS_INPUT and vetoes its own harness, and the bus refuses it BY
  // DESIGN — so if this paragraph goes, the reader meets that refusal as a bug and works around it.
  const lead = paragraph(body, /promote a lead/i);
  assert.ok(lead, 'the skill must still refuse to promote a lead or a lead’s teammate');
  assert.match(lead, /[Nn]ever\s+promote/, 'stated as a prohibition, not as a caveat');
  assert.match(lead, /SOMA_LEAD_NAME/, 'naming the variable that decides it');
  assert.match(lead, /refuses/i, 'and that the tool refuses rather than misbehaving');
  assert.match(lead, /own\s+orchestrator/i, 'with the reason, so it is not read as a bug to route around');

  // The second is the one exception to the headline "no restart" claim — which IS pinned. Without
  // it the file promises a restart is never needed and says nothing about the single case where it
  // is, which strands the operator at the only moment `soma init` is the answer.
  const missing = paragraph(body, /is missing from this session/i);
  assert.ok(missing, 'the skill must still say what to do when soma_adopt is absent entirely');
  // `run soma init`, the imperative — not the diagnosis. Bare `/soma init/` matched twice in this
  // one paragraph ("`soma init` has not run" and "run `soma init`"), so the instruction could be
  // dropped while the pin passed on the explanation of what went wrong.
  assert.match(missing, /run\s+`?soma\s+init/i, 'the command that fixes it, as an instruction');
  assert.match(missing, /(fresh|new)\s+session/i, 'and that it needs a fresh session');
  assert.match(missing, /restart/i, 'named as the one case a restart fixes, against the no-restart claim above');
});

test('the writeback bans hold even if orchestrator.md is never read', () => {
  const { body } = parse(read());
  // The skill is loaded before (and possibly instead of) the prompt file, so the two bans
  // that cannot be walked back — a merged PR, a PR marked ready — live here too.
  assert.match(body, /never\s+merge/i);
  assert.match(body, /(never|not)[\s\S]{0,40}(mark|marking)[\s\S]{0,20}ready/i);

  // The third standing rule, and the one with no test until now: a writeback
  // is a *comment* and nothing else. The whole "never a transition, never a close, never a
  // label" clause could be deleted with the suite green. Each verb is pinned on its own,
  // because the likely edit is partial — a model that also transitions the ticket "while it
  // is in there" has done the one thing the operator cannot undo from a comment.
  assert.match(body, /comment/i, 'the writeback is a comment — the skill must say so');
  for (const [what, re] of [
    ['a status transition', /(never|not|no)\b[\s\S]{0,24}transition/i],
    ['closing the ticket', /(never|not|no)\b[\s\S]{0,24}clos(e|ing)/i],
    ['relabelling it', /(never|not|no)\b[\s\S]{0,24}label/i],
  ]) {
    assert.match(body, re, `the comment-only writeback must still forbid ${what}`);
  }
});

test('the CLI fallback is present, triggered by a missing control tool, and concrete', () => {
  const { body } = parse(read());
  const fb = unfenced(section(body, /fallback/i));

  // The trigger: the canary for "the role upgrade was not honored". Scoped to the paragraph
  // that states it, because section-wide `/soma_spawn/` had TWO matches in §6 — this sentence and the
  // parity row 21 lines below — so replacing "If `soma_spawn` / `soma_enqueue` / `soma_send` are not
  // in your tool list" with "If they are not there" stayed GREEN, and the fallback then keyed off
  // nothing at all while this message claimed otherwise. Found with the assertion spy, not by reading.
  // All three tools pinned: they are the canary SET, and any one of them missing is a partial upgrade.
  const trigger = paragraph(fb, /[Cc]heck\s*\**\s*before|not\s+in\s+your\s+tool\s+list/);
  assert.ok(trigger, 'the fallback must still say how to detect that the role upgrade was not honored');
  for (const tool of [/soma_spawn/, /soma_enqueue/, /soma_send/]) {
    assert.match(trigger, tool, `the detection sentence must name ${tool.source} — it is what the reader checks their tool list for`);
  }
  assert.match(trigger, /tool\s+list|not\s+(in|there)/i, 'and what to compare it against');
  assert.match(fb, /\bCLI\b/);
  // The parity claim, and its bound. An earlier draft claimed "full parity", which was false —
  // two verbs have no subcommand at all — so the prose was deliberately softened to a parity
  // scoped to the verbs that dispatch work. The message on this assertion still described the
  // claim it had already stopped making; the honest pin is that the claim exists and that the
  // unqualified version does not come back.
  assert.match(fb, /parity/i, 'the fallback is only worth taking if it says how far its parity goes');
  assert.doesNotMatch(
    fb,
    /(full|complete|total|100%)\s+parity/i,
    'unqualified parity is false here: soma_inbox and soma_release have no subcommand at all',
  );

  // Concrete commands, not "use the CLI": each of these is a control-plane verb the
  // orchestrator needs on day one.
  for (const cmd of [/soma\s+status/, /soma\s+enqueue/, /soma\s+send/, /soma\s+attach/]) {
    assert.match(fb, cmd, `the fallback must name the real subcommand ${cmd}`);
  }

  // The fence, which is a rule and not an example, and the one place in the file that says where the
  // `session_id` comes from. EVERY mutating row of the table below takes `--as <session_id>` and
  // re-checks the lease — so this fence is what makes the fallback usable, and the whole block was
  // deletable with the suite green, markers included. Worse than the payload-template case: there the
  // fields were at least named in prose nearby, here nothing else in the document names the file.
  // An instance of both sweep blind spots at once — a skipped region AND unpinned.
  const shell = fence(section(parse(read()).body, /fallback/i), /orch\.lease|command -v soma/);
  assert.ok(shell, 'the fallback must still show how to reach the CLI and where the lease lives');
  assert.match(shell, /orch\.lease/, 'the lease file is the only source of the session_id every mutating row needs');
  assert.match(shell, /session_id/, 'and it must say that that is what the reader is looking for');
  assert.match(shell, /SOMA_HOME/, 'located relative to SOMA_HOME, not a guessed home directory');
  assert.match(shell, /command\s+-v\s+soma|bin\/soma\.mjs/, 'plus how to run the CLI when it is not on PATH');
  // The claim the fence serves, scoped to the paragraph that makes it. Section-wide, `/--as\b/` also
  // matched the `soma_send` table row, so the sentence stating the RULE — that mutating subcommands
  // take it and re-check the lease — could go while the pin passed on one row's example usage.
  const asRule = paragraph(fb, /Only the \*\*transport\*\*|Mutating subcommands/);
  assert.ok(asRule, 'the fallback must still state that only the transport changes');
  assert.match(asRule, /--as\b/, 'mutating subcommands take --as <session_id>; say so or the rows above cannot be run');
  assert.match(asRule, /re-check|recheck/i, 'and that they still re-check the lease — the shell is not a permission slip');
  // Per ROW, not section-wide, and one row per tool. Section-wide the four pins above left four rows
  // of this table individually deletable with the suite green — `soma_kill`/`soma_resume`,
  // `soma_transcript`, `soma_digest` and `soma_spawn`, measured by the deletion sweep. This table IS
  // the fallback: a missing row is a verb the holder cannot reach at the one moment it has no tools.
  for (const [tool, must, what] of [
    ['soma_status', /soma\s+status/, 'the status subcommand'],
    ['soma_enqueue', /soma\s+enqueue/, 'the enqueue subcommand'],
    ['soma_send', /soma\s+send/, 'the send subcommand'],
    ['soma_kill', /soma\s+kill/, 'the kill subcommand'],
    ['soma_resume', /soma\s+resume/, 'the resume subcommand'],
    ['soma_transcript', /soma\s+peek/, 'the differently-named peek subcommand'],
    ['soma_digest', /soma\s+digest/, 'the digest subcommand'],
    ['soma_spawn', /watchdog/i, 'that nothing replaces it because the watchdog drains the queue'],
  ]) {
    const r = row(fb, new RegExp(`\`${tool}\``));
    assert.ok(r, `the fallback table needs a row for ${tool} — it is a verb the orchestrator owns`);
    assert.match(r, must, `${tool}'s row must name ${what}`);
  }

  // The two orchestrator-only tools with no CLI subcommand *at all* — which the escape hatch
  // at the end of the section does not cover, since that one routes an unimplemented
  // subcommand to `soma attach`. `soma_inbox` is the verb §3 mandates and §5 says to open
  // every turn with, so a parity claim with no row for it strands a model in precisely the
  // scenario this section exists for.
  // Scoped to the ROW, not to the section: `NDJSON` is named again in the prose two paragraphs
  // down, so a section-wide match was satisfied with the row's entire instruction replaced by
  // "use the CLI" — and the row is what a model reads at the moment the tool is missing.
  const inboxRow = row(fb, /soma_inbox/);
  assert.ok(inboxRow, 'the verb §3 mandates needs a row in the table — v1 has no `inbox` subcommand');
  assert.match(inboxRow, /ndjson/i, 'and the row must name the file the events are really in');
  assert.match(inboxRow, /events/, 'with the directory it is in, not just the extension');
  assert.match(
    fb,
    /(UserPromptSubmit|inject)/i,
    'plus the reason the holder is not blind without the tool — the inject hook still feeds unread events in',
  );
  // …and that reason stated conditionally, because it does not hold for every holder: an
  // off-tmux one (`wake: 'notify'`, no pane) may not match the hook's holder test and then gets
  // no injection at all — a population §1 explicitly warns exists. The row's raw tail is what
  // keeps that operator un-stranded, so the claim must be hedged and must name the case.
  //
  // Scoped to the PARAGRAPH that makes the claim, not to §6. Section-wide, the hedge pin was
  // vacuous on arrival: §6's opening sentence has said "a mid-session role upgrade is not
  // guaranteed to be honored" since before this fix, 2,000 characters above the claim it was
  // supposed to be hedging. A reviewer restored the injection claim to unconditional AND
  // extended it explicitly to off-tmux holders — a statement strictly worse than the one this
  // was raised about — and both pins stayed green.
  const injection = paragraph(fb, /inject\s+hook/i);
  assert.ok(injection, 'the fallback must still explain why a missing soma_inbox does not blind the holder');
  assert.match(injection, /degraded_wake|off-?tmux/i, 'the injection claim must name the case where nothing is injected');
  assert.match(
    injection,
    /(may\s+not|might\s+not|do\s+not\s+assume|is\s+not\s+guaranteed|when\s+it\s+fires|if\s+it\s+fires)/i,
    'and hedge the claim rather than promise it to every holder',
  );
  // The hedge has to bound the claim, not decorate it: an "off-tmux holders included" reading is
  // the exact overclaim this replaced.
  //
  // The ban was phrase-fragile on arrival, and two restatements of that exact overclaim were green:
  // "…and an off-tmux holder (`degraded_wake: true`) is covered as well" put `as well` 43 characters
  // out, three past a `[^.]{0,40}` window, and "…the `degraded_wake: true` case is covered as well"
  // satisfied the naming pin above while never spelling `off-tmux`. So the window is doubled — one
  // sentence of this paragraph is ~118 characters, so 80 stays inside it — and the field name is an
  // alternative to the prose name, since either one identifies the excluded population.
  const OVERCLAIM = /((off-?tmux|degraded_wake)[^.]{0,80}(included|\btoo\b|as\s+well|\balso\b)|(all|every|any)\s+holders?\b)/i;
  assert.doesNotMatch(injection, OVERCLAIM, 'the injection claim must not be extended back to the holders it does not cover');
  // ...and the ban has to stay ABLE to fail on today's wording. It went blind once more: a
  // parenthetical put `degraded_wake` ~85 characters before where an overclaim lands, past the
  // window, and the overclaim below stayed GREEN. So it is applied here, in memory, and must be caught.
  const overclaimed = injection.replace(/may\s+not\s+match\s+the\s+hook's\s+holder\s+test,\s+and\s+then\s+nothing\s+is\s+injected\s+at\s+all\./, 'is covered as well, and the injection reaches it.');
  assert.notEqual(overclaimed, injection, 'could not observe: the hedged sentence this mutates is gone — re-anchor the mutation, do not delete it');
  assert.match(overclaimed, OVERCLAIM, 'the overclaim ban cannot fail on this wording: keep `degraded_wake` or `off-tmux` within 80 characters of the claim');
  assert.match(fb, /soma_release/, 'the handback has no subcommand either; say so rather than implying one');
  // The §5 counterpart of the injection paragraph, and the other half of "two of those rows are not
  // substitutes". Also deletable-GREEN before this: the section-wide `/soma_release/` above is
  // satisfied by the table row alone, so the paragraph explaining that you CANNOT give the lease up
  // by typing — and what happens instead — could go while the row stayed.
  const handback = paragraph(fb, /handing the lease back/i);
  assert.ok(handback, 'the fallback must still explain that there is no way to hand the lease back by typing');
  assert.match(handback, /no\s+CLI\s+handback/i, 'stated plainly, not implied by an empty cell');
  assert.match(handback, /soma\s+release\s+</, 'and the confusable per-lead verb called out again here');
  assert.match(
    handback,
    /(next\s+session|10\s*min|adoptable)/i,
    'plus what happens to the lease instead — it passes on, or goes stale',
  );

  // A shell is not a permission slip: the gates from §1–§5 travel with the transport, or
  // `soma kill <lead>` reads as a freely available verb here.
  assert.match(fb, /transport/i, 'the fallback must say that only the transport changes, not the judgement');
  // Typing into an attached pane races the lead's own turn.
  assert.match(fb, /\bEsc\b/, 'attach etiquette: interrupt first, or the keystrokes are swallowed or interleaved');

  // Promotion's headline property: the bus is already mounted, so nothing is restarted.
  assert.match(
    body,
    /(no\s+restart|without\s+restarting|no\s+session\s+restart)/i,
    'the skill must say promotion needs no restart — otherwise a stalled upgrade reads as failure',
  );
});

test('the staleness trap is spelled out so an idle orchestrator is not quietly stolen from', () => {
  const { body } = parse(read());
  // Scoped, and no longer one word: a whole-body `/stale/i` was the only pin on this entire
  // section, so every sentence in it bar that one word could be deleted with the suite green.
  const warm = unfenced(section(body, /keep the lease warm/i));

  assert.match(warm, /heartbeat/i);
  assert.match(warm, /\b10\s*min/i, 'the 10-minute staleness window is the number the operator must know');
  assert.match(warm, /stale/i);
  // The trap is not that the lease expires. It is that expiry makes the fleet takeable with
  // no force and no notice, which is the whole reason a quiet orchestrator must keep calling.
  assert.match(warm, /without[\s\S]{0,12}force/i, 'a stale lease is adoptable WITHOUT force — that is the trap');
  assert.match(warm, /(soma_inbox|soma_status)/, 'name the call that stamps the heartbeat');
  // Walking away on purpose, and the CLI verb that looks like the handback but un-holds a lead.
  assert.match(warm, /soma_release/, 'a deliberate hand-back beats being found stale');
  assert.match(warm, /soma\s+release\s+</, 'the confusable `soma release <lead>` spelling must stay called out');
  assert.match(warm, /DEMOTED/, 'and what to do once another session already took it');
});

test('a `#` line inside a fenced code block is not a heading', () => {
  // Synthetic, because the property belongs to the scan rather than to today's prose — but the
  // hazard is live and already present: §4's bash fence opens with `# either way you get …`, a
  // shell comment a bare /^#{1,6}\s/ reads as a depth-1 heading. A decoy costs an author nothing
  // to plant, and this one is shallower than the section it sits in, which is the worst case.
  const planted = [
    '## 1. Adopt the lease',
    'the gate lives here',
    '',
    '```bash',
    '# 5. Keep the lease warm    <- a decoy, and shallower than the section holding it',
    'echo hi',
    '```',
    '',
    'and §1 continues after the fence',
    '',
    '## 2. Brief the fleet',
    'second section',
  ].join('\n');

  // It does not truncate the section it sits in…
  const s1 = section(planted, /adopt the lease/i);
  assert.match(s1, /continues after the fence/, 'a fenced `#` comment truncated the section it sits in');
  assert.doesNotMatch(s1, /second section/, 'the section must still end at the next real heading');
  // …and it is not findable as a heading of its own, which is what a decoy trades on: the
  // ordering scan would otherwise hand back a stretch of shell under §5's name.
  assert.throws(
    () => sectionLine(planted, /keep the lease warm/i),
    /needs a heading/,
    'a heading planted inside a fence was accepted as a heading',
  );
  assert.ok(sectionLine(planted, /adopt the lease/i) < sectionLine(planted, /brief the fleet/i));

  // And on the real file: a depth-1 anchor now spans the whole body. Before this it stopped at
  // §4's `#`-commented fence line, silently dropping §4 through §6 from the section it returned.
  const whole = section(parse(read()).body, /promote this session/i);
  assert.match(whole, /Keep the lease warm/, 'the depth-1 section stopped short of §5 — a fenced `#` comment truncated it');
  assert.match(whole, /Fallback/i, 'the depth-1 section stopped short of §6, the fallback table');
});

test('no rule in the skill is left present and carved out', () => {
  // The mutation class the pins above are structurally blind to. Every assertion in this file, and
  // every unit a deletion sweep can offer, asks whether a rule is THERE — so a rule can be left
  // word for word intact and undone in place by an exception hung off it: "never merge a PR, unless
  // the operator asks", "the writeback is a comment, except when the ticket says otherwise". The
  // prohibition still matches, the object still matches, the scope is unchanged.
  //
  // Bannable as a shape because it was measured first: `unless`, `except`, `other than` and the rest
  // appear ZERO times in this file, in `lead.md` and in `orchestrator.md`. These are absolutist
  // documents; an exception connective in one is the finding, not a false positive.
  //
  // §1 is excluded, and only §1: the force-steal gate is legitimately an exception clause — "do not
  // run it unless the operator says yes" is a rule and `ASSENT_GATE` accepts that phrasing on
  // purpose — so banning the shape there would refuse a wording this suite deliberately admits.
  const { body } = parse(read());
  const gateSection = unfenced(section(body, /adopt the lease/i));
  const rest = body.split(gateSection).join('\n');
  for (const [what, re] of [['an exception clause', CARVE_OUT], ['an appeal to the ticket', TICKET_OVERRIDE]]) {
    assert.doesNotMatch(rest, re, `a rule in SKILL.md is left present and undone by ${what}`);
  }
  // A GATE IS NOT A HEDGE, so the §1 exclusion does not extend to one. `HEDGE` inherited this
  // carve-out exemption when it was added, and the justification above does not transfer: an
  // assent gate has to say `unless the operator says yes`, and it never has to say `generally`.
  // Measured as a matched pair on the same act in the two documents that both offer it — the
  // orchestrator's `{force: true}` gate hedged with `generally` was RED via `harness.test.mjs`'s
  // hedge ban, and `SKILL.md` §1's gate hedged identically was GREEN. Two consumers of one
  // constant, added in the same commit, disagreeing on the same edit — with the green side being
  // the assent gate on force-stealing a live lease, which this file calls its most safety-critical
  // line. `You should ask the operator first.` prepended to the offer was GREEN too. Whole body,
  // unfenced: a fenced block is an example and never the statement of a rule, so softening one is
  // not a repeal.
  assert.doesNotMatch(unfenced(body), HEDGE, 'a rule in SKILL.md is left present and undone by a hedge');
  // And the gate section may carve out for the OPERATOR only. A carve-out there that hands the
  // decision to the ticket, the model or a lead is the same defect wearing the gate's grammar.
  assert.doesNotMatch(gateSection, TICKET_OVERRIDE, '§1 defers a judgement to the ticket');
});

test('the skill stays small enough to load into every session, with nothing left unwritten', () => {
  const txt = read();
  assert.ok(txt.length <= 12 * 1024, `SKILL.md is ${txt.length} bytes; keep the on-ramp under 12 KiB`);
  assert.doesNotMatch(txt, /\b(TODO|TBD|FIXME|XXX)\b/, 'no placeholders in a file the model follows literally');
});
