#!/usr/bin/env node
'use strict';
// tokentrim: a local proxy between your app and the Anthropic / OpenAI APIs.
// Point your SDK's base URL at http://localhost:8787 and requests are compressed in flight.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { compressText, estimateTokens, MODES } = require('./compress');
const { compressRequest } = require('./messages');
const { verifyRequest } = require('./verify');
const retrieve = require('./retrieve');

function createServer(config = {}) {
  const cfg = {
    anthropicUpstream: config.anthropicUpstream || process.env.ANTHROPIC_UPSTREAM || 'https://api.anthropic.com',
    openaiUpstream: config.openaiUpstream || process.env.OPENAI_UPSTREAM || 'https://api.openai.com',
    mode: config.mode || process.env.TOKENTRIM_MODE || 'balanced',
    dryRun: config.dryRun ?? process.env.DRY_RUN === '1',
    keepRecent: config.keepRecent ?? 2,
    maxToolChars: config.maxToolChars ?? 12000,
    excludeTools:
      config.excludeTools ||
      (process.env.TOKENTRIM_EXCLUDE_TOOLS ? process.env.TOKENTRIM_EXCLUDE_TOOLS.split(',').map((x) => x.trim()) : undefined),
    // Check every rewritten request by decoding it. On any mismatch the original is sent instead.
    verify: config.verify ?? process.env.TOKENTRIM_VERIFY !== '0',
    // Opt-in: compress tool results older than ~staleAfter messages harder (never in safe mode).
    staleAfter: config.staleAfter ?? (Number(process.env.TOKENTRIM_STALE_AFTER) || 0),
    staleChars: config.staleChars ?? (Number(process.env.TOKENTRIM_STALE_CHARS) || undefined),
    staleStep: config.staleStep ?? (Number(process.env.TOKENTRIM_STALE_STEP) || undefined),
    // Opt-in: shortened tool results get a note, and the proxy answers the model's tokentrim_retrieve
    // calls itself (Anthropic /v1/messages only).
    retrieve: config.retrieve ?? process.env.TOKENTRIM_RETRIEVE === '1',
    compressRequest: config.compressRequest || compressRequest,
  };

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

  function pickFormat(req) {
    if (req.url.startsWith('/v1/messages')) return 'anthropic';
    if (req.url.startsWith('/v1/chat/completions')) return 'openai';
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
      return json(res, 200, { ...stats, config: cfg });
    }
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });

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
    const upstream = (anthropic ? cfg.anthropicUpstream : cfg.openaiUpstream).replace(/\/$/, '');
    const format = pickFormat(req);
    const started = Date.now();
    let raw = await readBody(req);
    const entry = {
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
      if (['host', 'content-length', 'accept-encoding', 'connection'].includes(k) || k.startsWith('x-tokentrim-')) continue;
      headers[k] = v;
    }
    // Set when this request may run the retrieval loop: { body, store }.
    let loop = null;

    if (format && raw.length) {
      try {
        const mode = MODES.includes(req.headers['x-tokentrim-mode']) ? req.headers['x-tokentrim-mode'] : cfg.mode;
        const dry = req.headers['x-tokentrim-dry-run'] ? req.headers['x-tokentrim-dry-run'] === '1' : cfg.dryRun;
        const body = JSON.parse(raw.toString('utf8'));
        if (cfg.retrieve && format === 'anthropic' && !dry) entry.expanded = retrieve.expand(body, memory);
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
      } catch {
        // Not JSON we understand: forward untouched.
      }
    }

    if (raw.length) headers['content-length'] = String(raw.length);

    let up;
    try {
      up = await fetch(upstream + req.url, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw,
      });
    } catch (err) {
      entry.status = 502;
      return json(res, 502, { error: `tokentrim could not reach upstream: ${err.message}` });
    }

    entry.status = up.status;
    const outHeaders = {};
    up.headers.forEach((v, k) => {
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) outHeaders[k] = v;
    });
    if (loop && up.ok) {
      const post = (b) => {
        const text = JSON.stringify(b);
        return fetch(upstream + req.url, { method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(text)) }, body: text });
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

    const m = tee.match(/"input_tokens"\s*:\s*(\d+)/) || tee.match(/"prompt_tokens"\s*:\s*(\d+)/);
    if (m) entry.reportedInput = Number(m[1]);
    entry.ms = Date.now() - started;
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: err.message });
      else res.end();
    });
  });
  return { server, stats, cfg };
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  const { server, cfg } = createServer();
  server.listen(port, () => {
    console.log(`tokentrim listening on http://localhost:${port}  (mode: ${cfg.mode}${cfg.dryRun ? ', dry run' : ''})`);
    console.log('Anthropic SDK:  ANTHROPIC_BASE_URL=http://localhost:' + port);
    console.log('OpenAI SDK:     OPENAI_BASE_URL=http://localhost:' + port + '/v1');
    console.log('Dashboard:      http://localhost:' + port + '/');
  });
}
