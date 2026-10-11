/**
 * The canary — the gate that opens the queue.
 *
 * Before the fleet accepts work on a machine, one synthetic lead is run end to end
 * and the nine runtime invariants below are observed to hold on *that* machine and
 * *that* Claude Code version. Every one of them depends on undocumented Claude Code
 * behavior — a permission deny that is not in any changelog, an env var that
 * survives `env -i`, a slot that frees itself, a permission prompt that a patch
 * release started raising under bypass — so a version bump can silently retire any
 * of them, and the whole safety model is downstream of all nine.
 *
 * v1 ships the EVALUATION only: `evaluateCanary` is a pure predicate over a probe
 * result, and the live driver that spawns the synthetic lead and produces that probe
 * is deliberately deferred to v1.x. That is why `runCanary` requires its driver to
 * be injected — it keeps this module a leaf with no dependency on `spawn.mjs`,
 * `tmux.mjs` or `settings-gen.mjs`, and it keeps the nine predicates testable
 * without a tmux server.
 *
 *   THE LIVE DRIVER IS EXERCISED BY `soma up --canary` ON A REAL MACHINE DURING
 *   BRING-UP, NOT IN THE UNIT SUITE. Nothing in `node --test` proves an invariant
 *   holds; these tests prove only that a probe which fails to prove one cannot be
 *   mistaken for a pass. The invariants themselves are established by hand, once
 *   per machine and once per Claude Code version.
 *
 * Three things here are load-bearing enough to state up front, because each of them
 * was a defect in the original sketch of this file:
 *
 *   STRICT `=== true`, NEVER TRUTHINESS. The live driver observes these facts
 *   through shell commands and environment variables, and both of those are always
 *   strings. `!probe[k]` — the sketch — passes `oauthUnderEnvI: "false"`, because
 *   the string "false" is truthy; measured, it also passes `"0"`, `[]`, `{}` and
 *   `"true"`. That turns the gate that opens the queue into a rubber stamp in
 *   exactly the case it exists for, so an invariant holds only if its observation is
 *   the boolean `true` and nothing else. A non-boolean fails that one invariant
 *   (rather than rejecting the whole probe) and says what arrived instead: rejecting
 *   the probe would throw away the other seven verdicts, and the operator's action
 *   is the same either way — the queue stays closed — but only the observed value
 *   tells a driver author which observation is mistyped.
 *
 *   A MISSING OR MALFORMED PROBE IS A VERDICT, NOT A STACK TRACE. `evaluateCanary`
 *   is a safety check, and a safety check that throws when handed nothing is
 *   indistinguishable from one that was never called. `null`, `undefined`, a string,
 *   a number and an array all return a clean failing result whose `reason` names the
 *   fault, with all nine invariants listed as unproven.
 *
 *   NOTHING HERE WRITES TO STDOUT. In this system stdout is a JSON-RPC frame
 *   channel, not a log: `bin/lib/jsonrpc.mjs` serves MCP by writing exactly one
 *   `JSON.stringify(msg) + '\n'` per message to `process.stdout`, and nothing stops
 *   the bus process from importing this module. One stray `canary: PASS` line in
 *   that stream is an unparseable frame in the orchestrator's only control plane.
 *   So the verdict goes to an injected writer that defaults to stderr — which is
 *   where Claude Code's MCP log already reads from. Do not put it back on stdout.
 *
 * One more note for whoever builds the live driver: if the canary stamps its result
 * into config (`last_canary_claude_version` was the proposal), that write must go
 * through `withFleetLock` — config writes are last-write-wins, and a canary racing
 * a spawn would otherwise drop one of them. This module writes no state at all,
 * which is the other reason it needs no lock.
 */
import process from 'node:process';

/**
 * The nine invariants, their operator-facing meanings, and — in the comments — what
 * the live driver must actually observe to prove each one.
 *
 * The NAMES ARE A PUBLIC CONTRACT: the runbook, the doctor and the bring-up
 * procedure all refer to them by these exact strings. Renaming one is a breaking
 * change to be announced, not a tidy-up. `INVARIANTS` is derived from this map's key
 * order so that the names and their meanings cannot drift apart.
 */
