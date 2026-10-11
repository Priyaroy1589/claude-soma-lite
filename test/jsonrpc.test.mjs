import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { serve } from '../bin/lib/jsonrpc.mjs';

// --- the original tests, verbatim -------------------------------------------

function harness(tools, describe) {
  const input = new PassThrough(); const output = new PassThrough();
  const lines = []; output.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => lines.push(JSON.parse(l))));
  return { input, output, lines };
}

test('initialize then tools/list returns role tool names', async () => {
  const { serve } = await import('../bin/lib/jsonrpc.mjs?' + Date.now());
  const { input, output, lines } = harness();
  const tools = new Map([['soma_report', async () => ({ ok: true })]]);
  const describe = (n) => ({ name: n, description: 'x', inputSchema: { type: 'object' } });
  serve({ tools, describe }, { input, output });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  await new Promise((r) => setTimeout(r, 20));
  const list = lines.find((l) => l.id === 2);
  assert.deepEqual(list.result.tools.map((t) => t.name), ['soma_report']);
});

test('tools/call dispatches and wraps result as text content', async () => {
  const { serve } = await import('../bin/lib/jsonrpc.mjs?' + Date.now());
  const { input, output, lines } = harness();
  const tools = new Map([['soma_report', async (args) => ({ echoed: args.type })]]);
  serve({ tools, describe: (n) => ({ name: n, description: '', inputSchema: {} }) }, { input, output });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'soma_report', arguments: { type: 'STARTED' } } }) + '\n');
  await new Promise((r) => setTimeout(r, 20));
  const res = lines.find((l) => l.id === 3);
  assert.equal(JSON.parse(res.result.content[0].text).echoed, 'STARTED');
});

// --- the rest of the spec ---------------------------------------------------

const MODULE = new URL('../bin/lib/jsonrpc.mjs', import.meta.url).href;

/**
 * One server on a pair of pipes.
 *
 * The output is kept as *raw text* and parsed on demand, for two reasons: a
 * malformed line then fails one assertion instead of throwing out of a stream
 * listener and taking the whole file with it, and `chunks` records the writes as
 * they were delivered — which is how "every message is exactly one write" gets
 * proved rather than assumed.
 */
const bus = ({ tools = new Map(), describe = (n) => ({ name: n, description: `soma ${n}`, inputSchema: { type: 'object' } }), onNotify, objectMode = false } = {}) => {
  const input = new PassThrough(objectMode ? { objectMode: true } : {});
  const output = new PassThrough();
  const chunks = [];
  let raw = '';
  output.on('data', (d) => { chunks.push(d.toString()); raw += d.toString(); });
  const server = serve({ tools, describe, onNotify }, { input, output });

  const lines = () => raw.split('\n').filter((l) => l !== '').map((l) => {
    try { return JSON.parse(l); } catch (e) { assert.fail(`server wrote a line that is not JSON: ${JSON.stringify(l)} (${e.message})`); }
  });
  return {
    input, output, server, chunks, lines,
    raw: () => raw,
    /** Frame and write one message, the way a client does. */
    send: (msg) => input.write(JSON.stringify(msg) + '\n'),
    byId: (id) => lines().find((m) => m.id === id),
  };
};

/**
 * Wait for a condition instead of for a duration: a fixed sleep is the flake
 * this suite already paid for once, and every path under test
 * here settles in microtasks.
 */
