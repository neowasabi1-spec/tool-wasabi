import { NextRequest, NextResponse } from 'next/server';
import { fetchFunnelCrawlStepsByFunnel } from '@/lib/supabase-operations';
import type { FunnelCrawlStepRow } from '@/types/database';
import type { FunnelCrawlStep } from '@/types';

function rowToStep(row: FunnelCrawlStepRow): FunnelCrawlStep {
  const d = (row.step_data as Record<string, unknown>) ?? {};
  return {
    stepIndex: row.step_index,
    url: row.url,
    title: row.title ?? '',
    screenshotBase64: row.screenshot_base64 ?? undefined,
    links: Array.isArray(d.links) ? (d.links as FunnelCrawlStep['links']) : [],
    ctaButtons: Array.isArray(d.ctaButtons) ? (d.ctaButtons as FunnelCrawlStep['ctaButtons']) : [],
    forms: Array.isArray(d.forms) ? (d.forms as FunnelCrawlStep['forms']) : [],
    networkRequests: Array.isArray(d.networkRequests) ? (d.networkRequests as FunnelCrawlStep['networkRequests']) : [],
    cookies: Array.isArray(d.cookies) ? (d.cookies as FunnelCrawlStep['cookies']) : [],
    domLength: typeof d.domLength === 'number' ? d.domLength : 0,
    redirectFrom: typeof d.redirectFrom === 'string' ? d.redirectFrom : undefined,
    timestamp: typeof d.timestamp === 'string' ? d.timestamp : new Date().toISOString(),
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { entryUrl, funnelName, provider } = body as {
      entryUrl: string;
      funnelName: string;
      provider?: 'claude' | 'gemini';
    };

    if (!entryUrl || !funnelName) {
      return NextResponse.json(
        { success: false, error: 'entryUrl and funnelName are required' },
        { status: 400 }
      );
    }

    const rows = await fetchFunnelCrawlStepsByFunnel(entryUrl, funnelName);
    if (rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No saved steps found for this funnel' },
        { status: 404 }
      );
    }

    const steps: FunnelCrawlStep[] = rows.map(rowToStep);
    const stepsWithScreenshots = steps.filter((s) => s.screenshotBase64);
    if (stepsWithScreenshots.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No steps with screenshots to analyze' },
        { status: 400 }
      );
    }

    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://127.0.0.1:3000');
    const res = await fetch(`${baseUrl}/api/funnel-analyzer/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: stepsWithScreenshots, provider: provider || 'gemini' }),
    });
    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: data.error || 'Vision analysis failed' },
        { status: res.status }
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Vision from saved error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Vision from saved failed',
      },
      { status: 500 }
    );
  }
}
