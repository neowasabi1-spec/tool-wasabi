import { NextRequest, NextResponse } from 'next/server';
import { withGuard, isValidUUID, validateBody, audit } from '@/lib/security';
import {
  fetchSavedPrompts,
  createSavedPrompt,
  updateSavedPrompt,
  deleteSavedPrompt,
  incrementPromptUseCount,
} from '@/lib/supabase-operations';

export const GET = withGuard(async (request: NextRequest, { ip }) => {
  const { searchParams } = new URL(request.url);
  const category = searchParams.get('category');

  let prompts;
  if (category) {
    const { fetchSavedPromptsByCategory } = await import('@/lib/supabase-operations');
    prompts = await fetchSavedPromptsByCategory(category);
  } else {
    prompts = await fetchSavedPrompts();
  }

  await audit.info('DATA_READ', 'Fetched saved prompts', {
    actor_ip: ip,
    resource_type: 'saved_prompts',
    details: { count: prompts.length, category },
  });

  return NextResponse.json({ prompts });
}, { rateLimit: 'api' });

export const POST = withGuard(async (request: NextRequest, { ip }) => {
  const body = await request.json();

  const { valid, data, errors } = validateBody(body, {
    title: { type: 'string', required: true, minLength: 1, maxLength: 500 },
    content: { type: 'string', required: true, minLength: 1, maxLength: 50000 },
    category: { type: 'string', maxLength: 100 },
    tags: { type: 'array' },
    is_favorite: { type: 'boolean' },
  });

  if (!valid) {
    return NextResponse.json({ error: 'Validation failed', details: errors }, { status: 400 });
  }

  const prompt = await createSavedPrompt({
    title: data.title as string,
    content: data.content as string,
    category: (data.category as string) || 'general',
    tags: (data.tags as string[]) || [],
    is_favorite: (data.is_favorite as boolean) || false,
  });

  await audit.info('DATA_CREATE', 'Created saved prompt', {
    actor_ip: ip,
    resource_type: 'saved_prompts',
    resource_id: prompt.id,
  });

  return NextResponse.json({ prompt });
}, { rateLimit: 'api' });

export const PUT = withGuard(async (request: NextRequest, { ip }) => {
  const body = await request.json();
  const { id, action, ...updates } = body;

  if (!id || !isValidUUID(id)) {
    return NextResponse.json({ error: 'Valid UUID id is required' }, { status: 400 });
  }

  if (action === 'increment_use') {
    await incrementPromptUseCount(id);
    return NextResponse.json({ success: true });
  }

  const prompt = await updateSavedPrompt(id, updates);

  await audit.info('DATA_UPDATE', 'Updated saved prompt', {
    actor_ip: ip,
    resource_type: 'saved_prompts',
    resource_id: id,
  });

  return NextResponse.json({ prompt });
}, { rateLimit: 'api' });

export const DELETE = withGuard(async (request: NextRequest, { ip }) => {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id || !isValidUUID(id)) {
    return NextResponse.json({ error: 'Valid UUID id is required' }, { status: 400 });
  }

  await deleteSavedPrompt(id);

  await audit.info('DATA_DELETE', 'Deleted saved prompt', {
    actor_ip: ip,
    resource_type: 'saved_prompts',
    resource_id: id,
  });

  return NextResponse.json({ success: true });
}, { rateLimit: 'api' });
