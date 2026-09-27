export type Project = {
  id: string; name: string; tone: string; positioning: string; palette: string[]; logo_rules: string;
  logo_path: string | null; forbidden: string[]; required_elements: string[];
};

export type Product = {
  id: string; project_id: string; name: string; description: string; avatar: string; offer: string;
  markets: string[]; landing_urls: string[]; image_paths: string[]; forbidden: string[]; required_elements: string[];
  weights: Record<string, number>; corpus_rules: Record<string, unknown>;
  source_mode: SourceMode; benefit: string; mechanism: string; features: string; proof: string;
  differentiators: string; guarantee: string; product_sheet: string;
};

/**
 * same_product: le fonti promuovono lo stesso identico prodotto → i fatti di prodotto sono trasferibili.
 * same_benefit: le fonti sono altri prodotti con lo stesso beneficio → si tiene il beneficio e la persuasione,
 * si sostituiscono prodotto, meccanismo e prove con i nostri.
 */
export type SourceMode = 'same_product' | 'same_benefit';

export const MODE_LABEL: Record<SourceMode, string> = {
  same_product: 'Stesso prodotto',
  same_benefit: 'Stesso beneficio, altri prodotti',
};

export type Source = {
  id: string; project_id: string; kind: 'page' | 'domain'; page_id: string | null; name: string; url: string;
  role: 'own' | 'competitor' | 'adjacent'; status: string; status_note: string | null; last_refreshed_at: string | null;
  last_total_label: string | null;
};

export type Creative = {
  id: string; project_id: string; source_id: string | null; product_id: string | null;
  assigned_by: 'domain' | 'judge' | 'manual' | null; assign_p: number | null;
  media_type: 'text' | 'image' | 'video' | 'carousel'; media_hash: string; media_paths: string[]; dhashes: string[];
  bodies: string[]; titles: string[]; descriptions: string[]; captions: string[]; languages: string[]; countries: string[];
  first_seen: string | null; last_seen: string | null; active: boolean; copies: number;
  extraction: any; extraction_status: string; extraction_error: string | null; description_en: string | null;
  embedding: unknown; ranking: any; created_at: string; advertised_product: string | null;
  impression_rank: number | null; impression_pct: number | null; ctas: string[]; poster_path: string | null;
};

export const ROLE_LABEL: Record<Source['role'], string> = { own: 'nostra', competitor: 'competitor', adjacent: 'adiacente' };
