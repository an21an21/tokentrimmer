'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createServer, VERSION } = require('../src/proxy');
const { createHistory, read } = require('../src/history');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tokentrimmer-test-'));
const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, TOKENTRIMMER_HOME: tmp(), ...env } });

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

function upstream() {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1 } }));
    });
  });
}

function repeatedBody() {
  const lines = ['### Result'];
  for (let i = 0; i < 5; i++) lines.push('- generic [ref=e4]:', '  - generic [ref=e12]: container for the fare selection panel <b>x</b>', `  - button "fare ${i}"`);
  return {
    model: 'm', max_tokens: 5, messages: [
      { role: 'user', content: 'find' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'browser_find', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: lines.join('\n') }] },
    ],
  };
}

const post = (port, body) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body),
});

test('cli: --help, --version and bad input', () => {
  const help = run(['--help']);
  assert.strictEqual(help.status, 0);
  assert.match(help.stdout, /tokentrimmer \[options\] claude \[args\]/);
  assert.strictEqual(run(['--version']).stdout.trim(), VERSION);
  for (const bad of [['--mode', 'nope'], ['--port', 'x'], ['bogus'], ['--frobnicate']]) {
    const r = run(bad);
    assert.strictEqual(r.status, 2, bad.join(' '));
    assert.match(r.stderr, /tokentrimmer: /);
  }
});

test('cli: savings with no history, and stop with nothing running', () => {
  const s = run(['savings']);
  assert.strictEqual(s.status, 0);
  assert.match(s.stdout, /No savings recorded yet/);
  const st = run(['--port', '1', 'stop']);
  assert.strictEqual(st.status, 0);
  assert.match(st.stdout, /no proxy running/);
});

test('history: two writers add up, and only counts are stored', () => {
  const file = path.join(tmp(), 'stats.json');
  const a = createHistory(file);
  const b = createHistory(file);
  a.record({ before: 100, after: 60, saved: 40, techniques: { 'dedupe-block': 2 } });
  b.record({ before: 50, after: 50, saved: 0, techniques: {} });
  a.flush();
  b.flush();
  a.record({ before: 10, after: 5, saved: 5, techniques: { 'dedupe-block': 1 } });
  a.flush();
  const d = read(file);
  assert.strictEqual(d.requests, 3);
  assert.strictEqual(d.saved, 45);
  assert.strictEqual(d.before, 160);
  assert.strictEqual(d.techniques['dedupe-block'], 3);
  assert.strictEqual(Object.values(d.days)[0].requests, 3);
  assert.ok(!/fare|generic/.test(fs.readFileSync(file, 'utf8')));
});

test('proxy: /health, lifetime stats, and the before/after view', async () => {
  const up = upstream();
  const upPort = await listen(up);
  const file = path.join(tmp(), 'stats.json');
  const { server, history } = createServer({ anthropicUpstream: `http://127.0.0.1:${upPort}`, historyFile: file });
  const port = await listen(server);
  try {
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.deepStrictEqual([h.ok, h.name, h.version, h.mode], [true, 'tokentrimmer', VERSION, 'safe']);
    await post(port, repeatedBody());
    const s = await (await fetch(`http://127.0.0.1:${port}/stats`)).json();
    assert.strictEqual(s.lifetime.requests, 1);
    const e = s.recent[0];
    assert.strictEqual(e.inspect, true);
    const v = await (await fetch(`http://127.0.0.1:${port}/inspect?id=${e.id}`)).json();
    assert.strictEqual(v.fields.length, 1);
    assert.match(v.fields[0].path, /^messages\[2\]\.content\[0\]\.content$/);
    assert.match(v.fields[0].after, /\[same as lines \d+-\d+ above\]/);
    assert.ok(v.fields[0].before.includes('<b>x</b>'), 'raw text is returned; the dashboard escapes it');
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/inspect?id=999`)).status, 404);
    history.flush();
    assert.strictEqual(read(file).requests, 1);
  } finally {
    server.close();
    up.close();
  }
});

test('proxy: only the last 10 rewritten requests are kept; inspection and history can be off', async () => {
  const up = upstream();
  const upPort = await listen(up);
  const { server, stats, history } = createServer({ anthropicUpstream: `http://127.0.0.1:${upPort}` });
  const port = await listen(server);
  const off = createServer({ anthropicUpstream: `http://127.0.0.1:${upPort}`, inspect: false });
  const offPort = await listen(off.server);
  try {
    assert.strictEqual(history, null, 'no history file unless one is given');
    for (let i = 0; i < 12; i++) await post(port, repeatedBody());
    assert.strictEqual(stats.recent.filter((e) => e.inspect).length, 10);
    const oldest = stats.recent[stats.recent.length - 1];
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/inspect?id=${oldest.id}`)).status, 404);
    await post(offPort, repeatedBody());
    assert.strictEqual(off.stats.recent[0].inspect, false);
    assert.strictEqual((await fetch(`http://127.0.0.1:${offPort}/inspect?id=1`)).status, 403);
  } finally {
    server.close();
    off.server.close();
    up.close();
  }
});

function recorder() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ usage: { input_tokens: 7 } }));
    });
  });
  return { server, seen };
}

