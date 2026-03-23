import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

const SYSTEM_PROMPT = `You are an expert product researcher and ecommerce analyst. Given a product name (and optionally some basic data from a catalog), you MUST research it thoroughly and create a complete product card.

Return a VALID JSON object with EXACTLY these fields:
{
  "name": "Official product name",
  "sku": "Product SKU/model number if found, or generate a logical one like BRAND-CATEGORY-001",
  "category": "Product category path (e.g. 'Health & Wellness / Oral Care', 'Beauty / Skincare')",
  "description": "Detailed product description (2-3 sentences). What it is, what it does, what makes it unique.",
  "price": 0,
  "benefits": ["Benefit 1", "Benefit 2", ...],
  "characteristics": ["Ingredient/spec/feature 1", "Ingredient/spec/feature 2", ...],
  "geoMarket": "Target markets (e.g. 'US, UK, EU', 'Global', 'Italy, EU')",
  "brandName": "Brand name",
  "ctaText": "Suggested CTA text based on product type",
  "imageUrl": "https://example.com/product-image.jpg",
  "promotionAngles": ["Angle 1: brief description", "Angle 2: brief description", ...]
}

RULES:
- price: number in EUR (convert if needed). Use the most common retail price.
- benefits: array of real, specific benefits found in your research (at least 4-5)
- characteristics: array of ingredients, specs, materials, key features (at least 5-6)
- promotionAngles: 3-5 advertising angles for affiliate/ecommerce marketing
- geoMarket: where this product is primarily sold/shipped
- imageUrl: MUST be a real, direct URL to a product image (jpg/png/webp). Search for the official product page or Amazon/ecommerce listing and get the main product image URL. Do NOT leave this empty.
- Be FACTUAL. Use real information from your research.
- Return ONLY the JSON object. No markdown, no code blocks, no explanations.`;

interface EnrichedProduct {
  name: string;
  sku: string;
  category: string;
  description: string;
  price: number;
  benefits: string[];
  characteristics: string[];
  geoMarket: string;
  brandName: string;
  ctaText: string;
  imageUrl: string;
  promotionAngles: string[];
}

export async function POST(request: NextRequest) {
  try {
    const { productName, rawData } = await request.json();

    if (!productName) {
      return NextResponse.json({ error: 'Product name is required' }, { status: 400 });
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;

    if (!openaiKey && !anthropicKey) {
      return NextResponse.json(
        { error: 'No AI API key configured (need OPENAI_API_KEY or ANTHROPIC_API_KEY)' },
        { status: 500 }
      );
    }

    const rawDataText = rawData && Object.keys(rawData).length > 0
      ? `\n\nAdditional data from catalog file:\n${Object.entries(rawData).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`
      : '';

    const userPrompt = `Research this product thoroughly and create a complete product card:

Product: "${productName}"${rawDataText}

Find: official description, ingredients/specifications/features, retail price, target markets, benefits, a direct URL to the main product image, and suggest promotion angles for affiliate marketing.

IMPORTANT: You MUST find and include a real product image URL (from the official site, Amazon, or any ecommerce listing). Do NOT leave imageUrl empty.

Return ONLY the JSON object.`;

    let result: EnrichedProduct;

    if (openaiKey) {
      try {
        result = await enrichWithOpenAIWebSearch(openaiKey, userPrompt);
      } catch (e) {
        console.warn('OpenAI web search failed, trying chat completions:', e);
        try {
          result = await enrichWithOpenAIChat(openaiKey, userPrompt);
        } catch (e2) {
          if (anthropicKey) {
            console.warn('OpenAI Chat failed, falling back to Claude:', e2);
            result = await enrichWithClaude(anthropicKey, userPrompt);
          } else {
            throw e2;
          }
        }
      }
    } else {
      result = await enrichWithClaude(anthropicKey!, userPrompt);
    }

    return NextResponse.json({ product: result });
  } catch (error) {
    console.error('Catalog enrich error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Enrichment failed' },
      { status: 500 }
    );
  }
}

async function enrichWithOpenAIWebSearch(apiKey: string, prompt: string): Promise<EnrichedProduct> {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      instructions: SYSTEM_PROMPT,
      input: prompt,
      tools: [{ type: 'web_search_preview' }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI Responses API error: ${response.status} – ${errText}`);
  }

  const data = await response.json();

  let text = '';
  for (const item of (data.output || [])) {
    if (item.type === 'message') {
      for (const content of (item.content || [])) {
        if (content.type === 'output_text') {
          text += content.text;
        }
      }
    }
  }

  if (!text) throw new Error('No text in OpenAI Responses output');
  return parseProductJSON(text);
}

async function enrichWithOpenAIChat(apiKey: string, prompt: string): Promise<EnrichedProduct> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 2048,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI Chat API error: ${response.status} – ${errText}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '';
  return parseProductJSON(text);
}

async function enrichWithClaude(apiKey: string, prompt: string): Promise<EnrichedProduct> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error: ${response.status} – ${errText}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '';
  return parseProductJSON(text);
}

function parseProductJSON(text: string): EnrichedProduct {
  let jsonStr = text.trim();

  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();

  const objMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (objMatch) jsonStr = objMatch[0];

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      name: parsed.name || '',
      sku: parsed.sku || '',
      category: parsed.category || '',
      description: parsed.description || '',
      price: typeof parsed.price === 'number' ? parsed.price : parseFloat(parsed.price) || 0,
      benefits: Array.isArray(parsed.benefits) ? parsed.benefits : [],
      characteristics: Array.isArray(parsed.characteristics) ? parsed.characteristics : [],
      geoMarket: parsed.geoMarket || parsed.geo_market || '',
      brandName: parsed.brandName || parsed.brand_name || '',
      ctaText: parsed.ctaText || parsed.cta_text || 'Buy Now',
      imageUrl: parsed.imageUrl || parsed.image_url || '',
      promotionAngles: Array.isArray(parsed.promotionAngles || parsed.promotion_angles)
        ? (parsed.promotionAngles || parsed.promotion_angles)
        : [],
    };
  } catch {
    throw new Error(`Failed to parse AI response as JSON: ${text.substring(0, 300)}`);
  }
}
