# scripts/ — mappa

**Qui nella root: solo CLI vivi** (lanciabili via `pnpm <comando>`, vedi [README principale](../README.md) e `pnpm reel --help`):

| File | Comando | Ruolo |
|---|---|---|
| generate-reel.ts | `pnpm reel` | Pipeline completa / audio-only / video-only |
| storyboard.ts | `pnpm storyboard` | Keyframe Gemini + gallery (GATE 4) |
| render-only.ts | `pnpm render` | Render Remotion (con hash-guard auto-recalc) |
| recalc-props.ts | `pnpm recalc-props` | Ricalcolo composition-props da script.json |
| scene-map.ts | `pnpm scene-map` | Review L1 (+ `--vision` per audit Gemini L2) |
| refresh-deconstruct.ts / refresh-verify.ts | `pnpm refresh:*` | Workflow refresh-creativo (clonare top ad) |
| test-character-consistency.ts | `pnpm test:consistency` | Test identità multi-character pre-produzione |
| preview.ts | `pnpm preview` | Anteprima Remotion |
| gen-variant.ts, regen-scenes.ts, regen-voiceover.ts, regen-seg.mts, regen-keyframe-with-ref.mts | via `tsx` | Tool di rigenerazione chirurgica (singola scena / segmento / keyframe) |
| higgsfield-auth.ts | `pnpm higgsfield:auth` | DEPRECATO (Higgsfield disabilitato 2026-05-28) — solo backward compat |

`cast-talkshow-1990s.json` è la fixture di esempio per `pnpm test:consistency` (documentata in CLAUDE.md).

**`projects/`** — script.json e builder dei reel prodotti, per cliente/progetto. Sono i sorgenti storici per rigenerare quei reel: non servono per usare il motore.

**`archive/`** — esperimenti one-off conclusi (test di validazione modelli, preflight). Tenuti per riferimento storico: non lanciarli, molti hanno path hardcoded.