function codexBody() {
  const lines = ['### Result'];
  for (let i = 0; i < 5; i++) lines.push('- generic [ref=e4]:', '  - generic [ref=e12]: container for the fare selection panel', `  - button "fare ${i}"`);
  return {
    model: 'gpt-x', instructions: 'You are Codex.', store: false, stream: false,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'find' }] },
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAAopaque' },
      { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'find' },
      { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: lines.join('\n') }] },
    ],
  };
}

test('proxy: Codex /v1/responses is compressed; a ChatGPT login is routed to the ChatGPT backend without /v1', async () => {
  const chat = recorder();
  const api = recorder();
  const { server, stats } = createServer({
    openaiUpstream: `http://127.0.0.1:${await listen(api.server)}`,
    chatgptUpstream: `http://127.0.0.1:${await listen(chat.server)}/backend-api/codex`,
  });
  const port = await listen(server);
  const send = (pathname, headers, body) => fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer t', ...headers }, body: body && JSON.stringify(body),
  });
  try {
    const body = codexBody();
    assert.strictEqual((await send('/v1/responses', { 'chatgpt-account-id': 'acct' }, body)).status, 200);
    await send('/v1/models?client_version=1', { 'chatgpt-account-id': 'acct' });
    await send('/v1/responses', {}, body);
    assert.deepStrictEqual(chat.seen.map((s) => s.url), ['/backend-api/codex/responses', '/backend-api/codex/models?client_version=1']);
    assert.deepStrictEqual(api.seen.map((s) => s.url), ['/v1/responses']);
    assert.strictEqual(chat.seen[0].headers['chatgpt-account-id'], 'acct');
    for (const sent of [JSON.parse(chat.seen[0].body), JSON.parse(api.seen[0].body)]) {
      assert.match(sent.input[3].output[0].text, /\[same as lines \d+-\d+ above\]/);
      assert.deepStrictEqual(sent.input.slice(0, 3), body.input.slice(0, 3), 'messages and reasoning items untouched');
      assert.strictEqual(sent.instructions, body.instructions);
    }
    assert.strictEqual(stats.recent[0].check, 'lossless');
    assert.strictEqual(stats.recent[0].reportedInput, 7);
    const v = await (await fetch(`http://127.0.0.1:${port}/inspect?id=${stats.recent[0].id}`)).json();
    assert.strictEqual(v.fields[0].path, 'input[3].output[0].text');
  } finally {
    server.close();
    chat.server.close();
    api.server.close();
  }
});

test('cli: codex runs through a provider pointing at the proxy, with per-session headers', () => {
  const { codexArgs } = require('../src/cli');
  const plain = codexArgs('http://127.0.0.1:9', {}, ['exec', 'hi']);
  assert.deepStrictEqual(plain, [
    '-c', 'model_providers.tokentrimmer={name="TokenTrimmer",base_url="http://127.0.0.1:9/v1",wire_api="responses",requires_openai_auth=true}',
    '-c', 'model_provider="tokentrimmer"', 'exec', 'hi',
  ]);
  const withHeaders = codexArgs('http://127.0.0.1:9', { 'x-tokentrimmer-mode': 'aggressive' }, []);
  assert.match(withHeaders[1], /http_headers=\{"x-tokentrimmer-mode"="aggressive"\}\}$/);
});
