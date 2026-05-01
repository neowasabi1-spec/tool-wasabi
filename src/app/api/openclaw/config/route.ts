import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const OPENCLAW_DEFAULTS = {
  baseUrl: 'https://downloading-after-wizard-virtue.trycloudflare.com',
  apiKey: '76d0f4b9c277c5e457d64d908fc51fe0a2e8a93664b30806',
  model: 'openclaw:neo',
};

export async function GET() {
  try {
    const { data } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'openclaw_config')
      .single();

    if (data?.value) {
      const config = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
      return NextResponse.json({
        baseUrl: config.baseUrl || OPENCLAW_DEFAULTS.baseUrl,
        apiKey: config.apiKey || OPENCLAW_DEFAULTS.apiKey,
        model: config.model || OPENCLAW_DEFAULTS.model,
      });
    }
  } catch {
    // table or row doesn't exist yet, use defaults
  }

  return NextResponse.json(OPENCLAW_DEFAULTS);
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const config = {
      baseUrl: body.baseUrl || OPENCLAW_DEFAULTS.baseUrl,
      apiKey: body.apiKey || OPENCLAW_DEFAULTS.apiKey,
      model: body.model || OPENCLAW_DEFAULTS.model,
    };

    // Try upsert
    const { error } = await supabase
      .from('settings')
      .upsert(
        { key: 'openclaw_config', value: JSON.stringify(config), updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );

    if (error) {
      // If table doesn't exist, create it
      if (error.code === '42P01' || error.message?.includes('does not exist')) {
        await supabase.rpc('exec_sql', {
          sql: `CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TIMESTAMPTZ DEFAULT NOW()
          );`
        });
        await supabase
          .from('settings')
          .upsert(
            { key: 'openclaw_config', value: JSON.stringify(config), updated_at: new Date().toISOString() },
            { onConflict: 'key' }
          );
      } else {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }

    return NextResponse.json({ success: true, config });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
