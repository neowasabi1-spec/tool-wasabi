#!/usr/bin/env python3
"""Converte i word-timestamps whisper in SubtitleWord[] (startFrame/endFrame @fps)
per il reel-engine, clip-relativi a [start,end], con merge elisioni + fix refusi.
Stampa JSON: [{"text","startFrame","endFrame"}, ...]
Uso: make_subs.py --json t.json --start S --end E [--fps 30] [--lead 0.0] [--fix "TIME=testo" ...]"""
import argparse, json
ap = argparse.ArgumentParser()
ap.add_argument("--json", required=True)
ap.add_argument("--start", type=float, required=True)
ap.add_argument("--end", type=float, required=True)
ap.add_argument("--fps", type=float, default=30.0)
ap.add_argument("--lead", type=float, default=0.0)  # anticipo sottotitoli (s); 0.1 per VO ElevenLabs
ap.add_argument("--fix", action="append", default=[])  # "TIME=testo" corregge la parola a t0~=TIME
a = ap.parse_args()

d = json.load(open(a.json, encoding="utf-8"))
words = []
for seg in d.get("segments", []):
    for w in seg.get("words", []):
        t = (w.get("word") or "").strip()
        if not t:
            continue
        if words and t[0] in "'’":                 # ricuci elisioni: "l" + "'azienda"
            words[-1]["w"] += t; words[-1]["e"] = float(w["end"]); continue
        words.append({"s": float(w["start"]), "e": float(w["end"]), "w": t})
for fx in a.fix:
    ts, _, new = fx.partition("="); ts = float(ts)
    for w in words:
        if abs(w["s"] - ts) < 0.06:
            w["w"] = new; break

out = []
for w in words:
    if w["e"] <= a.start or w["s"] >= a.end:
        continue
    if "[" in w["w"] or "]" in w["w"]:             # scarta tag audio v3
        continue
    out.append({
        "text": w["w"],
        "startFrame": max(0, round((w["s"] - a.start - a.lead) * a.fps)),
        "endFrame": max(0, round((w["e"] - a.start - a.lead) * a.fps)),
    })
print(json.dumps(out, ensure_ascii=False))
