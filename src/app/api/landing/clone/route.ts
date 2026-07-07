import { NextRequest, NextResponse } from 'next/server';
import { inlineExternalAssets } from '@/lib/inline-assets';
import { fetchHtmlSmart } from '@/lib/fetch-html-smart';
import {
  absolutizeUrlsInHtml,
  injectNoReferrerAndEagerLoading,
} from '@/lib/spa-rescue';
import { detectDynamicScripts } from '@/lib/detect-dynamic-scripts';
import { neutralizeRocketLoader } from '@/lib/neutralize-rocket-loader';

type ScriptsMode = 'auto' | 'keep' | 'strip';

/**
 * Resolve the effective scripts mode + whether scripts should be kept.
 *
 * Precedence:
 *   1. explicit `scripts_mode` ('auto' | 'keep' | 'strip')
 *   2. legacy boolean `remove_scripts` (true → strip, false → keep)
 *   3. default → 'strip' (historic behaviour for callers that pass nothing)
 *
 * In 'auto' mode we KEEP scripts only when the page builds visible content
 * client-side (fake live chat / comments, viewer counter, countdown, …),
 * detected by detectDynamicScripts. Plain pages whose only scripts are
 * analytics/pixels are stripped as before.
 */
function resolveScriptsDecision(
  html: string,
  scriptsMode: ScriptsMode | undefined,
  removeScripts: boolean | undefined,
): { mode: ScriptsMode; keep: boolean; detected: boolean; signals: string[] } {
  let mode: ScriptsMode;
  if (scriptsMode === 'auto' || scriptsMode === 'keep' || scriptsMode === 'strip') {
    mode = scriptsMode;
  } else if (removeScripts === false) {
    mode = 'keep';
  } else if (removeScripts === true) {
    mode = 'strip';
  } else {
    mode = 'strip';
  }

  if (mode === 'keep') return { mode, keep: true, detected: false, signals: [] };
  if (mode === 'strip') return { mode, keep: false, detected: false, signals: [] };

  const det = detectDynamicScripts(html);
  return { mode, keep: det.functional, detected: det.functional, signals: det.signals };
}

export const maxDuration = 60;

