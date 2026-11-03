#!/usr/bin/env python3
"""Accuracy check: can the model still answer from compressed context?

For each session in compare/real/out/cases.json, questions are generated deterministically from the
ORIGINAL tool results: each quotes one line and asks for the line that follows it in the same result.
Only unambiguous pairs are used (every occurrence of the quoted line is followed by the same line).
Questions are drawn from three strata per session: uniform over all tool-result lines, lines that
tokentrimmer (balanced+stale10) no longer shows verbatim, and lines Headroom no longer shows verbatim.

Every condition (original, tokentrimmer configs, Headroom default) gets the same questions in one API call
appended after its compressed conversation. Answers are graded by exact match (whitespace-trimmed).

Needs the venv used by run_headroom.py. Default backend is headless Claude Code (`claude -p`, your login);
--backend api uses the Anthropic SDK (pip install anthropic) and ANTHROPIC_API_KEY. Run
run_tokentrimmer.js first.

  python compare/real/eval_accuracy.py --dry-run             # questions, presence stats, cost estimate; no API calls
  python compare/real/eval_accuracy.py [--model M] [--effort E]
Writes compare/real/out/questions.json, accuracy.json and accuracy.md.

This sends your session content to the Anthropic API.
"""
import argparse, copy, json, os, random, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
CONDITIONS = ["original", "tt safe", "tt aggressive", "tt balanced+stale10", "tt balanced+stale10+retrieve", "hr default"]
# Conditions whose shortened results can be read back through the tokentrimmer_retrieve tool (MCP in headless mode).
RETRIEVE = {"tt balanced+stale10+retrieve"}
PER_STRATUM = {"uniform": 8, "tt-changed": 8, "hr-changed": 4}
MIN_LINE = 16
INSTRUCTIONS = (
    "Answer from the conversation above only. Each question quotes one line from an earlier tool result. "
    "Give the line that comes immediately after it in that same tool result, copied exactly. "
    "If the conversation shows that some lines were omitted or replaced by a reference, use whatever the "
    "conversation tells you. If you cannot find the answer, answer exactly UNKNOWN.\n\n"
)
SCHEMA = {
    "type": "object",
    "properties": {"answers": {"type": "array", "items": {
        "type": "object",
        "properties": {"id": {"type": "integer"}, "answer": {"type": "string"}},
        "required": ["id", "answer"], "additionalProperties": False}}},
    "required": ["answers"], "additionalProperties": False,
}


def tool_texts(messages):
    """(message index, text) for every tool-result text."""
    for i, m in enumerate(messages):
        if not isinstance(m.get("content"), list):
            continue
        for b in m["content"]:
            if isinstance(b, dict) and b.get("type") == "tool_result":
                c = b.get("content")
                for s in ([c] if isinstance(c, str) else [p.get("text", "") for p in (c or []) if isinstance(p, dict)]):
                    if isinstance(s, str):
                        yield i, s


def all_strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, list):
        for x in node:
            yield from all_strings(x)
    elif isinstance(node, dict):
        for x in node.values():
            yield from all_strings(x)


def present(messages, line):
    return any(line in s for s in all_strings(messages))


def make_questions(name, original, conds):
    followers = {}
    for _, s in tool_texts(original):
        ls = s.split("\n")
        for a, b in zip(ls, ls[1:]):
            followers.setdefault(a, set()).add(b)
    cands = []
    for i, s in tool_texts(original):
        if i >= len(original) - 4:  # the newest turns are trivially in view
            continue
        ls = s.split("\n")
        for a, b in zip(ls, ls[1:]):
            if len(a.strip()) >= MIN_LINE and len(b.strip()) >= MIN_LINE and a != b and len(followers[a]) == 1 and len(a) < 400 and len(b) < 400:
                cands.append({"message": i, "quote": a, "answer": b})
    seen, uniq = set(), []
    for c in cands:
        if c["quote"] not in seen:
            seen.add(c["quote"])
            uniq.append(c)
    rnd = random.Random(name)
    strata = {
        "uniform": uniq,
        "tt-changed": [c for c in uniq if not present(conds["tt balanced+stale10"], c["answer"])],
        "hr-changed": [c for c in uniq if not present(conds["hr default"], c["answer"])],
    }
    picked, used = [], set()
    for stratum, n in PER_STRATUM.items():
        pool = [c for c in strata[stratum] if c["quote"] not in used]
        for c in rnd.sample(pool, min(n, len(pool))):
            used.add(c["quote"])
            picked.append({**c, "stratum": stratum})
    for k, q in enumerate(picked, 1):
        q["id"] = k
        q["present"] = {cn: present(cm, q["answer"]) for cn, cm in conds.items()}
    return picked