const INVARIANT_MEANING = Object.freeze({
  /**
   * Observe: a soma tool actually CALLED from inside the spawned session and
   * returning — not that `settings.json` listed the server, and not that the process
   * is running. The bus is only mounted if the session completed the MCP
   * `initialize` handshake, which includes protocol-version negotiation: soma pins
   * `2024-11-05` (see `jsonrpc.mjs`), and a future Claude Code that stops accepting
   * that revision would leave a bus that starts, logs nothing, and serves nobody.
   */
  busMounted: 'the soma MCP bus is reachable from the spawned session',

  /**
   * Observe: a TEAMMATE of the synthetic lead performing a real Edit/Write on a real
   * file in the worktree and the change being on disk afterwards. This is the half
   * of the no-code boundary that must NOT be denied — leads plan, teammates
   * implement — so a settings change that over-denies is as fatal to the fleet as
   * one that under-denies, and it fails silently: the lead simply never ships.
   */
  teammateCanEdit: "a lead's teammates can write code",

  /**
   * Observe: the LEAD ITSELF attempting Edit, Write and NotebookEdit — all three,
   * by name — and being denied each time. Verified live against Claude Code 2.1.220,
   * including under `--dangerously-skip-permissions`: the deny still holds. That
   * result is the entire no-code boundary, it is undocumented, and it is the single
   * most important thing this canary re-proves after any Claude Code upgrade.
   */
  leadCannotWrite: "the lead's own Edit/Write/NotebookEdit are denied",

  /**
   * Observe — and this name UNDERSTATES the job, deliberately kept for compatibility
   * with the runbook and the tests that already quote it. "User MCP" reads as
   * one scope. This build established that the operator's MCP servers reach a
   * teammate through FOUR channels, and soma now denies all four:
   *
   *   1. top-level `mcpServers` in `~/.claude.json`
   *   2. per-directory local scope, `projects[<dir>].mcpServers` — where the
   *      brokerage server that places live orders and the write-capable MySQL
   *      servers actually turned out to live
   *   3. claude.ai ACCOUNT CONNECTORS, denied by the wildcard `mcp__claude_ai_*` —
   *      16 of them on the bring-up machine, THREE already authenticated (Microsoft
   *      365, Slack, Google Drive): send mail as the operator, post to their Slack,
   *      write to their Drive
   *   4. user-scope PLUGIN servers, denied by the wildcard `mcp__plugin_*`
   *
   * Scopes 3 and 4 appear NOWHERE in `~/.claude.json` — measured, by grep and by
   * `claude mcp list` from a bare directory — and the list can grow without any local
   * change, since a connector is authorized on the account. That is the fact the probe
   * has to be built around. A canary that enumerates the servers it can find locally
   * and confirms each one is denied would pass forever while a connector authenticated
   * last week sits wide open. So the invariant is not "the servers I know about are
   * denied"; it is "nothing the operator has authorized reaches a teammate, and the two
   * wildcard rules that cover that surface today are present verbatim". Deliberately not
   * phrased over the two prefixes — see THE BLIND SPOT after (c). Three observations:
   *
   *   a. Enumerate the TEAMMATE'S OWN TOOL SURFACE and assert that NONE OF THE
   *      OPERATOR'S AUTHORISED CONNECTORS IS REACHABLE FROM IT — stated over the
   *      connector list BY DISPLAY NAME, read from the account, and not over the two
   *      `mcp__claude_ai_*` / `mcp__plugin_*` prefixes. Wording it over the prefixes is
   *      what makes the whole invariant blind to a change in the prefix scheme; see THE
   *      BLIND SPOT below, which is the entire reason this leg is phrased this way.
   *      Asserting the two prefixes are absent as well costs nothing, so keep that
   *      check too — it is just not the assertion. Needs no seeding, is how the hole was
   *      found in the first place, and is the only leg that catches a newly connected
   *      account connector.
   *
   *      WHERE THAT LIST COMES FROM, so nobody re-derives it: `claude mcp list`, run from a
   *      directory with NO GUARD FILE, enumerates the account-side connectors BY DISPLAY
   *      NAME. Measured — two reviewers independently obtained the same list that way (16
   *      account connectors plus `plugin_vercel_vercel`), and one cross-checked it against
   *      its own tool surface. So the anchor this leg needs is not expensive: it is one
   *      command, and it is one nobody has to invent.
   *
   *      This leg needs a control for the same reason (b) does, and it is easy to miss
   *      because no rule is being tested here: an empty surface has the SAME two
   *      possible causes — the rules bit, or the connectors had not finished connecting
   *      when the surface was read. So the guarded reading is only meaningful beside an
   *      unguarded one in which those tools DO appear. Reading a rule-free surface is
   *      safe where firing from it would not be: enumerating is not invoking, and no
   *      tool from a real connector may ever be invoked by the canary.
   *
   *      AND THAT UNGUARDED READ IS THE SAME OPERATION AS THE ENUMERATION ABOVE. The
   *      rule-free directory that yields the authorised connector list IS the control arm:
   *      one read produces both the list leg (a) asserts over and the proof that those
   *      tools do appear when nothing is denying them. Do not build two mechanisms for it.
   *
   *      >> AND THAT CONTROL HAS NO LIFECYCLE ANCHOR, which is the harder half of the
   *      same problem. The unguarded arm is a DIFFERENT SESSION, read at a DIFFERENT
   *      POINT in session lifetime, and the guarded arm cannot show a connector tool by
   *      construction — so nothing the control reports can exclude the guarded arm having
   *      been read TOO EARLY. The still-connecting race therefore survives the control,
   *      and it survives it in the dangerous direction: not an inconclusive arm, but a
   *      FALSE PASS on the invariant itself.
   *
   *      The fix is to make "the connectors have settled" observable INSIDE the guarded
   *      session. The guarded arm must ALSO carry a SEEDED, NON-DENIED server, and one of
   *      its tools MUST APPEAR on the enumerated surface before the enumeration is
   *      trusted at all. A guarded reading taken before that tool shows up proves nothing
   *      and must be retried rather than recorded. That seeded server is the only thing
   *      in the guarded arm whose presence is expected, which makes it the only clock
   *      available — and it is the same discipline as (b), one level up: an absence is
   *      only evidence once something present has proved the observation was live.
   *
   *   b. Prove the RULE STILL BITES on this Claude Code version, as a PAIRED A/B: seed
   *      one probe MCP server, confirm its tools are absent with the rule in place, then
   *      remove ONLY that rule and confirm they come back.
   *
   *      >> THE TRAP, and it is why the second arm is not optional: A PROBE THAT
   *      SILENTLY NEVER CONNECTED LOOKS EXACTLY LIKE A RULE THAT BIT. Both present as
   *      "the tool does not exist". The first attempt at this A/B was inconclusive
   *      for precisely that reason — the probe had not finished connecting — and the
   *      re-review reproduced the race deliberately: one arm failed identically on its
   *      first attempt, then fired first-try once the session was made to sleep and
   *      retry the lookup. So an arm in which the tool is absent proves NOTHING on its
   *      own, however green it looks. Only the paired arm — same probe, same prompt,
   *      same cwd, that one rule removed — actually firing establishes that the absence
   *      in the first arm was caused by the rule. Any test of a deny rule must prove its
   *      control fires.
   *
   *      Name the probe whatever matches the rule you are testing, INCLUDING
   *      `claude_ai_Probe`. There is no reserved namespace here: an earlier version of
   *      this comment claimed `claude_ai_*` was reserved and it was WRONG — a stdio
   *      server named literally `claude_ai_Probe` connects and fires, confirmed in two
   *      independent arms. Matching the shipped rule literally is in fact the strongest
   *      assay available, and is how the wildcard was verified: rule present → the tool
   *      never resolves and no marker is written; that one rule deleted → it fires
   *      first try and the marker appears.
   *
   *      The subject of the control arm must be the SEEDED probe, never a real
   *      connector. "Prove the control fires" means firing a tool, and the live
   *      connectors on a bring-up machine are an authenticated Slack, Outlook and
   *      Drive. Verifying a deny by sending mail as the operator is not a test.
   *
   *   c. Assert the two wildcard rules `mcp__claude_ai_*` and `mcp__plugin_*` are
   *      present VERBATIM in the settings the synthetic lead was spawned with.
   *
   *      What makes two rules sufficient for a surface nobody enumerated: the
   *      `claude_ai_` and `plugin_` prefixes are applied BY THE CLIENT, with spaces
   *      converted to underscores, so they are structurally invariant to whatever a
   *      connector calls itself. Enumerated on the bring-up machine: 17 of 17 — 16
   *      account connectors plus `plugin_vercel_vercel` — are covered by those two
   *      wildcards, and no name matches neither. That is what licenses (c) as a
   *      sufficient statement about a list that grows without notice, rather than a
   *      guess about the names it will grow into.
   *
   * >> THE BLIND SPOT ALL THREE LEGS SHARE, and it is precisely the class this invariant
   * exists to catch. Every leg above is PREFIX-SCOPED, so NOT ONE OF THEM CATCHES A
   * CHANGE TO THE PREFIX SCHEME ITSELF. Suppose a Claude Code release stops applying
   * `claude_ai_`, or changes the separator, or namespaces account connectors some other
   * way. Then:
   *
   *   - (a) goes VACUOUSLY TRUE. No `mcp__claude_ai_*` tool appears on the surface —
   *     because nothing is named that any more.
   *   - (b) stays GREEN. The seeded probe is named to match the rule under test, so the
   *     old prefix still denies it. The mechanism works perfectly; it simply no longer
   *     governs anything.
   *   - (c) stays GREEN. Both rules are still in the file, verbatim.
   *
   * Three green legs, `teammateUserMcpDenied: true`, and EVERY CONNECTOR REACHABLE UNDER
   * ITS NEW NAME. A silent version bump has turned the gate into the rubber stamp this
   * whole module exists to refuse, and as written it cannot see it happen. That is why
   * (a) is stated over the OPERATOR'S AUTHORISED CONNECTOR LIST BY DISPLAY NAME: a list
   * read from the account survives a renaming of the tools, and a prefix does not. The
   * 17-of-17 enumeration under (c) is what makes the two wildcards SUFFICIENT TODAY; it
   * is not a promise about the scheme, and neither (b) nor (c) can notice the scheme
   * moving underneath it. Whatever the driver author does about this, the one thing not
   * to do is read three green prefix-scoped legs as coverage of the prefix scheme.
   *
   * Does (c) duplicate the doctor? The doctor is REQUIRED to assert the same two
   * rules (when this was written it was still to be built, so there was no doctor to
   * duplicate). Either way the answer is no: they are the same assertion made for
   * different reasons, and both are load-bearing. Doctor asserts PRESENCE across the
   * life of the machine — drift, a hand edit, a settings-generator regression. The
   * canary asserts ENFORCEMENT for one Claude Code version, and (c) is what generalizes
   * (b) from "this one rule bit this one probe I seeded" to "these two rules cover the
   * whole surface", which is the only form of the claim that survives a connector
   * authorized next month. Doctor cannot cover that half: it reads text, so a Claude
   * Code that changed its glob semantics would leave doctor green and every account
   * connector reachable. And a bring-up verdict must stand alone; a PASS here must not
   * silently depend on someone having remembered to run doctor.
   *
   * What a pass LOOKS like is already settled, so do not re-derive it: this build
   * verified that a bare-prefix deny removes the tools from the session outright —
   * they are not offered at all, and firing one returns "No such tool available" —
   * and that this holds under `--dangerously-skip-permissions`. The canary re-proves
   * that per version; it does not need to rediscover the shape of the result.
   *
   * But note what that shape does NOT give you, because it is the whole reason (b) is
   * paired: "the tool is not there" is the observation, and a denied server and a server
   * that never connected produce it identically. The absence is necessary evidence and
   * never sufficient evidence. Read it only against a control that fired.
   *
   * THE FIFTH SURFACE, and what its failure means. Project-scope `<repo>/.mcp.json` is
   * deliberately NOT on the deny list, because such a server needs an interactive
   * approval an unattended teammate cannot give. That premise is itself undocumented
   * Claude Code behavior, so the canary must re-prove it rather than inherit it — and
   * if it fails, it FLIPS THIS INVARIANT rather than getting a ninth of its own.
   * Reasons: the threat is identical (an operator's MCP server reachable by an
   * unattended agent), the consequence is identical, and the operator's IMMEDIATE action
   * is identical — stop the fleet. A ninth name would also be a breaking change to a list
   * the runbook, the doctor and the bring-up procedure all quote, bought for a
   * distinction the operator cannot act on differently at the moment of the verdict.
   *
   * The REMEDIATION is NOT identical, and that is worth stating rather than eliding.
   * Scopes 1 through 4 fail because a deny rule went missing or stopped biting: go fix
   * the settings generator. Scope 5 fails because Claude Code started AUTO-APPROVING
   * project-scope `.mcp.json` — a surface for which NO DENY RULE EXISTS to have broken —
   * so what has been found is a NEW REACHABLE CLASS, and the fix is to design a defence
   * that does not exist yet. Same verdict, same first move, materially different second
   * one. The ruling stands on the cost being named and the obligation placed on the
   * driver's log, immediately below; it does not stand on the two failures being the
   * same failure, and nobody should read it as saying they are.
   *
   * The cost of that choice, stated so the driver author covers it: the probe is a
   * BOOLEAN, so a single `teammateUserMcpDenied: false` cannot say WHICH of the five
   * surfaces leaked, and the note this module renders can only report the false. The
   * driver must therefore name the failing surface on its own log as it observes it.
   * The canary's result is the verdict; the driver's log is the diagnosis.
   */
  teammateUserMcpDenied: "the operator's personal MCP servers do not reach unattended agents",

  /**
   * Observe: a PR the synthetic lead's team actually opened, read back as
   * `isDraft: true` — never merged, never marked ready. The wrapper's guarantee is
   * pinned to one `gh` release's flag surface, so the driver should also confirm
   * `gh pr create --help` still spells the flag `-d, --draft` and has grown no
   * negation of it.
   */
  somaPrDraft: 'every PR the fleet opens is a draft',

  /**
   * Observe: admission actually recovering — a lead that completed, then a further
   * spawn succeeding into the slot it vacated. Without this the fleet stalls at its
   * concurrency limit and tasks 5 through 10 never start at all, which looks like a
   * quiet fleet rather than like a bug.
   */
  slotFreedAfterComplete: 'a completed lead frees its admission slot',

  /** Observe: the `--remote-control` URL actually obtained — the keep-alive path. */
  rcUrl: 'the --remote-control URL is obtained',

  /**
   * Observe: the synthetic lead authenticating after the spawner scrubbed the
   * environment with `env -i`. Leads must not inherit the operator's secrets — env
   * values are world-readable through `ps` — so the scrub is not optional, and this
   * invariant is what says the scrub did not also take the credentials the session
   * needs to start.
   */
  oauthUnderEnvI: 'OAuth still works after the spawner scrubs the environment with env -i',

  /**
   * Observe: ONE Bash call of the exact shape `cd <other dir> && grep -n x y.txt` — a `cd`
   * to a directory that is NOT the session's cwd, followed by a read-only verb on a RELATIVE
   * operand — issued under `--dangerously-skip-permissions` with a `Read()` deny rule in
   * force (leads carry 13), and its `tool_result` coming back with `1:x` in it.
   *
   * Why this is an invariant and not a version check: Claude Code 2.1.259 added a
   * bypass-immune safety check (`deniedPathInsideDirectory`) that raised a permission prompt
   * on exactly this shape whenever any `Read()` deny existed, and nobody sits at a lead's
   * pane. Measured over 179 fleet transcripts: 79 stalls summing 214 hours, the worst 40.3 h,
   * ALL on that one build; 2.1.263 removed the check and the same command runs. The fleet's
   * only version defence, `tested_claude`, passes patch releases by design, so it admitted
   * 2.1.259 — a version number cannot express "this build prompts", and a measurement can.
   *
   * THREE STATES, and the driver must keep them apart. RAN → `true`. ASKED → `false`: an
   * `is_error` tool_result for that call whose text names approval/permission, or a
   * `system`/`permission_denied` event carrying its `tool_use_id`. NOT OBSERVED → anything
   * else: claude did not start, no Bash tool_use happened, or the model dropped the `cd`.
   * That third state is unproven, never a pass — and it is the LIKELY state if the probe
   * `cd`s to the session's own cwd, because both haiku and sonnet silently delete a `cd`
   * whose target equals the cwd even when told byte-for-byte not to. Always `cd` elsewhere.
   *
   * `soma doctor` takes the same measurement with one haiku call (`claude cd-compound read
   * runs`, `doctor.classifyCdCompoundProbe`), so a machine has this reading before any lead
   * is spawned on a new build; the canary re-proves it for the version the fleet will run.
   */
  cdCompoundReadRuns: 'a `cd <dir> && grep <relative file>` compound runs under bypass instead of stopping on a permission prompt',
});

