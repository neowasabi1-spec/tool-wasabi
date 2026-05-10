// Supabase Edge Function: clone-competitor (smooth-responder)
// Clona landing page competitor: scarica HTML originale, estrae testi, li riscrive mantenendo struttura identica
// Deploy: supabase functions deploy smooth-responder --project-ref <your-project-ref>

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Helper: distribuisce il nuovo testo proporzionalmente tra i segmenti di testo
// preservando la posizione relativa dei tag HTML inline (bold, link, ecc.)
function distributeTextProportionally(
  segments: string[], 
  textSegments: { index: number; content: string }[], 
  newText: string
): void {
  if (textSegments.length <= 1) {
    if (textSegments.length === 1) {
      segments[textSegments[0].index] = newText
    }
    return
  }
  
  const originalWordCounts = textSegments.map(ts => {
    const words = ts.content.trim().split(/\s+/).filter((w: string) => w.length > 0)
    return Math.max(1, words.length)
  })
  const totalOriginalWords = originalWordCounts.reduce((a: number, b: number) => a + b, 0)
  const newWords = newText.trim().split(/\s+/).filter((w: string) => w.length > 0)
  
  if (totalOriginalWords === 0 || newWords.length === 0) {
    segments[textSegments[0].index] = newText
    for (let si = 1; si < textSegments.length; si++) {
      segments[textSegments[si].index] = ''
    }
    return
  }
  
  let wordIdx = 0
  for (let si = 0; si < textSegments.length; si++) {
    const cumulativeRatio = originalWordCounts.slice(0, si + 1).reduce((a: number, b: number) => a + b, 0) / totalOriginalWords
    const cumulativeTarget = Math.round(cumulativeRatio * newWords.length)
    const wordsForThis = Math.max(0, cumulativeTarget - wordIdx)
    
    if (wordsForThis > 0 && wordIdx < newWords.length) {
      const segmentWords = newWords.slice(wordIdx, wordIdx + wordsForThis).join(' ')
      const hadLeadingSpace = /^\s/.test(textSegments[si].content)
      segments[textSegments[si].index] = (hadLeadingSpace && si > 0 ? ' ' : '') + segmentWords
      wordIdx += wordsForThis
    } else {
      segments[textSegments[si].index] = ''
    }
  }
  
  if (wordIdx < newWords.length) {
    const lastIdx = textSegments[textSegments.length - 1].index
    const remaining = newWords.slice(wordIdx).join(' ')
    segments[lastIdx] = segments[lastIdx] ? segments[lastIdx] + ' ' + remaining : remaining
  }
}

// Estrae candidati brand dal dominio in modo robusto:
// - try.nooro-us.com  → ["nooro-us", "nooro", "us"]
// - www.nooro.com     → ["nooro"]
// - shop.brand.co.uk  → ["brand"]
// - try.foo-bar.io    → ["foo-bar", "foo", "bar"]
function extractBrandCandidatesFromDomain(originalUrl: string): string[] {
  const out: string[] = []
  try {
    const urlObj = new URL(originalUrl)
    const host = urlObj.hostname.replace(/^www\./, '').toLowerCase()
    const parts = host.split('.')
    // TLD comuni a 2 livelli (es. .co.uk, .com.au)
    const twoLevelTlds = new Set(['co.uk', 'co.nz', 'com.au', 'com.br', 'co.jp', 'co.in'])
    let sldIdx = parts.length - 2
    if (parts.length >= 3 && twoLevelTlds.has(`${parts[parts.length - 2]}.${parts[parts.length - 1]}`)) {
      sldIdx = parts.length - 3
    }
    const sld = parts[sldIdx]
    if (sld && sld.length >= 3) {
      out.push(sld)
      // Se c'è un hyphen (nooro-us), aggiungi le parti singole
      if (sld.includes('-')) {
        for (const piece of sld.split('-')) {
          if (piece.length >= 3) out.push(piece)
        }
      }
    }
    // Aggiungi anche subdomini significativi (es. shop.brand.com → "shop" non vale)
    for (let i = 0; i < sldIdx; i++) {
      const sub = parts[i]
      if (sub.length >= 4 && !['try', 'app', 'www', 'shop', 'store', 'go', 'buy', 'get', 'my', 'web'].includes(sub)) {
        out.push(sub)
      }
    }
  } catch {}
  return out
}

