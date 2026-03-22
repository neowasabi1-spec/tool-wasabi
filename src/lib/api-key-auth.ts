import { createHash } from 'crypto';
import { supabase } from './supabase';
import type { ApiPermission } from '@/types/database';

export interface ValidatedApiKey {
  id: string;
  name: string;
  permissions: ApiPermission[];
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function hasPermission(permissions: ApiPermission[], required: ApiPermission): boolean {
  if (permissions.includes('full_access')) return true;
  return permissions.includes(required);
}

export async function validateApiKey(
  request: Request,
  requiredPermission: ApiPermission
): Promise<{ valid: true; apiKey: ValidatedApiKey } | { valid: false; error: string; status: number }> {
  const headerKey =
    request.headers.get('x-api-key') ||
    request.headers.get('authorization')?.replace('Bearer ', '');

  if (!headerKey || !headerKey.startsWith('fsk_')) {
    return { valid: false, error: 'Missing or invalid API key. Pass it via X-API-Key header.', status: 401 };
  }

  const keyHash = hashKey(headerKey);

  const { data, error } = await supabase
    .from('api_keys')
    .select('id, name, permissions, is_active, expires_at')
    .eq('key_hash', keyHash)
    .single();

  if (error || !data) {
    return { valid: false, error: 'Invalid API key.', status: 401 };
  }

  if (!data.is_active) {
    return { valid: false, error: 'API key is disabled.', status: 403 };
  }

  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    return { valid: false, error: 'API key has expired.', status: 403 };
  }

  const perms = (data.permissions || []) as ApiPermission[];
  if (!hasPermission(perms, requiredPermission)) {
    return { valid: false, error: `Missing permission: ${requiredPermission}`, status: 403 };
  }

  // Update last_used_at (fire and forget)
  supabase.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', data.id).then(() => {});

  return {
    valid: true,
    apiKey: { id: data.id, name: data.name, permissions: perms },
  };
}