/**
 * The nine names, in order. Frozen because a consumer that mutated this list would
 * be editing the gate: dropping a name from it silently stops that invariant from
 * ever being checked, which is the failure this whole module exists to prevent.
 */
export const INVARIANTS = Object.freeze(Object.keys(INVARIANT_MEANING));

/**
 * One line of text for whatever a probe threw at us — the same guard, and for the
 * same reason, as `jsonrpc.mjs`'s: `e.message` on a `throw null` is itself a
 * TypeError, raised inside the handler that exists to stop a crash.
 */
const reason = (e) => {
  try {
    const message = e?.message;
    if (typeof message === 'string' && message !== '') return message;
    const text = String(e);
    return text === '' ? 'unknown error' : text;
  } catch {
    return 'unknown error';
  }
};

/**
 * What arrived instead of `true`, in words an operator can act on.
 *
 * Only ever called for a value that is not `true`, and it must not throw for any
 * value at all: a symbol in a template literal and a `toString` that throws are both
 * reachable from a buggy driver, and neither may take down the report.
 */
const describeValue = (v) => {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'undefined': return 'the value undefined';
    case 'boolean': return `the boolean ${v}`;
    case 'number': return `the number ${v}`;
    case 'bigint': return `the bigint ${v}`;
    case 'symbol': return 'a symbol';
    case 'function': return 'a function';
    case 'string': {
      // A probe value should be a boolean, so any long string is a driver bug; cap it
      // rather than paste a whole command's output into the verdict.
      const shown = v.length > 40 ? `${JSON.stringify(v.slice(0, 40))}… (${v.length} chars)` : JSON.stringify(v);
      return `the string ${shown}`;
    }
    default: {
      if (Array.isArray(v)) return 'an array';
      // `new Boolean(false)` is truthy, is not `true`, and is the most plausible way
      // for a value to look boolean while being an object. Worth naming exactly.
      try {
        if (Object.prototype.toString.call(v) === '[object Boolean]') {
          return 'a boxed Boolean object, not the primitive true';
        }
      } catch { /* an exotic proxy; 'an object' is still true and still useful */ }
      return 'an object';
    }
  }
};

