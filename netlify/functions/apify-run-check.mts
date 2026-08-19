/**
 * Diagnostic: inspect an Apify run's status + a small sample of its dataset,
 * using the server-side APIFY_KEY. Lets us verify the TikTok/Google actors are
 * finishing and see their real output schema.
 *
 *   GET /.netlify/functions/apify-run-check?runId=<id>
 */
export default async (req: Request) => {
  const url = new URL(req.url);
  const runId = url.searchParams.get('runId') || '';
  const token = process.env.APIFY_KEY || process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN || '';
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

  if (!token) return json({ error: 'APIFY_KEY not configured' }, 500);
  if (!runId) return json({ error: 'runId query param required' }, 400);

  try {
    const runResp = await fetch(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}?token=${encodeURIComponent(token)}`);
    const run = await runResp.json().catch(() => null);
    const data = run?.data || {};
    const datasetId = data.defaultDatasetId || '';
    let sample: unknown[] = [];
    if (datasetId) {
      const dResp = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&format=json&limit=3&token=${encodeURIComponent(token)}`);
      sample = await dResp.json().catch(() => []);
    }
    return json({
      runId,
      status: data.status,
      startedAt: data.startedAt,
      finishedAt: data.finishedAt,
      exitCode: data.exitCode,
      statusMessage: data.statusMessage,
      stats: data.stats,
      datasetId,
      sampleCount: Array.isArray(sample) ? sample.length : 0,
      sample,
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
};
