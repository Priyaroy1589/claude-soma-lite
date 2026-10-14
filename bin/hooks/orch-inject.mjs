#!/usr/bin/env node
/**
 * `orch-inject.mjs` — the UserPromptSubmit hook: the *pull* the orchestrator never
 * has to ask for.
 *
 * A lead's report reaches the orchestrator three ways, and the design's claim is that
 * they are independent: the bus send-keys a wake into its pane (push), the watchdog
 * batches what it missed (tick), and this hook staples a compact unread-events block
 * onto whatever the operator types next (inject). "Losing one degrades latency, never
 * correctness" is only true while the three do not share state — which is the single
 * most important thing about this file, and the reason for `INJECT_CURSOR` below.
 *
 * Opt-in: registered at **user scope** by `soma init --inject-hook`, so it runs on every
 * prompt in every Claude Code session on that config root — the orchestrator, the leads,
 * and every unrelated project the operator opens. Two consequences shape everything here:
 *
 * - **Only the lease holder may be injected into**, and every other session must exit
 *   silently and cheaply. A session that is not the orchestrator being handed the
 *   fleet's mail is a confusing prompt at best and a second session acting on lead
 *   events at worst.
 * - **It must never break a prompt.** Exit 2 on UserPromptSubmit *erases what the
 *   operator typed*; a stack trace on stdout is parsed as the hook's answer. So the
 *   whole body is wrapped, and every failure — no state root, a torn checkpoint, an
 *   unreadable cursor map — degrades to "no injection this turn".
 */
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { unread, writeCursor } from '../lib/events.mjs';
import { readFleet } from '../lib/fleet.mjs';
import { readLease } from '../lib/lease.mjs';

/**
 * This hook's own cursor key — deliberately *not* `orch`.
 *
 * `soma_inbox` consumes `orch`, and it is the only path that carries event
 * *payloads*: the question a NEEDS_INPUT is blocked on, the pr_url on a COMPLETED,
 * the traceback on an ERROR. If the hook advanced that cursor, every event it
 * injected would be marked read for the pull path too, `soma_inbox` would answer the
 * orchestrator with an empty list, and the payloads would be unreachable — while the
 * injected block, whose last line says "Call soma_inbox for payloads", still told it
 * to go and look. Two consumers, two cursors: the orchestrator sees a one-line
 * notification here and the full record there, each exactly once.
 */
export const INJECT_CURSOR = 'orch-inject';

/** How many events one prompt may carry. The block is a notification, not an inbox. */
const MAX_EVENTS = 20;

/** A stream name is a lead id: `events/<id>.ndjson`. Mirrors `fleet.mjs`'s `ID_RE`. */
const STREAM_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * One field of a stored event, safe to put on its own line of the block.
 *
 * Everything injected here is read by the orchestrator as instructions-shaped
 * context. `appendEvent` JSON-escapes newlines, so a stored `type` or `lead` *can*
 * contain one, and interpolating it raw would let a single stored field forge extra
 * bullet lines in a block the orchestrator trusts. Control characters out, length
 * capped, no exceptions for fields that "cannot" contain them.
 */
const label = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);

/**
 * Is this session the one holding the lease?
 *
 * Two proofs, but they are **ordered and mutually exclusive**, never OR'd. The session
 * id is the exact one — the bus records its own `CLAUDE_CODE_SESSION_ID` in the lease
 * and the hook payload carries the same value in `session_id` — and it is the only one
 * that works for a `wake: 'notify'` holder promoted outside tmux, which by
 * `acquireLease`'s own rules has no pane at all. The recorded pane is the fallback
 * originally planned, for the single case the id cannot cover: a harness that does not send
 * `session_id` in the payload.
 *
 * The variable name is `CLAUDE_CODE_SESSION_ID`, measured on 2.1.220 — `CLAUDE_SESSION_ID`
 * is undefined, and this comment named it until that was checked. `bus-tools`' `sessionId()`
 * prefers the real one and a notify-mode holder with `tmux_pane: null` was verified
 * against this hook to be injected into, so the assertion above is now true as well as
 * intended.
 *
 * Ordering them matters because there is exactly one cursor. Two *different* live
 * sessions can each satisfy one arm — the real holder by id after it resumed in a new
 * pane, and a stranger who has since been given the pane the lease still records — and
 * with `||` both pass, both consume `INJECT_CURSOR`, and the fleet's events are split
 * between them with no error anywhere: the stranger is handed a STARTED the
 * orchestrator then never sees. Returning the id comparison whenever an id is present
 * makes that impossible; the pane is consulted only when the field is absent
 * altogether, so a *wrong* id fails loud (nothing is injected, and `doctor` has a
 * cursor that never moves) instead of quietly promoting a bystander.
 */
