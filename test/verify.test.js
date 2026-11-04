'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { compressRequest, toolTexts } = require('../src/messages');
const formats = require('../src/formats');
const { verifyRequest } = require('../src/verify');
const { createServer } = require('../src/proxy');
const payloads = require('../compare/payloads');

const toolBody = (content, name = 'run_query') => ({
  messages: [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content }] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'done' },
  ],
});

function check(text, mode = 'safe') {
  const body = toolBody(text);
  const opts = { mode, keepRecent: 2, maxToolChars: 12000 };
  const r = compressRequest(body, 'anthropic', opts);
  const v = verifyRequest(body, r.body, opts);
  assert.ok(v.ok, `verify failed for input ${JSON.stringify(text).slice(0, 300)}\n${JSON.stringify(v.fields.filter((f) => f.status === 'FAILED'))}`);
  return { r, v };
}

// ---- seeded randomness ----
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const pickFrom = (r, a) => a[Math.floor(r() * a.length)];

const NASTY = ['', ' ', 'a', 'a,b', '"', 'say "x"', 'line\nbreak', '\t', '123', '-0.5', '1e5', 'true', 'false', 'null', '[1,2]', '{"a":1}',
  'é', '☕', '\\', 'a\\b', 'x|y', '~1|z', '@ dir/', '[table 1 rows] x', '%%', '0x1F', '  trailing  ', '\u2028', '\r', '.5', '5.', '+5', 'NaN',
  'constructor', 'toString', '[lines]', '"quoted"', '{y}', 'a{b'];
const ALPHA = 'abcXYZ019 ,"\'[]{}:;|~%@.\\/-_';
function rndString(r) {
  if (r() < 0.6) return pickFrom(r, NASTY);
  let s = '';
  for (let i = 0, n = Math.floor(r() * 12); i < n; i++) s += ALPHA[Math.floor(r() * ALPHA.length)];
  return s;
}
function rndScalar(r) {
  const t = r();
  if (t < 0.12) return null;
  if (t < 0.22) return r() < 0.5;
  if (t < 0.45) return Math.floor((r() - 0.3) * 1e6);
  if (t < 0.55) return Math.round(r() * 1e5) / 100;
  return rndString(r);
}
function rndValue(r, depth) {
  const t = r();
  if (depth >= 2 || t < 0.6) return rndScalar(r);
  if (t < 0.8) return Array.from({ length: Math.floor(r() * 4) }, () => rndValue(r, depth + 1));
  const o = {};
  for (let i = 0, n = Math.floor(r() * 4); i < n; i++) o[rndString(r)] = rndValue(r, depth + 1);
  return o;
}
const KEYS = ['id', 'name', 'a.b', 'x', 'y', '_z', 'constructor', 'toString', 'key,comma', '"q"', '', ' sp ', '1', 'é', 'status', 'n'];
function rndRows(r) {
  const shapes = Array.from({ length: 1 + Math.floor(r() * 4) }, () => {
    const ks = new Set();
    for (let i = 0, n = 1 + Math.floor(r() * 5); i < n; i++) ks.add(pickFrom(r, KEYS));
    return [...ks];
  });
  const nestedKeys = ['city', 'zip', 'geo'];
  return Array.from({ length: 3 + Math.floor(r() * 40) }, () => {
    const o = {};
    for (const k of pickFrom(r, shapes)) {
      o[k] = r() < 0.15 ? { [nestedKeys[0]]: rndScalar(r), [nestedKeys[1]]: rndScalar(r), [nestedKeys[2]]: { lat: rndScalar(r) } } : rndScalar(r);
    }
    return o;
  });
}

test('fuzz: random JSON survives compression in every mode that claims to be lossless', () => {
  const r = rng(12345);
  for (let i = 0; i < 600; i++) {
    const t = r();
    const value = t < 0.7 ? rndRows(r) : t < 0.85 ? { items: rndRows(r), total: Math.floor(r() * 100), meta: rndValue(r, 0) } : rndValue(r, 0);
    const text = JSON.stringify(value, null, r() < 0.5 ? 2 : undefined);
    if (text.length < 90) continue;
    check(text, 'safe');
  }
});

