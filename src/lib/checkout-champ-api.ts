/**
 * Checkout Champ CRM API Client
 *
 * Docs: https://apidocs.checkoutchamp.com
 * Base URL: https://api.checkoutchamp.com
 *
 * The CRM API handles tracking (clicks, leads, orders, upsells).
 * Funnel page creation is NOT available via API — use browser automation instead.
 */

const BASE_URL = 'https://api.checkoutchamp.com';

function getCredentials() {
  const loginId = process.env.CHECKOUT_CHAMP_LOGIN_ID;
  const password = process.env.CHECKOUT_CHAMP_PASSWORD;
  if (!loginId || !password) {
    throw new Error('Missing CHECKOUT_CHAMP_LOGIN_ID or CHECKOUT_CHAMP_PASSWORD env vars');
  }
  return { loginId, password };
}

async function apiCall<T = Record<string, unknown>>(
  endpoint: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  const { loginId, password } = getCredentials();

  const qs = new URLSearchParams();
  qs.set('loginId', loginId);
  qs.set('password', password);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }

  const url = `${BASE_URL}/${endpoint}/?${qs.toString()}`;
  const res = await fetch(url, { method: 'GET' });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Checkout Champ API ${endpoint} ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

/* ─── Import Click ─── */
export interface ImportClickParams {
  pageType: 'presell' | 'lander' | 'checkout' | 'upsell' | 'thankyou';
  campaignId: number;
  requestUri?: string;
  ip?: string;
  sessionId?: string;
  affiliateId?: string;
  subAffiliate1?: string;
  subAffiliate2?: string;
}

export interface ImportClickResponse {
  result: string;
  message: string;
  data?: { sessionId: string; clickId: string };
}

export async function importClick(p: ImportClickParams): Promise<ImportClickResponse> {
  return apiCall<ImportClickResponse>('click/import', {
    pageType: p.pageType,
    campaignId: p.campaignId,
    requestUri: p.requestUri,
    ipAddress: p.ip,
    sessionId: p.sessionId,
    affId: p.affiliateId,
    afId2: p.subAffiliate1,
    afId3: p.subAffiliate2,
  });
}

/* ─── Import Lead ─── */
export interface ImportLeadParams {
  campaignId: number;
  sessionId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface ImportLeadResponse {
  result: string;
  message: string;
  data?: { prospectId: string };
}

export async function importLead(p: ImportLeadParams): Promise<ImportLeadResponse> {
  return apiCall<ImportLeadResponse>('lead/import', {
    campaignId: p.campaignId,
    sessionId: p.sessionId,
    emailAddress: p.email,
    firstName: p.firstName,
    lastName: p.lastName,
    phoneNumber: p.phone,
    address1: p.address1,
    city: p.city,
    state: p.state,
    postalCode: p.postalCode,
    country: p.country,
  });
}

/* ─── Import Order ─── */
export interface ImportOrderParams {
  campaignId: number;
  sessionId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  address1: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  creditCardNumber: string;
  expirationDate: string; // MMYY
  cvv: string;
  productId: number;
  shippingId?: number;
  tranType?: number;
  ipAddress?: string;
}

export interface ImportOrderResponse {
  result: string;
  message: string;
  data?: { orderId: string; customerId: string };
}

export async function importOrder(p: ImportOrderParams): Promise<ImportOrderResponse> {
  return apiCall<ImportOrderResponse>('order/import', {
    campaignId: p.campaignId,
    sessionId: p.sessionId,
    firstName: p.firstName,
    lastName: p.lastName,
    emailAddress: p.email,
    phoneNumber: p.phone,
    address1: p.address1,
    city: p.city,
    state: p.state,
    postalCode: p.postalCode,
    country: p.country,
    creditCardNumber: p.creditCardNumber,
    expirationDate: p.expirationDate,
    CVV: p.cvv,
    productId: p.productId,
    shippingId: p.shippingId,
    tranType: p.tranType,
    ipAddress: p.ipAddress,
  });
}

/* ─── Import Upsale ─── */
export interface ImportUpsaleParams {
  orderId: string;
  productId: number;
  sessionId: string;
}

export interface ImportUpsaleResponse {
  result: string;
  message: string;
  data?: { orderId: string };
}

export async function importUpsale(p: ImportUpsaleParams): Promise<ImportUpsaleResponse> {
  return apiCall<ImportUpsaleResponse>('upsale/import', {
    previousOrderId: p.orderId,
    productId: p.productId,
    sessionId: p.sessionId,
  });
}

/* ─── Query Transactions ─── */
export interface QueryTransactionsParams {
  startDate: string;
  endDate: string;
  txnType?: 'SALE' | 'AUTH' | 'REFUND' | 'VOID';
  responseType?: 'SUCCESS' | 'DECLINE' | 'ERROR';
  campaignId?: number;
  orderId?: string;
}

export interface Transaction {
  orderId: string;
  orderStatus: string;
  totalAmount: string;
  dateCreated: string;
  [key: string]: unknown;
}

export interface QueryTransactionsResponse {
  result: string;
  message: string;
  totalResults?: number;
  data?: Transaction[];
}

export async function queryTransactions(
  p: QueryTransactionsParams,
): Promise<QueryTransactionsResponse> {
  return apiCall<QueryTransactionsResponse>('transactions/query', {
    startDate: p.startDate,
    endDate: p.endDate,
    txnType: p.txnType,
    responseType: p.responseType,
    campaignId: p.campaignId,
    orderId: p.orderId,
  });
}

/* ─── Query Order ─── */
export interface QueryOrderResponse {
  result: string;
  message: string;
  data?: Record<string, unknown>;
}

export async function queryOrder(orderId: string): Promise<QueryOrderResponse> {
  return apiCall<QueryOrderResponse>('order/query', { orderId });
}

/* ─── Tracking Snippet Generator ─── */
/**
 * Generates the client-side tracking JS that should be injected into
 * HTML funnel pages deployed on Checkout Champ. This handles:
 * - Click tracking on each page load
 * - Lead capture form submission
 * - Order form integration
 */
export function generateTrackingSnippet(opts: {
  campaignId: number;
  pageType: ImportClickParams['pageType'];
  checkoutChampDomain?: string;
}): string {
  const domain = opts.checkoutChampDomain || 'api.checkoutchamp.com';
  return `
<script>
(function(){
  var CC_CONFIG = {
    campaignId: ${opts.campaignId},
    pageType: "${opts.pageType}",
    apiBase: "https://${domain}"
  };

  function getSessionId() {
    var sid = sessionStorage.getItem('cc_session_id');
    if (!sid) {
      sid = 'sid_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      sessionStorage.setItem('cc_session_id', sid);
    }
    return sid;
  }

  function trackClick() {
    var params = new URLSearchParams({
      pageType: CC_CONFIG.pageType,
      campaignId: CC_CONFIG.campaignId,
      sessionId: getSessionId(),
      requestUri: window.location.href
    });
    var urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('affId')) params.set('affId', urlParams.get('affId'));
    if (urlParams.get('afId2')) params.set('afId2', urlParams.get('afId2'));

    fetch(CC_CONFIG.apiBase + '/click/import/?' + params.toString())
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.data && d.data.sessionId) {
          sessionStorage.setItem('cc_session_id', d.data.sessionId);
        }
      })
      .catch(function(e) { console.warn('CC click track error', e); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', trackClick);
  } else {
    trackClick();
  }

  window.CC_CONFIG = CC_CONFIG;
  window.CC_SESSION_ID = getSessionId;
})();
</script>`.trim();
}
