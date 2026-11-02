'use strict';
// Shared synthetic payloads for the head-to-head comparison. Deterministic.
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const apiList = JSON.stringify(
  Array.from({ length: 150 }, (_, i) => ({
    id: i + 1000, name: `Customer ${i}`, email: `customer${i}@example.com`,
    status: pick(['active', 'trial', 'churned']),
    phone: rnd() > 0.6 ? `+91-98${Math.floor(rnd() * 1e8)}` : null,
    notes: '', tags: [],
    address: { line2: null, city: pick(['Pune', 'Mumbai', 'Delhi']), country: 'IN' },
  })), null, 2);

const logs = [
  ...Array.from({ length: 400 }, (_, i) => `2026-10-31T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z WARN  db pool: connection ${i} timed out, retrying`),
  '2026-10-31T10:07:00Z ERROR  request failed: ECONNREFUSED 10.0.0.5:5432',
  ...Array.from({ length: 60 }, (_, i) => `    at Object.query (/app/node_modules/pg/lib/client.js:${100 + i}:11)`),
].join('\n');

const jsFile = Array.from({ length: 900 }, (_, i) => `export const handler${i} = (req) => {   \n  return process(req, ${i});\n};\n\n\n`).join('');

const pyFile = Array.from({ length: 60 }, (_, i) => `
# ---------------------------------------------------------------
# Handler ${i}: validates input and writes the result to the store.
# ---------------------------------------------------------------
def handle_${i}(request, store, *, retries=3):
    """Validate the request and persist it.

    Args:
        request: incoming payload
        store: storage backend
    Returns:
        the stored record id
    """
    # make sure the payload is well formed
    if not request.get("id"):
        raise ValueError("missing id")
    for attempt in range(retries):
        try:
            return store.put(request["id"], request)  # write through
        except TimeoutError:
            continue
    raise RuntimeError("store unavailable after ${i} tries")
`).join('\n');

const templates = [
  "import { useState } from 'react';", "export default function Button(props) {", "  const [open, setOpen] = useState(false);",
  "  // TODO: handle disabled state", "  return <button onClick={() => setOpen(!open)}>{props.label}</button>;",
];
const grep = Array.from({ length: 500 }, (_, i) => `src/components/Widget${i % 40}.tsx:${10 + (i % 90)}:${pick(templates)}`).join('\n');

const events = JSON.stringify(
  Array.from({ length: 120 }, (_, i) => {
    const t = i % 3;
    if (t === 0) return { type: 'click', ts: 1700000000 + i, x: Math.floor(rnd() * 900), y: Math.floor(rnd() * 600), target: { id: `btn-${i}`, tag: 'button' } };
    if (t === 1) return { type: 'api', ts: 1700000000 + i, url: `/v1/items/${i}`, status: pick([200, 200, 404, 500]), ms: Math.floor(rnd() * 800), headers: { 'x-req': `r${i}`, 'content-type': 'application/json' } };
    return { type: 'nav', ts: 1700000000 + i, from: `/page/${i}`, to: `/page/${i + 1}`, referrer: null };
  }), null, 2);

const prose = 'Please note that it is important to remember that the quick brown fox jumps.   \n\n\n\n'.repeat(60);

const toolMsgs = (content) => [
  { role: 'user', content: 'Look into the issue.' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'run_query', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
  { role: 'assistant', content: 'Got it. Anything else to check?' },
  { role: 'user', content: 'Summarize what you found.' },
];

const result = (id, content) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] });
const call = (id) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'tool', input: {} }] });
const agentConvo = [
  { role: 'user', content: 'Investigate the failing checkout flow.' },
  call('a'), result('a', jsFile), call('b'), result('b', apiList), call('c'), result('c', logs),
  call('d'), result('d', jsFile), { role: 'assistant', content: 'I have what I need.' },
  { role: 'user', content: 'Summarize the root cause.' },
];

module.exports = [
  ['JSON API response (150 records)', toolMsgs(apiList)],
  ['Server log with retry storm', toolMsgs(logs)],
  ['JavaScript source file', toolMsgs(jsFile)],
  ['Python source with comments', toolMsgs(pyFile)],
  ['grep results (500 hits)', toolMsgs(grep)],
  ['Mixed-shape JSON events', toolMsgs(events)],
  ['Verbose prose', toolMsgs(prose)],
  ['Agent conversation (5 tool results)', agentConvo],
];
