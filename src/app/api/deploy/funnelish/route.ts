import { NextRequest, NextResponse } from 'next/server';
import { deployFunnel, type DeployOptions } from '@/lib/deploy-automation';

export const maxDuration = 120;

export interface FunnelishDeployRequest {
  html: string;
  funnelName: string;
  pageName?: string;
  pageType?: string;
  email: string;
  password: string;
  trackingSnippet?: string;
  headless?: boolean;
}

export async function POST(request: NextRequest) {
  try {
    const body: FunnelishDeployRequest = await request.json();

    if (!body.html || !body.funnelName) {
      return NextResponse.json(
        { success: false, error: 'html and funnelName are required' },
        { status: 400 },
      );
    }

    if (!body.email || !body.password) {
      return NextResponse.json(
        { success: false, error: 'Funnelish email and password are required' },
        { status: 400 },
      );
    }

    const opts: DeployOptions = {
      platform: 'funnelish',
      html: body.html,
      funnelName: body.funnelName,
      pageName: body.pageName,
      pageType: body.pageType,
      credentials: {
        email: body.email,
        password: body.password,
      },
      trackingSnippet: body.trackingSnippet,
      headless: body.headless ?? true,
    };

    const result = await deployFunnel(opts);

    return NextResponse.json(result);
  } catch (error) {
    console.error('Funnelish deploy error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
