#!/usr/bin/env python3
"""Read-only report on how photos arrive from the camera (context for new-photo notifications, ADR-010).

Input: the JSON of `aws dynamodb scan --projection-expression "uploadedAt, capturedAt"` on stdin.
Output (stdout, Markdown): gaps between consecutive uploads, and how many bursts / what sizes and
durations each candidate quiet time would produce, overall and per day.
"""
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone

QUIETS_MIN = [2, 3, 5, 10, 15, 20, 30, 60]


def parse(ts):
    if not ts:
        return None
    ts = ts.replace("Z", "+00:00")
    try:
        d = datetime.fromisoformat(ts)
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


def fmt_s(s):
    if s is None:
        return "-"
    if s < 90:
        return f"{s:.0f}s"
    if s < 5400:
        return f"{s / 60:.1f}m"
    return f"{s / 3600:.1f}h"


def bursts(times, quiet_s):
    out, cur = [], [times[0]]
    for t in times[1:]:
        if (t - cur[-1]).total_seconds() > quiet_s:
            out.append(cur)
            cur = [t]
        else:
            cur.append(t)
    out.append(cur)
    return out


def main():
    raw = json.load(sys.stdin)
    items = raw.get("Items", raw)
    up = []
    lag = []
    caps = []
    for it in items:
        u = parse((it.get("uploadedAt") or {}).get("S") if isinstance(it.get("uploadedAt"), dict) else it.get("uploadedAt"))
        c_raw = (it.get("capturedAt") or {}).get("S") if isinstance(it.get("capturedAt"), dict) else it.get("capturedAt")
        if u:
            up.append(u)
        caps.append(c_raw)
        c = parse(c_raw)
        if u and c and c_raw and not c_raw.endswith("Z") and "+" not in c_raw[10:]:
            # capturedAt is camera-local time without a zone: report the raw difference, it includes the UTC offset.
            lag.append((u - c).total_seconds())
    up.sort()
    print(f"# Sync history: {len(up)} photos with uploadedAt, {up[0].isoformat()} .. {up[-1].isoformat()}\n")

    gaps = [(b - a).total_seconds() for a, b in zip(up, up[1:])]
    print("## Gap between consecutive uploads")
    print("| p10 | p25 | p50 | p75 | p90 | p95 | p99 | max |")
    print("|---|---|---|---|---|---|---|---|")
    print("| " + " | ".join(fmt_s(pct(gaps, p)) for p in [10, 25, 50, 75, 90, 95, 99]) + f" | {fmt_s(max(gaps) if gaps else None)} |\n")
    print("Gaps by size:")
    edges = [10, 30, 60, 120, 180, 300, 600, 900, 1200, 1800, 3600, 7200, 86400]
    prev = 0
    for e in edges:
        n = sum(1 for g in gaps if prev < g <= e)
        print(f"- {fmt_s(prev)}–{fmt_s(e)}: {n}")
        prev = e
    print(f"- >{fmt_s(prev)}: {sum(1 for g in gaps if g > prev)}\n")

    print("## Bursts per candidate quiet time (all days)")
    print("| quiet | bursts | of 1 photo | median size | max size | median duration | max duration |")
    print("|---|---|---|---|---|---|---|")
    for q in QUIETS_MIN:
        bs = bursts(up, q * 60)
        sizes = [len(b) for b in bs]
        durs = [(b[-1] - b[0]).total_seconds() for b in bs]
        print(f"| {q}m | {len(bs)} | {sum(1 for s in sizes if s == 1)} | {pct(sizes, 50)} | {max(sizes)} | {fmt_s(pct(durs, 50))} | {fmt_s(max(durs))} |")
    print()

    by_day = defaultdict(list)
    for t in up:
        by_day[t.date().isoformat()].append(t)
    print("## Per day (UTC): photos, and bursts at 3 / 5 / 10 / 20 min")
    print("| day | photos | first | last | 3m | 5m | 10m | 20m | biggest gaps |")
    print("|---|---|---|---|---|---|---|---|---|")
    for day in sorted(by_day):
        ts = by_day[day]
        g = sorted(((b - a).total_seconds() for a, b in zip(ts, ts[1:])), reverse=True)[:4]
        cols = [str(len(bursts(ts, q * 60))) for q in (3, 5, 10, 20)]
        print(f"| {day} | {len(ts)} | {ts[0].strftime('%H:%M')} | {ts[-1].strftime('%H:%M')} | " + " | ".join(cols) + " | " + ", ".join(fmt_s(x) for x in g) + " |")
    print()

    print("## Bursts at 5 min, newest 40 (UTC)")
    print("| start | end | photos | duration | gap before |")
    print("|---|---|---|---|---|")
    bs = bursts(up, 300)
    rows = []
    for i, b in enumerate(bs):
        before = (b[0] - bs[i - 1][-1]).total_seconds() if i else None
        rows.append(f"| {b[0].strftime('%m-%d %H:%M:%S')} | {b[-1].strftime('%H:%M:%S')} | {len(b)} | {fmt_s((b[-1] - b[0]).total_seconds())} | {fmt_s(before)} |")
    print("\n".join(rows[-40:]))
    print()
    # Shooting rhythm: with live auto-transfer, uploads follow capture, so capture gaps predict how
    # bursts would split during a shoot (camera-local time; only the gaps matter).
    cap = sorted(t for t in (parse(x) for x in caps) if t)
    if len(cap) > 1:
        cg = [(b - a).total_seconds() for a, b in zip(cap, cap[1:])]
        print(f"## Shooting rhythm: {len(cap)} capture times, {cap[0].date()} .. {cap[-1].date()}")
        print("Gap between consecutive shots:")
        print("| p50 | p75 | p90 | p95 | p99 |")
        print("|---|---|---|---|---|")
        print("| " + " | ".join(fmt_s(pct(cg, p)) for p in [50, 75, 90, 95, 99]) + " |\n")
        print("Gaps by size:")
        prev = 0
        for e in [10, 30, 60, 120, 180, 300, 600, 900, 1200, 1800, 3600, 7200]:
            print(f"- {fmt_s(prev)}–{fmt_s(e)}: {sum(1 for g in cg if prev < g <= e)}")
            prev = e
        print(f"- >{fmt_s(prev)}: {sum(1 for g in cg if g > prev)}\n")
        print("| quiet | shooting bursts | of 1 photo | of ≤3 photos | median size | median duration | max duration |")
        print("|---|---|---|---|---|---|---|")
        for q in QUIETS_MIN:
            bs = bursts(cap, q * 60)
            sizes = [len(b) for b in bs]
            durs = [(b[-1] - b[0]).total_seconds() for b in bs]
            print(f"| {q}m | {len(bs)} | {sum(1 for x in sizes if x == 1)} | {sum(1 for x in sizes if x <= 3)} | {pct(sizes, 50)} | {fmt_s(pct(durs, 50))} | {fmt_s(max(durs))} |")
        days = defaultdict(list)
        for t in cap:
            days[t.date()].append(t)
        print(f"\nShooting days: {len(days)}; bursts per day at 5 / 10 / 20 / 30 min:")
        for d in sorted(days):
            ts = days[d]
            print(f"- {d}: {len(ts)} shots, {ts[0].strftime('%H:%M')}–{ts[-1].strftime('%H:%M')}, " + " / ".join(str(len(bursts(ts, q * 60))) for q in (5, 10, 20, 30)))
        print()
    if lag:
        print("## uploadedAt − capturedAt (raw; includes the camera's UTC offset)")
        print("| p10 | p50 | p90 |")
        print("|---|---|---|")
        print("| " + " | ".join(fmt_s(pct(lag, p)) for p in [10, 50, 90]) + " |")


if __name__ == "__main__":
    main()