test('fuzz: balanced and aggressive stay verifiable (lossy fields are flagged, never failed)', () => {
  const r = rng(777);
  for (let i = 0; i < 250; i++) {
    const text = JSON.stringify(rndRows(r), null, 2);
    check(text, 'balanced');
    check(text, 'aggressive');
  }
});

const LOG_TEMPLATES = [
  (r) => `2026-10-31T10:${String(Math.floor(r() * 60)).padStart(2, '0')}:${String(Math.floor(r() * 60)).padStart(2, '0')}.${Math.floor(r() * 999)}Z INFO user ${Math.floor(r() * 9999)} logged in from 10.0.${Math.floor(r() * 255)}.${Math.floor(r() * 255)}`,
  (r) => `2026-10-31 10:00:${String(Math.floor(r() * 60)).padStart(2, '0')} WARN retry ${Math.floor(r() * 10)}/10 for job ${Math.floor(r() * 1e6)}`,
  (r) => `    at fn${Math.floor(r() * 50)} (/app/file${Math.floor(r() * 9)}.js:${Math.floor(r() * 900)}:${Math.floor(r() * 80)})`,
  (r) => `GET /api/items/${Math.floor(r() * 1e5)} 200 ${Math.floor(r() * 900)}ms | cache=${r() < 0.5 ? 'hit' : 'miss'}`,
  (r) => `req ${'0123456789abcdef'.repeat(2).slice(0, 8)}-1111-2222-3333-${Math.floor(r() * 1e11).toString(16).padStart(12, '0')} done`,
  (r) => `value=0x${Math.floor(r() * 65535).toString(16)} ~ not a template row ~${Math.floor(r() * 3)}`,
  () => 'plain text with no numbers at all',
  () => '',
  (r) => `  indented ${rndString(r).replace(/[\n\r\u2028]/g, ' ')} line ${Math.floor(r() * 99)}`,
];
test('fuzz: log templating always decodes back to the original text', () => {
  const r = rng(2024);
  let templated = 0;
  for (let i = 0; i < 300; i++) {
    const n = 20 + Math.floor(r() * 180);
    const lines = Array.from({ length: n }, () => (r() < 0.85 ? LOG_TEMPLATES[Math.floor(r() * 5)](r) : pickFrom(r, LOG_TEMPLATES)(r)));
    const { r: res } = check(lines.join('\n'), 'safe');
    if (res.techniques['log-template']) templated++;
  }
  assert.ok(templated > 100, `templating should trigger on most generated logs, got ${templated}`);
});

test('fuzz: grep grouping always decodes back, and refuses inputs with look-alike lines', () => {
  const r = rng(99);
  const dirs = ['src/a/', 'src/b c/', 'lib/ü/', './x/', 'deep/er/path/'];
  let grouped = 0;
  let refused = 0;
  let dir = dirs[0];
  const hit = () => {
    if (r() < 0.15) dir = pickFrom(r, dirs); // real grep output stays in one directory for a while
    return `${dir}File${Math.floor(r() * 9)}.ts:${Math.floor(r() * 500)}:${rndString(r).replace(/[\n\r\u2028]/g, ' ')}`;
  };
  for (let i = 0; i < 300; i++) {
    const n = 40 + Math.floor(r() * 120);
    const trap = r() < 0.25;
    const lines = Array.from({ length: n }, () => (r() < 0.03 ? pickFrom(r, ['--', '', 'Binary file matches']) : hit()));
    if (trap) lines.splice(Math.floor(r() * n), 0, pickFrom(r, ['foo:12:looks like a stripped row', '@ not a header']));
    const { r: res } = check(lines.join('\n'), 'safe');
    if (res.techniques['grep-group']) {
      grouped++;
      assert.ok(!trap, 'must not group when a look-alike line is present');
    } else if (trap) refused++;
  }
  assert.ok(grouped > 100, `grouping should trigger on most clean inputs, got ${grouped}`);
  assert.ok(refused > 30, `look-alike inputs should be refused, got ${refused}`);
});

