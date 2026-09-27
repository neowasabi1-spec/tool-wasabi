import { db } from './db';
import { env } from './env';
import { decrypt, encrypt } from './secret';

export type Thresholds = {
  pass: number;          // tutte le domande bloccanti sopra questa soglia → passa
  review: number;        // sotto questa → scarta
  borrowedIp: number;    // esclusione dalla classifica
  copySimilarity: number;      // coseno ≥ → copia
  lostSimilarity: number;      // coseno < → meccanismo perso
  dhashCopy: number;           // distanza di Hamming ≤ → immagine copiata (su 64 bit)
  maxPerAxisValue: number;     // copertura: un valore di un asse al massimo N volte per batch
  longevityDays: number;       // attiva da ≥ N giorni → indizio di vincente
  shortLivedDays: number;      // spenta entro N giorni → indizio di perdente
  topImpressionPct: number;    // nella parte alta della classifica per impression (0.2 = primo 20%) → indizio di vincente
  bottomImpressionPct: number; // nella parte bassa (0.3 = ultimo 30%) e spenta → indizio di perdente
  maxAdsPerPage: number;       // tetto di ads lette per pagina a ogni aggiornamento (le prime per impression)
  visualCopy: number;          // somiglianza visiva con una sorgente ≥ → copia (scarto)
  visualReview: number;        // somiglianza visiva ≥ → revisione
  outputQuality: number;       // qualità dell'output sotto questa soglia (0–1) → riscrittura automatica
  refineRounds: number;        // giri massimi di riscrittura automatica per output
  styleSimilarity: number;     // somiglianza visiva media minima per stare nella stessa famiglia di stile (0–1)
  imageTarget: number;         // efficacia dell'immagine reale sotto questa soglia → nuova versione del prompt in automatico
  imageRounds: number;         // versioni massime (v2, v3…) generate dal giudizio sulle immagini
  templateSimilarity: number;  // template: somiglianza minima della struttura grafica per stare nello stesso gruppo (0–1)
  templateFidelity: number;    // immagine generata: fedeltà minima al template (0–1), sotto si rigenera
  imageAttempts: number;       // rigenerazioni massime di un'immagine che non rispetta template o testi
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  pass: 0.85, review: 0.5, borrowedIp: 0.6,
  copySimilarity: 0.92, lostSimilarity: 0.55, dhashCopy: 10,
  maxPerAxisValue: 2, longevityDays: 60, shortLivedDays: 7,
  topImpressionPct: 0.2, bottomImpressionPct: 0.3, maxAdsPerPage: 200,
  visualCopy: 0.8, visualReview: 0.6,
  outputQuality: 0.65, refineRounds: 2,
  styleSimilarity: 0.72,
  imageTarget: 0.8, imageRounds: 3,
  templateSimilarity: 0.9, templateFidelity: 0.75, imageAttempts: 2,
};

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const { data } = await db().from('jev_settings').select('value').eq('key', key).maybeSingle();
  return (data?.value as T) ?? fallback;
}

export async function setSetting(key: string, value: unknown) {
  const { error } = await db().from('jev_settings').upsert({ key, value });
  if (error) throw new Error(error.message);
}

/**
 * Le probabilità di Jev sono calibrate, quelle del ripiego su Claude no: le soglie si salvano per motore.
 * Le soglie che non dipendono dal giudice (distanza, corpus, volume) valgono per entrambi ma restano per motore
 * per semplicità: si modificano dalla stessa pagina.
 */
export const thresholdsKey = (engine: 'jev' | 'claude' = env.judgeEngine) => `thresholds_${engine}`;

export async function getThresholds(engine: 'jev' | 'claude' = env.judgeEngine): Promise<Thresholds> {
  const legacy = await getSetting<Partial<Thresholds>>('thresholds', {});
  return { ...DEFAULT_THRESHOLDS, ...legacy, ...(await getSetting<Partial<Thresholds>>(thresholdsKey(engine), {})) };
}

export type FbTokenInfo = { token: string; expiresAt: string | null; checkedAt: string | null; adAccountId: string | null };

export async function getFbToken(): Promise<FbTokenInfo | null> {
  const v = await getSetting<{ enc: string; expiresAt: string | null; checkedAt: string | null; adAccountId?: string | null } | null>('fb_token', null);
  if (!v?.enc) return null;
  return { token: decrypt(v.enc), expiresAt: v.expiresAt, checkedAt: v.checkedAt, adAccountId: v.adAccountId ?? null };
}

export async function saveFbToken(token: string, extra: { expiresAt: string | null; checkedAt: string | null; adAccountId: string | null }) {
  await setSetting('fb_token', { enc: encrypt(token), ...extra });
}
