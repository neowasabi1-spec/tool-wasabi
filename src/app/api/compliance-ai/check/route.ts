import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

const GEMINI_MODEL = 'gemini-2.0-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface ComplianceCheckRequest {
  sectionId: string;
  funnelUrls: string[];
  funnelHtml?: string;
  productType: 'supplement' | 'digital' | 'both';
}

interface ComplianceItem {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'warning' | 'not_applicable';
  details: string;
  recommendation?: string;
}

interface ComplianceResult {
  sectionId: string;
  sectionName: string;
  items: ComplianceItem[];
  overallStatus: 'pass' | 'fail' | 'warning';
  summary: string;
}

const SECTION_PROMPTS: Record<string, { name: string; prompt: string }> = {
  'A1': {
    name: 'Footer & Mandatory Links',
    prompt: `Analyze the provided funnel pages for FOOTER & MANDATORY LINKS compliance.

Check each of these items and report pass/fail:
1. Footer is visible on every page (main/VSL, checkout, OTO, downsell, thank-you)
2. Privacy Policy link exists and works (must include email opt-out/unsubscribe instructions)
3. Terms & Conditions link exists and works
4. Refund / Returns Policy link exists and works
5. Disclaimer link exists and works
6. Contact Us link exists and works (must have email + support method)

For each item, explain what you found and if it passes or fails. If something is missing, explain exactly what needs to be added.`
  },
  'A2': {
    name: 'Refund Policy Consistency',
    prompt: `Analyze the provided funnel pages for REFUND POLICY CONSISTENCY compliance.

Check each of these items and report pass/fail:
1. Refund days are the same across ALL pages and ALL policies (no mismatches)
2. Guarantee wording is consistent (no "30 days" on one page and "60 days" elsewhere)
3. Checkout text matches policy text exactly

Search for any mention of refund periods, guarantee days, money-back guarantees across all pages. Flag ANY inconsistency with specific quotes and locations.`
  },
  'A3': {
    name: 'Timers, Scarcity & Urgency',
    prompt: `Analyze the provided funnel pages for TIMERS, SCARCITY & URGENCY compliance.

Check each of these items and report pass/fail:
1. No countdown timers unless the offer truly changes when timer expires
2. No fake scarcity claims ("only today", "spots left", "limited") unless provable and enforced
3. If any timer exists: documented proof of price/availability change after expiry must exist

Search for: countdown timers, urgency language, scarcity claims, "limited time", "act now", "spots left", "only X remaining", etc. Flag each instance found.`
  },
  'A4': {
    name: 'Testimonials, Ratings & Logos',
    prompt: `Analyze the provided funnel pages for TESTIMONIALS, RATINGS & LOGOS compliance.

Check each of these items and report pass/fail:
1. All testimonials appear real and have proof indicators (name/initials, source)
2. Star ratings appear legitimate (source + method should be documented)
3. Publication logos ("as seen in") are only used if actually featured
4. If any proof seems missing, recommend removing the asset

Search for: testimonial quotes, star ratings, review sections, media logos, "as seen on/in", trust badges. Flag any that look unverifiable.`
  },
  'A5': {
    name: 'Claims & Studies',
    prompt: `Analyze the provided funnel pages for CLAIMS & STUDIES compliance.

Check each of these items and report pass/fail:
1. No unsupported medical/scientific claims
2. If any study is mentioned (text or video references): references must be available and accurate
3. No "guaranteed results" / "clinically proven" unless clearly substantiated

Search for: medical claims, scientific language, study references, "proven", "clinically", "scientifically", "guaranteed results", health claims, income claims. Flag each instance with specific quotes.`
  },
  'A6': {
    name: 'Pricing & Discount Integrity',
    prompt: `Analyze the provided funnel pages for PRICING & DISCOUNT INTEGRITY compliance.

Check each of these items and report pass/fail:
1. No strike-through "WAS $X" unless provable previous sale price
2. No "TOTAL VALUE $X" / "value at $X" stacks (especially bonuses)
3. No confusing pricing blocks (same offer shown differently across pages)

Search for: crossed-out prices, "was $", "value $", price stacking, bonus valuations, discount percentages. Flag any questionable pricing presentation.`
  },
  'A7': {
    name: '"Free" Language Accuracy',
    prompt: `Analyze the provided funnel pages for "FREE" LANGUAGE ACCURACY compliance.

Check each of these items and report pass/fail:
1. "Free" is only used when truly free (no charge at all)
2. If customer pays shipping, it clearly states "Free (just $X shipping)"
3. No "free instant access" while actually charging — if customer pays anything, don't call it "free"

Search for every instance of "free", "no cost", "complimentary" and check if the customer actually pays anything. Flag any misleading free claims.`
  },
  'A8': {
    name: 'Access Wording',
    prompt: `Analyze the provided funnel pages for ACCESS WORDING compliance.

Check each of these items and report pass/fail:
1. "Lifetime access" should be replaced with "unlimited access" or "VIP access"
2. No "lifetime" promises that could be problematic

Search for: "lifetime", "forever", "permanent access". Flag each instance and recommend replacement wording.`
  },
  'A9': {
    name: 'Links & URL Hygiene',
    prompt: `Analyze the provided funnel pages for LINKS & URL HYGIENE compliance.

Check each of these items and report pass/fail:
1. All links open and match the correct product/page (no outdated URLs)
2. URLs do not contain risky/misleading terms that could trigger review issues
3. No broken images, missing sections, or layout issues

Search for: broken links, suspicious URL patterns, missing images, empty sections, 404 references. Flag any issues found.`
  },
  'B1': {
    name: 'Supplement Documentation',
    prompt: `Analyze the provided funnel pages for SUPPLEMENT DOCUMENTATION compliance (physical products).

Check each of these items and report pass/fail:
1. Product labels available as PDF (final version)
2. COAs (Certificates of Analysis) available per product/batch
3. Labels accessible to customers (linked in footer or clearly on page)

Search for: supplement facts, product labels, COA references, lab test results. Flag any missing documentation.`
  },
  'B2': {
    name: 'Shipping & Returns Compliance',
    prompt: `Analyze the provided funnel pages for SHIPPING & RETURNS COMPLIANCE (physical products).

Check each of these items and report pass/fail:
1. "Free shipping" specifies region (e.g., "Free US shipping")
2. Returns policy includes a physical return address
3. Customer support contact is clear for returns/refunds

Search for: shipping claims, return addresses, support contact info, regional shipping restrictions. Flag any missing elements.`
  },
  'B3': {
    name: 'OTO Button Wording & Clarity',
    prompt: `Analyze the provided funnel pages for OTO BUTTON WORDING & CLARITY compliance.

Check each of these items and report pass/fail:
1. Upsell/Downsell buy buttons use compliant language (e.g., "Add to order")
2. No misleading "digital-looking" imagery for physical items without clear clarification

Search for: upsell buttons, downsell CTAs, "add to order", misleading product imagery. Flag any non-compliant button text or misleading visuals.`
  },
  'C1': {
    name: 'Digital Delivery Clarity',
    prompt: `Analyze the provided funnel pages for DIGITAL DELIVERY CLARITY compliance.

Check each of these items and report pass/fail:
1. Near product images: clearly states "Digital product / instant access / online access"
2. Thank-you page explains exactly how to access the content (login/link/email)

Search for: product delivery descriptions, access instructions, digital product disclaimers. Flag any unclear delivery messaging.`
  },
  'C2': {
    name: 'Spokesperson / Expert Verification',
    prompt: `Analyze the provided funnel pages for SPOKESPERSON / EXPERT compliance.

Check each of these items and report pass/fail:
1. If a doctor/expert is presented: identity should be real and verifiable
2. If not verifiable: recommend removing/replacing doctor references

Search for: doctor names, expert credentials, "Dr.", "MD", professional titles, expert bios. Flag any unverifiable expert claims.`
  },
  'C3': {
    name: 'Video (VSL) Compliance',
    prompt: `Analyze the provided funnel pages for VIDEO (VSL) COMPLIANCE.

Check each of these items and report pass/fail:
1. Video is present and playable (desktop + mobile compatible player)
2. No unsubstantiated claim segments referenced in the page around the video

Search for: video embeds, video player elements, claims near video sections, video descriptions. Flag any compliance issues.`
  },
  'D1': {
    name: 'Checkout Page Compliance',
    prompt: `Analyze the provided funnel pages for CHECKOUT PAGE COMPLIANCE.

Check each of these items and report pass/fail:
1. Footer legal links present and working on checkout page
2. Refund summary matches the refund policy
3. No misleading ratings/testimonials on checkout
4. No timers on checkout (or fully enforceable with proof)

Search for: checkout page elements, legal links, refund text, ratings, timers on checkout. Flag any issues.`
  },
  'D2': {
    name: 'Thank-You Page Compliance',
    prompt: `Analyze the provided funnel pages for THANK-YOU PAGE COMPLIANCE.

Check each of these items and report pass/fail:
1. Billing descriptor disclosure present (e.g., "Charge will appear as Digistore24")
2. Delivery instructions are clear (digital access / shipping expectations)
3. Support contact is repeated on thank-you page

Search for: billing descriptors, delivery info, support contact on post-purchase pages. Flag any missing elements.`
  },
  'E1': {
    name: 'Final QA — Full Funnel Crawl',
    prompt: `Perform a FINAL QA ANALYSIS on the provided funnel pages.

Check each of these items and report pass/fail:
1. All pages are accessible and loading correctly
2. All footer links work on every page
3. Mobile layout appears correct (responsive design)
4. All buttons, popups, video, images work correctly
5. Red-flag keyword scan: search for "lifetime", "value", "worth", "clinically", "proven", "guarantee", "free", "timer" — flag each occurrence with context

For each red-flag keyword found, provide the exact text context and page where it appears.`
  },
};

