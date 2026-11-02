#!/usr/bin/env node
'use strict';
// Verifier: proves that a compressed request still carries the same information.
// For every string the compressor changed, it decodes the compressed form and compares it with
// the original. Statuses:
//   exact                 decodes to the identical text
//   whitespace-normalized identical apart from trailing spaces, blank-line runs, ANSI codes
//   equivalent            identical JSON value (formatting and key layout differ)
//   lossy                 an intentionally lossy technique ran (drop-empty, log-collapse, cap)
//   FAILED                the decoded text does not match the original
const { isDeepStrictEqual } = require('node:util');
const { compressText, cleanWhitespace } = require('./compress');
const formats = require('./formats');
const { toolTexts, staleOptions } = require('./messages');

const LOSSY = new Set(['json-drop-empty', 'log-collapse', 'cap-large-output']);
const DEDUPE_REF = /^\[tokentrim: identical to the tool result in message (\d+)\]$/;

function containsString(node, str) {
  if (typeof node === 'string') return node === str;
  if (Array.isArray(node)) return node.some((x) => containsString(x, str));
  if (node && typeof node === 'object') return Object.values(node).some((x) => containsString(x, str));
  return false;
}

function classify(orig, comp, originalBody, compressedBody, opts) {
  const ref = DEDUPE_REF.exec(comp);
  if (ref) {
    const target = originalBody.messages[Number(ref[1])];
    return containsString(target, orig)
      ? { status: 'exact', techniques: ['dedupe-identical'] }
      : { status: 'FAILED', techniques: ['dedupe-identical'], reason: 'referenced message does not contain this text' };
  }
  if (formats.hasBlockRefs(comp) && !formats.hasBlockRefs(orig)) {
    // Decode against the original (nothing lost) and against the compressed body (the referenced
    // lines are really in front of the model, unchanged).
    const t = ['dedupe-block'];
    try {
      for (const body of [originalBody, compressedBody]) {
        const decoded = formats.decodeBlockRefs(comp, (m, k) => toolTexts(body.messages[m])[k - 1]);
        if (decoded !== orig) return { status: 'FAILED', techniques: t, reason: 'referenced lines differ from the original text' };
      }
      return { status: 'exact', techniques: t };
    } catch (e) {
      return { status: 'FAILED', techniques: t, reason: `decode error: ${e.message}` };
    }
  }
  // Plain-text turns are compressed in safe mode, tool results in the configured mode, stale tool
  // results with the stale options.
  let techniques = null;
  for (const o of [opts, { ...opts, mode: 'safe' }, staleOptions(opts)].filter(Boolean)) {
    const r = compressText(orig, o);
    if (r.text === comp) {
      techniques = r.techniques;
      break;
    }
  }
  if (!techniques) return { status: 'FAILED', techniques: [], reason: 'compressed text is not what the compressor produces for the original' };
  if (techniques.some((t) => LOSSY.has(t))) return { status: 'lossy', techniques };

  try {
    if (techniques.some((t) => t.startsWith('json-'))) {
      const same = isDeepStrictEqual(formats.decodeJSONOutput(comp), JSON.parse(orig.trim()));
      return { status: same ? 'equivalent' : 'FAILED', techniques, ...(same ? {} : { reason: 'decoded JSON differs' }) };
    }
    const cleaned = cleanWhitespace(orig);
    let text = comp;
    if (techniques.includes('log-template')) text = formats.decodeLogTemplates(text);
    if (techniques.includes('grep-group')) text = formats.ungroupGrep(text);
    if (text !== cleaned) return { status: 'FAILED', techniques, reason: 'decoded text differs' };
    return { status: cleaned === orig ? 'exact' : 'whitespace-normalized', techniques };
  } catch (e) {
    return { status: 'FAILED', techniques, reason: `decode error: ${e.message}` };
  }
}

function walk(orig, comp, path, visit) {
  if (typeof orig === 'string' && typeof comp === 'string') {
    if (orig !== comp) visit(path, orig, comp);
  } else if (Array.isArray(orig) && Array.isArray(comp)) {
    orig.forEach((x, i) => walk(x, comp[i], `${path}[${i}]`, visit));
  } else if (orig && comp && typeof orig === 'object' && typeof comp === 'object') {
    for (const k of Object.keys(orig)) walk(orig[k], comp[k], path ? `${path}.${k}` : k, visit);
  }
}

// Compare an original request body with its compressed version.
function verifyRequest(originalBody, compressedBody, opts = {}) {
  const fields = [];
  const o = { mode: 'balanced', ...opts };
  walk(originalBody, compressedBody, '', (path, orig, comp) => {
    fields.push({ path, charsBefore: orig.length, charsAfter: comp.length, ...classify(orig, comp, originalBody, compressedBody, o) });
  });
  const counts = { exact: 0, equivalent: 0, 'whitespace-normalized': 0, lossy: 0, FAILED: 0 };
  for (const f of fields) counts[f.status]++;
  return { ok: counts.FAILED === 0, lossless: counts.lossy === 0 && counts.FAILED === 0, fields, counts };
}

module.exports = { verifyRequest };

if (require.main === module) {
  const fs = require('node:fs');
  const { compressRequest } = require('./messages');
  const [file, mode = 'balanced'] = process.argv.slice(2);
  if (!file) {
    console.error('Usage: node src/verify.js request.json [safe|balanced|aggressive]');
    process.exit(2);
  }
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  const format = Array.isArray(body.messages) && body.messages.some((m) => m.role === 'tool') ? 'openai' : 'anthropic';
  const opts = { mode, keepRecent: 2, maxToolChars: 12000 };
  const r = compressRequest(body, format, opts);
  const v = verifyRequest(body, r.body, opts);
  console.log(`Request: ${r.before} -> ${r.after} estimated tokens (${mode}, ${format} format)`);
  for (const f of v.fields) {
    const tag = f.status === 'FAILED' ? `FAILED (${f.reason})` : f.status;
    console.log(`  ${f.path.padEnd(34)} ${String(f.charsBefore).padStart(7)} -> ${String(f.charsAfter).padStart(7)}  ${tag}  [${f.techniques.join(', ')}]`);
  }
  console.log('Summary:', JSON.stringify(v.counts));
  console.log(v.ok ? (v.lossless ? 'VERIFIED: every change is lossless.' : 'VERIFIED: lossless except the fields marked lossy.') : 'FAILED: do not send the compressed request.');
  process.exit(v.ok ? 0 : 1);
}
