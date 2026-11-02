'use strict';
// Retrieval (Anthropic /v1/messages only): when lossy compression shortened a tool result, the model
// can call the tokentrim_retrieve tool to read the original. The client never sees that tool: the
// proxy answers the call itself, re-asks upstream, and returns one combined assistant turn.
//
// Thinking blocks are signed over everything before them (preserved thinking). The client will
// replay the combined turn without the hidden retrieval turns, so thinking blocks produced after a
// retrieval would no longer match their prefix and are left out of what the client receives.
// Thinking blocks from the first response keep their exact prefix and are passed through.
//
// The originals do not need to be kept between requests: the client always sends its full,
// uncompressed history, so every request rebuilds the id -> text store (messages.js, opts.retrieve).
const formats = require('./formats');

const MAX_ROUNDS = 4;
const MAX_CHARS = 30000;

const TOOL = {
  name: formats.RETRIEVE_TOOL,
  description:
    'Returns the original, full text of an earlier tool result that was shortened to save context. ' +
    'Shortened results end with a note like [tokentrim: shortened; full text via tokentrim_retrieve {"id":"..."}]. ' +
    'Call this with that id when you need content that was omitted. Use from_line/to_line (1-based) to read part ' +
    'of a long result. Call it on its own, not in the same turn as other tools.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The id from the shortened note.' },
      from_line: { type: 'integer', description: 'First line to return (1-based). Default 1.' },
      to_line: { type: 'integer', description: 'Last line to return. Default: as much as fits.' },
    },
    required: ['id'],
  },
};

const isRetrieveCall = (b) => b && b.type === 'tool_use' && b.name === TOOL.name;
const isThinking = (b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking');
const isOtherToolUse = (b) => b && b.type === 'tool_use' && b.name !== TOOL.name;

// Adds the tool to every request (a stable tool set keeps the cache and thinking signatures valid).
function addTool(body) {
  if (!Array.isArray(body.tools)) body.tools = [];
  if (!body.tools.some((t) => t && t.name === TOOL.name)) body.tools.push(TOOL);
}

function answer(input, store) {
  const id = input && typeof input.id === 'string' ? input.id : '';
  const text = store.get(id);
  if (text === undefined) {
    return { content: `No shortened tool result has id "${id}". Use the id from a [tokentrim: shortened ...] note.`, is_error: true };
  }
  const lines = text.split('\n');
  const n = lines.length;
  const from = Math.min(Math.max(Number.parseInt(input.from_line, 10) || 1, 1), n);
  let to = Math.min(Math.max(Number.parseInt(input.to_line, 10) || n, from), n);
  let used = 0;
  for (let i = from - 1; i < to; i++) {
    used += lines[i].length + 1;
    if (used > MAX_CHARS && i > from - 1) {
      to = i;
      break;
    }
  }
  const more = to < n ? `; call again with from_line=${to + 1} for more` : '';
  return { content: `[lines ${from}-${to} of ${n}${more}]\n${lines.slice(from - 1, to).join('\n')}` };
}

function followUp(body, assistantContent, calls, store) {
  body.messages.push(
    { role: 'assistant', content: assistantContent },
    { role: 'user', content: calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, ...answer(c.input, store) })) },
  );
}

// ---------- non-streaming ----------

// post(body) -> fetch Response. first: the Response to the original request.
// Returns { status, json } or, when upstream failed, { status, text }.
async function complete(post, body, store, first) {
  let resp = first;
  const kept = [];
  let rounds = 0;
  let outputTokens = 0;
  for (;;) {
    if (!resp.ok) return { status: resp.status, text: await resp.text(), rounds };
    const msg = await resp.json();
    const content = Array.isArray(msg.content) ? msg.content : [];
    outputTokens += (msg.usage && msg.usage.output_tokens) || 0;
    const calls = content.filter(isRetrieveCall);
    for (const b of content) if (!isRetrieveCall(b) && !(rounds > 0 && isThinking(b))) kept.push(b);
    if (calls.length && !content.some(isOtherToolUse) && msg.stop_reason === 'tool_use' && rounds < MAX_ROUNDS) {
      followUp(body, content, calls, store);
      rounds++;
      resp = await post(body);
      continue;
    }
    const out = { ...msg, content: kept };
    if (msg.usage) out.usage = { ...msg.usage, output_tokens: outputTokens };
    // The model's retrieval calls are not the client's business: if only those were cut, the turn ended.
    if (calls.length && out.stop_reason === 'tool_use' && !kept.some((b) => b.type === 'tool_use')) out.stop_reason = 'end_turn';
    return { status: 200, json: out, rounds };
  }
}

// ---------- streaming ----------

