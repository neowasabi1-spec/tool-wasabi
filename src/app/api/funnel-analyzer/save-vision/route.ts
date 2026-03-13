import { NextRequest, NextResponse } from 'next/server';
import { updateFunnelCrawlStepsVision } from '@/lib/supabase-operations';
import type { FunnelPageVisionAnalysis } from '@/types';

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

/** Updates already-saved steps on Supabase with Vision AI analyses. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { entryUrl, funnelName, visionAnalyses } = body as {
      entryUrl: string;
      funnelName: string;
      visionAnalyses: FunnelPageVisionAnalysis[];
    };

    if (!entryUrl || typeof entryUrl !== 'string') {
      return NextResponse.json(
        { success: false, error: 'entryUrl is required' },
        { status: 400 }
      );
    }
    const name =
      typeof funnelName === 'string' ? funnelName.trim() : '';
    if (!name) {
      return NextResponse.json(
        { success: false, error: 'funnelName is required to match saved steps' },
        { status: 400 }
      );
    }
    if (!Array.isArray(visionAnalyses) || visionAnalyses.length === 0) {
      return NextResponse.json(
        { success: false, error: 'visionAnalyses array is required and must not be empty' },
        { status: 400 }
      );
    }

    const payload = visionAnalyses.map((a) => ({
      stepIndex: a.stepIndex,
      analysis: visionToRecord(a),
    }));

    const { updated } = await updateFunnelCrawlStepsVision(
      entryUrl,
      name,
      payload
    );

    return NextResponse.json({
      success: true,
      updated,
    });
  } catch (error) {
    console.error('Save vision error:', error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : 'Error saving AI analysis',
      },
      { status: 500 }
    );
  }
}
