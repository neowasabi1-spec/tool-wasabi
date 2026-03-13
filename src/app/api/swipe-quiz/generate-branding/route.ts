import { NextRequest, NextResponse } from 'next/server';
import { generateBranding, buildBrandingInputFromDb } from '@/lib/branding-generator';
import { fetchFunnelCrawlStepsByFunnel } from '@/lib/supabase-operations';
import { supabase } from '@/lib/supabase';
import type { AffiliateSavedFunnel } from '@/types/database';

interface AffiliateFunnelStep {
  step_index: number;
  url?: string;
  title?: string;
  step_type?: string;
  input_type?: string;
  options?: string[];
  description?: string;
  cta_text?: string;
}

/**
 * Generates a complete branding package for quiz swapping.
 * 
 * Accepts either:
 *   A) Direct branding input (product + referenceFunnel + options)
 *   B) Simplified input (product + entryUrl + funnelName) — fetches crawl data from DB
 *   C) funnelId mode (product + funnelId) — fetches from affiliate_saved_funnels directly
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Mode C: funnelId — fetch from affiliate_saved_funnels directly (no crawl_steps dependency)
    if (body.funnelId && body.product) {
      const { funnelId, product, options } = body as {
        funnelId: string;
        product: {
          name: string;
          description: string;
          price: number;
          benefits: string[];
          ctaText: string;
          ctaUrl: string;
          brandName: string;
          imageUrl?: string;
        };
        options?: {
          provider?: 'claude' | 'gemini';
          tone?: 'professional' | 'casual' | 'urgent' | 'friendly' | 'luxury' | 'scientific' | 'empathetic';
          targetAudience?: string;
          niche?: string;
          language?: string;
        };
      };

      const { data: funnel, error: fetchError } = await supabase
        .from('affiliate_saved_funnels')
        .select('*')
        .eq('id', funnelId)
        .single();

      if (fetchError || !funnel) {
        return NextResponse.json(
          { success: false, error: `Funnel not found: ${fetchError?.message}` },
          { status: 404 },
        );
      }

      const typedFunnel = funnel as AffiliateSavedFunnel;
      const steps: AffiliateFunnelStep[] = Array.isArray(typedFunnel.steps)
        ? (typedFunnel.steps as unknown as AffiliateFunnelStep[])
        : [];

      // Convert affiliate_saved_funnels steps to the format buildBrandingInputFromDb expects
      const fakeSteps = steps.map((s) => ({
        step_index: s.step_index,
        url: s.url || typedFunnel.entry_url,
        title: s.title || `Step ${s.step_index}`,
        step_data: {
          isQuizStep: s.step_type === 'quiz_question' || s.step_type === 'info_screen',
          quizStepLabel: s.title || undefined,
          options: s.options,
          description: s.description,
          cta_text: s.cta_text,
          input_type: s.input_type,
        },
        vision_analysis: null, // No vision data yet from saved funnels
        funnel_name: typedFunnel.funnel_name,
        entry_url: typedFunnel.entry_url,
        funnel_tag: null,
      }));

      const input = buildBrandingInputFromDb(
        {
          name: product.name,
          description: product.description,
          price: product.price,
          benefits: product.benefits,
          cta_text: product.ctaText,
          cta_url: product.ctaUrl,
          brand_name: product.brandName,
          image_url: product.imageUrl,
        },
        fakeSteps,
        {
          provider: options?.provider || 'gemini',
          tone: options?.tone || 'professional',
          targetAudience: options?.targetAudience,
          niche: options?.niche || typedFunnel.category,
          language: options?.language || 'it',
          funnelType: typedFunnel.funnel_type,
          analysisSummary: typedFunnel.analysis_summary || undefined,
          persuasionTechniques: typedFunnel.persuasion_techniques,
          leadCaptureMethod: typedFunnel.lead_capture_method || undefined,
          notableElements: typedFunnel.notable_elements,
        },
      );

      console.log(`[generate-branding] Mode C (funnelId): "${typedFunnel.funnel_name}" — ${steps.length} steps`);
      const result = await generateBranding(input);
      return NextResponse.json(result);
    }

    // Mode B: simplified — fetch crawl steps from DB and build input
    if (body.entryUrl && body.funnelName && body.product) {
      const { entryUrl, funnelName, product, options, funnelMeta } = body as {
        entryUrl: string;
        funnelName: string;
        product: {
          name: string;
          description: string;
          price: number;
          benefits: string[];
          ctaText: string;
          ctaUrl: string;
          brandName: string;
          imageUrl?: string;
        };
        options?: {
          provider?: 'claude' | 'gemini';
          tone?: 'professional' | 'casual' | 'urgent' | 'friendly' | 'luxury' | 'scientific' | 'empathetic';
          targetAudience?: string;
          niche?: string;
          language?: string;
        };
        funnelMeta?: {
          funnel_type?: string;
          category?: string;
          analysis_summary?: string;
          persuasion_techniques?: string[];
          lead_capture_method?: string;
          notable_elements?: string[];
        };
      };

      // Try to fetch crawl steps with vision analysis from DB
      let crawlSteps: Awaited<ReturnType<typeof fetchFunnelCrawlStepsByFunnel>> = [];
      try {
        crawlSteps = await fetchFunnelCrawlStepsByFunnel(entryUrl, funnelName);
      } catch {
        // If no crawl steps, we'll use funnelMeta steps instead
      }

      if (crawlSteps.length > 0) {
        // Build from DB data (has vision analysis)
        const input = buildBrandingInputFromDb(
          {
            name: product.name,
            description: product.description,
            price: product.price,
            benefits: product.benefits,
            cta_text: product.ctaText,
            cta_url: product.ctaUrl,
            brand_name: product.brandName,
            image_url: product.imageUrl,
          },
          crawlSteps.map(row => ({
            step_index: row.step_index,
            url: row.url,
            title: row.title,
            step_data: row.step_data,
            vision_analysis: row.vision_analysis,
            funnel_name: row.funnel_name,
            entry_url: row.entry_url,
            funnel_tag: row.funnel_tag,
          })),
          {
            provider: options?.provider || 'gemini',
            tone: options?.tone || 'professional',
            targetAudience: options?.targetAudience,
            niche: options?.niche || funnelMeta?.category,
            language: options?.language || 'it',
            funnelType: funnelMeta?.funnel_type,
            analysisSummary: funnelMeta?.analysis_summary || undefined,
            persuasionTechniques: funnelMeta?.persuasion_techniques,
            leadCaptureMethod: funnelMeta?.lead_capture_method || undefined,
            notableElements: funnelMeta?.notable_elements,
          }
        );

        const result = await generateBranding(input);
        return NextResponse.json(result);
      }

      // Fallback: no crawl steps — build minimal input from funnelMeta
      return NextResponse.json({
        success: false,
        error: 'No crawl steps found in database. Use funnelId mode or run funnel analysis first.',
      }, { status: 404 });
    }

    // Mode A: direct branding input
    if (body.product && body.referenceFunnel) {
      const result = await generateBranding(body);
      return NextResponse.json(result);
    }

    return NextResponse.json(
      { success: false, error: 'Missing required fields. Provide (product + funnelId), (product + entryUrl + funnelName), or (product + referenceFunnel).' },
      { status: 400 }
    );
  } catch (error) {
    console.error('Generate branding error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Branding generation failed' },
      { status: 500 }
    );
  }
}
