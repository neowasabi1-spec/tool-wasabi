import { graphGet } from './graph';

export type InsightRow = {
  ad_id: string; ad_name: string; spend: number; impressions: number; clicks: number; ctr: number;
  purchases: number; cpa: number | null; roas: number | null; hook_rate: number | null; date_start: string; date_stop: string;
};

const actionValue = (arr: any[] | undefined, types: string[]) =>
  Number((arr ?? []).find((a) => types.includes(a.action_type))?.value ?? 0);

/** Insights per ad dall'account pubblicitario (serve ads_read). */
export async function fetchAdInsights(adAccountId: string, datePreset = 'last_90d'): Promise<InsightRow[]> {
  const acct = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  const out: InsightRow[] = [];
  let data: any = await graphGet(`${acct}/insights`, {
    level: 'ad',
    date_preset: datePreset,
    fields: 'ad_id,ad_name,spend,impressions,clicks,ctr,actions,purchase_roas,video_play_actions,video_thruplay_watched_actions',
    limit: '500',
  });
  for (;;) {
    for (const r of data.data ?? []) {
      const purchases = actionValue(r.actions, ['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase']);
      const spend = Number(r.spend ?? 0);
      const impressions = Number(r.impressions ?? 0);
      // video_play_actions = riproduzioni di 3 secondi: hook rate = 3s plays / impressioni
      const plays3s = actionValue(r.video_play_actions, ['video_view']);
      out.push({
        ad_id: r.ad_id, ad_name: r.ad_name, spend, impressions, clicks: Number(r.clicks ?? 0), ctr: Number(r.ctr ?? 0),
        purchases, cpa: purchases ? spend / purchases : null,
        roas: r.purchase_roas ? Number(r.purchase_roas[0]?.value ?? 0) : null,
        hook_rate: impressions && plays3s ? plays3s / impressions : null,
        date_start: r.date_start, date_stop: r.date_stop,
      });
    }
    if (!data.paging?.next) break;
    data = await graphGet(data.paging.next, {});
  }
  return out;
}
