'use strict';
// Applies the compression engine to Anthropic and OpenAI request bodies.
// Rules: system prompts, tool definitions and plain-text turns are never touched; only tool results are.
// A message's compressed form depends only on that message and earlier ones (plus the stepped stale
// cutoff), never on how many messages follow it. That keeps the history append-only, which both prompt
// caching and thinking-block signatures (preserved thinking) require. Plain-text cleanup of older turns
// is available with opts.plainText, but it rewrites a turn once it ages past keepRecent: an edit.
const crypto = require('node:crypto');
const { compressText, estimateTokens } = require('./compress');
const formats = require('./formats');

const DEDUPE_MIN_CHARS = 400;
const LOSSY = new Set(['json-drop-empty', 'log-collapse', 'cap-large-output']);
// Repeated line blocks: a run must span at least BLOCK_WINDOW lines and BLOCK_MIN_CHARS characters
// to be worth a reference line.
const BLOCK_WINDOW = 4;
const BLOCK_MIN_CHARS = 100; // tuned on real sessions via compare/real (opts.blockWindow / opts.blockMinChars override)

// Tools whose output is file content the model may later quote back exactly (edit tools match
// text verbatim). Their results are never rewritten, but identical repeats are still deduplicated.
const DEFAULT_EXCLUDE_TOOLS = [
  'read', 'read_file', 'view', 'edit', 'multiedit', 'write', 'notebookedit', 'notebookread',
  'str_replace_editor', 'str_replace_based_edit_tool', 'skill',
];

function isExcluded(ctx, name) {
  if (!name) return false;
  // Text the model retrieved on purpose is never shortened again.
  if (name === formats.RETRIEVE_TOOL) return true;
  const last = String(name).toLowerCase().split('__').pop();
  return ctx.exclude.has(last) || ctx.exclude.has(String(name).toLowerCase());
}

function makeContext(opts) {
  const exclude = new Set((opts.excludeTools || DEFAULT_EXCLUDE_TOOLS).map((n) => String(n).toLowerCase()));
  return {
    opts, exclude, names: new Map(), seen: new Map(), techniques: {}, fieldsChanged: 0, skipped: 0,
    // Repeated-block index: window hash -> first {msg, result, line} where those lines were sent verbatim.
    blocks: new Map(), sources: new Map(), resultCounts: new Map(),
    // Retrieval: id -> original text of every tool result that lost content (opts.retrieve).
    store: new Map(),
    blockWindow: opts.blockWindow || BLOCK_WINDOW, blockMinChars: opts.blockMinChars ?? BLOCK_MIN_CHARS,
  };
}

// The tool-result texts of one message, in order. Anthropic: every tool_result block's string
// content or text parts. OpenAI: a role "tool" message's content. Shared with the verifier so
// "tool result K in message M" means the same thing on both sides.
function toolTexts(m) {
  const out = [];
  if (!m || typeof m !== 'object') return out;
  const pushAll = (c) => {
    if (typeof c === 'string') out.push(c);
    else if (Array.isArray(c)) for (const p of c) if (p && p.type === 'text' && typeof p.text === 'string') out.push(p.text);
  };
  if (m.role === 'tool') pushAll(m.content);
  else if (Array.isArray(m.content)) for (const b of m.content) if (b && b.type === 'tool_result') pushAll(b.content);
  return out;
}

function note(ctx, list) {
  for (const t of list) ctx.techniques[t] = (ctx.techniques[t] || 0) + 1;
}

const windowKey = (lines, i, w) => crypto.createHash('sha1').update(lines.slice(i, i + w).join('\n')).digest('base64');

// Remember a tool result that is sent unchanged, so later results can point at its lines.
function indexSource(ctx, text, msgIndex, k) {
  const lines = text.split('\n');
  if (lines.length < ctx.blockWindow) return;
  const id = `${msgIndex}:${k}`;
  ctx.sources.set(id, lines);
  for (let i = 0; i + ctx.blockWindow <= lines.length; i++) {
    const key = windowKey(lines, i, ctx.blockWindow);
    if (!ctx.blocks.has(key)) ctx.blocks.set(key, { id, msgIndex, k, line: i });
  }
}

