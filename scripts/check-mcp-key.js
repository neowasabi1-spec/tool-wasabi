// Diagnose / repair the MCP api key.
//
// Reads the fsk_... key from CLI arg or env var MCP_KEY, computes its
// sha256 hash (the same way validateMcpAuth does in
// src/app/api/mcp/route.ts), and SELECTs from api_keys where key_hash
// matches. If found -> prints status. If not found -> tries to INSERT.
//
// Usage:
//   node scripts/check-mcp-key.js fsk_BF1UhVEsGaAzYQ3b5iWa4zoaIxm-sNCp_2PAguHC4bg
//
// Optional env vars:
//   SUPABASE_URL, SUPABASE_KEY (anon or service_role; defaults to the
//   anon credentials hardcoded below for convenience).

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL
  || 'https://sktpbizpckxldhxzezws.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const apiKey = process.argv[2] || process.env.MCP_KEY;
if (!apiKey) {
  console.error('Usage: node scripts/check-mcp-key.js fsk_xxxxxxx');
  process.exit(1);
}
if (!apiKey.startsWith('fsk_')) {
  console.error('Key must start with fsk_');
  process.exit(1);
}

const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
const keyPrefix = apiKey.slice(0, 12);

(async () => {
  console.log('Key prefix:', keyPrefix);
  console.log('Key hash  :', keyHash);
  console.log('---');

  const { data: existing, error: selErr } = await sb
    .from('api_keys')
    .select('id, name, key_prefix, permissions, is_active, expires_at, last_used_at, created_at')
    .eq('key_hash', keyHash)
    .maybeSingle();

  if (selErr) {
    console.error('SELECT error:', selErr.message);
    process.exit(2);
  }

  if (existing) {
    console.log('FOUND in api_keys:');
    console.log(JSON.stringify(existing, null, 2));
    if (!existing.is_active) {
      console.log('\n[!] is_active = false. Run this SQL to reactivate:');
      console.log(`   UPDATE api_keys SET is_active = true WHERE id = '${existing.id}';`);
    }
    if (existing.expires_at && new Date(existing.expires_at) < new Date()) {
      console.log('\n[!] expired. Run this SQL to extend:');
      console.log(`   UPDATE api_keys SET expires_at = NULL WHERE id = '${existing.id}';`);
    }
    const perms = Array.isArray(existing.permissions)
      ? existing.permissions
      : (existing.permissions || []);
    if (!perms.includes('full_access')) {
      console.log('\n[!] missing full_access permission. Run this SQL to fix:');
      console.log(`   UPDATE api_keys SET permissions = '["full_access"]'::jsonb WHERE id = '${existing.id}';`);
    }
    return;
  }

  console.log('NOT FOUND. Attempting INSERT (anon may be blocked by RLS)...');
  const { data: inserted, error: insErr } = await sb
    .from('api_keys')
    .insert({
      name: 'OpenClaw bundle-mcp',
      description: 'Auto-inserted by scripts/check-mcp-key.js',
      key_hash: keyHash,
      key_prefix: keyPrefix,
      permissions: ['full_access'],
      is_active: true,
    })
    .select('id, name, key_prefix')
    .single();

  if (insErr) {
    console.error('\nINSERT failed:', insErr.message);
    console.log('\nRun this SQL in the Supabase SQL Editor instead:');
    console.log('---');
    console.log(`INSERT INTO api_keys (name, description, key_hash, key_prefix, permissions, is_active)
VALUES (
  'OpenClaw bundle-mcp',
  'Manual insert for fsk_BF1Uh... after migration to new Netlify site',
  '${keyHash}',
  '${keyPrefix}',
  '["full_access"]'::jsonb,
  true
);`);
    process.exit(3);
  }

  console.log('INSERTED:');
  console.log(JSON.stringify(inserted, null, 2));
})();