const until = async (pred, what = 'condition', ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) assert.fail(`timed out after ${ms}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
};

/** Let every already-queued microtask and one timer tick drain. */
const settle = async () => { await new Promise((r) => setTimeout(r, 10)); };

// --- the handshake ---------------------------------------------------------

test('initialize answers with the pinned protocol version, listChanged, and serverInfo', async () => {
  const b = bus();
  // A real client sends its own (newer) version. Pinning ours is the spec's
  // "Otherwise, the server MUST respond with another protocol version it
  // supports" branch — not an echo.
  b.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.x' } } });
  await until(() => b.byId(1), 'the initialize reply');
  assert.deepEqual(b.byId(1), {
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: '2024-11-05',
      // listChanged is what licenses emitToolsChanged: "servers that declared
      // the listChanged capability SHOULD send a notification".
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'soma', version: '0.1.0' },
    },
  });
});

test('id 0 is an id — which is the very id the real client opens with', async () => {
  // Measured against Claude Code 2.1.220: its initialize request carries
  // `"id":0`. A truthiness check anywhere on the id path reads that as a
  // notification, answers nothing, and the handshake hangs forever.
  const b = bus();
  b.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  await until(() => b.lines().length === 1, 'the reply to id 0');
  assert.equal(b.lines()[0].id, 0);

  // The other falsy-but-legal id, for the same reason.
  b.send({ jsonrpc: '2.0', id: '', method: 'ping' });
  await until(() => b.lines().length === 2, 'the reply to an empty-string id');
  assert.equal(b.lines()[1].id, '');
});

test('the initialized notification draws no reply; a ping draws an empty one', async () => {
  const seen = [];
  const b = bus({ onNotify: (m) => seen.push(m) });

  // Part of the handshake, handled here — so it is neither answered nor handed
  // to onNotify, which exists for notifications this transport does not know.
  b.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await settle();
  assert.equal(b.raw(), '');
  assert.deepEqual(seen, []);

  // "The receiver MUST respond promptly with an empty response" — MCP ping.
  // A -32601 here would let a pinging client conclude the bus is dead.
  b.send({ jsonrpc: '2.0', id: '123', method: 'ping' });
  await until(() => b.byId('123'), 'the ping reply');
  assert.deepEqual(b.byId('123'), { jsonrpc: '2.0', id: '123', result: {} });
});

// --- tools/list, read from the live Map ------------------------------------

test('tools/list is answered from the live Map, so a candidate -> orchestrator upgrade is visible', async () => {
  // soma-bus.mjs mutates the very Map it handed to serve() and then calls
  // emitToolsChanged(); if serve snapshotted the names, the upgraded session
  // would re-list the candidate's two tools forever.
  const tools = new Map([['soma_adopt', async () => ({ adopted: true })]]);
  const asked = [];
  const b = bus({ tools, describe: (n) => { asked.push(n); return { name: n, description: `soma ${n}`, inputSchema: { type: 'object' } }; } });

  b.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  await until(() => b.byId(1), 'the first tools/list');
  assert.deepEqual(b.byId(1).result.tools, [{ name: 'soma_adopt', description: 'soma soma_adopt', inputSchema: { type: 'object' } }]);

  tools.set('soma_spawn', async () => ({}));
  tools.set('soma_status', async () => ({}));
  b.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  await until(() => b.byId(2), 'the second tools/list');
  assert.deepEqual(b.byId(2).result.tools.map((t) => t.name), ['soma_adopt', 'soma_spawn', 'soma_status']);
  assert.deepEqual(asked, ['soma_adopt', 'soma_adopt', 'soma_spawn', 'soma_status'], 'describe is called once per name per list');

  // An empty role set is a list, not an error.
  const empty = bus();
  empty.send({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
  await until(() => empty.byId(9), 'the empty tools/list');
  assert.deepEqual(empty.byId(9).result, { tools: [] });
});

// --- framing ---------------------------------------------------------------

test('framing: split messages, several per chunk, blank lines, CRLF, and a trailing partial', async () => {
  const b = bus({ tools: new Map([['echo', async (a) => a]]) });
  const call = (id, v) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'echo', arguments: { v } } });

  // One message delivered one byte at a time.
  for (const ch of `${call(1, 'byte-by-byte')}\n`) b.input.write(ch);
  await until(() => b.byId(1), 'the byte-by-byte reply');
  assert.equal(JSON.parse(b.byId(1).result.content[0].text).v, 'byte-by-byte');

  // Three messages in a single write, with blank and whitespace-only lines
  // between them, and a CRLF terminator on the last.
  b.input.write(`\n${call(2, 'a')}\n   \n${call(3, 'b')}\n\n${call(4, 'c')}\r\n`);
  await until(() => b.byId(4), 'the third batched reply');
  assert.deepEqual(b.lines().map((m) => m.id), [1, 2, 3, 4], 'answered in request order, blank lines skipped');

  // A trailing fragment is held, not parsed...
  b.input.write(call(5, 'later').slice(0, 20));
  await settle();
  assert.equal(b.byId(5), undefined);
  // ...and completes when the rest of it arrives.
  b.input.write(`${call(5, 'later').slice(20)}\n`);
  await until(() => b.byId(5), 'the completed fragment');
  assert.equal(JSON.parse(b.byId(5).result.content[0].text).v, 'later');
});

test('a multi-byte character split across a chunk boundary survives', async () => {
  const b = bus({ tools: new Map([['echo', async (a) => a]]) });
  const payload = 'café ✅ 🚀 déjà';
  const frame = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { v: payload } } })}\n`, 'utf8');

  // Cut after the lead byte of 🚀 (F0 9F 9A 80). Asserting the naive decode is
  // *already* broken keeps this test from passing vacuously: `chunk.toString()`
  // per chunk yields U+FFFD here and the JSON no longer parses.
  const cut = frame.indexOf(0xf0) + 1;
  assert.ok(cut > 1, 'the payload must contain a 4-byte sequence');
  assert.ok(frame.subarray(0, cut).toString().includes('�'), 'the split must really break a multi-byte sequence');

  b.input.write(frame.subarray(0, cut));
  b.input.write(frame.subarray(cut));
  await until(() => b.byId(1), 'the reply to a split-UTF-8 frame');
  assert.equal(JSON.parse(b.byId(1).result.content[0].text).v, payload);
  assert.equal(b.raw().includes('�'), false, 'no replacement character reached the client');

  // Same again through a 3-byte sequence (✅ = E2 9C 85), split at its last byte.
  const f2 = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { v: payload } } })}\n`, 'utf8');
  const cut2 = f2.indexOf(0xe2) + 2;
  b.input.write(f2.subarray(0, cut2));
  b.input.write(f2.subarray(cut2));
  await until(() => b.byId(2), 'the reply to a second split frame');
  assert.equal(JSON.parse(b.byId(2).result.content[0].text).v, payload);
});

/** Just past MAX_LINE (16 MiB), which the module does not export. */
const OVER_MAX_LINE = 17 * 1024 * 1024;

test('an unterminated line is dropped once it stops being a message, and the connection recovers', async () => {
  const b = bus({ tools: new Map([['ok', async () => ({ ok: true })]]) });

  // A peer that stops framing is the one way the line buffer grows without
  // bound, and the end of that road is `buf += chunk` throwing
  // `RangeError: Invalid string length` at V8's ~512MB cap — from the first
  // statement of the reader, where an escaping throw is a dead bus. Measured
  // against the previous commit, this fragment alone was already terminal: not
  // by crashing, but by poisoning the connection, because every later message
  // concatenates onto it and can never parse again.
  b.input.write('x'.repeat(OVER_MAX_LINE));
  await settle();
  assert.equal(b.raw(), '', 'a fragment is not a message');

  b.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  await until(() => b.byId(1), 'a ping after an over-long fragment was dropped', 5000);
  assert.deepEqual(b.byId(1).result, {}, 'the buffer recovered rather than prepending 17 MiB onto this');
});

test('a complete line is delivered on its framing, not judged on its size', async () => {
  // Why the bound is checked *after* draining, not before appending: a large but
  // properly terminated frame is a message, and dropping it for its size would
  // be a data-loss bug wearing the fix's clothes.
  const b = bus({ tools: new Map([['sink', async (a) => ({ len: a.v.length })]]) });
  const big = 'x'.repeat(OVER_MAX_LINE);
  b.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sink', arguments: { v: big } } })}\n`);
  await until(() => b.byId(1), 'the reply to a 17 MiB complete frame', 10_000);
  assert.equal(JSON.parse(b.byId(1).result.content[0].text).len, big.length);
});

