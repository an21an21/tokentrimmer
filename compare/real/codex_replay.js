#!/usr/bin/env node
'use strict';
// Offline replay of local Codex sessions (~/.codex/sessions, or the directory given with --dir): rebuilds
// the /v1/responses input at each model call, compresses and verifies it, and prints totals only.
//   node compare/real/codex_replay.js [--dir path] [safe] [balanced] [aggressive]
// Savings are measured on the text the model reads: encrypted reasoning / compaction payloads and image
// data are left out of both sides, since they are not billed as text.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compressRequest } = require('../../src/messages');
const { verifyRequest } = require('../../src/verify');

const args = process.argv.slice(2);
const dirAt = args.indexOf('--dir');
const dir = dirAt >= 0 ? args.splice(dirAt, 2)[1] : path.join(os.homedir(), '.codex', 'sessions');
const modes = args.length ? args : ['safe'];

const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.jsonl')) files.push(p);
  }
})(dir);

const MODEL_ITEMS = new Set(['reasoning', 'function_call', 'custom_tool_call', 'web_search_call', 'tool_search_call']);
const textOnly = (items) => JSON.stringify(items, (k, v) => (['encrypted_content', 'image_url', 'file_data'].includes(k) ? '' : v));

// Input snapshots at each model call: before a model item that follows a tool output or a user message.
function requests(file) {
  let items = [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type === 'compacted') items = [];
    if (r.type !== 'response_item') continue;
    const item = r.payload;
    if (item.type === 'compaction') items = [];
    const last = items[items.length - 1];
    if (last && MODEL_ITEMS.has(item.type) && (/_output$/.test(last.type) || (last.type === 'message' && last.role !== 'assistant'))) out.push(items.slice());
    items.push(item);
  }
  if (items.length) out.push(items);
  return out;
}

const totals = Object.fromEntries(modes.map((m) => [m, { reqs: 0, before: 0, after: 0, finalBefore: 0, finalAfter: 0, failed: 0, lossy: 0, ms: 0 }]));
let sessions = 0;
for (const f of files) {
  const reqs = requests(f);
  if (!reqs.length) continue;
  sessions++;
  for (const mode of modes) {
    const t = totals[mode];
    reqs.forEach((input, i) => {
      const body = { input };
      const opts = { mode, keepRecent: 2, maxToolChars: 12000 };
      const t0 = process.hrtime.bigint();
      let out = compressRequest(body, 'responses', opts);
      if (out.changed) {
        const v = verifyRequest(body, out.body, opts);
        if (!v.ok) {
          t.failed++;
          out = { body };
        } else if (!v.lossless) t.lossy++;
      }
      t.ms += Number(process.hrtime.bigint() - t0) / 1e6;
      const before = textOnly(input).length;
      const after = textOnly(out.body.input).length;
      t.reqs++;
      t.before += before;
      t.after += after;
      if (i === reqs.length - 1) {
        t.finalBefore += before;
        t.finalAfter += after;
      }
    });
  }
}

const pct = (a, b) => `${(100 * (1 - a / b)).toFixed(1)}%`;
console.log(`${sessions} Codex sessions from ${dir}`);
for (const [mode, t] of Object.entries(totals)) {
  console.log(`${mode.padEnd(10)} ${t.reqs} requests: all requests ${pct(t.after, t.before)} smaller, final request ${pct(t.finalAfter, t.finalBefore)} (characters of model-readable text); verify failed ${t.failed}, lossy ${t.lossy}, ${(t.ms / t.reqs).toFixed(1)} ms/request`);
}