function isHolder(lease, input, env) {
  if (!lease || typeof lease !== 'object') return false;
  const sid = input?.session_id;
  // Authoritative when present — including when it disagrees. Falling through to the
  // pane here is what lets a second session in.
  if (typeof sid === 'string' && sid !== '') return sid === lease.session_id;
  const pane = env?.TMUX_PANE;
  return typeof pane === 'string' && pane !== '' && pane === lease.tmux_pane;
}

/**
 * What to inject, and how far the cursor may then move: `{context, cursorId}`, or
 * null when this session gets nothing.
 *
 * Pure but for the three injected reads, so a test can drive the cap and the cursor
 * arithmetic without a filesystem. It does **not** write the cursor: that is the
 * caller's job, deliberately, so the advance can happen *after* the block is on
 * stdout. Duplicating an injected line costs the orchestrator two identical bullets;
 * dropping one costs it the event.
 */
export function injection(input, env, deps) {
  // A lead session can never hold the lease — `soma_adopt` refuses any caller with
  // `SOMA_LEAD_NAME` set, because that variable poisons the whole process tree — so
  // this is a free early exit for the busiest sessions on the machine, and a second
  // lock on the door if a lease record ever went stale enough to name one.
  if (env?.SOMA_LEAD_NAME) return null;

  const lease = deps.readLease();
  if (!isHolder(lease, input, env)) return null;

  // One sweep over every lead's stream plus the orchestrator's own (SPAWNED,
  // WATCHDOG_ERROR and the rest of the watchdog's output land there).
  // De-duplicated because a task literally named `orch` can still be on the checkpoint
  // (both enqueue doors refuse it, but `fleet.enqueue`'s id rule admits it and the file
  // is hand-editable), and filtered because a task id from a hand-edited checkpoint
  // reaches the filesystem as a path.
  const tasks = deps.readFleet()?.tasks ?? [];
  const streams = [...new Set(tasks.map((t) => t?.id).filter((id) => typeof id === 'string' && STREAM_RE.test(id)).concat('orch'))];

  const pending = deps.unread(INJECT_CURSOR, streams);
  if (!pending.length) return null;

  const shown = pending.slice(0, MAX_EVENTS);
  const lines = shown.map((e) => `- ${label(e.lead || 'orch', 64)} ${label(e.type, 32)}`);
  const dropped = pending.length - shown.length;
  if (dropped > 0) lines.push(`- …and ${dropped} more`);

  return {
    // Types and lead names only. A NEEDS_INPUT's question is capped at 500 characters
    // and a COMPLETED's summary at 2000; twenty of those would be a prompt preamble
    // longer than most prompts. This says who needs attention and why, in one line
    // each, and names the tool that has the rest.
    context: `## soma lead events (${pending.length} unread)\n${lines.join('\n')}\nCall soma_inbox for payloads.`,
    // The last event *shown*, never the last event *found*. Parking the cursor past
    // the cap would make everything beyond it unreachable by this consumer forever —
    // the silent loss `events.mjs`'s ordering rules exist to prevent, and the same
    // slice-then-stamp discipline `soma_inbox` uses.
    cursorId: shown[shown.length - 1].id,
  };
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
    process.exitCode = 0; // never 2: that would erase the prompt the operator just typed
    try { process.stdin.destroy(); } catch { /* already gone */ }
  };
  // The pipe should always be closed for us. If it is not, the operator's prompt is
  // waiting on this process, so the deadline gives up rather than holding the turn.
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
      if (input === null || typeof input !== 'object' || Array.isArray(input)) input = {};

      const plan = injection(input, process.env, { readLease, readFleet, unread });
      if (plan) {
        // Written here rather than handed back, so the cursor advance happens only
        // once the block is actually **on** stdout — which is why it lives in the
        // write callback and not on the line after the call. On macOS a pipe is an
        // asynchronous stream: `write()` returns long before the bytes land, and an
        // EPIPE from a reader that has already gone is swallowed by the error handler
        // above. Advancing on the next line therefore marked a batch delivered that
        // nobody received, and this consumer can never reach it again.
        //
        // The callback fires with an error, or not at all, when the write fails — both
        // of which leave the cursor where it was and re-inject next turn. Duplicating
        // an injected line costs the orchestrator two identical bullets; dropping one
        // costs it the event, so this is the direction to fail in.
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: plan.context },
        }), (err) => {
          // Nothing in here may throw: this runs on the stream's own callback, outside
          // the try/catch below, where an exception is an uncaught crash — a non-zero
          // exit and a stack trace on a hook whose whole contract is to stay out of the
          // operator's way.
          try {
            if (!err) writeCursor(INJECT_CURSOR, plan.cursorId);
          } catch {
            // The block was delivered; a cursor that did not move re-injects it next
            // turn. Two identical bullets, which is the harmless direction.
          }
        });
      }
    } catch {
      // Fail-open, and silent: no state root, a torn fleet.json, an unreadable lease.
      // The push and tick paths still carry the same events.
    }
    finish();
  });
}