test('large integers and __proto__ keys are never rewritten', () => {
  const big = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ id: 9007199254740993 + i, name: `n${i}` }))).replace(/9007199254740993/, '9007199254740993');
  const { r } = check(big, 'safe');
  assert.ok(!r.techniques['json-csv'] && !r.techniques['json-table']);
  const proto = '[' + Array.from({ length: 6 }, (_, i) => `{"__proto__":{"x":${i}},"n":${i},"label":"row number ${i}"}`).join(',') + ']';
  const { r: r2 } = check(proto, 'safe');
  assert.ok(!r2.techniques['json-csv']);
});

test('verifier passes on every comparison payload in every mode', () => {
  for (const mode of ['safe', 'balanced', 'aggressive']) {
    for (const [name, messages] of payloads) {
      const body = { messages };
      const opts = { mode, keepRecent: 2, maxToolChars: 12000 };
      const v = verifyRequest(body, compressRequest(body, 'anthropic', opts).body, opts);
      assert.ok(v.ok, `${name} (${mode}): ${JSON.stringify(v.fields.filter((f) => f.status === 'FAILED'))}`);
      if (mode === 'safe') assert.strictEqual(v.lossless, true, `${name} should be fully lossless in safe mode`);
    }
  }
});

test('verifier catches corruption: a changed cell, a changed template row, a missing dedupe target', () => {
  const users = Array.from({ length: 30 }, (_, i) => ({ id: 1000 + i, name: `user ${i}`, email: `u${i}@x.io` }));
  const body = toolBody(JSON.stringify(users, null, 2));
  const opts = { mode: 'safe', keepRecent: 2 };
  const good = compressRequest(body, 'anthropic', opts).body;
  assert.ok(verifyRequest(body, good, opts).ok);

  const bad = JSON.parse(JSON.stringify(good));
  bad.messages[2].content[0].content = bad.messages[2].content[0].content.replace('1005', '1006');
  const v1 = verifyRequest(body, bad, opts);
  assert.strictEqual(v1.ok, false);
  assert.strictEqual(v1.counts.FAILED, 1);

  const logText = Array.from({ length: 60 }, (_, i) => `2026-10-31T10:00:${String(i).padStart(2, '0')}Z WARN retry ${i}`).join('\n');
  const body2 = toolBody(logText);
  const good2 = compressRequest(body2, 'anthropic', opts).body;
  const bad2 = JSON.parse(JSON.stringify(good2));
  bad2.messages[2].content[0].content = bad2.messages[2].content[0].content.replace('|7\n', '|8\n');
  assert.strictEqual(verifyRequest(body2, bad2, opts).ok, false);

  const file = Array.from({ length: 30 }, (_, i) => `line ${i} of the file`).join('\n');
  const two = { messages: [{ role: 'user', content: 'x' }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: file }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: file }] }, { role: 'user', content: 'end' }] };
  const comp = compressRequest(two, 'anthropic', opts).body;
  assert.ok(verifyRequest(two, comp, opts).ok);
  const wrong = JSON.parse(JSON.stringify(comp));
  wrong.messages[2].content[0].content = wrong.messages[2].content[0].content.replace('message 1', 'message 0');
  assert.strictEqual(verifyRequest(two, wrong, opts).ok, false);
});

// ---- repeated line blocks ----