function replaceBrandInTextContent(
  html: string,
  originalUrl: string,
  originalHtml: string,
  productName: string
): string {
  if (!productName || !originalUrl) return html

  const brandsToReplace: string[] = []

  brandsToReplace.push(...extractBrandCandidatesFromDomain(originalUrl))

  const origTitleMatch = originalHtml.match(/<title[^>]*>([^<]+)<\/title>/i)
  if (origTitleMatch) {
    const titleParts = origTitleMatch[1].trim().split(/\s*[-|:–—]\s*/)
    for (const part of titleParts) {
      const t = part.trim()
      if (t.length > 3 && t.length < 40 && t.toLowerCase() !== productName.toLowerCase()) {
        brandsToReplace.push(t)
      }
    }
  }

  const ogMatch = originalHtml.match(/property=["']og:site_name["']\s*content=["']([^"']+)["']/i) ||
                   originalHtml.match(/content=["']([^"']+)["']\s*property=["']og:site_name["']/i)
  if (ogMatch && ogMatch[1].trim().length > 3) {
    brandsToReplace.push(ogMatch[1].trim())
  }

  // CONSERVATIVE STRATEGY: only replace the domain-derived brand candidates
  // (e.g. "resilia" from resilia.com) and og:site_name. We INTENTIONALLY do
  // NOT do auto-discovery of frequent capitalized words anymore — that path
  // was the root cause of "Reset Patch Reset Patch" / "PATCH DARIO Appetite
  // PATCH DARIO" because it would catch ingredient names, recurring nouns,
  // or words that overlap the new product name and rewrite them all to the
  // product name. Claude is now responsible (via prompt) for omitting or
  // neutralising competitor brand mentions in the texts it generates.
  const productLower = productName.toLowerCase()
  const productTokensLower = new Set(
    productName.split(/\s+/).map((t) => t.toLowerCase()).filter(Boolean),
  )
  const uniqueBrands = [...new Set(brandsToReplace.map(b => b.trim()))]
    .filter((b) => b.length >= 5)
    .filter((b) => b.toLowerCase() !== productLower)
    .filter((b) => !productTokensLower.has(b.toLowerCase()))
    // ordino per length desc così "nooro-us" viene prima di "nooro"
    .sort((a, b) => b.length - a.length)

  if (uniqueBrands.length === 0) return html

  console.log(`🏷️ Brand post-processing (domain/og only): [${uniqueBrands.join(', ')}] → "${productName}"`)

  // Protect <style>, <script>, <link>, <meta> blocks from brand replacement.
  // Their inner text (between the open/close tags) IS picked up by the
  // <[^>]+> split and would be treated as a text node, so brand names that
  // appear inside CSS @font-face / url(...) / inline JS strings would get
  // rewritten — turning e.g. "metabolicwave.com/font.woff2" into
  // "Metabolic Wave.com/font.woff2" which fails DNS as "metabolic%20wave.com"
  // (browser percent-encodes the space). Same risk for src URLs in <noscript>.
  const protectedBlocks: string[] = []
  let working = html.replace(
    /<(style|script|noscript)[^>]*>[\s\S]*?<\/\1>/gi,
    (m) => {
      const idx = protectedBlocks.length
      protectedBlocks.push(m)
      return `\u0000PROTECTED_BRAND_${idx}\u0000`
    },
  )

  // Common TLDs to guard against breaking URLs that survived the protection
  // above (e.g. raw domain mentions inside text like "Visit acme.com today").
  // Replacing "acme" -> "ACME Corp" there would break the dotted domain too.
  const TLD_GUARD = `(?!\\.(?:com|org|net|io|co|us|uk|de|fr|es|it|me|info|ai|app|shop|store|biz|tv|live|xyz|pro|club|space|website))`

  const htmlParts = working.split(/(<[^>]+>)/)
  for (let i = 0; i < htmlParts.length; i++) {
    if (!htmlParts[i].startsWith('<')) {
      for (const brand of uniqueBrands) {
        const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        // \b non funziona con caratteri unicode in modo affidabile in Deno;
        // uso lookaround approssimato: non-letter prima/dopo + TLD guard
        htmlParts[i] = htmlParts[i].replace(
          new RegExp(`(^|[^a-zA-Z0-9])${escaped}(?=[^a-zA-Z0-9]|$)${TLD_GUARD}`, 'gi'),
          (_match, prefix) => `${prefix}${productName}`
        )
      }
    }
  }
  working = htmlParts.join('')

  // Restore protected blocks
  working = working.replace(
    /\u0000PROTECTED_BRAND_(\d+)\u0000/g,
    (_m, idx) => protectedBlocks[Number(idx)] ?? '',
  )

  return working
}

// Final-pass anti-stuffing on the assembled HTML. Catches patterns that
// slipped past stripStuffing (which only sees individual texts) — most
// notably consecutive duplicates of the new product name like
// "Reset Patch Reset Patch" and "PATCH DARIO PATCH DARIO" that emerge
// when two different `cloning_texts` sit next to each other in the DOM.
//
// IMPORTANT: this function MUST NEVER cross HTML tag boundaries, or it
// can swallow tag closures (e.g. "<a>Reset Patch</a><a>Reset Patch</a>"
// would become "Reset Patch" with no anchor closures, breaking event
// handlers on FAQs, accordions, sliders, etc.). We operate text-segment
// by text-segment via split on tags.
function collapseConsecutiveBrandRuns(html: string, productName: string): string {
  if (!productName || productName.length < 3) return html
  const escaped = productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Inside a single text node only: brand + small gap (whitespace, NBSP,
  // simple separators — NEVER tags) + brand. Iterated to fixed point so
  // chains "A A A A" collapse fully.
  const gap = `(?:[\\s\\u00A0]|&nbsp;|&\\#160;|[\\-–—:|·•†*])*`
  const dup = new RegExp(`(${escaped})${gap}\\1`, 'gi')

  // Same guard as replaceBrandInTextContent: don't touch <style>/<script>/
  // <noscript> bodies, where this would mangle CSS url(...) and JS strings.
  const protectedBlocks: string[] = []
  let working = html.replace(
    /<(style|script|noscript)[^>]*>[\s\S]*?<\/\1>/gi,
    (m) => {
      const idx = protectedBlocks.length
      protectedBlocks.push(m)
      return `\u0000PROTECTED_COLLAPSE_${idx}\u0000`
    },
  )

  const segments = working.split(/(<[^>]+>)/)
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (!seg || seg.startsWith('<')) continue
    let prev = seg
    for (let pass = 0; pass < 6; pass++) {
      const next = prev.replace(dup, '$1')
      if (next === prev) break
      prev = next
    }
    segments[i] = prev
  }
  working = segments.join('')

  working = working.replace(
    /\u0000PROTECTED_COLLAPSE_(\d+)\u0000/g,
    (_m, idx) => protectedBlocks[Number(idx)] ?? '',
  )

  return working
}

// Sostituisce placeholder template Liquid/Jinja noti con valori reali.
// Es: `{{MMMM dd, yyyy}}` → "May 03, 2026"
// Senza questo, restano letterali nell'HTML finale (orribile UX).
function replaceLiquidPlaceholders(html: string): string {
  const now = new Date()
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]
  const monthShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const fullDate = `${monthNames[now.getMonth()]} ${String(now.getDate()).padStart(2, '0')}, ${now.getFullYear()}`
  const shortDate = `${monthShort[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`
  const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()]

  return html
    // Date placeholders (più frequenti nei page builder)
    .replace(/\{\{\s*MMMM\s+dd,?\s+yyyy\s*\}\}/gi, fullDate)
    .replace(/\{\{\s*MMM\s+dd,?\s+yyyy\s*\}\}/gi, shortDate)
    .replace(/\{\{\s*dd[\/\-]MM[\/\-]yyyy\s*\}\}/gi, now.toISOString().substring(0, 10))
    .replace(/\{\{\s*yyyy[\/\-]MM[\/\-]dd\s*\}\}/gi, now.toISOString().substring(0, 10))
    .replace(/\{\{\s*today\s*\}\}/gi, fullDate)
    .replace(/\{\{\s*current[\s_-]?date\s*\}\}/gi, fullDate)
    .replace(/\{\{\s*day[\s_-]?name\s*\}\}/gi, dayName)
    // Location placeholder generici → vuoto
    .replace(/\{\{\s*[Ll]ocation\s*\}\}/g, '')
    .replace(/\{\{\s*[Cc]ity\s*\}\}/g, '')
    .replace(/\{\{\s*[Cc]ountry\s*\}\}/g, '')
    // Cleanup di doppi spazi residui
    .replace(/  +/g, ' ')
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const {
      url,
      cloneMode = 'rewrite',
      phase,
      jobId,
      batchNumber = 0,
      productName,
      productDescription,
      priceFull,
      priceDiscounted,
      outputFormat,
      categoria,
      framework,
      target,
      customPrompt,
      // Optional explicit project brief. When provided, it is injected into
      // the Claude prompt as the primary source of truth for tone, positioning
      // and value props. Sourced from My Projects (`Project.brief`).
      brief,
      // Optional market research notes (free-form). Same flow as `brief`.
      market_research,
      // Optional funnel narrative — populated by the "Swipe All" orchestrator
      // when rewriting multiple pages of the same funnel in sequence. It's a
      // stringified JSON or plain text describing the headline / hook /
      // big promise / primary CTA / angle of pages already rewritten in this
      // funnel, plus the funnel position of the current page (e.g. "step 2/4
      // — Landing Page after the Advertorial"). Goal: keep voice, angle,
      // pain points and CTA logic CONSISTENT across all the funnel pages.
      funnel_context,
      // Optional copywriting knowledge base — injected by the Next.js API
      // route (/api/clone-funnel) from src/knowledge/copywriting/. Sent as a
      // cached system block (cache_control: ephemeral) so the cost is paid
      // once per ~5 minutes across all batches of the same job.
      system_kb,
      userId,
      htmlContent,
      targetLanguage,
      renderedHtml, // Pre-rendered HTML from Playwright (sent by Next.js API for JS-rendered pages)
      // Tunables (optional). The legacy defaults (BATCH_SIZE=25, timeout=60s)
      // were too aggressive: complex rewrites of 25 texts routinely exceeded
      // 60s on Claude Sonnet and surfaced as "Timeout chiamata Claude API
      // (60s). Ridurre batch size...". New defaults: 12 texts per batch and
      // 120s timeout (still well within Supabase Edge Functions' 150s wall).
      batchSize: batchSizeOverride,
      claudeTimeoutMs: claudeTimeoutMsOverride,
    } = await req.json()

    const BATCH_SIZE_DEFAULT = 12
    const CLAUDE_TIMEOUT_MS_DEFAULT = 120_000
    const BATCH_SIZE_RUNTIME = Math.max(
      1,
      Math.min(50, Number(batchSizeOverride) || BATCH_SIZE_DEFAULT),
    )
    const CLAUDE_TIMEOUT_MS_RUNTIME = Math.max(
      15_000,
      Math.min(140_000, Number(claudeTimeoutMsOverride) || CLAUDE_TIMEOUT_MS_DEFAULT),
    )

    // BUILD MARKER — bump on every deploy so we can verify in Supabase logs
    // which version of the function is actually serving requests. Critical
    // because GitHub pushes don't auto-deploy; if you don't see this exact
    // string in the logs you're still on the old build.
    console.log(`🔖 funnel-swap build: v4.3-200k-section-limit (2026-05-10)`)
    console.log(`📋 Richiesta ricevuta: phase=${phase}, cloneMode=${cloneMode}, url=${url?.substring(0, 50)}...`)
    if (system_kb) {
      const kbChars = String(system_kb).length
      console.log(`🧠 Knowledge base ricevuta: ${kbChars.toLocaleString()} chars (~${Math.round(kbChars / 4).toLocaleString()} tokens, cached)`)
    }
    if (brief) console.log(`📄 Brief ricevuto: ${String(brief).length} chars`)
    if (market_research) console.log(`🔬 Market research ricevuta: ${String(market_research).length} chars`)
    if (funnel_context) console.log(`🧵 Funnel context ricevuto: ${String(funnel_context).length} chars (Swipe All narrative)`)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // FASE "PROCESS": Processa batch di testi già estratti
    if (phase === 'process') {
      if (!jobId) {
        return new Response(
          JSON.stringify({ error: 'Missing required field: jobId for process phase' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const { data: job, error: jobError } = await supabase
        .from('cloning_jobs')
        .select('*')
        .eq('id', jobId)
        .eq('user_id', userId)
        .single()

      if (jobError || !job) {
        if (jobError?.message?.includes('does not exist') || jobError?.code === '42P01') {
          return new Response(
            JSON.stringify({ 
              error: 'Tabelle database non trovate. Esegui la migrazione SQL: supabase/migrations/create_cloning_tables.sql',
              details: jobError.message
            }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        return new Response(
          JSON.stringify({ error: `Job non trovato o non autorizzato: ${jobError?.message || 'Unknown error'}` }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const BATCH_SIZE = BATCH_SIZE_RUNTIME
      const { data: textsToProcess, error: textsError } = await supabase
        .from('cloning_texts')
        .select('*')
        .eq('job_id', jobId)
        .eq('processed', false)
        .order('index', { ascending: true })
        .limit(BATCH_SIZE)

      if (textsError) {
        return new Response(
          JSON.stringify({ error: `Errore caricamento testi: ${textsError.message}` }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      if (!textsToProcess || textsToProcess.length === 0) {
        const { data: allProcessedTexts, error: allTextsError } = await supabase
          .from('cloning_texts')
          .select('*')
          .eq('job_id', jobId)
          .eq('processed', true)
          .order('index', { ascending: true })

        if (allTextsError || !allProcessedTexts) {
          return new Response(
            JSON.stringify({ error: 'Errore caricamento testi processati' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }

        console.log(`🔄 Ricostruzione HTML finale: ${allProcessedTexts.length} testi da sostituire...`)
        let clonedHTML = job.original_html
        let replacementCount = 0
        
        const replacementReport: Array<{
          index: number,
          originalText: string,
          newText: string,
          tagName: string,
          position: number,
          replaced: boolean,
          reason?: string
        }> = []

        const sortedTexts = [...allProcessedTexts]
          .filter(t => t.new_text && t.original_text)
          .sort((a, b) => b.original_text.length - a.original_text.length)

        const REPLACEMENT_CHUNK_SIZE = 15
        const textChunks = []
        for (let i = 0; i < sortedTexts.length; i += REPLACEMENT_CHUNK_SIZE) {
          textChunks.push(sortedTexts.slice(i, i + REPLACEMENT_CHUNK_SIZE))
        }

        console.log(`📦 Processando ${textChunks.length} chunk(s) di sostituzioni (${REPLACEMENT_CHUNK_SIZE} testi per chunk)...`)

        for (let chunkIndex = 0; chunkIndex < textChunks.length; chunkIndex++) {
          const chunk = textChunks[chunkIndex]
          
          for (const textData of chunk) {
            if (!textData || typeof textData !== 'object') {
              console.warn('⚠️ textData non valido, salto:', textData)
              continue
            }
            
            const originalText = textData.original_text
            const newText = textData.new_text
            
            if (!originalText || !newText || typeof originalText !== 'string' || typeof newText !== 'string') {
              console.warn('⚠️ Testo originale o nuovo mancante, salto:', { originalText, newText })
              continue
            }
            
            const rawText = textData.raw_text || originalText
            const tagName = textData.tag_name || ''
            const fullTag = textData.full_tag || ''
            const attributes = (textData.attributes && typeof textData.attributes === 'string') ? textData.attributes : ''
            
            let found = false
            
            if (fullTag && attributes && tagName && typeof attributes === 'string') {
              const idMatch = attributes.match(/id=["']([^"']+)["']/i)
              const classMatch = attributes.match(/class=["']([^"']+)["']/i)
              
              if (idMatch && idMatch[1]) {
                const id = idMatch[1]
                const tagPattern = new RegExp(`<${tagName}[^>]*id=["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i')
                const tagMatch = clonedHTML.match(tagPattern)
                
                if (tagMatch) {
                  const tagContent = tagMatch[1]
                  const textToReplace = rawText !== originalText ? rawText : originalText
                  
                  if (tagContent.includes(textToReplace)) {
                    const beforeTag = clonedHTML.substring(0, tagMatch.index! + tagMatch[0].indexOf(tagContent))
                    const afterTag = clonedHTML.substring(tagMatch.index! + tagMatch[0].indexOf(tagContent) + tagContent.length)
                    const newTagContent = tagContent.replace(textToReplace, newText)
                    clonedHTML = beforeTag + newTagContent + afterTag
                    replacementCount++
                    found = true
                  }
                }
              } else if (classMatch && classMatch[1]) {
                const className = classMatch[1].split(' ')[0]
                const tagPattern = new RegExp(`<${tagName}[^>]*class=["'][^"']*${className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"']*["'][^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i')
                const tagMatch = clonedHTML.match(tagPattern)
                
                if (tagMatch) {
                  const tagContent = tagMatch[1]
                  const textToReplace = rawText !== originalText ? rawText : originalText
                  
                  if (tagContent.includes(textToReplace)) {
                    const beforeTag = clonedHTML.substring(0, tagMatch.index! + tagMatch[0].indexOf(tagContent))
                    const afterTag = clonedHTML.substring(tagMatch.index! + tagMatch[0].indexOf(tagContent) + tagContent.length)
                    const newTagContent = tagContent.replace(textToReplace, newText)
                    clonedHTML = beforeTag + newTagContent + afterTag
                    replacementCount++
                    found = true
                  }
                }
              }
            }
            
            if (!found && rawText && rawText.includes('&nbsp;')) {
              const foundIndex = clonedHTML.indexOf(rawText)
              if (foundIndex !== -1) {
                const beforeMatch = clonedHTML.substring(0, foundIndex)
                const lastOpenTag = beforeMatch.lastIndexOf('<')
                const lastCloseTag = beforeMatch.lastIndexOf('>')
                
                if (lastOpenTag <= lastCloseTag) {
                  clonedHTML = clonedHTML.substring(0, foundIndex) + newText + clonedHTML.substring(foundIndex + rawText.length)
                  replacementCount++
                  found = true
                }
              }
            }
            
            if (!found && clonedHTML.includes(originalText)) {
              clonedHTML = clonedHTML.replace(originalText, newText)
              replacementCount++
              found = true
            }
            
            if (!found && rawText !== originalText && clonedHTML.includes(rawText)) {
              clonedHTML = clonedHTML.replace(rawText, newText)
              replacementCount++
              found = true
            }
            
            if (!found && originalText.length >= 5 && originalText.length < 500) {
              try {
                const words = originalText.split(/\s+/).filter((w: string) => w.length > 0)
                if (words.length >= 2 && words.length <= 30) {
                  const escapedWords = words.map((w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                  const tagsBetween = '(?:\\s|&nbsp;|<[^>]{0,200}>)*'
                  const pattern = escapedWords.join(tagsBetween)
                  const regex = new RegExp(pattern, 'i')
                  const match = clonedHTML.match(regex)
                  if (match) {
                    const matchedStr = match[0]
                    const tagsInMatch = matchedStr.match(/<[^>]+>/g) || []
                    
                    if (tagsInMatch.length > 0) {
                      const segments = matchedStr.split(/(<[^>]+>)/)
                      const textSegments: { index: number; content: string }[] = []
                      for (let si = 0; si < segments.length; si++) {
                        if (segments[si] && !segments[si].startsWith('<')) {
                          textSegments.push({ index: si, content: segments[si] })
                        }
                      }
                      
                      if (textSegments.length > 0) {
                        distributeTextProportionally(segments, textSegments, newText)
                        const replacement = segments.join('')
                        clonedHTML = clonedHTML.substring(0, match.index!) + replacement + clonedHTML.substring(match.index! + matchedStr.length)
                      } else {
                        const preservedTags = tagsInMatch.join('')
                        clonedHTML = clonedHTML.substring(0, match.index!) + newText + preservedTags + clonedHTML.substring(match.index! + matchedStr.length)
                      }
                    } else {
                      clonedHTML = clonedHTML.substring(0, match.index!) + newText + clonedHTML.substring(match.index! + matchedStr.length)
                    }
                    replacementCount++
                    found = true
                  }
                }
              } catch (e) { /* Regex non valida */ }
            }
            
            if (!found && originalText.length < 200) {
              const escapedText = originalText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
              const simplePattern = escapedText.replace(/ +/g, '(?:[ ]|&nbsp;)+')
              try {
                const regex = new RegExp(simplePattern)
                const simpleMatch = clonedHTML.match(regex)
                if (simpleMatch) {
                  const sm = simpleMatch[0]
                  const smTags = sm.match(/<[^>]+>/g) || []
                  if (smTags.length > 0) {
                    const smSegments = sm.split(/(<[^>]+>)/)
                    const smTextSegs: { index: number; content: string }[] = []
                    for (let si = 0; si < smSegments.length; si++) {
                      if (smSegments[si] && !smSegments[si].startsWith('<')) {
                        smTextSegs.push({ index: si, content: smSegments[si] })
                      }
                    }
                    if (smTextSegs.length > 0) {
                      distributeTextProportionally(smSegments, smTextSegs, newText)
                      clonedHTML = clonedHTML.replace(regex, smSegments.join(''))
                    } else {
                      clonedHTML = clonedHTML.replace(regex, newText + smTags.join(''))
                    }
                  } else {
                    clonedHTML = clonedHTML.replace(regex, newText)
                  }
                  replacementCount++
                  found = true
                }
              } catch (e) { /* Regex non valida */ }
            }
            
            if (originalText && newText) {
              replacementReport.push({
                index: textData.index ?? 0,
                originalText: originalText,
                newText: newText,
                tagName: tagName || '',
                position: textData.position ?? 0,
                replaced: found,
                reason: found ? 'Sostituito con successo' : 'Testo non trovato nell\'HTML'
              })
            }
            
            if (found) {
              console.log(`✅ Testo sostituito: "${originalText.substring(0, 50)}..." → "${newText.substring(0, 50)}..."`)
            } else {
              console.warn(`⚠️ Testo NON sostituito: "${originalText.substring(0, 50)}..." (raw: "${rawText.substring(0, 50)}...")`)
            }
          }
          
          if ((chunkIndex + 1) % 5 === 0 || chunkIndex === textChunks.length - 1) {
            console.log(`✅ Chunk ${chunkIndex + 1}/${textChunks.length} completato: ${replacementCount} sostituzioni finora`)
          }
        }

        clonedHTML = replaceBrandInTextContent(clonedHTML, job.url, job.original_html, job.product_name)
        clonedHTML = collapseConsecutiveBrandRuns(clonedHTML, job.product_name)
        clonedHTML = replaceLiquidPlaceholders(clonedHTML)

        // === INLINE BUNDLE JS MODIFICATI ===
        // Per ogni testo riscritto con tag_name 'js-bundle' (estratto da
        // bundle Webpack di Next.js per quiz CSR puri tipo Bioma):
        //  1. raggruppa replacements per bundle URL (campo `attributes`)
        //  2. scarica il bundle originale dal CDN del competitor
        //  3. applica replace SAFE (solo su string literal "...", '...', `...`)
        //  4. inline il bundle modificato nell'HTML, sostituendo lo
        //     <script src="..."> originale con uno inline contenente il JS
        //     riscritto. Così il preview esegue il bundle MODIFICATO e
        //     l'utente vede i testi nuovi nelle pagine quiz/funnel CSR.
        // NB: campo del DB è `new_text` (non rewritten_text). Lo schema della
        // tabella cloning_texts usa original_text/raw_text/new_text per
        // motivi storici; il batch loop sopra fa update di new_text.
        // TUTTO il blocco INLINE BUNDLE è in try/catch top-level così un
        // errore qui non blocca il save dell'HTML né la response al client.
        const inlineBundleStats: {
          reached: boolean;
          jsBundleTextsCount: number;
          bundlesFound: number;
          inlineSuccess: number;
          inlineFailed: number;
          totalReplaced: number;
          errors: string[];
        } = {
          reached: false,
          jsBundleTextsCount: 0,
          bundlesFound: 0,
          inlineSuccess: 0,
          inlineFailed: 0,
          totalReplaced: 0,
          errors: [],
        }
        try {
          inlineBundleStats.reached = true
          const { data: jsBundleTexts, error: bundleQueryErr } = await supabase
            .from('cloning_texts')
            .select('original_text, new_text, attributes')
            .eq('job_id', jobId)
            .eq('tag_name', 'js-bundle')
            .not('new_text', 'is', null)
            .limit(5000)

          if (bundleQueryErr) {
            inlineBundleStats.errors.push(`bundle query: ${bundleQueryErr.message}`)
            console.error('❌ INLINE BUNDLE query error:', bundleQueryErr)
          }
          inlineBundleStats.jsBundleTextsCount = jsBundleTexts?.length || 0
          console.log(`📦 INLINE BUNDLE: query returned ${inlineBundleStats.jsBundleTextsCount} testi js-bundle riscritti`)

        if (jsBundleTexts && jsBundleTexts.length > 0) {
          console.log(`📦 INLINE BUNDLE: ${jsBundleTexts.length} stringhe riscritte da reinserire nei bundle JS`)
          const replacementsByBundle = new Map<string, Array<{ orig: string; rewr: string }>>()
          for (const t of jsBundleTexts) {
            if (!t.attributes || !t.original_text || !t.new_text) continue
            if (t.original_text === t.new_text) continue
            const arr = replacementsByBundle.get(t.attributes) || []
            arr.push({ orig: t.original_text, rewr: t.new_text })
            replacementsByBundle.set(t.attributes, arr)
          }
          inlineBundleStats.bundlesFound = replacementsByBundle.size

          for (const [bundleUrl, replacements] of replacementsByBundle.entries()) {
            try {
              const ctrl = new AbortController()
              const tid = setTimeout(() => ctrl.abort(), 15000)
              const r = await fetch(bundleUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Compatible; FunnelSwap/1.0)' },
                signal: ctrl.signal,
              })
              clearTimeout(tid)
              if (!r.ok) {
                console.warn(`  ⚠️ ${bundleUrl}: HTTP ${r.status}`)
                continue
              }
              let bundleJs = await r.text()
              if (bundleJs.length > 5_000_000) {
                console.warn(`  ⚠️ ${bundleUrl}: troppo grande, skip inline`)
                continue
              }

              let appliedCount = 0
              for (const { orig, rewr } of replacements) {
                const escOrig = orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                let replacedHere = false
                for (const quote of ['"', "'", '`']) {
                  const re = new RegExp(`${quote}${escOrig}${quote}`, 'g')
                  if (re.test(bundleJs)) {
                    const escRewr = rewr.replace(new RegExp(quote === '\\' ? '\\\\' : quote, 'g'), `\\${quote}`)
                    bundleJs = bundleJs.replace(re, `${quote}${escRewr}${quote}`)
                    appliedCount++
                    replacedHere = true
                    break
                  }
                }
                if (!replacedHere) {
                  // Fallback: replace senza quote (caso template literal con interpolazione)
                  // → MOLTO conservativo, solo se la stringa è univoca nel bundle
                  const occurrences = (bundleJs.match(new RegExp(escOrig, 'g')) || []).length
                  if (occurrences === 1) {
                    bundleJs = bundleJs.replace(orig, rewr)
                    appliedCount++
                  }
                }
              }

              const escBundleUrl = bundleUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
              const scriptInlineRegex = new RegExp(
                `<script\\b[^>]*\\bsrc=["']${escBundleUrl}["'][^>]*>\\s*<\\/script>`,
                'gi'
              )
              const safeJs = bundleJs.replace(/<\/script/gi, '<\\/script')
              const inlineTag = `<script>/* inline bundle ${bundleUrl.substring(bundleUrl.lastIndexOf('/'))} */\n${safeJs}\n</script>`

              const beforeLen = clonedHTML.length
              const replaced = clonedHTML.replace(scriptInlineRegex, inlineTag)
              if (replaced === clonedHTML) {
                console.warn(`  ⚠️ Bundle ${bundleUrl}: <script src> non trovato nell'HTML (forse già modificato)`)
                inlineBundleStats.inlineFailed++
                inlineBundleStats.errors.push(`bundle script tag not found in HTML: ${bundleUrl.substring(bundleUrl.lastIndexOf('/'))}`)
              } else {
                clonedHTML = replaced
                inlineBundleStats.inlineSuccess++
                inlineBundleStats.totalReplaced += appliedCount
                console.log(`  📦 ${bundleUrl.substring(bundleUrl.lastIndexOf('/'))}: ${appliedCount}/${replacements.length} replace, HTML +${clonedHTML.length - beforeLen}b`)
              }
            } catch (e) {
              const msg = (e as Error).message
              console.warn(`  ⚠️ Errore inline bundle ${bundleUrl}:`, msg)
              inlineBundleStats.inlineFailed++
              inlineBundleStats.errors.push(`${bundleUrl.substring(bundleUrl.lastIndexOf('/'))}: ${msg}`)
            }
          }
        }
        } catch (topErr) {
          const msg = (topErr as Error).message
          console.error('❌ INLINE BUNDLE top-level error:', msg, (topErr as Error).stack)
          inlineBundleStats.errors.push(`top-level: ${msg}`)
        }

        // === FIX NEXT.JS NAVIGATION (preview SPA) ===
        // I quiz Next.js usano client-side navigation tramite fetch a
        // /_next/data/<buildId>/<page>.json per ottenere props della
        // prossima pagina. Quando il preview gira fuori dal dominio
        // originale (es. cute-cupcake.netlify.app invece di bioma.health)
        // questi fetch danno 404 → 'Failed to load static props' → quiz
        // si blocca al primo click "Next". Monkey-patch del fetch per
        // ritornare props vuoti (la state del componente quiz mantiene
        // comunque la domanda corrente in localStorage o state).
        const navigationFix = `<script>(function(){
  if (typeof window === 'undefined') return;
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!origFetch) return;
  window.fetch = function(input, init){
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/\\/_next\\/data\\//.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({pageProps:{},__N_SSP:true}),{status:200,headers:{'Content-Type':'application/json'}}));
      }
    } catch(e){}
    return origFetch(input, init);
  };
})();</script>`
        if (clonedHTML.includes('<head>')) {
          clonedHTML = clonedHTML.replace('<head>', '<head>' + navigationFix)
        } else if (clonedHTML.includes('<body')) {
          clonedHTML = clonedHTML.replace(/(<body[^>]*>)/, '$1' + navigationFix)
        }

        // === STRIP SCRIPT ORIGINALI ===
        // I funnel Funnelish/CheckoutChamp girano su Vue.js + custom runtime.
        // Quando li cloniamo, gli script tentano di montare ma falliscono
        // (mancano endpoint API originali, dati di sessione, ecc.) e lasciano
        // la pagina in uno stato inerte: i bottoni non rispondono, FAQ non
        // si aprono, thumb gallery non funziona, ecc. Soluzione: rimuovere
        // TUTTI gli <script> originali e affidarsi al fallback init che
        // iniettiamo subito dopo. Manteniamo solo data-fallback (i nostri
        // script di fix navigationFix + fallbackInitServerSide).
        const scriptCountBefore = (clonedHTML.match(/<script\b/gi) || []).length
        clonedHTML = clonedHTML.replace(/<script\b(?![^>]*data-fallback=)[^>]*>[\s\S]*?<\/script>/gi, '')
        clonedHTML = clonedHTML.replace(/<script\b(?![^>]*data-fallback=)[^>]*\/>/gi, '')
        // Rimuoviamo anche <noscript> e attributi on* che possono fare
        // riferimento a global Vue/Funnelish handlers ormai assenti.
        clonedHTML = clonedHTML.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
        clonedHTML = clonedHTML.replace(/\s+on[a-z]+="[^"]*"/gi, '')
        clonedHTML = clonedHTML.replace(/\s+on[a-z]+='[^']*'/gi, '')
        const scriptCountAfter = (clonedHTML.match(/<script\b/gi) || []).length
        console.log(`🧹 Script strippati: ${scriptCountBefore} → ${scriptCountAfter} (manteniamo solo data-fallback)`)

        // === CSS HARD-OVERRIDE per FAQ ===
        // Strategia pragmatica: tutte le FAQ visibili DI DEFAULT (no JS
        // necessario per leggerle). Il toggle JS aggiunge/rimuove
        // .fb-collapsed per richiuderle se l'utente clicca, ma se per
        // qualche motivo il JS non gira o è bloccato, l'utente vede
        // comunque tutto il contenuto. Stesso principio per .stickSection
        // (sticky CTA bar) che resta sempre visibile.
        // Specificity alta (più classi + !important) per battere Vue
        // scoped CSS [data-v-X].
        const fbStyle = `<style data-fallback="server-v1-style">
html body .faq .faq-content-wrapper,
html body .faq .faq-content,
html body .faq-wrapper .faq-content-wrapper,
html body .faq-wrapper .faq-content,
html body .faq-item .faq-body,
html body .faq-item .faq-answer,
html body .accordion-item .accordion-content,
html body .accordion-item .accordion-body,
html body .accordion-item .accordion-collapse,
html body details > *:not(summary){
  display:block !important;
  max-height:none !important;
  height:auto !important;
  min-height:0 !important;
  overflow:visible !important;
  visibility:visible !important;
  opacity:1 !important;
  transform:none !important;
  pointer-events:auto !important;
}
html body .faq.fb-collapsed .faq-content-wrapper,
html body .faq.fb-collapsed .faq-content,
html body .faq-wrapper.fb-collapsed .faq-content-wrapper,
html body .faq-wrapper.fb-collapsed .faq-content,
html body .faq-item.fb-collapsed .faq-body,
html body .faq-item.fb-collapsed .faq-answer,
html body .accordion-item.fb-collapsed .accordion-content,
html body .accordion-item.fb-collapsed .accordion-body{
  display:none !important;
}
.faq-header,.faq-question,.faq-title,.accordion-header,.accordion-button,.accordion-question,.accordion-toggle,summary{cursor:pointer !important;}
.fb-icon-rotated{transform:rotate(180deg) !important;transition:transform .2s !important;}
html body .stickSection{display:block !important;visibility:visible !important;opacity:1 !important;}
</style>`
        if (clonedHTML.includes('</head>')) {
          clonedHTML = clonedHTML.replace('</head>', fbStyle + '</head>')
        } else if (clonedHTML.includes('<body')) {
          clonedHTML = clonedHTML.replace(/(<body[^>]*>)/, fbStyle + '$1')
        }

        // === FALLBACK INIT (FAQ + Swiper + thumb gallery) ===
        // Iniettato server-side in modo che la pagina sia interattiva
        // INDIPENDENTEMENTE dalla cache del bundle Next.js client. Carica
        // jQuery+Swiper da CDN se mancano, attiva accordion FAQ, lega
        // click thumb→main image. Idempotente: include FB_VERSION nel body
        // così il client può evitare doppia iniezione.
        const fallbackInitServerSide = `<script data-fallback="server-v1">(function(){
  var FB_VERSION='server-v2-2026-05-05';
  window.__FB_FALLBACK_INSTALLED=FB_VERSION;
  function loadCss(href){ if(document.querySelector('link[data-fb-css="'+href+'"]'))return; var l=document.createElement('link'); l.rel='stylesheet'; l.href=href; l.dataset.fbCss=href; document.head.appendChild(l); }
  function loadScript(src,cb){ var existing=document.querySelector('script[data-fb-src="'+src+'"]'); if(existing){ if(existing.__loaded){cb();} else { existing.addEventListener('load',cb); existing.addEventListener('error',cb); } return; } var s=document.createElement('script'); s.src=src; s.async=false; s.dataset.fbSrc=src; s.addEventListener('load',function(){s.__loaded=true; cb();}); s.addEventListener('error',function(){cb();}); (document.head||document.documentElement).appendChild(s); }
  function findContents(header){ var p=header.closest('.faq,.faq-wrapper,.faq-item,.accordion-item,details')||header.parentElement; return p; }
  function toggleFaq(header){
    var p = findContents(header);
    if(!p) return;
    // FAQ aperte di default. Toggle = aggiunge/rimuove .fb-collapsed
    var willCollapse = !p.classList.contains('fb-collapsed');
    if(willCollapse){
      p.classList.add('fb-collapsed');
      p.classList.remove('active','open','expanded','is-open','show');
      if(p.tagName==='DETAILS') p.removeAttribute('open');
    } else {
      p.classList.remove('fb-collapsed');
      p.classList.add('active','open','expanded','is-open','show');
      if(p.tagName==='DETAILS') p.setAttribute('open','');
    }
    header.setAttribute('aria-expanded', willCollapse?'false':'true');
    var icon = header.querySelector('.faq-icon,.accordion-icon,svg');
    if(icon){ if(willCollapse) icon.classList.remove('fb-icon-rotated'); else icon.classList.add('fb-icon-rotated'); }
  }
  function bindFaq(){ if(document.body.__faqDelegateBound)return; document.body.__faqDelegateBound=true; document.body.addEventListener('click',function(ev){ var t=ev.target; if(!t||!t.closest)return; var actionable=t.closest('a,button,input,select,textarea,label,[role="button"],[onclick]'); var header=t.closest('.faq-header,.faq-question,.faq-title,.accordion-header,.accordion-question,.accordion-toggle,.accordion-button,[data-faq-toggle],[data-toggle="collapse"],summary'); if(!header)return; if(actionable && header.contains(actionable) && actionable!==header) return; ev.preventDefault(); ev.stopPropagation(); try{ toggleFaq(header); }catch(e){} },true); document.querySelectorAll('.faq-header,.faq-question,.faq-title,.accordion-header,.accordion-button,summary').forEach(function(h){ h.style.cursor='pointer'; }); }
  function bindThumbs(){ if(document.body.__thumbDelegateBound)return; document.body.__thumbDelegateBound=true; document.body.addEventListener('click',function(ev){ var t=ev.target; if(!t||!t.closest)return; var tc=t.closest('.thumbImage,.swiper-thumbs,[data-thumb-container]'); if(!tc)return; var ti=t.closest('.swiper-slide,[data-thumb],img'); if(!ti)return; var sib=Array.prototype.slice.call(tc.querySelectorAll('.swiper-slide,[data-thumb]')); if(!sib.length) sib=Array.prototype.slice.call(tc.querySelectorAll('img')); var idx=sib.indexOf(ti); if(idx<0){ var p=ti; while(p&&idx<0){ idx=sib.indexOf(p); p=p.parentElement; } } var mainEl=document.querySelector('.swiper.mainImage'); if(mainEl&&mainEl.swiper&&idx>=0){ try{ mainEl.swiper.slideTo(idx); }catch(_){} } var img=ti.tagName==='IMG'?ti:ti.querySelector('img'); if(img){ var src=img.currentSrc||img.src||img.getAttribute('data-src'); if(src){ var m=document.querySelector('.swiper.mainImage .swiper-slide-active img,.swiper.mainImage .swiper-slide img,.mainImage img:not(.thumb),.product-image img'); if(m){ m.src=src; m.removeAttribute('srcset'); } } } },true); }
  function initSwipers(){ if(typeof window.Swiper!=='function')return false; var thumbs=[]; document.querySelectorAll('.swiper.thumbImage,.swiper.swiper-thumbs').forEach(function(el){ if(el.swiper||el.__swBound)return; el.__swBound=true; try{ thumbs.push(new window.Swiper(el,{slidesPerView:'auto',spaceBetween:10,watchSlidesProgress:true,freeMode:true,slideToClickedSlide:true})); }catch(_){} }); document.querySelectorAll('.swiper.mainImage').forEach(function(el){ if(el.swiper||el.__swBound)return; el.__swBound=true; var opts={slidesPerView:1,spaceBetween:10,navigation:{nextEl:el.querySelector('.swiper-button-next'),prevEl:el.querySelector('.swiper-button-prev')},pagination:{el:el.querySelector('.swiper-pagination'),clickable:true}}; if(thumbs[0]) opts.thumbs={swiper:thumbs[0]}; try{ new window.Swiper(el,opts); }catch(_){} }); document.querySelectorAll('.swiper').forEach(function(el){ if(el.swiper||el.__swBound)return; el.__swBound=true; var ann=el.classList.contains('announcement_bar'); try{ new window.Swiper(el,{slidesPerView:1,spaceBetween:10,loop:ann,autoplay:ann?{delay:3500}:false,navigation:{nextEl:el.querySelector('.swiper-button-next'),prevEl:el.querySelector('.swiper-button-prev')},pagination:{el:el.querySelector('.swiper-pagination'),clickable:true}}); }catch(_){} }); document.querySelectorAll('.stickSection').forEach(function(s){ s.style.display=''; }); return true; }
  function bootstrap(){ console.log('[fb-server]',FB_VERSION,'boot'); bindFaq(); bindThumbs(); var hasJq=typeof window.jQuery!=='undefined'; var hasSw=typeof window.Swiper==='function'; loadCss('https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.css'); var pending=0; function done(){ if(--pending<=0) finalize(); } if(!hasJq){ pending++; loadScript('https://code.jquery.com/jquery-3.5.1.min.js',done); } if(!hasSw){ pending++; loadScript('https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js',done); } if(pending===0) finalize(); }
  function finalize(){ initSwipers(); bindFaq(); bindThumbs(); setTimeout(function(){ initSwipers(); },1500); console.log('[fb-server]',FB_VERSION,'finalized'); }
  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded',bootstrap); } else { setTimeout(bootstrap,50); }
})();</script>`
        if (clonedHTML.includes('</body>')) {
          clonedHTML = clonedHTML.replace('</body>', fallbackInitServerSide + '</body>')
        } else {
          clonedHTML = clonedHTML + fallbackInitServerSide
        }

        console.log(`✅ Ricostruzione HTML completata: ${replacementCount} testi sostituiti`)

        await supabase
          .from('cloning_jobs')
          .update({ 
            status: 'completed',
            completed_at: new Date().toISOString(),
            final_html: clonedHTML
          })
          .eq('id', jobId)

        let reportData
        try {
          reportData = {
            totalTexts: replacementReport.length,
            replaced: replacementReport.filter(r => r && r.replaced).length,
            notReplaced: replacementReport.filter(r => r && !r.replaced).length,
            details: replacementReport
          }
        } catch (reportError) {
          console.error('Errore generazione report:', reportError)
          reportData = {
            totalTexts: 0,
            replaced: 0,
            notReplaced: 0,
            details: [],
            error: 'Errore generazione report'
          }
        }

        return new Response(
          JSON.stringify({
            success: true,
            phase: 'completed',
            jobId: jobId,
            content: clonedHTML,
            format: job.output_format || 'html',
            textsProcessed: allProcessedTexts.length,
            replacements: replacementCount,
            report: reportData,
            inlineBundleStats,
            finalHtmlLength: clonedHTML.length,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Processa batch con Claude
      const { data: userProfile } = await supabase
        .from('user_profiles')
        .select('anthropic_api_key')
        .eq('id', userId)
        .single()

      if (!userProfile?.anthropic_api_key) {
        return new Response(
          JSON.stringify({ error: 'API Key Anthropic non configurata' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const batchTexts = textsToProcess.map(t => ({
        index: t.index,
        text: t.original_text,
        tag: t.tag_name,
        classes: t.classes || ''
      }))
      
      console.log(`\n📋 BATCH ${batchNumber + 1} - TESTI ESTRATTI DA RISCRIVERE (${batchTexts.length} testi):`)
      batchTexts.forEach((t, idx) => {
        console.log(`  [${idx + 1}] Index: ${t.index}, Tag: ${t.tag || 'N/A'}, Testo: "${t.text.substring(0, 100)}${t.text.length > 100 ? '...' : ''}"`)
      })
      console.log(`\n`)

      const needsItalianTranslation = job.custom_prompt && 
        (job.custom_prompt.toLowerCase().includes('italiano') || 
         job.custom_prompt.toLowerCase().includes('italian') ||
         job.custom_prompt.toLowerCase().includes('traduci') ||
         job.custom_prompt.toLowerCase().includes('translate'))

      let detectedBrand = ''
      try {
        const urlObj = new URL(job.url)
        detectedBrand = urlObj.hostname.replace(/^www\./, '').split('.')[0]
        if (detectedBrand.length <= 3) detectedBrand = ''
      } catch {}

      // SPA detection: pages built with Vue (data-v-*), React (data-reactroot,
      // __NEXT_DATA__), Svelte (svelte-* class), Nuxt (__NUXT__), or page
      // builders that compile to a Vue/React component (Funnelytics, Clickfunnels
      // 2.0, Convertri, Shogun, Replo) hydrate the static markup at runtime.
      // If the rewritten text introduces NEW HTML tags (<p>, <strong>, <br>)
      // that weren't in the original DOM, the hydration mismatch causes the
      // framework to BAIL and skip attaching event handlers — accordions,
      // sliders, gallery thumbnails, modals stop responding to clicks even
      // though they still render. Detection: cheap regex on a 50KB sample.
      const htmlSample = (job.original_html || '').substring(0, 50_000)
      const isSpaPage =
        /\bdata-v-[a-f0-9]{6,}/.test(htmlSample) ||
        /\bdata-reactroot\b/.test(htmlSample) ||
        /__NEXT_DATA__/.test(htmlSample) ||
        /__NUXT__/.test(htmlSample) ||
        /__sveltekit_data/.test(htmlSample) ||
        /\bsvelte-[a-z0-9]{6,}/.test(htmlSample) ||
        /<div[^>]+id=["']root["'][^>]*>\s*<\/div>/.test(htmlSample) ||
        /<div[^>]+id=["']__next["'][^>]*>/.test(htmlSample) ||
        /\bv-cloak\b/.test(htmlSample) ||
        /\bng-(?:app|controller|view)\b/.test(htmlSample)

      if (isSpaPage) {
        console.log(`🧬 SPA page detected — disabling HTML markup in rewrites to avoid hydration mismatch`)
      }

      // Brief and market_research live in cached system blocks
      // (cache_control: ephemeral) so we pay full-price exactly once per
      // job and 90% off on every subsequent batch. Limit per section:
      // 200KB ≈ 50K tokens. Budget per Claude call:
      //   ~46K  knowledge base
      //   ~50K  brief
      //   ~50K  market research
      //   ~15K  user prompt (extracted texts batch)
      //   ~16K  output
      //   ─────
      //   ~177K tokens, safely under Sonnet 4's 200K context window.
      //
      // Funnel context still stays in the user prompt because it changes
      // between pages of the same Swipe-All run (different cache key).
      const SECTION_CHAR_LIMIT = 200_000
      const briefTrimmed = brief ? String(brief).slice(0, SECTION_CHAR_LIMIT) : ''
      const researchTrimmed = market_research ? String(market_research).slice(0, SECTION_CHAR_LIMIT) : ''
      const funnelContextTrimmed = funnel_context ? String(funnel_context).slice(0, 8000) : ''
      // Surface truncation explicitly in logs so operators can spot when a
      // project's brief or research is hitting the cap and not all the
      // uploaded files are reaching Claude.
      if (brief && String(brief).length > SECTION_CHAR_LIMIT) {
        console.warn(`✂️  brief truncated: ${String(brief).length.toLocaleString()} → ${SECTION_CHAR_LIMIT.toLocaleString()} chars (lost ${(String(brief).length - SECTION_CHAR_LIMIT).toLocaleString()})`)
      }
      if (market_research && String(market_research).length > SECTION_CHAR_LIMIT) {
        console.warn(`✂️  market_research truncated: ${String(market_research).length.toLocaleString()} → ${SECTION_CHAR_LIMIT.toLocaleString()} chars (lost ${(String(market_research).length - SECTION_CHAR_LIMIT).toLocaleString()})`)
      }

      const rewritePrompt = `La landing page è un TEMPLATE strutturale. Il tuo compito è riscrivere TUTTI i testi usando SOLO le informazioni del nuovo prodotto.

📋 INFORMAZIONI DEL NUOVO PRODOTTO (USA SOLO QUESTE):
Nome prodotto: ${job.product_name}
Descrizione prodotto: ${job.product_description}
${job.framework ? `Framework copywriting: ${job.framework}` : ''}
${job.target ? `Target audience: ${job.target}` : ''}
${job.custom_prompt ? `Istruzioni copy personalizzate: ${job.custom_prompt}` : ''}
${(briefTrimmed || researchTrimmed) ? `\n👉 Il PROJECT BRIEF e la MARKET RESEARCH completi (con tutti i file caricati su My Projects) sono stati forniti nel SYSTEM PROMPT come fonti primarie di verità. Usali attivamente per tono, positioning, pain points, value props, linguaggio del pubblico.\n` : ''}
${funnelContextTrimmed ? `\n🧵 FUNNEL NARRATIVE (pagine già riscritte di questo stesso funnel — DEVI mantenere COERENZA su tono di voce, angle/grande idea, big promise, pain point principale, audience, CTA logic. NON contraddire ciò che è stato detto prima; aggiungi profondità coerente con la posizione di questa pagina nel funnel):\n${funnelContextTrimmed}\n` : ''}

🎯 COSA DEVI FARE:
- I testi originali sono SOLO per capire: lunghezza approssimativa, tipo di testo (titolo/bottone/descrizione), formattazione
- IGNORA completamente il contenuto dei testi originali - NON copiare NESSUNA parola dal testo originale
- CREA nuovi testi da zero usando SOLO: nome prodotto, descrizione, framework, istruzioni copy
- Ogni testo deve essere COERENTE con il nuovo prodotto, ma NON deve necessariamente CITARE il suo nome
- Se il testo originale contiene &nbsp; o spazi all'inizio, mantieni la stessa formattazione ma riscrivi TUTTO il contenuto DOPO &nbsp; usando SOLO le informazioni del nuovo prodotto
- IMPORTANTE: Riscrivi TUTTO il testo dopo &nbsp; con testo completamente nuovo adattato al prodotto - non lasciare parti del testo originale

🚫 REGOLE ANTI-RIPETIZIONE DEL NOME PRODOTTO (CRITICAL — VIOLATION = REWRITE):
- Il nome prodotto "${job.product_name}" può apparire MASSIMO 1 volta per testo se il testo è breve (heading, bottone, label, bullet, feature card).
- Nei testi lunghi (paragrafi 100+ caratteri) può apparire MASSIMO 2 volte, in punti diversi e mai consecutivi.
- Non inserire MAI il nome prodotto due volte nello stesso heading o nella stessa frase.
- Nei feature-block / bullet / sotto-titoli scrivi SOLO il beneficio, MAI il nome prodotto.
- Negli header di sezione ("How it works", "Benefits", "Ingredients", "FAQs") il nome NON deve comparire.
- Nelle label commerciali ("Welcome Gift", "30-Day Protocol", "You Save", "Add to Cart", prezzi, sconti, "30-Day Money Back") il nome NON deve comparire.
- Quando devi riferirti al prodotto in modo generico: usa pronomi o termini neutri ("it", "this", "the formula", "the supplement", "il prodotto", "la formula").

ESEMPI CONCRETI (copia questo stile):

Heading hero (lungo):
  ✗ "${job.product_name} Appetite ${job.product_name} Control"
  ✗ "${job.product_name} ${job.product_name} Reset"
  ✓ "Take Back Control of Your Cravings with ${job.product_name}"
  ✓ "Reset Your Routine in 90 Days"

Feature card / bullet:
  ✗ "${job.product_name} Weight Management"
  ✗ "Weight ${job.product_name} ${job.product_name}"
  ✓ "Weight Management"
  ✓ "Evening Craving Control"

Label commerciali:
  ✗ "Welcome Gift - ${job.product_name} \\$18.00"
  ✗ "You ${job.product_name}"
  ✓ "Welcome Gift - \\$18.00"
  ✓ "You Save"
  ✓ "30-Day Protocol"

Body copy (frase intera):
  ✗ "The ${job.product_name} appetite ${job.product_name} your changing body has been waiting for."
  ✓ "The appetite formula your changing body has been waiting for."
  ✓ "${job.product_name} is the appetite formula your changing body has been waiting for."

REGOLA D'ORO: se NON sapresti come pronunciarlo ad alta voce in un'inserzione TV, è stuffing. Riscrivi.

${isSpaPage ? `📐 FORMATTAZIONE HTML — DIVIETO ASSOLUTO (pagina SPA Vue/React/Svelte rilevata):
- 🚨 NON aggiungere MAI alcun tag HTML al testo riscritto. NIENTE <p>, <strong>, <em>, <br>, <span>, <ul>, <li>.
- Restituisci SEMPRE plain text. Se il testo originale aveva newline o &nbsp;, mantienili IDENTICI nelle stesse posizioni.
- Se il testo originale conteneva tag HTML (es. <strong>...</strong>), preservali ESATTAMENTE: stessi tag, stessa posizione relativa, stessa nidificazione. Cambia SOLO il testo dentro i tag.
- Motivo: questa pagina è un componente Vue/React idratato dal browser. Aggiungere o togliere un solo tag rompe l'hydration e disabilita TUTTI i click handler (accordion FAQ, gallery prodotto, modal). Nessuna eccezione.
- Per testi lunghi senza HTML originale: scrivi testo continuo separato solo da \\n (newline) dove servono pause logiche, mai con <br>.` : `📐 FORMATTAZIONE HTML OBBLIGATORIA:
- Se il testo originale è LUNGO (più di 100 caratteri), DEVI formattarlo con tag HTML
- Usa <p>...</p> per separare i paragrafi (ogni 2-3 frasi)
- Usa <strong>...</strong> per parole/frasi importanti da evidenziare
- Usa <br> per andare a capo quando serve
- NON creare muri di testo - dividi SEMPRE in paragrafi leggibili
- Per testi CORTI (titoli, bottoni, meno di 100 caratteri): NON usare tag HTML`}

⚠️ REGOLE CRITICHE:
- NON mescolare lingue diverse nello stesso testo
- Se il testo originale è in inglese, scrivi tutto in inglese
- Se il testo originale è in italiano, scrivi tutto in italiano
- NON copiare NESSUNA parola dal testo originale - riscrivi tutto da zero
- Se trovi nomi di brand, aziende o siti web del COMPETITOR (NON il nuovo prodotto) nel testo originale, RIMUOVILI o sostituiscili con un termine generico ("the formula", "the supplement", "il prodotto"). NON sostituirli automaticamente con "${job.product_name}" — quello produce stuffing.
- INGREDIENTI/SOSTANZE specifiche del competitor (es. "Moringa", "Berberine", "Resveratrol", ingredienti esotici) NON devono finire nel copy del nuovo prodotto a meno che non siano esplicitamente menzionati nella descrizione del prodotto qui sopra. Se il testo originale dice "What can Moringa help with?" e il nuovo prodotto NON contiene Moringa, riscrivi come "What can it help with?" o "How does it work?".
${detectedBrand ? `- Il brand del competitor e probabilmente "${detectedBrand}". Quando lo incontri, sostituiscilo con un termine generico ("the formula", "il prodotto") o ometti la menzione. Cita "${job.product_name}" SOLO una volta nel testo, non in ogni occorrenza.` : ''}

📝 TESTI DA RISCRIVERE (usa solo per capire lunghezza/tipo/formattazione - IGNORA completamente il contenuto):
${JSON.stringify(batchTexts, null, 2)}

${needsItalianTranslation ? '\n🇮🇹 TRADUZIONE OBBLIGATORIA:\n- Scrivi TUTTI i testi in italiano\n- Traduci ogni parola inglese o straniera\n- Se è misto italiano/inglese, traduci TUTTO in italiano' : ''}

RESTITUISCI SOLO JSON ARRAY (stesso ordine):
[{"index": 0, "text": "testo riscritto per il nuovo prodotto"}, ...]`

      // Build the system prompt as multi-block array so we can mark the
      // copywriting knowledge base with cache_control: ephemeral. Claude will
      // cache the KB block for ~5 minutes; subsequent batches of the same job
      // pay only 10% of input cost on the cached portion.
      const systemBlocks: Array<{
        type: 'text'
        text: string
        cache_control?: { type: 'ephemeral' }
      }> = [
        {
          type: 'text',
          text: `You are an expert senior direct-response copywriter integrated into the "Funnel Cloner Builder" tool. You rewrite landing-page copy from a structural template, applying proven direct-response frameworks (COS Engine, Tony Flores' Million Dollar Mechanisms, Evaldo's 16-Word Sales Letter, Anghelache's Crash Course, Peter Kell's Savage System, Brunson's 108 Split Test Winners). Apply the techniques naturally — do NOT name them in the output. Always reply in the language requested by the user. Never output anything other than the JSON array specified.`,
        },
      ]

      if (system_kb && typeof system_kb === 'string' && system_kb.length > 200) {
        systemBlocks.push({
          type: 'text',
          text: system_kb,
          cache_control: { type: 'ephemeral' },
        })
      }

      // Project brief + market research as cached system blocks. They live
      // in the system prompt (not the per-batch user prompt) so we pay the
      // tokens once per job and get a 90% discount on every subsequent
      // batch. This lets users upload large multi-file briefs without
      // wrecking cost or context budget.
      if (briefTrimmed) {
        systemBlocks.push({
          type: 'text',
          text:
            `📄 PROJECT BRIEF — fonte primaria di verità per tono, posizionamento e value props del nuovo prodotto. ` +
            `Tutti i file caricati su My Projects sono concatenati qui (separati da "=== FILE: ... ===").\n\n` +
            briefTrimmed,
          cache_control: { type: 'ephemeral' },
        })
      }
      if (researchTrimmed) {
        systemBlocks.push({
          type: 'text',
          text:
            `🔬 MARKET RESEARCH — insight su pubblico target, dolori, desideri, linguaggio, obiezioni. ` +
            `Tutti i file caricati su My Projects sono concatenati qui (separati da "=== FILE: ... ===").\n\n` +
            researchTrimmed,
          cache_control: { type: 'ephemeral' },
        })
      }

      let claudeResponse
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS_RUNTIME)

      try {
        claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': userProfile.anthropic_api_key,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            // 6000 was too tight: 12 texts × ~500 tok avg = 6000 tok, so any
            // single long body paragraph would cut the JSON mid-way and the
            // parser would fall back to the ORIGINAL text for the entire
            // batch (12 texts unchanged). Bumping to 16000 gives ~1300 tok
            // per text — comfortable headroom for long body copy.
            max_tokens: 16000,
            temperature: 0.6,
            system: systemBlocks,
            messages: [{ role: 'user', content: rewritePrompt }]
          }),
          signal: controller.signal
        })

        clearTimeout(timeoutId)
      } catch (fetchError) {
        clearTimeout(timeoutId)
        if (fetchError.name === 'AbortError' || controller.signal.aborted) {
          const tSec = Math.round(CLAUDE_TIMEOUT_MS_RUNTIME / 1000)
          return new Response(
            JSON.stringify({
              error: `Timeout chiamata Claude API (${tSec}s) sul batch di ${BATCH_SIZE_RUNTIME} testi. Riduci batchSize nel body della richiesta (es. 6-8) o aumenta claudeTimeoutMs (max 140000).`,
              batchSize: BATCH_SIZE_RUNTIME,
              claudeTimeoutMs: CLAUDE_TIMEOUT_MS_RUNTIME,
            }),
            { status: 504, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        return new Response(
          JSON.stringify({ error: `Errore chiamata Claude API: ${fetchError.message}` }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      
      if (!claudeResponse.ok) {
        const error = await claudeResponse.json().catch(() => ({ error: { message: 'Unknown error' } }))
        return new Response(
          JSON.stringify({ error: `Errore Claude API: ${error.error?.message || 'Unknown error'}` }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const claudeData = await claudeResponse.json()
      let rewrittenTexts = []

      // Log usage with cache hit/miss so we can verify the KB cache is
      // actually working in production (Supabase Function logs).
      try {
        const u = claudeData?.usage || {}
        const cacheRead = u.cache_read_input_tokens || 0
        const cacheWrite = u.cache_creation_input_tokens || 0
        const inputTokens = u.input_tokens || 0
        const outputTokens = u.output_tokens || 0
        console.log(
          `💰 Claude usage batch ${batchNumber + 1}: ` +
          `input=${inputTokens} | cache_write=${cacheWrite} | cache_read=${cacheRead} | output=${outputTokens}` +
          (cacheRead > 0 ? ` | 🎯 CACHE HIT (paying 10%)` : cacheWrite > 0 ? ` | 🆕 cache primed` : '')
        )
      } catch { /* best-effort logging */ }

      try {
        let responseText = claudeData.content[0].text
        responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
        
        let jsonMatch = responseText.match(/\[[\s\S]*\]/)
        
        if (!jsonMatch) {
          const arrayStart = responseText.indexOf('[')
          if (arrayStart !== -1) {
            let partialJson = responseText.substring(arrayStart)
            partialJson = partialJson.replace(/[^}\]]*$/, '')
            const openBrackets = (partialJson.match(/\[/g) || []).length
            const closeBrackets = (partialJson.match(/\]/g) || []).length
            if (openBrackets > closeBrackets) {
              partialJson += ']'.repeat(openBrackets - closeBrackets)
            }
            jsonMatch = [partialJson]
          }
        }
        
        if (jsonMatch && jsonMatch[0]) {
          let jsonString = jsonMatch[0]
          jsonString = jsonString.replace(/}\s*{/g, '},{')
          jsonString = jsonString.replace(/}\s*\]/g, '}]')
          jsonString = jsonString.replace(/,\s*]/g, ']')
          jsonString = jsonString.replace(/,\s*}/g, '}')
          
          try {
            rewrittenTexts = JSON.parse(jsonString)
          } catch (innerError) {
            const objectMatches = jsonString.match(/\{[^}]*"index"\s*:\s*\d+[^}]*"text"\s*:\s*"[^"]*"[^}]*\}/g)
            if (objectMatches && objectMatches.length > 0) {
              rewrittenTexts = objectMatches.map(objStr => {
                try {
                  return JSON.parse(objStr)
                } catch {
                  const indexMatch = objStr.match(/"index"\s*:\s*(\d+)/)
                  const textMatch = objStr.match(/"text"\s*:\s*"([^"]*)"/)
                  if (indexMatch && textMatch) {
                    return { index: parseInt(indexMatch[1]), text: textMatch[1] }
                  }
                  return null
                }
              }).filter(obj => obj !== null)
            } else {
              throw innerError
            }
          }
        } else {
          rewrittenTexts = JSON.parse(responseText)
        }
        
        if (!Array.isArray(rewrittenTexts)) {
          throw new Error('Risposta Claude non è un array JSON valido')
        }
        
        rewrittenTexts = rewrittenTexts.filter(item => 
          item && typeof item.index === 'number' && typeof item.text === 'string'
        )
        
        if (rewrittenTexts.length === 0) {
          throw new Error('Nessun testo valido trovato nella risposta Claude')
        }

        // Partial-recovery: Claude may have returned fewer items than the
        // batch (truncation, filtering). Fill the gaps with the ORIGINAL
        // text so the page still renders, and log how many were lost.
        const returnedIndexes = new Set<number>(rewrittenTexts.map((t: { index: number }) => t.index))
        const missingFromClaude = textsToProcess.filter(t => !returnedIndexes.has(t.index))
        if (missingFromClaude.length > 0) {
          console.warn(
            `⚠️ Batch ${batchNumber + 1}: Claude ha restituito ${rewrittenTexts.length}/${textsToProcess.length} testi. ` +
            `${missingFromClaude.length} mancanti, fallback all'originale per: ` +
            missingFromClaude.map(t => t.index).join(', ')
          )
          for (const m of missingFromClaude) {
            rewrittenTexts.push({ index: m.index, text: m.original_text })
          }
        }

        const changedCount = rewrittenTexts.filter((t: { index: number; text: string }) => {
          const orig = batchTexts.find(b => b.index === t.index)
          return orig && orig.text !== t.text
        }).length
        console.log(
          `\n✅ BATCH ${batchNumber + 1} - ${rewrittenTexts.length} testi totali, ` +
          `${changedCount} riscritti, ${rewrittenTexts.length - changedCount} invariati ` +
          `(${missingFromClaude.length} fallback su originale)`
        )
        rewrittenTexts.forEach((t: { index: number; text: string }, idx: number) => {
          const original = batchTexts.find(b => b.index === t.index)
          console.log(`  [${idx + 1}] Index: ${t.index}`)
          console.log(`      ORIGINALE: "${original?.text.substring(0, 80)}${original && original.text.length > 80 ? '...' : ''}"`)
          console.log(`      RISCRITTO: "${t.text.substring(0, 80)}${t.text.length > 80 ? '...' : ''}"`)
          console.log(`      CAMBIATO: ${original?.text !== t.text ? '✅ SÌ' : '❌ NO'}`)
        })
        console.log(`\n`)

      } catch (parseError) {
        console.error('❌ Errore parsing risposta Claude:', parseError)
        console.error('Risposta raw (primi 500 caratteri):', claudeData.content[0].text.substring(0, 500))

        // Last-resort regex sweep: salvage as many `{"index": N, "text": "..."}`
        // pairs as possible from the raw response, even if the surrounding
        // JSON envelope is malformed. This is much better than dropping the
        // entire batch back to the original text (which is what used to
        // happen and caused "many texts unchanged" reports).
        const rawText: string = claudeData.content[0].text || ''
        const salvaged: Array<{ index: number; text: string }> = []
        const itemRe = /"index"\s*:\s*(\d+)\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g
        let m: RegExpExecArray | null
        while ((m = itemRe.exec(rawText)) !== null) {
          try {
            const text = JSON.parse(`"${m[2]}"`)
            salvaged.push({ index: parseInt(m[1], 10), text })
          } catch { /* skip malformed item */ }
        }
        const salvagedIdx = new Set(salvaged.map(s => s.index))
        const fallbacks = textsToProcess
          .filter(t => !salvagedIdx.has(t.index))
          .map(t => ({ index: t.index, text: t.original_text }))
        rewrittenTexts = [...salvaged, ...fallbacks]
        console.warn(
          `⚠️ Recovery batch ${batchNumber + 1}: ${salvaged.length} riscritture salvate via regex, ` +
          `${fallbacks.length} fallback su originale.`
        )
      }

      // SPA safety: when the source page is a hydrated Vue/React/Svelte
      // component, the rewritten text MUST keep exactly the same tag
      // structure as the original — adding or removing tags causes the
      // framework to bail hydration and disable all event handlers
      // (broken accordions, sliders, gallery thumbnails, modals).
      // We enforce it server-side: if the original text has no tags,
      // strip every tag from the rewrite. If the original had tags, we
      // can't easily realign Claude's tags to the original positions, so
      // we fall back to plain text (slightly worse formatting, fully
      // working interactivity).
      const enforceSpaSafety = (originalText: string, rewrittenText: string): string => {
        if (!isSpaPage) return rewrittenText
        const originalHasTags = /<[a-zA-Z\/]/.test(originalText)
        const rewrittenHasTags = /<[a-zA-Z\/]/.test(rewrittenText)
        if (!rewrittenHasTags) return rewrittenText
        if (!originalHasTags) {
          // Strip all tags. Decode common entities introduced by tag stripping.
          return rewrittenText
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
        }
        // Original had tags AND rewritten has tags. Conservative path:
        // strip rewritten tags down to text, then we still preserve the
        // original tag skeleton in distributeTextProportionally during
        // rebuild. This avoids any tag mismatch on hydration.
        return rewrittenText
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>/gi, '\n\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
      }

      // Anti-stuffing pass: Claude (or upstream substitutions) sometimes
      // repeats the product name 2-3 times in short headings/buttons and
      // 3+ times in body copy. Strip occurrences beyond a length-aware
      // budget. Headings and buttons get max 1 mention; body copy gets
      // max 2.
      const stripStuffing = (rawText: string, brand: string): string => {
        if (!rawText || !brand || brand.length < 3) return rawText
        const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const occRegex = new RegExp(escaped, 'gi')
        const matches = rawText.match(occRegex)
        if (!matches) return rawText

        // Strip HTML tags to evaluate the visible text length only
        const visibleLen = rawText.replace(/<[^>]+>/g, '').trim().length
        // Heading / button / short label heuristic: <= 60 visible chars OR
        // no sentence-ending punctuation. These should mention the brand
        // 0-1 times maximum.
        const isShort = visibleLen <= 60 || !/[.!?]/.test(rawText)
        const maxAllowed = isShort ? 1 : 2

        if (matches.length <= maxAllowed) return rawText

        let seen = 0
        let cleaned = rawText.replace(occRegex, (m) => {
          seen += 1
          return seen <= maxAllowed ? m : ''
        })

        // Tidy up resulting double spaces / dangling punctuation / empty
        // separators left where the brand was removed.
        cleaned = cleaned
          .replace(/\s+([,.;:!?)])/g, '$1')
          .replace(/\(\s+/g, '(')
          // dash now leading the string (e.g. "- $18.00") -> drop
          .replace(/^\s*[\-–—]\s+/, '')
          // dash now trailing the string (e.g. "Welcome Gift -") -> drop
          .replace(/\s+[\-–—]\s*$/, '')
          // collapse repeated whitespace
          .replace(/\s{2,}/g, ' ')
          // remove stray whitespace before closing inline tags
          .replace(/\s+(<\/(?:strong|em|p|span|h[1-6]|li|td|th|a|button)>)/gi, '$1')
          // empty paragraph/strong/em wrappers left over -> drop
          .replace(/<(strong|em|span|p|h[1-6])>\s*<\/\1>/gi, '')
          .trim()

        // If after stripping the text is now suspiciously empty/garbage
        // (e.g. became just "†" or " "), keep the original — we'd rather
        // ship a stuffed text than a broken one.
        const visibleAfter = cleaned.replace(/<[^>]+>/g, '').trim()
        if (visibleAfter.length < 3) return rawText

        return cleaned
      }

      // Per-batch (original → rewritten) preview pairs returned to the
      // client so the cinematic overlay can show the user the actual
      // copy changes happening live, batch by batch — not just a counter.
      // We strip HTML, collapse whitespace and cap length to keep the
      // payload light (~25 entries × ~280 chars = ~14 KB max per batch).
      const stripHtmlForPreview = (s: string): string =>
        (s || '')
          .replace(/<br\s*\/?>(\s|&nbsp;)*/gi, ' ')
          .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\s+/g, ' ')
          .trim()
      const cap = (s: string, n: number): string =>
        s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…'

      const rewritesPreview: Array<{ index: number; original: string; rewritten: string }> = []

      for (const rewritten of rewrittenTexts) {
        const originalText = textsToProcess.find(t => t.index === rewritten.index)
        if (originalText) {
          const safeText = enforceSpaSafety(originalText.original_text || '', rewritten.text || '')
          const cleanedText = stripStuffing(safeText, job.product_name)
          await supabase
            .from('cloning_texts')
            .update({
              new_text: cleanedText,
              processed: true,
              processed_at: new Date().toISOString()
            })
            .eq('id', originalText.id)

          const beforeStr = stripHtmlForPreview(originalText.raw_text || originalText.original_text || '')
          const afterStr = stripHtmlForPreview(cleanedText)
          // Filter out micro-texts (single chars, currency symbols, dashes,
          // pure digits) — they are visual noise in the live stream and
          // don't carry meaningful copy changes.
          if (
            beforeStr.length >= 3 &&
            afterStr.length >= 3 &&
            beforeStr !== afterStr
          ) {
            rewritesPreview.push({
              index: originalText.index,
              original: cap(beforeStr, 280),
              rewritten: cap(afterStr, 280),
            })
          }
        }
      }

      const { count: remainingCount } = await supabase
        .from('cloning_texts')
        .select('*', { count: 'exact', head: true })
        .eq('job_id', jobId)
        .eq('processed', false)

      if (remainingCount === 0) {
        // All texts processed - rebuild final HTML (same logic as above)
        const { data: allProcessedTexts, error: allTextsError } = await supabase
          .from('cloning_texts')
          .select('*')
          .eq('job_id', jobId)
          .eq('processed', true)
          .order('index', { ascending: true })

        if (allTextsError || !allProcessedTexts) {
          return new Response(
            JSON.stringify({ error: 'Errore caricamento testi processati per risultato finale' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }

        console.log(`🔄 Ricostruzione HTML finale: ${allProcessedTexts.length} testi da sostituire...`)
        let clonedHTML = job.original_html
        let replacementCount = 0
        const replacementReport: Array<any> = []

        const sortedTexts = [...allProcessedTexts]
          .filter(t => t.new_text && t.original_text)
          .sort((a, b) => b.original_text.length - a.original_text.length)

        const REPLACEMENT_CHUNK_SIZE = 15
        const textChunks = []
        for (let i = 0; i < sortedTexts.length; i += REPLACEMENT_CHUNK_SIZE) {
          textChunks.push(sortedTexts.slice(i, i + REPLACEMENT_CHUNK_SIZE))
        }

        for (let chunkIndex = 0; chunkIndex < textChunks.length; chunkIndex++) {
          const chunk = textChunks[chunkIndex]
          for (const textData of chunk) {
            if (!textData || typeof textData !== 'object') continue
            const originalText = textData.original_text
            const newText = textData.new_text
            if (!originalText || !newText || typeof originalText !== 'string' || typeof newText !== 'string') continue
            
            const rawText = textData.raw_text || originalText
            let found = false
            
            if (!found && clonedHTML.includes(originalText)) {
              clonedHTML = clonedHTML.replace(originalText, newText)
              replacementCount++
              found = true
            }
            if (!found && rawText !== originalText && clonedHTML.includes(rawText)) {
              clonedHTML = clonedHTML.replace(rawText, newText)
              replacementCount++
              found = true
            }
            if (!found && originalText.length >= 5 && originalText.length < 500) {
              try {
                const words = originalText.split(/\s+/).filter((w: string) => w.length > 0)
                if (words.length >= 2 && words.length <= 30) {
                  const escapedWords = words.map((w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                  const pattern = escapedWords.join('(?:\\s|&nbsp;|<[^>]{0,200}>)*')
                  const regex = new RegExp(pattern, 'i')
                  const match = clonedHTML.match(regex)
                  if (match) {
                    const matchedStr = match[0]
                    const tagsInMatch = matchedStr.match(/<[^>]+>/g) || []
                    if (tagsInMatch.length > 0) {
                      const segments = matchedStr.split(/(<[^>]+>)/)
                      const textSegments: { index: number; content: string }[] = []
                      for (let si = 0; si < segments.length; si++) {
                        if (segments[si] && !segments[si].startsWith('<')) textSegments.push({ index: si, content: segments[si] })
                      }
                      if (textSegments.length > 0) {
                        distributeTextProportionally(segments, textSegments, newText)
                        clonedHTML = clonedHTML.substring(0, match.index!) + segments.join('') + clonedHTML.substring(match.index! + matchedStr.length)
                      } else {
                        clonedHTML = clonedHTML.substring(0, match.index!) + newText + tagsInMatch.join('') + clonedHTML.substring(match.index! + matchedStr.length)
                      }
                    } else {
                      clonedHTML = clonedHTML.substring(0, match.index!) + newText + clonedHTML.substring(match.index! + matchedStr.length)
                    }
                    replacementCount++
                    found = true
                  }
                }
              } catch (e) { /* skip */ }
            }
            
            if (found) console.log(`✅ Testo sostituito: "${originalText.substring(0, 50)}..."`)
            else console.warn(`⚠️ Testo NON sostituito: "${originalText.substring(0, 50)}..."`)
          }
        }

        clonedHTML = replaceBrandInTextContent(clonedHTML, job.url, job.original_html, job.product_name)
        clonedHTML = collapseConsecutiveBrandRuns(clonedHTML, job.product_name)
        clonedHTML = replaceLiquidPlaceholders(clonedHTML)

        console.log(`✅ Ricostruzione HTML completata: ${replacementCount} testi sostituiti`)

        await supabase
          .from('cloning_jobs')
          .update({ status: 'completed', completed_at: new Date().toISOString(), final_html: clonedHTML })
          .eq('id', jobId)

        return new Response(
          JSON.stringify({
            success: true,
            phase: 'completed',
            jobId: jobId,
            content: clonedHTML,
            format: job.output_format || 'html',
            textsProcessed: allProcessedTexts.length,
            replacements: replacementCount,
            report: { totalTexts: allProcessedTexts.length, replaced: replacementCount },
            // Include the LAST batch's preview pairs even on the completion
            // response so the cinematic overlay shows them too (otherwise
            // the final batch's rewrites would never reach the UI).
            rewrites: rewritesPreview,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      return new Response(
        JSON.stringify({
          success: true,
          phase: 'process',
          jobId: jobId,
          batchProcessed: textsToProcess.length,
          remainingTexts: remainingCount || 0,
          continue: true,
          // Live preview pairs for the cinematic overlay (see preview
          // pipeline above). Capped to ~25 per batch by upstream batch
          // sizing.
          rewrites: rewritesPreview,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // FASE "EXTRACT": Estrai testi e salva nel database
    if (phase === 'extract') {
      console.log(`📦 FASE EXTRACT: Estrazione testi per modalità asincrona`)
      
      if (!url) {
        return new Response(
          JSON.stringify({ error: 'Missing required field: url' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      if (cloneMode === 'rewrite' && (!productName || !productDescription)) {
        return new Response(
          JSON.stringify({ error: 'Missing required fields for rewrite mode: productName, productDescription' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // STEP 1: Get HTML - use pre-rendered HTML from Playwright if available, otherwise fetch.
      // Soglia: 5000 char. Sotto è quasi sicuramente uno scheletro SPA (es. <div id="root">+<script>)
      // che non serve a niente: meglio fallback a fetch grezzo che almeno prende qualcosa,
      // anche se per quiz JS-only nemmeno quello basta.
      let originalHTML = ''
      let htmlSource = ''
      const RENDERED_MIN_BYTES = 5000
      if (renderedHtml && typeof renderedHtml === 'string' && renderedHtml.length >= RENDERED_MIN_BYTES) {
        console.log(`📥 STEP 1: Using pre-rendered HTML from Playwright (${renderedHtml.length} chars)`)
        originalHTML = renderedHtml
          .replace(/"\s*==\s*\$\d+/g, '"')
          .replace(/\s*==\s*\$\d+/g, '')
        htmlSource = 'rendered'
      } else {
        if (renderedHtml && typeof renderedHtml === 'string') {
          console.warn(`⚠️ renderedHtml ricevuto ma troppo piccolo (${renderedHtml.length} char < ${RENDERED_MIN_BYTES}) — sembra scheletro SPA. Fallback a fetch grezzo.`)
        }
        console.log('📥 STEP 1: Fetching original HTML from:', url)
        try {
          const htmlResponse = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
          })

          if (!htmlResponse.ok) {
            throw new Error(`Failed to fetch HTML: ${htmlResponse.status} ${htmlResponse.statusText}`)
          }

          originalHTML = await htmlResponse.text()
          originalHTML = originalHTML
            .replace(/"\s*==\s*\$\d+/g, '"')
            .replace(/\s*==\s*\$\d+/g, '')
          
          console.log(`✅ HTML fetched and cleaned, size: ${originalHTML.length} characters`)
          htmlSource = 'fetch'
        } catch (error) {
          console.error('❌ Error fetching HTML:', error)
          return new Response(
            JSON.stringify({ error: `Errore scaricamento HTML: ${error.message}. Verifica che l'URL sia accessibile pubblicamente.` }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
      }

      console.log(`📥 HTML originale ricevuto, dimensione: ${originalHTML.length} caratteri (source=${htmlSource})`)

      // STEP 2: Estrai TUTTI i testi rilevanti dall'HTML.
      // Estrattore unificato: per ogni testo cattura anche tag_name, full_tag,
      // attributes, classes (servono al phase=process per il replace tollerante
      // a 5 strategie e per `replaceBrandInTextContent`).
      type ExtractedTextRow = {
        index: number
        original_text: string
        raw_text: string
        tag_name: string
        full_tag: string
        attributes: string
        classes: string
        position: number
        processed: boolean
      }

      const cleanText = (s: string): string =>
        s
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\s+/g, ' ')
          .trim()

      const extractTextsFromHTML = (html: string): ExtractedTextRow[] => {
        const out: ExtractedTextRow[] = []
        const seen = new Set<string>()
        let nextIdx = 0

        // Valori-segnaposto comuni dei page builder (Funnels.fm, ClickFunnels,
        // ecc.): sono marker tecnici, non copy reale.
        const BUILDER_MARKER_VALUES = new Set([
          'text', 'title', 'link', 'button', 'image', 'submit',
          'placeholder', 'none', 'default', 'block', 'div', 'span',
          'true', 'false', 'on', 'off', 'yes', 'no',
          'lorem ipsum', 'sample text', 'click here',
        ])

        const isBuilderMarker = (s: string): boolean => {
          return BUILDER_MARKER_VALUES.has(s.toLowerCase().trim())
        }

        const isTemplatePlaceholder = (s: string): boolean => {
          // Liquid/Jinja/Handlebars/Mustache/JS template literals
          if (/^\s*\{\{[\s\S]*\}\}\s*$/.test(s)) return true
          if (/^\s*\{%[\s\S]*%\}\s*$/.test(s)) return true
          if (/^\s*\$\{[\s\S]*\}\s*$/.test(s)) return true
          // pattern composto da SOLO {{ }} segments (es. "{{a}} {{b}}")
          const stripped = s.replace(/\{\{[\s\S]*?\}\}/g, '').replace(/\{%[\s\S]*?%\}/g, '').trim()
          if (stripped.length === 0 && /\{\{|\{%/.test(s)) return true
          return false
        }

        const push = (params: {
          original_text: string
          raw_text: string
          tag_name: string
          full_tag: string
          attributes: string
          classes: string
          position: number
        }): void => {
          const cleaned = cleanText(params.original_text)
          if (cleaned.length < 2) return
          // Skip puro CSS/JS/HTML residuo
          if (/^[{};:|()<>=]+$/.test(cleaned)) return
          // Skip valori-segnaposto del page builder (es. data-text="text")
          if (isBuilderMarker(cleaned)) return
          // Skip placeholder template ({{...}}, {%...%}, ${...})
          if (isTemplatePlaceholder(cleaned)) return
          const key = `${cleaned}::${params.tag_name}::${params.position}`
          if (seen.has(key)) return
          seen.add(key)
          out.push({
            index: nextIdx++,
            original_text: cleaned,
            raw_text: params.raw_text || cleaned,
            tag_name: params.tag_name,
            full_tag: params.full_tag,
            attributes: params.attributes,
            classes: params.classes,
            position: params.position,
            processed: false,
          })
        }

        const parseAttrs = (attrStr: string): { attributes: string; classes: string } => {
          const cleanAttr = (attrStr || '').trim()
          const classMatch = cleanAttr.match(/class=["']([^"']+)["']/i)
          return {
            attributes: cleanAttr,
            classes: classMatch ? classMatch[1] : '',
          }
        }

        // 1. <title>
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
        if (titleMatch) {
          push({
            original_text: titleMatch[1],
            raw_text: titleMatch[1],
            tag_name: 'title',
            full_tag: '<title>',
            attributes: '',
            classes: '',
            position: titleMatch.index || 0,
          })
        }

        // 2. <meta name=description / og:* / twitter:*>
        const metaRegex = /<meta\s+([^>]*?)>/gi
        let metaMatch: RegExpExecArray | null
        while ((metaMatch = metaRegex.exec(html)) !== null) {
          const attrs = metaMatch[1]
          const contentMatch = attrs.match(/content=["']([^"']+)["']/i)
          if (!contentMatch) continue
          const httpEquivMatch = attrs.match(/http-equiv=/i)
          if (httpEquivMatch) continue
          const nameMatch = attrs.match(/name=["']([^"']+)["']/i)
          const propertyMatch = attrs.match(/property=["']([^"']+)["']/i)
          const key = (nameMatch?.[1] || propertyMatch?.[1] || '').toLowerCase()
          // whitelist meta che sono davvero copy
          const allowed = [
            'description',
            'og:title',
            'og:description',
            'og:site_name',
            'twitter:title',
            'twitter:description',
          ]
          if (!allowed.includes(key)) continue
          push({
            original_text: contentMatch[1],
            raw_text: contentMatch[1],
            tag_name: 'meta',
            full_tag: metaMatch[0],
            attributes: attrs,
            classes: '',
            position: metaMatch.index,
          })
        }

        // 3. Tag block-level semantici. Catturano sempre il loro testo (anche se
        // hanno figli inline come <strong>/<em>): il rebuild fa sort discendente
        // per length quindi il container vince sui figli inline.
        const semanticBlockTags = [
          'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'p', 'li', 'td', 'th', 'button', 'a', 'label',
          'span', 'strong', 'em', 'b', 'i', 'small', 'figcaption',
          'blockquote', 'summary', 'dt', 'dd', 'caption', 'cite', 'q', 'mark',
        ]
        for (const tag of semanticBlockTags) {
          const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi')
          let m: RegExpExecArray | null
          while ((m = re.exec(html)) !== null) {
            const attrStr = m[1] || ''
            const innerHtml = m[2] || ''
            if (/<(script|style)[\s>]/i.test(innerHtml)) continue
            const plainText = innerHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
            if (plainText.length < 2) continue
            const { attributes, classes } = parseAttrs(attrStr)
            push({
              original_text: plainText,
              raw_text: innerHtml.replace(/\s+/g, ' ').trim(),
              tag_name: tag,
              full_tag: `<${tag}${attrStr}>`,
              attributes,
              classes,
              position: m.index,
            })
          }
        }

        // 3b. Container generici (div/section/article/header/footer/nav/aside/main):
        // catturano SOLO se "leaf" (no tag figli). Se hanno figli, il loro testo è
        // già in altri tag (semantici o testo nudo) → evitiamo i duplicati che
        // gonfiano gli estratti senza aggiungere copy nuovo.
        const genericContainerTags = [
          'div', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'main',
        ]
        for (const tag of genericContainerTags) {
          const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi')
          let m: RegExpExecArray | null
          while ((m = re.exec(html)) !== null) {
            const attrStr = m[1] || ''
            const innerHtml = m[2] || ''
            // Skip se contiene altri tag (i figli sono già coperti)
            if (innerHtml.includes('<')) continue
            const plainText = innerHtml.replace(/\s+/g, ' ').trim()
            if (plainText.length < 2) continue
            const { attributes, classes } = parseAttrs(attrStr)
            push({
              original_text: plainText,
              raw_text: plainText,
              tag_name: tag,
              full_tag: `<${tag}${attrStr}>`,
              attributes,
              classes,
              position: m.index,
            })
          }
        }

        // 4. Attributi marketing-utili (alt, title, placeholder, aria-label,
        // data-text, data-content, data-title, data-tooltip)
        const attrRegex = /<(\w+)\b([^>]*?)\s(alt|title|placeholder|aria-label|data-text|data-content|data-title|data-tooltip)=["']([^"']{2,})["']([^>]*)>/gi
        let aMatch: RegExpExecArray | null
        while ((aMatch = attrRegex.exec(html)) !== null) {
          const tagName = aMatch[1].toLowerCase()
          const attrName = aMatch[3]
          const value = aMatch[4]
          const attrs = `${aMatch[2]} ${attrName}="${value}"${aMatch[5]}`
          const { classes } = parseAttrs(attrs)
          push({
            original_text: value,
            raw_text: value,
            tag_name: `${tagName}@${attrName}`,
            full_tag: aMatch[0],
            attributes: attrs.trim(),
            classes,
            position: aMatch.index,
          })
        }

        // 5. Input value (submit/button)
        const inputValRegex = /<input\b([^>]*?)\stype=["'](submit|button)["']([^>]*?)\svalue=["']([^"']+)["']([^>]*)>/gi
        let iMatch: RegExpExecArray | null
        while ((iMatch = inputValRegex.exec(html)) !== null) {
          push({
            original_text: iMatch[4],
            raw_text: iMatch[4],
            tag_name: `input@value`,
            full_tag: iMatch[0],
            attributes: `${iMatch[1]}${iMatch[3]}${iMatch[5]}`.trim(),
            classes: '',
            position: iMatch.index,
          })
        }

        // 6. <noscript> content (testi visibili ai bot/screen reader)
        const noscriptRegex = /<noscript[^>]*>([\s\S]*?)<\/noscript>/gi
        let nMatch: RegExpExecArray | null
        while ((nMatch = noscriptRegex.exec(html)) !== null) {
          const inner = nMatch[1]
          const plain = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
          if (plain.length < 2) continue
          push({
            original_text: plain,
            raw_text: inner.replace(/\s+/g, ' ').trim(),
            tag_name: 'noscript',
            full_tag: '<noscript>',
            attributes: '',
            classes: '',
            position: nMatch.index,
          })
        }

        // 7. JSON-LD: estrai stringhe semanticamente utili (name, description, headline, ecc.)
        const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
        let jMatch: RegExpExecArray | null
        while ((jMatch = jsonLdRegex.exec(html)) !== null) {
          try {
            const jsonData = JSON.parse(jMatch[1].trim())
            const usefulKeys = new Set([
              'name', 'description', 'headline', 'alternativename', 'disambiguatingdescription',
              'caption', 'text', 'abstract', 'review', 'reviewbody', 'comment',
              'slogan', 'keywords', 'genre', 'category',
            ])
            const visit = (obj: any, path: string = ''): void => {
              if (typeof obj === 'string') {
                if (obj.length >= 3 && obj.length < 1000 && /[a-zA-ZàèéìòùÀÈÉÌÒÙ]/.test(obj) && !/^https?:\/\//.test(obj)) {
                  const lastKey = path.split('.').pop()?.toLowerCase() || ''
                  if (usefulKeys.has(lastKey)) {
                    push({
                      original_text: obj,
                      raw_text: obj,
                      tag_name: `jsonld:${lastKey}`,
                      full_tag: `<script type="application/ld+json">`,
                      attributes: '',
                      classes: '',
                      position: jMatch!.index,
                    })
                  }
                }
              } else if (Array.isArray(obj)) {
                obj.forEach((item, i) => visit(item, `${path}[${i}]`))
              } else if (obj && typeof obj === 'object') {
                Object.entries(obj).forEach(([k, v]) => visit(v, path ? `${path}.${k}` : k))
              }
            }
            visit(jsonData)
          } catch {}
        }

        // 7.5 SPA framework JSON inline (Next.js __NEXT_DATA__, Nuxt __NUXT__,
        // SvelteKit __sveltekit_data, Remix __remixContext, plus qualsiasi
        // <script type="application/json">). Per SPA che non hanno SSR
        // dei tag visibili (Bioma quiz, Typeform-like, ecc.) i testi reali
        // (domande, opzioni, label bottoni, headline) vivono solo qui.
        const spaJsonRegex = /<script\b([^>]*?)\stype=["']application\/json["']([^>]*)>([\s\S]*?)<\/script>/gi
        const usefulKeysSpa = new Set([
          'title', 'subtitle', 'heading', 'subheading', 'headline', 'tagline',
          'label', 'text', 'content', 'body', 'message', 'description',
          'placeholder', 'value', 'name', 'caption', 'copy', 'note', 'helptext',
          'question', 'questions', 'answer', 'answers', 'option', 'options',
          'choice', 'choices', 'button', 'buttontext', 'cta', 'ctatext',
          'submitlabel', 'nextlabel', 'backlabel', 'errormessage',
          'hero', 'subhero', 'benefit', 'benefits', 'feature', 'features',
          'testimonial', 'testimonials', 'faq', 'question_text', 'answer_text',
          'price', 'pricelabel', 'discount', 'badge', 'tag', 'eyebrow',
          'disclaimer', 'footer', 'legal',
        ])
        const blacklistKeysSpa = new Set([
          'id', 'key', '_id', 'uid', 'guid', 'slug', 'href', 'url', 'src',
          'image', 'imageurl', 'imagesrc', 'asset', 'avatar', 'icon', 'iconname',
          'type', 'kind', 'variant', 'classname', 'classnames', 'tag_name',
          'color', 'bgcolor', 'fontfamily', 'fontsize', 'theme',
          'aspath', 'path', 'route', 'pathname', 'search', 'query', 'querystring',
          'token', 'csrftoken', 'apikey', 'sessionid', 'visitorid',
          'event', 'eventname', 'analyticsid', 'gtmid', 'pixelid',
          'lang', 'locale', 'language', 'timezone', 'currency', 'country',
          'createdat', 'updatedat', 'timestamp', 'expiresat', 'date',
          'width', 'height', 'size', 'maxlength', 'minlength', 'min', 'max',
          'order', 'position', 'index', 'ordinal', 'step', 'count',
          'enabled', 'disabled', 'visible', 'hidden', 'required', 'active',
          'mime', 'mimetype', 'format', 'encoding', 'extension',
        ])
        const looksLikeCode = (s: string): boolean => {
          if (/^https?:\/\//i.test(s)) return true
          if (/^data:[a-z]+\//i.test(s)) return true
          if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s)) return true
          if (/^#[0-9a-f]{3,8}$/i.test(s)) return true
          if (/^[a-z][a-z0-9_-]{0,40}$/i.test(s) && s.length < 25 && !/\s/.test(s)) return true
          if (/^[A-Z_]+$/.test(s) && s.length < 30) return true
          if (/\{\{|\$\{|\bvar\b|\bfunction\b|\breturn\b|=>|\bconst\b|\blet\b/.test(s)) return true
          if (/^[\d.,\s%/()\-+*=<>!?]+$/.test(s)) return true
          return false
        }
        const isHumanText = (s: string): boolean => {
          if (s.length < 3 || s.length > 800) return false
          const letters = s.match(/[a-zA-ZàèéìòùÀÈÉÌÒÙáéíóúÁÉÍÓÚñÑ]/g)?.length || 0
          if (letters < 3) return false
          if (letters / s.length < 0.4) return false
          const words = s.trim().split(/\s+/)
          if (words.length === 1 && s.length < 4) return false
          return true
        }
        let spaMatch: RegExpExecArray | null
        while ((spaMatch = spaJsonRegex.exec(html)) !== null) {
          const rawJson = spaMatch[3].trim()
          if (rawJson.length < 50) continue
          let parsed: any
          try {
            parsed = JSON.parse(rawJson)
          } catch {
            continue
          }
          const seenInThisScript = new Set<string>()
          const visitSpa = (node: any, parentKey: string, depth: number): void => {
            if (depth > 25) return
            if (node === null || node === undefined) return
            if (typeof node === 'string') {
              const lkey = parentKey.toLowerCase()
              if (blacklistKeysSpa.has(lkey)) return
              if (lkey.endsWith('id') || lkey.endsWith('url') || lkey.endsWith('src') || lkey.endsWith('href') || lkey.endsWith('class')) return
              const trimmed = node.trim()
              if (!isHumanText(trimmed)) return
              if (looksLikeCode(trimmed)) return
              const useful = usefulKeysSpa.has(lkey) ||
                /text|label|title|content|copy|description|question|answer|option|button|cta|message|hero|head/i.test(parentKey)
              if (!useful) {
                if (trimmed.length < 12 || !/\s/.test(trimmed)) return
              }
              const dedupeKey = `${lkey}::${trimmed}`
              if (seenInThisScript.has(dedupeKey)) return
              seenInThisScript.add(dedupeKey)
              push({
                original_text: trimmed,
                raw_text: trimmed,
                tag_name: `spa-json:${lkey || 'value'}`,
                full_tag: '<script type="application/json">',
                attributes: '',
                classes: '',
                position: spaMatch!.index,
              })
            } else if (Array.isArray(node)) {
              for (const item of node) visitSpa(item, parentKey, depth + 1)
            } else if (typeof node === 'object') {
              for (const [k, v] of Object.entries(node)) visitSpa(v, k, depth + 1)
            }
          }
          visitSpa(parsed, '', 0)
        }

        // 8. Text nodes "nudi" tra tag chiusura e prossimo tag.
        // Cattura es. `<br>Bonus testo<br>` o testi diretti dentro contenitori non
        // catturati altrimenti. Filtro pesante per evitare CSS/JS residuo.
        // PRIMA: strippa <script>, <style>, <!--...--> e JSON-LD per evitare di
        // catturare codice/CSS/json come fosse copy.
        const htmlForTextNodes = html
          .replace(/<script\b[\s\S]*?<\/script>/gi, '')
          .replace(/<style\b[\s\S]*?<\/style>/gi, '')
          .replace(/<!--[\s\S]*?-->/g, '')
        const textNodeRegex = />([^<>{}\n]{4,300})</g
        let tMatch: RegExpExecArray | null
        while ((tMatch = textNodeRegex.exec(htmlForTextNodes)) !== null) {
          const content = tMatch[1]
          const trimmed = content.trim()
          if (trimmed.length < 4) continue
          // Skip se sembra puro CSS, codice, o numeri/simboli
          if (/^[\s\d.,;:|()\-+*/=<>!?@#%^&]+$/.test(trimmed)) continue
          if (/^[a-zA-Z_-]+\s*:\s*[^;]+;?$/.test(trimmed)) continue // CSS rule
          if (!/[a-zA-ZàèéìòùÀÈÉÌÒÙ]{2,}/.test(trimmed)) continue // serve almeno 2 lettere
          push({
            original_text: trimmed,
            raw_text: content,
            tag_name: 'text-node',
            full_tag: '',
            attributes: '',
            classes: '',
            position: tMatch.index,
          })
        }

        return out
      }

      const htmlExtracted = extractTextsFromHTML(originalHTML)

      // === ESTRAI STRINGHE DAI BUNDLE JS NEXT.JS / SPA ===
      // Per quiz/funnel CSR puro (es. Bioma Health) i testi sono hardcoded
      // dentro i bundle JS Webpack di Next.js. __NEXT_DATA__ è quasi vuoto e
      // l'HTML è solo lo shell. Scarichiamo i bundle referenziati e estraiamo
      // stringhe "umane" (frase con maiuscola+spazi+lettere). Verranno
      // riscritte come testi normali e poi inline-ate nell'HTML al posto
      // del <script src="..."> originale (vedi blocco "INLINE BUNDLE JS"
      // nella fase PROCESS).
      const bundleScriptRegex = /<script\b[^>]*\bsrc=["']([^"']*\/_next\/static\/chunks\/[^"']+\.js[^"']*)["'][^>]*>/gi
      const bundleUrls = new Set<string>()
      let bsMatch: RegExpExecArray | null
      while ((bsMatch = bundleScriptRegex.exec(originalHTML)) !== null) {
        const src = bsMatch[1]
        // Whitelist: solo bundle delle pagine specifiche (es. pages/[funnel]/quiz-HASH.js).
        // Skippa main, webpack, polyfills, framework, runtime, _app, _document, _error
        // perché contengono runtime Next.js (error messages, system text) e non
        // testi specifici della pagina che vogliamo riscrivere.
        const isPageBundle = /\/_next\/static\/chunks\/pages\//.test(src)
        const isFrameworkBundle = /\/(?:main|webpack|polyfills|framework|runtime)[-.]/i.test(src) ||
          /\/pages\/_(?:app|document|error|middleware)/.test(src)
        if (!isPageBundle || isFrameworkBundle) continue
        let absUrl: string
        try {
          absUrl = new URL(src, url).href
        } catch {
          continue
        }
        bundleUrls.add(absUrl)
      }

      const bundleExtracted: ExtractedTextRow[] = []
      if (bundleUrls.size > 0) {
        console.log(`📦 BUNDLE: trovati ${bundleUrls.size} script Next.js. Scarico per estrazione testi...`)
        const fetchPromises = Array.from(bundleUrls).slice(0, 8).map(async (bundleUrl) => {
          try {
            const ctrl = new AbortController()
            const timeoutId = setTimeout(() => ctrl.abort(), 15000)
            const r = await fetch(bundleUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Compatible; FunnelSwap/1.0)' },
              signal: ctrl.signal,
            })
            clearTimeout(timeoutId)
            if (!r.ok) {
              console.warn(`  ⚠️ ${bundleUrl}: HTTP ${r.status}`)
              return
            }
            const js = await r.text()
            if (js.length > 5_000_000) {
              console.warn(`  ⚠️ ${bundleUrl}: troppo grande (${js.length}b), skip`)
              return
            }
            const seen = new Set<string>()
            // Match string literals: "text" 'text' `text` (escape-aware-ish)
            const stringRegex = /(["'`])((?:\\.|(?!\1)[^\\])*?)\1/g
            let sMatch: RegExpExecArray | null
            let kept = 0
            while ((sMatch = stringRegex.exec(js)) !== null) {
              const s = sMatch[2]
              if (s.length < 10 || s.length > 280) continue
              if (!/[A-Za-z]/.test(s.charAt(0))) continue
              if (!/\s/.test(s)) continue
              if (!/[a-zA-Z]{3,}\s+[a-zA-Z]{2,}/.test(s)) continue
              if (/[<>{}\\=;|]/.test(s)) continue
              if (/^https?:\/\//i.test(s)) continue
              if (/\.(js|css|png|jpe?g|svg|webp|woff2?|ttf|json)(\?|$)/i.test(s)) continue
              if (s.includes('node_modules')) continue
              if (s.includes('webpack')) continue
              if (/^[A-Z_][A-Z0-9_]+$/.test(s)) continue
              if (/^[a-z]+([A-Z][a-z]+){2,}$/.test(s) && !s.includes(' ')) continue
              if (seen.has(s)) continue
              seen.add(s)
              bundleExtracted.push({
                original_text: s,
                raw_text: s,
                tag_name: 'js-bundle',
                full_tag: `<script src="${bundleUrl.substring(bundleUrl.lastIndexOf('/'))}">`,
                attributes: bundleUrl,
                classes: '',
                position: 90000 + bundleExtracted.length,
              })
              kept++
            }
            console.log(`  📦 ${bundleUrl.substring(bundleUrl.lastIndexOf('/'))}: ${kept} stringhe estratte (size=${js.length}b)`)
          } catch (e) {
            console.warn(`  ⚠️ Errore scarico bundle ${bundleUrl}:`, (e as Error).message)
          }
        })
        await Promise.all(fetchPromises)
        console.log(`📦 BUNDLE: estratti ${bundleExtracted.length} testi unici dai ${bundleUrls.size} bundle JS`)
      }

      const rawExtracted = [...htmlExtracted, ...bundleExtracted]

      // Post-pass: dedupe `tag@attr` redundancies.
      // Es: `<button data-text="Buy">Buy</button>` produce sia `tag_name='button'`
      // che `tag_name='button@data-text'` con lo stesso testo. Teniamo solo quello
      // del tag base (più affidabile per il replace).
      const baseSeenAtPos = new Map<number, Set<string>>()
      for (const r of rawExtracted) {
        if (!r.tag_name.includes('@')) {
          const set = baseSeenAtPos.get(r.position) || new Set<string>()
          set.add(r.original_text)
          baseSeenAtPos.set(r.position, set)
        }
      }

      // Globalmente: skip text-node se quel testo appare già altrove (qualunque tag).
      // I text-node sono catch-all volutamente loose, va bene perderli quando ridondanti.
      const allTextsExceptNodes = new Set<string>()
      for (const r of rawExtracted) {
        if (r.tag_name !== 'text-node') allTextsExceptNodes.add(r.original_text)
      }

      const extractedRows = rawExtracted
        .filter(r => {
          if (r.tag_name === 'text-node') {
            return !allTextsExceptNodes.has(r.original_text)
          }
          if (r.tag_name.includes('@')) {
            const set = baseSeenAtPos.get(r.position)
            return !(set && set.has(r.original_text))
          }
          return true
        })
        .map((r, i) => ({ ...r, index: i }))

      console.log(
        `✅ Estratti ${extractedRows.length} testi unici dall'HTML ` +
        `(prima del dedupe: ${rawExtracted.length})`
      )

      if (extractedRows.length === 0) {
        const isJsOnly = htmlSource === 'fetch' && originalHTML.length < 30000 &&
          /<div[^>]*\bid=["'](root|app|__next|main)["']/i.test(originalHTML)
        const detail = isJsOnly
          ? `La pagina sembra essere un'app JavaScript (SPA): l'HTML grezzo (${originalHTML.length} char) contiene solo lo scheletro. Il client deve pre-renderizzarla con Playwright e passare il risultato come "renderedHtml". Per quiz/funnel JS-only assicurati di clonare prima con cloneMode=identical e keepScripts=true.`
          : `HTML ricevuto: ${originalHTML.length} char (source=${htmlSource}). Estratti raw=${rawExtracted.length} unici=0. Probabile pagina vuota o template senza contenuto testuale.`
        return new Response(
          JSON.stringify({
            error: `Nessun testo estraibile dall'HTML del competitor. ${detail}`,
            htmlLength: originalHTML.length,
            htmlSource,
            isJsOnly,
          }),
          { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // STEP 3: Crea il job in cloning_jobs.
      // If a Project brief is provided, append it to product_description so
      // it travels with the job and gets injected into the Claude prompt
      // later (see batch processing). The DB column stays the same.
      const briefBlock =
        typeof brief === 'string' && brief.trim()
          ? `\n\n---\n📚 BRIEF DEL PROGETTO (fonte di verità per tono, posizionamento e value props):\n${brief.trim()}`
          : ''
      const productDescriptionWithBrief =
        (productDescription || '') + briefBlock

      const { data: insertedJob, error: jobInsertError } = await supabase
        .from('cloning_jobs')
        .insert({
          user_id: userId,
          url,
          clone_mode: cloneMode,
          original_html: originalHTML,
          product_name: productName,
          product_description: productDescriptionWithBrief,
          framework: framework || null,
          target: target || null,
          custom_prompt: customPrompt || null,
          output_format: outputFormat || 'html',
          categoria: categoria || null,
          price_full: priceFull || null,
          price_discounted: priceDiscounted || null,
          status: 'extracting',
        })
        .select('id')
        .single()

      if (jobInsertError || !insertedJob) {
        console.error('❌ Errore insert cloning_jobs:', jobInsertError)
        return new Response(
          JSON.stringify({
            error: `Errore creazione job: ${jobInsertError?.message || 'unknown'}`,
            details: jobInsertError,
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const newJobId = insertedJob.id

      // STEP 4: Insert testi in batch (Postgres ha un limite, splittiamo in chunk da 200)
      const TEXT_INSERT_CHUNK = 200
      let insertedCount = 0
      for (let i = 0; i < extractedRows.length; i += TEXT_INSERT_CHUNK) {
        const slice = extractedRows.slice(i, i + TEXT_INSERT_CHUNK).map(r => ({
          job_id: newJobId,
          index: r.index,
          original_text: r.original_text,
          raw_text: r.raw_text,
          tag_name: r.tag_name,
          full_tag: r.full_tag,
          attributes: r.attributes,
          classes: r.classes,
          context: r.tag_name,
          position: r.position,
          processed: false,
        }))
        const { error: textsInsertError } = await supabase.from('cloning_texts').insert(slice)
        if (textsInsertError) {
          console.error(`❌ Errore insert cloning_texts (chunk ${i}):`, textsInsertError)
          // rollback job
          await supabase.from('cloning_jobs').update({ status: 'failed' }).eq('id', newJobId)
          return new Response(
            JSON.stringify({
              error: `Errore salvataggio testi: ${textsInsertError.message}`,
              details: textsInsertError,
            }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        insertedCount += slice.length
      }

      // STEP 5: Aggiorna job a stato 'processing'
      await supabase
        .from('cloning_jobs')
        .update({ status: 'processing', total_texts: insertedCount })
        .eq('id', newJobId)

      console.log(`✅ Job ${newJobId} creato con ${insertedCount} testi pronti per il batch processing`)

      return new Response(
        JSON.stringify({
          success: true,
          jobId: newJobId,
          totalTexts: insertedCount,
          phase: 'extracted',
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // MODALITÀ TRANSLATE
    if (cloneMode === 'translate') {
      console.log(`🌍 MODALITÀ TRANSLATE: Traduzione HTML in ${targetLanguage}`)

      if (!htmlContent || !targetLanguage) {
        return new Response(
          JSON.stringify({ error: 'Missing required fields for translate mode: htmlContent, targetLanguage' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      if (!userId) {
        return new Response(
          JSON.stringify({ error: 'Missing required field: userId' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const { data: userProfile, error: profileError } = await supabase
        .from('user_profiles')
        .select('anthropic_api_key')
        .eq('id', userId)
        .single()

      if (profileError || !userProfile?.anthropic_api_key) {
        return new Response(
          JSON.stringify({ error: 'API Key Anthropic non configurata per questo utente' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // ... (full translate implementation in deployed version)
      
      return new Response(
        JSON.stringify({ error: 'See deployed Edge Function for full translate implementation' }),
        { status: 501, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // MODALITÀ SINCRONA (retrocompatibilità)
    console.log('🔄 MODALITÀ SINCRONA: processamento immediato')
    
    if (!url) {
      return new Response(
        JSON.stringify({ error: 'Missing required field: url' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (cloneMode === 'rewrite' && (!productName || !productDescription)) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields for rewrite mode: productName, productDescription' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { data: userProfile, error: profileError } = await supabase
      .from('user_profiles')
      .select('anthropic_api_key, screenshotone_access_key, screenshotone_secret_key')
      .eq('id', userId)
      .single()

    if (profileError || !userProfile?.anthropic_api_key) {
      return new Response(
        JSON.stringify({ error: 'API Key Anthropic non configurata per questo utente' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    let originalHTML = ''
    try {
      const htmlResponse = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      })

      if (!htmlResponse.ok) {
        throw new Error(`Failed to fetch HTML: ${htmlResponse.status} ${htmlResponse.statusText}`)
      }

      originalHTML = await htmlResponse.text()
      console.log(`✅ HTML fetched, size: ${originalHTML.length} characters`)
    } catch (error) {
      console.error('❌ Error fetching HTML:', error)
      return new Response(
        JSON.stringify({ error: `Errore scaricamento HTML: ${error.message}. Verifica che l'URL sia accessibile pubblicamente.` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (cloneMode === 'identical') {
      console.log('📋 Modalità IDENTICAL: restituisco HTML originale senza modifiche')
      return new Response(
        JSON.stringify({
          success: true,
          content: originalHTML,
          format: outputFormat || 'html',
          mode: 'identical',
          originalSize: originalHTML.length
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // MODALITÀ REWRITE sincrona - full implementation in deployed version
    // ... (extracts texts, calls Claude one-by-one, replaces in HTML)
    
    return new Response(
      JSON.stringify({ error: 'See deployed Edge Function for full sync rewrite implementation' }),
      { status: 501, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('❌ Error in clone-competitor function:', error)
    console.error('❌ Error stack:', error.stack)
    
    const errorMessage = error.message || 'Errore sconosciuto durante la clonazione'
    const errorDetails = error.stack ? `\nDettagli: ${error.stack.substring(0, 500)}` : ''
    
    return new Response(
      JSON.stringify({ 
        error: `Errore nella funzione clone-competitor: ${errorMessage}${errorDetails}`,
        errorType: error.name || 'UnknownError'
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
