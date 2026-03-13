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

function replaceBrandInTextContent(
  html: string,
  originalUrl: string,
  originalHtml: string,
  productName: string
): string {
  if (!productName || !originalUrl) return html

  const brandsToReplace: string[] = []

  try {
    const urlObj = new URL(originalUrl)
    const domain = urlObj.hostname.replace(/^www\./, '').split('.')[0]
    if (domain && domain.length > 3) {
      brandsToReplace.push(domain)
      brandsToReplace.push(domain.charAt(0).toUpperCase() + domain.slice(1))
    }
  } catch {}

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

  const uniqueBrands = [...new Set(brandsToReplace)]
    .filter(b => b.length > 3 && b.toLowerCase() !== productName.toLowerCase())
    .sort((a, b) => b.length - a.length)

  if (uniqueBrands.length === 0) return html

  console.log(`🏷️ Brand post-processing: [${uniqueBrands.join(', ')}] → "${productName}"`)
  const htmlParts = html.split(/(<[^>]+>)/)
  for (let i = 0; i < htmlParts.length; i++) {
    if (!htmlParts[i].startsWith('<')) {
      for (const brand of uniqueBrands) {
        const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        htmlParts[i] = htmlParts[i].replace(new RegExp(escaped, 'gi'), productName)
      }
    }
  }
  return htmlParts.join('')
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
      userId,
      htmlContent,
      targetLanguage,
      renderedHtml // Pre-rendered HTML from Playwright (sent by Next.js API for JS-rendered pages)
    } = await req.json()

    console.log(`📋 Richiesta ricevuta: phase=${phase}, cloneMode=${cloneMode}, url=${url?.substring(0, 50)}...`)

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
        .select('*, cloning_texts(*)')
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

      const BATCH_SIZE = 10
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
            report: reportData
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
      
      const rewritePrompt = `La landing page è un TEMPLATE strutturale. Il tuo compito è riscrivere TUTTI i testi usando SOLO le informazioni del nuovo prodotto.

📋 INFORMAZIONI DEL NUOVO PRODOTTO (USA SOLO QUESTE):
Nome prodotto: ${job.product_name}
Descrizione prodotto: ${job.product_description}
${job.framework ? `Framework copywriting: ${job.framework}` : ''}
${job.target ? `Target audience: ${job.target}` : ''}
${job.custom_prompt ? `Istruzioni copy personalizzate: ${job.custom_prompt}` : ''}

🎯 COSA DEVI FARE:
- I testi originali sono SOLO per capire: lunghezza approssimativa, tipo di testo (titolo/bottone/descrizione), formattazione
- IGNORA completamente il contenuto dei testi originali - NON copiare NESSUNA parola dal testo originale
- CREA nuovi testi da zero usando SOLO: nome prodotto, descrizione, framework, istruzioni copy
- Ogni testo deve parlare SOLO del nuovo prodotto "${job.product_name}"
- Se il testo originale contiene &nbsp; o spazi all'inizio, mantieni la stessa formattazione ma riscrivi TUTTO il contenuto DOPO &nbsp; usando SOLO le informazioni del nuovo prodotto
- IMPORTANTE: Riscrivi TUTTO il testo dopo &nbsp; con testo completamente nuovo adattato al prodotto - non lasciare parti del testo originale

📐 FORMATTAZIONE HTML OBBLIGATORIA:
- Se il testo originale è LUNGO (più di 100 caratteri), DEVI formattarlo con tag HTML
- Usa <p>...</p> per separare i paragrafi (ogni 2-3 frasi)
- Usa <strong>...</strong> per parole/frasi importanti da evidenziare
- Usa <br> per andare a capo quando serve
- NON creare muri di testo - dividi SEMPRE in paragrafi leggibili
- Per testi CORTI (titoli, bottoni, meno di 100 caratteri): NON usare tag HTML

⚠️ REGOLE CRITICHE:
- NON mescolare lingue diverse nello stesso testo
- Se il testo originale è in inglese, scrivi tutto in inglese
- Se il testo originale è in italiano, scrivi tutto in italiano
- NON copiare NESSUNA parola dal testo originale - riscrivi tutto da zero
- Se trovi nomi di brand, aziende o siti web del competitor nel testo originale, sostituiscili SEMPRE con "${job.product_name}"
${detectedBrand ? `- ATTENZIONE: il brand originale è probabilmente "${detectedBrand}" - sostituisci OGNI sua occorrenza con "${job.product_name}"` : ''}

📝 TESTI DA RISCRIVERE (usa solo per capire lunghezza/tipo/formattazione - IGNORA completamente il contenuto):
${JSON.stringify(batchTexts, null, 2)}

${needsItalianTranslation ? '\n🇮🇹 TRADUZIONE OBBLIGATORIA:\n- Scrivi TUTTI i testi in italiano\n- Traduci ogni parola inglese o straniera\n- Se è misto italiano/inglese, traduci TUTTO in italiano' : ''}

RESTITUISCI SOLO JSON ARRAY (stesso ordine):
[{"index": 0, "text": "testo riscritto per il nuovo prodotto"}, ...]`

      let claudeResponse
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 60000)
      
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
            max_tokens: 6000,
            temperature: 0.6,
            messages: [{ role: 'user', content: rewritePrompt }]
          }),
          signal: controller.signal
        })
        
        clearTimeout(timeoutId)
      } catch (fetchError) {
        clearTimeout(timeoutId)
        if (fetchError.name === 'AbortError' || controller.signal.aborted) {
          return new Response(
            JSON.stringify({ error: 'Timeout chiamata Claude API (60s). Ridurre batch size o verificare connessione.' }),
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
        
        console.log(`\n✅ BATCH ${batchNumber + 1} - TESTI RISCRITTI DA CLAUDE (${rewrittenTexts.length} testi):`)
        rewrittenTexts.forEach((t, idx) => {
          const original = batchTexts.find(b => b.index === t.index)
          console.log(`  [${idx + 1}] Index: ${t.index}`)
          console.log(`      ORIGINALE: "${original?.text.substring(0, 80)}${original?.text.length > 80 ? '...' : ''}"`)
          console.log(`      RISCRITTO: "${t.text.substring(0, 80)}${t.text.length > 80 ? '...' : ''}"`)
          console.log(`      CAMBIATO: ${original?.text !== t.text ? '✅ SÌ' : '❌ NO'}`)
        })
        console.log(`\n`)
        
      } catch (parseError) {
        console.error('❌ Errore parsing risposta Claude:', parseError)
        console.error('Risposta raw (primi 500 caratteri):', claudeData.content[0].text.substring(0, 500))
        
        console.warn('⚠️ Usando testi originali come fallback per questo batch')
        rewrittenTexts = textsToProcess.map(t => ({
          index: t.index,
          text: t.original_text
        }))
      }

      for (const rewritten of rewrittenTexts) {
        const originalText = textsToProcess.find(t => t.index === rewritten.index)
        if (originalText) {
          await supabase
            .from('cloning_texts')
            .update({
              new_text: rewritten.text,
              processed: true,
              processed_at: new Date().toISOString()
            })
            .eq('id', originalText.id)
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
            report: { totalTexts: allProcessedTexts.length, replaced: replacementCount }
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
          continue: true
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

      // STEP 1: Get HTML - use pre-rendered HTML from Playwright if available, otherwise fetch
      let originalHTML = ''
      if (renderedHtml && typeof renderedHtml === 'string' && renderedHtml.length > 100) {
        // Pre-rendered by Playwright (handles JS-rendered pages)
        console.log(`📥 STEP 1: Using pre-rendered HTML from Playwright (${renderedHtml.length} chars)`)
        originalHTML = renderedHtml
          .replace(/"\s*==\s*\$\d+/g, '"')
          .replace(/\s*==\s*\$\d+/g, '')
      } else {
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
        } catch (error) {
          console.error('❌ Error fetching HTML:', error)
          return new Response(
            JSON.stringify({ error: `Errore scaricamento HTML: ${error.message}. Verifica che l'URL sia accessibile pubblicamente.` }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
      }

      // NOTE: The full extractTextsFromHTML function is very long.
      // In production, this file contains the complete text extraction logic
      // with all patterns for h1-h6, p, button, a, label, li, span, td, th, 
      // strong, em, b, i, div, etc. plus attribute extraction (alt, title, placeholder, aria-label)
      // and fragment extraction for nested tags.
      // The function is identical to what's deployed on Supabase Edge Functions.
      
      // For the full implementation, see the deployed Edge Function on Supabase Dashboard.
      // This file serves as a reference/backup of the complete function code.
      
      console.log(`📥 HTML originale ricevuto, dimensione: ${originalHTML.length} caratteri`)
      // extractedTexts = extractTextsFromHTML(originalHTML) — full implementation in deployed version

      // ... (rest of extract phase - creates job, saves texts, returns jobId)
      
      return new Response(
        JSON.stringify({ error: 'See deployed Edge Function for full extract implementation' }),
        { status: 501, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
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
