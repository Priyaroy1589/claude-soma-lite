#!/usr/bin/env node
/**
 * `soma-pr` — the only PR-creation path a lead's team is allowed to use.
 *
 * The standing operator rule is draft-only: an agent may open a pull request,
 * never merge one and never mark one ready for review. A lead's worktree-local
 * settings deny raw `gh pr create` and allow this wrapper, so every PR the fleet
 * ever opens arrives here — which makes this file the place the rule is
 * *enforced* rather than merely written down. Everything below exists to keep one
 * sentence true: the argv handed to `gh` marks the pull request as a draft,
 * whatever the caller passed and whatever the caller meant.
 *
 * Deny beats allow in the settings rules, and this wrapper matches only the
 * allow pattern — so the wrapper is reachable and raw `gh pr create` is not:
 *
 *     "deny":  ["Bash(gh pr create...)", "Bash(gh pr merge...)", …]
 *     "allow": ["Bash(node <glob>/bin/soma-pr.mjs<glob>)"]
 *
 * (Written with placeholders because a settings glob contains the two characters
 * that end a block comment; the literal patterns live in the spawn-time settings
 * writer.) `gh api` remains the declared residual hole. `--web` does *not*:
 * gh 2.76.1 refuses it outright next to a draft flag — "the `--draft` flag is not
 * supported with `--web`" — so an injected `--draft` turns every browser-form
 * attempt into an error. The browser route that did work was the shorthand
 * cluster `-wd=false`, and that is what the filter below is for.
 *
 * **It never pushes.** It hands `gh pr create` the caller's arguments and nothing else, and gh
 * run from a non-interactive shell will not push an unpushed branch: it stops with "you must
 * first push the current branch to a remote, or use the --head flag". So the branch is already on
 * `origin` before this runs — the lead pushes `soma/<id>` with `git push -u origin soma/<id>`
 * (the one push the gate lets a lead make), or a teammate does.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * Every token that can hand the draft flag a value — including the shorthand
 * clusters, which is where this file's first version was defeated.
 *
 * pflag walks a cluster (`-fd=false`) one character at a time: a bool shorthand
 * takes its `NoOptDefVal` ("true") and hands the *remainder* back to the loop,
 * and a remainder shaped `d=false` hits pflag's `len > 2 && s[1] == '='` branch,
 * which `Set()`s the draft flag to false. gh names the recipient itself when the
 * value is unparseable, which is how this was verified rather than reasoned:
 *
 *     $ gh pr create -dd=notabool --title t --body b
 *     invalid argument "notabool" for "-d, --draft" flag: strconv.ParseBool: …
 *     $ gh pr create -fd=notabool …   ->  same, for "-d, --draft"
 *     $ gh pr create -wd=notabool …   ->  same, for "-d, --draft"
 *
 * So `-dd=false`, `-fd=false`, `-wd=false` and `-ed=false` all reach gh as
 * "draft = false", and `-fd=false` alone is a complete ready-for-review PR:
 * `-f` is `--fill`, which takes the title and body from the commits.
 *
 * `-[A-Za-z]*d=.*` therefore strips any cluster whose trailing assignment lands
 * on `d`. It over-strips two innocents — `-bd=false` and `-td=false`, where the
 * `d=false` is really an attached *value* for `--body`/`--title` (verified: gh
 * reports no draft error for `-bd=notabool`) — and dropping a body or title
 * makes gh refuse the PR. That is the correct direction for a guardrail: the
 * over-strip costs a confusing error, the under-strip costs the operator's rule.
 *
 * `-fd` (no assignment) survives on purpose: a bare cluster can only ever take
 * `NoOptDefVal`, i.e. set draft *true*, which is the outcome we want anyway.
 */
const DRAFT_FLAG = /^(--draft(=.*)?|-d|-[A-Za-z]*d=.*)$/;

