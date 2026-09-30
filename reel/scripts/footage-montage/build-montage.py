#!/usr/bin/env python3
"""
build-montage.py — assembla un MONTAGGIO COMPLETO da un footage parlato esistente.

Prende il TUO video parlato (talking-head) + il suo transcript (word-timestamps) +
una EDIT-LIST e produce un composition-props.json per BasicReel, pronto per `pnpm render`.

Idea chiave (perché funziona):
  La VOCE ORIGINALE viene estratta come UNICA traccia globale (`voiceoverUrl`) → BasicReel
  MUTA automaticamente tutti i clip. Così puoi alternare:
    - A-ROLL  = pezzi del TUO video reale (la tua faccia), mutati
    - B-ROLL  = clip generati (Kling i2v) o altri video, muti
    - CARD    = componenti animati (dashboardComponent) o tipografia
    - ENDCARD = un'immagine finale
  mentre la tua voce vera scorre CONTINUA sotto, con i sottotitoli kinetic sincronizzati.

SYNC AUTOMATICO (impossibile sbagliarlo):
  Le scene si elencano in ORDINE. Lo script tiene un cursore-timeline `t` (parte da 0).
  Ogni A-ROLL viene estratto dal video sorgente all'istante ESATTO in cui la voce è
  arrivata (origStart = clipStart + t) → il labiale resta sempre in sync, anche dopo i
  b-roll. Per gli A-roll specifichi SOLO la durata; lo script calcola da dove tagliare.

USO:
  python3 build-montage.py edit-list.json
  (tutti i path nella edit-list sono relativi alla cartella del progetto, vedi sotto)

EDIT-LIST (JSON):
{
  "source": "assets/IMG_3415.MOV",     // il tuo footage parlato
  "transcript": "assets/transcript.json", // output di footage-to-reel/transcribe.sh
  "outDir": ".",                        // dove scrivere composition-props.json + assets/
  "clipStart": 4.90,                    // inizio del taglio (hook-first) nel sorgente
  "clipEnd": 89.70,                     // fine del parlato nel sorgente
  "fps": 30,
  "subtitleStyle": {"kinetic": true, "variant": "motion", "captionFont": "anton"},
  "masterGrade": {"saturation": 1.06, "contrast": 1.03, "temperature": 6},
  "fixes": [{"t": 25.54, "text": "CopyClaude"}],          // correggi UNA parola del sub
  "mergeFixes": [{"from": ["video","blog"], "to": "VideoClaude"}], // fondi 2 parole in 1
  "scenes": [
    {"type": "aroll",   "durSec": 8.22, "punchIn": 1.10},   // la tua faccia, push-in
    {"type": "broll",   "clip": "assets/broll-2.mp4", "durSec": 5.28},
    {"type": "card",    "component": "copy-chat-card", "durSec": 4.72},
    {"type": "kineticTypo", "words": [{"t":"UNO"},{"t":"DUE","accent":true}], "durSec": 3.0,
                        "bg":"#262624","accent":"#D97757","textColor":"#F0EEE6"},
    {"type": "endcard", "image": "assets/endcard.png", "durSec": 2.5}
  ]
}

REGOLE:
  - La somma delle durate degli A-ROLL + B-ROLL + CARD deve coprire (clipEnd-clipStart);
    l'ENDCARD è additivo (cade dopo la voce, muto). Lo script avvisa se non torna.
  - I clip b-roll generati devono durare >= della loro scena (lo script lo verifica).
  - Genera i b-roll PRIMA, con scripts/footage-montage/gen-broll.ts (Kling i2v dai keyframe).
"""
import json, subprocess, sys, os, math

HERE = os.path.dirname(os.path.abspath(__file__))
MAKE_SUBS = os.path.join(HERE, "..", "footage-to-reel", "make_subs.py")


