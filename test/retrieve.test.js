'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createServer } = require('../src/proxy');
const { compressRequest } = require('../src/messages');
const { verifyRequest } = require('../src/verify');
const retrieve = require('../src/retrieve');
const formats = require('../src/formats');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// A Bash result big enough to be capped in aggressive mode; every line is distinct.
const BIG = Array.from({ length: 400 }, (_, i) => `build step ${i}: compiled module_${i * 7}.js in ${(i * 13) % 97}ms`).join('\n');
const ID = formats.retrieveId(BIG);

const conversation = (stream) => ({
  model: 'claude-opus-5-5',
  max_tokens: 1000,
  stream,
  thinking: { type: 'adaptive' },
  tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
  messages: [
    { role: 'user', content: 'build it' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'make' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: BIG }] },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'what was step 200?' },
  ],
});

// Upstream that answers from a script: script[n] is the n-th reply, as a full message object.
function scriptedUpstream(script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ body, headers: req.headers });
      const msg = { id: `msg_${seen.length}`, type: 'message', role: 'assistant', model: body.model, ...script[seen.length - 1] };
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(msg));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', { message: { ...msg, content: [], stop_reason: null, usage: msg.usage } });
      ev('ping', {});
      msg.content.forEach((b, index) => {
        if (b.type === 'text') {
          ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
          for (const part of [b.text.slice(0, 3), b.text.slice(3)]) ev('content_block_delta', { index, delta: { type: 'text_delta', text: part } });
        } else if (b.type === 'thinking') {
          ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
          ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } });
          ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature } });
        } else if (b.type === 'tool_use') {
          ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
          const j = JSON.stringify(b.input);
          for (const part of [j.slice(0, 5), j.slice(5)]) ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: part } });
        }
        ev('content_block_stop', { index });
      });
      ev('message_delta', { delta: { stop_reason: msg.stop_reason }, usage: { output_tokens: 7 } });
      ev('message_stop', {});
      res.end();
    });
  });
  return { server, seen };
}

const T1 = { type: 'thinking', thinking: 'need the omitted lines', signature: 'sig-1' };
const T2 = { type: 'thinking', thinking: 'found it', signature: 'sig-2' };
const CALL = { type: 'tool_use', id: 'r1', name: 'tokentrim_retrieve', input: { id: ID, from_line: 200, to_line: 202 } };
const ANSWER = { type: 'text', text: 'Step 200 compiled module_1400.js.' };
const SCRIPT = [
  { content: [T1, CALL], stop_reason: 'tool_use', usage: { input_tokens: 900, output_tokens: 40 } },
  { content: [T2, ANSWER], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 20 } },
];

async function withProxy(script, fn) {
  const up = scriptedUpstream(script);
  const upPort = await listen(up.server);
  const { server, stats } = createServer({ anthropicUpstream: `http://127.0.0.1:${upPort}`, mode: 'aggressive', maxToolChars: 2000, retrieve: true });
  const port = await listen(server);
  try {
    await fn(port, up.seen, stats);
  } finally {
    server.close();
    up.server.close();
  }
}

const post = (port, body) =>
  fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });

function checkUpstream(seen) {
  assert.strictEqual(seen.length, 2, 'one follow-up request');
  for (const s of seen) assert.ok(s.body.tools.some((t) => t.name === 'tokentrim_retrieve'), 'tool offered on every request');
  const shortened = seen[0].body.messages[2].content[0].content;
  assert.ok(shortened.length < BIG.length);
  assert.ok(shortened.endsWith(`full text via tokentrim_retrieve {"id":"${ID}"}]`), 'shortened result carries the note');
  const [asst, user] = seen[1].body.messages.slice(-2);
  assert.deepStrictEqual(asst, { role: 'assistant', content: [T1, CALL] }, 'the model sees its own call, thinking intact');
  const result = user.content[0];
  assert.strictEqual(result.tool_use_id, 'r1');
  assert.strictEqual(result.content, `[lines 200-202 of 400; call again with from_line=203 for more]\n${BIG.split('\n').slice(199, 202).join('\n')}`);
  assert.deepStrictEqual(seen[1].body.messages.slice(0, -2), seen[0].body.messages, 'history is append-only');
}

