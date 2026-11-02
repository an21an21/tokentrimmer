'use strict';
// Benchmark on synthetic but realistic agent payloads. Numbers are estimates (chars/token heuristic).
const { compressText, estimateTokens } = require('./src/compress');
const { compressRequest } = require('./src/messages');

// Deterministic pseudo-random so results are reproducible.
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const apiList = JSON.stringify(
  Array.from({ length: 150 }, (_, i) => ({
    id: i + 1000,
    name: `Customer ${i}`,
    email: `customer${i}@example.com`,
    status: pick(['active', 'trial', 'churned']),
    phone: rnd() > 0.6 ? `+91-98${Math.floor(rnd() * 1e8)}` : null,
    notes: '',
    tags: [],
    address: { line2: null, city: pick(['Pune', 'Mumbai', 'Delhi']), country: 'IN' },
  })),
  null,
  2,
);

const logs = [
  ...Array.from({ length: 400 }, (_, i) => `2026-10-31T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z WARN  db pool: connection ${i} timed out, retrying`),
  '2026-10-31T10:07:00Z ERROR  request failed: ECONNREFUSED 10.0.0.5:5432',
  ...Array.from({ length: 60 }, (_, i) => `    at Object.query (/app/node_modules/pg/lib/client.js:${100 + i}:11)`),
].join('\n');

const codeFile = Array.from({ length: 900 }, (_, i) => `export const handler${i} = (req) => {   \n  return process(req, ${i});\n};\n\n\n`).join('');

const prose = 'Please note that it is important to remember that the quick brown fox jumps.   \n\n\n\n'.repeat(60);

const cases = [
  ['JSON API response (150 records)', apiList],
  ['Server log with retry storm', logs],
  ['Large source file read', codeFile],
  ['Verbose prose with blank lines', prose],
];

const pct = (b, a) => (b ? ((1 - a / b) * 100).toFixed(1) + '%' : '0%');
const pad = (s, n) => String(s).padEnd(n);

for (const mode of ['safe', 'balanced', 'aggressive']) {
  console.log(`\nMode: ${mode}`);
  console.log(pad('Payload', 36), pad('Before', 9), pad('After', 9), 'Saved');
  let tb = 0, ta = 0;
  for (const [name, text] of cases) {
    const r = compressText(text, { mode, maxToolChars: 12000 });
    const b = estimateTokens(text), a = estimateTokens(r.text);
    tb += b; ta += a;
    console.log(pad(name, 36), pad(b, 9), pad(a, 9), pct(b, a));
  }
  console.log(pad('TOTAL', 36), pad(tb, 9), pad(ta, 9), pct(tb, ta));
}

// A whole agent conversation: the same file is read twice, plus a JSON lookup and a log tail.
const result = (id, content) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] });
const call = (id) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'tool', input: {} }] });
const convo = {
  model: 'claude-sonnet-5-5',
  system: 'You are a coding agent.',
  messages: [
    { role: 'user', content: 'Investigate the failing checkout flow.' },
    call('a'), result('a', codeFile),
    call('b'), result('b', apiList),
    call('c'), result('c', logs),
    call('d'), result('d', codeFile),
    { role: 'assistant', content: 'I have what I need.' },
    { role: 'user', content: 'Summarize the root cause.' },
  ],
};
console.log('\nWhole conversation (5 tool results, one file read twice)');
for (const mode of ['safe', 'balanced', 'aggressive']) {
  const r = compressRequest(convo, 'anthropic', { mode, keepRecent: 2, maxToolChars: 12000 });
  console.log(pad(mode, 12), pad(r.before, 8), '->', pad(r.after, 8), pct(r.before, r.after), Object.keys(r.techniques).join(', '));
}
