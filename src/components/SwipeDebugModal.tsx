'use client';

/**
 * SwipeDebugModal
 *
 * Popup bloccante mostrato PRIMA di enqueueare un job swipe_landing_local
 * a Neo / Morfeo. Mostra esattamente cosa sta per essere passato:
 *  - agente scelto + macchina + workspace + target_agent routing
 *  - documento SHARED-KNOWLEDGE del processo swipe
 *  - regole anti-paraphrase iniettate via openclaw-extra-context.md
 *  - prodotto target
 *  - brief (con sorgente e lunghezza)
 *  - market research (con sorgente e lunghezza)
 *  - tecniche libreria saved_prompts
 *  - payload meta (action, source url, tono, lingua, dimensione HTML)
 *
 * L'utente clicca "Procedi" per enqueueare, "Annulla" per abortire.
 *
 * Pattern d'uso (imperativo, ritorna Promise<boolean>):
 *
 *   const [debug, setDebug] = useState<SwipeDebugInfo | null>(null);
 *   const resolveRef = useRef<((b: boolean) => void) | null>(null);
 *   const confirmDebug = (info: SwipeDebugInfo) => new Promise<boolean>(
 *     (resolve) => { resolveRef.current = resolve; setDebug(info); }
 *   );
 *   // ...prima dell'enqueue:
 *   const ok = await confirmDebug({ ...payloadInfo });
 *   if (!ok) return;
 *   // ...enqueue come prima
 *
 *   // nel JSX:
 *   <SwipeDebugModal info={debug} onResolve={(b) => {
 *     resolveRef.current?.(b);
 *     setDebug(null);
 *     resolveRef.current = null;
 *   }} />
 */

export type SwipeDebugAgent = 'neo' | 'morfeo' | 'claude';

export interface SwipeDebugInfo {
  agent: SwipeDebugAgent;
  agentName: string;
  targetAgent: string | null;
  workspaceDir: string;
  sharedKnowledgeDoc: string;
  rulesInjected: string;
  payload: {
    action: string;
    sourceUrl: string | null;
    product: Record<string, unknown>;
    tone: string;
    language: string;
    knowledge: {
      prompts: unknown[];
      project: {
        name: string;
        brief: string | null;
        market_research: unknown;
        notes: string | null;
      };
    };
    htmlLength: number;
  };
  briefSource: 'manuale' | 'progetto' | 'mancante';
  mrSource: 'manuale' | 'progetto' | 'mancante';
  // For Swipe-All (loop su N pagine): se valorizzato il modal mostra
  // "esempio della prima pagina + verranno mandati N job uguali con il
  // brief/product della rispettiva pagina".
  batchInfo?: { totalPages: number; firstPageName: string };
}

