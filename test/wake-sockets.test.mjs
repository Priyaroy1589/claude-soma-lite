/**
 * Issue #1 on real tmux: two fleets, two tmux servers, one pane id.
 *
 * Seen in the field: a default fleet on socket `soma` and a second fleet on a socket of its own,
 * both orchestrators sitting in pane `%40` of their own server — and every NEEDS_INPUT and
 * COMPLETED wake from the second fleet's leads was typed into the FIRST fleet's orchestrator. A
 * pane id is a small per-server counter, so two servers sharing one is the ordinary case rather
 * than a coincidence. The lead's bus never learned its fleet's socket (`env -i` dropped it and the
 * lead's `mcp.json` did not set it), so it fell back to `soma` and typed `%40` there.
 *
 * This file stages exactly that, safely. Two fresh servers whose first pane is `%0` on both;
 * fleet B's lease naming `%0` on its own socket; and a bus started with the environment a really
 * spawned lead's bus gets: `spawn.buildLeadEnv`'s output plus the `soma` entry of the `mcp.json`
 * that `settings-gen.writeLeadMcpConfig` writes for that lead, which is what Claude Code hands an
 * MCP server (its own process env, plus the config's `env`). The lead files NEEDS_INPUT over the
 * bus's own stdio, and the two panes say where the wake landed: each runs `cat`, which echoes what
 * is typed into it. Before the fix the line lands in fleet A's pane; after it, in fleet B's.
 *
 * ⚠ TMUX SAFETY. Every server here lives under a throwaway `TMUX_TMPDIR`, set before anything
 * loads `tmux.mjs`, so even the server named `soma` (fleet A, deliberately the default name) is a
 * stranger to any live fleet's. `-f /dev/null` keeps the operator's tmux.conf, and any plugin in it
 * that saves or restores sessions, out of these servers. `$TMUX` is dropped, so no tmux call in
 * this process can fall back to the server the suite happens to run inside. `after` kills both
 * servers and deletes the directory.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

// --- The sandbox, before anything else. Nothing below may reach a tmux server outside it. -----
// Short names on purpose: a Unix socket path must stay under ~104 bytes, and tmux reports the
// realpath (`/private/var/...` on macOS).
const D = mkdtempSync(join(tmpdir(), 'sw-'));
process.env.TMUX_TMPDIR = D;
delete process.env.TMUX;
delete process.env.TMUX_PANE;

// The spawner is fleet B's. `tmux.mjs` reads `SOMA_TMUX_SOCKET` once, at load, so it is set here,
// before the dynamic imports below: the same position a fleet-B watchdog is in, whose environment
// carries it (`soma up` forwards it through `WATCHDOG_ENV_ALLOW`).
const saved = { SOMA_TMUX_SOCKET: process.env.SOMA_TMUX_SOCKET, SOMA_HOME: process.env.SOMA_HOME };
const FLEET_A = 'soma';   // the default socket name: a throwaway here, because of TMUX_TMPDIR
const FLEET_B = 'swb';
process.env.SOMA_TMUX_SOCKET = FLEET_B;
const HOME_B = join(D, 'home-b');
process.env.SOMA_HOME = HOME_B;

const { buildLeadEnv } = await import('../bin/lib/spawn.mjs');
const { writeLeadMcpConfig } = await import('../bin/lib/settings-gen.mjs');
const { acquireLease } = await import('../bin/lib/lease.mjs');
const tmux = await import('../bin/lib/tmux.mjs');

const tmuxInstalled = spawnSync('tmux', ['-V']).status === 0;
const LEAD = 'cr-b';
const WAKE_LINE = `[soma] ${LEAD} NEEDS_INPUT. Call soma_inbox.`;
const started = new Set();
let bus = null;

/**
 * tmux on one of this file's two servers. `-f /dev/null` is only read by the command that starts
 * a server, and costs nothing on the others, so every call carries it rather than remembering
 * which one starts the server.
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

test("a lead's wake lands on its own fleet's tmux server, not on the default one's pane with the same id", { skip: !tmuxInstalled && 'tmux not installed' }, async () => {
  assert.equal(tmux.socketName(), FLEET_B, "fixture: the spawner side must be fleet B's, or this measures nothing");

  // Two fleets, and the collision the field report had: both orchestrators in the same pane id.
  const paneA = await orchestrator(FLEET_A, 'fleet-a-orchestrator');
  const paneB = await orchestrator(FLEET_B, 'fleet-b-orchestrator');
  assert.equal(paneA, '%0', 'fixture: a fresh server numbers its first pane %0');
  assert.equal(paneB, paneA, 'fixture: the two orchestrators must share a pane id, as in the field report');

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