// Replace runs of lines already sent verbatim earlier with one reference line each. Returns null
// when nothing qualifies. The first earlier occurrence is always used, so output is deterministic.
function dedupeBlocks(text, ctx) {
  if (!ctx.blocks.size || formats.hasBlockRefs(text)) return null;
  const lines = text.split('\n');
  if (lines.length < ctx.blockWindow) return null;
  const out = [];
  let replaced = false;
  let i = 0;
  while (i < lines.length) {
    const hit = i + ctx.blockWindow <= lines.length && ctx.blocks.get(windowKey(lines, i, ctx.blockWindow));
    if (hit) {
      const src = ctx.sources.get(hit.id);
      let n = 0;
      let chars = 0;
      while (i + n < lines.length && hit.line + n < src.length && lines[i + n] === src[hit.line + n]) chars += lines[i + n++].length + 1;
      if (n >= ctx.blockWindow && chars >= ctx.blockMinChars) {
        const result = ctx.resultCounts.get(hit.msgIndex) > 1 ? hit.k : 0;
        out.push(formats.blockRef(hit.line + 1, hit.line + n, hit.msgIndex, result));
        replaced = true;
        i += n;
        continue;
      }
    }
    out.push(lines[i++]);
  }
  return replaced ? out.join('\n') : null;
}

// ---- stale tool results (opt-in, never in safe mode) ----
// With opts.staleAfter = N, tool results more than about N messages old are compressed in aggressive
// mode with a small cap (opts.staleChars). The cutoff only moves in steps of opts.staleStep
// messages, so a result changes form once and the cached prefix breaks once per step, not every turn.
// Defaults tuned on real sessions for cache-weighted cost (compare/real, cache replay).
const STALE_CHARS = 1000;
const STALE_STEP = 20;

function staleOptions(opts) {
  if (!opts || !opts.staleAfter || opts.mode === 'safe') return null;
  return { ...opts, mode: 'aggressive', maxToolChars: opts.staleChars || STALE_CHARS };
}

function staleBefore(opts, count) {
  if (!staleOptions(opts)) return -1;
  const step = opts.staleStep || STALE_STEP;
  return Math.floor((count - opts.staleAfter) / step) * step;
}

// k is the 1-based position of this text among the message's tool-result texts (see toolTexts).
// stale: the result is older than the stale cutoff (see staleBefore).
function shrinkToolText(text, ctx, msgIndex, excluded, k, stale) {
  if (typeof text !== 'string' || text.length < 80) return text;
  const hash = crypto.createHash('sha1').update(text).digest('hex');
  if (text.length >= DEDUPE_MIN_CHARS) {
    if (ctx.seen.has(hash)) {
      note(ctx, ['dedupe-identical']);
      ctx.fieldsChanged++;
      return `[tokentrim: identical to the tool result in message ${ctx.seen.get(hash)}]`;
    }
    ctx.seen.set(hash, msgIndex);
  }
  if (excluded) {
    // File content stays verbatim (edit tools match it exactly), and so can be referenced later.
    ctx.skipped++;
    indexSource(ctx, text, msgIndex, k);
    return text;
  }
  const r = compressText(text, (stale && staleOptions(ctx.opts)) || ctx.opts);
  const blocks = dedupeBlocks(text, ctx);
  if (blocks !== null && blocks.length < r.text.length) {
    note(ctx, ['dedupe-block']);
    ctx.fieldsChanged++;
    return blocks;
  }
  if (r.techniques.length) {
    note(ctx, r.techniques);
    ctx.fieldsChanged++;
  } else {
    indexSource(ctx, text, msgIndex, k);
  }
  if (ctx.opts.retrieve && r.techniques.some((t) => LOSSY.has(t))) {
    // Content was dropped: keep the original for the retrieval tool and tell the model how to get it.
    const id = formats.retrieveId(text);
    ctx.store.set(id, text);
    note(ctx, ['retrievable']);
    return r.text + formats.retrieveNote(id);
  }
  return r.text;
}