/**
 * The `gh` argument vector for one PR: the caller's flags with every draft
 * spelling of theirs removed, wrapped in a `--draft` at each end.
 *
 * Both positions are load-bearing, for opposite reasons.
 *
 * The *leading* one cannot be eaten. A value-expecting flag left dangling at the
 * end of the caller's argv — `--title` whose value was forgotten, or whose value
 * was the very token just stripped — swallows the next token as its value:
 * `gh pr create --title --draft` parses cleanly and gh then complains that the
 * *body* is missing, i.e. the title became "--draft" and nothing marked the PR a
 * draft. Nothing precedes our first flag but `create`, so nothing can reach it.
 *
 * The *trailing* one wins ties. pflag lets the last occurrence of a flag win, so
 * a draft spelling this file has not thought of — sitting anywhere in the
 * caller's argv — is overruled by a `--draft` that comes after it. It is the
 * generic backstop behind the specific filter above, and the reason the filter
 * being incomplete is no longer the same thing as the rule failing.
 *
 * A dangling caller flag eats the trailing one instead of erroring, which trades
 * "no PR" for "a draft PR with a silly title" — the leading flag still stands,
 * so the rule holds either way. Two `--draft` tokens are idempotent to pflag
 * (verified: `gh pr create --draft --draft` parses).
 */
export function buildPrArgs(userArgs = []) {
  return ['pr', 'create', '--draft', ...userArgs.filter((a) => !DRAFT_FLAG.test(a)), '--draft'];
}

/**
 * Candidate URLs for the process entry point: as spelled on the command line,
 * and with its symlinks resolved.
 *
 * Both, because the two disagree and either can be the one that matches. The ESM
 * loader realpaths by default, so a wrapper invoked through a symlink (or living
 * under one — stock macOS `/var` is a symlink to `/private/var`) has an
 * `import.meta.url` that `process.argv[1]` does not spell; under
 * `--preserve-symlinks-main` it is the other way round. `realpathSync` throws if
 * the path has been unlinked underneath us, which is not a reason to fail.
 *
 * Exported, and taking the path as an argument, because no end-to-end test can
 * discriminate this on a Node that has `import.meta.main` — the fallback would
 * otherwise be asserted only by reading it, which is how its first version
 * shipped with the symlink half still broken.
 */
export function entryUrls(arg = process.argv[1]) {
  if (!arg) return []; // `node -e`: there is no entry file
  const urls = [pathToFileURL(arg).href];
  try {
    urls.push(pathToFileURL(realpathSync.native(arg)).href);
  } catch { /* raced away; the unresolved spelling is still worth comparing */ }
  return urls;
}

/**
 * True only when this file is the process entry point.
 *
 * `import.meta.main` is the whole answer where it exists (Node >= 24.2). But
 * `engines.node` is `>=24`, and a lead's `env -i` PATH can just as easily find
 * an older system node, where it is `undefined` — falsy, which would turn this
 * wrapper into a no-op that exits 0 having created nothing, and "exit 0, no
 * output" reads to a lead exactly like a PR that exists. Hence the fallback, and
 * hence `entryUrls()` rather than `file://${process.argv[1]}`: that
 * interpolation misses a space (percent-encoded in `import.meta.url`, raw in
 * argv) *and* every symlink, and both misses are that same silent no-op.
 */
const isMain = typeof import.meta.main === 'boolean'
  ? import.meta.main
  : entryUrls().includes(import.meta.url);

if (isMain) {
  try {
    // No `stdio` option, deliberately: execFileSync forwards the child's stderr
    // to ours whenever the caller passes none, so gh's own diagnostics reach the
    // operator on the success path ("Creating draft pull request…") and the
    // failure path alike, without this file reformatting any of it.
    process.stdout.write(execFileSync('gh', buildPrArgs(process.argv.slice(2)), { encoding: 'utf8' }));
  } catch (e) {
    // gh's stderr was written by that same forwarding before execFileSync threw,
    // so writing `e.stderr` here would print every gh error twice. Whatever gh
    // managed to put on stdout first is still ours to pass along. The one case
    // with no gh output at all is a failure to *launch* gh, and that one needs a
    // line from us or the nonzero exit is unexplained.
    if (e?.stdout) process.stdout.write(e.stdout);
    if (!e?.stderr) {
      process.stderr.write(e?.code === 'ENOENT'
        // The live version of this: a lead spawned under `env -i` whose curated
        // PATH does not carry the GitHub CLI.
        ? `soma-pr: gh not found on PATH — install the GitHub CLI or add it to this PATH (${e.message})\n`
        : `${e?.message ?? e}\n`);
    }
    // `exitCode`, not `process.exit(1)`: stderr is an async pipe when the caller
    // is an agent's Bash tool, and exiting inside the same tick can drop the
    // message we just wrote. Nothing async is pending, so the process still
    // ends immediately — with status 1.
    //
    // 1 rather than gh's own `e.status`: those codes are not a contract worth
    // re-exporting, and a gh killed by a signal has `status === null`, which
    // would exit 0 and report a pull request that does not exist.
    process.exitCode = 1;
  }
}