const BLOCK_TOOLS = ['Bash', 'browser_find', 'Read', 'mcp__fs__read_file', 'run_query'];
function rndLine(r) {
  const t = r();
  if (t < 0.15) return pickFrom(r, NASTY).replace(/[\n\r\u2028]/g, ' ');
  if (t < 0.2) return pickFrom(r, ['', '[same as message 1 lines 1-5]', '[same as message 1 result 2 lines 1-5]', '[same as message x', '  - generic [ref=e12]:']);
  return `  - item ${Math.floor(r() * 1e4)} ${rndString(r)} ${'abcdefghij'.repeat(1 + Math.floor(r() * 4))}`;
}
// A conversation whose tool results reuse runs of lines from earlier results, sometimes with an edited line.
function rndConversation(r, openai) {
  const results = [];
  const messages = [{ role: 'user', content: 'start' }];
  for (let turn = 0, n = 3 + Math.floor(r() * 8); turn < n; turn++) {
    const calls = Array.from({ length: r() < 0.3 ? 2 : 1 }, (_, c) => ({ id: `t${turn}_${c}`, name: pickFrom(r, BLOCK_TOOLS) }));
    const texts = calls.map(() => {
      const lines = [];
      while (lines.length < 6 + Math.floor(r() * 50)) {
        if (results.length && r() < 0.5) {
          const src = pickFrom(r, results);
          const a = Math.floor(r() * src.length);
          const run = src.slice(a, a + 3 + Math.floor(r() * 20));
          if (r() < 0.2 && run.length > 2) run[Math.floor(r() * run.length)] += ' (edited)';
          lines.push(...run);
        } else lines.push(rndLine(r));
      }
      results.push(lines);
      return lines.join('\n');
    });
    if (openai) {
      messages.push({ role: 'assistant', content: null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: '{}' } })) });
      calls.forEach((c, i) => messages.push({ role: 'tool', tool_call_id: c.id, content: texts[i] }));
    } else {
      messages.push({ role: 'assistant', content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: {} })) });
      messages.push({
        role: 'user',
        content: calls.map((c, i) => ({ type: 'tool_result', tool_use_id: c.id, content: r() < 0.3 ? [{ type: 'text', text: texts[i] }] : texts[i] })),
      });
    }
  }
  messages.push({ role: 'assistant', content: 'ok' }, { role: 'user', content: 'end' });
  return { messages };
}

test('fuzz: repeated line blocks decode exactly, point at text the model can see, and are deterministic', () => {
  const r = rng(4242);
  let blocks = 0;
  for (let i = 0; i < 300; i++) {
    const openai = r() < 0.3;
    const body = rndConversation(r, openai);
    for (const mode of ['safe', 'balanced', 'aggressive']) {
      const opts = { mode, keepRecent: 2, maxToolChars: 12000 };
      const out = compressRequest(body, openai ? 'openai' : 'anthropic', opts);
      const v = verifyRequest(body, out.body, opts);
      assert.ok(v.ok, `case ${i} ${mode}: ${JSON.stringify(v.fields.filter((f) => f.status === 'FAILED')).slice(0, 600)}`);
      // References may sit inside a lossless compressed form, so 'exact' is not required, only lossless.
      for (const f of v.fields) if (f.techniques.includes('dedupe-block') && mode === 'safe') assert.ok(['exact', 'whitespace-normalized', 'equivalent'].includes(f.status), f.status);
      if (mode === 'safe') {
        assert.strictEqual(v.lossless, true);
        blocks += out.techniques['dedupe-block'] || 0;
      }
      assert.deepStrictEqual(compressRequest(body, openai ? 'openai' : 'anthropic', opts).body, out.body, 'output must be deterministic');
    }
  }
  assert.ok(blocks > 300, `block dedupe should trigger often on generated conversations, got ${blocks}`);
});

// A browser accessibility-tree style result where the same branch repeats for every match.
function treeResult(matches, salt) {
  const out = [`### Result`, `Found ${matches} matches for /Fare|Select/i:`];
  for (let i = 0; i < matches; i++) {
    out.push('', '- generic [ref=e4]:', '  - generic [ref=e12]:', '    - generic [ref=e16]:  container for the fare selection panel');
    out.push(`      - button "Select fare ${i} ${salt}" [ref=e${100 + i}]: Select this fare and continue to passenger details`);
    out.push('----');
  }
  return out.join('\n');
}