def question_message(qs):
    body = INSTRUCTIONS + "\n".join(f"Q{q['id']}: {q['quote']}" for q in qs)
    return {"role": "user", "content": body}


def stub_tools(messages):
    names = sorted({b["name"] for m in messages if isinstance(m.get("content"), list)
                    for b in m["content"] if isinstance(b, dict) and b.get("type") == "tool_use"})
    return [{"name": n, "description": "Tool used earlier in this conversation.", "input_schema": {"type": "object"}} for n in names]


def grade(expected, got):
    return got.strip() == expected.strip()


def grade_loose(expected, got):
    # Credit an answer that contains the line plus a little framing ("The next line is: ...").
    e, g = expected.strip(), got.strip()
    return bool(e) and e in g and len(g) <= len(e) + 40


def render_transcript(messages):
    """Plain-text transcript for headless mode. Message numbers match the request's messages array,
    so tokentrimmer's "message M" / "tool result K" references stay meaningful."""
    out = []
    for i, m in enumerate(messages):
        out.append(f"=== message {i} ({m.get('role')}) ===")
        c = m.get("content")
        if isinstance(c, str):
            out.append(c)
            continue
        for b in c or []:
            if not isinstance(b, dict):
                continue
            t = b.get("type")
            if t == "text":
                out.append(b.get("text", ""))
            elif t == "tool_use":
                out.append(f"[tool call {b.get('name')} id={b.get('id')}] {json.dumps(b.get('input'), ensure_ascii=False)}")
            elif t == "tool_result":
                cc = b.get("content")
                parts = [cc] if isinstance(cc, str) else [p.get("text", "") for p in (cc or []) if isinstance(p, dict)]
                for k, p in enumerate(parts):
                    out.append(f"[tool result for id={b.get('tool_use_id')}]")
                    out.append(p)
                    out.append("[end of tool result]")
    return "\n".join(out)


HEADLESS_SYSTEM = ("You answer questions about a recorded conversation transcript that is given to you in full. "
                   "Use only the transcript. Do not use tools.")


RETRIEVE_SYSTEM = ("You answer questions about a recorded conversation transcript that is given to you in full. "
                   "Use only the transcript. Some tool results in it were shortened and end with a note naming an id; "
                   "the only tool you have, tokentrimmer_retrieve, returns the original text for such an id.")


def store_file(name):
    import re
    return os.path.join(OUT, "store", re.sub(r"[^A-Za-z0-9_-]", "_", name) + ".json")


def ask_headless(conds_msgs, qs, model, effort, cwd, store=None):
    """One `claude -p` call. Uses the local Claude Code login; returns (answers dict, cost, error).
    With store (a saved id -> original map), the retrieval tool is offered through a local MCP server."""
    import subprocess
    prompt = ("<transcript>\n" + render_transcript(conds_msgs) + "\n</transcript>\n\n"
              + question_message(qs)["content"]
              + "\n\nReturn each answer as only the line itself, with no extra words.")
    cmd = ["claude", "-p", "--model", model, "--effort", effort, "--tools", "", "--no-session-persistence",
           "--system-prompt", RETRIEVE_SYSTEM if store else HEADLESS_SYSTEM,
           "--output-format", "json", "--json-schema", json.dumps(SCHEMA)]
    if store:
        server = {"command": "node", "args": [os.path.join(HERE, "retrieve_mcp.js"), store]}
        cmd += ["--strict-mcp-config", "--mcp-config", json.dumps({"mcpServers": {"tt": server}}),
                "--allowedTools", "mcp__tt__tokentrimmer_retrieve"]
    p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, cwd=cwd, timeout=1800)
    try:
        d = json.loads(p.stdout)
    except ValueError:
        return None, 0.0, f"exit {p.returncode}: {(p.stderr or p.stdout)[:200]}"
    if d.get("is_error") or not isinstance(d.get("structured_output"), dict):
        return None, d.get("total_cost_usd", 0.0), f"{d.get('subtype')}: {str(d.get('result'))[:200]}"
    return {x["id"]: x["answer"] for x in d["structured_output"].get("answers", [])}, d.get("total_cost_usd", 0.0), None