test('a chunk that is not a Buffer resets the buffer instead of ending the reader', async () => {
  // The belt on the reader's first statement. An objectMode stream is the
  // reachable version of "the framing itself threw": `decoder.write` rejects
  // anything that is not a Buffer/TypedArray/DataView with a TypeError, and
  // pre-fix that escaped the `data` listener — the same class of uncaught
  // exception round 1 closed for the reply paths.
  const b = bus({ tools: new Map([['ok', async () => ({ ok: true })]]), objectMode: true });
  b.input.write({ not: 'a buffer' });
  await settle();
  assert.equal(b.raw(), '');

  // An objectMode stream also carries strings, which the reader takes as-is —
  // so the same connection can prove it is still alive.
  b.input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  await until(() => b.byId(1), 'a ping after a chunk the decoder refused', 5000);
  assert.deepEqual(b.byId(1).result, {});
});

test('garbage on the wire is skipped, and never stops the next message', async () => {
  const seen = [];
  const b = bus({ onNotify: (m) => seen.push(m) });
  const raw = [
    '{"jsonrpc":"2.0",',                     // truncated JSON
    'not json at all',
    '{"jsonrpc":"2.0" "id":1}',              // syntactically broken
    'null', '42', '"a string"', 'true',      // valid JSON, not a message
    '[{"jsonrpc":"2.0","id":1,"method":"ping"}]', // a batch: not in 2024-11-05
    '{"jsonrpc":"2.0","id":7}',              // no method
    '{"jsonrpc":"2.0","method":123}',        // method not a string
    '{"jsonrpc":"2.0","id":8,"result":{}}',  // a *response* from the peer
    '{"jsonrpc":"2.0","id":9,"error":{"code":-1,"message":"x"}}',
  ];
  b.input.write(`${raw.join('\n')}\n`);
  await settle();
  assert.equal(b.raw(), '', `nothing on the wire should have been answered, got: ${b.raw()}`);
  assert.deepEqual(seen, [], 'onNotify is for method notifications, not for garbage');

  // The connection is still usable — the whole point.
  b.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await until(() => b.byId(1), 'the reply after the garbage');
  assert.equal(b.lines().length, 1);
});

// --- routing ---------------------------------------------------------------