/**
 * What KIND of object this is, for the shape-fault verdict below. `an object` is not
 * enough there: the whole point of that verdict is to tell a driver author they
 * returned a `Map` where a plain object belonged, so the verdict has to say `a Map`.
 */
const describeShape = (v) => {
  // `a Error` and `a Observations instance` read as typos in a verdict an operator is
  // already unhappy to be reading. Both arms matter: an always-"an" article renders
  // `an Map`, and an always-"a" one renders `a Error` — which is the exact typo this
  // exists to prevent — so the tests pin a vowel case AND a consonant case.
  const article = (word) => (/^[aeiou]/i.test(word) ? 'an' : 'a');
  // A `Symbol.toStringTag` and a constructor name are both class names — one word — but
  // both are attacker- or bug-controlled strings that land verbatim in an operator-facing
  // verdict, so they get the same cap `describeValue` gives a long string. Measured
  // without it: a 300-character tag rendered a 433-character verdict line, and an EMPTY
  // tag rendered `malformed probe: a  yielded …`, an empty article followed by a double
  // space. Whitespace is collapsed before the cap because `reason` occupies ONE LINE of a
  // multi-line report — a newline inside it desynchronizes the report's own framing, the
  // same class of fault as the stdout rule in the module header. Returns null for a name
  // that is blank once collapsed, so the caller can fall back to a sentence that reads.
  const named = (word, suffix) => {
    const clean = word.replace(/\s+/g, ' ').trim();
    if (clean === '') return null;
    const shown = clean.length > 40 ? `${clean.slice(0, 40)}… (${clean.length} chars)` : clean;
    return `${article(shown)} ${shown}${suffix}`;
  };
  try {
    // '[object Map]' → 'Map'. Reaches Map, Date, Error, WeakMap, Promise and the rest
    // of the builtins a driver might accumulate into by mistake.
    const tag = Object.prototype.toString.call(v).slice(8, -1);
    if (tag !== 'Object') return named(tag, '') ?? 'an object';
    const name = v?.constructor?.name;
    if (typeof name !== 'string' || name === 'Object') return 'a plain object';
    return named(name, ' instance') ?? 'a plain object';
  } catch {
    // A revoked or hostile proxy. Vague but true, and this is a reporting path.
    return 'an object';
  }
};

