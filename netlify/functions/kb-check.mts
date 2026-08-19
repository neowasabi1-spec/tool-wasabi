import { getCoreKnowledge, getKnowledgeForTask, getKnowledgeStats } from '../../src/knowledge/copywriting';

/**
 * Diagnostic: confirms the copywriting Knowledge Base actually loads inside a
 * Netlify function bundle (included_files + process.cwd() resolution). Hit
 * /.netlify/functions/kb-check and check coreChars > 0.
 */
export default async () => {
  const out: Record<string, unknown> = { cwd: process.cwd() };
  try { out.coreChars = getCoreKnowledge().length; } catch (e) { out.coreErr = (e as Error).message; }
  try { out.tier2AdChars = getKnowledgeForTask('ad' as never).length; } catch (e) { out.tier2Err = (e as Error).message; }
  try {
    const s = getKnowledgeStats();
    out.sources = s.sources.map((x) => ({ id: x.id, tier: x.tier, loaded: x.loaded, chars: x.chars }));
  } catch (e) { out.statsErr = (e as Error).message; }
  return new Response(JSON.stringify(out, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
};
