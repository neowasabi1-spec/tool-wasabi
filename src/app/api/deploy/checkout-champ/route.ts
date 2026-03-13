import { NextRequest, NextResponse } from 'next/server';
import { deployFunnel, type DeployOptions } from '@/lib/deploy-automation';
import { generateTrackingSnippet } from '@/lib/checkout-champ-api';

export const maxDuration = 120;

export interface CheckoutChampDeployRequest {
  html: string;
  funnelName: string;
  pageName?: string;
  pageType?: string;
  email: string;
  password: string;
  subdomain?: string;
  campaignId?: number;
  injectTracking?: boolean;
  headless?: boolean;
}

export async function POST(request: NextRequest) {
  try {
    const body: CheckoutChampDeployRequest = await request.json();

    if (!body.html || !body.funnelName) {
      return NextResponse.json(
        { success: false, error: 'html and funnelName are required' },
        { status: 400 },
      );
    }

    if (!body.email || !body.password) {
      return NextResponse.json(
        { success: false, error: 'Checkout Champ email and password are required' },
        { status: 400 },
      );
    }

    let trackingSnippet: string | undefined;
    if (body.injectTracking && body.campaignId) {
      trackingSnippet = generateTrackingSnippet({
        campaignId: body.campaignId,
        pageType: (body.pageType as 'presell' | 'lander' | 'checkout' | 'upsell' | 'thankyou') || 'lander',
        checkoutChampDomain: body.subdomain
          ? `${body.subdomain}.checkoutchamp.com`
          : undefined,
      });
    }

    const opts: DeployOptions = {
      platform: 'checkout_champ',
      html: body.html,
      funnelName: body.funnelName,
      pageName: body.pageName,
      pageType: body.pageType,
      credentials: {
        email: body.email,
        password: body.password,
        subdomain: body.subdomain,
      },
      trackingSnippet,
      headless: body.headless ?? true,
    };

    const result = await deployFunnel(opts);

    return NextResponse.json(result);
  } catch (error) {
    console.error('Checkout Champ deploy error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
