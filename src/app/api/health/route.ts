import { NextResponse } from 'next/server';

/**
 * Health & diagnostics endpoint - tests connectivity and configuration
 * Usa GET per semplicità (es. curl, browser)
 */
export async function GET() {
  const checks: Record<string, { ok: boolean; message?: string }> = {};

  // 1. Supabase (env vars)
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  checks.supabase = {
    ok: !!(supabaseUrl && supabaseKey),
    message: supabaseUrl && supabaseKey ? 'Configurato' : 'Manca NEXT_PUBLIC_SUPABASE_URL o ANON_KEY',
  };

  // 2. Vision API keys (per Funnel Analyzer Vision)
  const geminiKey = (process.env.GOOGLE_GEMINI_API_KEY ?? process.env.GEMINI_API_KEY ?? '').trim();
  const anthropicKey = (process.env.ANTHROPIC_API_KEY ?? '').trim();
  checks.vision_gemini = { ok: !!geminiKey, message: geminiKey ? 'Configurato' : 'Manca GOOGLE_GEMINI_API_KEY' };
  checks.vision_claude = { ok: !!anthropicKey, message: anthropicKey ? 'Configurato' : 'Manca ANTHROPIC_API_KEY' };
  checks.vision = {
    ok: !!geminiKey || !!anthropicKey,
    message: geminiKey || anthropicKey ? 'At least one Vision key available' : 'No Vision key (Gemini/Claude)',
  };

  // 3. Agentic API (Landing Analyzer) — read at runtime, not module level
  const agenticUrl = process.env.AGENTIC_API_URL ?? 'http://localhost:8000';
  const isLocalhost = /localhost|127\.0\.0\.1/.test(agenticUrl);
  checks.agentic = {
    ok: !isLocalhost,
    message: isLocalhost
      ? 'AGENTIC_API_URL non configurato (localhost non funziona su Fly.io)'
      : `Configurato: ${agenticUrl}`,
  };

  // 4. Test Supabase connection (use common table)
  if (supabaseUrl && supabaseKey) {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(supabaseUrl, supabaseKey);
      const { error } = await supabase.from('products').select('id').limit(1);
      checks.supabase_connect = {
        ok: !error,
        message: error ? `Error: ${error.message}` : 'Connection OK',
      };
    } catch (e) {
      checks.supabase_connect = {
        ok: false,
        message: e instanceof Error ? e.message : 'Eccezione',
      };
    }
  } else {
    checks.supabase_connect = { ok: false, message: 'Supabase non configurato' };
  }

  // 5. External copy_analyzer test (optional, can be slow)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch('https://claude-code-agents.fly.dev/health', {
      signal: controller.signal,
    }).catch(() => null);
    clearTimeout(timeout);
    checks.external_copy_analyzer = {
      ok: res?.ok ?? false,
      message: res?.ok ? 'Raggiungibile' : 'Non raggiungibile o timeout',
    };
  } catch {
    checks.external_copy_analyzer = { ok: false, message: 'Timeout o errore di rete' };
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  return NextResponse.json({
    ok: allOk,
    checks,
    hints: {
      funnel_analyzer_crawl: 'Requires Playwright/Chromium. On Fly.io it may take 60-90s.',
      funnel_analyzer_vision: 'Richiede GOOGLE_GEMINI_API_KEY o ANTHROPIC_API_KEY (fly secrets)',
      landing_analyzer: 'Richiede AGENTIC_API_URL puntato a un server agentic attivo',
      copy_analyzer: 'Usa claude-code-agents.fly.dev esterno',
    },
  });
}