test('an unknown method with an id is a -32601, even when onNotify is watching', async () => {
  const seen = [];
  const b = bus({ onNotify: (m) => seen.push(m) });

  // The original ladder tested `msg.method && onNotify` *before* `msg.id != null`,
  // so with onNotify wired a request for an unimplemented capability got no
  // reply at all and the client waited for it forever.
  b.send({ jsonrpc: '2.0', id: 5, method: 'resources/list', params: {} });
  await until(() => b.byId(5), 'the -32601 for an unknown method');
  assert.deepEqual(b.byId(5), { jsonrpc: '2.0', id: 5, error: { code: -32601, message: 'method not found: resources/list' } });
  assert.deepEqual(seen, []);

  // A notification (no id) is what onNotify is for — Claude Code sends
  // notifications/cancelled when an operator interrupts a turn.
  const cancelled = { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 5, reason: 'user' } };
  b.send(cancelled);
  await until(() => seen.length === 1, 'the notification handed to onNotify');
  assert.deepEqual(seen, [cancelled]);
  assert.equal(b.lines().length, 1, 'a notification is never answered');

  // ...and without an onNotify it is simply dropped.
  const quiet = bus();
  quiet.send(cancelled);
  await settle();
  assert.equal(quiet.raw(), '');
});

test('a request sent as a notification is executed and never answered', async () => {
  let ran = 0;
  const b = bus({ tools: new Map([['soma_report', async () => { ran += 1; return { ok: true }; }]]) });

  // JSON-RPC 2.0: a Notification gets no Response. Replying with `id: undefined`
  // (which JSON.stringify drops) would put a response with no id on the wire.
  b.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'soma_report', arguments: {} } });
  await until(() => ran === 1, 'the notified tool call to run');
  b.send({ jsonrpc: '2.0', method: 'initialize', params: {} });
  b.send({ jsonrpc: '2.0', method: 'tools/list' });
  await settle();
  assert.equal(b.raw(), '');
});

test('nothing a notification can do produces a frame — not even the failure paths', async () => {
  // JSON-RPC forbids answering a notification, so every path that *would* have
  // replied must stay silent for one — including the error paths added since,
  // which is what makes this worth pinning rather than assuming. A fabricated
  // reply here is an id-less or null-id frame the client never asked for and
  // cannot correlate.
  const cyclic = { name: 'fleet' }; cyclic.self = cyclic;
  const ran = [];
  const b = bus({
    tools: new Map([
      ['boom', async () => { ran.push('boom'); throw new Error('kaboom'); }],
      ['nully', async () => { ran.push('nully'); throw null; }],
      ['cyclic', async () => { ran.push('cyclic'); return cyclic; }],
      ['fine', async () => { ran.push('fine'); return { ok: true }; }],
    ]),
  });

  for (const name of ['boom', 'nully', 'cyclic', 'fine']) {
    b.send({ jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: {} } });   // no id
  }
  b.send({ jsonrpc: '2.0', method: 'tools/call', params: {} });                          // no name either
  b.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 42 } });                // a non-string name
  b.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'absent' } });          // not in the Map
  b.send({ jsonrpc: '2.0', method: 'tools/call' });                                      // no params at all
  b.send({ jsonrpc: '2.0', method: 'initialize', params: {} });                          // and the request methods
  b.send({ jsonrpc: '2.0', method: 'tools/list' });
  b.send({ jsonrpc: '2.0', method: 'ping' });

  // The handlers really ran, so the silence below is the id guard and not an
  // accident of nothing having happened.
  await until(() => ran.length === 4, 'all four notified handlers to run');
  await settle();
  assert.equal(b.raw(), '', `a notification was answered: ${b.raw()}`);

  // ...and the server is still able to answer something that asked.
  b.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  await until(() => b.byId(1), 'a ping with an id, after all of that');
  assert.equal(b.lines().length, 1);
});

test('an unknown tool is a -32601 that names it; a call with no name is a -32602', async () => {
  const b = bus({ tools: new Map([['soma_report', async () => ({})]]) });
  b.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'soma_spawn', arguments: {} } });
  await until(() => b.byId(1), 'the unknown-tool error');
  assert.deepEqual(b.byId(1), { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'unknown tool soma_spawn' } });
  assert.equal('result' in b.byId(1), false, 'a JSON-RPC message carries error or result, never both');

  // A malformed call is not a missing tool. These messages reach the model
  // verbatim, and `unknown tool undefined` reads as a bug in soma rather than as
  // a bad request — so it must not be what a nameless call gets told.
  b.send({ jsonrpc: '2.0', id: 2, method: 'tools/call' });                          // no params at all
  b.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} });              // params, no name
  b.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 42 } });    // a name that is not a name
  await until(() => b.byId(4), 'all three invalid-params errors');
  for (const id of [2, 3, 4]) {
    assert.deepEqual(b.byId(id).error, { code: -32602, message: 'missing params.name' }, `id ${id}`);
    assert.equal(b.byId(id).error.message.includes('undefined'), false, `id ${id} must not name a tool that was never named`);
  }

  // An empty string, though, really is a name that is not in the Map.
  b.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: '' } });
  await until(() => b.byId(5), 'the empty-name error');
  assert.deepEqual(b.byId(5).error, { code: -32601, message: 'unknown tool ' });
});

