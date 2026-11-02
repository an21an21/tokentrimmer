#!/usr/bin/env python3
"""Build benchmark cases from real Claude Code sessions (stdlib only).

Reads session transcripts (~/.claude/projects/*/*.jsonl by default), rebuilds each main-thread
conversation as an Anthropic /v1/messages list, cuts it to a size cap, and writes
compare/real/out/cases.json. The output contains your own session content: it stays local
(compare/real/out/ is git-ignored) and is never uploaded by any script here.

  python3 compare/real/extract.py [--src DIR] [--max-bytes N] [--max-cases N] [--per-project N]
"""
import argparse, collections, glob, json, os

HERE = os.path.dirname(os.path.abspath(__file__))


def result_content(c):
    # Keep text parts only; images and screenshots are dropped.
    if isinstance(c, list):
        out = [{"type": "text", "text": b.get("text", "")} for b in c if isinstance(b, dict) and b.get("type") == "text"]
        return out or ""
    return c if isinstance(c, str) else ""


def load_session(path):
    msgs = []
    for line in open(path, errors="replace"):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get("type") not in ("user", "assistant") or d.get("isSidechain"):
            continue
        m = d.get("message")
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant"):
            continue
        c = m.get("content")
        if isinstance(c, list):
            blocks = []
            for b in c:
                if not isinstance(b, dict):
                    continue
                t = b.get("type")
                if t == "text" and b.get("text", "").strip():
                    blocks.append({"type": "text", "text": b["text"]})
                elif t == "tool_use":
                    blocks.append({"type": "tool_use", "id": b["id"], "name": b["name"], "input": b.get("input", {})})
                elif t == "tool_result":
                    blocks.append({"type": "tool_result", "tool_use_id": b["tool_use_id"], "content": result_content(b.get("content"))})
            c = blocks
        if c:
            msgs.append({"role": m["role"], "content": c})
    return msgs


def cut(msgs, max_bytes):
    # Longest prefix under the cap that ends on an assistant turn with no pending tool call.
    out, size = [], 0
    for m in msgs:
        s = len(json.dumps(m))
        if size + s > max_bytes:
            break
        out.append(m)
        size += s
    while out and (out[-1]["role"] != "assistant" or any(b.get("type") == "tool_use" for b in out[-1]["content"] if isinstance(b, dict))):
        out.pop()
    return out if out and out[0]["role"] == "user" else None


def tool_result_bytes(msgs):
    return sum(len(json.dumps(b["content"])) for m in msgs if isinstance(m["content"], list)
               for b in m["content"] if b.get("type") == "tool_result")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--out", default=os.path.join(HERE, "out", "cases.json"))
    ap.add_argument("--max-bytes", type=int, default=400_000)
    ap.add_argument("--max-cases", type=int, default=12)
    ap.add_argument("--per-project", type=int, default=4)
    ap.add_argument("--min-tool-bytes", type=int, default=15_000)
    a = ap.parse_args()

    cands = []
    for path in sorted(glob.glob(os.path.join(a.src, "*", "*.jsonl"))):
        msgs = cut(load_session(path), a.max_bytes)
        if msgs:
            cands.append((tool_result_bytes(msgs), path, msgs))
    # Most tool output first; the path breaks ties so the selection is deterministic.
    cands.sort(key=lambda x: (-x[0], x[1]))
    per, cases = collections.Counter(), []
    for trb, path, msgs in cands:
        proj = os.path.basename(os.path.dirname(path))
        if trb < a.min_tool_bytes or per[proj] >= a.per_project:
            continue
        per[proj] += 1
        cases.append({"name": f"{proj[-24:]}/{os.path.basename(path)[:8]}", "original": msgs, "tool_result_bytes": trb})
        if len(cases) >= a.max_cases:
            break
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    json.dump(cases, open(a.out, "w"))
    print(f"wrote {len(cases)} cases to {a.out}")
    for c in cases:
        print(f"  {c['name']:36} {len(c['original']):4} msgs  {c['tool_result_bytes'] // 1000:5} KB tool output")


if __name__ == "__main__":
    main()