test('repeated line blocks: lines repeated within one result become "same as lines above" references', () => {
  const text = treeResult(6, 'a');
  const body = { messages: [
    { role: 'user', content: 'find fares' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'browser_find', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] },
  ] };
  for (const mode of ['safe', 'balanced', 'aggressive']) {
    const out = compressRequest(body, 'anthropic', { mode }).body;
    const sent = out.messages[2].content[0].content;
    assert.match(sent, /^\[same as lines \d+-\d+ above\]$/m, mode);
    assert.ok(sent.length < text.length * 0.8, `${mode}: ${sent.length} vs ${text.length}`);
    assert.strictEqual(formats.decodeBlockRefs(sent, () => null), text, mode);
    const v = verifyRequest(body, out, { mode });
    assert.ok(v.ok && v.lossless, `${mode}: ${JSON.stringify(v.counts)}`);
  }
});

test('repeated line blocks: references into a result that itself has references resolve to verbatim lines; tampering is caught', () => {
  const body = { messages: [{ role: 'user', content: 'find fares' }] };
  for (let n = 0; n < 4; n++) {
    body.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${n}`, name: 'browser_find', input: {} }] });
    body.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: treeResult(3 + n, `s${n}`) }] });
  }
  const opts = { mode: 'safe' };
  const out = compressRequest(body, 'anthropic', opts).body;
  const sentTexts = out.messages.map((m) => toolTexts(m)[0]);
  const refs = sentTexts.join('\n').match(/^\[same as message \d+ lines \d+-\d+\]$/gm) || [];
  assert.ok(refs.length > 0, 'later results should point at earlier ones');
  // Every reference to another message lands on lines that are not references themselves.
  for (const r of refs) {
    const [, m, a, b] = /message (\d+) lines (\d+)-(\d+)/.exec(r).map(Number);
    for (const l of sentTexts[m].split('\n').slice(a - 1, b)) assert.ok(!formats.isRefLine(l), `${r} -> ${l}`);
  }
  const v = verifyRequest(body, out, opts);
  assert.ok(v.ok && v.lossless, JSON.stringify(v.counts));
  // Corrupt a line that a later result points at: the verifier must notice.
  const [, m, a] = /message (\d+) lines (\d+)-/.exec(refs[0]).map(Number);
  const tampered = JSON.parse(JSON.stringify(out));
  const holder = tampered.messages[m].content[0];
  const lines = holder.content.split('\n');
  lines[a - 1] += ' (changed)';
  holder.content = lines.join('\n');
  assert.strictEqual(verifyRequest(body, tampered, opts).ok, false);
});

test('repeated line blocks: original text with lines that look like references is never given references', () => {
  const text = `${treeResult(4, 'x')}\n[same as lines 1-2 above]`;
  const body = { messages: [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'browser_find', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] },
  ] };
  const out = compressRequest(body, 'anthropic', { mode: 'safe' }).body;
  const sent = out.messages[2].content[0].content;
  assert.strictEqual((sent.match(/\[same as /g) || []).length, 1, 'only the original look-alike line');
  assert.ok(verifyRequest(body, out, { mode: 'safe' }).ok);
});

test('repeated line blocks: excluded tools are never rewritten but serve as sources; corruption is caught', () => {
  const file = Array.from({ length: 40 }, (_, i) => `export const value${i} = compute(${i}); // line ${i} of the module`).join('\n');
  const tail = Array.from({ length: 12 }, (_, i) => `test ${i} passed in ${i * 3}ms`).join('\n');
  const body = {
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: file }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: {} }, { type: 'tool_use', id: 'c', name: 'Read', input: {} }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'b', content: `$ cat module.js\n${file}\n${tail}` },
        { type: 'tool_result', tool_use_id: 'c', content: `${file}\nextra` },
      ] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'end' },
    ],
  };
  const opts = { mode: 'safe', keepRecent: 2 };
  const out = compressRequest(body, 'anthropic', opts).body;
  const bash = out.messages[4].content[0].content;
  assert.match(bash, /^\$ cat module\.js\n\[same as message 2 lines 1-40\]\ntest 0 passed/);
  assert.strictEqual(out.messages[4].content[1].content, `${file}\nextra`, 'an excluded tool result stays verbatim');
  assert.strictEqual(verifyRequest(body, out, opts).lossless, true);

  const wrongRange = JSON.parse(JSON.stringify(out));
  wrongRange.messages[4].content[0].content = bash.replace('lines 1-40', 'lines 2-40');
  assert.strictEqual(verifyRequest(body, wrongRange, opts).ok, false);

  const sourceChanged = JSON.parse(JSON.stringify(out));
  sourceChanged.messages[2].content[0].content = file.replace('line 7 of', 'line 7 in');
  assert.strictEqual(verifyRequest(body, sourceChanged, opts).ok, false, 'a reference to text the model no longer sees must fail');

  const missing = JSON.parse(JSON.stringify(out));
  missing.messages[4].content[0].content = bash.replace('message 2', 'message 9');
  assert.strictEqual(verifyRequest(body, missing, opts).ok, false);
});