test('retrieval (non-streaming): the proxy answers the call and returns one clean assistant turn', async () => {
  await withProxy(SCRIPT, async (port, seen, stats) => {
    const res = await post(port, conversation(false));
    assert.strictEqual(res.status, 200);
    const msg = await res.json();
    checkUpstream(seen);
    // T1 keeps its exact prefix; T2 was produced after hidden turns, so it is left out.
    assert.deepStrictEqual(msg.content, [T1, ANSWER]);
    assert.strictEqual(msg.stop_reason, 'end_turn');
    assert.strictEqual(msg.usage.output_tokens, 60, 'output tokens of both rounds');
    assert.strictEqual(stats.retrievals, 1);
  });
});

function rebuild(sseText) {
  const content = [];
  let stop = null;
  const indexes = [];
  for (const raw of sseText.split('\n\n').filter((x) => x.trim())) {
    const d = JSON.parse(raw.split('\n').find((l) => l.startsWith('data:')).slice(5));
    if (d.type === 'content_block_start') {
      indexes.push(d.index);
      content[d.index] = { ...d.content_block };
    } else if (d.type === 'content_block_delta') {
      const b = content[d.index];
      if (d.delta.type === 'text_delta') b.text += d.delta.text;
      if (d.delta.type === 'thinking_delta') b.thinking += d.delta.thinking;
      if (d.delta.type === 'signature_delta') b.signature = d.delta.signature;
    } else if (d.type === 'message_delta') stop = d.delta.stop_reason;
  }
  return { content, stop, indexes, starts: (sseText.match(/event: message_start/g) || []).length, stops: (sseText.match(/event: message_stop/g) || []).length };
}

test('retrieval (streaming): follow-up blocks are stitched into the same message with renumbered indexes', async () => {
  await withProxy(SCRIPT, async (port, seen) => {
    const res = await post(port, conversation(true));
    const out = rebuild(await res.text());
    checkUpstream(seen);
    assert.deepStrictEqual(out.indexes, [0, 1], 'contiguous indexes, retrieval call and late thinking hidden');
    assert.deepStrictEqual(out.content, [T1, ANSWER]);
    assert.strictEqual(out.stop, 'end_turn');
    assert.strictEqual(out.starts, 1);
    assert.strictEqual(out.stops, 1);
  });
});

test('retrieval: a call mixed with client tools is dropped, the client tools go through, no follow-up', async () => {
  const BASH = { type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'ls' } };
  const script = [{ content: [CALL, BASH], stop_reason: 'tool_use', usage: { input_tokens: 9, output_tokens: 9 } }];
  for (const stream of [false, true]) {
    await withProxy(script, async (port, seen) => {
      const res = await post(port, conversation(stream));
      const content = stream ? rebuild(await res.text()).content : (await res.json()).content;
      assert.strictEqual(seen.length, 1);
      assert.deepStrictEqual(content, [stream ? { ...BASH, input: {} } : BASH]);
    });
  }
});

test('retrieval: unknown ids and paging', () => {
  const store = new Map([[ID, BIG]]);
  assert.strictEqual(retrieve.answer({ id: 'nope' }, store).is_error, true);
  const whole = retrieve.answer({ id: ID }, store).content;
  assert.ok(whole.startsWith('[lines 1-400 of 400]\n'));
  assert.strictEqual(whole.slice(whole.indexOf('\n') + 1), BIG);
  const huge = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
  const page = retrieve.answer({ id: 'h' }, new Map([['h', huge]])).content;
  assert.match(page, /^\[lines 1-\d+ of 5000; call again with from_line=\d+ for more\]/);
  assert.ok(page.length < 31000);
});

