import { NextRequest } from 'next/server';
import { runAgenticSwipe, type SwipeInput } from '@/lib/swipe-agents';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, productName, productDescription, target, priceInfo, customInstructions, language } =
      body as SwipeInput & { language?: string };

    if (!url || !productName || !productDescription) {
      return new Response(
        JSON.stringify({
          error: 'Missing required fields: url, productName, productDescription',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const encoder = new TextEncoder();
    let streamClosed = false;
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: Record<string, unknown>) => {
          if (streamClosed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            streamClosed = true;
          }
        };

        try {
          const input: SwipeInput = {
            url,
            productName,
            productDescription,
            target,
            priceInfo,
            customInstructions,
            language,
          };

          const result = await runAgenticSwipe(input, (phase: string, message: string, progress: number) => {
            send({ type: 'progress', phase, message, progress });
          });

          send({
            type: 'result',
            success: true,
            html: result.html,
            productAnalysis: result.productAnalysis,
            landingAnalysis: result.landingAnalysis,
            croPlan: result.croPlan,
          });
        } catch (error) {
          console.error('[agentic-swipe] Pipeline error:', error);
          send({
            type: 'error',
            error: error instanceof Error ? error.message : 'Unknown pipeline error',
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    console.error('[agentic-swipe] Request error:', error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
