// =====================================================
// DEFAULT PROMPT TEMPLATES — Affiliate Marketing
// =====================================================

export type PromptCategory =
  | 'spy_ads'
  | 'competitor_analysis'
  | 'trends'
  | 'funnel_analysis'
  | 'content_research'
  | 'offer_discovery';

export interface AffiliatePromptTemplate {
  id: string;
  title: string;
  description: string;
  category: PromptCategory;
  icon: string; // lucide icon name
  prompt: string;
  startUrl: string;
  maxTurns: number;
  /** Whether this template is a good candidate for scheduling */
  schedulable: boolean;
  /** Suggested schedule frequency */
  suggestedFrequency?: 'daily' | 'weekly' | 'bi_weekly';
  tags: string[];
}

export const PROMPT_CATEGORIES: { value: PromptCategory; label: string; color: string; bgColor: string }[] = [
  { value: 'spy_ads', label: 'Spy Ads', color: 'text-red-700', bgColor: 'bg-red-50 border-red-200' },
  { value: 'competitor_analysis', label: 'Competitor Analysis', color: 'text-blue-700', bgColor: 'bg-blue-50 border-blue-200' },
  { value: 'trends', label: 'Trends & Research', color: 'text-green-700', bgColor: 'bg-green-50 border-green-200' },
  { value: 'funnel_analysis', label: 'Funnel Analysis', color: 'text-purple-700', bgColor: 'bg-purple-50 border-purple-200' },
  { value: 'content_research', label: 'Content Research', color: 'text-orange-700', bgColor: 'bg-orange-50 border-orange-200' },
  { value: 'offer_discovery', label: 'Offer Discovery', color: 'text-emerald-700', bgColor: 'bg-emerald-50 border-emerald-200' },
];