test('retrieval notes: verified as lossy, and a wrong id or a note on lossless output fails', () => {
  const body = conversation(false);
  const opts = { mode: 'aggressive', keepRecent: 2, maxToolChars: 2000, retrieve: true };
  const out = compressRequest(body, 'anthropic', opts);
  assert.strictEqual(out.store.get(ID), BIG);
  const v = verifyRequest(body, out.body, opts);
  assert.ok(v.ok);
  assert.strictEqual(v.counts.lossy, 1);
  assert.deepStrictEqual(compressRequest(body, 'anthropic', opts).body, out.body, 'deterministic');

  const wrongId = JSON.parse(JSON.stringify(out.body));
  wrongId.messages[2].content[0].content = wrongId.messages[2].content[0].content.replace(ID, '0123456789ab');
  assert.strictEqual(verifyRequest(body, wrongId, opts).ok, false);

  const users = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ id: i, name: `user ${i}` })), null, 2);
  const lossless = JSON.parse(JSON.stringify(body));
  lossless.messages[2].content[0].content = users;
  const safe = compressRequest(lossless, 'anthropic', { ...opts, mode: 'safe' }).body;
  safe.messages[2].content[0].content += formats.retrieveNote(formats.retrieveId(users));
  assert.strictEqual(verifyRequest(lossless, safe, { ...opts, mode: 'safe' }).ok, false);

  assert.strictEqual(compressRequest(body, 'anthropic', { ...opts, retrieve: false }).body.messages[2].content[0].content.includes('tokentrim_retrieve'), false);
});

test('stale rewrites ask the API to drop mismatched thinking blocks; nothing else is touched', () => {
  const withThinking = { thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: [T1, { type: 'text', text: 'y' }] }] };
  const h = { 'anthropic-beta': 'foo-2026-01-01' };
  assert.strictEqual(retrieve.allowEditedHistory(withThinking, h), true);
  assert.deepStrictEqual(withThinking.thinking, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  assert.strictEqual(h['anthropic-beta'], 'foo-2026-01-01,thinking-binding-controls-2026-08-01');

  const omitted = { messages: withThinking.messages };
  assert.strictEqual(retrieve.allowEditedHistory(omitted, {}), true);
  assert.strictEqual(omitted.thinking.type, 'adaptive');

  const noThinking = { messages: [{ role: 'user', content: 'x' }] };
  assert.strictEqual(retrieve.allowEditedHistory(noThinking, {}), false);
  assert.strictEqual(noThinking.thinking, undefined);
  const between = { thinking: { type: 'between_tools' }, messages: withThinking.messages };
  assert.strictEqual(retrieve.allowEditedHistory(between, {}), false);
  const chosen = { thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'error' } }, messages: withThinking.messages };
  assert.strictEqual(retrieve.allowEditedHistory(chosen, {}), false);
});

test('proxy: a stale rewrite of a history with thinking blocks is sent with drop_block and the beta header', async () => {
  const up = scriptedUpstream([{ content: [ANSWER], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }]);
  const upPort = await listen(up.server);
  const { server } = createServer({ anthropicUpstream: `http://127.0.0.1:${upPort}`, mode: 'balanced', staleAfter: 2, staleStep: 1, staleChars: 500 });
  const port = await listen(server);
  try {
    const body = conversation(false);
    body.messages[3] = { role: 'assistant', content: [T1, { type: 'text', text: 'done' }] };
    await (await post(port, body)).json();
    const sent = up.seen[0];
    assert.ok(sent.body.messages[2].content[0].content.length < 1000, 'the old result was shortened');
    assert.deepStrictEqual(sent.body.thinking, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    assert.strictEqual(sent.headers['anthropic-beta'], 'thinking-binding-controls-2026-08-01');
    assert.ok(!sent.body.tools.some((t) => t.name === 'tokentrim_retrieve'), 'retrieval is opt-in');
  } finally {
    server.close();
    up.server.close();
  }
});

test('plain-text turns are never rewritten, so the history stays append-only', () => {
  const text = `please look at this   \n\n\n\n${'pasted log line with trailing spaces   \n'.repeat(20)}`;
  const body = {
    messages: [
      { role: 'user', content: text },
      { role: 'assistant', content: [{ type: 'text', text }] },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ],
  };
  for (const mode of ['safe', 'balanced', 'aggressive']) {
    const out = compressRequest(body, 'anthropic', { mode, keepRecent: 2 });
    assert.deepStrictEqual(out.body, body, mode);
  }
  const opted = compressRequest(body, 'anthropic', { mode: 'safe', keepRecent: 2, plainText: true });
  assert.notDeepStrictEqual(opted.body, body, 'opt-in plain-text cleanup still works');
});
