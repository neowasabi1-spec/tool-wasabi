import { NextRequest, NextResponse } from 'next/server';
import { createFunnelCrawlSteps } from '@/lib/supabase-operations';
import type { FunnelCrawlStep, FunnelPageVisionAnalysis } from '@/types';

// Allow large body (base64 screenshots): avoids 413 on Fly/Vercel
export const maxDuration = 60;

function visionToRecord(a: FunnelPageVisionAnalysis): Record<string, unknown> {
  return {
    stepIndex: a.stepIndex,
    url: a.url,
    page_type: a.page_type,
    headline: a.headline,
    subheadline: a.subheadline,
    body_copy: a.body_copy,
    cta_text: a.cta_text,
    next_step_ctas: a.next_step_ctas,
    offer_details: a.offer_details,
    price_points: a.price_points,
    urgency_elements: a.urgency_elements,
    social_proof: a.social_proof,
    tech_stack_detected: a.tech_stack_detected,
    outbound_links: a.outbound_links,
    persuasion_techniques_used: a.persuasion_techniques_used,
    raw: a.raw,
    error: a.error,
  };
}

function getSupabaseErrorInfo(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const msg = (error as { message?: string }).message ?? '';
    const code = (error as { code?: string }).code ?? '';
    const details = (error as { details?: string }).details ?? '';
    if (code) return `${msg} (code: ${code})${details ? ` - ${details}` : ''}`;
    return msg;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function POST(request: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      return NextResponse.json(
        {
          success: false,
          error: `Invalid or too large body (payload with screenshots may exceed the limit). Detail: ${msg}`,
        },
        { status: 400 }
      );
    }
    const { entryUrl, funnelName, funnelTag, steps, visionAnalyses } = (body || {}) as {
      entryUrl: string;
      funnelName?: string;
      funnelTag?: string;
      steps: FunnelCrawlStep[];
      visionAnalyses?: FunnelPageVisionAnalysis[];
    };

    if (!entryUrl || typeof entryUrl !== 'string') {
      return NextResponse.json(
        { success: false, error: 'entryUrl is required' },
        { status: 400 }
      );
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      return NextResponse.json(
        { success: false, error: 'steps array is required and must not be empty' },
        { status: 400 }
      );
    }

    const name = typeof funnelName === 'string' ? funnelName.trim() : '';
    const tag = typeof funnelTag === 'string' ? funnelTag.trim() || null : null;

    const visionByStep =
      Array.isArray(visionAnalyses) && visionAnalyses.length > 0
        ? Object.fromEntries(
            visionAnalyses.map((a) => [a.stepIndex, visionToRecord(a)])
          )
        : undefined;

    const { count, ids } = await createFunnelCrawlSteps(
      entryUrl,
      name || 'Unnamed',
      tag,
      steps,
      visionByStep
    );

    return NextResponse.json({
      success: true,
      saved: count,
      ids,
    });
  } catch (error) {
    const detail = getSupabaseErrorInfo(error);
    console.error('Save funnel steps error:', detail, error);
    return NextResponse.json(
      {
        success: false,
        error: `Supabase save failed: ${detail}`,
      },
      { status: 500 }
    );
  }
}
