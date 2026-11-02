'use strict';
// Runs tokentrim over compare/real/out/cases.json in several configurations.
// Per case and configuration it records the compressed final request, wall time, determinism (two
// runs, byte-identical?), the verifier's verdict, and a cache replay: the session is re-sent request
// by request (one request per user message) and each request is priced as prompt caching bills it,
// 0.1x for the prefix shared with the previous request and 1.25x for the rest (cache write).
// Replay sizes are in characters. Writes compare/real/out/tokentrim.json.
//   node compare/real/run_tokentrim.js
const fs = require('node:fs');
const path = require('node:path');
const { compressRequest } = require('../../src/messages');
const { verifyRequest } = require('../../src/verify');

const OUT = path.join(__dirname, 'out');
const cases = JSON.parse(fs.readFileSync(path.join(OUT, 'cases.json'), 'utf8'));
const CONFIGS = {
  safe: { mode: 'safe' },
  balanced: { mode: 'balanced' },
  aggressive: { mode: 'aggressive' },
  'balanced+stale10': { mode: 'balanced', staleAfter: 10 },
};

function commonPrefix(a, b) {
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

// compress: messages -> messages sent upstream (identity for the uncompressed baseline).
function replay(messages, compress) {
  let prev = '';
  let sent = 0;
  let cost = 0;
  let requests = 0;
  for (let t = 1; t <= messages.length; t++) {
    if (messages[t - 1].role !== 'user') continue;
    const s = JSON.stringify(compress(messages.slice(0, t)));
    const cached = commonPrefix(prev, s);
    sent += s.length;
    cost += 0.1 * cached + 1.25 * (s.length - cached);
    requests++;
    prev = s;
  }
  return { requests, sent, cost: Math.round(cost) };
}

const result = cases.map((c) => {
  const body = { model: 'claude-sonnet-5-5', messages: c.original };
  const row = { name: c.name, baselineReplay: replay(c.original, (m) => m), modes: {} };
  for (const [name, cfg] of Object.entries(CONFIGS)) {
    const opts = { keepRecent: 2, maxToolChars: 12000, ...cfg };
    const t0 = process.hrtime.bigint();
    const r = compressRequest(body, 'anthropic', opts);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const again = compressRequest(body, 'anthropic', opts);
    const v = verifyRequest(body, r.body, opts);
    row.modes[name] = {
      messages: r.body.messages,
      ms: Math.round(ms * 10) / 10,
      deterministic: JSON.stringify(r.body) === JSON.stringify(again.body),
      verify: v.counts,
      techniques: r.techniques,
      replay: replay(c.original, (m) => compressRequest({ messages: m }, 'anthropic', opts).body.messages),
    };
  }
  console.log('done', c.name);
  return row;
});

fs.writeFileSync(path.join(OUT, 'tokentrim.json'), JSON.stringify(result));
