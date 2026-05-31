'use client';

import { create } from 'zustand';
import { SwipeApiResponse } from '@/types';
import type {
  Product,
  Project,
  SwipeTemplate,
  FunnelPage,
  PostPurchasePage,
  ArchivedFunnel,
  PageType,
  SwipeStatus,
  PostPurchaseType,
} from '@/types/database';
import * as supabaseOps from '@/lib/supabase-operations';
import { parseSectionData, type SectionData } from '@/lib/project-sections';

const SWIPE_API_URL = '/api/landing/swipe';

// Helper to convert database types to app types
interface AppProduct {
  id: string;
  name: string;
  description: string;
  price: number;
  imageUrl?: string;
  benefits: string[];
  ctaText: string;
  ctaUrl: string;
  brandName: string;
  sku?: string;
  category?: string;
  characteristics?: string[];
  geoMarket?: string;
  supplier?: string;
  createdAt: Date;
}

interface ProjectAsset {
  url: string;
  name: string;
  addedAt: string;
}

interface ProjectSectionData {
  [key: string]: unknown;
}

interface AppProject {
  id: string;
  name: string;
  description: string;
  status: string;
  tags: string[];
  notes?: string;
  domain: string;
  logo: ProjectAsset[];
  marketResearch: ProjectSectionData;
  brief: string;
  frontEnd: ProjectSectionData;
  backEnd: ProjectSectionData;
  complianceFunnel: ProjectSectionData;
  funnel: ProjectSectionData;
  // Parsed multi-file payloads — same data as `marketResearch` / `brief`
  // but normalised through parseSectionData() so consumers (e.g. the rewrite
  // proxy) can pick individual files instead of a giant concatenated blob.
  briefData: SectionData;
  marketResearchData: SectionData;
  createdAt: Date;
  updatedAt: Date;
}

type ViewFormat = 'desktop' | 'mobile';

interface AppSwipeTemplate {
  id: string;
  name: string;
  sourceUrl: string;
  pageType: PageType;
  viewFormat: ViewFormat;
  tags: string[];
  description?: string;
  previewImage?: string;
  category?: 'standard' | 'quiz';
  createdAt: Date;
}

interface AppFunnelPage {
  id: string;
  name: string;
  pageType: PageType;
  templateId?: string;
  productId: string;
  urlToSwipe: string;
  angle?: string;
  prompt?: string;
  swipeStatus: SwipeStatus;
  swipeResult?: string;
  feedback?: string;
  clonedData?: {
    html: string;
    mobileHtml?: string;
    title: string;
    method_used: string;
    content_length: number;
    duration_seconds: number;
    cloned_at: Date;
    // ID del job openclaw_messages che ha prodotto questo HTML. Usato dal
    // boot dello store per reidratare l'HTML dalla `response` del job
    // quando supabase ha stripped via il blob > 50KB.
    jobId?: string;
    // Flag/metadata che supabase-operations.ts inietta quando l'HTML e'
    // stato strippato prima del save (sopra HTML_PERSIST_THRESHOLD).
    htmlLength?: number;
    htmlSkipped?: boolean;
    mobileHtmlLength?: number;
    mobileHtmlSkipped?: boolean;
    // URL pubblico Supabase Storage da cui recuperare l'HTML al boot.
    // Settato dalla pipeline `persistHtmlBlobs` quando l'html supera
    // HTML_STORAGE_THRESHOLD (50 KB). Persiste cross-browser/device —
    // l'IndexedDB resta solo come backup locale. Vedi rehydrate logic
    // in `initializeData` (Step 0).
    htmlUrl?: string;
    mobileHtmlUrl?: string;
    // Timestamp (ms) dell'ultimo Save del VisualHtmlEditor. Persistito nel
    // JSONB (pochi byte, sopravvive allo strip). Al boot lo confrontiamo con
    // `savedAt` del blob IndexedDB: se l'IDB locale è >= editedAt, l'edit
    // locale vince (anche se il write Supabase è fallito o la pagina è
    // piccola e l'HTML nel JSONB è rimasto vecchio).
    editedAt?: number;
  };
  swipedData?: {
    html: string;
    mobileHtml?: string;
    originalTitle: string;
    newTitle: string;
    originalLength: number;
    newLength: number;
    processingTime: number;
    methodUsed: string;
    changesMade: string[];
    swipedAt: Date;
    jobId?: string;
    htmlLength?: number;
    htmlSkipped?: boolean;
    mobileHtmlLength?: number;
    mobileHtmlSkipped?: boolean;
    htmlUrl?: string;
    mobileHtmlUrl?: string;
    // Vedi clonedData.editedAt.
    editedAt?: number;
  };
  analysisStatus?: SwipeStatus;
  analysisResult?: string;
  extractedData?: {
    headline: string;
    subheadline: string;
    cta: string[];
    price: string | null;
    benefits: string[];
  };
  createdAt: Date;
  updatedAt: Date;
}

interface AppPostPurchasePage {
  id: string;
  name: string;
  type: PostPurchaseType;
  productId: string;
  urlToSwipe: string;
  swipeStatus: SwipeStatus;
  swipeResult?: string;
  clonedData?: {
    html: string;
    title: string;
    method_used: string;
    content_length: number;
    duration_seconds: number;
    cloned_at: Date;
  };
  swipedData?: {
    html: string;
    originalTitle: string;
    newTitle: string;
    originalLength: number;
    newLength: number;
    processingTime: number;
    methodUsed: string;
    changesMade: string[];
    swipedAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

// Conversion functions
function dbProductToApp(p: Product): AppProduct {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    price: p.price,
    imageUrl: p.image_url || undefined,
    benefits: p.benefits,
    ctaText: p.cta_text,
    ctaUrl: p.cta_url,
    brandName: p.brand_name,
    sku: p.sku || undefined,
    category: p.category || undefined,
    characteristics: p.characteristics || [],
    geoMarket: p.geo_market || undefined,
    supplier: p.supplier || undefined,
    createdAt: new Date(p.created_at),
  };
}

function dbProjectToApp(p: Project): AppProject {
  // brief lives in TWO columns for backwards compat:
  //   - p.brief         (TEXT, legacy concatenated content)
  //   - p.brief_files   (JSONB, new SectionData with file array)
  // Prefer the JSONB blob when present; fall back to the TEXT column.
  const briefRaw =
    (p as Project & { brief_files?: unknown }).brief_files ?? p.brief;
  const briefData = parseSectionData(briefRaw);
  const marketResearchData = parseSectionData(p.market_research);
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status,
    tags: p.tags,
    notes: p.notes || undefined,
    domain: p.domain || '',
    logo: (p.logo as ProjectAsset[]) || [],
    marketResearch: (p.market_research as ProjectSectionData) || {},
    brief: p.brief || '',
    frontEnd: (p.front_end as ProjectSectionData) || {},
    backEnd: (p.back_end as ProjectSectionData) || {},
    complianceFunnel: (p.compliance_funnel as ProjectSectionData) || {},
    funnel: (p.funnel as ProjectSectionData) || {},
    briefData,
    marketResearchData,
    createdAt: new Date(p.created_at),
    updatedAt: new Date(p.updated_at),
  };
}

