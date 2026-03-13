import { NextRequest, NextResponse } from 'next/server';
import { generateBranding, buildBrandingInputFromDb } from '@/lib/branding-generator';
import { supabase } from '@/lib/supabase';
import type { BrandingGenerationInput } from '@/types';

/**
 * POST /api/branding/generate
 *
 * Generate complete branding for a product from the analysis
 * of a reference funnel (quiz or standard).
 *
 * Supports two modes:
 *
 * 1. DB MODE — Pass productId + funnelName/entryUrl and the system
 *    automatically loads data from the database:
 *    {
 *      "productId": "uuid",
 *      "funnelName": "Mounjaro Fit Quiz",
 *      "entryUrl": "https://...",
 *      "options": { "provider": "gemini", "tone": "empathetic", ... }
 *    }
 *
 * 2. DIRECT MODE — Pass the complete input:
 *    {
 *      "product": { name, description, price, benefits, ... },
 *      "referenceFunnel": { funnelName, steps: [...] },
 *      "options": { ... }
 *    }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    let input: BrandingGenerationInput;

    // Mode 1: Load from DB using productId + funnelName/entryUrl
    if (body.productId && (body.funnelName || body.entryUrl)) {
      const { productId, funnelName, entryUrl, options } = body as {
        productId: string;
        funnelName?: string;
        entryUrl?: string;
        options?: Record<string, unknown>;
      };

      // Fetch product
      const { data: product, error: productError } = await supabase
        .from('products')
        .select('*')
        .eq('id', productId)
        .single();

      if (productError || !product) {
        return NextResponse.json(
          { success: false, error: `Product not found: ${productId}` },
          { status: 404 }
        );
      }

      // Fetch funnel steps
      let query = supabase
        .from('funnel_crawl_steps')
        .select('*')
        .order('step_index', { ascending: true });

      if (funnelName) {
        query = query.eq('funnel_name', funnelName);
      }
      if (entryUrl) {
        query = query.eq('entry_url', entryUrl);
      }

      const { data: steps, error: stepsError } = await query;

      if (stepsError || !steps || steps.length === 0) {
        return NextResponse.json(
          {
            success: false,
            error: `No funnel steps found for funnel "${funnelName || ''}" at "${entryUrl || ''}"`,
          },
          { status: 404 }
        );
      }

      // Check if we also have an affiliate_saved_funnel for extra context
      let extraContext: {
        analysisSummary?: string;
        persuasionTechniques?: string[];
        leadCaptureMethod?: string;
        notableElements?: string[];
        funnelType?: string;
      } = {};

      if (entryUrl) {
        const { data: savedFunnel } = await supabase
          .from('affiliate_saved_funnels')
          .select('*')
          .eq('entry_url', entryUrl)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (savedFunnel) {
          extraContext = {
            analysisSummary: savedFunnel.analysis_summary || undefined,
            persuasionTechniques: savedFunnel.persuasion_techniques || undefined,
            leadCaptureMethod: savedFunnel.lead_capture_method || undefined,
            notableElements: savedFunnel.notable_elements || undefined,
            funnelType: savedFunnel.funnel_type || undefined,
          };
        }
      }

      input = buildBrandingInputFromDb(product, steps, {
        provider: (options?.provider as 'claude' | 'gemini') || 'gemini',
        tone: (options?.tone as 'professional' | 'casual' | 'urgent' | 'friendly' | 'luxury' | 'scientific' | 'empathetic') || 'professional',
        targetAudience: options?.targetAudience as string | undefined,
        niche: options?.niche as string | undefined,
        language: (options?.language as string) || 'en',
        ...extraContext,
      });
    }
    // Mode 2: Direct input
    else if (body.product && body.referenceFunnel) {
      input = body as BrandingGenerationInput;
    }
    // Invalid request
    else {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid request. Either provide (productId + funnelName/entryUrl) or (product + referenceFunnel).',
          usage: {
            mode1_db: {
              productId: 'uuid',
              funnelName: 'string',
              entryUrl: 'string (optional if funnelName provided)',
              options: {
                provider: 'claude | gemini',
                tone: 'professional | casual | urgent | friendly | luxury | scientific | empathetic',
                targetAudience: 'string',
                niche: 'string',
                language: 'en | it | es | ...',
              },
            },
            mode2_direct: {
              product: '{ name, description, price, benefits, ctaText, ctaUrl, brandName }',
              referenceFunnel: '{ funnelName, entryUrl, funnelType, steps: [...] }',
              options: '{ provider, tone, targetAudience, niche, language }',
            },
          },
        },
        { status: 400 }
      );
    }

    // Generate branding
    const result = await generateBranding(input);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          error: result.error,
          rawResponse: result.rawResponse,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      branding: result.branding,
    });
  } catch (error) {
    console.error('[api/branding/generate] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error generating branding',
      },
      { status: 500 }
    );
  }
}
