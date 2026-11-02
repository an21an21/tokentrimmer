# tokentrim

A local proxy that sits between your app and the Anthropic or OpenAI API and
compresses requests before they are sent. Zero dependencies, Node 18+.

```
your app  ->  tokentrim (localhost:8787)  ->  api.anthropic.com / api.openai.com
```

## Run

```
npm start
# Anthropic SDK:  ANTHROPIC_BASE_URL=http://localhost:8787
# OpenAI SDK:     OPENAI_BASE_URL=http://localhost:8787/v1
# Dashboard:      http://localhost:8787/
```

Start with `DRY_RUN=1 npm start` first. Requests are measured and the dashboard
shows what you would save, but the original request is forwarded unchanged.

## What it compresses

| Technique | Mode | Lossless |
|---|---|---|
| Whitespace, ANSI codes, blank-line runs | safe | yes |
| JSON minify | safe | yes |
| A top-level JSON array of objects becomes a compact text table (`[table N rows] cols`, then one CSV-style row per object); nested objects become dotted columns and the header says `nested` | safe | yes |
| Arrays with a few mixed shapes become one table per shape plus an `[order N]` line that restores the original sequence | safe | yes |
| Log lines sharing a template: templates listed once, each line written as `~N|var|var`, original order kept | safe | yes |
| Tables nested inside a larger JSON object keep a JSON form (`{"_table":{cols,rows}}`) | safe | yes |
| grep-style `path/file:line:text` output: each directory written once as an `@ dir/` header | safe | yes |
| Identical tool results sent again later become a one-line reference | safe | yes |
| A run of 4+ lines already shown verbatim in an earlier tool result becomes `[tokentrim: lines A-B of the tool result in message M repeated here]` | safe | yes |
| Drop null / empty JSON fields and all-empty table columns | balanced | no |
| Collapse runs of similar log lines (first and last kept, count shown) | balanced | no |
| Cap huge outputs: head and tail kept, middle omitted and labelled | aggressive | no |
| Opt-in (`TOKENTRIM_STALE_AFTER`): tool results older than about N messages are capped hard (`TOKENTRIM_STALE_CHARS`). The cutoff moves in steps (`TOKENTRIM_STALE_STEP`), so each result changes once and the prompt cache breaks once per step, not every turn. **Experimental:** on its own it cut recall of old details to 35% in the accuracy test below; use it with retrieval | balanced, aggressive | no |
| Opt-in (`TOKENTRIM_RETRIEVE=1`, Anthropic `/v1/messages`): a shortened tool result ends with `[tokentrim: shortened; full text via tokentrim_retrieve {"id":"…"}]`. The proxy adds that tool to every request and answers the model's calls itself, so the client never sees them | any lossy mode | restores content on demand |

Never touched: system prompts, tool definitions, plain-text turns. Only tool results are rewritten, and a
message's rewritten form never changes as the conversation grows (the stale cutoff is the one exception, below).
That keeps the history append-only, which prompt caching and Claude's signed thinking blocks both need.
Tool results are processed, except results from file-content tools (`Read`, `Edit`,
`Write`, `read_file`, `view`, `str_replace_editor`, `skill`, including MCP-prefixed
names such as `mcp__fs__read_file`). Those are never rewritten, because edit tools
match text verbatim, but an identical repeated result is still replaced by a one-line
reference. Override the list with `TOKENTRIM_EXCLUDE_TOOLS=name1,name2`. Compression is deterministic, so a repeated
prefix stays identical between requests and provider prompt caching keeps working.

## Config

| Env var | Default |
|---|---|
| `PORT` | 8787 |
| `TOKENTRIM_MODE` | balanced (`safe`, `balanced`, `aggressive`) |
| `DRY_RUN` | off (`1` to measure only) |
| `TOKENTRIM_VERIFY` | on (`0` to disable the runtime check) |
| `TOKENTRIM_EXCLUDE_TOOLS` | read, read_file, view, edit, multiedit, write, notebookedit, str_replace_editor, skill |
| `ANTHROPIC_UPSTREAM` | https://api.anthropic.com |
| `OPENAI_UPSTREAM` | https://api.openai.com |
| `TOKENTRIM_STALE_AFTER` | off (e.g. `10`; ignored in safe mode) |
| `TOKENTRIM_STALE_CHARS` | 1000 |
| `TOKENTRIM_STALE_STEP` | 20 |
| `TOKENTRIM_RETRIEVE` | off (`1` to add the retrieval tool; Anthropic only) |

Per request: header `x-tokentrim-mode: safe|balanced|aggressive` and
`x-tokentrim-dry-run: 1`. These headers are not forwarded upstream.

`POST /compress` with `{"text": "...", "mode": "balanced"}` returns compressed text
for use outside the proxy. `GET /stats` returns the numbers the dashboard shows.

## Verification

Every rewritten request is checked before it is sent. The verifier (`src/verify.js`) decodes
each changed string back and compares it with the original:

| Status | Meaning |
|---|---|
| exact | decodes to the identical text |
| whitespace-normalized | identical apart from trailing spaces, blank-line runs and ANSI codes |
| equivalent | identical JSON value (layout and number formatting may differ, for example `1.0` becomes `1`) |
| lossy | a deliberately lossy technique ran (drop empty fields, collapse logs, cap output) |
| FAILED | the decoded text does not match |

In the proxy, a FAILED check means your original request is sent unchanged and the dashboard
shows "FAILED, original sent". Safe mode never reports lossy.

Check any saved request offline:

```
npm run verify -- request.json balanced
```

It prints each changed field with its status and exits non-zero on a failure.

