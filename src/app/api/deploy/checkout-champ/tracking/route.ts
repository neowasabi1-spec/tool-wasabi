import { NextRequest, NextResponse } from 'next/server';
import {
  importClick,
  importLead,
  importUpsale,
  queryTransactions,
  queryOrder,
  type ImportClickParams,
  type ImportLeadParams,
  type ImportUpsaleParams,
  type QueryTransactionsParams,
} from '@/lib/checkout-champ-api';

/**
 * Proxy endpoint for Checkout Champ CRM API calls.
 * Keeps credentials server-side; the frontend only sends the action + params.
 */
export async function POST(request: NextRequest) {
  try {
    const { action, params } = await request.json();

    switch (action) {
      case 'import_click': {
        const res = await importClick(params as ImportClickParams);
        return NextResponse.json(res);
      }
      case 'import_lead': {
        const res = await importLead(params as ImportLeadParams);
        return NextResponse.json(res);
      }
      case 'import_upsale': {
        const res = await importUpsale(params as ImportUpsaleParams);
        return NextResponse.json(res);
      }
      case 'query_transactions': {
        const res = await queryTransactions(params as QueryTransactionsParams);
        return NextResponse.json(res);
      }
      case 'query_order': {
        const res = await queryOrder(params.orderId as string);
        return NextResponse.json(res);
      }
      default:
        return NextResponse.json(
          { success: false, error: `Unknown action: ${action}` },
          { status: 400 },
        );
    }
  } catch (error) {
    console.error('Checkout Champ tracking error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
