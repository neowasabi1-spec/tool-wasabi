import { supabaseAdmin } from '@/lib/supabase-admin';
import { decryptSecret, encryptSecret } from './crypto';
import { envSpikeAdAccount, envSpikeToken, graphGet } from './graph';

export type InsightRow = {
  ad_id: string;
  ad_name: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  purchases: number;
  cpa: number | null;
  roas: number | null;
  hook_rate: number | null;
  date_start: string;
  date_stop: string;
};

const actionValue = (arr: any[] | undefined, types: string[]) =>
  Number((arr ?? []).find((a) => types.includes(a.action_type))?.value ?? 0);

export async function fetchAdInsights(token: string, adAccountId: string, datePreset = 'last_30d'): Promise<InsightRow[]> {
  const acct = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  const out: InsightRow[] = [];
  let data: any = await graphGet(
    `${acct}/insights`,
    {
      level: 'ad',
      date_preset: datePreset,
      fields:
        'ad_id,ad_name,spend,impressions,clicks,ctr,actions,purchase_roas,video_play_actions',
      limit: '200',
    },
    token,
  );
  for (;;) {
    for (const r of data.data ?? []) {
      const purchases = actionValue(r.actions, [
        'purchase',
        'offsite_conversion.fb_pixel_purchase',
        'omni_purchase',
      ]);
      const spend = Number(r.spend ?? 0);
      const impressions = Number(r.impressions ?? 0);
      const plays3s = actionValue(r.video_play_actions, ['video_view']);
      out.push({
        ad_id: r.ad_id,
        ad_name: r.ad_name,
        spend,
        impressions,
        clicks: Number(r.clicks ?? 0),
        ctr: Number(r.ctr ?? 0),
        purchases,
        cpa: purchases ? spend / purchases : null,
        roas: r.purchase_roas ? Number(r.purchase_roas[0]?.value ?? 0) : null,
        hook_rate: impressions && plays3s ? plays3s / impressions : null,
        date_start: r.date_start,
        date_stop: r.date_stop,
      });
    }
    if (!data.paging?.next) break;
    data = await graphGet(data.paging.next, {}, token);
  }
  return out;
}

export async function listAdAccounts(token: string): Promise<{ id: string; name: string }[]> {
  const data = await graphGet('me/adaccounts', { fields: 'id,name', limit: '50' }, token);
  return (data.data || []).map((a: any) => ({ id: a.id, name: a.name || a.id }));
}

export async function resolveAccessToken(opts: {
  userId: string | null;
}): Promise<{ token: string; source: 'user' | 'env' }> {
  if (opts.userId) {
    const { data } = await supabaseAdmin
      .from('user_meta_connections')
      .select('access_token_enc')
      .eq('user_id', opts.userId)
      .maybeSingle();
    const enc = (data as { access_token_enc?: string } | null)?.access_token_enc || '';
    if (enc) {
      try {
        return { token: decryptSecret(enc), source: 'user' };
      } catch {
        /* fall through */
      }
    }
  }
  const envTok = envSpikeToken();
  if (envTok) return { token: envTok, source: 'env' };
  throw new Error('No Meta token — connect Ads Manager or set META_ACCESS_TOKEN for local spike');
}

export async function upsertUserToken(userId: string, token: string, fbUserId = '', scopes: string[] = []) {
  const enc = encryptSecret(token);
  const { data, error } = await supabaseAdmin
    .from('user_meta_connections')
    .upsert(
      {
        user_id: userId,
        access_token_enc: enc,
        fb_user_id: fbUserId,
        scopes,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return Number(data.id);
}

export async function syncOwnAdsForProject(opts: {
  projectId: string;
  userId: string | null;
  adAccountId?: string;
}): Promise<{ synced: number; insights: number; source: string }> {
  const { token, source } = await resolveAccessToken({ userId: opts.userId });
  let act = (opts.adAccountId || '').trim();
  if (!act) act = envSpikeAdAccount();
  if (!act) {
    const accounts = await listAdAccounts(token);
    if (!accounts.length) throw new Error('No ad accounts visible for this token');
    act = accounts[0].id;
  }
  if (!act.startsWith('act_')) act = `act_${act}`;

  // Pull ads with creative summary
  const adsData = await graphGet(
    `${act}/ads`,
    {
      fields: 'id,name,status,creative{id,title,body,image_url,thumbnail_url,video_id}',
      limit: '100',
      effective_status: JSON.stringify(['ACTIVE', 'PAUSED']),
    },
    token,
  );

  let synced = 0;
  for (const ad of adsData.data || []) {
    const creative = ad.creative || {};
    const mediaUrl = String(creative.image_url || creative.thumbnail_url || '');
    const { error } = await supabaseAdmin.from('own_ads').upsert(
      {
        project_id: opts.projectId,
        ad_account_id: act,
        external_ad_id: String(ad.id),
        ad_name: String(ad.name || ''),
        status: String(ad.status || ''),
        headline: String(creative.title || ''),
        body_text: String(creative.body || ''),
        media_type: creative.video_id ? 'video' : 'image',
        media_url: mediaUrl,
        thumbnail_url: String(creative.thumbnail_url || ''),
        raw: ad,
        synced_at: new Date().toISOString(),
      },
      { onConflict: 'project_id,external_ad_id' },
    );
    if (!error) synced += 1;
  }

  let insightsCount = 0;
  try {
    const insights = await fetchAdInsights(token, act, 'last_30d');
    for (const row of insights) {
      const { data: own } = await supabaseAdmin
        .from('own_ads')
        .select('id')
        .eq('project_id', opts.projectId)
        .eq('external_ad_id', row.ad_id)
        .maybeSingle();
      if (!own) continue;
      const { error } = await supabaseAdmin.from('own_ad_insights').upsert(
        {
          own_ad_id: own.id,
          date_start: row.date_start,
          date_end: row.date_stop,
          spend: row.spend,
          impressions: row.impressions,
          clicks: row.clicks,
          ctr: row.ctr,
          cpa: row.cpa,
          roas: row.roas,
          hook_rate: row.hook_rate,
          purchases: row.purchases,
        },
        { onConflict: 'own_ad_id,date_start,date_end' },
      );
      if (!error) insightsCount += 1;
    }
  } catch (e) {
    console.warn('[meta sync] insights failed', e);
  }

  return { synced, insights: insightsCount, source };
}