function dbTemplateToApp(t: SwipeTemplate): AppSwipeTemplate {
  const row = t as SwipeTemplate & { category?: 'standard' | 'quiz' };
  return {
    id: t.id,
    name: t.name,
    sourceUrl: t.source_url,
    pageType: t.page_type,
    viewFormat: (t.view_format as ViewFormat) || 'desktop',
    tags: t.tags,
    description: t.description || undefined,
    previewImage: t.preview_image || undefined,
    category: row.category || 'standard',
    createdAt: new Date(t.created_at),
  };
}

// ── Persistenza HTML su Supabase Storage ────────────────────────────
// Per ognuno dei blob JSONB (cloned/swiped/extracted): se contiene un html
// > 50 KB, lo carica su Storage (path: funnel-html/{pageId}/{kind}.html)
// e ritorna:
//   - `forDb.<kind>` : blob da scrivere su DB con html/mobileHtml RIMOSSI
//     (sostituiti da htmlUrl/mobileHtmlUrl + htmlLength + htmlSkipped=true)
//   - `urlsByKind.<kind>` : { htmlUrl, mobileHtmlUrl } da MERGEARE nello
//     state locale senza toccare l'html in-memory
// Best-effort: se Storage fallisce, restituiamo il blob originale e
// lasciamo che `supabase-operations.stripHtmlFromJsonb` faccia il suo
// strip senza salvataggio (l'HTML resterà solo in memoria e in IDB).
const STORAGE_HTML_FIELDS: Array<['html' | 'mobileHtml', 'htmlUrl' | 'mobileHtmlUrl']> = [
  ['html', 'htmlUrl'],
  ['mobileHtml', 'mobileHtmlUrl'],
];

async function persistHtmlBlobs(
  pageId: string,
  blobs: {
    clonedData?: Record<string, unknown>;
    swipedData?: Record<string, unknown>;
    extractedData?: Record<string, unknown>;
  },
  // Contesto del progetto/funnel: serve a persistHtmlToStorage per
  // iniettare il tag tracker `<script src=".../t.js">` nell'HTML salvato.
  // Se funnelId e' undefined, l'inject viene saltato (fail-safe). Non
  // blocca mai il save: il tracking e' un'aggiunta, non e' essenziale
  // per il funzionamento dell'editor.
  trackingCtx?: {
    funnelId?: string | null;
    stepType?: string | null;
  },
): Promise<{
  forDb: {
    clonedData: Record<string, unknown> | undefined;
    swipedData: Record<string, unknown> | undefined;
    extractedData: Record<string, unknown> | undefined;
  };
  urlsByKind: {
    cloned: Record<string, string> | null;
    swiped: Record<string, string> | null;
    extracted: Record<string, string> | null;
  };
  // Messaggio dell'errore di upload su Storage, se presente. Permette alla
  // UI di spiegare ESATTAMENTE perche' un save e' rimasto solo locale.
  storageError?: string;
}> {
  let storageError: string | undefined;
  const { persistHtmlToStorage, HTML_STORAGE_THRESHOLD } = await import('@/lib/funnel-html-storage');
  const { saveHtmlBlob } = await import('@/lib/html-blob-store');

  type Kind = 'cloned' | 'swiped' | 'extracted';
  const work: Array<{ kind: Kind; idbTarget: 'clonedData' | 'swipedData' | 'extractedData'; blob: Record<string, unknown> | undefined }> = [
    { kind: 'cloned', idbTarget: 'clonedData', blob: blobs.clonedData },
    { kind: 'swiped', idbTarget: 'swipedData', blob: blobs.swipedData },
    { kind: 'extracted', idbTarget: 'extractedData', blob: blobs.extractedData },
  ];

  const forDb: Record<string, Record<string, unknown> | undefined> = {};
  const urlsByKind: Record<string, Record<string, string> | null> = { cloned: null, swiped: null, extracted: null };

  for (const { kind, idbTarget, blob } of work) {
    if (!blob) { forDb[kind] = undefined; continue; }
    const out: Record<string, unknown> = { ...blob };

    const htmlVal = typeof blob.html === 'string' ? (blob.html as string) : '';
    const mobileVal = typeof blob.mobileHtml === 'string' ? (blob.mobileHtml as string) : '';
    // SERVER SOURCE OF TRUTH: carichiamo SEMPRE l'HTML su page_html (anche
    // i piccoli), così `htmlUrl` è sempre presente e aggiornato e al reload
    // si rilegge dal server. Lo strip dal JSONB resta limitato ai grandi
    // (per non sforare lo statement_timeout su Postgres); i piccoli restano
    // anche nel JSONB come fallback offline.
    const hasHtml = htmlVal.length > 0;
    const hasMobile = mobileVal.length > 0;

    if (hasHtml || hasMobile) {
      try {
        const urls = await persistHtmlToStorage(
          pageId,
          kind,
          hasHtml ? htmlVal : undefined,
          hasMobile ? mobileVal : undefined,
          // Solo per kind cloned/swiped (HTML "nostro"). 'extracted' resta
          // raw — persistHtmlToStorage stesso fa lo skip se kind ===
          // 'extracted', ma passiamo comunque il context per non
          // dipendere dall'implementation detail.
          {
            funnelId: trackingCtx?.funnelId,
            stepType: trackingCtx?.stepType,
          },
        );
        const collected: Record<string, string> = {};
        for (const [htmlKey, urlKey] of STORAGE_HTML_FIELDS) {
          const v = htmlKey === 'html' ? htmlVal : mobileVal;
          const url = htmlKey === 'html' ? urls.htmlUrl : urls.mobileHtmlUrl;
          if (v.length > 0 && url) {
            out[urlKey] = url;
            collected[urlKey] = url;
            // Strip dal JSONB SOLO per HTML grande (evita 57014 timeout).
            // Per i piccoli teniamo l'html nel JSONB come fallback.
            if (v.length > HTML_STORAGE_THRESHOLD) {
              out[`${htmlKey}Length`] = v.length;
              out[`${htmlKey}Skipped`] = true;
              delete out[htmlKey];
            }
          }
        }
        urlsByKind[kind] = collected;

        // Backup IDB (best-effort): se Storage in futuro non risponde,
        // l'utente trova comunque la sua edit su questa macchina.
        try {
          await saveHtmlBlob(
            pageId,
            idbTarget,
            htmlVal || '',
            mobileVal || undefined,
          );
        } catch {
          // silenziosa: IDB è solo backup
        }
      } catch (err) {
        // Storage upload failed — lasciamo il blob originale e
        // `stripHtmlFromJsonb` farà il vecchio strip. Almeno IDB salva.
        console.warn(`[useStore.persistHtmlBlobs] Storage upload failed for ${kind} of page ${pageId}, falling back to strip:`, err);
        if (!storageError) storageError = err instanceof Error ? err.message : String(err);
        try {
          await saveHtmlBlob(pageId, idbTarget, htmlVal || '', mobileVal || undefined);
        } catch {
          // niente
        }
      }
    }

    forDb[kind] = out;
  }

  return {
    forDb: {
      clonedData: forDb.cloned,
      swipedData: forDb.swiped,
      extractedData: forDb.extracted,
    },
    urlsByKind: {
      cloned: urlsByKind.cloned,
      swiped: urlsByKind.swiped,
      extracted: urlsByKind.extracted,
    },
    storageError,
  };
}

