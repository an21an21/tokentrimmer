'use strict';
// Splits safe mode's savings by cache hit rate, per session in compare/real/out/cases.json.
// Each session is replayed request by request (one request per user message), as in
// run_tokentrimmer.js: the prefix shared with the previous request counts as a cache read (0.1x),
// the rest as a cache write (1.25x). Sizes are in characters, and the cache never expires.
//   node compare/real/cache_split.js
const fs = require('node:fs');
const path = require('node:path');
const { compressRequest } = require('../../src/messages');

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'cases.json'), 'utf8'));
const opts = { mode: 'safe', keepRecent: 2, maxToolChars: 12000 };

function commonPrefix(a, b) {
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function replay(messages, compress) {
  const r = { sent: 0, cached: 0, cost: 0, last: 0 };
  let prev = '';
  for (let t = 1; t <= messages.length; t++) {
    if (messages[t - 1].role !== 'user') continue;
    const s = JSON.stringify(compress(messages.slice(0, t)));
    const c = commonPrefix(prev, s);
    r.sent += s.length;
    r.cached += c;
    r.cost += 0.1 * c + 1.25 * (s.length - c);
    r.last = s.length;
    prev = s;
  }
  return r;
}

const pct = (a, b) => `${(100 * (1 - b / a)).toFixed(1)}%`;
const total = { base: { sent: 0, cached: 0, cost: 0, last: 0 }, safe: { sent: 0, cached: 0, cost: 0, last: 0 } };
console.log('| Session | Cache hit rate | Final request | All requests | Cost with caching |');
console.log('|---|---:|---:|---:|---:|');
cases.forEach((c, i) => {
  const base = replay(c.original, (m) => m);
  const safe = replay(c.original, (m) => compressRequest({ messages: m }, 'anthropic', opts).body.messages);
  for (const k of Object.keys(base)) {
    total.base[k] += base[k];
    total.safe[k] += safe[k];
  }
  const hit = `${Math.round((100 * base.cached) / base.sent)}%`;
  console.log(`| ${i + 1} | ${hit} | ${pct(base.last, safe.last)} | ${pct(base.sent, safe.sent)} | ${pct(base.cost, safe.cost)} |`);
});
const { base, safe } = total;
console.log(`| all | ${Math.round((100 * base.cached) / base.sent)}% | ${pct(base.last, safe.last)} | ${pct(base.sent, safe.sent)} | ${pct(base.cost, safe.cost)} |`);
