'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { compressText, estimateTokens } = require('../src/compress');
const { compressRequest } = require('../src/messages');
const { decodeJSONOutput, decodeLogTemplates, encCell, splitCells, parseCell } = require('../src/formats');

const users = Array.from({ length: 50 }, (_, i) => ({ id: i, name: `user${i}`, email: `u${i}@x.io`, bio: null, tags: [] }));

test('json: minify + tabularize is lossless in safe mode', () => {
  const input = JSON.stringify(users, null, 2);
  const r = compressText(input, { mode: 'safe' });
  assert.ok(r.text.length < input.length * 0.5, 'expected >50% smaller');
  assert.ok(r.text.startsWith('[table 50 rows] id,name,email,bio,tags'));
  assert.deepStrictEqual(decodeJSONOutput(r.text), users);
});

test('json: balanced mode drops null and empty fields', () => {
  const r = compressText(JSON.stringify({ a: 1, b: null, c: [], d: { e: '' } }, null, 2), { mode: 'balanced' });
  assert.strictEqual(r.text, '{"a":1}');
});

test('logs: balanced mode templates then collapses repeats, keeping first and last rows', () => {
  const lines = ['2026-01-01T10:00:00Z INFO start'];
  for (let i = 0; i < 100; i++) lines.push(`2026-01-01T10:00:${String(i % 60).padStart(2, '0')}Z WARN retry attempt ${i}`);
  lines.push('2026-01-01T10:05:00Z ERROR gave up');
  const r = compressText(lines.join('\n'), { mode: 'balanced' });
  assert.ok(r.techniques.includes('log-template') && r.techniques.includes('log-collapse'));
  assert.ok(r.text.includes('|0\n'));
  assert.ok(r.text.includes('|99\n'));
  assert.ok(r.text.includes('98 similar lines omitted'));
  assert.ok(r.text.includes('ERROR gave up'));
});

test('safe mode never collapses logs', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `2026-01-01T10:00:00Z WARN retry ${i}`).join('\n');
  const r = compressText(lines, { mode: 'safe' });
  assert.ok(!r.techniques.includes('log-collapse'));
});

test('whitespace and ANSI codes are stripped', () => {
  const r = compressText('\x1b[31mred\x1b[0m   \n\n\n\n\nnext   ', { mode: 'safe' });
  assert.strictEqual(r.text, 'red\n\nnext');
});

