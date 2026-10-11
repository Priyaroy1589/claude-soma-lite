/**
 * Wake keystrokes and tmux servers, on real tmux: two servers, one pane id.
 *
 * A pane id is a small per-server counter, so two tmux servers that both have a `%0` (or a `%40`)
 * is the ordinary case, not a coincidence. Two defects typed wakes into a stranger's pane because
 * of it, and this file stages both, safely.
 *
 * Issue #1. Seen in the field: a default fleet on socket `soma` and a second fleet on a socket of
 * its own, both orchestrators in pane `%40` of their own server, and every NEEDS_INPUT and COMPLETED
 * wake from the second fleet's leads was typed into the FIRST fleet's orchestrator. The lead's bus
 * never learned its fleet's socket (`env -i` dropped it and the lead's `mcp.json` did not set it),
 * so it fell back to `soma` and typed `%40` there. Staged here with fleet B's lease naming `%0` on
 * its own socket and a bus started with the environment a really spawned lead's bus gets:
 * `spawn.buildLeadEnv`'s output plus the `soma` entry of the `mcp.json` that
 * `settings-gen.writeLeadMcpConfig` writes for that lead, which is what Claude Code hands an MCP
 * server (its own process env, plus the config's `env`). The lead files NEEDS_INPUT over the bus's
 * own stdio, and the two panes say where the wake landed: each runs `cat`, which echoes what is
 * typed into it. Before the fix the line lands in fleet A's pane; after it, in fleet B's.
 *
 * Issue #2. `soma_adopt` recorded `$TMUX_PANE` as a keystroke target without checking that the pane
 * is on soma's server, so an orchestrator promoted in the operator's everyday tmux recorded a pane
 * id that, on soma's server, belongs to a lead or a teammate. The proof is one round trip on the
 * bus's own server, `soma-bus.paneOnServer`, which also requires the session's `$TMUX` to name that
 * server. Here the bus is fleet B's, on `swb`, and the server named `soma` is the other server: it
 * stands in for the operator's own.
 *
 * ⚠ TMUX SAFETY. Every server here lives under a throwaway `TMUX_TMPDIR`, set before anything
 * loads `tmux.mjs`, so even the server named `soma` (deliberately the default name) is a stranger to
 * any live fleet's. `-f /dev/null` keeps the operator's tmux.conf, and any plugin in it that saves
 * or restores sessions, out of these servers. `$TMUX` is dropped, so no tmux call in this process
 * can fall back to the server the suite happens to run inside. `after` kills both servers and
 * deletes the directory.
 */
import './soma-home.mjs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

// --- The sandbox, before anything else. Nothing below may reach a tmux server outside it. -----
// Short names on purpose: a Unix socket path must stay under ~104 bytes, and tmux reports the
// realpath (`/private/var/...` on macOS).
const D = mkdtempSync(join(tmpdir(), 'sw-'));
process.env.TMUX_TMPDIR = D;
delete process.env.TMUX;
delete process.env.TMUX_PANE;

// This process is fleet B's: its spawner and its bus. `tmux.mjs` reads `SOMA_TMUX_SOCKET` once, at
// load, so it is set here, before the dynamic imports below: the same position a fleet-B watchdog
// is in, whose environment carries it (`soma up` forwards it through `WATCHDOG_ENV_ALLOW`).
const saved = { SOMA_TMUX_SOCKET: process.env.SOMA_TMUX_SOCKET, SOMA_HOME: process.env.SOMA_HOME };
const FLEET_A = 'soma';   // the default socket name: a throwaway here, because of TMUX_TMPDIR
const FLEET_B = 'swb';
process.env.SOMA_TMUX_SOCKET = FLEET_B;
const HOME_B = join(D, 'home-b');
process.env.SOMA_HOME = HOME_B;

const { buildLeadEnv } = await import('../bin/lib/spawn.mjs');
const { writeLeadMcpConfig } = await import('../bin/lib/settings-gen.mjs');
const { acquireLease, readLease } = await import('../bin/lib/lease.mjs');
const tmux = await import('../bin/lib/tmux.mjs');
const somaBus = await import('../bin/soma-bus.mjs');