/**
 * An id nested deeply enough that `JSON.parse` accepts it and `JSON.stringify` of
 * the response wrapping it does not. Measured on Node 24: parse survives 500k
 * levels, stringify of `{jsonrpc, id, error}` overflows the stack past ~10k — so
 * this line is a legal JSON-RPC request that cannot be answered.
 */
const DEEP_ID = `${'['.repeat(50_000)}${']'.repeat(50_000)}`;
const FRAME_FAILURE = { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'internal error' } };

test('a response that cannot be framed is still answered, and never escapes the reader', async () => {
  const b = bus({ tools: new Map([['ok', async () => ({ ok: true })]]) });

  // Written raw: JSON.stringify in the test helper would overflow on the way in.
  // (a) The synchronous path — the throw comes out of `dispatch`, and the
  // recovery `err` throws the same RangeError, one frame below the `data`
  // listener. Unguarded that is an uncaught exception and the bus is gone.
  b.input.write(`{"jsonrpc":"2.0","id":${DEEP_ID},"method":"tools/list"}\n`);
  await until(() => b.lines().length === 1, 'the fallback for an un-framable tools/list');
  assert.deepEqual(b.lines()[0], FRAME_FAILURE);

  // (b) The queued path — there the throw rejects the chain step, whose `.catch`
  // would swallow it and leave the client waiting out its whole timeout.
  b.input.write(`{"jsonrpc":"2.0","id":${DEEP_ID},"method":"tools/call","params":{"name":"ok","arguments":{}}}\n`);
  await until(() => b.lines().length === 2, 'the fallback for an un-framable tools/call');
  assert.deepEqual(b.lines()[1], FRAME_FAILURE);

  // Same again for a call that fails before the handler, so the -32601/-32602
  // replies are covered too, not just the success reply.
  b.input.write(`{"jsonrpc":"2.0","id":${DEEP_ID},"method":"tools/call","params":{"name":"nope","arguments":{}}}\n`);
  b.input.write(`{"jsonrpc":"2.0","id":${DEEP_ID},"method":"tools/call"}\n`);
  b.input.write(`{"jsonrpc":"2.0","id":${DEEP_ID},"method":"resources/list"}\n`);
  await until(() => b.lines().length === 5, 'the remaining fallbacks');
  assert.deepEqual(b.lines().slice(2), [FRAME_FAILURE, FRAME_FAILURE, FRAME_FAILURE]);

  // ...and the connection is still good.
  b.send({ jsonrpc: '2.0', id: 9, method: 'ping' });
  await until(() => b.byId(9), 'a ping after five un-framable replies');
});

test('a request is always answered — even when the transport was wired up wrong', async () => {
  // Silence is the one failure a client cannot recover from: it waits out its
  // whole timeout with a tool call the model believes is running. So a caller
  // bug — `tools` that is not a Map, a `describe` that throws or returns
  // something unserializable — still has to produce a response.
  // `null`, not `undefined` — a default parameter would swallow undefined and
  // the test would pass on an empty Map instead of a broken one.
  const broken = bus({ tools: null });
  broken.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x', arguments: {} } });
  broken.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await until(() => broken.byId(1) && broken.byId(2), 'both replies from a broken wiring');
  assert.equal(broken.byId(1).error.code, -32000, 'the queued step must not reject into silence');
  assert.equal(broken.byId(2).error.code, -32603);

  const badDescribe = bus({ tools: new Map([['x', async () => ({})]]), describe: () => { throw new Error('bad describe'); } });
  badDescribe.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  await until(() => badDescribe.byId(1), 'the reply for a throwing describe');
  assert.deepEqual(badDescribe.byId(1).error, { code: -32603, message: 'bad describe' });

  // A tool list that cannot be serialized at all: the throw comes from inside
  // `send`, which must not swallow it into silence.
  const cyclic = { name: 'x' }; cyclic.self = cyclic;
  const unserializable = bus({ tools: new Map([['x', async () => ({})]]), describe: () => cyclic });
  unserializable.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  await until(() => unserializable.byId(1), 'the reply for an unserializable tool list');
  assert.equal(unserializable.byId(1).error.code, -32603);
  assert.match(unserializable.byId(1).error.message, /circular/i);

  // ...and every one of them is still serving afterwards.
  for (const b of [broken, badDescribe, unserializable]) {
    b.send({ jsonrpc: '2.0', id: 99, method: 'ping' });
    await until(() => b.byId(99), 'a ping after the failure');
  }
});

// --- handler failure modes -------------------------------------------------