// ---- stale tool results ----

test('stale results: off in safe mode, lossy-but-verified otherwise, excluded tools untouched', () => {
  // Distinct per run, so repeated-block references do not apply and only the stale cap is measured.
  const big = (t) => Array.from({ length: 300 }, (_, i) => `run ${t} row ${i}: ${'payload '.repeat(4)}${i * 7}`).join('\n');
  const file = Array.from({ length: 300 }, (_, i) => `const x${i} = ${i}; // file line ${i}`).join('\n');
  const messages = [{ role: 'user', content: 'go' }];
  for (let t = 0; t < 30; t++) {
    const name = t === 0 ? 'Read' : 'Bash';
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${t}`, name, input: {} }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${t}`, content: t === 0 ? file : big(t) }] });
  }
  messages.push({ role: 'assistant', content: 'ok' }, { role: 'user', content: 'end' });
  const body = { messages };
  const stale = { keepRecent: 2, maxToolChars: 12000, staleAfter: 20, staleChars: 2000, staleStep: 10 };

  const safeOn = compressRequest(body, 'anthropic', { ...stale, mode: 'safe' });
  const safeOff = compressRequest(body, 'anthropic', { keepRecent: 2, maxToolChars: 12000, mode: 'safe' });
  assert.deepStrictEqual(safeOn.body, safeOff.body, 'safe mode must ignore staleAfter');
  assert.strictEqual(verifyRequest(body, safeOn.body, { ...stale, mode: 'safe' }).lossless, true);

  const out = compressRequest(body, 'anthropic', { ...stale, mode: 'balanced' });
  const v = verifyRequest(body, out.body, { ...stale, mode: 'balanced' });
  assert.ok(v.ok, JSON.stringify(v.fields.filter((f) => f.status === 'FAILED')).slice(0, 500));
  assert.ok(v.counts.lossy > 0, 'old results are capped and flagged lossy');
  assert.strictEqual(out.body.messages[2].content[0].content, file, 'an excluded tool result is never rewritten, even when stale');
  const cutoff = Math.floor((messages.length - 20) / 10) * 10;
  for (let i = 2; i < messages.length - 2; i += 2) {
    const len = out.body.messages[i].content[0].content.length;
    if (i === 2) continue;
    if (i < cutoff) assert.ok(len <= 2200, `message ${i} is stale and should be capped (got ${len})`);
    else assert.ok(len > 2200, `message ${i} is recent and must not be capped`);
  }
});

