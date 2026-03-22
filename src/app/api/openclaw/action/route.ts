import { NextRequest, NextResponse } from 'next/server';

const getConfig = () => ({
  baseUrl: process.env.OPENCLAW_BASE_URL || 'http://69.197.168.23:19001',
  apiKey: process.env.OPENCLAW_API_KEY || '',
  model: process.env.OPENCLAW_MODEL || 'openclaw:neo',
});

interface ToolAction {
  action: string;
  params: Record<string, unknown>;
}

const ACTION_DETECTION_PROMPT = `You are an AI that detects when a user wants to perform an action in a tool.
Analyze the user message and determine if they want to execute a tool action.

AVAILABLE ACTIONS:
- analyze_copy: Analyze marketing copy from a URL. Params: { url: string }
- analyze_landing: Analyze a landing page. Params: { url: string }
- analyze_funnel: Analyze an entire funnel. Params: { url: string }
- clone_page: Clone/download a landing page HTML. Params: { url: string }
- start_browser_agent: Start the browser agent to navigate. Params: { prompt: string, startUrl?: string }
- create_product: Create a new product. Params: { name: string, description: string, price: number }
- generate_brief: Generate an AI product brief. Params: { productName: string }
- check_compliance: Run compliance check on a URL. Params: { url: string }
- rewrite_section: Rewrite a section of copy. Params: { text: string, instructions: string }
- search_templates: Search saved templates. Params: { query: string }
- no_action: Just a regular chat message, no tool action needed. Params: {}

Respond ONLY with valid JSON in this exact format:
{ "action": "action_name", "params": { ... } }

If the user is just chatting or asking a question that doesn't require a tool action, respond with:
{ "action": "no_action", "params": {} }`;

async function detectAction(userMessage: string, section: string, config: ReturnType<typeof getConfig>): Promise<ToolAction> {
  try {
    const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: ACTION_DETECTION_PROMPT + `\n\nThe user is currently in the "${section}" section.` },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.1,
        max_tokens: 200,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return { action: 'no_action', params: {} };

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { action: 'no_action', params: {} };

    return JSON.parse(jsonMatch[0]);
  } catch {
    return { action: 'no_action', params: {} };
  }
}