async function* sseEvents(stream) {
  const decoder = new TextDecoder();
  let buf = '';
  const parse = (raw) => {
    let event = null;
    const data = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    let json = null;
    try {
      json = data.length ? JSON.parse(data.join('\n')) : null;
    } catch {
      json = null;
    }
    return { event, data: json, raw };
  };
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      const raw = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      if (raw.trim()) yield parse(raw);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) yield parse(buf);
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const DELTAS = {
  text_delta: (b, d) => { b.text = (b.text || '') + d.text; },
  thinking_delta: (b, d) => { b.thinking = (b.thinking || '') + d.thinking; },
  signature_delta: (b, d) => { b.signature = d.signature; },
  citations_delta: (b, d) => { (b.citations = b.citations || []).push(d.citation); },
  input_json_delta: (b, d, e) => { e.partial += d.partial_json; },
};

// Streams upstream events to the client while it rebuilds each upstream message, so a retrieval call
// can be answered and the follow-up's blocks appended to the same client message (indexes renumbered).
async function stream(post, body, store, first, write) {
  let resp = first;
  let rounds = 0;
  let next = 0; // next content block index on the client side
  for (;;) {
    const blocks = new Map();
    let delta = null;
    let unsafe = false;
    let forwardedToolUse = false;
    for await (const ev of sseEvents(resp.body)) {
      const d = ev.data;
      const type = (d && d.type) || ev.event;
      if (type === 'message_start') {
        if (rounds === 0) write(ev.raw + '\n\n');
      } else if (type === 'content_block_start' && d) {
        const b = JSON.parse(JSON.stringify(d.content_block || {}));
        const hidden = isRetrieveCall(b) || (rounds > 0 && isThinking(b));
        const e = { block: b, hidden, out: hidden ? null : next++, partial: '' };
        blocks.set(d.index, e);
        if (!hidden) {
          if (b.type === 'tool_use') forwardedToolUse = true;
          write(sse(ev.event || type, { ...d, index: e.out }));
        }
      } else if (type === 'content_block_delta' && d) {
        const e = blocks.get(d.index);
        if (!e) continue;
        const apply = DELTAS[d.delta && d.delta.type];
        if (apply) apply(e.block, d.delta, e);
        else unsafe = true; // cannot rebuild this block faithfully, so no follow-up request
        if (!e.hidden) write(sse(ev.event || type, { ...d, index: e.out }));
      } else if (type === 'content_block_stop' && d) {
        const e = blocks.get(d.index);
        if (!e) continue;
        if (e.block.type === 'tool_use' || e.block.type === 'server_tool_use') {
          try {
            e.block.input = e.partial ? JSON.parse(e.partial) : e.block.input || {};
          } catch {
            unsafe = true;
          }
        }
        if (!e.hidden) write(sse(ev.event || type, { ...d, index: e.out }));
      } else if (type === 'message_delta') {
        delta = d; // held: only the last round's end is sent
      } else if (type === 'message_stop') {
        // held
      } else if (type === 'error') {
        write(ev.raw + '\n\n');
        return;
      } else {
        write(ev.raw + '\n\n'); // ping and anything new
      }
    }
    const content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e.block);
    const calls = content.filter(isRetrieveCall);
    const stop = delta && delta.delta && delta.delta.stop_reason;
    if (calls.length && !content.some(isOtherToolUse) && stop === 'tool_use' && rounds < MAX_ROUNDS && !unsafe) {
      followUp(body, content, calls, store);
      rounds++;
      resp = await post(body);
      if (!resp.ok) {
        const detail = (await resp.text()).slice(0, 300);
        write(sse('error', { type: 'error', error: { type: 'api_error', message: `tokentrim retrieval follow-up failed (HTTP ${resp.status}): ${detail}` } }));
        return rounds;
      }
      continue;
    }
    if (delta) {
      if (calls.length && stop === 'tool_use' && !forwardedToolUse) delta = { ...delta, delta: { ...delta.delta, stop_reason: 'end_turn' } };
      write(sse('message_delta', delta));
    }
    write(sse('message_stop', { type: 'message_stop' }));
    return rounds;
  }
}

// ---------- thinking-block binding ----------

const BINDING_BETA = 'thinking-binding-controls-2026-08-01';

// For rewrites that are not append-only (the stale cutoff moving), ask the API to drop thinking
// blocks whose prefix changed instead of rejecting the request. Only touches requests whose history
// has thinking blocks and whose thinking config is adaptive (or omitted, which those models run as
// adaptive). Returns true when the body and headers were changed.
function allowEditedHistory(body, headers) {
  const has = body.messages.some((m) => Array.isArray(m.content) && m.content.some(isThinking));
  const t = body.thinking;
  if (!has || (t && (t.type !== 'adaptive' || t.block_binding))) return false;
  body.thinking = { ...(t || { type: 'adaptive' }), block_binding: { prefix_mismatch_behavior: 'drop_block' } };
  const betas = String(headers['anthropic-beta'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!betas.includes(BINDING_BETA)) betas.push(BINDING_BETA);
  headers['anthropic-beta'] = betas.join(',');
  return true;
}

module.exports = { TOOL, addTool, answer, complete, stream, sseEvents, allowEditedHistory, MAX_ROUNDS };