/** The verdict for a run that observed nothing at all: no probe, so nothing proven. */
const unproven = (why) => ({ ok: false, failures: [...INVARIANTS], notes: [], reason: why });

/**
 * Evaluate a probe against the nine invariants.
 *
 * Returns `{ok, failures, notes, reason}`:
 *   ok       — true only if all eight were observed as the boolean `true`
 *   failures — the invariant names that did not hold, in `INVARIANTS` order
 *   notes    — one operator-facing line per failure, naming what arrived instead
 *   reason   — null for a well-formed probe; a sentence when the probe ITSELF was
 *              unusable, which is how a caller tells "measured and violated" from
 *              "never measured". Both are `ok: false`; both keep the queue closed.
 *
 * `failures` lists all eight when there is no usable probe. That is not padding: a
 * caller that checks `failures.length === 0` instead of `ok` must not read an empty
 * list as a clean bill of health — the same truthiness mistake this module is built
 * to refuse, one level up.
 *
 * "Unusable" includes an object of the right type that YIELDED NONE of the eight
 * observations — a `Map`, a `Date`, an empty accumulator, a probe whose values sit on
 * its prototype, a probe every read of which threw. Those are driver bugs, and calling
 * them eight violations would tell an operator this machine breaks every safety
 * invariant it has. The line between the two is whether anything was OBSERVED, not
 * whether the answer was right: eight own keys all valued `undefined` is a measured run
 * that got eight wrong answers, and it stays a FAIL.
 */