test('a handler that fails becomes a -32000 and the server keeps serving', async () => {
  const b = bus({
    tools: new Map([
      ['reject', async () => { throw new Error('lease held by pid 42'); }],
      ['throw', () => { throw new Error('sync boom'); }],           // not even async
      ['nully', async () => { throw null; }],                       // a thrown non-Error…
      ['stringy', async () => { throw 'plain string'; }],           // …of each shape a
      ['messageless', async () => { throw { code: 'ENOENT' }; }],    // real dep can produce
      ['fine', async () => ({ ok: true })],
    ]),
  });
  const call = (id, name) => b.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });

  call(1, 'reject'); call(2, 'throw'); call(3, 'nully'); call(4, 'stringy'); call(5, 'messageless'); call(6, 'fine');
  await until(() => b.byId(6), 'the reply after five failures');

  assert.deepEqual(b.byId(1), { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'lease held by pid 42' } });
  assert.deepEqual(b.byId(2).error, { code: -32000, message: 'sync boom' });
  // `e.message` on a thrown null is itself a TypeError; unguarded it becomes an
  // unhandled rejection, which under Node's default kills the bus.
  for (const id of [3, 4, 5]) {
    assert.equal(b.byId(id).error.code, -32000, `id ${id}`);
    assert.equal(typeof b.byId(id).error.message, 'string', `id ${id} message must be a string`);
    assert.ok(b.byId(id).error.message.length > 0, `id ${id} message must not be empty`);
  }
  assert.equal(b.byId(4).error.message, 'plain string');
  assert.equal(JSON.parse(b.byId(6).result.content[0].text).ok, true, 'the server survived all of it');
});

test('a result that cannot be serialized is an error, not a crash', async () => {
  const cyclic = { name: 'fleet' }; cyclic.self = cyclic;
  const b = bus({
    tools: new Map([
      ['cyclic', async () => cyclic],
      ['bigint', async () => ({ seq: 1n })],
      ['fine', async () => ({ ok: true })],
    ]),
  });
  const call = (id, name) => b.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });

  call(1, 'cyclic'); call(2, 'bigint'); call(3, 'fine');
  await until(() => b.byId(3), 'the reply after two unserializable results');
  assert.equal(b.byId(1).error.code, -32000);
  assert.match(b.byId(1).error.message, /circular/i);
  assert.equal(b.byId(2).error.code, -32000);
  assert.equal(JSON.parse(b.byId(3).result.content[0].text).ok, true);
});

test('every result is text, even when the handler returns nothing', async () => {
  const b = bus({
    tools: new Map([
      ['void', async () => {}],
      ['nul', async () => null],
      ['str', async () => 'queued'],
      ['num', async () => 0],
      ['falsey', async () => false],
    ]),
  });
  const call = (id, name) => b.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });
  ['void', 'nul', 'str', 'num', 'falsey'].forEach((n, i) => call(i + 1, n));
  await until(() => b.byId(5), 'all five replies');

  // JSON.stringify(undefined) is undefined, not '"undefined"' — the key would
  // vanish and the client would see {type:'text'} with no text at all.
  for (const id of [1, 2, 3, 4, 5]) {
    const [content] = b.byId(id).result.content;
    assert.deepEqual(Object.keys(content).sort(), ['text', 'type'], `id ${id}`);
    assert.equal(content.type, 'text');
    assert.equal(typeof content.text, 'string', `id ${id} text must be a string`);
    assert.doesNotThrow(() => JSON.parse(content.text), `id ${id} text must be JSON`);
  }
  assert.equal(b.byId(1).result.content[0].text, 'null');
  assert.equal(b.byId(2).result.content[0].text, 'null');
  assert.equal(JSON.parse(b.byId(3).result.content[0].text), 'queued');
  assert.equal(JSON.parse(b.byId(4).result.content[0].text), 0);
  assert.equal(JSON.parse(b.byId(5).result.content[0].text), false);
});

// --- the wire itself -------------------------------------------------------

test('every message is one write of one line, whatever the payload contains', async () => {
  const nasty = {
    summary: 'line1\nline2\r\ttab "quoted" \\ backslash',
    unicode: 'café ✅ 🚀',
    nested: { deep: ['\n\n\n', '}\n{'] },
  };
  const b = bus({
    tools: new Map([
      ['nasty', async () => nasty],
      ['boom', async () => { throw new Error('failed on\ntwo lines'); }],
    ]),
  });
  b.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nasty', arguments: {} } });
  b.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'boom', arguments: {} } });
  await until(() => b.byId(2), 'both replies');

  // JSON.stringify escapes every newline it emits, so a payload cannot forge a
  // frame boundary; the client's own split-on-newline reader stays in sync.
  assert.equal(b.chunks.length, 2, `one write per message, got ${b.chunks.length}`);
  for (const chunk of b.chunks) {
    assert.equal(chunk.endsWith('\n'), true);
    assert.equal(chunk.slice(0, -1).includes('\n'), false, 'a message must not contain a raw newline');
    assert.equal(chunk.slice(0, -1).includes('\r'), false, 'nor a raw carriage return');
  }
  assert.deepEqual(JSON.parse(b.byId(1).result.content[0].text), nasty, 'the payload round-trips exactly');
  assert.equal(b.byId(2).error.message, 'failed on\ntwo lines');
});