async function executeAction(action: ToolAction, origin: string): Promise<{ success: boolean; result: string; data?: unknown }> {
  const { action: actionName, params } = action;

  try {
    switch (actionName) {
      case 'analyze_copy': {
        const url = params.url as string;
        if (!url) return { success: false, result: 'URL is required for copy analysis.' };
        const res = await fetch(`${origin}/api/analyze-copy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        const data = await res.json();
        return { success: res.ok, result: data.analysis || data.error || 'Analysis complete.', data };
      }

      case 'analyze_landing': {
        const url = params.url as string;
        if (!url) return { success: false, result: 'URL is required for landing analysis.' };
        const res = await fetch(`${origin}/api/funnel-brief/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        const data = await res.json();
        return { success: res.ok, result: data.analysis || data.brief || data.error || 'Analysis complete.', data };
      }

      case 'analyze_funnel': {
        const url = params.url as string;
        if (!url) return { success: false, result: 'URL is required for funnel analysis.' };
        const res = await fetch(`${origin}/api/funnel/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        const data = await res.json();
        return { success: res.ok, result: data.analysis || data.error || 'Funnel analysis complete.', data };
      }

      case 'clone_page': {
        const url = params.url as string;
        if (!url) return { success: false, result: 'URL is required to clone a page.' };
        const res = await fetch(`${origin}/api/landing/clone`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        const data = await res.json();
        if (res.ok && data.html) {
          return { success: true, result: `Page cloned successfully! HTML length: ${data.html.length} chars. Title: "${data.title || 'N/A'}"`, data: { title: data.title, length: data.html.length } };
        }
        return { success: false, result: data.error || 'Clone failed.' };
      }

      case 'start_browser_agent': {
        const prompt = params.prompt as string;
        const startUrl = params.startUrl as string | undefined;
        if (!prompt) return { success: false, result: 'A prompt is required to start the browser agent.' };
        const res = await fetch(`${origin}/api/affiliate-browser-chat/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, startUrl, maxTurns: 50 }),
        });
        const data = await res.json();
        if (data.success) {
          return { success: true, result: `Browser agent started! Job ID: ${data.jobId}. It's navigating now. Check the Affiliate Browser Chat section for live updates.`, data };
        }
        return { success: false, result: data.error || 'Failed to start browser agent.' };
      }

      case 'create_product': {
        const name = params.name as string;
        const description = params.description as string || '';
        const price = (params.price as number) || 0;
        if (!name) return { success: false, result: 'Product name is required.' };
        const res = await fetch(`${origin}/api/v1/products`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description, price, benefits: [], cta_text: 'Buy Now', cta_url: '', brand_name: '' }),
        });
        const data = await res.json();
        if (res.ok) {
          return { success: true, result: `Product "${name}" created successfully!`, data };
        }
        return { success: false, result: data.error || 'Failed to create product.' };
      }

      case 'generate_brief': {
        const productName = params.productName as string;
        if (!productName) return { success: false, result: 'Product name is required for brief generation.' };
        const res = await fetch(`${origin}/api/product-brief`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product: { name: productName } }),
        });
        const data = await res.json();
        return { success: res.ok, result: data.brief || data.error || 'Brief generated.', data };
      }

      case 'check_compliance': {
        const url = params.url as string;
        if (!url) return { success: false, result: 'URL is required for compliance check.' };
        const res = await fetch(`${origin}/api/compliance-ai/check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        const data = await res.json();
        return { success: res.ok, result: data.analysis || data.report || data.error || 'Compliance check complete.', data };
      }

      case 'rewrite_section': {
        const text = params.text as string;
        const instructions = params.instructions as string;
        if (!text) return { success: false, result: 'Text to rewrite is required.' };
        const res = await fetch(`${origin}/api/rewrite-section`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, instructions: instructions || 'Improve this copy' }),
        });
        const data = await res.json();
        return { success: res.ok, result: data.rewritten || data.result || data.error || 'Rewrite complete.', data };
      }

      default:
        return { success: false, result: 'Unknown action.' };
    }
  } catch (err) {
    return { success: false, result: `Action failed: ${(err as Error).message}` };
  }
}

export async function POST(req: NextRequest) {
  const { message, section, conversationHistory } = await req.json();

  if (!message) {
    return NextResponse.json({ error: 'Missing message' }, { status: 400 });
  }

  const config = getConfig();
  if (!config.apiKey) {
    return NextResponse.json({ error: 'OpenClaw API key not configured' }, { status: 500 });
  }

  const origin = req.nextUrl.origin;

  // Step 1: Detect if user wants an action
  const detectedAction = await detectAction(message, section, config);

  // Step 2: If action detected, execute it
  let actionResult: { success: boolean; result: string; data?: unknown } | null = null;
  if (detectedAction.action !== 'no_action') {
    actionResult = await executeAction(detectedAction, origin);
  }

  // Step 3: Send to OpenClaw with action context for a natural response
  const systemPrompt = `You are OpenClaw, an AI assistant integrated into the "Funnel Swiper" tool.
The user is in the "${section}" section.

${actionResult ? `
ACTION EXECUTED: ${detectedAction.action}
ACTION RESULT: ${actionResult.success ? 'SUCCESS' : 'FAILED'}
ACTION OUTPUT:
${actionResult.result}

Summarize what happened to the user in a clear, friendly way. If the action succeeded, explain what was done. If it failed, explain why and suggest alternatives.
` : ''}

Be concise, helpful, and actionable. Respond in the same language the user writes in.`;

  const history = (conversationHistory || []).slice(-10);
  history.push({ role: 'user', content: message });

  try {
    const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...history,
        ],
        temperature: 0.7,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(120000),
    });

    if (!res.ok) {
      const errText = await res.text();
      return NextResponse.json({ error: `OpenClaw error: ${res.status} - ${errText}` }, { status: res.status });
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';

    return NextResponse.json({
      content,
      actionExecuted: detectedAction.action !== 'no_action' ? detectedAction.action : null,
      actionSuccess: actionResult?.success ?? null,
      actionData: actionResult?.data ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `OpenClaw connection failed: ${(err as Error).message}` },
      { status: 502 }
    );
  }
}