export const AFFILIATE_PROMPT_TEMPLATES: AffiliatePromptTemplate[] = [
  // ===== SPY ADS =====
  {
    id: 'fb-ad-library-health',
    title: 'Facebook Ad Library — Health & Wellness',
    description: 'Scraping the Facebook Ad Library for active ads in the health & wellness sector. Collects copy, creatives and landing pages.',
    category: 'spy_ads',
    icon: 'Search',
    prompt: `Go to the Facebook Ad Library (https://www.facebook.com/ads/library/) and search for active ads in the "Health & Wellness" category. 
For each ad found (minimum 10), extract:
1. Ad text (main copy)
2. Creative type (image, video, carousel)
3. Name of the page publishing the ad
4. Landing page link (if visible)
5. Ad start date
6. Targeting country (if visible)

Organize the results in a structured list. Also look for variants of the same ad to understand what A/B tests they are running.`,
    startUrl: 'https://www.facebook.com/ads/library/',
    maxTurns: 150,
    schedulable: true,
    suggestedFrequency: 'daily',
    tags: ['facebook', 'ads', 'health', 'spy'],
  },
  {
    id: 'fb-ad-library-weight-loss',
    title: 'Facebook Ad Library — Weight Loss',
    description: 'Monitor active weight loss ads on Facebook. Identify top advertisers and their strategies.',
    category: 'spy_ads',
    icon: 'Search',
    prompt: `Go to the Facebook Ad Library (https://www.facebook.com/ads/library/) and search for active ads related to "weight loss", "fat burner", "appetite suppressant".
For each ad found (minimum 10), extract:
1. Complete ad copy
2. Opening hook (first line)
3. CTA used
4. Creative type
5. Advertiser name
6. Landing page URL
7. Whether it appears to be an affiliate ad or direct brand

Identify common patterns in the ads: which hooks work? Which pain points are leveraged? Which promises are made?`,
    startUrl: 'https://www.facebook.com/ads/library/',
    maxTurns: 150,
    schedulable: true,
    suggestedFrequency: 'daily',
    tags: ['facebook', 'ads', 'weight-loss', 'spy'],
  },
  {
    id: 'fb-ad-library-custom',
    title: 'Facebook Ad Library — Custom Search',
    description: 'Search the Facebook Ad Library with custom keywords.',
    category: 'spy_ads',
    icon: 'Search',
    prompt: `Go to the Facebook Ad Library (https://www.facebook.com/ads/library/) and search for active ads with the keyword "[INSERT KEYWORD]".
Collect at least 10 ads and for each one extract:
1. Complete ad copy
2. Hook (first line)
3. CTA
4. Creative type (image/video/carousel)
5. Landing page URL
6. Advertiser name
7. Start date

Analyze the patterns: which marketing angles are used? Which emotions do they leverage? Is there a dominant format?`,
    startUrl: 'https://www.facebook.com/ads/library/',
    maxTurns: 150,
    schedulable: true,
    suggestedFrequency: 'weekly',
    tags: ['facebook', 'ads', 'custom', 'spy'],
  },
  {
    id: 'tiktok-creative-center',
    title: 'TikTok Creative Center — Top Ads',
    description: 'Analyze top performing ads on TikTok Creative Center to find trends and winning creatives.',
    category: 'spy_ads',
    icon: 'Play',
    prompt: `Go to TikTok Creative Center (https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en) and analyze the top performing ads.
Filter by region "United States" and sector "Health".
For the first 10 ads found, extract:
1. Creative description
2. Hook from the first 3 seconds
3. Video duration
4. Like/engagement count (if visible)
5. Call to action used
6. Brand/advertiser
7. Landing page link (if present)

Identify the trends: which formats work? UGC vs professional? Which hooks capture attention?`,
    startUrl: 'https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en',
    maxTurns: 120,
    schedulable: true,
    suggestedFrequency: 'weekly',
    tags: ['tiktok', 'ads', 'creative', 'spy'],
  },

  // ===== COMPETITOR ANALYSIS =====
  {
    id: 'competitor-funnel-analysis',
    title: 'Competitor Funnel Analysis',
    description: 'Analyze a competitor\'s complete funnel: from landing page to checkout.',
    category: 'competitor_analysis',
    icon: 'Target',
    prompt: `Analyze the complete funnel of the site [INSERT COMPETITOR URL].
Navigate through the entire user journey from the home/landing page to checkout. For each step, document:
1. Page URL
2. Page type (landing, VSL, quiz, checkout, upsell, etc.)
3. Main headline
4. Sub-headline
5. CTA button copy
6. Urgency/scarcity elements
7. Social proof present (testimonials, reviews, badges)
8. Price shown
9. Persuasion techniques used

At the end, provide a summary of the complete funnel flow and the key tactics used.`,
    startUrl: '',
    maxTurns: 200,
    schedulable: false,
    tags: ['competitor', 'funnel', 'analysis'],
  },
  {
    id: 'competitor-pricing-monitor',
    title: 'Competitor Price Monitor',
    description: 'Monitor prices and offers from the main competitors in your sector.',
    category: 'competitor_analysis',
    icon: 'DollarSign',
    prompt: `Visit the following competitor sites and collect information on current prices and offers:
[INSERT COMPETITOR URL LIST, one per line]

For each competitor document:
1. Main product/service
2. Base price
3. Active special offers (discounts, bundles, trials)
4. Pricing structure (one-time, subscription, tiered)
5. Guarantee offered (money back, etc.)
6. Visible upsell/cross-sell
7. Price comparison if present
8. Any visible discount codes

Create a final comparative table.`,
    startUrl: '',
    maxTurns: 150,
    schedulable: true,
    suggestedFrequency: 'weekly',
    tags: ['competitor', 'pricing', 'monitor'],
  },
  {
    id: 'similarweb-competitor',
    title: 'SimilarWeb — Traffic Analysis',
    description: 'Competitor traffic analysis via SimilarWeb: sources, volumes, keywords.',
    category: 'competitor_analysis',
    icon: 'BarChart3',
    prompt: `Go to SimilarWeb (https://www.similarweb.com) and analyze the traffic of the site [INSERT DOMAIN].
Extract all available information:
1. Estimated monthly traffic
2. Traffic trend (last 6 months)
3. Bounce rate
4. Average time on page
5. Pages per visit
6. Top traffic sources (organic, paid, social, referral, direct)
7. Top organic keywords
8. Top paid keywords
9. Top referral sites
10. Top social channels
11. Most similar competitor sites

Summarize the strengths and weaknesses of the traffic strategy.`,
    startUrl: 'https://www.similarweb.com',
    maxTurns: 100,
    schedulable: true,
    suggestedFrequency: 'weekly',
    tags: ['similarweb', 'traffic', 'competitor'],
  },

  // ===== TRENDS & RESEARCH =====
  {
    id: 'google-trends-health',
    title: 'Google Trends — Health Niche',
    description: 'Analysis of Google search trends for the health/wellness sector. Identify growing keywords.',
    category: 'trends',
    icon: 'TrendingUp',
    prompt: `Go to Google Trends (https://trends.google.com/trends/) and analyze trends for the health and wellness sector.
Search for these keywords and compare them:
- "weight loss supplement"
- "GLP-1"
- "ozempic alternative"
- "gut health"
- "probiotics"

For each keyword:
1. Last 12 months trend (growing, stable, declining)
2. Peak of interest and when it occurred
3. Regions with most interest
4. Related queries on the rise ("rising")
5. Related topics

Then also search for "breakout" queries in the health sector to discover new emerging trends.
Provide a report with the top 5 opportunities based on trends.`,
    startUrl: 'https://trends.google.com/trends/',
    maxTurns: 120,
    schedulable: true,
    suggestedFrequency: 'weekly',
    tags: ['google-trends', 'health', 'keyword', 'research'],
  },
  {
    id: 'google-trends-custom',
    title: 'Google Trends — Custom Search',
    description: 'Custom trend analysis on Google Trends with keywords of your choice.',
    category: 'trends',
    icon: 'TrendingUp',
    prompt: `Go to Google Trends (https://trends.google.com/trends/) and analyze trends for these keywords:
[INSERT KEYWORDS, one per line]

For each keyword:
1. Last 12 months trend
2. Last 5 years trend
3. Seasonality (are there recurring peaks?)
4. Regions with most interest
5. Related queries on the rise ("rising" and "top")
6. Related topics

Compare the keywords against each other and identify:
- Which has the most positive trend
- Which has the best seasonality
- Which related queries suggest new opportunities`,
    startUrl: 'https://trends.google.com/trends/',
    maxTurns: 100,
    schedulable: true,
    suggestedFrequency: 'weekly',
    tags: ['google-trends', 'custom', 'research'],
  },
  {
    id: 'reddit-niche-research',
    title: 'Reddit — Niche Research',
    description: 'Analysis of relevant subreddits to discover pain points, FAQs and trends in the niche.',
    category: 'trends',
    icon: 'MessageCircle',
    prompt: `Go to Reddit and analyze the following subreddits related to the health/affiliate sector:
- r/loseit
- r/Supplements  
- r/biohackers
- r/SkincareAddiction

For each subreddit:
1. Most popular posts from the last week
2. Recurring user questions
3. Frequently mentioned products/brands
4. Pain points and frustrations expressed
5. Solutions that users are looking for
6. Language and terminology used by the community

Create a report with:
- Top 10 pain points found
- Top 5 products/solutions mentioned
- Top 5 suggested marketing angles based on real conversations`,
    startUrl: 'https://www.reddit.com',
    maxTurns: 150,
    schedulable: true,
    suggestedFrequency: 'weekly',
    tags: ['reddit', 'research', 'pain-points', 'niche'],
  },

  // ===== FUNNEL ANALYSIS =====
  {
    id: 'quiz-funnel-breakdown',
    title: 'Quiz Funnel Breakdown',
    description: 'Detailed analysis of a quiz funnel: every step, logic, copy and conversion triggers.',
    category: 'funnel_analysis',
    icon: 'ClipboardList',
    prompt: `Go to [INSERT QUIZ FUNNEL URL] and complete the entire quiz funnel from start to finish.
For each quiz step, document:
1. Step number and progress (e.g. 3/10)
2. Question asked
3. Available answer options
4. Layout design (vertical list, cards, images, etc.)
5. Visual elements (images, icons, progress bar)
6. Supporting copy below the question
7. CTA button text

After the quiz, analyze the result page:
1. How the result is personalized
2. Headline and sub-headline
3. Offer copy
4. Price and pricing structure
5. Urgency/scarcity
6. Social proof
7. Final CTA

Provide a summary of the psychological techniques used in the quiz to maximize conversion.`,
    startUrl: '',
    maxTurns: 200,
    schedulable: false,
    tags: ['quiz', 'funnel', 'breakdown'],
  },
  {
    id: 'landing-page-teardown',
    title: 'Landing Page Teardown',
    description: 'Complete teardown of a landing page: structure, copy, design patterns and conversion elements.',
    category: 'funnel_analysis',
    icon: 'FileSearch',
    prompt: `Analyze the landing page at [INSERT URL] doing a complete teardown.
Scroll the entire page from top to bottom and for each section document:
1. Section type (hero, features, testimonials, pricing, FAQ, etc.)
2. Headline and copy
3. CTA buttons (text, color, position)
4. Images/videos used
5. Social proof (testimonials, numbers, badges, logos)
6. Urgency/scarcity elements
7. Above the fold: what's visible without scrolling

Additional analysis:
- Persuasion techniques used (AIDA, PAS, etc.)
- Color scheme and branding
- Mobile-friendliness (responsive layout?)
- Perceived loading speed
- Trust elements (guarantee, security, privacy)

Provide a score from 1-10 for each area and improvement suggestions.`,
    startUrl: '',
    maxTurns: 100,
    schedulable: false,
    tags: ['landing-page', 'teardown', 'conversion'],
  },
  {
    id: 'checkout-optimization-audit',
    title: 'Checkout Optimization Audit',
    description: 'Audit of the checkout process: friction points, trust elements, upsell strategy.',
    category: 'funnel_analysis',
    icon: 'ShoppingCart',
    prompt: `Go to [INSERT URL] and navigate to the checkout process (do not complete the purchase).
Analyze each step of the checkout process:
1. How many steps the checkout has (single page vs multi-step)
2. Fields required at each step
3. Payment methods accepted
4. Trust badges and security certifications
5. Order summary: how it's presented
6. Upsell/cross-sell in checkout
7. Order bump (additional pre-purchase offer)
8. Guarantee shown
9. Exit intent: are there popups?
10. Hidden costs (shipping, tax)

Provide a complete audit with:
- Identified friction points
- Missing trust elements
- Unexploited upsell opportunities
- Suggestions to increase the conversion rate`,
    startUrl: '',
    maxTurns: 150,
    schedulable: false,
    tags: ['checkout', 'optimization', 'audit'],
  },
  {
    id: 'quiz-funnel-cro-mapping',
    title: 'Quiz Funnel CRO Mapping — Complete Report',
    description: 'Navigate an entire quiz funnel as a CRO/UX expert: map every step, extract technical data, content and provide a report with final UX analysis.',
    category: 'funnel_analysis',
    icon: 'ClipboardList',
    prompt: `Role: Act as a Conversion Rate Optimization (CRO) Expert and UX Analyst.

Objective: Navigate the entire quiz funnel starting from the URL: [INSERT LINK HERE]. Your task is to map every single step, extract technical and content data and provide a final report.

Navigation Instructions:
- Access the landing page and identify the start button.
- Proceed through the quiz answering consistently (if there are multiple options, always choose the first or most generic one to advance).
- For every screen you encounter, capture the data required for the report.
- Continue until the Thank You Page or the results/lead magnet page.

Required Report Format:
For each step of the funnel, create a table or list that includes:
1. Page URL (the exact link visible in the browser)
2. Title/Question (the main question text)
3. Input Type (e.g. multiple choice, free text, progress bar)
4. Answer Options (list the available answers)
5. Element Description (presence of images, videos, icons or timers)

Final Analysis:
Conclude with a brief summary of the quiz structure (e.g.: "Linear 5-step funnel with final lead capture via email") and comment on the fluidity of the user experience.

Technical Tips for Browser Use:
- Lead Handling: If the quiz requires an email to proceed, use a dummy email (e.g. test@example.com).
- Dynamic Selectors: Some quizzes load questions without changing the URL (using JavaScript). Wait for the DOM to load after each click and describe the visual state even if the URL remains unchanged.
- Screenshots: Take a screenshot for each step to document the design beyond just text.`,
    startUrl: '',
    maxTurns: 200,
    schedulable: false,
    tags: ['quiz', 'funnel', 'cro', 'ux', 'mapping', 'report'],
  },
  {
    id: 'quiz-funnel-cro-granular-navigation',
    title: 'Quiz Funnel CRO — Granular Step-by-Step Navigation',
    description: 'Sequential and granular navigation of a quiz funnel with strict protocol: every screen is a new step, mandatory screenshot, URL verification and structured report with final CRO/UX analysis.',
    category: 'funnel_analysis',
    icon: 'ClipboardList',
    prompt: `Role: Act as a Conversion Rate Optimization (CRO) Expert and UX Analyst.
Objective: Perform a sequential and granular navigation of the quiz funnel at: [INSERT LINK HERE].

STRICT NAVIGATION PROTOCOL:

1. Step-by-Step Analysis: Never group multiple questions into a single point in the report. Every time you click on an answer and the screen changes (even if the URL stays the same or only a parameter changes), you must consider it a "New Step".
2. Interaction: Answer the questions by selecting always the first available option. If an email is required, use test@example.com.
3. URL Verification: For each single step, read and transcribe the complete URL from the address bar.
4. Mandatory Screenshot: Take a screenshot for every single question/screen before proceeding to the next.

REQUIRED REPORT FORMAT (REPEAT FOR EVERY SCREEN):

---

### STEP [Progressive Number]

* EXACT URL: [Copy the full URL from the address bar here]
* QUESTION/TITLE: [Main visible text]
* INPUT TYPE: [Single choice / Multiple choice / Text input / Slider]
* AVAILABLE OPTIONS: [Complete list of clickable answer options]
* VISUAL ELEMENTS: [Presence of icons, product images, progress bar (indicate % if visible), timer or testimonials]
* ACTION TAKEN: [Indicate what you clicked to advance]

---

FINAL ANALYSIS (only after completing the quiz):

* Funnel Map: Summary of the total number of steps.
* Branching Logic: Indicate if the quiz seems linear or if it changes based on answers.
* UX Review: Comment on loading speed, clarity of questions and effectiveness of the progress bar.`,
    startUrl: '',
    maxTurns: 200,
    schedulable: false,
    tags: ['quiz', 'funnel', 'cro', 'ux', 'granular', 'step-by-step', 'navigation', 'report'],
  },
  {
    id: 'sales-funnel-cro-mapping',
    title: 'Sales Funnel CRO Mapping — Complete Report',
    description: 'Navigate an entire sales funnel (no quiz) as a CRO/UX expert: map every page, extract copy, persuasion elements and provide a report with complete analysis.',
    category: 'funnel_analysis',
    icon: 'Target',
    prompt: `Role: Act as a Conversion Rate Optimization (CRO), Copywriting and UX Analyst Expert specialized in sales funnels.

Objective: Navigate the entire sales funnel (NOT a quiz) starting from the URL: [INSERT LINK HERE]. Your task is to map every single page of the sales journey, extract all copy, design and persuasion data and provide a structured final report.

Navigation Instructions:
- Access the first page of the funnel (landing page, advertorial, bridge page or VSL).
- Scroll the ENTIRE page from top to bottom before moving to the next.
- Click on the main CTAs to advance through the funnel (purchase buttons, "Learn More", "Get Started", etc.).
- Navigate through all pages: landing → sales page → checkout → upsell → downsell → thank you.
- If the funnel requires an email, use test@example.com. If it asks for payment data, DO NOT enter real data — stop at the checkout page and document it.
- Continue until the end of the funnel or until you can no longer proceed without paying.

Report Format — For EVERY page of the funnel:
1. Step Number (e.g. Step 1 of 5)
2. Page URL (exact link)
3. Page Type: landing_page | advertorial | bridge_page | vsl | sales_page | checkout | upsell | downsell | order_bump | thank_you | other
4. Main Headline (exact text, word for word)
5. Sub-headline (exact text)
6. Above the Fold: describe everything visible without scrolling
7. Page Structure: list ALL sections from top to bottom (hero, benefits, testimonials, pricing, FAQ, etc.)
8. CTA Copy: exact text of every button present (e.g. "Buy Now — 50% Off", "Add To Cart", "Yes, I Want This!")
9. Price and Offer: full price, discounted price, bundle, subscription, one-time
10. Urgency/Scarcity Elements: timer, limited stock, limited-time offer, "only X left"
11. Social Proof: testimonials (how many and type), reviews, numbers ("100,000+ customers"), badges, media logos
12. Trust Elements: money-back guarantee, certifications, payment security, FDA disclaimer
13. Visual Elements: video (VSL? duration?), product images, before/after, infographics
14. Lead Capture: where and how the email is requested (popup, inline, exit intent)

COMPLETE FUNNEL ANALYSIS:
1. Funnel Architecture: total number of pages, exact sequence of the journey
2. Funnel Model: identify the type (VSL funnel, advertorial → checkout, bridge page → sales, tripwire → upsell chain, etc.)
3. Pricing Strategy: how the price is presented, anchoring, discounts, bundle strategy
4. Upsell/Downsell Chain: how many upsells, at what price, how they are positioned
5. Copy Framework: which framework the main copy uses (AIDA, PAS, BAB, 4P, Star-Story-Solution)
6. Persuasion Techniques: list every technique identified (Anchoring, Social Proof, Authority, Scarcity, Urgency, Loss Aversion, Reciprocity, Commitment & Consistency, Contrast Principle, etc.)
7. Hook Analysis: what is the main hook? What big idea/mechanism is communicated?
8. Target Audience: who is the funnel targeting? What pain points and desires are addressed?
9. Strengths: what this funnel does well, elements to replicate
10. Weaknesses: friction points, missing elements, where it could improve

Technical Tips for Browser Use:
- Scroll the ENTIRE page slowly: many funnels are long-form with 10+ sections.
- Popups and Exit Intent: if a popup appears, document it (text, offer, CTA).
- Video Sales Letter: if there is a video, note its presence, position and whether the purchase button only appears after a certain time.
- Dynamic pages: some sales pages change content after X seconds or after scrolling. Wait and document.
- Screenshots: take a screenshot for each page to document the layout and design.

Format everything in a structured and readable way. Conclude with a 5-line final summary on the overall quality of the funnel and the top 3 tactics to replicate.`,
    startUrl: '',
    maxTurns: 200,
    schedulable: false,
    tags: ['sales', 'funnel', 'cro', 'ux', 'mapping', 'report', 'no-quiz'],
  },

  // ===== CONTENT RESEARCH =====
  {
    id: 'top-articles-keyword',
    title: 'Top Articles by Keyword',
    description: 'Search Google and analyze the top 5 articles for a specific keyword.',
    category: 'content_research',
    icon: 'FileText',
    prompt: `Search Google for "[INSERT KEYWORD]" and analyze the first 5 organic results.
For each article/page:
1. URL
2. Title tag
3. Meta description
4. H1 and main sub-headings (H2)
5. Estimated content length
6. Article structure (introduction, sections, conclusion)
7. Content type (listicle, guide, review, comparison)
8. CTAs present (affiliate links, opt-in, etc.)
9. Images/media used
10. Monetization scheme (ads, affiliate, own product)

Create a content brief based on the patterns found:
- Ideal article structure
- H2s to cover
- Recommended length
- Suggested differentiating angle
- LSI keywords to include`,
    startUrl: 'https://www.google.com',
    maxTurns: 120,
    schedulable: false,
    tags: ['content', 'seo', 'keyword', 'research'],
  },
  {
    id: 'youtube-competitor-videos',
    title: 'YouTube — Video Research',
    description: 'Analysis of top YouTube videos for a keyword: titles, thumbnail patterns, engagement.',
    category: 'content_research',
    icon: 'Youtube',
    prompt: `Go to YouTube and search for "[INSERT KEYWORD]".
Analyze the first 10 videos in the results:
1. Video title
2. Channel (name and subscribers if visible)
3. Views
4. Publication date
5. Video duration
6. Thumbnail type (face, text, before/after, product)
7. Hook in the first visible comments
8. Content type (review, tutorial, story, comparison)

Identify the patterns:
- Which titles perform best
- Which thumbnail style is most common
- Which duration is preferred
- How they monetize (affiliate links in description, sponsorship, etc.)
- Suggestions for a competitive video on the same keyword`,
    startUrl: 'https://www.youtube.com',
    maxTurns: 100,
    schedulable: true,
    suggestedFrequency: 'weekly',
    tags: ['youtube', 'video', 'research'],
  },

  // ===== OFFER DISCOVERY =====
  {
    id: 'clickbank-top-offers',
    title: 'ClickBank — Top Offers',
    description: 'Discover the best-selling offers on ClickBank: gravity, commissions and metrics.',
    category: 'offer_discovery',
    icon: 'Award',
    prompt: `Go to ClickBank Marketplace (https://www.clickbank.com/marketplace/) and analyze the top offers.
Filter by "Health & Fitness" category and sort by "Gravity" (popularity).
For the first 15 offers:
1. Product name
2. Gravity score
3. Average commission ($/sale)
4. Product price
5. Product type (digital, physical, subscription)
6. Presence of recurring billing
7. Sales page URL
8. Funnel type (VSL, long form, quiz)
9. Notable elements of the sales page

Identify trends:
- Which product type has the highest gravity
- Optimal price range
- Most used funnel models
- Emerging niches in the health category`,
    startUrl: 'https://www.clickbank.com/marketplace/',
    maxTurns: 150,
    schedulable: true,
    suggestedFrequency: 'weekly',
    tags: ['clickbank', 'offers', 'marketplace'],
  },
  {
    id: 'digistore-top-offers',
    title: 'Digistore24 — Top Offers',
    description: 'Analysis of top offers on Digistore24: commissions, sales pages and funnel type.',
    category: 'offer_discovery',
    icon: 'Award',
    prompt: `Go to Digistore24 Marketplace (https://www.digistore24.com/marketplace) and analyze the offers in the "Health & Fitness" category.
For the first 10 offers:
1. Product name
2. Commission per sale
3. Average conversion rate
4. Earnings per click (EPC)
5. Product type
6. Sales page URL
7. Funnel type used
8. Available affiliate materials

Provide a ranking of the best opportunities based on: commission x conversion rate x funnel quality.`,
    startUrl: 'https://www.digistore24.com/marketplace',
    maxTurns: 120,
    schedulable: true,
    suggestedFrequency: 'weekly',
    tags: ['digistore24', 'offers', 'marketplace'],
  },
  {
    id: 'affiliate-network-scout',
    title: 'Network Scout — New Offers',
    description: 'Monitor the main affiliate networks to discover newly launched offers.',
    category: 'offer_discovery',
    icon: 'Radar',
    prompt: `Visit the following affiliate networks and identify NEW offers (launched in the last month):

1. ClickBank (https://www.clickbank.com/marketplace/) - "New" section or sort by date
2. OfferVault (https://www.offervault.com/) - search "health" with recent date filter

For each new offer found:
1. Product name
2. Network
3. Commission
4. Product type
5. Specific niche
6. Sales page URL
7. Launch date
8. Perceived funnel quality (1-10)

Identify the 5 most promising offers among the new ones and explain why.`,
    startUrl: 'https://www.clickbank.com/marketplace/',
    maxTurns: 200,
    schedulable: true,
    suggestedFrequency: 'daily',
    tags: ['network', 'new-offers', 'scout'],
  },
];
