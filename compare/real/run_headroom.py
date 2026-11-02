#!/usr/bin/env python3
"""Runs Headroom over the same cases, then scores both tools.

Needs a virtualenv with `headroom-ai==0.42.0 tiktoken`. Run extract.py and run_tokentrim.js first.

Two scores:
  final request   tokens of the last request (tiktoken o200k_base over the serialized messages,
                  identical for every column)
  cache cost      the session replayed request by request, priced as prompt caching bills it:
                  0.1x for the prefix shared with the previous request, 1.25x for the rest.
                  Characters; each tool is compared with an uncompressed replay serialized the same way.
Headroom runs in library mode (headroom.compress): its placeholders cannot be expanded by the model
there, so its output is reported as-is with no lossless claim.

  python compare/real/run_headroom.py [--no-replay]
Writes compare/real/out/results.json and compare/real/out/report.md.
"""
import copy, json, os, signal, sys, time
import headroom, tiktoken

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
ENC = tiktoken.get_encoding("o200k_base")
# {} = library defaults; the rest are Headroom's named savings profiles.
HEADROOM = (("default", {}), ("coding", {"savings_profile": "coding"}),
            ("general", {"savings_profile": "general"}), ("agent-90", {"savings_profile": "agent-90"}))
REPLAY = ("default", "coding")  # replay is slow; the other profiles gave identical output in library mode
TIMEOUT = 300


def dumps(messages):
    return json.dumps(messages, separators=(",", ":"), ensure_ascii=False)


def tokens(messages):
    return len(ENC.encode(dumps(messages), disallowed_special=()))


def common_prefix(a, b):
    return len(os.path.commonprefix([a, b]))


def replay(messages, compress):
    prev, sent, cost, requests = "", 0, 0.0, 0
    for t in range(1, len(messages) + 1):
        if messages[t - 1]["role"] != "user":
            continue
        s = dumps(compress(messages[:t]))
        cached = common_prefix(prev, s)
        sent += len(s)
        cost += 0.1 * cached + 1.25 * (len(s) - cached)
        requests += 1
        prev = s
    return {"requests": requests, "sent": sent, "cost": round(cost)}


class Timeout(Exception):
    pass


def _alarm(*_):
    raise Timeout()


def hr(messages, kw):
    return headroom.compress(copy.deepcopy(messages), model="claude-sonnet-4-5-20250929", **kw).messages


def run_headroom(messages, kw, label, do_replay):
    signal.signal(signal.SIGALRM, _alarm)
    signal.alarm(TIMEOUT)
    try:
        t = time.perf_counter()
        out = hr(messages, kw)
        ms = (time.perf_counter() - t) * 1000
        same = dumps(out) == dumps(hr(messages, kw))
        signal.alarm(0)
        res = {"tokens": tokens(out), "ms": round(ms, 1), "deterministic": same}
        if do_replay and label in REPLAY:
            res["replay"] = replay(messages, lambda m: hr(m, kw))
        return res
    except Timeout:
        return {"error": "timeout"}
    except Exception as e:  # report, never abort the whole run
        signal.alarm(0)
        return {"error": f"{type(e).__name__}: {str(e)[:120]}"}


def pct(after, before):
    return f"{100 * (1 - after / before):.1f}%"


def main():
    do_replay = "--no-replay" not in sys.argv
    cases = json.load(open(os.path.join(OUT, "cases.json")))
    tt = {r["name"]: r for r in json.load(open(os.path.join(OUT, "tokentrim.json")))}
    modes = list(next(iter(tt.values()))["modes"])
    rows = []
    for c in cases:
        row = {"name": c["name"], "original": tokens(c["original"]), "tokentrim": {}, "headroom": {},
               "baselineReplay": {"tokentrim": tt[c["name"]]["baselineReplay"]}}
        if do_replay:
            row["baselineReplay"]["headroom"] = replay(c["original"], lambda m: m)
        for m in modes:
            x = tt[c["name"]]["modes"][m]
            row["tokentrim"][m] = {"tokens": tokens(x["messages"]), "ms": x["ms"], "deterministic": x["deterministic"],
                                   "verify": x["verify"], "replay": x.get("replay")}
        for label, kw in HEADROOM:
            row["headroom"][label] = run_headroom(c["original"], kw, label, do_replay)
        rows.append(row)
        print("done", c["name"], flush=True)
    json.dump(rows, open(os.path.join(OUT, "results.json"), "w"), indent=1)

    cols = [("tt " + m, "tokentrim", m) for m in modes] + [("hr " + l, "headroom", l) for l, _ in HEADROOM]
    lines = ["# Real-session comparison", "",
             f"{len(rows)} sessions. Final request: tiktoken o200k_base tokens. Savings vs. the original.", "",
             "| Session | Original | " + " | ".join(n for n, _, _ in cols) + " |",
             "|---|---:|" + "---:|" * len(cols)]
    tot = {n: 0 for n, _, _ in cols}
    orig = 0
    for r in rows:
        orig += r["original"]
        cells = []
        for n, tool, key in cols:
            x = r[tool][key]
            tot[n] += x.get("tokens", r["original"])  # an error counts as no saving
            cells.append("error" if "error" in x else pct(x["tokens"], r["original"]))
        lines.append(f"| {r['name']} | {r['original']} | " + " | ".join(cells) + " |")
    lines.append(f"| **Total** | **{orig}** | " + " | ".join(f"**{pct(tot[n], orig)}**" for n, _, _ in cols) + " |")

    lines += ["", "| Column | Final request | Cache-weighted cost, whole session | Total time | Deterministic | Errors | Verifier FAILED / lossy fields |",
              "|---|---:|---:|---:|---|---:|---|"]
    for n, tool, key in cols:
        xs = [r[tool][key] for r in rows]
        ok = [x for x in xs if "error" not in x]
        det = "yes" if ok and all(x["deterministic"] for x in ok) else ("no" if ok else "n/a")
        ver = f"{sum(x['verify']['FAILED'] for x in ok)} / {sum(x['verify']['lossy'] for x in ok)}" if tool == "tokentrim" else "n/a"
        cache = "not run"
        if all(r[tool][key].get("replay") for r in rows):
            base = sum(r["baselineReplay"][tool]["cost"] for r in rows)
            cache = pct(sum(r[tool][key]["replay"]["cost"] for r in rows), base)
        lines.append(f"| {n} | {pct(tot[n], orig)} | {cache} | {sum(x['ms'] for x in ok) / 1000:.2f} s | {det} | {len(xs) - len(ok)} | {ver} |")
    report = "\n".join(lines) + "\n"
    open(os.path.join(OUT, "report.md"), "w").write(report)
    print(report)


if __name__ == "__main__":
    main()