// Re-attaches the in-memory `html` (and friends) that `supabaseOps` strips
// before sending the JSONB to Supabase. Used when an UPDATE/INSERT comes
// back: the DB-backed object will be missing those fields, but the local
// optimistic state still holds them and downstream rewrite logic depends
// on `clonedData.html` / `swipedData.html` being present in-memory.
function mergeJsonbWithLocalHtml<T extends Record<string, unknown> | null | undefined>(
  fromDb: T,
  fromLocal: T,
): T {
  if (!fromDb && !fromLocal) return fromDb;
  if (!fromDb) return fromLocal;
  if (!fromLocal) return fromDb;
  const out: Record<string, unknown> = { ...fromDb };
  for (const key of ['html', 'mobileHtml', 'htmlMobile', 'rawHtml', 'renderedHtml', 'content']) {
    const dbVal = (fromDb as Record<string, unknown>)[key];
    const localVal = (fromLocal as Record<string, unknown>)[key];
    if (typeof localVal === 'string' && localVal && typeof dbVal !== 'string') {
      out[key] = localVal;
    }
  }
  return out as T;
}

function dbFunnelPageToApp(p: FunnelPage): AppFunnelPage {
  return {
    id: p.id,
    name: p.name,
    pageType: p.page_type,
    templateId: p.template_id || undefined,
    // The dropdown is now bound to My Projects (`project_id`). Older rows that
    // only have the legacy `product_id` keep falling back to it so they don't
    // disappear from the UI; the user just needs to re-pick the project.
    productId: p.project_id || p.product_id || '',
    urlToSwipe: p.url_to_swipe,
    // `angle` is read defensively because the column was added in a later
    // migration (supabase-migration-funnel-pages-angle.sql) and may be
    // missing on rows from older deploys.
    angle: (p as Record<string, unknown>).angle as string | undefined,
    prompt: (p as Record<string, unknown>).prompt as string | undefined,
    swipeStatus: p.swipe_status,
    swipeResult: p.swipe_result || undefined,
    feedback: (p as Record<string, unknown>).feedback as string | undefined,
    clonedData: p.cloned_data as AppFunnelPage['clonedData'],
    swipedData: p.swiped_data as AppFunnelPage['swipedData'],
    analysisStatus: p.analysis_status || undefined,
    analysisResult: p.analysis_result || undefined,
    extractedData: p.extracted_data as AppFunnelPage['extractedData'],
    createdAt: new Date(p.created_at),
    updatedAt: new Date(p.updated_at),
  };
}

function dbPostPurchaseToApp(p: PostPurchasePage): AppPostPurchasePage {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    productId: p.product_id,
    urlToSwipe: p.url_to_swipe,
    swipeStatus: p.swipe_status,
    swipeResult: p.swipe_result || undefined,
    clonedData: p.cloned_data as AppPostPurchasePage['clonedData'],
    swipedData: p.swiped_data as AppPostPurchasePage['swipedData'],
    createdAt: new Date(p.created_at),
    updatedAt: new Date(p.updated_at),
  };
}

interface Store {
  // Loading state
  isLoading: boolean;
  error: string | null;
  isInitialized: boolean;

  // Initialize data from Supabase
  initializeData: () => Promise<void>;

  // Templates
  templates: AppSwipeTemplate[];
  addTemplate: (template: Omit<AppSwipeTemplate, 'id' | 'createdAt'>) => Promise<void>;
  updateTemplate: (id: string, template: Partial<AppSwipeTemplate>) => Promise<void>;
  deleteTemplate: (id: string) => Promise<void>;

  // Products
  products: AppProduct[];
  addProduct: (product: Omit<AppProduct, 'id' | 'createdAt'>) => Promise<void>;
  updateProduct: (id: string, product: Partial<AppProduct>) => Promise<void>;
  deleteProduct: (id: string) => Promise<void>;

