// Mappatura locale "pagina del builder → step del progetto".
//
// Quando si salva il funnel in un progetto (My Projects), ogni AppFunnelPage
// del builder genera una riga in `funnel_steps`. Questa mappa tiene il
// collegamento pageId → { projectId, stepId } così che, quando l'utente
// edita la pagina nel Visual Editor e salva, possiamo aggiornare in
// automatico il `result_content` dello step del progetto (auto-sync), senza
// dover ri-salvare manualmente tutto il funnel.
//
// Sta in localStorage (non nel DB) di proposito: è un'associazione
// per-browser, sopravvive ai reload e non richiede migrazioni. Best-effort:
// se manca/è corrotta, l'auto-sync semplicemente non scatta.

const KEY = 'wasabi:funnel-step-map:v1';

export interface FunnelStepLink {
  projectId: string;
  stepId: number;
}

type MapShape = Record<string, FunnelStepLink>;

function readAll(): MapShape {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as MapShape;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(map: MapShape): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* quota / private mode: ignora */
  }
}

/** Collega una pagina del builder allo step del progetto appena creato. */
export function setFunnelStepLink(pageId: string, link: FunnelStepLink): void {
  if (!pageId || !link?.projectId || !link?.stepId) return;
  const map = readAll();
  map[pageId] = link;
  writeAll(map);
}

/** Recupera il collegamento per una pagina, se esiste. */
export function getFunnelStepLink(pageId: string): FunnelStepLink | null {
  if (!pageId) return null;
  return readAll()[pageId] ?? null;
}

/** Sostituisce in blocco i collegamenti per un intero salvataggio funnel. */
export function setFunnelStepLinks(
  links: Array<{ pageId: string } & FunnelStepLink>,
): void {
  if (!links?.length) return;
  const map = readAll();
  for (const l of links) {
    if (l.pageId && l.projectId && l.stepId) {
      map[l.pageId] = { projectId: l.projectId, stepId: l.stepId };
    }
  }
  writeAll(map);
}
