import json, math, signal, sys, time, copy
import headroom

def neutral(messages):
    # One counter for every tool: ~4 characters per token over the serialized messages.
    return math.ceil(len(json.dumps(messages, separators=(",", ":"), ensure_ascii=False)) / 4)

class Timeout(Exception): pass
def on_alarm(*_): raise Timeout()
signal.signal(signal.SIGALRM, on_alarm)

cases = json.load(open("out/cases.json"))
results = []
for c in cases:
    row = {"name": c["name"], "original": neutral(c["original"])}
    for mode in ("safe", "balanced", "aggressive"):
        row["tt_" + mode] = neutral(c["tokentrimmer"][mode])
    for label, kw in (("hr_default", {}), ("hr_protect0", {"protect_recent": 0})):
        signal.alarm(90)
        t = time.time()
        try:
            r = headroom.compress(copy.deepcopy(c["original"]), model="claude-sonnet-4-5-20250929", **kw)
            signal.alarm(0)
            row[label] = neutral(r.messages)
            row[label + "_own"] = [r.tokens_before, r.tokens_after]
            row[label + "_transforms"] = r.transforms_applied
            row[label + "_secs"] = round(time.time() - t, 1)
        except Timeout:
            row[label] = None; row[label + "_err"] = "timeout"
        except Exception as e:
            signal.alarm(0)
            row[label] = None; row[label + "_err"] = f"{type(e).__name__}: {str(e)[:160]}"
    results.append(row)
    print("done", c["name"], flush=True)
json.dump(results, open("out/results.json", "w"), indent=1)