  // Projects
  projects: AppProject[];
  addProject: (project: Omit<AppProject, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  updateProject: (id: string, project: Partial<AppProject>) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;

  // Custom page types (per Templates)
  customPageTypes: { value: string; label: string }[];
  addCustomPageType: (label: string) => void;
  deleteCustomPageType: (value: string) => void;

  // Front End Funnel Pages
  funnelPages: AppFunnelPage[];
  addFunnelPage: (page: Omit<AppFunnelPage, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  updateFunnelPage: (id: string, page: Partial<AppFunnelPage>) => Promise<void>;
  deleteFunnelPage: (id: string) => Promise<void>;
  launchSwipe: (id: string) => Promise<void>;

  // Post Purchase Pages
  postPurchasePages: AppPostPurchasePage[];
  addPostPurchasePage: (page: Omit<AppPostPurchasePage, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  updatePostPurchasePage: (id: string, page: Partial<AppPostPurchasePage>) => Promise<void>;
  deletePostPurchasePage: (id: string) => Promise<void>;
  launchPostPurchaseSwipe: (id: string) => Promise<void>;

  // Archived Funnels
  archivedFunnels: ArchivedFunnel[];
  archivedFunnelsLoaded: boolean;
  loadArchivedFunnels: () => Promise<void>;
  saveCurrentFunnelAsArchive: (name: string, section?: string) => Promise<void>;
  deleteArchivedFunnel: (id: string) => Promise<void>;

  // Ultimo errore di upload HTML su Supabase Storage (null = nessun errore).
  // Settato da updateFunnelPage/persistHtmlBlobs; letto dalla UI per
  // mostrare il motivo reale quando un save resta solo locale.
  lastStorageError: string | null;
}

export const useStore = create<Store>()((set, get) => ({
  // Loading state
  isLoading: true,
  error: null,
  isInitialized: false,
  lastStorageError: null,

  // Initialize data from Supabase (with timeout to prevent infinite loading)
  initializeData: async () => {
    if (get().isInitialized) return;

    const SUPABASE_INIT_TIMEOUT_MS = 12_000;

    set({ isLoading: true, error: null });

    const fetchWithTimeout = <T>(promise: Promise<T>): Promise<T> => {
      return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout: Supabase did not respond within 12 seconds')), SUPABASE_INIT_TIMEOUT_MS)
        ),
      ]);
    };

    try {
      const [products, projects, templates, funnelPages, postPurchasePages] = await fetchWithTimeout(
        Promise.all([
          supabaseOps.fetchProducts(),
          supabaseOps.fetchProjects().catch(() => [] as Project[]),
          supabaseOps.fetchTemplates(),
          supabaseOps.fetchFunnelPages(),
          supabaseOps.fetchPostPurchasePages(),
        ])
      );

      const appFunnelPages = funnelPages.map(dbFunnelPageToApp);
      set({
        products: products.map(dbProductToApp),
        projects: projects.map(dbProjectToApp),
        templates: templates.map(dbTemplateToApp),
        funnelPages: appFunnelPages,
        postPurchasePages: postPurchasePages.map(dbPostPurchaseToApp),
        isLoading: false,
        isInitialized: true,
      });

      // ── HTML REHYDRATE ────────────────────────────────────────────────
      // `stripHtmlFromJsonb` rimuove l'HTML > 50KB da swiped_data /
      // cloned_data prima del save Supabase per evitare statement_timeout
      // 57014 sull'anon role. Senza reidratazione l'utente vede la riga
      // "Completed / Rewrite OK" ma il preview HTML e' sparito al reload.
      //
      // Strategia in due livelli:
      //   1) openclaw_messages.response (via jobId) — funziona per i flussi
      //      rewrite/extract che producono HTML lato worker.
      //   2) IndexedDB locale (html-blob-store) — funziona per il clone
      //      Identical sincrono via /api/clone-funnel, e copre anche i
      //      casi in cui openclaw_messages non e' raggiungibile o la
      //      `response` e' stata pulita.
      //
      // Async non-blocking: la UI si vede subito senza HTML, poi quando
      // arrivano le `response` la set aggiorna gli swipedData/clonedData
      // e React rerenderizza con l'HTML completo.
      void (async () => {
        const { loadHtmlBlob } = await import('@/lib/html-blob-store');
        const { fetchHtmlFromStorage } = await import('@/lib/funnel-html-storage');

        // Tutte le pagine con HTML mancante in clonedData o swipedData,
        // indipendentemente dalla presenza di jobId. Per ognuna proviamo
        // nell'ordine: Storage URL → openclaw → IndexedDB.
        const targets: Array<{
          pageId: string;
          target: 'swipedData' | 'clonedData';
          jobId?: string;
          htmlUrl?: string;
          mobileHtmlUrl?: string;
          // L'HTML è già presente nel JSONB (pagina piccola / non strippata)?
          // Se sì NON serve fetch remoto: serve solo l'eventuale override
          // dell'edit locale (IndexedDB) più recente.
          htmlPresent: boolean;
          // Timestamp dell'ultimo edit registrato sul server.
          editedAt?: number;
        }> = [];
        // IMPORTANTE: includiamo TUTTE le pagine con clonedData/swipedData,
        // non solo quelle strippate. Motivo: l'edit dell'editor viene scritto
        // SEMPRE in IndexedDB, ma il write su Supabase può fallire (RLS,
        // sessione anonima, rete) o la pagina può essere piccola e mantenere
        // nel JSONB l'HTML VECCHIO. In quei casi, senza controllare IndexedDB
        // anche per le pagine con html presente, al reload si rivedrebbe la
        // versione originale e l'edit andrebbe perso.
        for (const p of appFunnelPages) {
          if (p.swipedData) {
            targets.push({
              pageId: p.id,
              target: 'swipedData',
              jobId: p.swipedData.jobId,
              htmlUrl: p.swipedData.htmlUrl,
              mobileHtmlUrl: p.swipedData.mobileHtmlUrl,
              htmlPresent: !p.swipedData.htmlSkipped && !!p.swipedData.html,
              editedAt: p.swipedData.editedAt,
            });
          }
          if (p.clonedData) {
            targets.push({
              pageId: p.id,
              target: 'clonedData',
              jobId: p.clonedData.jobId,
              htmlUrl: p.clonedData.htmlUrl,
              mobileHtmlUrl: p.clonedData.mobileHtmlUrl,
              htmlPresent: !p.clonedData.htmlSkipped && !!p.clonedData.html,
              editedAt: p.clonedData.editedAt,
            });
          }
        }
        if (targets.length === 0) return;
        // eslint-disable-next-line no-console
        console.log(`[store] tentativo reidratazione HTML per ${targets.length} target (IndexedDB → Storage URL → openclaw_messages)…`);

        const applyHydratedHtml = (
          pageId: string,
          target: 'swipedData' | 'clonedData',
          html: string,
          mobileHtml?: string,
        ) => {
          set((state) => ({
            funnelPages: state.funnelPages.map((p) => {
              if (p.id !== pageId) return p;
              const blob = p[target] as Record<string, unknown> | undefined;
              if (!blob) return p;
              const merged = {
                ...blob,
                html,
                ...(mobileHtml ? { mobileHtml } : {}),
                htmlSkipped: false,
              };
              return { ...p, [target]: merged } as typeof p;
            }),
          }));
        };

        // Limita 4 in parallelo per non saturare l'API route Next.js
        const PARALLEL = 4;
        for (let i = 0; i < targets.length; i += PARALLEL) {
          const slice = targets.slice(i, i + PARALLEL);
          await Promise.all(
            slice.map(async ({ pageId, target, jobId, htmlUrl, mobileHtmlUrl, htmlPresent }) => {
              const kind = target === 'swipedData' ? 'swiped' : 'cloned';

              // 1) SERVER (tabella page_html via service role) — SORGENTE DI
              //    VERITÀ per un'app online. L'editor ad ogni Save fa UPSERT su
              //    page_html, quindi questa riga è sempre l'ULTIMA versione,
              //    cross-device, indipendente dall'esito dell'UPDATE del JSONB
              //    funnel_pages (che può fallire per RLS). L'URL è
              //    deterministica per (pageId, kind, variant), così funziona
              //    anche se il JSONB ha un htmlUrl vecchio o assente.
              try {
                const base = `/api/funnel-html?pageId=${encodeURIComponent(pageId)}&kind=${kind}`;
                const html = await fetchHtmlFromStorage(`${base}&variant=desktop`);
                if (html) {
                  const mobileHtml = await fetchHtmlFromStorage(`${base}&variant=mobile`);
                  applyHydratedHtml(pageId, target, html, mobileHtml || undefined);
                  return;
                }
              } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[store] page_html rehydrate fallita per page ${pageId}/${target}, provo le altre fonti:`, err);
              }

              // 1b) htmlUrl legacy (vecchio Supabase Storage) — copia
              //     cross-device per pagine create prima di page_html.
              if (htmlUrl) {
                try {
                  const html = await fetchHtmlFromStorage(htmlUrl);
                  const mobileHtml = mobileHtmlUrl ? await fetchHtmlFromStorage(mobileHtmlUrl) : undefined;
                  if (html) {
                    applyHydratedHtml(pageId, target, html, mobileHtml || undefined);
                    return;
                  }
                } catch (err) {
                  // eslint-disable-next-line no-console
                  console.warn(`[store] Storage rehydrate fallito per page ${pageId}/${target}, provo openclaw:`, err);
                }
              }

              // 2) HTML già presente nel JSONB (in memoria): è il fallback per
              //    le pagine piccole mai finite su page_html. Niente da fare.
              if (htmlPresent) return;

              // 3) openclaw_messages (solo se jobId) — risultato del worker
              //    per i flussi rewrite/swipe non ancora editati a mano.
              if (jobId) {
                try {
                  const r = await fetch(`/api/openclaw/queue?id=${encodeURIComponent(jobId)}`);
                  if (r.ok) {
                    const data = (await r.json()) as { status?: string; response?: string | null };
                    if (data.response) {
                      let parsed: { html?: string; mobileHtml?: string; new_title?: string } | null = null;
                      try { parsed = JSON.parse(data.response); } catch { /* nessuna fonte */ }
                      if (parsed?.html) {
                        applyHydratedHtml(pageId, target, parsed.html, parsed.mobileHtml);
                        return;
                      }
                    }
                  }
                } catch (err) {
                  // eslint-disable-next-line no-console
                  console.warn(`[store] openclaw rehydrate fallito per page ${pageId} (job ${jobId.slice(0, 8)}):`, err);
                }
              }

              // 4) IndexedDB — ULTIMA risorsa, solo offline. Se il server non
              //    risponde (rete giù) e non c'è nient'altro, recuperiamo
              //    l'ultima copia salvata su QUESTA macchina così l'utente non
              //    perde il lavoro. Non vince mai sul server.
              try {
                const blob = await loadHtmlBlob(pageId, target);
                if (blob?.html) {
                  applyHydratedHtml(pageId, target, blob.html, blob.mobileHtml);
                }
              } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[store] IndexedDB rehydrate (ultima risorsa) fallita per page ${pageId}/${target}:`, err);
              }
            })
          );
        }
      })();
    } catch (error) {
      console.error('Error initializing data from Supabase:', error);
      set({
        error: error instanceof Error ? error.message : 'Supabase connection error',
        isLoading: false,
      });
    }
  },

