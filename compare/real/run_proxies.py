#!/usr/bin/env python3
"""Proxy-mode comparison: replays each session turn by turn through running proxies.

Every proxy's upstream must point at compare/real/capture_upstream.js, which records the exact bodies the
proxy would send to the API. Each session is replayed as the client would send it: one request per user
message, the history growing each time. That matters for Headroom's default "cache" mode, which only
compresses the newest part of a conversation and freezes what it has already sent.

  python compare/real/run_proxies.py --capture=http://127.0.0.1:8790 \
      "headroom cache=http://127.0.0.1:8796" "tokentrimmer safe=http://127.0.0.1:8799" ...

Scores (tiktoken o200k_base over messages + tools, so injected retrieval tools count against the proxy):
  final request   tokens of the last request vs. the original
  cache cost      every request priced as prompt caching bills it: 0.1x for the prefix shared with the
                  previous request, 1.25x for the rest (characters)
Writes compare/real/out/proxies.json and proxies.md. Sends nothing anywhere but the given proxies.
"""
import json, os, sys, time, urllib.request
import tiktoken

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
ENC = tiktoken.get_encoding("o200k_base")
HEADERS = {"content-type": "application/json", "x-api-key": "sk-ant-benchmark", "anthropic-version": "2023-06-01"}


def dumps(x):
    return json.dumps(x, separators=(",", ":"), ensure_ascii=False)


def strip_cache_control(x):
    # cache_control marks where the API caches; it is not part of the cached content, and proxies move it
    if isinstance(x, dict):
        return {k: strip_cache_control(v) for k, v in x.items() if k != "cache_control"}
    if isinstance(x, list):
        return [strip_cache_control(v) for v in x]
    return x


def sent(body):
    return strip_cache_control({"tools": body.get("tools") or [], "messages": body.get("messages") or []})


def markers(x):
    s = dumps(x)
    return s.count("<<ccr:") + s.count("tokentrimmer_retrieve {") + s.count("tokentrim_retrieve {")


def tokens(x):
    return len(ENC.encode(dumps(x), disallowed_special=()))


def call(url, data=None):
    req = urllib.request.Request(url, data=data, headers=HEADERS if data is not None else {})
    with urllib.request.urlopen(req, timeout=900) as r:
        return r.read()


def cache_cost(texts):
    prev, cost = "", 0.0
    for s in texts:
        k = len(os.path.commonprefix([prev, s]))
        cost += 0.1 * k + 1.25 * (len(s) - k)
        prev = s
    return cost


def replay(proxy, capture, messages):
    call(capture + "/_reset", b"")
    ms = []
    for t in range(1, len(messages) + 1):
        if messages[t - 1]["role"] != "user":
            continue
        raw = dumps({"model": "claude-opus-5-5", "max_tokens": 100, "messages": messages[:t]}).encode()
        t0 = time.perf_counter()
        call(proxy + "/v1/messages", raw)
        ms.append((time.perf_counter() - t0) * 1000)
    bodies = [c["body"] for c in json.loads(call(capture + "/_captured"))]
    if len(bodies) != len(ms):
        raise RuntimeError(f"{proxy}: {len(ms)} requests but {len(bodies)} reached the upstream")
    return bodies, ms


def pct(a, b):
    return f"{100 * (1 - a / b):.1f}%"


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--capture")]
    capture = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--capture=")), "http://127.0.0.1:8790")
    proxies = [a.split("=", 1) for a in args]
    cases = json.load(open(os.path.join(OUT, "cases.json")))
    rows = []
    for c in cases:
        m = c["original"]
        base = [dumps({"tools": [], "messages": m[:t]}) for t in range(1, len(m) + 1) if m[t - 1]["role"] == "user"]
        row = {"name": c["name"], "original": tokens({"tools": [], "messages": m}), "base_cost": cache_cost(base), "proxies": {}}
        for name, url in proxies:
            bodies, ms = replay(url, capture, m)
            row["proxies"][name] = {
                "requests": len(bodies), "tokens": tokens(sent(bodies[-1])),
                "cost": cache_cost([dumps(sent(b)) for b in bodies]), "ms_total": sum(ms), "ms_max": max(ms),
                "markers": markers(bodies[-1].get("messages") or []) - markers(m),
            }
            print(f"{c['name']:36} {name:28} {pct(row['proxies'][name]['tokens'], row['original']):>7}", flush=True)
        rows.append(row)
    json.dump(rows, open(os.path.join(OUT, "proxies.json"), "w"), indent=1)

    names = [n for n, _ in proxies]
    lines = ["# Proxy-mode comparison (turn-by-turn replay)", "",
             f"{len(rows)} sessions, {sum(r['proxies'][names[0]]['requests'] for r in rows)} requests each. "
             "Savings vs. the original; tokens include any tool a proxy injects.", "",
             "| Session | " + " | ".join(names) + " |", "|---|" + "---:|" * len(names)]
    for r in rows:
        lines.append(f"| {r['name']} | " + " | ".join(pct(r['proxies'][n]['tokens'], r['original']) for n in names) + " |")
    O = sum(r["original"] for r in rows)
    B = sum(r["base_cost"] for r in rows)
    lines.append("| **Total, final request** | " + " | ".join(f"**{pct(sum(r['proxies'][n]['tokens'] for r in rows), O)}**" for n in names) + " |")
    lines.append("| **Total, cache-weighted cost** | " + " | ".join(f"**{pct(sum(r['proxies'][n]['cost'] for r in rows), B)}**" for n in names) + " |")
    lines += ["", "| Proxy | Mean latency per request | Slowest request | Retrieval markers added (final requests) |", "|---|---:|---:|---:|"]
    for n in names:
        req = sum(r["proxies"][n]["requests"] for r in rows)
        marks = sum(r["proxies"][n]["markers"] for r in rows)
        lines.append(f"| {n} | {sum(r['proxies'][n]['ms_total'] for r in rows) / req:.0f} ms | {max(r['proxies'][n]['ms_max'] for r in rows):.0f} ms | {marks} |")
    report = "\n".join(lines) + "\n"
    open(os.path.join(OUT, "proxies.md"), "w").write(report)
    print(report)


if __name__ == "__main__":
    main()