export function evaluateCanary(probe) {
  if (probe === undefined) return unproven('no probe: the live driver returned nothing, so no invariant was observed');
  if (probe === null) return unproven('no probe: the live driver returned null, so no invariant was observed');
  if (typeof probe !== 'object' || Array.isArray(probe)) {
    return unproven(`malformed probe: expected an object of invariant observations, got ${describeValue(probe)}`);
  }

  const failures = [];
  const notes = [];
  // The three ways a key can yield NO OBSERVATION AT ALL, counted apart because they are
  // three faults with three different fixes: `missing` is an object that never carried
  // the observation, `inherited` is one that carries it somewhere that does not count,
  // and `unreadable` is one whose read threw. Collapsing them would report a
  // prototype-pollution probe as a wrong-shape one and hide the only clue to what
  // actually happened.
  //
  // What they share is the thing the shape-fault check below is counting: not one of
  // them is a MEASUREMENT. A key that was read and held the wrong value is a different
  // event and must never be counted here — eight own keys all valued `undefined` is a
  // probe that measured eight times and got eight wrong answers, and it has to stay a
  // measured violation.
  let missing = 0;
  let inherited = 0;
  let unreadable = 0;
  for (const key of INVARIANTS) {
    let held = false;
    let got;
    // One guard around the whole read. A probe is meant to be plain data, but a
    // getter that throws, or a proxy with a hostile `has` trap, would otherwise
    // raise from inside the safety check — and this function's entire contract is
    // that it returns a verdict instead of throwing.
    try {
      if (!Object.hasOwn(probe, key)) {
        // An inherited `true` is not an observation this probe made. Reading own
        // properties only is also what makes an `Object.create(null)` probe — what a
        // careful driver builds — behave identically.
        if (key in probe) { inherited += 1; got = 'absent (inherited, not an own property)'; }
        else { missing += 1; got = 'absent'; }
      } else {
        const value = probe[key];
        if (value === true) held = true;
        else got = describeValue(value);
      }
    } catch (e) {
      // Counted, not just described. This branch KNOWS the key was not observed, so
      // leaving it out of the tally below is how a probe nothing could be read from
      // got reported as eight broken invariants.
      unreadable += 1;
      got = `unreadable (reading it threw: ${reason(e)})`;
    }
    if (held) continue;
    failures.push(key);
    notes.push(`${key} (${INVARIANT_MEANING[key]}): expected true, got ${got}`);
  }

  // The probe yielded not one of the nine. No driver that ran produces that, so it is a
  // fault in the probe rather than nine broken invariants — reported as unproven,
  // because `reason: null` means "measured and violated" by the contract above, and
  // rendering "9 of 9 invariants did not hold" at an operator sends them to dismantle a
  // Claude Code install over a missing `Object.fromEntries`.
  //
  // Three causes reach here and the verdict names which, because they are fixed
  // differently: a wrong-shaped container (a `Map` or a `Date` where a plain object
  // belonged, or an accumulator returned before anything was written to it); values that
  // are present but INHERITED — `Object.create(probe)`, or a polluted `Object.prototype`;
  // or reads that THREW — nine lazy getters that shell out into a tmux session which has
  // since died is a plausible driver, not a hostile one. "Wrong shape" alone would send an
  // operator hunting a Map while their debugger shows all nine reading `true`, and it
  // would name a container fault for a session that simply went away.
  //
  // One branch, not three: `missing + inherited + unreadable === INVARIANTS.length` already
  // covers each of them alone and every mixture, and a separate branch per cause would be
  // branches whose removal no test could detect.
  if (missing + inherited + unreadable === INVARIANTS.length) {
    const causes = [];
    if (inherited > 0) {
      causes.push(`${inherited} of them are inherited from its prototype, and an inherited value is not an observation this probe made`);
    }
    if (unreadable > 0) causes.push(`${unreadable} of them threw when read`);
    // Nothing to add only when every one of the nine was plainly absent, which is what a
    // wrong-shaped container looks like from here.
    const cause = causes.length === 0 ? 'the live driver returned the wrong shape' : causes.join('; ');
    return unproven(`malformed probe: ${describeShape(probe)} yielded none of the ${INVARIANTS.length} observations — ${cause}, so nothing was measured`);
  }

  return { ok: failures.length === 0, failures, notes, reason: null };
}

