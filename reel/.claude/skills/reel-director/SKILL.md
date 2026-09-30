---
name: reel-director
description: Produce un reel 9:16 col Reel Engine seguendo il workflow a 4 gate (treatment → mapping → voce → keyframe → video). Attivare quando l'utente vuole creare un reel, produrre una video ad, trasformare un copy in video, generare un reel da un brief. Richiede il repo reel-engine installato (altrimenti usare prima reel-setup).
---

# Reel Director — produzione reel col workflow a 4 gate

## Regola zero — il manuale è nel repo

**Lavora SEMPRE dalla cartella del repo `reel-engine`** (aprila come workspace o spostati lì). Il file `CLAUDE.md` del repo è il manuale operativo CANONICO e completo: struttura del treatment, regole dello storyboard, anti-pattern, schema dello script.json, comandi. Leggilo e seguilo alla lettera — questa skill è la mappa, quel file è il territorio. Se il repo non c'è: ferma tutto e passa da `reel-setup`.

## La mappa del workflow

| Fase | Cosa | Dove | Costo |
|---|---|---|---|
| 1 | **Director's Treatment** → `treatment.md` | conversazione | $0 |
| — | 🟡 **GATE 1**: l'utente approva il treatment | | |
| 2 | **Mapping** frase-voiceover ↔ scena (tabella) | conversazione | $0 |
| — | 🟡 **GATE 2**: l'utente approva il mapping | | |
| 3 | **script.json** (schema Zod del repo) | conversazione | $0 |
| 4 | **Voce**: `pnpm reel <script> --audio-only` | CLI | ~$0.30 |
| — | 🟡 **GATE 3**: l'utente ascolta e approva la voce | | |
| 4.5 | **Storyboard**: `pnpm storyboard <script> --from <reel-dir>` | CLI | ~$0.06-0.10/scena |
| — | 🟡 **GATE 4**: l'utente approva OGNI keyframe (`keyframes.html` + marker `.approved`) | | |
| 5 | **Video + render**: `pnpm reel <script> --video-only --from <reel-dir>` — IRREVERSIBILE | CLI | ~$5-7 |
| 6 | **Review**: `pnpm scene-map <reel-dir>` (L1 gratis; `--vision` a pagamento solo se autorizzato) | CLI | $0 / ~$0.50 |

## Regole non negoziabili

1. **Mai saltare un gate.** A ogni gate: presenta l'artefatto, chiedi approvazione esplicita (approva / itera), e fermati finché non arriva. Mai procedere alla FASE 5 senza GATE 3 e GATE 4 passati.
2. **Economia degli errori**: prima del GATE 4 un errore costa centesimi e secondi; dopo costa $0.50-2 a scena e minuti. Itera a sinistra: treatment e mapping si correggono gratis, la voce a $0.30, i keyframe a $0.10. Il video è l'ULTIMO passo.
3. **Mai far generare testo leggibile, schermi o dashboard ai modelli video** (producono sempre gibberish): i dati vanno in scene Remotion (`kineticDashboard`, `dashboardComponent` — vedi `demo-card` come template). Il significato emotivo di ogni scena deve reggere senza testo.
4. **Mai inventare numeri**: ogni dato a schermo è dichiarato `[REAL]` (fonte del cliente — chiedere a Michel), `[ILLUSTRATIVE]` (esempio dichiarato) o `[FROM COPY]`.
5. **Sync video↔audio**: nessuna scena con più di 10s di audio (il motore BLOCCA — spezza la scena, non forzare con `--allow-oversized`); ogni `voiceoverSegment` ricalca parola-per-parola il `voiceoverText` e non inizia mai con un tag `[...]`.
6. **Costi sempre dichiarati prima**: prima di ogni comando a pagamento, di' all'utente quanto costerà. `--vision` mai di default.

## Se qualcosa fallisce a metà

I clip già generati restano su disco e NON si ripagano: il motore stampa il comando di resume esatto (`--skip-existing-videos`). Gli errori transitori di rete vengono già ritentati da soli. Un `403` da fal.ai = saldo esaurito dell'utente, non un bug.

## Iterazioni tipiche

- Voce diversa: modifica `voiceSettings`/`voiceoverText` nello script → `pnpm reel <script> --audio-only --from "<reel-dir>"` (RIUSA la cartella; per rigenerare da zero usa `--out`).
- Keyframe sbagliato: `pnpm storyboard <script> --from "<reel-dir>" --force-regen=N`.
- Script.json editato a mano dopo il render: rilancia `pnpm render <reel-dir>` — si accorge da solo delle modifiche e ricalcola.
- Template di partenza: `templates/script-esempio.json` e `templates/treatment-template.md` di questa skill.