test('stale results: the cached prefix only breaks when the stale cutoff moves', () => {
  const r = rng(31337);
  for (let n = 0; n < 15; n++) {
    const full = rndConversation(r, false).messages;
    // Make results big enough to be capped once stale.
    for (const m of full) if (Array.isArray(m.content)) for (const b of m.content) {
      if (b.type === 'tool_result' && typeof b.content === 'string') b.content = `${b.content}\n${'filler line for size\n'.repeat(150)}`;
    }
    const opts = { mode: 'balanced', keepRecent: 2, maxToolChars: 12000, staleAfter: 6, staleChars: 500, staleStep: 4 };
    let prev = null;
    for (let t = 3; t <= full.length; t++) {
      const body = { messages: full.slice(0, t) };
      const out = compressRequest(body, 'anthropic', opts).body.messages;
      const cut = Math.floor((t - 6) / 4) * 4;
      if (prev && cut === prev.cut) {
        // Everything before the newest messages must be byte-identical to the previous request.
        for (let i = 0; i < t - 1 - 2; i++) {
          assert.deepStrictEqual(out[i], prev.out[i], `conversation ${n}: message ${i} changed between requests ${t - 1} and ${t} without a cutoff move`);
        }
      }
      const v = verifyRequest(body, { messages: out }, opts);
      assert.ok(v.ok, `conversation ${n}, request ${t}: ${JSON.stringify(v.fields.filter((f) => f.status === 'FAILED')).slice(0, 600)}`);
      prev = { out, cut };
    }
  }
});

test('decoders refuse __proto__ keys instead of polluting objects', () => {
  const { decodeTables } = require('../src/formats');
  assert.throws(() => decodeTables('[table 1 rows] __proto__\n1'));
  assert.throws(() => decodeTables('[table 1 rows nested] a.__proto__.b\n1'));
  assert.strictEqual({}.polluted, undefined);
});

// ---- proxy fail-safe ----
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function mockUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return { server, seen };
}
async function post(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  await res.text();
  return res;
}
const users40 = Array.from({ length: 40 }, (_, i) => ({ id: 1000 + i, name: `user ${i}`, email: `u${i}@x.io` }));

test('proxy: verified rewrites are sent and marked lossless', async () => {
  const up = mockUpstream();
  const upPort = await listen(up.server);
  const { server, stats } = createServer({ anthropicUpstream: `http://127.0.0.1:${upPort}`, mode: 'safe' });
  const port = await listen(server);
  try {
    await post(port, toolBody(JSON.stringify(users40, null, 2)));
    assert.strictEqual(stats.recent[0].check, 'lossless');
    assert.ok(JSON.parse(up.seen[0]).messages[2].content[0].content.startsWith('[table '));
    assert.strictEqual(stats.verifyFailed, 0);
  } finally {
    server.close();
    up.server.close();
  }
});

test('proxy: a rewrite that fails verification is replaced by the original request', async () => {
  const up = mockUpstream();
  const upPort = await listen(up.server);
  const corrupting = (body, format, opts) => {
    const r = compressRequest(body, format, opts);
    const bad = JSON.parse(JSON.stringify(r.body));
    bad.messages[2].content[0].content = bad.messages[2].content[0].content.replace('1005', '1006');
    return { ...r, body: bad };
  };
  const { server, stats } = createServer({ anthropicUpstream: `http://127.0.0.1:${upPort}`, mode: 'safe', compressRequest: corrupting });
  const port = await listen(server);
  try {
    const original = toolBody(JSON.stringify(users40, null, 2));
    await post(port, original);
    assert.deepStrictEqual(JSON.parse(up.seen[0]), original, 'upstream must receive the untouched original');
    assert.strictEqual(stats.verifyFailed, 1);
    assert.strictEqual(stats.recent[0].check, 'FAILED, original sent');
    assert.strictEqual(stats.recent[0].saved, 0);
  } finally {
    server.close();
    up.server.close();
  }
});

test('proxy: verification can be turned off', async () => {
  const up = mockUpstream();
  const upPort = await listen(up.server);
  const { server, stats } = createServer({ anthropicUpstream: `http://127.0.0.1:${upPort}`, mode: 'safe', verify: false });
  const port = await listen(server);
  try {
    await post(port, toolBody(JSON.stringify(users40, null, 2)));
    assert.strictEqual(stats.recent[0].check, '');
  } finally {
    server.close();
    up.server.close();
  }
});