async function fetchPageContent(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    });
    const html = await res.text();
    return html.substring(0, 30000);
  } catch (e) {
    return `[Error fetching ${url}: ${e instanceof Error ? e.message : 'unknown'}]`;
  }
}

async function callGemini(prompt: string, apiKey: string): Promise<string> {
  const url = `${API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
      systemInstruction: {
        parts: [{
          text: `You are an expert compliance auditor for online marketing funnels (supplements, digital products, affiliate offers). You analyze web page content (HTML/text) and check for specific compliance issues.

ALWAYS respond with valid JSON in this exact format:
{
  "items": [
    {
      "id": "unique_id",
      "label": "Short description of what was checked",
      "status": "pass" | "fail" | "warning" | "not_applicable",
      "details": "Detailed explanation of what was found",
      "recommendation": "What to fix (only if status is fail or warning)"
    }
  ],
  "overallStatus": "pass" | "fail" | "warning",
  "summary": "Brief overall summary of compliance for this section"
}

Rules:
- "pass" = fully compliant, no issues found
- "fail" = clear compliance violation that MUST be fixed
- "warning" = potential issue that should be reviewed
- "not_applicable" = this check doesn't apply to the provided content
- Be specific: quote exact text from pages when flagging issues
- Be thorough: check every possible violation
- If page content is missing or can't be analyzed, mark as "warning" with explanation`
        }],
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini');
  return text;
}