test('aggressive mode caps huge output, keeping head and tail', () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i} of the file`).join('\n');
  const r = compressText(big, { mode: 'aggressive', maxToolChars: 2000 });
  assert.ok(r.text.length < 2400);
  assert.ok(r.text.startsWith('line 0 of the file'));
  assert.ok(r.text.endsWith('line 4999 of the file'));
  assert.ok(r.text.includes('lines omitted from the middle'));
});

test('output is never longer than input', () => {
  const input = 'short text that cannot shrink';
  assert.strictEqual(compressText(input, { mode: 'aggressive' }).text, input);
});

test('invalid JSON that starts with a brace is left alone apart from whitespace', () => {
  const r = compressText('{not json at all}   ', { mode: 'safe' });
  assert.strictEqual(r.text, '{not json at all}');
});

test('anthropic request: tool results shrink, system and latest user turn untouched', () => {
  const body = {
    model: 'claude-sonnet-5-5',
    system: 'You are helpful.   \n\n\n\n',
    messages: [
      { role: 'user', content: 'list users' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'users', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: JSON.stringify(users, null, 2) }] },
      { role: 'assistant', content: 'Here they are.' },
      { role: 'user', content: 'thanks   \n\n\n\nmore please' },
    ],
  };
  const r = compressRequest(body, 'anthropic', { mode: 'balanced', keepRecent: 2 });
  assert.ok(r.changed);
  assert.ok(r.after < r.before * 0.6);
  assert.strictEqual(r.body.system, body.system);
  assert.strictEqual(r.body.messages[4].content, body.messages[4].content);
  assert.ok(r.body.messages[2].content[0].content.startsWith('[table '));
  assert.strictEqual(body.messages[2].content[0].content.startsWith('[table '), false, 'input must not be mutated');
});

test('identical tool results are deduplicated', () => {
  const file = 'export function thing() { return 1 }\n'.repeat(40);
  const mk = (id) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: file }] });
  const body = { messages: [mk('a'), { role: 'assistant', content: 'ok' }, mk('b'), { role: 'assistant', content: 'ok' }, { role: 'user', content: 'go' }] };
  const r = compressRequest(body, 'anthropic', { mode: 'safe', keepRecent: 2 });
  assert.ok(r.techniques['dedupe-identical']);
  assert.ok(r.body.messages[2].content[0].content.startsWith('[same as a tool result in message'));
});

test('openai request: tool messages shrink', () => {
  const body = {
    messages: [
      { role: 'user', content: 'x' },
      { role: 'tool', tool_call_id: 'c1', content: JSON.stringify(users, null, 2) },
      { role: 'user', content: 'y' },
    ],
  };
  const r = compressRequest(body, 'openai', { mode: 'balanced' });
  assert.ok(r.changed && r.after < r.before);
});

test('estimateTokens is monotonic and nonzero for text', () => {
  assert.ok(estimateTokens('hello world') > 0);
  assert.ok(estimateTokens('a'.repeat(400)) > estimateTokens('a'.repeat(40)));
});

test('regression: balanced keeps tables and saves at least as much as safe on JSON', () => {
  const input = JSON.stringify(
    Array.from({ length: 80 }, (_, i) => ({ id: i, name: `n${i}`, phone: i % 3 ? null : '123', notes: '', addr: { line2: null, city: 'Pune' } })),
    null,
    2,
  );
  const safe = compressText(input, { mode: 'safe' });
  const balanced = compressText(input, { mode: 'balanced' });
  assert.ok(balanced.text.startsWith('[table '));
  assert.ok(balanced.text.length <= safe.text.length);
  assert.ok(!balanced.text.includes('notes'), 'all-empty column should be dropped');
});

test('regression: aggressive never wipes out single-line JSON, it keeps leading rows', () => {
  const rows = Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `user number ${i}`, email: `user${i}@example.com` }));
  const r = compressText(JSON.stringify(rows), { mode: 'aggressive', maxToolChars: 3000 });
  const kept = decodeJSONOutput(r.text.split('\n[... ')[0]);
  assert.ok(kept.length > 10 && kept.length < 2000);
  assert.ok(/\[\.\.\. \d+ more rows omitted\]$/.test(r.text));
  assert.deepStrictEqual(kept[0], rows[0]);
  assert.deepStrictEqual(kept, rows.slice(0, kept.length));
});

test('regression: single very long text line is cut by characters, not erased', () => {
  const r = compressText('x'.repeat(50000), { mode: 'aggressive', maxToolChars: 2000 });
  assert.ok(r.text.length > 1500 && r.text.length < 2300);
  assert.ok(r.text.includes('characters omitted'));
});

test('mixed-shape arrays group by shape and decode back to the exact original', () => {
  const events = Array.from({ length: 60 }, (_, i) =>
    i % 3 === 0 ? { type: 'click', x: i, y: i * 2, target: { id: `b${i}`, tag: 'button' } }
    : i % 3 === 1 ? { type: 'api', url: `/v1/${i}`, status: 200, headers: { a: `r${i}`, ct: 'json' } }
    : { type: 'nav', from: `/p/${i}`, to: `/p/${i + 1}`, referrer: null });
  const input = JSON.stringify(events, null, 2);
  const r = compressText(input, { mode: 'safe' });
  assert.ok(r.text.startsWith('[group 0:') && /\n\[order 60\] cycle\(0,1,2\)$/.test(r.text));
  assert.ok(r.text.length < input.length * 0.5);
  assert.deepStrictEqual(decodeJSONOutput(r.text), events);
});

test('nested uniform objects flatten into dotted columns and decode back exactly', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: i, addr: { city: `c${i}`, zip: `${i}00`, geo: { lat: i, lng: 100 - i } } }));
  const r = compressText(JSON.stringify(rows), { mode: 'safe' });
  assert.ok(r.text.startsWith('[table 20 rows nested] id,addr.city,addr.zip,addr.geo.lat,addr.geo.lng'));
  assert.deepStrictEqual(decodeJSONOutput(r.text), rows);
});

test('keys that already contain dots are never flattened', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ 'a.b': i, n: { x: i } }));
  const r = compressText(JSON.stringify(rows), { mode: 'safe' });
  assert.ok(r.text.startsWith('[table 5 rows] a.b,n'), 'no "nested" marker, dots are literal');
  assert.deepStrictEqual(decodeJSONOutput(r.text), rows);
});

test('grep output groups by directory and can be rebuilt exactly', () => {
  const lines = Array.from({ length: 80 }, (_, i) => `src/components/ui/Widget${i % 7}.tsx:${i + 1}:  const x = ${i}; // hit`);
  lines.push('lib/util.js:5:module.exports = 1');
  const input = lines.join('\n');
  const r = compressText(input, { mode: 'safe' });
  assert.ok(r.techniques.includes('grep-group'));
  assert.ok(r.text.length < input.length * 0.85);
  let dir = '';
  const rebuilt = r.text.split('\n').map((l) => (l.startsWith('@ ') ? ((dir = l.slice(2)), null) : dir + l)).filter((l) => l !== null);
  assert.deepStrictEqual(rebuilt, lines);
});