const tmuxInstalled = spawnSync('tmux', ['-V']).status === 0;
const skip = !tmuxInstalled && 'tmux not installed';
const LEAD = 'cr-b';
const WAKE_LINE = `[soma] ${LEAD} NEEDS_INPUT. Call soma_inbox.`;
const started = new Set();
let bus = null;

/**
 * tmux on one of this file's servers. `-f /dev/null` is only read by the command that starts a
 * server, and costs nothing on the others, so every call carries it rather than remembering which
 * one starts the server.
 */
const tm = (socket, ...args) => execFileSync('tmux', ['-f', '/dev/null', '-L', socket, ...args], {
  env: { ...process.env, TMUX_TMPDIR: D },
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 5000,
});

/** What pane `%0` shows on one server, blank rows dropped. */
const screen = (socket) => tm(socket, 'capture-pane', '-p', '-t', '%0').replace(/\n+$/, '');

/** Poll `fn` until it is true or `ms` pass. Answers the last reading, so a caller asserts on it. */
const until = async (fn, ms = 5000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
};

/**
 * One fleet's orchestrator: a detached session whose only pane runs `cat`.
 *
 * The label is printed first because the pane gate refuses a blank screen (a live, non-shell
 * pane with nothing on it is `unobservable`, and `wake()` holds on that). With text on it, `cat`
 * reads as `unrecognised`, which the gate types into, and `cat` echoes what was typed: the
 * capture then shows exactly where a wake landed.
 */
const orchestrator = async (socket, label) => {
  tm(socket, 'new-session', '-d', '-s', 'orch', '-x', '160', '-y', '40', 'sh', '-c', `echo ${label}; exec cat`);
  started.add(socket);
  assert.ok(await until(() => screen(socket).includes(label)), `${socket}: the orchestrator pane never printed its label`);
  return tm(socket, 'display-message', '-p', '-t', 'orch:', '#{pane_id}').trim();
};

/** Both fleets, started once and shared by every test here. Both orchestrators sit in `%0`. */
let fleetsStarted = null;
const fleets = () => {
  fleetsStarted ??= (async () => {
    const a = await orchestrator(FLEET_A, 'fleet-a-orchestrator');
    const b = await orchestrator(FLEET_B, 'fleet-b-orchestrator');
    assert.equal(a, '%0', 'fixture: a fresh server numbers its first pane %0');
    assert.equal(b, a, 'fixture: the two orchestrators must share a pane id, as in the field report');
    return { a, b };
  })();
  return fleetsStarted;
};

/**
 * `$TMUX` as tmux itself sets it for a process in a pane on `socket`, read from inside one (a
 * second window, so `%0` is left alone) rather than assembled here: the proof compares against
 * exactly this string, so it should come from tmux.
 */
const tmuxVars = new Map();
const tmuxVarOf = async (socket) => {
  if (!tmuxVars.has(socket)) {
    const out = join(D, `${socket}.tmux`);
    tm(socket, 'new-window', '-d', '-t', 'orch:', 'sh', '-c', `printf %s "$TMUX" > '${out}'; exec sleep 600`);
    assert.ok(await until(() => existsSync(out) && readFileSync(out, 'utf8') !== ''), `${socket}: no $TMUX came back`);
    tmuxVars.set(socket, readFileSync(out, 'utf8'));
  }
  return tmuxVars.get(socket);
};

