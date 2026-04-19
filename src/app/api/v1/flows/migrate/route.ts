import { NextRequest, NextResponse } from 'next/server';

// This endpoint creates the funnel_flows and flow_steps tables if they don't exist.
// Call POST /api/v1/flows/migrate to run the migration.
export async function POST(_req: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: 'Missing Supabase credentials' }, { status: 500 });
  }

  const sql = `
CREATE TABLE IF NOT EXISTS funnel_flows (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Flow A',
  description TEXT,
  status TEXT DEFAULT 'draft',
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE funnel_flows DISABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS flow_steps (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  flow_id UUID REFERENCES funnel_flows(id) ON DELETE CASCADE,
  project_id UUID,
  step_number INTEGER NOT NULL DEFAULT 1,
  step_type TEXT NOT NULL DEFAULT 'page',
  name TEXT NOT NULL DEFAULT 'Step',
  copy_text TEXT,
  html_content TEXT,
  live_url TEXT,
  preview_image TEXT,
  status TEXT DEFAULT 'draft',
  visits INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  cvr DECIMAL(5,2) DEFAULT 0,
  revenue DECIMAL(10,2) DEFAULT 0,
  price DECIMAL(10,2),
  offer_type TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE flow_steps DISABLE ROW LEVEL SECURITY;
  `.trim();

  // Try Supabase Management API
  const projectRef = supabaseUrl.replace('https://', '').replace('.supabase.co', '');
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({ query: sql }),
  });

  if (!res.ok) {
    const errText = await res.text();
    return NextResponse.json({ 
      error: 'Migration failed via Management API', 
      detail: errText,
      hint: 'Run the SQL manually in the Supabase Dashboard SQL Editor.',
      sql 
    }, { status: 500 });
  }

  const result = await res.json();
  return NextResponse.json({ success: true, result });
}

export async function GET() {
  return NextResponse.json({ 
    message: 'POST to this endpoint to run the funnel_flows + flow_steps migration.',
    sql_file: '/create-flow-tables.sql'
  });
}