def ffprobe_dur(path):
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nk=1:nw=1", path]
    )
    return float(out.strip())


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    if len(sys.argv) < 2:
        print("uso: python3 build-montage.py edit-list.json"); sys.exit(1)
    spec = json.load(open(sys.argv[1], encoding="utf-8"))

    proj = os.path.abspath(spec.get("outDir", "."))
    apath = lambda p: p if os.path.isabs(p) else os.path.join(proj, p)
    src = apath(spec["source"])
    fps = float(spec.get("fps", 30))
    clip_start = float(spec["clipStart"])
    clip_end = float(spec["clipEnd"])
    assets = os.path.join(proj, "assets")
    os.makedirs(assets, exist_ok=True)

    # 1) VOCE GLOBALE (traccia unica, muta i clip in BasicReel)
    voice = os.path.join(assets, "voice.m4a")
    run(["ffmpeg", "-y", "-ss", f"{clip_start}", "-i", src, "-t", f"{clip_end-clip_start}",
         "-vn", "-ac", "2", "-c:a", "aac", "-b:a", "192k", voice])

    # 2) SOTTOTITOLI dai word-timestamps (clip-relativi, voce ORIGINALE → lead 0)
    mk = ["python3", MAKE_SUBS, "--json", apath(spec["transcript"]),
          "--start", f"{clip_start}", "--end", f"{clip_end}", "--fps", f"{fps}", "--lead", "0.0"]
    for fx in spec.get("fixes", []):
        mk += ["--fix", f"{fx['t']}={fx['text']}"]
    subs = json.loads(subprocess.check_output(mk))
    # mergeFixes: fondi N parole consecutive in una (es. "video"+"blog" -> "VideoClaude")
    for mf in spec.get("mergeFixes", []):
        seq = [w.lower() for w in mf["from"]]
        i = 0
        while i <= len(subs) - len(seq):
            window = [subs[i + k]["text"].strip().lower().strip(".,") for k in range(len(seq))]
            if window == seq:
                subs[i]["text"] = mf["to"]
                subs[i]["endFrame"] = subs[i + len(seq) - 1]["endFrame"]
                del subs[i + 1:i + len(seq)]
            i += 1

    ENC = ["-an", "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
           "-crf", "18", "-preset", "medium", "-movflags", "+faststart",
           "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920"]

    # 3) SCENE — cursore timeline `t` (sec). A-roll estratto all'istante esatto della voce.
    scenes, t, a_idx, warnings = [], 0.0, 0, []
    for i, sc in enumerate(spec["scenes"]):
        typ = sc["type"]
        dur = float(sc["durSec"])
        frames = max(1, round(dur * fps))
        if typ == "aroll":
            a_idx += 1
            orig = clip_start + t  # <-- sync-by-construction
            out = os.path.join(assets, f"aroll-{a_idx}.mp4")
            run(["ffmpeg", "-y", "-ss", f"{orig}", "-i", src, "-t", f"{dur + 0.4}"] + ENC + [out])
            scene = {"text": "", "videoUrl": f"assets/aroll-{a_idx}.mp4", "durationInFrames": frames}
            if sc.get("punchIn"):
                scene["tailTreatment"] = {"type": "kenBurns", "fromSec": 0, "zoom": float(sc["punchIn"])}
            scenes.append(scene)
        elif typ == "broll":
            clip = apath(sc["clip"])
            if os.path.exists(clip):
                cd = ffprobe_dur(clip)
                if cd + 1e-3 < dur:
                    warnings.append(f"scena {i} b-roll '{sc['clip']}' dura {cd:.2f}s < {dur:.2f}s → FREEZE. Rigenera più lungo.")
            else:
                warnings.append(f"scena {i} b-roll '{sc['clip']}' NON esiste ancora (genera con gen-broll.ts).")
            scenes.append({"text": "", "videoUrl": os.path.relpath(clip, proj), "durationInFrames": frames})
        elif typ == "card":
            scenes.append({"text": "", "dashboardComponent": sc["component"], "durationInFrames": frames})
        elif typ == "kineticTypo":
            scenes.append({"text": "", "durationInFrames": frames, "kineticTypo": {
                "words": sc["words"], "bg": sc.get("bg"), "accent": sc.get("accent"),
                "textColor": sc.get("textColor")}})
        elif typ == "endcard":
            scenes.append({"text": "", "imageUrl": os.path.relpath(apath(sc["image"]), proj),
                           "durationInFrames": frames, "kenBurnsRange": sc.get("kenBurnsRange", [1.0, 1.05]),
                           "hideSubtitle": True, "gradeExempt": True})
        else:
            print(f"tipo scena sconosciuto: {typ}"); sys.exit(1)
        t += dur

    # 4) Verifica sync: il parlato (clipEnd-clipStart) deve essere coperto dalle scene non-endcard
    spoken = clip_end - clip_start
    covered = sum(float(s["durSec"]) for s in spec["scenes"] if s["type"] != "endcard")
    if abs(covered - spoken) > 0.15:
        warnings.append(f"copertura scene non-endcard = {covered:.2f}s ma parlato = {spoken:.2f}s "
                        f"(Δ {covered-spoken:+.2f}s). Aggiusta le durate o il taglio.")

    total = sum(s["durationInFrames"] for s in scenes)
    props = {"compositionId": "BasicReel", "durationInFrames": total, "props": {
        "hook": "", "cta": "", "scenes": scenes, "subtitles": subs,
        "subtitleStyle": spec.get("subtitleStyle", {"kinetic": True, "variant": "motion"}),
        "voiceoverUrl": "assets/voice.m4a"}}
    if spec.get("masterGrade"):
        props["props"]["masterGrade"] = spec["masterGrade"]

    out = os.path.join(proj, "composition-props.json")
    json.dump(props, open(out, "w"), ensure_ascii=False, indent=2)
    print(f"OK {out}")
    print(f"   {len(scenes)} scene · {total}f ({total/fps:.1f}s) · {len(subs)} parole-sub · voce {spoken:.1f}s")
    for w in warnings:
        print("   ⚠️ " + w)
    print("   → render:  pnpm render \"%s\"" % proj)


if __name__ == "__main__":
    main()