test('emitToolsChanged writes exactly one id-less notification', async () => {
  const b = bus();
  const out = b.server.emitToolsChanged();
  await settle();
  // The promotion announcement, byte for byte. An `id` here would make it a
  // request the client would try to answer.
  assert.equal(b.raw(), '{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n');
  assert.equal(out, undefined, 'emitToolsChanged reports nothing');
  b.server.emitToolsChanged();
  await settle();
  assert.equal(b.chunks.length, 2, 'and it is repeatable');
});

// --- dispatch discipline ---------------------------------------------------

test('tool calls run one at a time, in request order', async () => {
  // Serialized on purpose: the fleet lock is re-entrant *because* "every
  // acquisition is synchronous … there is no await between acquire and release
  // for another caller to interleave into". Two handlers awaiting in the same
  // process would break that premise between their lock sections.
  const events = [];
  let release;
  const b = bus({
    tools: new Map([
      ['slow', async () => { events.push('enter slow'); await new Promise((r) => { release = r; }); events.push('exit slow'); return { slow: true }; }],
      ['fast', async () => { events.push('enter fast'); events.push('exit fast'); return { fast: true }; }],
    ]),
  });
  b.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow', arguments: {} } });
  b.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fast', arguments: {} } });

  await until(() => release, 'the slow handler to start');
  await settle();
  assert.deepEqual(events, ['enter slow'], 'the second call must not start before the first finishes');
  assert.equal(b.raw(), '');

  release();
  await until(() => b.byId(2), 'both replies');
  assert.deepEqual(events, ['enter slow', 'exit slow', 'enter fast', 'exit fast']);
  assert.deepEqual(b.lines().map((m) => m.id), [1, 2], 'responses in request order');
});

test('a pending tool call does not block the handshake or the tool list', async () => {
  // The flip side of serialization: metadata is answered synchronously, so a
  // wedged handler cannot make the whole bus look dead to a pinging client.
  let started = false;
  const b = bus({ tools: new Map([['hang', async () => { started = true; await new Promise(() => {}); }]]) });
  b.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hang', arguments: {} } });
  await until(() => started, 'the hanging handler to start');

  b.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
  b.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  b.send({ jsonrpc: '2.0', id: 4, method: 'ping' });
  b.send({ jsonrpc: '2.0', id: 5, method: 'nope/nope' });
  await until(() => b.byId(2) && b.byId(3) && b.byId(4) && b.byId(5), 'the four metadata replies');
  assert.equal(b.byId(1), undefined, 'the wedged call is still outstanding');
  b.server.emitToolsChanged();
  await settle();
  assert.equal(b.lines().length, 5);
});

// --- the default io, in a real process -------------------------------------

/** Serve `tools` in a child process over its real stdin/stdout, and collect the lines. */
const child = (lines) => new Promise((resolve, reject) => {
  const script = `
    import { serve } from ${JSON.stringify(MODULE)};
    const tools = new Map([
      ['ok', async (a) => ({ echoed: a.v })],
      ['boom', async () => { throw new Error('kaboom'); }],
      ['void', async () => {}],
    ]);
    serve({ tools, describe: (n) => ({ name: n, description: 'soma ' + n, inputSchema: { type: 'object' } }) });
  `;
  const proc = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { err += d.toString(); });
  proc.on('error', reject);
  const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`child never exited; stdout so far: ${out}`)); }, 15_000);
  proc.on('close', (code) => { clearTimeout(timer); resolve({ code, err, out, messages: out.split('\n').filter(Boolean).map((l) => JSON.parse(l)) }); });
  // A raw string is written as its own line — the only way to send a message
  // this test process cannot itself serialize.
  proc.stdin.end(lines.map((m) => `${typeof m === 'string' ? m : JSON.stringify(m)}\n`).join(''));
});

test('the default io is the real stdin/stdout, and a failing handler does not kill the process', async () => {
  const { code, err, messages } = await child([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ok', arguments: { v: 'café 🚀' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'void', arguments: {} } },
    { jsonrpc: '2.0', id: 6, method: 'ping' },
  ]);

  // Exit 0 is the assertion that matters: an unhandled rejection from `boom`
  // would end the process at the next microtask checkpoint, and closing stdin
  // is how the MCP stdio transport says shutdown happens.
  assert.equal(code, 0, `child exited ${code}: ${err}`);
  assert.equal(err, '', `nothing should reach stderr, got: ${err}`);

  // All seven lines arrive in one chunk, so this is the dispatch split on the
  // wire: metadata (1, 2, 6) is answered inside the reader, the three tool calls
  // (3, 4, 5) drain the queue afterwards in arrival order. Responses are
  // correlated by id, so a client is indifferent — but a ping never queues
  // behind a tool call, which is the whole point.
  assert.deepEqual(messages.map((m) => m.id), [1, 2, 6, 3, 4, 5]);
  const byId = (id) => messages.find((m) => m.id === id);
  assert.equal(byId(1).result.protocolVersion, '2024-11-05');
  assert.deepEqual(byId(2).result.tools.map((t) => t.name), ['ok', 'boom', 'void']);
  assert.equal(JSON.parse(byId(3).result.content[0].text).echoed, 'café 🚀');
  assert.deepEqual(byId(4).error, { code: -32000, message: 'kaboom' });
  assert.equal(byId(5).result.content[0].text, 'null');
  assert.deepEqual(byId(6).result, {});
});