/** The bus as Claude Code runs it for a lead: a child process, JSON-RPC over its own stdio. */
const startBus = (args, env) => {
  const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => {
    out += String(chunk);
    for (let nl = out.indexOf('\n'); nl >= 0; nl = out.indexOf('\n')) {
      const line = out.slice(0, nl).trim();
      out = out.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined) replies.set(msg.id, msg);
    }
  });
  child.stderr.on('data', (chunk) => { err += String(chunk); });
  return {
    child,
    replies,
    stderr: () => err,
    send: (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`),
  };
};

after(() => {
  try { bus?.child.kill('SIGKILL'); } catch { /* already gone */ }
  for (const socket of started) {
    try { tm(socket, 'kill-server'); } catch { /* already gone */ }
  }
  rmSync(D, { recursive: true, force: true });
  // The tmux sandbox is deliberately NOT lifted: this process ends with the file, and a tmux call
  // made after lifting it would reach the server named `soma` outside it.
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// ---------------------------------------------------------------------------
// Issue #1: a lead's wake goes to its own fleet's server
// ---------------------------------------------------------------------------

test("a lead's wake lands on its own fleet's tmux server, not on the default one's pane with the same id", { skip }, async () => {
  assert.equal(tmux.socketName(), FLEET_B, "fixture: the spawner side must be fleet B's, or this measures nothing");
  process.env.SOMA_HOME = HOME_B;

  // Two fleets, and the collision the field report had: both orchestrators in the same pane id.
  const { b: paneB } = await fleets();

  // Fleet B's lease, through the real API, naming its orchestrator's pane on its own server.
  const grant = acquireLease({ session_id: 'orch-b', tmux_socket: FLEET_B, tmux_pane: paneB, wake: 'tmux' }, { force: true });
  assert.equal(grant.ok, true);

  // The spawner's environment, minimal. The PATH holds tmux and nothing else, so the bus's real
  // notifier finds no `osascript` (or `notify-send`) and the operator's desktop gets no toast from
  // a test; HOME is a throwaway. LANG is load-bearing, and a real spawner has it (it is on
  // ENV_ALLOW): MEASURED on tmux 3.6a, a client with no UTF-8 locale in its environment prints
  // every tab in a `-F` listing as `_`, so the pane gate cannot parse its listing and reads the
  // orchestrator's pane as absent. The wake is then held whichever server the bus talks to, before
  // the fix and after it, and this test could tell nothing about sockets.
  const bin = join(D, 'bin');
  mkdirSync(bin);
  const real = process.env.PATH.split(delimiter).map((dir) => join(dir, 'tmux')).find((f) => existsSync(f));
  assert.ok(real, 'fixture: tmux is installed but not found on PATH');
  symlinkSync(real, join(bin, 'tmux'));
  const userHome = join(D, 'user-home');
  mkdirSync(userHome);

  // The environment a real lead's bus gets in fleet B: the lead's own env (`env -i` plus what
  // the spawner injects), overlaid with the `soma` server's env from the lead's mcp.json. NOT
  // `process.env`: this process carries SOMA_TMUX_SOCKET=swb and would hide the bug. The one
  // addition is TMUX_TMPDIR, which is the sandbox, not production.
  const leadEnv = buildLeadEnv({ id: LEAD, env: { PATH: bin, HOME: userHome, LANG: 'en_US.UTF-8' } });
  const soma = JSON.parse(readFileSync(writeLeadMcpConfig(LEAD), 'utf8')).mcpServers.soma;
  const childEnv = { ...leadEnv, ...soma.env, TMUX_TMPDIR: D };
  assert.equal(childEnv.TMUX_TMPDIR, D, 'the bus must run inside the tmux sandbox');
  assert.equal(childEnv.TMUX, undefined, 'and must not be told about the server this suite runs inside');
  assert.equal(childEnv.SOMA_HOME, HOME_B);

  bus = startBus(soma.args, childEnv);
  bus.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  bus.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'soma_report', arguments: { type: 'NEEDS_INPUT', payload: { question: 'which branch?' } } } });
  assert.ok(await until(() => bus.replies.has(1)), `the bus never answered soma_report; stderr=${bus.stderr()}`);
  const reply = JSON.parse(bus.replies.get(1).result.content[0].text);
  assert.equal(reply.delivered, true, JSON.stringify(reply));

  // The wake is typed during the call, so it is on one screen or the other within moments.
  await until(() => screen(FLEET_A).includes(WAKE_LINE) || screen(FLEET_B).includes(WAKE_LINE));
  const a = screen(FLEET_A);
  const b = screen(FLEET_B);
  assert.ok(!a.includes(WAKE_LINE),
    `fleet B's wake was typed into fleet A's orchestrator (pane %0 on the server named soma), which is the field report:\n${a}`);
  assert.ok(b.includes(WAKE_LINE), `fleet B's orchestrator never got its own lead's wake:\n${b}`);
});

// ---------------------------------------------------------------------------
// Issue #2: only a pane on soma's own server is a keystroke target
// ---------------------------------------------------------------------------

test("the adopt proof: a pane id soma's server has proves nothing unless the session's $TMUX names that server", { skip }, async () => {
  await fleets();
  const otherTmux = await tmuxVarOf(FLEET_A);   // a session in another server: the operator's own, say
  const ownTmux = await tmuxVarOf(FLEET_B);     // a session in the bus's own server
  // The canary, measured rather than assumed: `$TMUX` names its server by `#{socket_path}`, byte for
  // byte, realpath and all. A tmux that changed either spelling reddens here, not in the proof.
  assert.equal(ownTmux.split(',')[0], tm(FLEET_B, 'display-message', '-p', '-t', '%0', '#{socket_path}').trim());
  assert.notEqual(otherTmux.split(',')[0], ownTmux.split(',')[0]);

  // The collision: `%0` is on the bus's server as well, so pane existence alone says yes.
  assert.equal(somaBus.hasPane('%0'), true, "fixture: %0 must exist on the bus's own server, or this is not the collision");
  assert.equal(somaBus.paneOnServer('%0', otherTmux), false, "a session in another server's %0 is not in this server's %0");
  assert.equal(somaBus.paneOnServer('%0', ownTmux), true, "a session in this server's %0 is proven");
  assert.equal(somaBus.paneOnServer('%99', ownTmux), false, 'a pane this server does not have');
  for (const none of [undefined, '']) assert.equal(somaBus.paneOnServer('%0', none), false, `$TMUX ${JSON.stringify(none)}`);

  // The bus's own server not running: the same probe, aimed at a socket nothing listens on (the
  // `run` seam every tmux wrapper takes), from a session whose `$TMUX` names that socket.
  const idle = (args) => {
    try {
      return { stdout: tm('swn', ...args), code: 0 };
    } catch (e) {
      return { stdout: String(e.stdout ?? ''), code: e.status ?? 1 };
    }
  };
  assert.equal(somaBus.paneOnServer('%0', `${dirname(ownTmux.split(',')[0])}/swn,1,0`, idle), false);
});