  // Templates
  templates: [],

  addTemplate: async (template) => {
    try {
      const created = await supabaseOps.createTemplate({
        name: template.name,
        source_url: template.sourceUrl,
        page_type: template.pageType,
        view_format: template.viewFormat || 'desktop',
        tags: template.tags,
        description: template.description,
        preview_image: template.previewImage,
      });
      
      set((state) => ({
        templates: [dbTemplateToApp(created), ...state.templates],
      }));
    } catch (error) {
      console.error('Error adding template:', error);
      throw error;
    }
  },

  updateTemplate: async (id, template) => {
    try {
      const updated = await supabaseOps.updateTemplate(id, {
        name: template.name,
        source_url: template.sourceUrl,
        page_type: template.pageType,
        view_format: template.viewFormat,
        tags: template.tags,
        description: template.description,
        preview_image: template.previewImage,
      });
      
      set((state) => ({
        templates: state.templates.map((t) =>
          t.id === id ? dbTemplateToApp(updated) : t
        ),
      }));
    } catch (error) {
      console.error('Error updating template:', error);
      throw error;
    }
  },

  deleteTemplate: async (id) => {
    try {
      await supabaseOps.deleteTemplate(id);
      set((state) => ({
        templates: state.templates.filter((t) => t.id !== id),
      }));
    } catch (error) {
      console.error('Error deleting template:', error);
      throw error;
    }
  },

  // Products
  products: [],

  addProduct: async (product) => {
    try {
      const created = await supabaseOps.createProduct({
        name: product.name,
        description: product.description,
        price: product.price,
        image_url: product.imageUrl,
        benefits: product.benefits,
        cta_text: product.ctaText,
        cta_url: product.ctaUrl,
        brand_name: product.brandName,
        sku: product.sku,
        category: product.category,
        characteristics: product.characteristics,
        geo_market: product.geoMarket,
        supplier: product.supplier,
      });
      
      set((state) => ({
        products: [dbProductToApp(created), ...state.products],
      }));
    } catch (error) {
      console.error('Error adding product:', error);
      throw error;
    }
  },

  updateProduct: async (id, product) => {
    try {
      const updated = await supabaseOps.updateProduct(id, {
        name: product.name,
        description: product.description,
        price: product.price,
        image_url: product.imageUrl,
        benefits: product.benefits,
        cta_text: product.ctaText,
        cta_url: product.ctaUrl,
        brand_name: product.brandName,
        sku: product.sku,
        category: product.category,
        characteristics: product.characteristics,
        geo_market: product.geoMarket,
        supplier: product.supplier,
      });
      
      set((state) => ({
        products: state.products.map((p) =>
          p.id === id ? dbProductToApp(updated) : p
        ),
      }));
    } catch (error) {
      console.error('Error updating product:', error);
      throw error;
    }
  },

  deleteProduct: async (id) => {
    try {
      await supabaseOps.deleteProduct(id);
      set((state) => ({
        products: state.products.filter((p) => p.id !== id),
      }));
    } catch (error) {
      console.error('Error deleting product:', error);
      throw error;
    }
  },

  // Projects
  projects: [],

  addProject: async (project) => {
    try {
      const created = await supabaseOps.createProject({
        name: project.name,
        description: project.description,
        status: project.status,
        tags: project.tags,
        notes: project.notes,
        domain: project.domain,
        logo: project.logo as unknown as import('@/types/database').Json,
        market_research: project.marketResearch as unknown as import('@/types/database').Json,
        brief: project.brief,
        front_end: project.frontEnd as unknown as import('@/types/database').Json,
        back_end: project.backEnd as unknown as import('@/types/database').Json,
        compliance_funnel: project.complianceFunnel as unknown as import('@/types/database').Json,
        funnel: project.funnel as unknown as import('@/types/database').Json,
      });
      set((state) => ({
        projects: [dbProjectToApp(created), ...state.projects],
      }));
    } catch (error) {
      console.error('Error adding project:', error);
      throw error;
    }
  },