// Shrinks holder[key] (a string, or an array of text parts), numbering texts in toolTexts order.
// counter is { k } shared across one message.
function shrinkContent(holder, key, ctx, i, ex, counter) {
  const stale = i < ctx.staleBefore;
  const one = (s) => (typeof s === 'string' ? shrinkToolText(s, ctx, i, ex, ++counter.k, stale) : s);
  if (typeof holder[key] === 'string') holder[key] = one(holder[key]);
  else if (Array.isArray(holder[key])) for (const p of holder[key]) if (p && p.type === 'text') p.text = one(p.text);
}

function shrinkPlainText(text, ctx) {
  if (typeof text !== 'string' || text.length < 200) return text;
  const r = compressText(text, { ...ctx.opts, mode: 'safe' });
  if (r.techniques.length) {
    note(ctx, r.techniques);
    ctx.fieldsChanged++;
  }
  return r.text;
}

function anthropic(body, ctx) {
  const messages = body.messages;
  messages.forEach((m, i) => {
    if (Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'tool_use' && b.id) ctx.names.set(b.id, b.name);
    }
    ctx.resultCounts.set(i, toolTexts(m).length);
  });
  ctx.staleBefore = staleBefore(ctx.opts, messages.length);
  const recentFrom = messages.length - (ctx.opts.keepRecent ?? 2);
  messages.forEach((m, i) => {
    const old = i < recentFrom;
    if (typeof m.content === 'string') {
      if (old && ctx.opts.plainText) m.content = shrinkPlainText(m.content, ctx);
      return;
    }
    if (!Array.isArray(m.content)) return;
    const counter = { k: 0 };
    for (const block of m.content) {
      if (block.type === 'tool_result') {
        shrinkContent(block, 'content', ctx, i, isExcluded(ctx, ctx.names.get(block.tool_use_id)), counter);
      } else if (block.type === 'text' && old && ctx.opts.plainText) {
        block.text = shrinkPlainText(block.text, ctx);
      }
    }
  });
}

function openai(body, ctx) {
  const messages = body.messages;
  messages.forEach((m, i) => {
    if (Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) if (c.id && c.function) ctx.names.set(c.id, c.function.name);
    }
    ctx.resultCounts.set(i, toolTexts(m).length);
  });
  ctx.staleBefore = staleBefore(ctx.opts, messages.length);
  const recentFrom = messages.length - (ctx.opts.keepRecent ?? 2);
  messages.forEach((m, i) => {
    if (m.role === 'tool') {
      shrinkContent(m, 'content', ctx, i, isExcluded(ctx, ctx.names.get(m.tool_call_id)), { k: 0 });
    } else if ((m.role === 'user' || m.role === 'assistant') && i < recentFrom) {
      if (typeof m.content === 'string' && ctx.opts.plainText) m.content = shrinkPlainText(m.content, ctx);
    }
  });
}

// Returns { body, before, after, techniques, changed, store }. Never throws on odd input.
// store maps retrieval ids to original texts (only filled with opts.retrieve).
function compressRequest(body, format, opts) {
  const beforeText = JSON.stringify(body);
  const before = estimateTokens(beforeText);
  if (!body || !Array.isArray(body.messages)) {
    return { body, before, after: before, techniques: {}, changed: false, store: new Map() };
  }
  const clone = JSON.parse(beforeText);
  const ctx = makeContext(opts);
  try {
    (format === 'anthropic' ? anthropic : openai)(clone, ctx);
  } catch {
    return { body, before, after: before, techniques: {}, changed: false, store: new Map() };
  }
  const afterText = JSON.stringify(clone);
  // Keep the rewrite only if it is really shorter. Judged on length, not on the estimate.
  const changed = ctx.fieldsChanged > 0 && afterText.length < beforeText.length;
  const after = changed ? Math.min(estimateTokens(afterText), before) : before;
  return {
    body: changed ? clone : body,
    before,
    after,
    techniques: changed ? ctx.techniques : {},
    changed,
    store: changed ? ctx.store : new Map(),
  };
}

module.exports = { compressRequest, toolTexts, staleOptions, DEFAULT_EXCLUDE_TOOLS };
