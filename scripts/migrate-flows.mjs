// Migration script for funnel_flows and flow_steps tables
// Run: node scripts/migrate-flows.mjs

const SUPABASE_URL = 'https://sktpbizpckxldhxzezws.supabase.co';
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NjU2MTI2NSwiZXhwIjoyMDkyMTM3MjY1fQ.-QjEUa871p0awne8UeMAyMZKTe8FyfBrMYISp1JGaDU';

const projectRef = SUPABASE_URL.replace('https://', '').replace('.supabase.co', '');

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
`;

console.log('Attempting migration via Supabase Management API...');

const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
  },
  body: JSON.stringify({ query: sql }),
});

const text = await res.text();
console.log(`Status: ${res.status}`);
console.log(`Response: ${text}`);

if (!res.ok) {
  console.log('\n⚠️  Automated migration failed (the Management API requires a Personal Access Token, not a service role key).');
  console.log('\n📋 MANUAL MIGRATION REQUIRED:');
  console.log('1. Go to https://supabase.com/dashboard/project/sktpbizpckxldhxzezws/sql');
  console.log('2. Paste and run the SQL from: C:\\Users\\Neo\\create-flow-tables.sql');
  console.log('\nSQL content has been saved to: C:\\Users\\Neo\\create-flow-tables.sql');
}
