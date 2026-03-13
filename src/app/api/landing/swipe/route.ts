import { NextRequest, NextResponse } from 'next/server';

interface ProductInfo {
  name: string;
  description?: string;
  benefits?: string[];
  target_audience?: string;
  price?: string;
  cta_text?: string;
  cta_url?: string;
  brand_name?: string;
  social_proof?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { source_url, product, tone, language } = body as {
      source_url: string;
      product: ProductInfo;
      tone?: string;
      language?: string;
    };

    if (!source_url) {
      return NextResponse.json(
        { error: 'source_url is required' },
        { status: 400 }
      );
    }

    if (!product?.name) {
      return NextResponse.json(
        { error: 'product.name is required' },
        { status: 400 }
      );
    }

    // Call the swipe API
    const response = await fetch(
      'https://claude-code-agents.fly.dev/api/landing/swipe',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          source_url,
          product,
          tone: tone || 'professional',
          language: language || 'it',
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `Swipe API error: ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error || errorJson.message || errorMessage;
      } catch {
        // Keep default error message
      }
      return NextResponse.json(
        { error: errorMessage },
        { status: response.status }
      );
    }

    const responseText = await response.text();
    
    try {
      const data = JSON.parse(responseText);
      
      // If it contains html, return the complete result
      if (data.html) {
        return NextResponse.json({
          success: true,
          html: data.html,
          original_title: data.original_title,
          new_title: data.new_title,
          original_length: data.original_length,
          new_length: data.new_length,
          processing_time_seconds: data.processing_time_seconds,
          method_used: data.method_used,
          changes_made: data.changes_made || [],
        });
      }
      
      // If there's no html but there's an error
      if (data.error) {
        return NextResponse.json(
          { error: data.error },
          { status: 400 }
        );
      }
      
      // Fallback: return everything
      return NextResponse.json({
        success: true,
        ...data,
      });
    } catch {
      // If it's not JSON, it could be direct HTML
      if (responseText.trim().startsWith('<!DOCTYPE') || responseText.trim().startsWith('<html')) {
        return NextResponse.json({
          success: true,
          html: responseText,
        });
      }
      
      return NextResponse.json(
        { error: 'Invalid response from server' },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('Error during swipe:', error);
    return NextResponse.json(
      { error: 'Error during landing page swipe' },
      { status: 500 }
    );
  }
}