def load_conditions():
    cases = json.load(open(os.path.join(OUT, "cases.json")))
    tt = {r["name"]: r for r in json.load(open(os.path.join(OUT, "tokentrimmer.json")))}
    import headroom  # imported late so --help works without it
    out = []
    for c in cases:
        conds = {"original": c["original"]}
        for m in ("safe", "aggressive", "balanced+stale10", "balanced+stale10+retrieve"):
            conds["tt " + m] = tt[c["name"]]["modes"][m]["messages"]
        conds["hr default"] = headroom.compress(copy.deepcopy(c["original"]), model="claude-sonnet-4-5-20250929").messages
        out.append((c["name"], conds))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--model", default="claude-opus-5-5")
    ap.add_argument("--effort", default="medium")
    ap.add_argument("--price", type=float, default=4.0, help="input $ per 1M tokens, for the estimate")
    ap.add_argument("--backend", choices=["headless", "api"], default="headless",
                    help="headless: `claude -p` with your Claude Code login (transcript as text); api: Anthropic SDK, needs a key")
    ap.add_argument("--workers", type=int, default=3, help="parallel headless calls")
    ap.add_argument("--no-resume", dest="resume", action="store_false",
                    help="ignore out/accuracy.json and rerun every call")
    a = ap.parse_args()

    sessions = load_conditions()
    qsets = []
    for name, conds in sessions:
        qs = make_questions(name, conds["original"], conds)
        if qs:
            qsets.append((name, conds, qs))
    json.dump([{"name": n, "questions": q} for n, _, q in qsets], open(os.path.join(OUT, "questions.json"), "w"), indent=1)

    nq = sum(len(q) for _, _, q in qsets)
    print(f"{nq} questions over {len(qsets)} sessions")
    for cn in CONDITIONS:
        lit = sum(q["present"][cn] for _, _, qs in qsets for q in qs)
        print(f"  {cn:22} answer line shown verbatim for {lit}/{nq}")

    if a.dry_run:
        import tiktoken
        enc = tiktoken.get_encoding("o200k_base")
        toks = sum(len(enc.encode(json.dumps(c, ensure_ascii=False), disallowed_special=()))
                   for _, conds, _ in qsets for c in conds.values())
        est = toks * 1.3  # o200k is only a proxy for Claude's tokenizer; pad for the difference
        print(f"{len(qsets) * len(CONDITIONS)} API calls, about {est / 1e6:.1f}M input tokens "
              f"-> roughly ${est / 1e6 * a.price:.0f} at ${a.price}/M input (plus a little output)")
        return

    def score(rec, qs, cn, got):
        rec["answers"] = [{"id": q["id"], "stratum": q["stratum"], "present": q["present"][cn],
                           "answer": got.get(q["id"], ""), "correct": grade(q["answer"], got.get(q["id"], "")),
                           "loose": grade_loose(q["answer"], got.get(q["id"], "")),
                           "unknown": got.get(q["id"], "").strip() == "UNKNOWN"} for q in qs]

    jobs = [(name, conds, qs, cn) for name, conds, qs in qsets for cn in CONDITIONS]
    # Resume: keep earlier successful answers (same questions), rerun only what is missing or failed.
    done = {}
    prev_path = os.path.join(OUT, "accuracy.json")
    if a.resume and os.path.exists(prev_path):
        for r in json.load(open(prev_path)):
            if "answers" in r:
                done[(r["name"], r["condition"])] = r
        print(f"resuming: {len(done)} of {len(jobs)} calls already answered")
    todo = [j for j in jobs if (j[0], j[3]) not in done]
    results = []
    if a.backend == "headless":
        import threading
        from concurrent.futures import ThreadPoolExecutor
        cwd = os.path.join(OUT, "headless_cwd")  # empty directory: no project CLAUDE.md is loaded
        os.makedirs(cwd, exist_ok=True)
        limited = threading.Event()

        def run(job):
            name, conds, qs, cn = job
            rec = {"name": name, "condition": cn}
            if limited.is_set():
                rec["error"] = "skipped: usage limit reached earlier in this run"
                return rec
            got, cost, err = ask_headless(conds[cn], qs, a.model, a.effort, cwd,
                                          store=store_file(name) if cn in RETRIEVE else None)
            if err and "limit" in err.lower():
                limited.set()
            rec["cost_usd"] = cost
            if err:
                rec["error"] = err
            else:
                score(rec, qs, cn, got)
            ok = sum(x["correct"] for x in rec.get("answers", []))
            print(f"{name:36} {cn:22} {rec.get('error') or f'{ok}/{len(qs)} correct'}  ${cost:.2f}", flush=True)
            return rec
        with ThreadPoolExecutor(a.workers) as ex:
            results = list(ex.map(run, todo))
        if limited.is_set():
            print("Usage limit reached: rerun the same command after it resets; finished answers are kept.")
    else:
        results = run_api(a, todo, score)
    results = list(done.values()) + results
    finish(a, results, nq, qsets)


