#!/usr/bin/env node
/**
 * `lead-postcompact.mjs` — re-orient a lead that just lost its memory. Registered on
 * **`SessionStart` with matcher `compact`** (`settings-gen.writeLeadSettings`); the filename is
 * older than the measurement below.
 *
 * Compaction rewrites the conversation into a summary. What survives is whatever the summariser
 * judged important, and the two things a soma lead most needs are exactly the two a summariser
 * drops first: they are old, they were never referred to again, and they read as boilerplate —
 * the task brief it was spawned with, and the HARNESS contract it declared (the plan of record
 * *and* the budget reservation the watchdog bound a circuit breaker to).
 *
 * So the answer is not a reminder of the content — the hook has no way to know it — but a
 * pointer to the tool that re-reads it. `soma_task()` exists for this: it is the lead's
 * re-orientation tool.
 *
 * **Why not `PostCompact`, which this file was written for and nothing ever registered.**
 * Measured on Claude Code 2.1.296: `PostCompact` has no `additionalContext` channel. Its
 * `hookSpecificOutput` fails validation ("hookSpecificOutput.hookEventName: expected one of …"),
 * so the hook reports FAILED; after an auto-compact nothing it prints reaches the model, and after
 * a manual `/compact` its output appears only as text inside `/compact`'s own command output.
 * `SessionStart` with matcher `compact` fires once per compaction, manual or auto, never on startup
 * or resume; its stdin carries `source: "compact"` and the UNCHANGED `session_id`, and its
 * `additionalContext` reaches the model as a system reminder, read once before the lead's next
 * turn — the only channel that delivered in both modes.
 *
 * **The lead only.** The lead's `--settings` file is inherited by every split-pane teammate
 * (settings-gen's header), so this runs on a teammate's compaction too — and a teammate has no
 * task brief or HARNESS of its own to re-read. The note goes out only when the stdin `session_id`
 * equals `SOMA_LEAD_SESSION_UUID`, `lead-gate.mjs`'s `isLeadSession` rule: both present, both
 * non-empty, equal. Unknowable is not the lead.
 *
 * Exit 0, always: a non-zero exit would surface as an error against a compaction the lead did
 * not ask for and cannot retry.
 */
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * The note itself. Exported so the wire-up and the canary can assert on the same string the lead
 * will see, rather than a paraphrase of it.
 *
 * Kept short on purpose: it is spent from the freshly-compacted context window it is trying to
 * protect. Its middle clause is `prompts/lead.md`'s own line, so the two cannot disagree.
 */
export const REORIENT = [
  'soma: your context was just compacted, so everything above is a lossy summary —',
  'call `soma_task()` and re-read your HARNESS contract before acting.',
  '`soma_task()` returns the task brief you were spawned with, and your HARNESS report is still',
  'your plan of record and your budget reservation.',
].join(' ');

/** `REORIENT` for the lead's own compaction, `null` for every other session start. Never throws. */
export function reorientation(input, env) {
  try {
    if (input?.source !== 'compact') return null;
    const sid = input.session_id;
    const uuid = env?.SOMA_LEAD_SESSION_UUID;
    return typeof sid === 'string' && sid !== '' && typeof uuid === 'string' && uuid !== '' && sid === uuid
      ? REORIENT
      : null;
  } catch {
    return null;
  }
}

/** Is this file the process entry point? `realpath` first, so a symlinked or relative argv still matches. */
function isMain(url) {
  try {
    return typeof process.argv[1] === 'string' && url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

/** How long to wait for a stdin that may never end. Overridable so a test can prove the deadline exists. */
const DEADLINE_MS = 5000;
const deadline = (env) => {
  const ms = Number(env?.SOMA_HOOK_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 60_000) : DEADLINE_MS;
};

if (isMain(import.meta.url)) {
  let raw = '';
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    process.exitCode = 0;
    try { process.stdin.destroy(); } catch { /* already gone */ }
  };
  // Same idiom as `orch-inject.mjs`: the pipe should be closed for us, and if it is not, the
  // session is waiting on this process, so the deadline gives up with nothing said.
  const timer = setTimeout(finish, deadline(process.env));
  process.stdout.on('error', () => {});
  process.stdin.on('error', finish);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      let input;
      try {
        input = JSON.parse(raw);
      } catch {
        input = {};
      }
      const note = reorientation(input, process.env);
      // No `process.exit()` after the write: stdout to a pipe is asynchronous and exiting
      // discards whatever has not drained, which would hand Claude Code a truncated JSON fragment
      // instead of the note. Letting the loop empty on its own flushes it.
      if (typeof note === 'string') {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note },
        }));
      }
    } catch { /* the reader is gone; there is nobody left to tell */ }
    finish();
  });
}