test('tool exclusion: Read results are untouched, other tools are compressed', () => {
  const fileText = Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};   `).join('\n') + '\n\n\n\n\nend';
  const json = JSON.stringify(users, null, 2);
  const mk = (id, name, content) => [
    { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  ];
  const body = { messages: [{ role: 'user', content: 'go' }, ...mk('a', 'Read', fileText), ...mk('b', 'run_query', json), { role: 'user', content: 'done' }] };
  const r = compressRequest(body, 'anthropic', { mode: 'balanced', keepRecent: 2 });
  assert.strictEqual(r.body.messages[2].content[0].content, fileText, 'Read output must be byte-identical');
  assert.ok(r.body.messages[4].content[0].content.startsWith('[table '));
});

test('tool exclusion: an identical repeated Read is still deduplicated', () => {
  const file = Array.from({ length: 40 }, (_, i) => `line ${i} of the source file`).join('\n');
  const mk = (id) => [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: file }] },
  ];
  const body = { messages: [{ role: 'user', content: 'go' }, ...mk('a'), ...mk('b'), { role: 'user', content: 'done' }] };
  const r = compressRequest(body, 'anthropic', { mode: 'safe', keepRecent: 2 });
  assert.strictEqual(r.body.messages[2].content[0].content, file);
  assert.ok(r.body.messages[4].content[0].content.startsWith('[same as a tool result in message'));
});

test('tool exclusion works for MCP-prefixed names and for OpenAI tool calls', () => {
  const file = Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};   `).join('\n') + '\n\n\n\n\nend';
  const body = {
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'mcp__fs__read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: file },
      { role: 'user', content: 'done' },
    ],
  };
  const r = compressRequest(body, 'openai', { mode: 'balanced' });
  assert.strictEqual(r.body.messages[2].content, file);
});

test('regression: a rewrite that is shorter is kept even if the symbol mix changes', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `src/components/Widget${i % 40}.tsx:${10 + (i % 90)}:  return <b onClick={() => set(!open)}>{p.label}</b>;`);
  const body = {
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'run_query', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: lines.join('\n') }] },
      { role: 'user', content: 'done' },
    ],
  };
  const r = compressRequest(body, 'anthropic', { mode: 'safe' });
  assert.ok(r.changed && r.techniques['grep-group']);
  assert.ok(r.after <= r.before);
});

test('estimateTokens never rises when text gets shorter by removing path prefixes', () => {
  const a = Array.from({ length: 100 }, (_, i) => `src/components/ui/W${i}.tsx:${i}:  x();`).join('\n');
  const b = Array.from({ length: 100 }, (_, i) => `W${i}.tsx:${i}:  x();`).join('\n');
  assert.ok(estimateTokens(b) <= estimateTokens(a));
});

