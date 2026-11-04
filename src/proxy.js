#!/usr/bin/env node
'use strict';
// tokentrimmer: a local proxy between your app and the Anthropic / OpenAI APIs (and ChatGPT's Codex backend).
// Point your SDK's base URL at http://localhost:8787 and requests are compressed in flight.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { compressText, estimateTokens, MODES } = require('./compress');
const { compressRequest } = require('./messages');
const { verifyRequest } = require('./verify');
const retrieve = require('./retrieve');
const { createHistory } = require('./history');

const VERSION = require('../package.json').version;
const INSPECT_KEEP = 10; // rewritten requests kept in memory for the dashboard's before/after view

// Every string that differs between two bodies of the same shape, with its JSON path.
function changedStrings(a, b, p, out) {
  if (typeof a === 'string' && typeof b === 'string') {
    if (a !== b) out.push({ path: p, before: a, after: b });
  } else if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) changedStrings(a[i], b[i], `${p}[${i}]`, out);
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of Object.keys(a)) if (k in b) changedStrings(a[k], b[k], p ? `${p}.${k}` : k, out);
  }
  return out;
}

function createServer(config = {}) {
  const cfg = {
    anthropicUpstream: config.anthropicUpstream || process.env.ANTHROPIC_UPSTREAM || 'https://api.anthropic.com',
    openaiUpstream: config.openaiUpstream || process.env.OPENAI_UPSTREAM || 'https://api.openai.com',
    // Codex signed in with ChatGPT: its /v1/... requests (marked by a chatgpt-account-id header) go here.
    chatgptUpstream: config.chatgptUpstream || process.env.CHATGPT_UPSTREAM || 'https://chatgpt.com/backend-api/codex',
    mode: config.mode || process.env.TOKENTRIMMER_MODE || 'safe',
    dryRun: config.dryRun ?? process.env.DRY_RUN === '1',
    keepRecent: config.keepRecent ?? 2,
    maxToolChars: config.maxToolChars ?? 12000,
    excludeTools:
      config.excludeTools ||
      (process.env.TOKENTRIMMER_EXCLUDE_TOOLS ? process.env.TOKENTRIMMER_EXCLUDE_TOOLS.split(',').map((x) => x.trim()) : undefined),
    // Check every rewritten request by decoding it. On any mismatch the original is sent instead.
    verify: config.verify ?? process.env.TOKENTRIMMER_VERIFY !== '0',
    // Opt-in: compress tool results older than ~staleAfter messages harder (never in safe mode).
    staleAfter: config.staleAfter ?? (Number(process.env.TOKENTRIMMER_STALE_AFTER) || 0),
    staleChars: config.staleChars ?? (Number(process.env.TOKENTRIMMER_STALE_CHARS) || undefined),
    staleStep: config.staleStep ?? (Number(process.env.TOKENTRIMMER_STALE_STEP) || undefined),
    // Opt-in: shortened tool results get a note, and the proxy answers the model's tokentrimmer_retrieve
    // calls itself (Anthropic /v1/messages only).
    retrieve: config.retrieve ?? process.env.TOKENTRIMMER_RETRIEVE === '1',
    compressRequest: config.compressRequest || compressRequest,
    // Lifetime savings file (counts only). Off unless given: the CLI passes ~/.tokentrimmer/stats.json.
    historyFile: config.historyFile || null,
    // Keep the last few rewritten requests in memory for the dashboard's before/after view.
    inspect: config.inspect ?? process.env.TOKENTRIMMER_INSPECT !== '0',
  };
  const history = cfg.historyFile ? createHistory(cfg.historyFile) : null;
  const inspected = new Map(); // entry id -> { original, sent }
  let nextId = 1;

  const stats = {
    startedAt: Date.now(),
    requests: 0,
    before: 0,
    after: 0,
    saved: 0,
    verifyFailed: 0,
    retrievals: 0,
    techniques: {},
    recent: [],
  };

  // Hidden retrieval exchanges, so replayed turns can be expanded back to what upstream saw.
  const memory = retrieve.createMemory();

  const dashboard = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function json(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  function pickFormat(req, pathname) {
    if (req.url.startsWith('/v1/messages')) return 'anthropic';
    if (req.url.startsWith('/v1/chat/completions')) return 'openai';
    if (pathname === '/v1/responses' && req.method === 'POST') return 'responses';
    return null;
  }

  function isAnthropicRequest(req) {
    return req.url.startsWith('/v1/messages') || 'x-api-key' in req.headers || 'anthropic-version' in req.headers;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(dashboard);
    }
    if (req.method === 'GET' && url.pathname === '/stats') {
      const { compressRequest: _fn, ...config } = cfg;
      return json(res, 200, { ...stats, version: VERSION, config, lifetime: history ? history.snapshot() : null });
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, name: 'tokentrimmer', version: VERSION, mode: cfg.mode, dryRun: cfg.dryRun });
    }
    if (req.method === 'GET' && url.pathname === '/inspect') {
      if (!cfg.inspect) return json(res, 403, { error: 'inspection is off (TOKENTRIMMER_INSPECT=0 or --no-inspect)' });
      const item = inspected.get(Number(url.searchParams.get('id')));
      if (!item) return json(res, 404, { error: 'not kept: only the last few rewritten requests are' });
      return json(res, 200, { fields: changedStrings(item.original, item.sent, '', []) });
    }

    // Library-style endpoint: POST {"text": "...", "mode": "balanced"}
    if (req.method === 'POST' && url.pathname === '/compress') {
      try {
        const { text, mode } = JSON.parse((await readBody(req)).toString('utf8'));
        const r = compressText(String(text ?? ''), { mode: MODES.includes(mode) ? mode : cfg.mode, maxToolChars: cfg.maxToolChars });
        return json(res, 200, {
          ...r,
          tokensBefore: estimateTokens(String(text ?? '')),
          tokensAfter: estimateTokens(r.text),
        });
      } catch {
        return json(res, 400, { error: 'Send JSON like {"text": "...", "mode": "balanced"}' });
      }
    }

    // Everything else is proxied.
    const anthropic = isAnthropicRequest(req);
    // Codex with a ChatGPT login talks to ChatGPT's backend, whose paths have no /v1 prefix.
    const chatgpt = !anthropic && 'chatgpt-account-id' in req.headers && url.pathname.startsWith('/v1/');
    const upstream = (anthropic ? cfg.anthropicUpstream : chatgpt ? cfg.chatgptUpstream : cfg.openaiUpstream).replace(/\/$/, '');
    const target = upstream + (chatgpt ? req.url.slice(3) : req.url);
    const format = pickFormat(req, url.pathname);
    const started = Date.now();
    let raw = await readBody(req);
    const entry = {
      id: nextId++,
      inspect: false,
      time: new Date().toISOString(),
      route: url.pathname,
      mode: cfg.mode,
      dry: false,
      before: 0,
      after: 0,
      saved: 0,
      techniques: [],
      check: '',
      status: 0,
      reportedInput: null,
      retrievals: 0,
      dropBlock: false,
      ms: 0,
    };

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (['host', 'content-length', 'accept-encoding', 'connection'].includes(k) || k.startsWith('x-tokentrimmer-')) continue;
      headers[k] = v;
    }
    // Set when this request may run the retrieval loop: { body, store }.
    let loop = null;

    if (format && raw.length) {
      try {
        const mode = MODES.includes(req.headers['x-tokentrimmer-mode']) ? req.headers['x-tokentrimmer-mode'] : cfg.mode;
        const dry = req.headers['x-tokentrimmer-dry-run'] ? req.headers['x-tokentrimmer-dry-run'] === '1' : cfg.dryRun;
        const body = JSON.parse(raw.toString('utf8'));
        if (cfg.retrieve && format === 'anthropic' && !dry) entry.expanded = retrieve.expand(body, memory);
        const original = cfg.inspect ? JSON.parse(JSON.stringify(body)) : null;
        const opts = {
          mode, keepRecent: cfg.keepRecent, maxToolChars: cfg.maxToolChars, excludeTools: cfg.excludeTools,
          staleAfter: cfg.staleAfter, staleChars: cfg.staleChars, staleStep: cfg.staleStep,
          retrieve: cfg.retrieve && format === 'anthropic',
        };
        let r = cfg.compressRequest(body, format, opts);
        if (r.changed && cfg.verify) {
          const v = verifyRequest(body, r.body, opts);
          if (v.ok) {
            entry.check = v.lossless ? 'lossless' : 'lossy fields';
          } else {
            // A decode check failed: never send a rewrite we cannot prove. Forward the original.
            entry.check = 'FAILED, original sent';
            stats.verifyFailed++;
            r = { body, before: r.before, after: r.before, techniques: {}, changed: false, store: new Map() };
          }
        }
        entry.mode = mode;
        entry.dry = dry;
        entry.before = r.before;
        entry.after = r.after;
        entry.saved = r.before - r.after;
        entry.techniques = Object.keys(r.techniques);
        let send = r.changed && !dry ? r.body : null;
        if (opts.retrieve && !dry && req.method === 'POST' && Array.isArray(body.messages)) {
          send = send || JSON.parse(JSON.stringify(body));
          retrieve.addTool(send);
          if (url.pathname === '/v1/messages') loop = { body: send, store: r.store || new Map() };
        }
        // Moving the stale cutoff rewrites old turns: let the API drop the thinking blocks that no
        // longer match instead of rejecting the request (accounts enforced on preserved thinking).
        if (send && r.changed && format === 'anthropic' && cfg.staleAfter && mode !== 'safe' && url.pathname === '/v1/messages') {
          entry.dropBlock = retrieve.allowEditedHistory(send, headers);
        }
        if (send) raw = Buffer.from(JSON.stringify(send));
        stats.requests++;
        stats.before += r.before;
        stats.after += r.after;
        stats.saved += entry.saved;
        for (const [t, n] of Object.entries(r.techniques)) stats.techniques[t] = (stats.techniques[t] || 0) + n;
        stats.recent.unshift(entry);
        stats.recent.length = Math.min(stats.recent.length, 50);
        if (history) history.record({ ...entry, techniques: r.techniques, verifyFailed: entry.check.startsWith('FAILED') });
        if (cfg.inspect && r.changed) {
          // In memory only, never written anywhere; what the dry run would have sent, too.
          const key = format === 'responses' ? 'input' : 'messages';
          inspected.set(entry.id, { original: { [key]: original[key] }, sent: { [key]: r.body[key] } });
          entry.inspect = true;
          for (const id of inspected.keys()) {
            if (inspected.size <= INSPECT_KEEP) break;
            inspected.delete(id);
            const old = stats.recent.find((e) => e.id === id);
            if (old) old.inspect = false;
          }
        }
      } catch {
        // Not JSON we understand: forward untouched.
      }
    }

    if (raw.length) headers['content-length'] = String(raw.length);

    let up;
    try {
      up = await fetch(target, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw,
      });
    } catch (err) {
      entry.status = 502;
      return json(res, 502, { error: `tokentrimmer could not reach upstream: ${err.message}` });
    }

    entry.status = up.status;
    const outHeaders = {};
    up.headers.forEach((v, k) => {
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) outHeaders[k] = v;
    });
    if (loop && up.ok) {
      const post = (b) => {
        const text = JSON.stringify(b);
        return fetch(target, { method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(text)) }, body: text });
      };
      const streaming = (up.headers.get('content-type') || '').includes('text/event-stream');
      let rounds = 0;
      if (streaming) {
        res.writeHead(up.status, outHeaders);
        rounds = await retrieve.stream(post, loop.body, loop.store, up, (s) => res.write(s), memory);
        res.end();
      } else {
        const out = await retrieve.complete(post, loop.body, loop.store, up, memory);
        rounds = out.rounds;
        res.writeHead(out.status, outHeaders);
        res.end(out.json ? JSON.stringify(out.json) : out.text);
        if (out.json && out.json.usage) entry.reportedInput = out.json.usage.input_tokens ?? null;
      }
      entry.retrievals = rounds || 0;
      stats.retrievals += entry.retrievals;
      if (history) history.addRetrievals(entry.retrievals);
      entry.ms = Date.now() - started;
      return;
    }

    res.writeHead(up.status, outHeaders);
    let tee = '';
    if (up.body) {
      for await (const chunk of up.body) {
        res.write(chunk);
        if (tee.length < 262144) tee += Buffer.from(chunk).toString('utf8');
      }
    }
    res.end();

    // The largest reported count: a Responses stream starts with zeros and reports usage at the end.
    const counts = [...tee.matchAll(/"(?:input|prompt)_tokens"\s*:\s*(\d+)/g)].map((x) => Number(x[1]));
    if (counts.length) entry.reportedInput = Math.max(...counts);
    entry.ms = Date.now() - started;
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: err.message });
      else res.end();
    });
  });
  return { server, stats, cfg, history };
}

