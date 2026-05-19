// Supabase Edge Function: funnel-translate-v1
//
// Funzione DEDICATA al Translate. Separata da `funnel-swap-v1-functions`
// perche':
//   - quella e' un mostro multi-modalita' (extract / process / rewrite /
//     identical) e ogni edit rischia regressioni sul rewrite live;
//   - la translate via `clone-funnel/route.ts` puntava a una function
//     fantasma `smooth-responder` che non e' deployata, restituendo
//     POST /api/clone-funnel 404 al client.
//
// Contratto IO (deve restare compatibile con il client front-end-funnel):
//   IN  : { cloneMode: 'translate', htmlContent: string,
//           targetLanguage: string, userId: string,
//           system_kb?: string }
//   OUT : { content: string,           // HTML tradotto
//           textsTranslated: number,
//           targetLanguage: string,
//           originalHtmlSize: number,
//           finalHtmlSize: number,
//           model: string,
//           durationMs: number }
//   ERR : { error: string }    HTTP 4xx/5xx
//
// Deploy: il workflow `.github/workflows/supabase-functions-deploy.yml`
// deploya tutte le cartelle in `supabase/functions/*/` come "best
// effort", quindi questa va online automaticamente al prossimo push su
// main.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── CONFIG ──────────────────────────────────────────────────────────────
const CLAUDE_MODEL = 'claude-sonnet-4-20250514'
const CLAUDE_MAX_TOKENS = 16000
// Numero di testi per chiamata a Claude. 12 e' il punto dolce: testi
// piccoli stanno comodi in 16K output token, e su una landing tipica
// (200-400 testi) servono 17-34 chiamate, gestibili in <5min.
const BATCH_SIZE = 12
// Timeout per singola chiamata Claude. Una landing media completa la
// translate in ~60-180s totali; il timeout per-batch deve essere ben
// sotto al budget Edge Function (300s) per lasciare spazio agli ultimi
// batch.
const CLAUDE_TIMEOUT_MS = 90_000
// Hard cap su quanti testi proviamo a tradurre. Le landing piu' grandi
// hanno ~600 testi; oltre c'e' boilerplate / template che non vale la
// pena tradurre e fa esplodere il tempo.
const MAX_TEXTS = 800

// ── TEXT EXTRACTION ─────────────────────────────────────────────────────
//
// Approccio regex-based, no DOM (Deno non ha querySelector built-in e
// importare `deno-dom` aggiunge ~1MB e cold start). Il tradeoff: niente
// nesting awareness (un <p> dentro <article> viene visto come 2 match
// se entrambi hanno testo). Per il translate va benissimo: ogni match
// con testo unico viene tradotto una volta.
//
// Tag che contengono copy reale (non strutturali). Volutamente NO `div`
// per evitare fragment di intero blocco.
const TEXT_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'li', 'td', 'th', 'dt', 'dd',
  'button', 'a', 'label', 'figcaption',
  'blockquote', 'summary', 'legend',
  'span', 'strong', 'em', 'b', 'i', 'u',
]

const ATTR_TEXTS = ['alt', 'title', 'placeholder', 'aria-label']

interface ExtractedText {
  id: number
  text: string
  tag: string
  // Hash dell'intero contesto (open tag + classes) per permettere la
  // re-injection sicura: usiamo la lookup nella stringa originale.
  // Niente position byte: scriviamo la replace per lookup esatto.
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
}

