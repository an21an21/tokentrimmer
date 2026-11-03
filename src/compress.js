'use strict';
const formats = require('./formats');
// tokentrimmer compression engine. Pure functions, no dependencies.
// Modes:
//   safe       lossless only (whitespace, ANSI, JSON minify, table-ify, identical-result dedupe)
//   balanced   safe + drop null/empty JSON fields + collapse repeated log lines
//   aggressive balanced + cap very large outputs (head + tail, middle elided)

const MODES = ['safe', 'balanced', 'aggressive'];
const level = (mode) => Math.max(0, MODES.indexOf(mode));

// Rough estimate: ~4 chars/token for prose, down to ~3 for symbol-heavy text (JSON, code).
// Smooth in symbol density so a shorter text never estimates as more tokens than a longer one
// by crossing a threshold.
function estimateTokens(s) {
  if (!s) return 0;
  const symbols = (s.match(/[{}\[\]":,;=<>()]/g) || []).length;
  const density = symbols / s.length;
  const charsPerToken = Math.min(4, Math.max(3, 4.2 - density * 8));
  return Math.ceil(s.length / charsPerToken);
}

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

function cleanWhitespace(text) {
  return text
    .replace(ANSI, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- JSON ----------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isEmpty(v) {
  return (
    v === null ||
    v === '' ||
    (Array.isArray(v) && v.length === 0) ||
    (isPlainObject(v) && Object.keys(v).length === 0)
  );
}

// Nested objects with identical keys in every row become dotted columns ("address.city").
// Skipped when any column name already contains a dot, so decoding stays unambiguous.
function sameKeys(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

function flattenTable(cols, rows) {
  if (cols.some((c) => c.includes('.'))) return { cols, rows };
  let nested = false;
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    const next = [];
    cols.forEach((c, i) => {
      const first = rows[0][i];
      const ok =
        isPlainObject(first) &&
        Object.keys(first).length > 0 &&
        Object.keys(first).every((k) => !k.includes('.') && !k.startsWith('_')) &&
        rows.every((r) => isPlainObject(r[i]) && sameKeys(r[i], first));
      if (ok) {
        changed = true;
        for (const k of Object.keys(first)) next.push({ name: `${c}.${k}`, get: (r) => r[i][k] });
      } else next.push({ name: c, get: (r) => r[i] });
    });
    if (!changed) break;
    nested = true;
    rows = rows.map((r) => next.map((n) => n.get(r)));
    cols = next.map((n) => n.name);
  }
  return nested ? { cols, rows, nested: true } : { cols, rows };
}

function buildTable(objs) {
  const cols = Object.keys(objs[0]);
  return flattenTable(cols, objs.map((o) => cols.map((c) => o[c])));
}

// Arrays of objects become tables so keys are written once.
//   same shape everywhere:  {"_table":{"cols":[..],"rows":[[..]]}}
//   a few shapes mixed:     {"_groups":[{cols,rows},..],"_order":[0,1,0,..]}  (order index keeps the original sequence)
// Lossless; the mixed form is only used when it is actually shorter.
function tabularize(arr) {
  if (arr.length < 3 || !arr.every(isPlainObject)) return null;
  const groups = new Map();
  const order = [];
  for (const o of arr) {
    const sig = JSON.stringify(Object.keys(o));
    if (!groups.has(sig)) groups.set(sig, []);
    order.push([...groups.keys()].indexOf(sig));
    groups.get(sig).push(o);
  }
  if (Object.keys(arr[0]).length === 0) return null;
  if (groups.size === 1) return { _table: buildTable(arr) };
  if (groups.size > 8 || arr.length < 6) return null;
  const candidate = { _groups: [...groups.values()].map(buildTable), _order: order };
  return JSON.stringify(candidate).length < JSON.stringify(arr).length ? candidate : null;
}

// Phase 1: structure. Arrays of same-shaped objects become tables.
function structure(value, stats) {
  if (Array.isArray(value)) {
    const items = value.map((v) => structure(v, stats));
    const table = tabularize(items);
    if (table) {
      stats.tables++;
      return table;
    }
    return items;
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = structure(v, stats);
    return out;
  }
  return value;
}

function cleanTable({ cols, rows, nested }, stats) {
  const cleaned = rows.map((r) => r.map((c) => dropEmpties(c, stats)));
  const keep = cols.map((_, i) => cleaned.some((r) => !isEmpty(r[i])));
  stats.dropped += keep.filter((k) => !k).length;
  return {
    cols: cols.filter((_, i) => keep[i]),
    rows: cleaned.map((r) =>
      r.filter((_, i) => keep[i]).map((c) => {
        if (!isEmpty(c)) return c;
        if (c !== null) stats.dropped++; // "" / [] / {} becoming null is a change, so it must be reported as lossy
        return null;
      }),
    ),
    ...(nested ? { nested: true } : {}),
  };
}

// Phase 2 (balanced and up): drop empty values. Inside a table only columns that
// are empty in every row are removed, so the table stays rectangular.
function dropEmpties(value, stats) {
  if (Array.isArray(value)) return value.map((v) => dropEmpties(v, stats));
  if (!isPlainObject(value)) return value;
  if (value._table && Object.keys(value).length === 1) return { _table: cleanTable(value._table, stats) };
  if (value._groups && value._order && Object.keys(value).length === 2) {
    return { _groups: value._groups.map((g) => cleanTable(g, stats)), _order: value._order };
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const c = dropEmpties(v, stats);
    if (isEmpty(c)) {
      stats.dropped++;
      continue;
    }
    out[k] = c;
  }
  return out;
}

// Aggressive mode for huge JSON: keep the first rows that fit, say how many were left out.
function capRows(value, currentLen, maxChars) {
  if (isPlainObject(value) && value._groups && value._order) {
    const n = value._order.length;
    const keep = Math.max(1, Math.floor((n * maxChars) / currentLen));
    if (keep >= n) return null;
    const order = value._order.slice(0, keep);
    const counts = value._groups.map(() => 0);
    for (const g of order) counts[g]++;
    return {
      _groups: value._groups.map((g, i) => ({ ...g, rows: g.rows.slice(0, counts[i]) })),
      _order: order,
      _omitted_items: n - keep,
    };
  }
  const isTable = isPlainObject(value) && value._table;
  const rows = isTable ? value._table.rows : Array.isArray(value) ? value : null;
  if (!rows || rows.length < 2) return null;
  const keep = Math.max(1, Math.floor((rows.length * maxChars) / currentLen));
  if (keep >= rows.length) return null;
  const omitted = rows.length - keep;
  if (isTable) return { _table: { ...value._table, rows: rows.slice(0, keep) }, _omitted_rows: omitted };
  return [...rows.slice(0, keep), { _omitted_items: omitted }];
}

// A top-level table (or group of tables) is written as compact text rather than JSON when that is shorter.
function serializeTop(v) {
  const json = JSON.stringify(v);
  let text = null;
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    if (v._table && keys.every((k) => k === '_table' || k === '_omitted_rows')) {
      text = formats.encodeTable(v._table, v._omitted_rows);
    } else if (v._groups && v._order && keys.every((k) => ['_groups', '_order', '_omitted_items'].includes(k))) {
      text = formats.encodeGroups(v._groups, v._order, v._omitted_items);
    }
  }
  return text && text.length < json.length ? { text, csv: true } : { text: json, csv: false };
}

function compressJSON(text, mode, maxChars) {
  // Re-serializing would corrupt integers beyond 2^53 and drop a literal "__proto__" key.
  if (/\d{16,}/.test(text) || text.includes('"__proto__"')) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const stats = { tables: 0, dropped: 0 };
  let v = structure(parsed, stats);
  if (level(mode) >= 1) v = dropEmpties(v, stats);
  const techniques = ['json-minify'];
  if (stats.tables) techniques.push('json-table');
  if (stats.dropped) techniques.push('json-drop-empty');
  let ser = serializeTop(v);
  let out = ser.text;
  if (level(mode) >= 2 && out.length > maxChars) {
    const capped = capRows(v, out.length, maxChars);
    if (capped) {
      ser = serializeTop(capped);
      out = ser.text;
      techniques.push('cap-large-output');
    }
  }
  if (ser.csv) techniques.push('json-csv');
  return { text: out, techniques };
}

// ---------- Logs ----------

const LOG_HINT = /^\s*(\[?\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}|(INFO|WARN|ERROR|DEBUG|TRACE)\b|at\s+\S+\s*\(|\s+at\s)/;

function looksLikeLog(text) {
  const lines = text.split('\n');
  if (lines.length < 8) return false;
  const hits = lines.slice(0, 200).filter((l) => LOG_HINT.test(l)).length;
  return hits / Math.min(lines.length, 200) > 0.4;
}

// Mask the parts of a line that vary (timestamps, ids, numbers) so near-identical lines group.
function shape(line) {
  return line
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<ts>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\d+/g, '#');
}

function collapseRepeats(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  let collapsed = 0;
  while (i < lines.length) {
    let j = i + 1;
    const s = shape(lines[i]);
    while (j < lines.length && shape(lines[j]) === s) j++;
    const run = j - i;
    if (run >= 3) {
      out.push(lines[i]);
      out.push(`  ... ${run - 2} similar lines omitted ...`);
      out.push(lines[j - 1]);
      collapsed += run - 2;
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }
  return { text: out.join('\n'), collapsed };
}

// ---------- grep-style results ----------

const GREP_LINE = /^([^\s:][^:\n]*\/)([^\/:\n]+):(\d+):(.*)$/;

// "src/a/B.tsx:10:text" lines share long directory prefixes. Write each directory once
// as an "@ dir/" header. Lossless; skipped if the text already uses "@ " lines.
function groupGrep(text) {
  const lines = text.split('\n');
  if (lines.length < 20 || lines.some((l) => l.startsWith('@ '))) return null;
  const hits = lines.filter((l) => GREP_LINE.test(l)).length;
  if (hits / lines.length < 0.8) return null;
  // A leftover line shaped like a stripped row could not be told apart when decoding.
  if (lines.some((l) => !GREP_LINE.test(l) && formats.STRIPPED_ROW.test(l))) return null;
  const out = [];
  let dir = null;
  for (const l of lines) {
    const g = GREP_LINE.exec(l);
    if (!g) {
      out.push(l);
      dir = null;
      continue;
    }
    if (g[1] !== dir) {
      out.push('@ ' + g[1]);
      dir = g[1];
    }
    out.push(`${g[2]}:${g[3]}:${g[4]}`);
  }
  return out.join('\n');
}

// ---------- Large output cap ----------

function capOutput(text, maxChars) {
  if (text.length <= maxChars) return null;
  const lines = text.split('\n');
  const headBudget = Math.floor(maxChars * 0.6);
  const tailBudget = maxChars - headBudget;
  if (lines.length < 10) {
    const cut = text.length - maxChars;
    return `${text.slice(0, headBudget)}\n... [tokentrimmer: ${cut} characters omitted from the middle] ...\n${text.slice(text.length - tailBudget)}`;
  }
  const head = [];
  let used = 0;
  let h = 0;
  while (h < lines.length && used + lines[h].length + 1 <= headBudget) {
    head.push(lines[h]);
    used += lines[h].length + 1;
    h++;
  }
  const tail = [];
  used = 0;
  let t = lines.length - 1;
  while (t > h && used + lines[t].length + 1 <= tailBudget) {
    tail.unshift(lines[t]);
    used += lines[t].length + 1;
    t--;
  }
  const omitted = t - h + 1;
  if (omitted <= 0) return null;
  return [...head, `... [tokentrimmer: ${omitted} lines omitted from the middle] ...`, ...tail].join('\n');
}

// ---------- Public API ----------

// Compress one string. Returns { text, techniques }.
function compressText(input, opts = {}) {
  const mode = opts.mode || 'balanced';
  const maxChars = opts.maxToolChars || 12000;
  const techniques = [];
  let text = input;

  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const j = compressJSON(trimmed, mode, maxChars);
    if (j) {
      text = j.text;
      techniques.push(...j.techniques);
    }
  }

  if (!techniques.length) {
    const cleaned = cleanWhitespace(text);
    if (cleaned.length < text.length) techniques.push('whitespace');
    text = cleaned;
    const grouped = groupGrep(text);
    if (grouped && grouped.length < text.length) {
      text = grouped;
      techniques.push('grep-group');
    }
    const logLike = looksLikeLog(text);
    if (logLike) {
      const tpl = formats.templateLogs(text);
      if (tpl) {
        text = tpl;
        techniques.push('log-template');
      }
    }
    if (level(mode) >= 1 && logLike) {
      const r = collapseRepeats(text);
      if (r.collapsed) {
        text = r.text;
        techniques.push('log-collapse');
      }
    }
  }

  if (level(mode) >= 2 && !techniques.includes('json-minify')) {
    const capped = capOutput(text, maxChars);
    if (capped) {
      text = capped;
      techniques.push('cap-large-output');
    }
  }

  // Never return something longer than the input.
  if (text.length >= input.length) return { text: input, techniques: [] };
  return { text, techniques };
}

module.exports = { compressText, estimateTokens, cleanWhitespace, MODES };