const isLoopback = (host) => ['127.0.0.1', 'localhost', '::1'].includes(host) || host.startsWith('127.');

// Start a proxy (used by the CLI). opts: port, host, plus any createServer config. Resolves once listening.
function start(opts = {}) {
  const port = Number(opts.port ?? process.env.PORT ?? 8787);
  // Loopback only by default: the dashboard and /stats have no auth, and the proxy would relay for anyone.
  const host = opts.host || process.env.HOST || '127.0.0.1';
  // The before/after view shows request content: only on loopback unless asked for explicitly.
  const inspect = opts.inspect ?? (process.env.TOKENTRIMMER_INSPECT ? process.env.TOKENTRIMMER_INSPECT !== '0' : isLoopback(host));
  const { server, cfg, history } = createServer({ ...opts, inspect });
  const flush = () => history && history.flush();
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      flush();
      process.exit(0);
    });
  }
  process.once('exit', flush);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const shown = host.includes(':') ? `[${host}]` : host;
      const base = `http://${shown}:${port}`;
      console.log(`tokentrimmer ${VERSION} listening on ${base}  (mode: ${cfg.mode}${cfg.dryRun ? ', dry run' : ''})`);
      console.log(`Claude Code:    ANTHROPIC_BASE_URL=${base} claude   (or: tokentrimmer claude)`);
      console.log(`Anthropic SDK:  ANTHROPIC_BASE_URL=${base}`);
      console.log(`Codex:          tokentrimmer codex`);
      console.log(`OpenAI SDK:     OPENAI_BASE_URL=${base}/v1`);
      console.log(`Dashboard:      ${base}/`);
      if (!isLoopback(host)) console.log('Warning: listening beyond this machine. Anyone who can reach it can use your API key through it.');
      resolve({ server, cfg, history, port, host });
    });
  });
}

module.exports = { createServer, start, VERSION };

if (require.main === module) {
  start().catch((e) => {
    console.error(`tokentrimmer: ${e.message}`);
    process.exit(1);
  });
}