function encodeHtmlEntities(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function cleanText(s: string): string {
  return decodeHtmlEntities(s).replace(/\s+/g, ' ').trim()
}

function isTranslatableText(s: string): boolean {
  const t = s.trim()
  if (t.length < 2) return false
  if (t.length > 4000) return false
  // Solo numeri / simboli
  if (/^[\s\d.,$€£¥%+\-/*()[\]{}|\\!?:;<>="'#@&_]+$/.test(t)) return false
  // Placeholder template
  if (/^\s*\{\{[\s\S]*\}\}\s*$/.test(t)) return false
  if (/^\s*\{%[\s\S]*%\}\s*$/.test(t)) return false
  if (/^\s*\$\{[\s\S]*\}\s*$/.test(t)) return false
  // Marker tecnici comuni dei page builder
  const lower = t.toLowerCase()
  if (
    [
      'text', 'title', 'link', 'button', 'image', 'submit',
      'placeholder', 'none', 'default', 'block', 'lorem ipsum',
      'sample text', 'click here', 'true', 'false',
    ].includes(lower)
  ) {
    return false
  }
  // CSS/JS residui
  if (/^[{};:|()<>=]+$/.test(t)) return false
  return true
}

function extractTextsFromHtml(html: string): ExtractedText[] {
  const out: ExtractedText[] = []
  const seen = new Set<string>()
  let nextId = 0

  const push = (text: string, tag: string) => {
    const cleaned = cleanText(text)
    if (!isTranslatableText(cleaned)) return
    const key = `${tag}::${cleaned}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ id: nextId++, text: cleaned, tag })
    if (out.length >= MAX_TEXTS) return
  }

  // 1) <title>
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (titleMatch) push(titleMatch[1], 'title')

  // 2) meta description / og:title / og:description / twitter:*
  const allowedMeta = new Set([
    'description',
    'og:title', 'og:description', 'og:site_name',
    'twitter:title', 'twitter:description',
  ])
  const metaRegex = /<meta\s+([^>]+?)>/gi
  let m: RegExpExecArray | null
  while ((m = metaRegex.exec(html)) !== null) {
    if (out.length >= MAX_TEXTS) break
    const attrs = m[1]
    const contentMatch = attrs.match(/content=["']([^"']+)["']/i)
    if (!contentMatch) continue
    if (/http-equiv=/i.test(attrs)) continue
    const nameMatch = attrs.match(/name=["']([^"']+)["']/i)
    const propMatch = attrs.match(/property=["']([^"']+)["']/i)
    const key = (nameMatch?.[1] || propMatch?.[1] || '').toLowerCase()
    if (!allowedMeta.has(key)) continue
    push(contentMatch[1], `meta:${key}`)
  }

  // 3) tag testuali — pattern <tag ...>contenuto</tag>
  for (const tag of TEXT_TAGS) {
    if (out.length >= MAX_TEXTS) break
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi')
    let mm: RegExpExecArray | null
    while ((mm = re.exec(html)) !== null) {
      if (out.length >= MAX_TEXTS) break
      // Strip nested tags from inner content to grab just the visible
      // text. Lascia perdere se il contenuto ha tag annidati: prendiamo
      // i match foglia separati nei loro tag rispettivi.
      const inner = mm[1]
      // Skip se contiene altri tag block-level: lo prenderemo nel loro
      // proprio loop. Pero' inline tags (b/i/em/strong/span) li
      // includiamo nel testo.
      const hasBlockChild = /<(?:p|li|h[1-6]|button|a|td|th|figcaption|blockquote)\b/i.test(inner)
      if (hasBlockChild) continue
      const text = inner.replace(/<[^>]+>/g, ' ')
      push(text, tag)
    }
  }

  // 4) attributi testuali
  for (const attr of ATTR_TEXTS) {
    if (out.length >= MAX_TEXTS) break
    const re = new RegExp(`${attr}=["']([^"']+)["']`, 'gi')
    let mm: RegExpExecArray | null
    while ((mm = re.exec(html)) !== null) {
      if (out.length >= MAX_TEXTS) break
      push(mm[1], `attr:${attr}`)
    }
  }

  return out
}

// ── TEXT REPLACEMENT ────────────────────────────────────────────────────
//
// Per ogni testo originale -> tradotto, sostituisce TUTTE le occorrenze
// nella forma encoded HTML. Replace per occurrenza (non per byte index)
// perche' a) i match regex su HTML scompongono il flusso, b) il client
// poi renderizza l'HTML risultante e tag/attribute/text condividono lo
// stesso mapping originale (es. "Acquista ora" appare come <button>
// E come aria-label= → tradotto in entrambi i posti con un solo replace).

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function applyTranslations(
  html: string,
  pairs: Array<{ original: string; translated: string }>,
): { html: string; replacements: number } {
  let out = html
  let replacements = 0
  // Ordine: piu' lunghi prima per evitare che "ciao" sostituisca dentro
  // "ciao mondo".
  const sorted = [...pairs].sort((a, b) => b.original.length - a.original.length)

  for (const { original, translated } of sorted) {
    if (!original || !translated || original === translated) continue
    // Forma 1: testo come appare nell'HTML (encoded)
    const encOrig = encodeHtmlEntities(original)
    const encTrans = encodeHtmlEntities(translated)
    if (encOrig.length >= 2) {
      const re1 = new RegExp(escapeForRegex(encOrig), 'g')
      const before = out
      out = out.replace(re1, encTrans)
      if (out !== before) replacements += (before.length - out.length === 0 ? 1 : 1)
    }
    // Forma 2: dentro attributi (non necessariamente encoded)
    if (original !== encOrig && original.length >= 2) {
      const re2 = new RegExp(escapeForRegex(original), 'g')
      const before = out
      out = out.replace(re2, translated)
      if (out !== before) replacements += 1
    }
  }
  return { html: out, replacements }
}

// ── CLAUDE TRANSLATE BATCH ──────────────────────────────────────────────

interface TranslatedItem { id: number; translated: string }

async function translateBatchWithClaude(params: {
  apiKey: string
  systemKb: string
  targetLanguage: string
  batch: ExtractedText[]
  batchNumber: number
  totalBatches: number
}): Promise<TranslatedItem[]> {
  const { apiKey, systemKb, targetLanguage, batch, batchNumber, totalBatches } = params

  const systemBlocks: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text:
        `Sei un traduttore professionista specializzato in copy persuasivo e marketing. ` +
        `Traduci ogni testo in ${targetLanguage} mantenendo: ` +
        `(1) il tono e l'intento del testo originale (titoli punchy restano punchy, CTA restano CTA brevi); ` +
        `(2) la lunghezza approssimativa (entro ±30%); ` +
        `(3) eventuali placeholder come {{NAME}}, [CITY], {price}, $X, %d, %s — copia tali e quali; ` +
        `(4) numeri, valute, simboli — mantieni o convertili in modo naturale per la lingua target ` +
        `(es. $ → € per italiano se appropriato, ma non forzare se il prezzo e' un riferimento concreto); ` +
        `(5) maiuscole stilistiche del titolo se presenti. ` +
        `Restituisci SOLO un JSON array di oggetti { "id": number, "translated": "..." }, niente prosa, niente markdown.`,
      cache_control: { type: 'ephemeral' },
    },
  ]

  // KB del cliente (cached) — es. brand voice, product positioning. Se il
  // chiamante l'ha passato lo aggiungiamo come cached system block per
  // pagare i token una volta sola.
  if (systemKb && systemKb.length > 200) {
    systemBlocks.push({
      type: 'text',
      text: `📚 BRAND/PRODUCT KNOWLEDGE BASE — usa per scegliere il vocabolario corretto:\n\n${systemKb.slice(0, 28000)}`,
      cache_control: { type: 'ephemeral' },
    })
  }

  const userPrompt =
    `Batch ${batchNumber + 1}/${totalBatches}. Traduci i seguenti ${batch.length} testi in ${targetLanguage}.\n\n` +
    'INPUT:\n' +
    JSON.stringify(
      batch.map(b => ({ id: b.id, tag: b.tag, text: b.text })),
      null,
      0,
    ) +
    '\n\nOUTPUT (SOLO JSON array):'

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: CLAUDE_MAX_TOKENS,
        temperature: 0.3,
        system: systemBlocks,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
  } catch (e) {
    clearTimeout(timeoutId)
    const err = e as Error
    if (err.name === 'AbortError' || controller.signal.aborted) {
      throw new Error(`Timeout Claude API (${CLAUDE_TIMEOUT_MS / 1000}s) sul batch ${batchNumber + 1}`)
    }
    throw new Error(`Errore chiamata Claude: ${err.message}`)
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({} as Record<string, unknown>))
    const errObj = (errBody as { error?: { message?: string } }).error
    throw new Error(`Claude API ${res.status}: ${errObj?.message || 'unknown'}`)
  }

  const data = await res.json() as { content?: Array<{ text?: string }>; usage?: Record<string, number> }
  const responseText = (data.content?.[0]?.text || '').trim()

  // Log usage per visibilita' nei log Supabase
  try {
    const u = data.usage || {}
    console.log(
      `💰 batch ${batchNumber + 1}/${totalBatches} — input=${u.input_tokens || 0} ` +
      `cache_read=${u.cache_read_input_tokens || 0} cache_write=${u.cache_creation_input_tokens || 0} ` +
      `output=${u.output_tokens || 0}`,
    )
  } catch { /* best-effort */ }

  // Parse JSON. Claude a volte avvolge in ```json ... ```
  let jsonText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  const arrayStart = jsonText.indexOf('[')
  const arrayEnd = jsonText.lastIndexOf(']')
  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    jsonText = jsonText.slice(arrayStart, arrayEnd + 1)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    console.warn(`⚠️ Impossibile parsare risposta Claude batch ${batchNumber + 1}, prime 200 char:\n${responseText.slice(0, 200)}`)
    return []
  }

  if (!Array.isArray(parsed)) return []
  const items: TranslatedItem[] = []
  for (const row of parsed as Array<Record<string, unknown>>) {
    if (typeof row?.id !== 'number') continue
    if (typeof row?.translated !== 'string') continue
    const trimmed = row.translated.trim()
    if (!trimmed) continue
    items.push({ id: row.id, translated: trimmed })
  }
  return items
}

// ── HANDLER ─────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const startedAt = Date.now()

  try {
    const body = await req.json().catch(() => null) as
      | {
          cloneMode?: string
          htmlContent?: string
          targetLanguage?: string
          userId?: string
          system_kb?: string
        }
      | null

    if (!body) {
      return new Response(
        JSON.stringify({ error: 'Body JSON malformato' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (body.cloneMode !== 'translate') {
      return new Response(
        JSON.stringify({ error: `funnel-translate-v1 accetta solo cloneMode=translate, ricevuto: ${body.cloneMode}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const html = body.htmlContent
    const targetLanguage = body.targetLanguage
    const userId = body.userId

    if (!html || typeof html !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid htmlContent' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }
    if (!targetLanguage || typeof targetLanguage !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid targetLanguage' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // Lookup Anthropic API key. Strategia in due livelli:
    //
    //   1) Edge Function secret `ANTHROPIC_API_KEY` (recommended in
    //      single-user setup, una chiave per tutta la function).
    //      Configurazione:
    //        supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
    //          --project-ref <YOUR_PROJECT_REF>
    //      oppure dashboard:
    //        Project → Edge Functions → Manage secrets
    //
    //   2) `user_profiles.anthropic_api_key` per l'`userId` ricevuto.
    //      Modalita' multi-tenant legacy. Funziona solo se il client
    //      manda un `userId` reale che esiste nella tabella; il
    //      front-end attuale manda l'UUID fittizio
    //      00000000-0000-0000-0000-000000000001 che non esiste,
    //      quindi questo path fallisce silenziosamente — usato solo
    //      come fallback se il secret non e' settato.
    let apiKey: string | undefined = Deno.env.get('ANTHROPIC_API_KEY')?.trim() || undefined

    if (!apiKey && userId && typeof userId === 'string') {
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      )
      const { data: userProfile } = await supabase
        .from('user_profiles')
        .select('anthropic_api_key')
        .eq('id', userId)
        .single()
      if (userProfile?.anthropic_api_key) {
        apiKey = userProfile.anthropic_api_key
      }
    }

    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error:
            'Anthropic API key non disponibile. ' +
            'Imposta il secret `ANTHROPIC_API_KEY` sulla Edge Function:\n' +
            '  supabase secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref <YOUR_PROJECT_REF>\n' +
            'oppure dal dashboard: Project → Edge Functions → Manage secrets.',
        }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    console.log(`🌍 Translate START - target=${targetLanguage} - HTML ${html.length} char`)

    // 1) Estrai testi traducibili
    const texts = extractTextsFromHtml(html)
    console.log(`📝 Estratti ${texts.length} testi unici da tradurre`)

    if (texts.length === 0) {
      return new Response(
        JSON.stringify({
          content: html,
          textsTranslated: 0,
          targetLanguage,
          originalHtmlSize: html.length,
          finalHtmlSize: html.length,
          model: CLAUDE_MODEL,
          durationMs: Date.now() - startedAt,
          warning: 'Nessun testo traducibile trovato nell\'HTML',
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // 2) Chunk in batch da BATCH_SIZE
    const batches: ExtractedText[][] = []
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      batches.push(texts.slice(i, i + BATCH_SIZE))
    }
    console.log(`📦 ${batches.length} batch da ${BATCH_SIZE} testi`)

    // 3) Traduci ciascun batch (sequenziale per evitare rate-limit
    //    Anthropic: 50 req/min sul tier base. Concurrency 1 e' safe.)
    const idToTranslated = new Map<number, string>()
    const systemKb = typeof body.system_kb === 'string' ? body.system_kb : ''
    let failedBatches = 0

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]
      try {
        const translated = await translateBatchWithClaude({
          apiKey,
          systemKb,
          targetLanguage,
          batch,
          batchNumber: i,
          totalBatches: batches.length,
        })
        for (const t of translated) {
          idToTranslated.set(t.id, t.translated)
        }
      } catch (e) {
        failedBatches++
        const err = e as Error
        console.warn(`⚠️ batch ${i + 1}/${batches.length} fallito: ${err.message}`)
      }
    }

    console.log(`✅ Tradotti ${idToTranslated.size}/${texts.length} testi (${failedBatches} batch falliti)`)

    // 4) Applica le traduzioni all'HTML
    const pairs = texts
      .filter(t => idToTranslated.has(t.id))
      .map(t => ({ original: t.text, translated: idToTranslated.get(t.id)! }))

    const { html: translatedHtml, replacements } = applyTranslations(html, pairs)
    console.log(`🔄 ${replacements} sostituzioni applicate all'HTML`)

    // Annotazione lang attribute (best effort) sull'<html>
    let withLangAttr = translatedHtml
    const langCode = (targetLanguage || '').toLowerCase().slice(0, 2) || 'en'
    if (!/<html\b[^>]*\blang=/i.test(withLangAttr)) {
      withLangAttr = withLangAttr.replace(/<html\b/i, `<html lang="${langCode}"`)
    } else {
      withLangAttr = withLangAttr.replace(/<html\b([^>]*)\blang=["'][^"']*["']/i, `<html$1lang="${langCode}"`)
    }

    return new Response(
      JSON.stringify({
        content: withLangAttr,
        textsTranslated: idToTranslated.size,
        textsExtracted: texts.length,
        replacements,
        targetLanguage,
        originalHtmlSize: html.length,
        finalHtmlSize: withLangAttr.length,
        model: CLAUDE_MODEL,
        durationMs: Date.now() - startedAt,
        ...(failedBatches > 0 ? { warning: `${failedBatches}/${batches.length} batch falliti` } : {}),
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (e) {
    const err = e as Error
    console.error('❌ funnel-translate-v1 errore:', err.message, err.stack)
    return new Response(
      JSON.stringify({ error: `Errore interno: ${err.message}` }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