def run_api(a, jobs, score):
    import anthropic
    client = anthropic.Anthropic()
    results = []
    for name, conds, qs, cn in jobs:
            msgs = conds[cn] + [question_message(qs)]
            rec = {"name": name, "condition": cn}
            try:
                with client.messages.stream(
                    model=a.model, max_tokens=16000, messages=msgs,
                    tools=stub_tools(conds[cn]), tool_choice={"type": "none"},
                    output_config={"effort": a.effort, "format": {"type": "json_schema", "schema": SCHEMA}},
                ) as stream:
                    resp = stream.get_final_message()
                rec["stop_reason"] = resp.stop_reason
                rec["usage"] = {"input": resp.usage.input_tokens, "output": resp.usage.output_tokens}
                if resp.stop_reason == "refusal":
                    rec["error"] = "refusal"
                else:
                    text = next(b.text for b in resp.content if b.type == "text")
                    score(rec, qs, cn, {x["id"]: x["answer"] for x in json.loads(text)["answers"]})
            except anthropic.BadRequestError as e:
                rec["error"] = f"bad request: {e.message[:200]}"
            except anthropic.RateLimitError as e:
                rec["error"] = f"rate limited: {e.message[:200]}"
            except anthropic.APIStatusError as e:
                rec["error"] = f"API {e.status_code}: {e.message[:200]}"
            except anthropic.APIConnectionError as e:
                rec["error"] = f"connection: {e}"
            results.append(rec)
            ok = sum(x["correct"] for x in rec.get("answers", []))
            print(f"{name:36} {cn:22} {rec.get('error') or f'{ok}/{len(qs)} correct'}", flush=True)
    return results


def finish(a, results, nq, qsets):
    json.dump(results, open(os.path.join(OUT, "accuracy.json"), "w"), indent=1)
    lines = [f"# Accuracy on compressed context ({a.model}, effort {a.effort}, {a.backend})", "",
             f"{nq} questions over {len(qsets)} sessions. Next-line recall: exact match (loose match in brackets).", "",
             "| Condition | All | Uniform | tt-changed | hr-changed | Answered UNKNOWN | Errors | Cost (USD, as reported) |",
             "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for cn in CONDITIONS:
        rs = [r for r in results if r["condition"] == cn]
        ans = [x for r in rs for x in r.get("answers", [])]

        def acc(xs):
            if not xs:
                return "n/a"
            c, l = sum(x["correct"] for x in xs), sum(x.get("loose", x["correct"]) for x in xs)
            return f"{100 * c / len(xs):.0f}% ({c}/{len(xs)}) [{100 * l / len(xs):.0f}%]"
        lines.append(f"| {cn} | {acc(ans)} | " + " | ".join(acc([x for x in ans if x["stratum"] == s]) for s in PER_STRATUM)
                     + f" | {sum(x['unknown'] for x in ans)} | {sum('error' in r for r in rs)} | {sum(r.get('cost_usd', 0) for r in rs):.2f} |")
    report = "\n".join(lines) + "\n"
    open(os.path.join(OUT, "accuracy.md"), "w").write(report)
    print(report)


if __name__ == "__main__":
    sys.exit(main())
