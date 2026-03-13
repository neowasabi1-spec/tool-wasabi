import { NextResponse } from 'next/server';

function getAgenticApiBase() {
  return process.env.AGENTIC_API_URL || 'http://localhost:8000';
}

export async function GET() {
  const AGENTIC_API_BASE = getAgenticApiBase();
  const IS_LOCALHOST = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(AGENTIC_API_BASE);
  const isDeployed = !!(process.env.FLY_APP_NAME || process.env.VERCEL_URL);
  if (IS_LOCALHOST && isDeployed) {
    return NextResponse.json({
      success: false,
      error: 'AGENTIC_API_URL non configurato. Su Fly.io/Vercel non puoi usare localhost. Imposta AGENTIC_API_URL con l\'URL pubblico del server agentic.',
      server: AGENTIC_API_BASE,
    }, { status: 503 });
  }
  try {
    const response = await fetch(`${AGENTIC_API_BASE}/health`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return NextResponse.json(
        { 
          success: false, 
          error: `Health check failed: ${response.status}`,
          server: AGENTIC_API_BASE,
        },
        { status: response.status }
      );
    }

    const data = await response.json();
    
    return NextResponse.json({
      success: true,
      server: AGENTIC_API_BASE,
      ...data,
    });

  } catch (error) {
    console.error('Error checking agentic API health:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Connection failed',
        server: AGENTIC_API_BASE,
      },
      { status: 503 }
    );
  }
}
