'use strict';
// Compact, lossless text formats used by the compressor, plus their decoders.
// The decoders exist so tests (and users) can verify that nothing was lost.

// ---------- cells ----------

const NUM = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

function needsQuote(s) {
  return (
    s === '' ||
    /[,"\n\r]/.test(s) ||
    s !== s.trim() ||
    NUM.test(s) ||
    s === 'true' || s === 'false' || s === 'null' ||
    s[0] === '[' || s[0] === '{'
  );
}

// Strings stay bare unless they could be mistaken for something else. Everything else is JSON.
function encCell(v) {
  if (typeof v === 'string') return needsQuote(v) ? JSON.stringify(v) : v;
  return JSON.stringify(v);
}

function scanString(line, i) {
  let j = i + 1;
  while (j < line.length) {
    if (line[j] === '\\') j += 2;
    else if (line[j] === '"') return j + 1;
    else j++;
  }
  return line.length;
}

function scanBalanced(line, i) {
  let depth = 0;
  let j = i;
  while (j < line.length) {
    const ch = line[j];
    if (ch === '"') {
      j = scanString(line, j);
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    j++;
    if (depth === 0) return j;
  }
  return line.length;
}

function splitCells(line) {
  const cells = [];
  let i = 0;
  const n = line.length;
  for (;;) {
    const c = line[i];
    let end;
    if (c === '"') end = scanString(line, i);
    else if (c === '[' || c === '{') end = scanBalanced(line, i);
    else {
      end = line.indexOf(',', i);
      if (end < 0) end = n;
    }
    cells.push(line.slice(i, end));
    if (end >= n) break;
    i = end + 1;
  }
  return cells;
}

function parseCell(s) {
  if (s === '') return '';
  const c = s[0];
  if (c === '"' || c === '[' || c === '{') return JSON.parse(s);
  if (s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (NUM.test(s)) return Number(s);
  return s;
}

// ---------- tables ----------

function encodeTable(t, omitted) {
  if (!t.cols.length) return null;
  const lines = [`[table ${t.rows.length} rows${t.nested ? ' nested' : ''}] ${t.cols.map(encCell).join(',')}`];
  for (const r of t.rows) lines.push(r.map(encCell).join(','));
  if (omitted) lines.push(`[... ${omitted} more rows omitted]`);
  return lines.join('\n');
}

function encodeOrder(order) {
  for (let p = 1; p <= 8; p++) {
    if (order.length >= 2 * p && order.every((x, i) => x === order[i % p])) return `cycle(${order.slice(0, p).join(',')})`;
  }
  const parts = [];
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j < order.length && order[j] === order[i]) j++;
    parts.push(j - i > 1 ? `${order[i]}x${j - i}` : `${order[i]}`);
    i = j;
  }
  return parts.join(',');
}

function decodeOrder(spec, n) {
  const m = /^cycle\((.*)\)$/.exec(spec);
  if (m) {
    const cyc = m[1].split(',').map(Number);
    return Array.from({ length: n }, (_, i) => cyc[i % cyc.length]);
  }
  const out = [];
  for (const part of spec.split(',')) {
    const [v, k] = part.split('x');
    for (let i = 0; i < (k ? Number(k) : 1); i++) out.push(Number(v));
  }
  return out;
}

function encodeGroups(groups, order, omitted) {
  if (groups.some((g) => !g.cols.length)) return null;
  const lines = [];
  groups.forEach((g, i) => {
    lines.push(`[group ${i}: ${g.rows.length} rows${g.nested ? ' nested' : ''}] ${g.cols.map(encCell).join(',')}`);
    for (const r of g.rows) lines.push(r.map(encCell).join(','));
  });
  lines.push(`[order ${order.length}] ${encodeOrder(order)}`);
  if (omitted) lines.push(`[... ${omitted} more items omitted]`);
  return lines.join('\n');
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (k === '__proto__') throw new Error('refusing to decode a __proto__ key');
    // Own properties only: keys like "constructor" must never reach inherited objects.
    if (!Object.prototype.hasOwnProperty.call(o, k)) o[k] = {};
    o = o[k];
  }
  const last = parts[parts.length - 1];
  if (last === '__proto__') throw new Error('refusing to decode a __proto__ key');
  o[last] = value;
}

// Dotted column names mean nested objects only when the table is marked "nested".
function rowsToObjects(cols, rows, nested) {
  return rows.map((r) => {
    const o = {};
    cols.forEach((c, i) => {
      if (c === '__proto__') throw new Error('refusing to decode a __proto__ key');
      if (nested) setPath(o, c, r[i]);
      else o[c] = r[i];
    });
    return o;
  });
}

// Returns the original array of objects (rows that were omitted by aggressive mode are simply absent).
function decodeTables(text) {
  const lines = text.split('\n');
  let i = 0;
  const readTable = (header) => {
    const rest = header.slice(header.indexOf('] ') + 2);
    const cols = splitCells(rest).map(parseCell);
    const hm = /(\d+) rows( nested)?\]/.exec(header);
    const count = Number(hm[1]);
    const nested = Boolean(hm[2]);
    const rows = [];
    for (let k = 0; k < count; k++) rows.push(splitCells(lines[i++]).map(parseCell));
    return rowsToObjects(cols, rows, nested);
  };
  if (lines[0].startsWith('[table ')) return readTable(lines[i++]);
  const tables = [];
  while (lines[i] && lines[i].startsWith('[group ')) tables.push(readTable(lines[i++]));
  const om = /^\[order (\d+)\] (.*)$/.exec(lines[i++]);
  const order = decodeOrder(om[2], Number(om[1]));
  const next = tables.map(() => 0);
  return order.map((g) => tables[g][next[g]++]);
}