Guards that came out of fuzz testing: JSON containing integers of 16 or more digits (they
would lose precision when re-serialized) or a `__proto__` key is left alone, and grep
grouping is skipped when a leftover line looks like a stripped grep row.
The test suite fuzzes JSON, logs and grep output with random shapes, nasty strings, nested
objects and look-alike lines, and decodes every result.

## Measured results

`npm run bench`, synthetic payloads, token counts estimated:

| Payload | safe | balanced | aggressive |
|---|---|---|---|
| JSON API response, 150 records | 71% | 78% | 78% |
| Server log with retry storm | 62% | 99% | 99% |
| Large source file | 6% | 6% | 82% |
| Whole agent conversation, 5 tool results | 59% | 65% | 89% |

## Compared with Headroom

Same 8 synthetic payloads run through tokentrim and Headroom 0.42.0 (`headroom.compress`,
default settings), one identical counter (about 4 characters per token) over the whole
message list. Reproduce with `compare/export.js` then `compare/run_headroom.py`.

| Payload | tokentrim safe (lossless) | tokentrim balanced | Headroom |
|---|---|---|---|
| JSON API response, 150 records | 74% | 78% | 72% |
| Mixed-shape JSON events | 73% | 74% | 73% |
| grep results, 500 hits | 20% | 20% | 20% |
| Server log, retry storm | 61% | 98% | 10% |
| JavaScript source file | 6% | 6% | 0% |
| Python source with comments | 0% | 0% | 0% |
| Verbose prose | 8% | 8% | 0% |
| Agent conversation, 5 tool results | 59% | 65% | 17% |
| Total | 44% | 50% | 20% |

How to read this:
- Safe mode is the like-for-like column: Headroom's output on JSON, logs and grep kept every
  row. Safe mode is verified lossless by decoder round-trip tests (`src/formats.js`).
- Balanced and aggressive win by omitting content and are not comparable.
- The counter is characters divided by four. Real tokenizers may count digits, punctuation and
  CSV-style rows differently, so real savings can be lower or higher. Use dry run: the
  dashboard's "billed input" column is the real figure.
- Headroom was tested with default settings through its library call, not its proxy or its
  more aggressive profiles. The data is synthetic.
- Not tested: whether a model reads tokentrim's table and template formats as accurately as
  the original text. Check that on your own tasks before relying on non-trivial savings.

## Thinking blocks

Current Claude models sign each thinking block over the system prompt, the tool list and every earlier message,
and reject (or, if the request opts in, drop) a block whose history changed. tokentrim is built around that:

- Rewrites are append-only: a message is compressed the same way on every request, so old blocks stay valid.
- Retrieval keeps the thinking from the model's first response, which still matches its history, and leaves out
  thinking produced after a hidden retrieval turn, since the client will replay the turn without it.
- Moving the stale cutoff does rewrite old messages. On those requests, if the history contains thinking blocks
  and thinking is adaptive, tokentrim sets `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` with the
  `thinking-binding-controls-2026-08-01` beta header, so mismatched blocks are dropped instead of failing the request.
- Starting the proxy, or changing its settings, in the middle of a session also changes the history. Start new
  sessions after changing the setup.

## Real sessions

The synthetic numbers above flatter tokentrim: they are the shapes it was built for. `compare/real/` repeats the
comparison on real Claude Code sessions (9 of the author's own, mostly browser automation and assistant work),
tokens counted with tiktoken o200k_base, Headroom 0.42.0 in library mode. Savings:

| | Final request | Cache-weighted cost, whole session |
|---|---|---|
| tokentrim safe | 3.3% | 2.5% |
| tokentrim aggressive | 10.8% | 9.1% |
| tokentrim balanced + `TOKENTRIM_STALE_AFTER=10` | 27.4% | 14.5% |
| Headroom (default, coding, general, agent-90 profiles alike) | 1.0% | 1.0% |

Cache-weighted cost replays each session request by request, priced as prompt caching bills it (0.1x for the prefix
shared with the previous request, 1.25x for the rest). Rewriting old messages re-bills everything after them, which is
why stale mode's saving roughly halves there.

Accuracy: 140 questions over 8 of the sessions, each quoting a line from an old tool result and asking for the line
after it (exact match), answered by Claude Opus 5.5 through `claude -p` with each compressed conversation:

| | Correct | Answered UNKNOWN | Wrong guess |
|---|---|---|---|
| original | 100% | 0 | 0 |
| tokentrim safe | 100% | 0 | 0 |
| tokentrim aggressive | 86% | 18 | 1 |
| tokentrim balanced + stale 10 | 35% | 89 | 2 |
| Headroom default | 95% | 3 | 4 |

Safe mode matched the original, including answers that had to be found by following a repeated-block reference.
Stale mode loses most old detail; leave it off unless your sessions never need to look back. Recall of exact lines
is a harsh test: it does not show whether a task still succeeds. The sample is small and from one person's work.

## Limits

- Savings come from rules, not understanding. Code is not minified, so source files
  only shrink in aggressive mode, by cutting the middle.
- Safe mode is lossless in meaning, not always byte for byte: whitespace cleanup, JSON
  layout and duplicate JSON keys (the last one wins) are not preserved.
- Only a top-level JSON array becomes a text table. An object that wraps an array
  (`{"users":[...]}`) keeps the JSON `_table` form for that array.
- Token counts are estimates. The dashboard also shows the "billed input" the API
  reported, which is the real figure.
- Non-lossless modes can remove information the model needs. Balanced and
  aggressive are labelled in the output so the model knows something was omitted.
- Streaming works (responses are piped through). Only `/v1/messages` and
  `/v1/chat/completions` request bodies are rewritten; other routes pass through.
- Tested against a mock upstream only, not live API traffic.
