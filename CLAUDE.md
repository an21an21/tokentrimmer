# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

tokentrim is a zero-dependency Node 18+ local proxy (default port 8787) that compresses Anthropic `/v1/messages` and OpenAI `/v1/chat/completions` request bodies before forwarding them upstream. Keep it dependency-free: only `node:` built-ins.

## Commands

```bash
npm start                                  # run proxy; DRY_RUN=1 to measure without rewriting
npm test                                   # node --test test/*.test.js
node --test test/compress.test.js          # single test file
node --test --test-name-pattern="grep" test/*.test.js   # single test by name
npm run bench                              # synthetic savings per mode (root bench.js)
npm run verify -- request.json balanced    # offline verify of a saved request
```

`compare/export.js` + `compare/run_headroom.py` reproduce the synthetic Headroom comparison in the README.

Real-session benchmark (the one that matters; synthetic payloads overstate savings). Needs a venv with `headroom-ai==0.42.0 tiktoken`:

```bash
python3 compare/real/extract.py            # ~/.claude/projects sessions -> compare/real/out/cases.json (local, git-ignored)
node compare/real/run_tokentrim.js         # each config: output, timing, determinism, verifier verdict, cache replay
<venv>/bin/python compare/real/run_headroom.py   # Headroom profiles + o200k tokens + cache replay -> out/report.md (--no-replay is fast)
```

## Architecture

Request flow: `proxy.js` → `messages.js` → `compress.js` (+ `formats.js`) → `verify.js` → upstream.

- **src/proxy.js** — HTTP server (`createServer`). Reads per-request headers `x-tokentrim-mode` / `x-tokentrim-dry-run` (stripped before forwarding), rewrites only the two message routes, pipes everything else and streaming responses through, serves `dashboard.html`, `/stats`, and `POST /compress`. If verification reports FAILED, the original body is sent unchanged.
  Config comes from env (`PORT`, `TOKENTRIM_MODE`, `DRY_RUN=1`, `TOKENTRIM_VERIFY=0`, `ANTHROPIC_UPSTREAM`, `OPENAI_UPSTREAM`, `TOKENTRIM_EXCLUDE_TOOLS`, `TOKENTRIM_STALE_AFTER`/`_CHARS`/`_STEP`) or the `createServer(config)` argument, which overrides env. `test/proxy.test.js` uses the latter to point at a mock upstream.
- **src/messages.js** — Walks Anthropic and OpenAI message shapes. Never touches system prompts, tool definitions, or the last 2 messages' plain text. Tool results from file-content tools (`DEFAULT_EXCLUDE_TOOLS`, incl. MCP-prefixed names; override via `TOKENTRIM_EXCLUDE_TOOLS`) are never rewritten, but identical repeated tool results anywhere are replaced with a one-line reference (hash-based). Runs of 4+ lines (100+ chars) that already appeared in an earlier tool result sent *unchanged* become `[tokentrim: lines A-B of … in message M repeated here]`; only unchanged results (incl. excluded tools) are indexed as sources, so a reference always points at text the model sees verbatim. `toolTexts()` defines "tool result K" numbering for both encoder and verifier. Opt-in `staleAfter` (env `TOKENTRIM_STALE_AFTER`, never in safe mode) compresses tool results before a cutoff with `staleOptions()` (aggressive, small cap); the cutoff `floor((len - staleAfter) / staleStep) * staleStep` moves in steps so the cached prefix breaks once per step.
- **src/compress.js** — `compressText(input, {mode})` with modes `safe` (lossless), `balanced` (drops empties, collapses repeated logs), `aggressive` (caps output head/tail). Detects JSON / logs / grep output and applies the matching technique.
- **src/formats.js** — Encoders *and decoders* for the compact formats (`[table N rows]`, `[order N]`, `_table` JSON form, log templates `~N|…`, grep `@ dir/` groups). Every encoding must have a decoder here.
- **src/verify.js** — Decodes each changed string via `formats.js` and classifies it: exact / whitespace-normalized / equivalent / lossy / FAILED. Block references are decoded against both the original and the compressed body.

## Invariants to preserve

- Compression must be deterministic (keeps provider prompt caching working across requests). A message's compressed form may depend only on earlier messages and the stale cutoff, never on later ones; `test/verify.test.js` checks that the prefix stays byte-identical between consecutive requests unless the cutoff moved.
- Judge lossy changes by cache-weighted cost (`compare/real` replay), not single-request savings: changing an old message re-bills everything after it.
- Safe mode must round-trip through the decoders; it must never produce a `lossy` status. Adding a new encoding means adding its decoder and fuzz coverage in `test/verify.test.js` / `test/compress.test.js`.
- Fuzz-derived guards: JSON with integers of 16+ digits or a `__proto__` key is left alone; grep grouping is skipped when a leftover line looks like a stripped grep row.
- Only top-level JSON arrays become text tables; nested arrays use the `{"_table":{cols,rows}}` JSON form.
