#!/usr/bin/env node
'use strict';
// Minimal stdio MCP server exposing tokentrim_retrieve over a saved store, so the accuracy test can
// let headless Claude Code (`claude -p`) use retrieval exactly as the proxy would answer it.
//   node compare/real/retrieve_mcp.js out/store/<case>.json
// The store file is {"<id>": "<original text>", ...} written by run_tokentrim.js.
const fs = require('node:fs');
const readline = require('node:readline');
const { TOOL, answer } = require('../../src/retrieve');

const store = new Map(Object.entries(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))));
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.id === undefined) return; // notifications need no reply
  const reply = (result) => send({ jsonrpc: '2.0', id: req.id, result });
  switch (req.method) {
    case 'initialize':
      return reply({
        protocolVersion: (req.params && req.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'tokentrim', version: '0.1.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: [{ name: TOOL.name, description: TOOL.description, inputSchema: TOOL.input_schema }] });
    case 'tools/call': {
      const r = answer((req.params && req.params.arguments) || {}, store);
      return reply({ content: [{ type: 'text', text: r.content }], isError: Boolean(r.is_error) });
    }
    default:
      return send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `unknown method ${req.method}` } });
  }
});
