import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paragraph, readArtifact, unfenced } from './prose.mjs';

/**
 * The event types the prose names, checked against the event types `bin/` can produce.
 *
 * `prompts/orchestrator.md` and `skills/soma-promote/SKILL.md` are what an orchestrator model
 * reads about its event feed, and `docs/ROADMAP.md` is what an operator reads about v1. A type
 * they name as emitted that nothing writes is worse than one they leave out. The orchestrator
 * waits for a signal that never comes, reads its silence as good news, or is told to append an
 * event that no tool of its own can append. Five such types were found: `STALLED` and
 * `TEAMMATE_DOWN` (no detector exists), `DEMOTED` (a forced steal types a notice into the old
 * holder's pane and appends nothing), and `WRITEBACK_OK` / `WRITEBACK_FAILED` (no orchestrator
 * tool appends an arbitrary event). The decision was to change the documents, not to add the
 * producers, so these tests hold the documents to what the code does.
 */

const BIN = fileURLToPath(new URL('../bin/', import.meta.url));

/**
 * `src` with its comments blanked and its string literals kept.
 *
 * One alternation, scanned left to right, so a `//` inside a string is never read as a comment
 * and a quote inside a comment never opens a string. Regex literals are not modelled. A quote or
 * a `//` inside one can mis-scan the rest of that line, which is why the self-check below pins
 * what the scan must find as well as what it must not.
 */
