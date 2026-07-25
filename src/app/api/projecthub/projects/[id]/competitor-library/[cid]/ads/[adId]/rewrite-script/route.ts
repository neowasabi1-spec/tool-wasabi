import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Phase 1 — "same script, new video" step 1: rewrite a winning competitor
 * ad's transcript into a FRESH script adapted to the user's own product.
 *
 * POST /api/projecthub/projects/:id/competitor-library/:cid/ads/:adId/rewrite-script
 *   body: { product?: string; angle?: string; language?: string }
 *
 * We keep the winner's proven STRUCTURE (hook → problem → mechanism → proof →
 * CTA), pacing and emotional beats, but rewrite the wording so it's original
 * (no verbatim copy → avoids IP/policy issues) and points at the user's offer.
 */

const SYSTEM = `You are a world-class direct-response video-ad scriptwriter (VSL / UGC / advertorial).

You are given the TRANSCRIPT of a competitor's PROVEN winning video ad, plus the user's own product. Your job: produce a BRAND-NEW script for the user's product that reuses the winner's proven STRUCTURE and persuasion mechanics — WITHOUT copying its words.

KEEP (this is why the original wins):
- The hook style and opening pattern-interrupt.
- The pacing and the order of emotional beats (curiosity → problem → agitation → mechanism/solution → proof → offer → CTA/urgency).
- The angle/big idea, adapted to the new product.

REWRITE (mandatory):
- All wording is ORIGINAL. Never copy sentences from the transcript.
- Swap the offer, claims and specifics to the USER'S product.
- Be compliance-aware: no unverifiable medical/financial/legal guarantees, no "cure", no income/again promises. Use softened, defensible phrasing.

OUTPUT FORMAT (plain text, no markdown fences):
HOOK: <1-2 lines>
SCRIPT:
<the spoken voiceover, in short punchy lines / short paragraphs, ready to record>
ON-SCREEN / B-ROLL: <a few bracketed visual cues aligned to the script>
CTA: <the closing call to action>

Keep it roughly the same length as the original. Write in the requested language.`;

interface AdRow {
  id: number;
  body_text: string;
  headline: string;
  hook: string;
  media_type: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; cid: string; adId: string } },
) {
  const { id, cid, adId } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const product = String(body.product || '').trim();
  const angle = String(body.angle || '').trim();
  const language = String(body.language || 'English').trim() || 'English';

  const adIdNum = Number(adId);
  if (!Number.isFinite(adIdNum)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const { data: ad } = await supabaseAdmin
    .from('competitor_ads')
    .select('id, body_text, headline, hook, media_type')
    .eq('id', adIdNum)
    .eq('brand_id', Number(cid))
    .eq('project_id', id)
    .maybeSingle();

  if (!ad) return NextResponse.json({ error: 'Creative not found' }, { status: 404 });

  const a = ad as AdRow;
  const transcript = (a.body_text || '').trim();
  if (transcript.length < 20) {
    return NextResponse.json(
      { error: 'No script to rewrite yet. Use “Extract text” to transcribe the video first.' },
      { status: 400 },
    );
  }

  // Pull the project name as light context when the user didn't type a product.
  let projectName = '';
  try {
    const { data: proj } = await supabaseAdmin
      .from('projects')
      .select('name')
      .eq('id', id)
      .maybeSingle();
    projectName = (proj as { name?: string } | null)?.name || '';
  } catch { /* ignore */ }

  const productLine = product || projectName || 'MY PRODUCT (describe in the script generically)';

  const userMsg = [
    `MY PRODUCT / OFFER: ${productLine}`,
    angle ? `DESIRED ANGLE: ${angle}` : '',
    `OUTPUT LANGUAGE: ${language}`,
    '',
    a.headline ? `Competitor headline: ${a.headline}` : '',
    a.hook ? `Competitor hook: ${a.hook}` : '',
    '',
    'COMPETITOR WINNING TRANSCRIPT:',
    transcript.slice(0, 8000),
  ]
    .filter(Boolean)
    .join('\n');

  let script = '';
  try {
    const anthropic = new Anthropic({ apiKey });
    const resp = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
      system: SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    });
    const textBlock = resp.content.find((b) => b.type === 'text');
    script = (textBlock && 'text' in textBlock ? textBlock.text : '')?.trim() || '';
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Rewrite failed' },
      { status: 500 },
    );
  }

  if (!script) return NextResponse.json({ error: 'Empty rewrite' }, { status: 500 });

  // Best-effort persist so the user doesn't have to regenerate. Ignored if the
  // rewritten_script column hasn't been migrated yet.
  try {
    await supabaseAdmin
      .from('competitor_ads')
      .update({ rewritten_script: script })
      .eq('id', adIdNum)
      .eq('project_id', id);
  } catch { /* column may not exist yet */ }

  return NextResponse.json({ success: true, script });
}
