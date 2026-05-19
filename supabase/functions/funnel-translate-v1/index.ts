// Supabase Edge Function: funnel-translate-v1
//
// Modalita' BATCH stateless (architettura client-driven):
//   IN  : { cloneMode: 'translate', mode: 'batch',
//           texts: [{ id: number, text: string, tag?: string }, ...],
//           targetLanguage: string,
//           system_kb?: string }
//   OUT : { translations: [{ id: number, translated: string }, ...],
//           batchSize: number, model: string, durationMs: number }
//   ERR : { error: string }    HTTP 4xx/5xx
//
// Razionale dello split lato client:
// - le landing page reali hanno 200-600 testi -> in modalita' "full"
//   l'Edge Function impiegava 60-300s in cascata di chiamate Claude;
// - tra Netlify, Cloudflare e il TLS terminator di Supabase qualcuno
//   chiude la connessione con `Inactivity Timeout` se non vede dati per
//   ~30-60s, e il client riceve un HTML 504 invece di JSON;
// - chunkando lato client, ogni call dura 10-30s (un solo batch a
//   Claude) e nessun proxy si lamenta. Il client applica i replace.
//
// Auth Anthropic: priorita' al secret `ANTHROPIC_API_KEY` della Edge
// Function. Fallback su `user_profiles.anthropic_api_key` se passato
// `userId` valido (legacy multi-tenant).

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const CLAUDE_MODEL = 'claude-sonnet-4-20250514'
const CLAUDE_MAX_TOKENS = 16000
const CLAUDE_TIMEOUT_MS = 90_000
// Hard cap sul numero di testi per singola call. Sopra ~30 testi il
// payload Claude inizia a superare i 16K output token e si tronca.
const MAX_TEXTS_PER_BATCH = 30

interface InputText { id: number; text: string; tag?: string }
interface TranslatedItem { id: number; translated: string }

async function translateBatchWithClaude(params: {
  apiKey: string
  systemKb: string
  targetLanguage: string
  batch: InputText[]
}): Promise<TranslatedItem[]> {
  const { apiKey, systemKb, targetLanguage, batch } = params

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

  if (systemKb && systemKb.length > 200) {
    systemBlocks.push({
      type: 'text',
      text: `📚 BRAND/PRODUCT KNOWLEDGE BASE — usa per scegliere il vocabolario corretto:\n\n${systemKb.slice(0, 28000)}`,
      cache_control: { type: 'ephemeral' },
    })
  }

  const userPrompt =
    `Traduci i seguenti ${batch.length} testi in ${targetLanguage}.\n\n` +
    'INPUT:\n' +
    JSON.stringify(
      batch.map(b => ({ id: b.id, tag: b.tag || '', text: b.text })),
      null,
      0,
    ) +
    '\n\nOUTPUT (SOLO JSON array di oggetti {"id": number, "translated": string}):'

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
      throw new Error(`Timeout Claude API (${CLAUDE_TIMEOUT_MS / 1000}s)`)
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

  try {
    const u = data.usage || {}
    console.log(
      `💰 batch ${batch.length} testi — input=${u.input_tokens || 0} ` +
      `cache_read=${u.cache_read_input_tokens || 0} cache_write=${u.cache_creation_input_tokens || 0} ` +
      `output=${u.output_tokens || 0}`,
    )
  } catch { /* best-effort */ }

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
    console.warn(`⚠️ Impossibile parsare risposta Claude, prime 200 char:\n${responseText.slice(0, 200)}`)
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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const startedAt = Date.now()

  try {
    const body = await req.json().catch(() => null) as
      | {
          cloneMode?: string
          mode?: string
          texts?: InputText[]
          htmlContent?: string  // legacy, non piu' supportato in batch mode
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

    const targetLanguage = body.targetLanguage
    if (!targetLanguage || typeof targetLanguage !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid targetLanguage' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // Sola modalita' supportata: batch. La modalita' "full" htmlContent
    // e' stata rimossa perche' i timeout Netlify/Cloudflare la rendevano
    // inaffidabile su landing > 100 testi (Inactivity Timeout 504).
    const texts = body.texts
    if (!Array.isArray(texts) || texts.length === 0) {
      return new Response(
        JSON.stringify({
          error:
            'Missing or empty `texts` array. ' +
            'funnel-translate-v1 accetta solo modalita\' batch: ' +
            '{ cloneMode: "translate", mode: "batch", texts: [{id, text, tag?}], targetLanguage, system_kb? }. ' +
            'Estrai i testi dall\'HTML lato client e chiamala in chunk da <=' + MAX_TEXTS_PER_BATCH + ' testi.',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }
    if (texts.length > MAX_TEXTS_PER_BATCH) {
      return new Response(
        JSON.stringify({
          error: `Batch troppo grande: ${texts.length} testi. Massimo ${MAX_TEXTS_PER_BATCH} per call. Spezza ulteriormente lato client.`,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // Sanitizza input
    const sanitized: InputText[] = []
    for (const t of texts) {
      if (typeof t?.id !== 'number') continue
      if (typeof t?.text !== 'string') continue
      const trimmed = t.text.trim()
      if (trimmed.length < 1) continue
      sanitized.push({
        id: t.id,
        text: trimmed.slice(0, 4000),
        tag: typeof t.tag === 'string' ? t.tag.slice(0, 32) : '',
      })
    }
    if (sanitized.length === 0) {
      return new Response(
        JSON.stringify({ translations: [], batchSize: 0, model: CLAUDE_MODEL, durationMs: Date.now() - startedAt }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // Lookup API key: secret (preferito) → user_profiles (legacy fallback)
    let apiKey: string | undefined = Deno.env.get('ANTHROPIC_API_KEY')?.trim() || undefined

    if (!apiKey && body.userId && typeof body.userId === 'string') {
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      )
      const { data: userProfile } = await supabase
        .from('user_profiles')
        .select('anthropic_api_key')
        .eq('id', body.userId)
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
            'Imposta il secret `ANTHROPIC_API_KEY` sulla Edge Function (Project → Edge Functions → Manage secrets) ' +
            'oppure popola `user_profiles.anthropic_api_key` per il userId che il client manda.',
        }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    console.log(`🌍 Translate batch START - target=${targetLanguage} - ${sanitized.length} testi`)

    const systemKb = typeof body.system_kb === 'string' ? body.system_kb : ''
    const translations = await translateBatchWithClaude({
      apiKey,
      systemKb,
      targetLanguage,
      batch: sanitized,
    })

    console.log(`✅ Tradotti ${translations.length}/${sanitized.length} testi in ${Date.now() - startedAt}ms`)

    return new Response(
      JSON.stringify({
        translations,
        batchSize: sanitized.length,
        model: CLAUDE_MODEL,
        durationMs: Date.now() - startedAt,
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
