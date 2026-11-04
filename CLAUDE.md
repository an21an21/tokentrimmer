# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

TokenTrimmer is a zero-dependency Node 18+ local proxy (default port 8787) that compresses Anthropic `/v1/messages` and OpenAI `/v1/chat/completions` request bodies before forwarding them upstream. Keep it dependency-free: only `node:` built-ins.

## Commands

```bash
npm start                                  # run proxy (src/cli.js); --dry-run / DRY_RUN=1 measures without rewriting
node src/cli.js --help                     # CLI: claude [args] | doctor | savings | stop; options before the command
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
node compare/real/run_tokentrimmer.js         # each config: output, timing, determinism, verifier verdict, cache replay
<venv>/bin/python compare/real/run_headroom.py   # Headroom profiles + o200k tokens + cache replay -> out/report.md (--no-replay is fast)
```

Proxy-vs-proxy replay (needs `headroom-ai[proxy]==0.42.0`): start `node compare/real/capture_upstream.js 8790`, start each proxy with its upstream pointed there (`ANTHROPIC_UPSTREAM=http://127.0.0.1:8790`, Headroom `--anthropic-api-url`), then `<venv>/bin/python compare/real/run_proxies.py --capture=http://127.0.0.1:8790 "name=http://127.0.0.1:PORT" ...` -> `out/proxies.md`. Restart proxies between runs (Headroom's cache mode keeps per-conversation state). Never use port 8787 for benchmark proxies: it may be the proxy the current session runs through.

## Architecture

Entry point: `src/cli.js` (npm `bin`) parses flags and commands, then calls `proxy.start()`. Request flow: `proxy.js` → `messages.js` → `compress.js` (+ `formats.js`) → `verify.js` → upstream (→ `retrieve.js` loop when `TOKENTRIMMER_RETRIEVE=1`).

- **src/proxy.js** — HTTP server (`createServer`). Reads per-request headers `x-tokentrimmer-mode` / `x-tokentrimmer-dry-run` (stripped before forwarding), rewrites only the two message routes, pipes everything else and streaming responses through, serves `dashboard.html`, `/stats`, `/health` (version, mode), `/inspect?id=` (original vs sent strings of the last 10 rewritten requests, memory only, off for non-loopback hosts) and `POST /compress`. If verification reports FAILED, the original body is sent unchanged. The dashboard renders request content, so everything it shows must go through its `esc()`.
  Config comes from env (`PORT`, `HOST` (default `127.0.0.1`), `TOKENTRIMMER_MODE`, `DRY_RUN=1`, `TOKENTRIMMER_VERIFY=0`, `ANTHROPIC_UPSTREAM`, `OPENAI_UPSTREAM`, `TOKENTRIMMER_EXCLUDE_TOOLS`, `TOKENTRIMMER_STALE_AFTER`/`_CHARS`/`_STEP`, `TOKENTRIMMER_RETRIEVE`) or the `createServer(config)` argument, which overrides env. `test/proxy.test.js` uses the latter to point at a mock upstream. `createServer` writes nothing to disk unless `historyFile` is given; the CLI passes `~/.tokentrimmer/stats.json` (`TOKENTRIMMER_HOME`).
- **src/cli.js** — Commands: start (default), `claude` (starts a detached proxy if `/health` fails, pid/log in `~/.tokentrimmer/`, then spawns `claude` with `ANTHROPIC_BASE_URL`; a running proxy in another mode gets `x-tokentrimmer-mode` via `ANTHROPIC_CUSTOM_HEADERS`), `doctor` (exit 0/1/2), `savings`, `stop` (checks `/health` before signalling the saved pid). Tests run it with `TOKENTRIMMER_HOME` set to a temp dir; never use port 8787 in tests or benchmarks.
- **src/history.js** — Lifetime counts only (never content). Each proxy adds its pending deltas to what is on disk at flush (every 5 s and on exit), writing through tmp + rename, so several proxies can share the file.
- **src/messages.js** — Walks Anthropic and OpenAI message shapes. Never touches system prompts, tool definitions, or plain-text turns (`opts.plainText` re-enables cleanup of older turns, which is a history edit). Tool results from file-content tools (`DEFAULT_EXCLUDE_TOOLS`, incl. MCP-prefixed names; override via `TOKENTRIMMER_EXCLUDE_TOOLS`) are never rewritten, but identical repeated tool results anywhere are replaced with a one-line reference (hash-based). Identical repeats become `[same as a tool result in message M]`. Lines the model already has verbatim become `[same as message M lines A-B]` (an earlier tool result) or `[same as lines A-B above]` (same result); line numbers count the referenced text *as sent*, every sent result is indexed (up to 16 sites per line, longest run wins), reference lines are never pointed at, and references may sit inside an already-compressed form. Thresholds `BLOCK_WINDOW`/`BLOCK_MIN_CHARS`/`BLOCK_RATIO` (1 line, 60 chars, 2x the reference) were tuned on real sessions; no references when the original has look-alike lines. `toolTexts()` defines "tool result K" numbering for both encoder and verifier. Opt-in `staleAfter` (env `TOKENTRIMMER_STALE_AFTER`, never in safe mode) compresses tool results before a cutoff with `staleOptions()` (aggressive, small cap); the cutoff `floor((len - staleAfter) / staleStep) * staleStep` moves in steps so the cached prefix breaks once per step.
- **src/retrieve.js** — With `opts.retrieve`, lossy tool results end with a `tokentrimmer_retrieve {"id":…}` note (id = sha1 of the original, stored in `compressRequest(...).store`, rebuilt from every request since clients resend full history). The proxy adds the tool to every Anthropic request and answers calls in `complete()` (JSON) / `stream()` (SSE, re-indexes stitched blocks). Thinking blocks from follow-up rounds are not returned to the client; each retrieval leaves a `[tokentrimmer_retrieve call <id> …]` text block in the client's turn, and `createMemory()`/`expand()` restore the exact hidden turns when the client replays it (in-memory, per proxy process). A retrieve call mixed with client tool calls is dropped. `tokentrimmer_retrieve` results are never compressed. `allowEditedHistory()` adds `drop_block` + beta header when the stale cutoff rewrites a history containing thinking blocks.
- **src/compress.js** — `compressText(input, {mode})` with modes `safe` (lossless), `balanced` (drops empties, collapses repeated logs), `aggressive` (caps output head/tail). Detects JSON / logs / grep output and applies the matching technique.
- **src/formats.js** — Encoders *and decoders* for the compact formats (`[table N rows]`, `[order N]`, `_table` JSON form, log templates `~N|…`, grep `@ dir/` groups). Every encoding must have a decoder here.
- **src/verify.js** — Decodes each changed string via `formats.js` and classifies it: exact / whitespace-normalized / equivalent / lossy / FAILED. Block references are expanded against the compressed (sent) body, then the result is classified as usual.

## Invariants to preserve

- Compression must be deterministic and append-only (prompt caching, and Claude thinking-block signatures cover the system prompt, tools and every earlier message — an edited history gets a 400 on enforced accounts). A message's compressed form may depend only on earlier messages and the stale cutoff, never on later ones; `test/verify.test.js` checks that the prefix stays byte-identical between consecutive requests unless the cutoff moved.
- Judge lossy changes by cache-weighted cost (`compare/real` replay), not single-request savings: changing an old message re-bills everything after it.
- Safe mode must round-trip through the decoders; it must never produce a `lossy` status. Adding a new encoding means adding its decoder and fuzz coverage in `test/verify.test.js` / `test/compress.test.js`.
- Fuzz-derived guards: JSON with integers of 16+ digits or a `__proto__` key is left alone; grep grouping is skipped when a leftover line looks like a stripped grep row.
- Only top-level JSON arrays become text tables; nested arrays use the `{"_table":{cols,rows}}` JSON form.