test('a real process survives an un-framable response instead of dying with it', async () => {
  // In-process assertions cannot tell "answered from the recovery path" from
  // "answered and then the listener threw": under `node --test` an uncaught
  // exception from a stream callback is attributed to whatever test is running.
  // A child process can — measured against the pre-fix module, the first line
  // below exited **1** with `RangeError: Maximum call stack size exceeded at
  // Socket.<anonymous> (jsonrpc.mjs:280)`, and the second was answered with
  // nothing at all.
  const { code, err, messages } = await child([
    `{"jsonrpc":"2.0","id":${DEEP_ID},"method":"tools/list"}`,
    `{"jsonrpc":"2.0","id":${DEEP_ID},"method":"tools/call","params":{"name":"ok","arguments":{"v":"x"}}}`,
    { jsonrpc: '2.0', id: 7, method: 'ping' },
  ]);

  assert.equal(code, 0, `child exited ${code}: ${err}`);
  assert.equal(err, '', `nothing should reach stderr, got: ${err}`);
  assert.equal(messages.length, 3);
  assert.equal(messages.filter((m) => m.id === null).length, 2, 'both un-framable replies were answered');
  for (const m of messages.filter((m) => m.id === null)) assert.deepEqual(m, FRAME_FAILURE);
  assert.deepEqual(messages.find((m) => m.id === 7).result, {});
});

// --- the reader going away ---------------------------------------------------

test('an EPIPE on the bus output is an event, so only a listener keeps it off the log', async () => {
  const b = bus();
  const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' });

  // `send()`'s try/catch covers a *synchronous* throw out of `output.write`, so it does
  // not substitute for this: writing to a pipe whose reader is gone reports back as an
  // 'error' EVENT, and an 'error' event with no listener is thrown by EventEmitter
  // itself. Measured — with the listener removed, this emit throws the EPIPE straight
  // out of the call. Stdout is also the only channel this module has, so there is
  // nowhere to report it to even if it were actionable.
  assert.doesNotThrow(() => b.output.emit('error', epipe),
    'nothing is listening for EPIPE on the bus output, so the ordinary end of every session is an uncaught exception');

  // Swallowed, not torn down. Stated at the seam as well as end to end: a listener that
  // destroys the stream also "handles" the event, and the round-trip below would then
  // fail in `until`'s timeout rather than saying what went wrong.
  assert.equal(b.output.destroyed, false, 'the EPIPE listener tore the output down instead of swallowing');
  b.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  await until(() => b.byId(1), 'a ping answered after the output reported an error');
  assert.deepEqual(b.byId(1).result, {});
});

test('a real bus survives its reader going away, which is how every session ends', async () => {
  // A child, for the reason the un-framable-response test gives: an unhandled 'error'
  // event out of a stream callback is an uncaught exception, and under `node --test`
  // that is attributed to whichever test happens to be running. Measured against the
  // module with `output.on('error')` deleted, this child exits **1** with
  // `Error: write EPIPE / Unhandled 'error' event` on stderr, 3 of 3 runs.
  const script = `
    import { serve } from ${JSON.stringify(MODULE)};
    serve({ tools: new Map([['ok', async () => ({ ok: true })]]),
            describe: (n) => ({ name: n, description: 'soma ' + n, inputSchema: { type: 'object' } }) });
  `;
  const proc = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err += d.toString(); });
  // The parent's own ends, so a broken pipe here cannot be mistaken for the child's.
  proc.stdout.on('error', () => {});
  proc.stdin.on('error', () => {});
  // Attached before anything is written: `close` fires once, and a child that dies
  // immediately would otherwise fire it before there was a listener to hear it.
  const closed = new Promise((resolve) => proc.on('close', (code, signal) => resolve({ code, signal })));
  const timer = setTimeout(() => proc.kill('SIGKILL'), 15_000);

  await new Promise((resolve) => {
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); if (out.includes('\n')) resolve(); });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
  });

  // Claude Code closes the pipes when it exits and a reply already in flight loses the
  // race. Destroying the read end is that, exactly — and then three more requests, so
  // the bus is certain to write into a pipe with nobody on the other side.
  proc.stdout.destroy();
  for (const id of [2, 3, 4]) proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })}\n`);
  proc.stdin.end();

  const { code, signal } = await closed;
  clearTimeout(timer);
  assert.equal(code, 0, `a torn-down stdout ended the process, not the session: exit ${code}/${signal}`);
  assert.equal(err, '', `an EPIPE reached the MCP log looking like a soma crash: ${err}`);
});
