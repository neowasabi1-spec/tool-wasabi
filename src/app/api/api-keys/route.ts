import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomBytes } from 'crypto';
import { supabase } from '@/lib/supabase';
import type { ApiPermission } from '@/types/database';

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function generateApiKey(): string {
  const bytes = randomBytes(32);
  return `fsk_${bytes.toString('base64url')}`;
}

// GET - List all API keys (without showing the actual key)
export async function GET() {
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, name, description, key_prefix, permissions, is_active, last_used_at, expires_at, created_at, updated_at')
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ keys: data });
}

// POST - Create a new API key
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, description, permissions, expires_at } = body as {
    name: string;
    description?: string;
    permissions: ApiPermission[];
    expires_at?: string;
  };

  if (!name?.trim()) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 });
  }
  if (!permissions?.length) {
    return NextResponse.json({ error: 'At least one permission is required' }, { status: 400 });
  }

  const rawKey = generateApiKey();
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.substring(0, 12) + '...';

  const { data, error } = await supabase
    .from('api_keys')
    .insert({
      name: name.trim(),
      description: description?.trim() || '',
      key_hash: keyHash,
      key_prefix: keyPrefix,
      permissions,
      expires_at: expires_at || null,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Return the raw key ONLY on creation — it won't be shown again
  return NextResponse.json({ key: data, raw_key: rawKey });
}

// PUT - Update an API key (toggle active, rename, change permissions)
export async function PUT(req: NextRequest) {
  const body = await req.json();
  const { id, ...updates } = body as {
    id: string;
    name?: string;
    description?: string;
    permissions?: ApiPermission[];
    is_active?: boolean;
    expires_at?: string | null;
  };

  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const updateData: Record<string, unknown> = {};
  if (updates.name !== undefined) updateData.name = updates.name.trim();
  if (updates.description !== undefined) updateData.description = updates.description.trim();
  if (updates.permissions !== undefined) updateData.permissions = updates.permissions;
  if (updates.is_active !== undefined) updateData.is_active = updates.is_active;
  if (updates.expires_at !== undefined) updateData.expires_at = updates.expires_at;

  const { data, error } = await supabase
    .from('api_keys')
    .update(updateData)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ key: data });
}

// DELETE - Delete an API key
export async function DELETE(req: NextRequest) {
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { error } = await supabase.from('api_keys').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