const STRIP = /('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const code = (src) => src.replace(STRIP, (_, literal) => literal ?? ' ');

/**
 * Every single- or double-quoted string literal in `bin/**\/*.mjs` that is exactly an UPPER_SNAKE
 * token, outside comments.
 *
 * This OVER-approximates "emitted": it means "named as a literal somewhere in bin/", and it also
 * picks up `'ENOENT'`, `'HOME'` and other names that are not events. That is enough here, because
 * every claim under test names an event type that nothing in `bin/` names at all.
 *
 * It has to be a literal scan rather than a `type: 'X'` scan, because event types reach
 * `appendEvent` several ways: `say('FLEET_DRAINED', …)` in `soma-watchdog.mjs`, builders in
 * `wd/rotation-events.mjs` that hold the type in a `const T = 'SEAT_CLOSED'`, and the
 * `REPORT_TYPES` set a lead's `soma_report` is validated against in `bus-tools.mjs`. A backticked
 * `DEMOTED` in a JSDoc, and the template string `[soma] DEMOTED: …` that `soma_adopt` types into a
 * pane, are not quoted literals, so they do not count.
 */
let produced = null;
const producedTypes = () => {
  if (produced) return produced;
  produced = new Set();
  for (const rel of readdirSync(BIN, { recursive: true })) {
    if (!String(rel).endsWith('.mjs')) continue;
    const src = code(readFileSync(join(BIN, String(rel)), 'utf8'));
    for (const m of src.matchAll(/(['"])([A-Z][A-Z0-9_]{2,})\1/g)) produced.add(m[2]);
  }
  return produced;
};

/** The leading UPPER_SNAKE token of each inline code span: `WRITEBACK_OK {task, target, url}` → WRITEBACK_OK. */
const spanTypes = (text) => new Set(
  [...text.matchAll(/`([^`]+)`/g)].map((m) => /^\s*([A-Z][A-Z0-9_]{2,})\b/.exec(m[1])?.[1]).filter(Boolean),
);

const ORCH = 'prompts/orchestrator.md';
const SKILL = 'skills/soma-promote/SKILL.md';
const ROADMAP = readFileSync(new URL('../docs/ROADMAP.md', import.meta.url), 'utf8');

test('the producer scan finds the events bin/ writes, and none of the five the documents had to stop naming', () => {
  const types = producedTypes();
  // At least one type from each route into the log: a lead's `soma_report` (NEEDS_INPUT, ERROR), a
  // watchdog `appendEvent` (GAVE_UP, BUDGET), the watchdog's `say()`, which picks FLEET_SETTLED in a
  // ternary, a rotation-events builder (SEAT_CLOSED, BACKPRESSURE), the kill that the bus and the
  // CLI both log (KILLED), and the pane census (LEAD_DEAD_SHELL).
  for (const t of ['NEEDS_INPUT', 'ERROR', 'GAVE_UP', 'BUDGET', 'FLEET_SETTLED', 'SEAT_CLOSED', 'KILLED', 'BACKPRESSURE', 'LEAD_DEAD_SHELL']) {
    assert.ok(types.has(t), `the scan missed ${t}, which bin/ does write, so every check below can pass on a blind scanner`);
  }
  // On this build nothing writes these five. If one of them gains a producer, it moves to the
  // list above, and the documents that disclaim it change with it.
  for (const t of ['STALLED', 'TEAMMATE_DOWN', 'DEMOTED', 'WRITEBACK_OK', 'WRITEBACK_FAILED']) {
    assert.ok(!types.has(t), `the scan counts ${t} as produced; either bin/ now writes it or the scan reads comments or templates`);
  }
});

test('every event type in orchestrator.md\'s triage table is one bin/ produces', () => {
  const lines = unfenced(readArtifact(ORCH)).split('\n');
  const head = lines.findIndex((l) => /^\|\s*Event\s*\|\s*Your move\s*\|/.test(l));
  assert.notEqual(head, -1, 'the triage table (`| Event | Your move |`) is gone, so its rows cannot be checked');
  assert.match(lines[head + 1], /^\|[\s:|-]+\|\s*$/, 'the triage table header is not followed by its separator row');
  const rows = [];
  for (let i = head + 2; i < lines.length && lines[i].trimStart().startsWith('|'); i++) rows.push(lines[i]);
  // The table carries over twenty rows; a parse that stopped early would check nothing.
  assert.ok(rows.length >= 10, `only ${rows.length} triage rows were read`);
  const types = producedTypes();
  for (const r of rows) {
    // A cell can name two types, as `ERROR` / `GAVE_UP` does.
    const named = [...r.split('|')[1].matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map((m) => m[1]);
    assert.ok(named.length > 0, `a triage row names no event type in its first column: ${r.slice(0, 80)}`);
    for (const t of named) assert.ok(types.has(t), `the triage table tells the orchestrator how to handle ${t}, and nothing in bin/ produces it`);
  }
});

test('every event type orchestrator.md names is produced, or declared as having no producer', () => {
  const prose = unfenced(readArtifact(ORCH));
  const decl = paragraph(prose, /no producer in this build/);
  assert.ok(decl, 'the paragraph declaring "no producer in this build" is gone');
  const declared = spanTypes(decl);
  // Non-empty, so this test cannot go vacuous if the declaration moves or loses its names.
  assert.ok(declared.size > 0, 'the "no producer in this build" paragraph names no type');

  const types = producedTypes();
  const stray = [...spanTypes(prose)].filter((t) => !types.has(t) && !declared.has(t));
  assert.deepEqual(stray, [], `orchestrator.md names an event type that nothing in bin/ produces and the "no producer in this build" paragraph does not declare: ${stray.join(', ')}`);
  // The other direction: a declaration outlives its truth the day a producer lands, and from then
  // on it tells the orchestrator to ignore a real signal.
  const stale = [...declared].filter((t) => types.has(t));
  assert.deepEqual(stale, [], `${stale.join(', ')} is declared as having no producer, but bin/ now names it; drop it from the declaration`);
});

/**
 * Three shapes of a sentence saying an event IS appended or emitted. Each is bounded to one
 * sentence by `[^.]` and captures the type it names: verb … `TYPE` … event ("appends a `DEMOTED`
 * event"), verb … event … `TYPE` ("append the ledger event yourself: `WRITEBACK_OK {…}`"), and the
 * passive ("a `DEMOTED` event is appended").
 */
const CLAIMS = [
  /\b(?:append|emit)\w*\b[^.]{0,60}?`([A-Z][A-Z0-9_]{2,})\b[^`]*`[^.]{0,30}?\bevents?\b/g,
  /\b(?:append|emit)\w*\b[^.]{0,40}?\bevents?\b[^.]{0,40}?`([A-Z][A-Z0-9_]{2,})\b[^`]*`/g,
  /`([A-Z][A-Z0-9_]{2,})\b[^`]*`[^.]{0,30}?\bevents?\s+(?:is|are|was|were|gets?)\s+(?:appended|emitted)\b/g,
];
/** A negation inside the claim or just before it ("does not append a `DEMOTED` event"): that is a denial, not a claim. */
const NEGATED = /\b(?:no|not|never|nothing|none|neither|nor|without)\b|n['’]t\b/i;

test('neither the orchestrator prompt nor the promote skill says an event is appended for a type nothing produces', () => {
  const types = producedTypes();
  const found = [];
  for (const doc of [ORCH, SKILL]) {
    const prose = unfenced(readArtifact(doc));
    for (const re of CLAIMS) {
      for (const m of prose.matchAll(re)) {
        if (types.has(m[1])) continue;
        if (NEGATED.test(prose.slice(Math.max(0, m.index - 20), m.index + m[0].length))) continue;
        found.push(`${doc}: ${m[1]} in "${m[0].replace(/\s+/g, ' ')}"`);
      }
    }
  }
  assert.deepEqual(found, [], `claims an event that nothing in bin/ appends:\n${found.join('\n')}`);
});

test('docs/ROADMAP.md says v1 emits only event types that bin/ produces', () => {
  // Sentences, not lines: some ROADMAP paragraphs are hard-wrapped, so a paragraph is re-joined
  // before it is split. Headings are dropped first, since one can sit directly on its paragraph.
  const sentences = unfenced(ROADMAP).split(/\n\s*\n/)
    .map((block) => block.split('\n').filter((l) => !/^#{1,6}\s/.test(l)).join(' '))
    .flatMap((block) => block.split(/(?<=[.!?])\s+/))
    .filter((s) => /\bv1 emits\b/i.test(s));
  assert.ok(sentences.length > 0, 'no ROADMAP sentence says what v1 emits any more, so there is nothing to check');
  const types = producedTypes();
  const unproduced = sentences.flatMap((s) => [...spanTypes(s)].filter((t) => !types.has(t)).map((t) => `${t} in "${s.slice(0, 120)}"`));
  assert.deepEqual(unproduced, [], `the ROADMAP says v1 emits a type that nothing in bin/ produces:\n${unproduced.join('\n')}`);
});