test('adopting from a pane on another tmux server records notify wake, on the real wiring and real tmux', { skip }, async () => {
  await fleets();
  const otherTmux = await tmuxVarOf(FLEET_A);
  const ownTmux = await tmuxVarOf(FLEET_B);
  /** A promoted session in pane `%0` of whichever server `$TMUX` names, adopting a fresh fleet. */
  const adopt = async (home, tmuxVar) => {
    process.env.SOMA_HOME = join(D, home);
    const env = somaBus.busEnv({ SOMA_ROLE: 'candidate', CLAUDE_CODE_SESSION_ID: `orch-${home}`, TMUX_PANE: '%0', TMUX: tmuxVar, SOMA_TMUX_SOCKET: FLEET_B });
    const reply = await somaBus.buildTools(env).tools.get('soma_adopt')({});
    const held = readLease();
    return { reply, claim: { tmux_socket: held?.tmux_socket, tmux_pane: held?.tmux_pane, wake: held?.wake } };
  };

  const other = await adopt('home-other', otherTmux);
  assert.equal(other.reply.adopted, true);
  assert.equal(other.reply.wake, 'notify', "soma's server has a %0 too, and it is not this session");
  assert.equal(other.reply.degraded_wake, true);
  assert.deepEqual(other.claim, { tmux_socket: null, tmux_pane: null, wake: 'notify' });

  const own = await adopt('home-own', ownTmux);
  assert.equal(own.reply.adopted, true);
  assert.equal(own.reply.wake, 'tmux');
  assert.equal(own.reply.degraded_wake, false);
  assert.deepEqual(own.claim, { tmux_socket: FLEET_B, tmux_pane: '%0', wake: 'tmux' });
});