  updateProject: async (id, project) => {
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === id ? { ...p, ...project, updatedAt: new Date() } : p
      ),
    }));
    try {
      const updates: import('@/types/database').ProjectUpdate = {};
      if (project.name !== undefined) updates.name = project.name;
      if (project.description !== undefined) updates.description = project.description;
      if (project.status !== undefined) updates.status = project.status;
      if (project.tags !== undefined) updates.tags = project.tags;
      if (project.notes !== undefined) updates.notes = project.notes;
      if (project.domain !== undefined) updates.domain = project.domain;
      if (project.logo !== undefined) updates.logo = project.logo as unknown as import('@/types/database').Json;
      if (project.marketResearch !== undefined) updates.market_research = project.marketResearch as unknown as import('@/types/database').Json;
      if (project.brief !== undefined) updates.brief = project.brief;
      if (project.frontEnd !== undefined) updates.front_end = project.frontEnd as unknown as import('@/types/database').Json;
      if (project.backEnd !== undefined) updates.back_end = project.backEnd as unknown as import('@/types/database').Json;
      if (project.complianceFunnel !== undefined) updates.compliance_funnel = project.complianceFunnel as unknown as import('@/types/database').Json;
      if (project.funnel !== undefined) updates.funnel = project.funnel as unknown as import('@/types/database').Json;
      const updated = await supabaseOps.updateProject(id, updates);
      set((state) => ({
        projects: state.projects.map((p) =>
          p.id === id ? dbProjectToApp(updated) : p
        ),
      }));
    } catch (error) {
      console.error('Error updating project:', error);
    }
  },

  deleteProject: async (id) => {
    try {
      await supabaseOps.deleteProject(id);
      set((state) => ({
        projects: state.projects.filter((p) => p.id !== id),
      }));
    } catch (error) {
      console.error('Error deleting project:', error);
      throw error;
    }
  },

  // Custom page types (in-memory, per Templates)
  customPageTypes: [],
  addCustomPageType: (label) => {
    const value = label.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    if (!value) return;
    set((s) => {
      if (s.customPageTypes.some((ct) => ct.value === value)) return s;
      return {
        customPageTypes: [...s.customPageTypes, { value, label }],
      };
    });
  },
  deleteCustomPageType: (value) => {
    set((s) => ({
      customPageTypes: s.customPageTypes.filter((ct) => ct.value !== value),
    }));
  },

  // Front End Funnel Pages
  funnelPages: [],

  addFunnelPage: async (page) => {
    try {
      // The client-side field `productId` actually carries a Project id since
      // the dropdown was rebound to My Projects. We persist it on the
      // `project_id` column (FK -> projects, ON DELETE SET NULL) and leave
      // `product_id` null. Requires the `funnel_pages.product_id` NOT NULL
      // constraint to be dropped (see
      // supabase-migration-funnel-pages-product-id-nullable.sql).
      const created = await supabaseOps.createFunnelPage({
        name: page.name,
        page_type: page.pageType,
        template_id: page.templateId,
        project_id: page.productId || null,
        product_id: null,
        url_to_swipe: page.urlToSwipe,
        angle: page.angle,
        prompt: page.prompt,
        swipe_status: page.swipeStatus,
        swipe_result: page.swipeResult,
        feedback: page.feedback,
        cloned_data: page.clonedData as unknown as Record<string, unknown>,
        swiped_data: page.swipedData as unknown as Record<string, unknown>,
        analysis_status: page.analysisStatus,
        analysis_result: page.analysisResult,
        extracted_data: page.extractedData as unknown as Record<string, unknown>,
      } as Parameters<typeof supabaseOps.createFunnelPage>[0]);
      
      set((state) => ({
        funnelPages: [...state.funnelPages, dbFunnelPageToApp(created)],
      }));
    } catch (error) {
      console.error('Error adding funnel page:', error);
      throw error;
    }
  },

  updateFunnelPage: async (id, page) => {
    const prev = get().funnelPages.find((p) => p.id === id);
    // Optimistic: update local state immediately so UI stays responsive
    set((state) => ({
      funnelPages: state.funnelPages.map((p) =>
        p.id === id ? { ...p, ...page } : p
      ),
    }));
    try {
      // ── HTML PERSISTENCE (cross-session, cross-device) ──────────────
      // Prima del save Supabase: se i blob cloned/swiped/extracted hanno
      // html grossi (l'edit dell'editor produce facilmente 100-500 KB)
      // li carichiamo su Supabase Storage e nel JSONB mettiamo solo
      // `htmlUrl` (~200 byte). Altrimenti `stripHtmlFromJsonb` li
      // butterebbe via PER SEMPRE per non triggerare 57014, e al refresh
      // dell'app le edit dell'utente sparirebbero.
      //
      // `payload` = quello che va su DB (HTML strippato, solo URL).
      // Lo state in memoria continua a tenere l'html completo PIÙ gli
      // htmlUrl appena ottenuti (così la UI renderizza subito e al next
      // save abbiamo già l'URL).
      // Context per l'auto-inject del Wasabi tracker: il `funnelId` esposto
      // come `data-funnel` nel <script> iniettato e' il project_id del
      // funnel (vedi commento sopra: `project_id` sul DB coincide col
      // concetto "funnel" lato analytics). Lo step type e' il pageType
      // della pagina. Entrambi possono venire dalla patch in arrivo o
      // dallo state precedente — facciamo merge nel modo Zustand-style.
      // Se entrambi sono mancanti l'inject viene saltato (fail-safe in
      // persistHtmlToStorage).
      const trackingFunnelId =
        (page.productId ?? prev?.productId) || null;
      const trackingStepType =
        (page.pageType ?? prev?.pageType) || null;

      const persisted = await persistHtmlBlobs(
        id,
        {
          clonedData: page.clonedData,
          swipedData: page.swipedData,
          extractedData: page.extractedData as Record<string, unknown> | undefined,
        },
        {
          funnelId: trackingFunnelId,
          stepType: trackingStepType,
        },
      );

      // Esponi l'esito dell'upload Storage alla UI (banner diagnostico).
      set({ lastStorageError: persisted.storageError ?? null });

      // See `addFunnelPage`: write the selected Project id on `project_id`.
      // We only touch `product_id` if the caller explicitly cleared it
      // (page.productId === '') — otherwise the legacy value is preserved.
      const updated = await supabaseOps.updateFunnelPage(id, {
        name: page.name,
        page_type: page.pageType,
        template_id: page.templateId,
        ...(page.productId !== undefined
          ? { project_id: page.productId || null }
          : {}),
        url_to_swipe: page.urlToSwipe,
        angle: page.angle,
        prompt: page.prompt,
        swipe_status: page.swipeStatus,
        swipe_result: page.swipeResult,
        feedback: page.feedback,
        cloned_data: persisted.forDb.clonedData as unknown as Record<string, unknown>,
        swiped_data: persisted.forDb.swipedData as unknown as Record<string, unknown>,
        analysis_status: page.analysisStatus,
        analysis_result: page.analysisResult,
        extracted_data: persisted.forDb.extractedData as unknown as Record<string, unknown>,
      } as Parameters<typeof supabaseOps.updateFunnelPage>[1]);

      // Riallinea lo state in memoria con gli url Storage appena scritti
      // (mantenendo l'html originale per il render istantaneo).
      if (persisted.urlsByKind.cloned || persisted.urlsByKind.swiped || persisted.urlsByKind.extracted) {
        set((state) => ({
          funnelPages: state.funnelPages.map((p) => {
            if (p.id !== id) return p;
            return {
              ...p,
              clonedData: p.clonedData ? { ...p.clonedData, ...persisted.urlsByKind.cloned } as typeof p.clonedData : p.clonedData,
              swipedData: p.swipedData ? { ...p.swipedData, ...persisted.urlsByKind.swiped } as typeof p.swipedData : p.swipedData,
              extractedData: p.extractedData ? { ...p.extractedData, ...persisted.urlsByKind.extracted } as typeof p.extractedData : p.extractedData,
            };
          }),
        }));
      }
      
      // Merge DB result with the optimistic state instead of replacing it.
      // `supabaseOps.updateFunnelPage` strips the raw `html` blob from
      // cloned_data/swiped_data/extracted_data before persisting (it would
      // blow past Supabase's 3s anon `statement_timeout` and crash with
      // 57014). We must therefore re-attach the in-memory html that the
      // optimistic update wrote a few lines above, otherwise downstream
      // rewrite/extract calls would lose access to the cloned page.
      set((state) => ({
        funnelPages: state.funnelPages.map((p) => {
          if (p.id !== id) return p;
          const fromDb = dbFunnelPageToApp(updated);
          return {
            ...fromDb,
            clonedData: mergeJsonbWithLocalHtml(fromDb.clonedData, p.clonedData),
            swipedData: mergeJsonbWithLocalHtml(fromDb.swipedData, p.swipedData),
            extractedData: mergeJsonbWithLocalHtml(fromDb.extractedData, p.extractedData),
          };
        }),
      }));
    } catch (error) {
      // Revert on failure
      if (prev) {
        set((state) => ({
          funnelPages: state.funnelPages.map((p) =>
            p.id === id ? prev : p
          ),
        }));
      }
      console.error('Error updating funnel page:', error);
      throw error;
    }
  },

  deleteFunnelPage: async (id) => {
    try {
      await supabaseOps.deleteFunnelPage(id);
      set((state) => ({
        funnelPages: state.funnelPages.filter((p) => p.id !== id),
      }));
    } catch (error) {
      console.error('Error deleting funnel page:', error);
      throw error;
    }
  },

  launchSwipe: async (id) => {
    const page = get().funnelPages.find((p) => p.id === id);
    if (!page || !page.urlToSwipe) return;

    // Source of truth is now My Projects. The funnel page's `productId` field
    // (legacy name) holds a project id. We pass name + description + brief +
    // domain to the rewriter; the brief is the most important signal.
    const project = get().projects.find((p) => p.id === page.productId);
    if (!project) {
      await get().updateFunnelPage(id, {
        swipeStatus: 'failed',
        swipeResult: 'Select a project before launching the swipe',
      });
      return;
    }

    await get().updateFunnelPage(id, { swipeStatus: 'in_progress' });

    try {
      const clonedHtml = page.clonedData?.html || '';
      const response = await fetch(SWIPE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_url: page.urlToSwipe,
          html: clonedHtml || undefined,
          product: {
            name: project.name,
            description: project.description,
            benefits: [],
            cta_text: 'BUY NOW',
            cta_url: project.domain,
            brand_name: project.name,
          },
          brief: project.brief || '',
          project: {
            id: project.id,
            name: project.name,
            description: project.description,
            brief: project.brief,
            domain: project.domain,
          },
          language: 'it',
        }),
      });

      const data: SwipeApiResponse = await response.json();

      if (!response.ok || !data.success) {
        await get().updateFunnelPage(id, {
          swipeStatus: 'failed',
          swipeResult: data.error || 'Error during swipe',
        });
        return;
      }

      await get().updateFunnelPage(id, {
        swipeStatus: 'completed',
        swipeResult: `✓ Swipe completed: "${data.new_title || ''}" (${data.new_length || 0} chars, ${data.replacements || 0} replacements)`,
        swipedData: {
          html: data.html,
          originalTitle: data.original_title || '',
          newTitle: data.new_title || '',
          originalLength: data.original_length || 0,
          newLength: data.new_length || 0,
          processingTime: data.processing_time_seconds || 0,
          methodUsed: data.method_used || 'text-replacement',
          changesMade: data.changes_made || [],
          swipedAt: new Date(),
        },
      });
    } catch (error) {
      await get().updateFunnelPage(id, {
        swipeStatus: 'failed',
        swipeResult: error instanceof Error ? error.message : 'Network error',
      });
    }
  },

  // Post Purchase Pages
  postPurchasePages: [],

  addPostPurchasePage: async (page) => {
    try {
      const created = await supabaseOps.createPostPurchasePage({
        name: page.name,
        type: page.type,
        product_id: page.productId,
        url_to_swipe: page.urlToSwipe,
        swipe_status: page.swipeStatus,
        swipe_result: page.swipeResult,
        cloned_data: page.clonedData as unknown as Record<string, unknown>,
        swiped_data: page.swipedData as unknown as Record<string, unknown>,
      });
      
      set((state) => ({
        postPurchasePages: [dbPostPurchaseToApp(created), ...state.postPurchasePages],
      }));
    } catch (error) {
      console.error('Error adding post purchase page:', error);
      throw error;
    }
  },

  updatePostPurchasePage: async (id, page) => {
    try {
      const updated = await supabaseOps.updatePostPurchasePage(id, {
        name: page.name,
        type: page.type,
        product_id: page.productId,
        url_to_swipe: page.urlToSwipe,
        swipe_status: page.swipeStatus,
        swipe_result: page.swipeResult,
        cloned_data: page.clonedData as unknown as Record<string, unknown>,
        swiped_data: page.swipedData as unknown as Record<string, unknown>,
      });
      
      set((state) => ({
        postPurchasePages: state.postPurchasePages.map((p) =>
          p.id === id ? dbPostPurchaseToApp(updated) : p
        ),
      }));
    } catch (error) {
      console.error('Error updating post purchase page:', error);
      throw error;
    }
  },

  deletePostPurchasePage: async (id) => {
    try {
      await supabaseOps.deletePostPurchasePage(id);
      set((state) => ({
        postPurchasePages: state.postPurchasePages.filter((p) => p.id !== id),
      }));
    } catch (error) {
      console.error('Error deleting post purchase page:', error);
      throw error;
    }
  },

  launchPostPurchaseSwipe: async (id) => {
    const page = get().postPurchasePages.find((p) => p.id === id);
    if (!page || !page.urlToSwipe) return;

    // See `launchSwipe` for rationale: project replaces the legacy product.
    const project = get().projects.find((p) => p.id === page.productId);
    if (!project) {
      await get().updatePostPurchasePage(id, {
        swipeStatus: 'failed',
        swipeResult: 'Select a project before launching the swipe',
      });
      return;
    }

    await get().updatePostPurchasePage(id, { swipeStatus: 'in_progress' });

    try {
      const ppClonedHtml = page.clonedData?.html || '';
      const response = await fetch(SWIPE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_url: page.urlToSwipe,
          html: ppClonedHtml || undefined,
          product: {
            name: project.name,
            description: project.description,
            benefits: [],
            cta_text: 'BUY NOW',
            cta_url: project.domain,
            brand_name: project.name,
          },
          brief: project.brief || '',
          project: {
            id: project.id,
            name: project.name,
            description: project.description,
            brief: project.brief,
            domain: project.domain,
          },
          language: 'it',
        }),
      });

      const data: SwipeApiResponse = await response.json();

      if (!response.ok || !data.success) {
        await get().updatePostPurchasePage(id, {
          swipeStatus: 'failed',
          swipeResult: data.error || 'Error during swipe',
        });
        return;
      }

      await get().updatePostPurchasePage(id, {
        swipeStatus: 'completed',
        swipeResult: `✓ Swipe completed: "${data.new_title || ''}" (${data.new_length || 0} chars, ${data.replacements || 0} replacements)`,
        swipedData: {
          html: data.html,
          originalTitle: data.original_title || '',
          newTitle: data.new_title || '',
          originalLength: data.original_length || 0,
          newLength: data.new_length || 0,
          processingTime: data.processing_time_seconds || 0,
          methodUsed: data.method_used || 'text-replacement',
          changesMade: data.changes_made || [],
          swipedAt: new Date(),
        },
      });
    } catch (error) {
      await get().updatePostPurchasePage(id, {
        swipeStatus: 'failed',
        swipeResult: error instanceof Error ? error.message : 'Network error',
      });
    }
  },

  // Archived Funnels
  archivedFunnels: [],
  archivedFunnelsLoaded: false,

  loadArchivedFunnels: async () => {
    if (get().archivedFunnelsLoaded) return;
    try {
      const data = await supabaseOps.fetchArchivedFunnels();
      set({ archivedFunnels: data, archivedFunnelsLoaded: true });
    } catch (error) {
      console.error('Error loading archived funnels:', error);
    }
  },

  saveCurrentFunnelAsArchive: async (name: string, section?: string) => {
    const pages = get().funnelPages;
    // funnelPages.productId now references a Project (My Projects).
    const projects = get().projects;
    const templates = get().templates;
    if (!pages || pages.length === 0) return;

    // Materializza l'HTML di OGNI step prima di salvare in archivio, con la
    // stessa catena di fallback usata dal save-to-project:
    //   1) HTML inline in memoria (clonedData/swipedData.html)
    //   2) IndexedDB (backup locale dell'ultima edit)
    //   3) page_html via htmlUrl (snapshot server, sopravvive al reload)
    // Senza questo, le pagine ricaricate da una sessione precedente hanno
    // solo `htmlUrl` (HTML offloaded) → lo step finiva in archivio SENZA
    // `.html` e, sparito il link sorgente, non restava nulla da mostrare.
    const { loadHtmlBlob } = await import('@/lib/html-blob-store');
    const { fetchHtmlFromStorage } = await import('@/lib/funnel-html-storage');

    const materializeHtml = async (
      p: typeof pages[number],
    ): Promise<{ html: string; mobileHtml: string }> => {
      let html = p.swipedData?.html || p.clonedData?.html || '';
      let mobileHtml = p.swipedData?.mobileHtml || p.clonedData?.mobileHtml || '';
      if (!html) {
        try {
          const target: 'swipedData' | 'clonedData' = p.swipedData ? 'swipedData' : 'clonedData';
          const blob = await loadHtmlBlob(p.id, target);
          html = blob?.html || '';
          mobileHtml = mobileHtml || blob?.mobileHtml || '';
          if (!html) {
            const other = await loadHtmlBlob(p.id, target === 'swipedData' ? 'clonedData' : 'swipedData');
            html = other?.html || '';
            mobileHtml = mobileHtml || other?.mobileHtml || '';
          }
        } catch { /* IDB non disponibile */ }
      }
      if (!html) {
        const url = p.swipedData?.htmlUrl || p.clonedData?.htmlUrl;
        if (url) {
          try { html = (await fetchHtmlFromStorage(url)) || ''; } catch { /* offline */ }
        }
        const mUrl = p.swipedData?.mobileHtmlUrl || p.clonedData?.mobileHtmlUrl;
        if (!mobileHtml && mUrl) {
          try { mobileHtml = (await fetchHtmlFromStorage(mUrl)) || ''; } catch { /* offline */ }
        }
      }
      return { html, mobileHtml };
    };

    const steps = await Promise.all(pages.map(async (p, i) => {
      const { html, mobileHtml } = await materializeHtml(p);
      // Riattacca l'HTML materializzato al blob che la pagina My Archive
      // legge (`swiped_data?.html || cloned_data?.html`). Preferiamo il
      // bucket "swiped" se la pagina è stata riscritta, altrimenti "cloned".
      const swiped_data = p.swipedData
        ? { ...p.swipedData, html: html || p.swipedData.html, mobileHtml: mobileHtml || p.swipedData.mobileHtml }
        : null;
      const cloned_data = p.clonedData
        ? { ...p.clonedData, html: (!p.swipedData ? (html || p.clonedData.html) : p.clonedData.html), mobileHtml: mobileHtml || p.clonedData.mobileHtml }
        : (!p.swipedData && html ? { html, mobileHtml: mobileHtml || undefined } : null);
      return {
        step_index: i + 1,
        name: p.name,
        page_type: p.pageType,
        template_name: templates.find(t => t.id === p.templateId)?.name || '',
        product_name: projects.find(pr => pr.id === p.productId)?.name || '',
        url_to_swipe: p.urlToSwipe,
        prompt: p.prompt || '',
        feedback: p.feedback || '',
        swipe_status: p.swipeStatus,
        swipe_result: p.swipeResult || '',
        swiped_data,
        cloned_data,
      };
    }));

    try {
      const created = await supabaseOps.createArchivedFunnel({
        name,
        total_steps: steps.length,
        steps: steps as unknown as import('@/types/database').Json,
        ...(section ? { section } : {}),
      });
      set((state) => ({
        archivedFunnels: [created, ...state.archivedFunnels],
      }));
    } catch (error) {
      console.error('Error saving funnel to archive:', error);
      throw error;
    }
  },

  deleteArchivedFunnel: async (id: string) => {
    try {
      await supabaseOps.deleteArchivedFunnel(id);
      set((state) => ({
        archivedFunnels: state.archivedFunnels.filter((f) => f.id !== id),
      }));
    } catch (error) {
      console.error('Error deleting archived funnel:', error);
      throw error;
    }
  },
}));