test('safe-mode log templating is lossless: decoding gives back the exact original', () => {
  const lines = [];
  for (let i = 0; i < 120; i++) lines.push(`2026-10-31T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.${100 + i}Z WARN  db pool: connection ${i} (id 0x${(i * 977).toString(16)}) timed out`);
  lines.push('2026-10-31T10:07:00Z ERROR request failed: ECONNREFUSED 10.0.0.5:5432');
  for (let i = 0; i < 30; i++) lines.push(`    at Object.query (/app/node_modules/pg/lib/client.js:${100 + i}:11)`);
  lines.push('plain line with no numbers');
  const input = lines.join('\n');
  const r = compressText(input, { mode: 'safe' });
  assert.deepStrictEqual(r.techniques, ['log-template']);
  assert.ok(r.text.length < input.length * 0.6);
  assert.strictEqual(decodeLogTemplates(r.text), input);
});

test('log templating is skipped when the text already uses its marker characters', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `2026-10-31T10:00:${String(i).padStart(2, '0')}Z INFO 100% done %% step ${i}`);
  assert.ok(!compressText(lines.join('\n'), { mode: 'safe' }).techniques.includes('log-template'));
});

test('csv cells: tricky strings and types survive a round trip', () => {
  const tricky = [
    '', ' padded ', 'a,b', 'say "hi"', 'line1\nline2', '123', '-4.5e3', 'true', 'null', '[x]', '{y}', '"quoted"',
    'plain', 'café ☕', 'back\\slash', 'a{b', '1.2.3', 'x|y', '~1|z',
  ];
  const rows = tricky.map((t, i) => ({ id: i, s: t, n: i % 2 ? null : i * 1.5, b: i % 3 === 0, arr: [i, `s,${i}`], obj: { k: t } }));
  const r = compressText(JSON.stringify(rows), { mode: 'safe' });
  assert.ok(r.text.startsWith('[table '));
  assert.deepStrictEqual(decodeJSONOutput(r.text), rows);
});

test('csv cells: splitCells and parseCell agree with encCell for every value kind', () => {
  const values = [null, true, false, 0, -7, 3.25, 'x', '', 'a,b', '12', [1, 'two', { three: [3] }], { a: 'b,c', d: null }];
  const line = values.map(encCell).join(',');
  assert.deepStrictEqual(splitCells(line).map(parseCell), values);
});

test('group order encodings round trip: cycle, runs, and irregular sequences', () => {
  const mk = (order) => Array.from({ length: 60 }, (_, i) => {
    const t = order[i % order.length];
    return t === 0 ? { a: i, b: 'x' } : t === 1 ? { c: i } : { d: `v${i}`, e: null };
  });
  const seqs = [
    [0, 1, 2], [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2],
    [0, 1, 1, 2, 0, 2, 1, 0, 0, 2, 1, 2, 1, 1, 0],
  ];
  for (const seq of seqs) {
    const rows = mk(seq);
    const r = compressText(JSON.stringify(rows), { mode: 'safe' });
    if (r.text.startsWith('[group ')) assert.deepStrictEqual(decodeJSONOutput(r.text), rows);
    else assert.deepStrictEqual(JSON.parse(r.text), rows);
  }
});

test('aggressive cap on grouped tables keeps a valid prefix and reports the omission', () => {
  const rows = Array.from({ length: 900 }, (_, i) => (i % 2 ? { kind: 'a', v: i, note: `n${i}` } : { kind: 'b', w: i, extra: `e${i}` }));
  const r = compressText(JSON.stringify(rows), { mode: 'aggressive', maxToolChars: 4000 });
  assert.ok(r.techniques.includes('cap-large-output'));
  assert.ok(/\[\.\.\. \d+ more items omitted\]$/.test(r.text));
  const kept = decodeJSONOutput(r.text.split('\n[... ')[0]);
  assert.deepStrictEqual(kept, rows.slice(0, kept.length));
});
