#!/usr/bin/env node
'use strict';
// Stand-in Anthropic upstream for proxy benchmarks. Point a proxy's upstream here and it records the
// exact request bodies the proxy would send to the API.
//   mode "canned"  (default) answers every /v1/messages request with a short end_turn reply, JSON or SSE
//   mode "forward" passes requests through to https://api.anthropic.com unchanged (the caller's own auth
//                  headers go along; nothing is stored but the request body)
// Control endpoints (local only): GET /_captured?since=N, POST /_reset, POST /_mode {"mode":"forward"}.
//   node compare/real/capture_upstream.js [port]
const http = require('node:http');

const port = Number(process.argv[2] || 8790);
const API = 'https://api.anthropic.com';
let mode = 'canned';
let captured = [];

const read = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
});

function canned(res, body) {
  const msg = {
    id: `msg_capture_${captured.length}`, type: 'message', role: 'assistant', model: body.model || 'unknown',
    content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(msg));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { ...msg, content: [], stop_reason: null } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } });
  ev('content_block_stop', { index: 0 });
  ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  ev('message_stop', {});
  res.end();
}

async function forward(req, res, raw) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!['host', 'content-length', 'connection', 'accept-encoding'].includes(k)) headers[k] = v;
  }
  const up = await fetch(API + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw });
  const out = {};
  up.headers.forEach((v, k) => {
    if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) out[k] = v;
  });
  res.writeHead(up.status, out);
  if (up.body) for await (const chunk of up.body) res.write(chunk);
  res.end();
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/_captured') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(captured.slice(Number(url.searchParams.get('since') || 0))));
  }
  if (url.pathname === '/_reset') {
    captured = [];
    mode = 'canned';
    return res.end('{}');
  }
  if (url.pathname === '/_mode') {
    mode = JSON.parse((await read(req)).toString() || '{}').mode === 'forward' ? 'forward' : 'canned';
    return res.end(JSON.stringify({ mode }));
  }
  const raw = await read(req);
  let body = null;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    body = null;
  }
  const isMessages = req.method === 'POST' && url.pathname === '/v1/messages';
  if (isMessages) captured.push({ path: url.pathname, body });
  try {
    if (mode === 'forward') return await forward(req, res, raw);
    if (isMessages) return canned(res, body || {});
    if (url.pathname === '/v1/messages/count_tokens') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: Math.ceil(raw.length / 4) }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'capture upstream' } }));
  } catch (e) {
    if (!res.headersSent) res.writeHead(502);
    res.end(String(e.message));
  }
}).listen(port, '127.0.0.1', () => console.log(`capture upstream on http://127.0.0.1:${port}`));