test('cli: verify command reports a verdict and exit code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-'));
  const file = path.join(dir, 'req.json');
  fs.writeFileSync(file, JSON.stringify(toolBody(JSON.stringify(users40, null, 2))));
  const out = execFileSync('node', [path.join(__dirname, '../src/verify.js'), file, 'safe'], { encoding: 'utf8' });
  assert.ok(out.includes('VERIFIED: every change is lossless.'));
  const none = spawnSync('node', [path.join(__dirname, '../src/verify.js')], { encoding: 'utf8' });
  assert.strictEqual(none.status, 2);
});

// The same random conversations in OpenAI Responses API form (what Codex sends): function_call /
// custom_tool_call items, outputs as a string or input_text parts, and opaque reasoning items in between.
function toResponses(body, r) {
  const input = [];
  for (const m of body.messages) {
    if (typeof m.content === 'string') {
      input.push({ type: 'message', role: m.role, content: [{ type: m.role === 'user' ? 'input_text' : 'output_text', text: m.content }] });
      continue;
    }
    for (const b of m.content) {
      if (b.type === 'tool_use') {
        if (r() < 0.5) input.push({ type: 'reasoning', id: `rs_${b.id}`, summary: [], encrypted_content: 'gAAAA' + 'x'.repeat(200) });
        const custom = r() < 0.5;
        input.push(custom ? { type: 'custom_tool_call', call_id: b.id, name: b.name, input: 'ls' } : { type: 'function_call', call_id: b.id, name: b.name, arguments: '{}' });
        b.custom = custom;
      } else if (b.type === 'tool_result') {
        const text = typeof b.content === 'string' ? b.content : b.content[0].text;
        const call = input.find((x) => x.call_id === b.tool_use_id);
        const output = r() < 0.5 ? text : [{ type: 'input_text', text }];
        input.push({ type: call.type === 'custom_tool_call' ? 'custom_tool_call_output' : 'function_call_output', call_id: b.tool_use_id, output });
      }
    }
  }
  return { model: 'gpt-x', instructions: 'You are Codex.', input, tools: [], store: false, stream: true };
}

test('fuzz: Responses API (Codex) bodies verify, stay lossless in safe mode, are deterministic and append-only', () => {
  const r = rng(5151);
  let blocks = 0;
  for (let i = 0; i < 200; i++) {
    const body = toResponses(rndConversation(r, false), r);
    for (const mode of ['safe', 'balanced', 'aggressive']) {
      const opts = { mode, keepRecent: 2, maxToolChars: 12000 };
      const out = compressRequest(body, 'responses', opts);
      const v = verifyRequest(body, out.body, opts);
      assert.ok(v.ok, `case ${i} ${mode}: ${JSON.stringify(v.fields.filter((f) => f.status === 'FAILED')).slice(0, 600)}`);
      for (const f of v.fields) assert.match(f.path, /^input\[\d+\]\.output(\[\d+\]\.text)?$/, 'only tool outputs change');
      if (mode === 'safe') {
        assert.strictEqual(v.lossless, true);
        blocks += out.techniques['dedupe-block'] || 0;
      }
      assert.deepStrictEqual(compressRequest(body, 'responses', opts).body, out.body, 'output must be deterministic');
      // Append-only: compressing a shorter history gives the same items for the shared prefix.
      const cut = 1 + Math.floor(r() * (body.input.length - 1));
      const shorter = compressRequest({ ...body, input: body.input.slice(0, cut) }, 'responses', opts);
      assert.deepStrictEqual(shorter.body.input, out.body.input.slice(0, cut), `case ${i} ${mode}: prefix changed`);
    }
  }
  assert.ok(blocks > 200, `block dedupe should trigger on generated conversations, got ${blocks}`);
});
