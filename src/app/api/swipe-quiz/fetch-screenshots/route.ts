import { NextRequest, NextResponse } from 'next/server';
import { fetchFunnelCrawlStepsByFunnel } from '@/lib/supabase-operations';

/**
 * Fetch per-step screenshots from funnel_crawl_steps.
 * Returns the screenshots and basic step info without sending
 * the full crawl data (which can be very large).
 */
export async function POST(request: NextRequest) {
  try {
    const { entryUrl, funnelName } = (await request.json()) as {
      entryUrl: string;
      funnelName: string;
    };

    if (!entryUrl || !funnelName) {
      return NextResponse.json(
        { success: false, error: 'entryUrl and funnelName are required' },
        { status: 400 }
      );
    }

    const rows = await fetchFunnelCrawlStepsByFunnel(entryUrl, funnelName);
    const stepsWithScreenshots = rows
      .filter((r) => r.screenshot_base64)
      .map((r) => ({
        stepIndex: r.step_index,
        url: r.url,
        title: r.title,
        screenshotBase64: r.screenshot_base64!,
        hasVisionAnalysis: !!r.vision_analysis,
      }));

    return NextResponse.json({
      success: true,
      totalSteps: rows.length,
      stepsWithScreenshots: stepsWithScreenshots.length,
      steps: stepsWithScreenshots,
    });
  } catch (error) {
    console.error('Fetch screenshots error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch screenshots' },
      { status: 500 }
    );
  }
}