/**
 * Render a verdict for a human. Three labels, because the operator's next move
 * differs:
 *
 *   PASS  — all eight hold; the queue may open.
 *   FAIL  — the canary ran and an invariant is genuinely broken on this machine or
 *           this Claude Code version. Stop; the safety model is not intact.
 *   ERROR — the canary did not run, so nothing was proven. Fix the harness and
 *           re-run. A crashed canary and a violated invariant are both `ok: false`,
 *           and telling them apart is the difference between debugging soma and
 *           debugging Claude Code.
 */
export function formatCanary(result) {
  if (!result || typeof result !== 'object') {
    return 'canary: ERROR — no result to report; the queue stays closed\n';
  }
  const failures = Array.isArray(result.failures) ? result.failures : [];
  if (result.reason) {
    return `canary: ERROR — the canary did not run, so none of the ${INVARIANTS.length} invariants was proven; the queue stays closed\n`
      + `  reason: ${result.reason}\n`
      + `  unproven: ${failures.join(', ')}\n`;
  }
  if (result.ok === true) {
    return `canary: PASS — all ${INVARIANTS.length} runtime invariants hold on this machine and this Claude Code version\n`;
  }
  const lines = Array.isArray(result.notes) && result.notes.length ? result.notes : failures;
  return `canary: FAIL — ${failures.length} of ${INVARIANTS.length} invariants did not hold; the queue stays closed\n`
    + lines.map((line) => `  ${line}\n`).join('');
}