export async function POST(request: NextRequest) {
  try {
    const body: ComplianceCheckRequest = await request.json();
    const { sectionId, funnelUrls, funnelHtml, productType } = body;

    const sectionConfig = SECTION_PROMPTS[sectionId];
    if (!sectionConfig) {
      return NextResponse.json({ error: `Unknown section: ${sectionId}` }, { status: 400 });
    }

    if (productType === 'digital' && sectionId.startsWith('B')) {
      return NextResponse.json({
        success: true,
        result: {
          sectionId,
          sectionName: sectionConfig.name,
          items: [{ id: `${sectionId}_na`, label: sectionConfig.name, status: 'not_applicable', details: 'This section only applies to physical/supplement products.' }],
          overallStatus: 'pass',
          summary: 'Not applicable for digital-only products.',
        } as ComplianceResult,
      });
    }

    if (productType === 'supplement' && sectionId.startsWith('C')) {
      return NextResponse.json({
        success: true,
        result: {
          sectionId,
          sectionName: sectionConfig.name,
          items: [{ id: `${sectionId}_na`, label: sectionConfig.name, status: 'not_applicable', details: 'This section only applies to digital products.' }],
          overallStatus: 'pass',
          summary: 'Not applicable for supplement/physical products.',
        } as ComplianceResult,
      });
    }

    const apiKey = (process.env.GOOGLE_GEMINI_API_KEY ?? '').trim();
    if (!apiKey) {
      return NextResponse.json({ error: 'GOOGLE_GEMINI_API_KEY not configured' }, { status: 500 });
    }

    let pageContents = '';
    if (funnelUrls && funnelUrls.length > 0) {
      const results = await Promise.all(
        funnelUrls.map(async (url) => {
          const content = await fetchPageContent(url);
          return `\n\n=== PAGE: ${url} ===\n${content}`;
        })
      );
      pageContents = results.join('');
    }

    if (funnelHtml) {
      pageContents += `\n\n=== PASTED HTML CONTENT ===\n${funnelHtml.substring(0, 30000)}`;
    }

    if (!pageContents) {
      return NextResponse.json({ error: 'Provide at least one URL or paste HTML content' }, { status: 400 });
    }

    const fullPrompt = `${sectionConfig.prompt}\n\n--- FUNNEL PAGE CONTENT TO ANALYZE ---\n${pageContents}`;

    const rawResponse = await callGemini(fullPrompt, apiKey);

    let parsed: ComplianceResult;
    try {
      const json = JSON.parse(rawResponse);
      parsed = {
        sectionId,
        sectionName: sectionConfig.name,
        items: json.items || [],
        overallStatus: json.overallStatus || 'warning',
        summary: json.summary || '',
      };
    } catch {
      parsed = {
        sectionId,
        sectionName: sectionConfig.name,
        items: [{
          id: `${sectionId}_parse_error`,
          label: 'Analysis completed',
          status: 'warning',
          details: rawResponse,
        }],
        overallStatus: 'warning',
        summary: 'Analysis completed but response format was unexpected.',
      };
    }

    return NextResponse.json({ success: true, result: parsed });
  } catch (error) {
    console.error('[compliance-ai/check] Error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Compliance check failed' },
      { status: 500 }
    );
  }
}