// Expand any {_table} / {_groups} forms still embedded in plain JSON (nested tables).
function expand(v) {
  if (Array.isArray(v)) return v.map(expand);
  if (v && typeof v === 'object') {
    if (v._table && Object.keys(v).every((k) => k === '_table' || k === '_omitted_rows')) {
      return rowsToObjects(v._table.cols, v._table.rows.map((r) => r.map(expand)), v._table.nested);
    }
    if (v._groups && v._order) {
      const tables = v._groups.map((g) => rowsToObjects(g.cols, g.rows.map((r) => r.map(expand)), g.nested));
      const next = tables.map(() => 0);
      return v._order.map((g) => tables[g][next[g]++]);
    }
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = expand(x);
    return o;
  }
  return v;
}

// Decode whatever compressJSON produced back to the original JSON value.
function decodeJSONOutput(text) {
  if (text.startsWith('[table ') || text.startsWith('[group ')) return decodeTables(text);
  return expand(JSON.parse(text));
}

// ---------- grep grouping (decoder side) ----------

// A grep row after its directory was moved into an "@ dir/" header: "file:line:text".
const STRIPPED_ROW = /^[^\/:\n]+:\d+:/;

function ungroupGrep(text) {
  let dir = null;
  const out = [];
  for (const l of text.split('\n')) {
    if (l.startsWith('@ ')) dir = l.slice(2);
    else out.push(dir !== null && STRIPPED_ROW.test(l) ? dir + l : l);
  }
  return out.join('\n');
}

// ---------- log templates ----------

const VAR_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b0x[0-9a-f]+\b|\d+/gi;
const LOG_HEADER = '[log templates: %% marks a variable; "~N|a|b" fills template N]';

// Lines that share a template (everything except numbers, timestamps, ids) are written as
// "~N|var|var" after the templates are listed once. Order is preserved. Lossless.
function templateLogs(text) {
  const lines = text.split('\n');
  if (lines.length < 20 || text.includes('%%') || /^~\d/m.test(text) || lines.includes('[lines]') || lines[0].startsWith('[log templates')) return null;
  const parsed = lines.map((l) => {
    const vars = [];
    const t = l.replace(VAR_RE, (m) => (vars.push(m), '%%'));
    return { t, vars, l };
  });
  const counts = new Map();
  for (const p of parsed) counts.set(p.t, (counts.get(p.t) || 0) + 1);
  const chosen = [...counts.entries()].filter(([t, c]) => c >= 5 && t.includes('%%')).sort((a, b) => b[1] - a[1]).slice(0, 30);
  if (!chosen.length) return null;
  const ids = new Map(chosen.map(([t], i) => [t, i + 1]));
  const out = [LOG_HEADER, ...chosen.map(([t], i) => `~${i + 1}: ${t}`), '[lines]'];
  for (const p of parsed) {
    const id = ids.get(p.t);
    out.push(id ? `~${id}|${p.vars.join('|')}` : p.l);
  }
  const result = out.join('\n');
  return result.length < text.length * 0.95 ? result : null;
}

function decodeLogTemplates(text) {
  const lines = text.split('\n');
  const tpl = new Map();
  let i = 1;
  for (; lines[i] !== '[lines]'; i++) {
    const m = /^~(\d+): (.*)$/s.exec(lines[i]);
    tpl.set(m[1], m[2]);
  }
  const out = [];
  for (i++; i < lines.length; i++) {
    const m = /^~(\d+)\|(.*)$/s.exec(lines[i]);
    if (!m) {
      out.push(lines[i]);
      continue;
    }
    const parts = tpl.get(m[1]).split('%%');
    const vars = m[2].split('|');
    out.push(parts.reduce((acc, p, k) => acc + p + (k < vars.length ? vars[k] : ''), ''));
  }
  return out.join('\n');
}

// ---------- repeated line blocks ----------

// A run of lines already shown verbatim in an earlier tool result is replaced by one reference line.
// `message` is the index in the request's messages array; `result` (1-based) is only written when that
// message holds more than one tool-result text. Lossless: decodeBlockRefs restores the exact text.
const BLOCK_REF = /^\[tokentrim: lines (\d+)-(\d+) of (?:tool result (\d+)|the tool result) in message (\d+) repeated here\]$/;

function blockRef(from, to, message, result) {
  const where = result ? `tool result ${result}` : 'the tool result';
  return `[tokentrim: lines ${from}-${to} of ${where} in message ${message} repeated here]`;
}

function hasBlockRefs(text) {
  return text.split('\n').some((l) => BLOCK_REF.test(l));
}

// getText(message, result) returns the referenced original text (result is 1-based, defaults to 1).
function decodeBlockRefs(text, getText) {
  const out = [];
  for (const l of text.split('\n')) {
    const m = BLOCK_REF.exec(l);
    if (!m) {
      out.push(l);
      continue;
    }
    const src = getText(Number(m[4]), m[3] ? Number(m[3]) : 1);
    if (typeof src !== 'string') throw new Error(`block reference to a missing tool result: ${l}`);
    const lines = src.split('\n');
    const from = Number(m[1]), to = Number(m[2]);
    if (from < 1 || to < from || to > lines.length) throw new Error(`block reference out of range: ${l}`);
    out.push(...lines.slice(from - 1, to));
  }
  return out.join('\n');
}

module.exports = {
  encCell, splitCells, parseCell, encodeTable, encodeGroups, decodeTables, decodeJSONOutput, expand,
  templateLogs, decodeLogTemplates, ungroupGrep, STRIPPED_ROW,
  BLOCK_REF, blockRef, hasBlockRefs, decodeBlockRefs,
};