// `fixClonedHtml` storico era una funzione locale con regex che
// operavano sull'INTERO HTML, incluso il contenuto dei <script>. Per
// le SPA (Vite/React/Replit) questo significa: stringhe JS letterali
// tipo `'<img src="/x">'` o `'url(/y)'` dentro un <script> inline
// venivano modificate -> bundle a runtime corrotto -> pagina rotta
// PRIMA ANCORA del rewrite LLM. Ora deleghiamo a:
//   - `absolutizeUrlsInHtml`: regex per-tag specifiche (<img\b[^>]*src=)
//     -> non matcha stringhe dentro <script>.
//   - `injectNoReferrerAndEagerLoading`: estrae <script>/<noscript> in
//     placeholder, applica le regex, reinserisce, idempotente.
function fixClonedHtml(html: string, sourceUrl: string): string {
  return injectNoReferrerAndEagerLoading(absolutizeUrlsInHtml(html, sourceUrl));
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, remove_scripts, scripts_mode } = body as {
      url?: string;
      remove_scripts?: boolean;
      scripts_mode?: ScriptsMode;
    };

    if (!url) {
      return NextResponse.json({ success: false, error: 'URL is required' }, { status: 400 });
    }

    try { new URL(url); } catch {
      return NextResponse.json({ success: false, error: 'Invalid URL format' }, { status: 400 });
    }

    const start = Date.now();

    // Smart fetch: plain fetch → SPA detection → Playwright → Jina.
    // Same helper used by every other clone/swipe/audit code path so
    // OpenClaw inherits SPA support automatically (it just hits this
    // route internally).
    const fetched = await fetchHtmlSmart(url, {
      mode: 'full',
      fetchTimeoutMs: 20000,
      playwrightTimeoutMs: 30000,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    // Surface SPA-related diagnostics directly in the JSON response.
    // We can't rely on console.log on Netlify because the function
    // sometimes terminates before stdout is flushed — so we ship the
    // full picture as response fields. Same shape on success and error
    // so OpenClaw / curl / the diagnose modal can introspect either.
    const spaPlaywrightAttempt = fetched.attempts.find((a) => a.startsWith('playwright')) ?? null;
    const spaJinaAttempt = fetched.attempts.find((a) => a.startsWith('jina')) ?? null;
    const env = {
      NETLIFY: process.env.NETLIFY ?? null,
      VERCEL: process.env.VERCEL ?? null,
      AWS_LAMBDA_FUNCTION_NAME: process.env.AWS_LAMBDA_FUNCTION_NAME ?? null,
      isServerless:
        !!process.env.VERCEL ||
        !!process.env.AWS_LAMBDA_FUNCTION_NAME ||
        (!!process.env.NETLIFY &&
          !process.env.NETLIFY_LOCAL &&
          !process.env.NETLIFY_DEV),
    };
    if (!fetched.ok || !fetched.html) {
      return NextResponse.json(
        {
          success: false,
          error: `Unable to clone the page: ${fetched.error ?? 'no HTML returned'}`,
          attempts: fetched.attempts,
          spa_detected: fetched.wasSpa,
          spa_attempted: spaPlaywrightAttempt !== null,
          spa_playwright_result: spaPlaywrightAttempt,
          spa_jina_result: spaJinaAttempt,
          env,
        },
        { status: 400 },
      );
    }
    let html = fetched.html;
    const duration = (Date.now() - start) / 1000;

    // Decide whether to keep the original <script> tags. In 'auto' mode we
    // sniff the page for content-generating scripts (live chat, counters,
    // countdown, …) so pages like live-stream VSLs clone faithfully while
    // ordinary pages stay script-free. See resolveScriptsDecision above.
    const scriptsDecision = resolveScriptsDecision(html, scripts_mode, remove_scripts);
    let rocketRestored = 0;
    let rocketLoaderRemoved = false;
    if (!scriptsDecision.keep) {
      html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    } else {
      // When we keep scripts, undo Cloudflare Rocket Loader so the page's
      // inline scripts (live chat/comments engine, counters, countdown)
      // actually execute on the cloned origin. Otherwise the loader 404s and
      // nothing runs — the classic "comments section never populates" bug.
      const neutralized = neutralizeRocketLoader(html);
      html = neutralized.html;
      rocketRestored = neutralized.restored;
      rocketLoaderRemoved = neutralized.loaderRemoved;
    }

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : '';

    const cleanHtml = fixClonedHtml(html, url);
    // Inline external stylesheets + fonts so the snapshot is self-contained
    // and survives source-side changes (CDN rotation, server outage, CORS).
    // See src/lib/inline-assets.ts.
    const selfContainedHtml = await inlineExternalAssets(cleanHtml, url);

    return NextResponse.json({
      success: true,
      url,
      method_used: fetched.source ?? 'direct-fetch',
      was_spa: fetched.wasSpa,
      // Explicit SPA-flow diagnostics (mirrors the error branch above).
      // Lets the caller see WHICH stage of the cascade ran without
      // having to read Netlify Function logs.
      spa_detected: fetched.wasSpa,
      spa_attempted: spaPlaywrightAttempt !== null,
      spa_playwright_result: spaPlaywrightAttempt,
      spa_jina_result: spaJinaAttempt,
      attempts: fetched.attempts,
      env,
      // Scripts handling — lets the UI show WHY the chat/comments were kept.
      scripts_mode: scriptsDecision.mode,
      scripts_kept: scriptsDecision.keep,
      dynamic_content_detected: scriptsDecision.detected,
      dynamic_signals: scriptsDecision.signals,
      rocket_loader_neutralized: rocketLoaderRemoved || rocketRestored > 0,
      rocket_scripts_restored: rocketRestored,
      content_length: selfContainedHtml.length,
      title,
      duration_seconds: duration,
      html: selfContainedHtml,
      html_preview: selfContainedHtml.substring(0, 500) + '...',
    });
  } catch (error) {
    console.error('Clone API error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
