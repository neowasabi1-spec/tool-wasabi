import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

import {
  runVisualBlueprintAnalysis,
  runQuizLogicBlueprintAnalysis,
} from '@/lib/quiz-multiagent-engine';
import { fetchFunnelCrawlStepsByFunnel } from '@/lib/supabase-operations';

interface AffiliateFunnelStep {
  step_index: number;
  url: string;
  title: string;
  step_type?: string;
  input_type?: string;
  options?: string[];
  description?: string;
  cta_text?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { entryUrl, funnelName, funnelSteps } = body as {
      entryUrl: string;
      funnelName: string;
      funnelSteps?: AffiliateFunnelStep[];
    };

    if (!entryUrl) {
      return NextResponse.json({ error: 'entryUrl is required' }, { status: 400 });
    }

    const geminiKey = (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GEMINI_API_KEY ?? '').trim();
    if (!geminiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY not configured' }, { status: 500 });
    }

    // Fetch screenshots from DB
    let screenshots: string[] = [];
    let stepsInfo: Array<{ index: number; title: string; type: string; options?: string[] }> = [];

    try {
      const crawlSteps = await fetchFunnelCrawlStepsByFunnel(entryUrl, funnelName);
      screenshots = crawlSteps
        .filter(r => r.screenshot_base64)
        .map(r => r.screenshot_base64!);
      stepsInfo = crawlSteps.map(r => {
        const sd = r.step_data as Record<string, unknown> | null;
        return {
          index: r.step_index,
          title: r.title || `Step ${r.step_index}`,
          type: (sd?.step_type as string) || 'other',
          options: Array.isArray(sd?.options) ? (sd.options as string[]) : undefined,
        };
      });
    } catch { /* no crawl data */ }

    if (stepsInfo.length === 0 && funnelSteps) {
      stepsInfo = funnelSteps.map(s => ({
        index: s.step_index,
        title: s.title,
        type: s.step_type || 'other',
        options: s.options,
      }));
    }

    // If no screenshots in DB, capture live
    if (screenshots.length === 0 && funnelSteps) {
      const { launchBrowser } = await import('@/lib/get-browser');
      const browser = await launchBrowser();
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        viewport: { width: 1280, height: 800 },
        ignoreHTTPSErrors: true,
      });
      const page = await context.newPage();

      const seen = new Set<string>();
      const urls = [entryUrl, ...funnelSteps.map(s => s.url)].filter(u => {
        if (!u || seen.has(u)) return false;
        seen.add(u);
        return true;
      });

      for (const url of urls) {
        try {
          await page.goto(url, { waitUntil: 'networkidle', timeout: 12000 });
          await page.waitForTimeout(1200);
          const buf = await page.screenshot({ fullPage: true, type: 'png', timeout: 8000 });
          screenshots.push(buf.toString('base64'));
        } catch { /* skip */ }
      }

      await context.close();
      await browser.close();
    }

    if (screenshots.length === 0) {
      return NextResponse.json({ error: 'No screenshots available' }, { status: 400 });
    }

    // Run both Gemini analyses in parallel
    const [visualBlueprint, quizBlueprint] = await Promise.all([
      runVisualBlueprintAnalysis({
        screenshots,
        cssTokens: null,
        geminiApiKey: geminiKey,
      }),
      runQuizLogicBlueprintAnalysis({
        screenshots,
        stepsInfo,
        geminiApiKey: geminiKey,
      }),
    ]);

    return NextResponse.json({
      success: true,
      screenshotsCount: screenshots.length,
      stepsInfoCount: stepsInfo.length,
      visualBlueprint,
      quizBlueprint,
    });
  } catch (error) {
    console.error('[debug-gemini] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Gemini debug error' },
      { status: 500 },
    );
  }
}