/**
 * Drive the canary and return the full verdict — the composition every caller that
 * wants detail should use, in place of hand-rolling `evaluateCanary(await drive())`.
 *
 * This function exists because that hand-rolled version has a trap in it, and the
 * trap is reachable from the most obvious code a caller would write. `soma up
 * --canary` does not need it: it exits 3 on any verdict that is not a pass, through
 * `runCanary`'s boolean. A caller that wants an exit code per outcome — ERROR apart
 * from FAIL — needs the result object instead, and the natural spelling is
 * `try { r = evaluateCanary(await drive()) } catch (e) { r = { reason: e.message } }`.
 * A driver that rejects with a non-Error — `Promise.reject(null)`, which this
 * module's own tests cover — makes `e.message` a TypeError inside the guard, and the
 * bring-up gate dies with a stack trace instead of producing a verdict. The guarded
 * `reason()` above is exactly what prevents that, so it must not live somewhere a
 * caller has to re-derive it.
 *
 * `driveProbe` spawns the ~2-minute synthetic lead and observes the nine invariants.
 * It is REQUIRED, not defaulted: this module must stay importable without pulling in
 * tmux, and a canary that can be run by accident with a stub driver is worse than one
 * that refuses. The real driver arrives from `soma up --canary`.
 *
 * Never throws for anything the driver does — a crash and a violation are both
 * verdicts. It throws only for a missing or non-function `driveProbe`, which is a
 * programming error in the caller, not a canary outcome.
 */
export async function probeCanary(driveProbe) {
  if (typeof driveProbe !== 'function') {
    throw new TypeError(
      // Phrased for BOTH entry points: `runCanary` delegates its driver check here, and
      // an operator who called `runCanary` must not be told about a function they never used.
      'the canary needs a live driver — probeCanary(driveProbe) or runCanary(driveProbe). The real '
      + `driver spawns a synthetic lead and observes the ${INVARIANTS.length} invariants; run it for real with `
      + '`soma up --canary` on the target machine. There is deliberately no default: a canary '
      + 'nobody drove must not look like a pass.',
    );
  }
  try {
    return evaluateCanary(await driveProbe());
  } catch (e) {
    // A driver that crashed proved nothing, and it is not the same event as an
    // invariant that failed. Reported as ERROR, never rethrown: the caller of a gate
    // needs a decision, and letting a driver's stack trace escape loses both the
    // decision and the seven other verdicts.
    return unproven(`the live driver threw before producing a probe: ${reason(e)}`);
  }
}

/**
 * Run the canary with an injected live driver and report the verdict.
 *
 * `write` defaults to stderr and exists so tests — and a CLI that wants the verdict
 * in its own log — can capture it. It must NEVER default to stdout: see the module
 * header, and `bin/lib/jsonrpc.mjs` for why.
 *
 * Returns a strict boolean, deliberately. This is a gate, and its caller is going to
 * write `if (!await runCanary(drive)) return`; returning a richer object would make
 * that check pass unconditionally on an object's truthiness — which is defect #1 of
 * this module wearing a different hat. A caller that needs the detail — an exit code
 * per outcome, say — should call `probeCanary` and `formatCanary`, which is the same
 * path this function takes.
 *
 * There is deliberately NO timeout around the driver: a hung driver hangs here, and
 * that is the better failure. A timeout at this level could only ABANDON the driver,
 * never kill it — the driver owns the tmux session and the `kill` — so firing one
 * would report a false ERROR *and* leave a synthetic lead running with an admission
 * slot held. Hanging visibly during an interactive bring-up is strictly safer than
 * a verdict that is wrong in both directions at once. The timeout belongs to the
 * driver, which can actually clean up after itself.
 */
export async function runCanary(driveProbe, { write = (text) => process.stderr.write(text) } = {}) {
  if (typeof write !== 'function') {
    throw new TypeError('runCanary: `write` must be a (text) => void writer; it defaults to stderr, and must never be stdout');
  }

  // Driver validation lives in `probeCanary` — one refusal, phrased once, reachable
  // from both entry points rather than copied into each.
  const result = await probeCanary(driveProbe);

  // A broken writer must not be able to turn a verdict into a crash.
  try {
    write(formatCanary(result));
  } catch { /* nothing left to report it to */ }

  return result.ok === true;
}