export default function SwipeDebugModal({
  info,
  onResolve,
}: {
  info: SwipeDebugInfo | null;
  onResolve: (proceed: boolean) => void;
}) {
  if (!info) return null;
  const briefStr = info.payload.knowledge.project.brief || '';
  const mr = info.payload.knowledge.project.market_research;
  const mrStr =
    typeof mr === 'string' ? mr : mr ? JSON.stringify(mr, null, 2) : '';
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[100] p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-gray-200 bg-gradient-to-r from-purple-600 to-indigo-600 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-white">
              Swipe Debug — cosa verra&apos; passato a {info.agentName}
            </h2>
            <p className="text-white/80 text-sm">
              {info.batchInfo
                ? `Verranno mandati ${info.batchInfo.totalPages} job, uno per pagina. Esempio sotto: payload della 1ª pagina "${info.batchInfo.firstPageName}". Brief/product cambiano per pagina, regole + agente sono uguali.`
                : 'Verifica prima di lanciare: brief, market research, product facts, regole iniettate.'}
            </p>
          </div>
          <button
            onClick={() => onResolve(false)}
            className="text-white/80 hover:text-white text-2xl leading-none"
            title="Annulla"
          >
            ×
          </button>
        </div>

        <div className="overflow-y-auto p-6 space-y-5 text-sm">
          {/* AGENTE */}
          <section>
            <h3 className="font-semibold text-gray-900 mb-2">🤖 Agente scelto</h3>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-1">
              <div>
                <span className="text-gray-500">Nome:</span>{' '}
                <strong>{info.agentName}</strong>
              </div>
              <div>
                <span className="text-gray-500">
                  target_agent (routing Supabase):
                </span>{' '}
                <code className="text-purple-700">
                  {info.targetAgent || '(null = qualunque worker)'}
                </code>
              </div>
              <div>
                <span className="text-gray-500">Workspace OpenClaw:</span>{' '}
                <code className="text-xs text-gray-700 break-all">
                  {info.workspaceDir}
                </code>
              </div>
            </div>
          </section>

          {/* DOCUMENTO INTERNO */}
          <section>
            <h3 className="font-semibold text-gray-900 mb-2">
              📄 Documento SHARED-KNOWLEDGE usato per gli swipe
            </h3>
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 whitespace-pre-line text-gray-700">
              {info.sharedKnowledgeDoc}
            </div>
          </section>

          {/* REGOLE OBBLIGATORIE INIETTATE */}
          <section>
            <h3 className="font-semibold text-gray-900 mb-2">
              ⚠️ Regole obbligatorie iniettate in ogni call (openclaw-extra-context.md)
            </h3>
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-gray-800">
              {info.rulesInjected}
            </div>
          </section>

          {/* PRODOTTO */}
          <section>
            <h3 className="font-semibold text-gray-900 mb-2">🛍️ Prodotto target</h3>
            <pre className="bg-gray-50 border border-gray-200 rounded-lg p-3 overflow-x-auto text-xs whitespace-pre-wrap">
              {JSON.stringify(info.payload.product, null, 2)}
            </pre>
          </section>

          {/* BRIEF */}
          <section>
            <h3 className="font-semibold text-gray-900 mb-2">
              📝 Brief (source:{' '}
              <span
                className={
                  info.briefSource === 'mancante'
                    ? 'text-red-600'
                    : 'text-green-700'
                }
              >
                {info.briefSource}
              </span>
              , {briefStr.length} char)
            </h3>
            {briefStr ? (
              <pre className="bg-gray-50 border border-gray-200 rounded-lg p-3 overflow-x-auto text-xs whitespace-pre-wrap max-h-60">
                {briefStr}
              </pre>
            ) : (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700">
                ⚠ Nessun brief: l&apos;agente dovra&apos; ricostruirlo dai suoi archivi nel
                primer step (qualita&apos; inferiore).
              </div>
            )}
          </section>

          {/* MARKET RESEARCH */}
          <section>
            <h3 className="font-semibold text-gray-900 mb-2">
              🔍 Market Research (source:{' '}
              <span
                className={
                  info.mrSource === 'mancante' ? 'text-red-600' : 'text-green-700'
                }
              >
                {info.mrSource}
              </span>
              , {mrStr.length} char)
            </h3>
            {mrStr ? (
              <pre className="bg-gray-50 border border-gray-200 rounded-lg p-3 overflow-x-auto text-xs whitespace-pre-wrap max-h-60">
                {mrStr}
              </pre>
            ) : (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700">
                ⚠ Nessuna market research.
              </div>
            )}
          </section>

          {/* KNOWLEDGE PROMPTS */}
          <section>
            <h3 className="font-semibold text-gray-900 mb-2">
              📚 Tecniche libreria saved_prompts ({info.payload.knowledge.prompts.length})
            </h3>
            {info.payload.knowledge.prompts.length === 0 ? (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-yellow-800">
                Nessuna tecnica caricata dalla libreria. L&apos;agente usera&apos; solo
                le sue tecniche interne (Schwartz/Sultanic/Georgi/Halbert/ecc).
              </div>
            ) : (
              <ul className="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-1 max-h-40 overflow-y-auto">
                {info.payload.knowledge.prompts.map((p, idx) => {
                  const pp = p as { title?: string; category?: string };
                  return (
                    <li key={idx} className="text-xs">
                      <strong>{pp.title || '(no title)'}</strong> —{' '}
                      <span className="text-gray-500">{pp.category || '?'}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* PAYLOAD META */}
          <section>
            <h3 className="font-semibold text-gray-900 mb-2">⚙️ Payload tecnico</h3>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs space-y-1">
              <div>
                <span className="text-gray-500">Action:</span>{' '}
                <code>{info.payload.action}</code>
              </div>
              <div>
                <span className="text-gray-500">Source URL:</span>{' '}
                <code className="break-all">
                  {info.payload.sourceUrl ||
                    '(nessuna, viene usato html clonato)'}
                </code>
              </div>
              <div>
                <span className="text-gray-500">Tono:</span>{' '}
                <code>{info.payload.tone}</code>
              </div>
              <div>
                <span className="text-gray-500">Lingua output:</span>{' '}
                <code>{info.payload.language}</code>
              </div>
              <div>
                <span className="text-gray-500">HTML originale:</span>{' '}
                <code>{info.payload.htmlLength} char</code>
              </div>
            </div>
          </section>
        </div>

        <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex items-center justify-end gap-3">
          <button
            onClick={() => onResolve(false)}
            className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
          >
            Annulla
          </button>
          <button
            onClick={() => onResolve(true)}
            className="px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-semibold"
          >
            {info.batchInfo
              ? `Procedi con ${info.batchInfo.totalPages} pagine →`
              : 'Procedi col swipe →'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Helper: costruisce un SwipeDebugInfo standard a partire dai dati che
 * gia` esistono lato client. Mantiene la coerenza tra le pagine che
 * usano il modal (clone-landing, front-end-funnel, ecc) e centralizza
 * la stringa "workspaceDir" / "sharedKnowledgeDoc" / "rulesInjected" che
 * altrimenti rischia di driftare.
 */
export function buildSwipeDebugInfo(args: {
  agent: SwipeDebugAgent;
  agentLabel: string;
  targetAgent: string | null;
  payload: SwipeDebugInfo['payload'];
  briefSource: SwipeDebugInfo['briefSource'];
  mrSource: SwipeDebugInfo['mrSource'];
  batchInfo?: SwipeDebugInfo['batchInfo'];
}): SwipeDebugInfo {
  const isNeo = args.agent === 'neo';
  return {
    agent: args.agent,
    agentName: args.agentLabel,
    targetAgent: args.targetAgent,
    workspaceDir: isNeo
      ? 'PC Windows (Neo) — C:\\Users\\Neo\\.openclaw\\workspace (agent main)'
      : 'Mac (Morfeo) — ~/.openclaw/workspace-morpheus (agent morpheus). Il job viene messo in coda su Supabase e raccolto dal worker sul Mac.',
    sharedKnowledgeDoc: isNeo
      ? 'C:\\Users\\Neo\\.openclaw\\workspace\\agents\\SHARED-KNOWLEDGE\\processes\\swipe-html-process.md\n(regola fondamentale: NON adattare il competitor, RISCRIVERE dal brief)'
      : 'Morfeo gira sul Mac, ha il suo workspace separato. Le regole anti-paraphrase arrivano comunque via openclaw-extra-context.md committato nel repo: appena il Mac fa `git pull` e riavvia il worker, anche Morfeo le carica.',
    rulesInjected:
      'openclaw-extra-context.md (drop accanto al worker): 5 regole obbligatorie tra cui "NON adattare = SBAGLIATO, RISCRIVERE dal brief = GIUSTO", lunghezza blocco, fact substitution, brief come fonte di verita\', auto-check pre-risposta.',
    payload: args.payload,
    briefSource: args.briefSource,
    mrSource: args.mrSource,
    batchInfo: args.batchInfo,
  };
}
