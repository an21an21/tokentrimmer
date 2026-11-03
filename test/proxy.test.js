'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createServer } = require('../src/proxy');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const users = Array.from({ length: 60 }, (_, i) => ({ id: i, name: `user${i}`, email: `u${i}@x.io`, bio: null }));

// Mock upstream: records the body it receives, "bills" 1 token per 4 chars, streams SSE when asked.
function mockUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push({ url: req.url, headers: req.headers, raw });
      const tokens = Math.ceil(raw.length / 4);
      if (JSON.parse(raw).stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":${tokens}}}}\n\n`);
        res.write('event: content_block_delta\ndata: {"delta":{"text":"hi"}}\n\n');
        res.end('event: message_stop\ndata: {}\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, usage: { input_tokens: tokens } }));
      }
    });
  });
  return { server, seen };
}

const request = (stream) => ({
  model: 'claude-sonnet-5-5',
  stream,
  messages: [
    { role: 'user', content: 'list users' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'users', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: JSON.stringify(users, null, 2) }] },
  ],
});

async function post(port, path, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01', ...headers },
    body: JSON.stringify(body),
  });
  return { res, text: await res.text() };
}

test('proxy compresses, forwards auth headers, and reports savings', async () => {
  const up = mockUpstream();
  const upPort = await listen(up.server);
  const { server, stats } = createServer({ anthropicUpstream: `http://127.0.0.1:${upPort}`, mode: 'balanced' });
  const port = await listen(server);

  const { res, text } = await post(port, '/v1/messages', request(false));
  assert.strictEqual(res.status, 200);
  assert.ok(JSON.parse(text).ok);
  assert.strictEqual(up.seen[0].headers['x-api-key'], 'k');
  const forwarded = JSON.parse(up.seen[0].raw);
  assert.ok(forwarded.messages[2].content[0].content.startsWith('[table '));
  assert.ok(stats.saved > 0);
  assert.ok(up.seen[0].raw.length < JSON.stringify(request(false)).length * 0.6);

  server.close();
  up.server.close();
});

test('dry run measures savings but forwards the original request', async () => {
  const up = mockUpstream();
  const upPort = await listen(up.server);
  const { server, stats } = createServer({ anthropicUpstream: `http://127.0.0.1:${upPort}`, dryRun: true });
  const port = await listen(server);

  const original = JSON.stringify(request(false));
  await post(port, '/v1/messages', request(false));
  assert.strictEqual(up.seen[0].raw, original);
  assert.ok(stats.saved > 0);
  assert.strictEqual(stats.recent[0].dry, true);

  server.close();
  up.server.close();
});

test('streaming responses pass through and billed input is captured', async () => {
  const up = mockUpstream();
  const upPort = await listen(up.server);
  const { server, stats } = createServer({ anthropicUpstream: `http://127.0.0.1:${upPort}` });
  const port = await listen(server);

  const { res, text } = await post(port, '/v1/messages', request(true));
  assert.strictEqual(res.headers.get('content-type'), 'text/event-stream');
  assert.ok(text.includes('message_stop'));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(stats.recent[0].reportedInput > 0);

  server.close();
  up.server.close();
});

test('per-request header overrides mode; x-tokentrimmer headers are not forwarded', async () => {
  const up = mockUpstream();
  const upPort = await listen(up.server);
  const { server } = createServer({ anthropicUpstream: `http://127.0.0.1:${upPort}`, mode: 'balanced' });
  const port = await listen(server);

  await post(port, '/v1/messages', request(false), { 'x-tokentrimmer-mode': 'safe' });
  assert.ok(!('x-tokentrimmer-mode' in up.seen[0].headers));

  server.close();
  up.server.close();
});

test('unreachable upstream returns a clear 502', async () => {
  const { server } = createServer({ anthropicUpstream: 'http://127.0.0.1:1' });
  const port = await listen(server);
  const { res, text } = await post(port, '/v1/messages', request(false));
  assert.strictEqual(res.status, 502);
  assert.ok(text.includes('could not reach upstream'));
  server.close();
});

test('dashboard, stats and /compress endpoints respond', async () => {
  const { server } = createServer({});
  const port = await listen(server);
  const dash = await fetch(`http://127.0.0.1:${port}/`);
  assert.ok((await dash.text()).includes('tokentrimmer'));
  const stats = await (await fetch(`http://127.0.0.1:${port}/stats`)).json();
  assert.strictEqual(stats.requests, 0);
  const { text } = await post(port, '/compress', { text: JSON.stringify(users, null, 2), mode: 'safe' });
  const out = JSON.parse(text);
  assert.ok(out.tokensAfter < out.tokensBefore);
  server.close();
});
