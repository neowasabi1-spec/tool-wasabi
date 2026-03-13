import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

const MODEL = 'gpt-4.1';

const SYSTEM_PROMPT = `You are a world-class expert in funnel marketing, direct response copywriting, persuasion and funnel engineering.
Your task is to perform a complete REVERSE ENGINEERING of a funnel.

You will be provided with one or more of the following materials:
- Structured funnel data (JSON with steps, URLs, etc.)
- Screenshots of funnel pages (images)
- PDF documents with funnel information
- HTML/text content of web pages retrieved from links
- Additional analyst notes

Use ALL available materials to reconstruct and analyze the entire funnel in depth.

For each funnel step you can identify, analyze:
1. **Unique Mechanism**: What is the differentiating element that makes this step unique? What is the "big idea" or "big promise"?
2. **Step Objective**: What does this step aim to achieve in the user's journey?
3. **Psychological Triggers**: What psychological levers are used (scarcity, urgency, social proof, authority, reciprocity, curiosity gap, etc.)?
4. **Copywriting Patterns**: What copy framework is used (PAS, AIDA, BAB, 4Ps, Star-Story-Solution, etc.)?
5. **Hook & Angle**: What is the main hook and attack angle?
6. **Transition to Next Step**: How is the user guided to the next step? What is the "bridge"?
7. **Conversion Elements**: CTA, form, buttons — how are they structured to maximize conversion?
8. **Objections Handled**: What user objections are addressed in this step?

Additionally, provide a global funnel analysis:
- **Funnel Architecture**: The overall strategic blueprint
- **Customer Journey Map**: The user's emotional journey through the funnel
- **Global Unique Mechanism**: The Big Mechanism that differentiates the entire funnel
- **Effectiveness Scoring**: Rating 1-10 of various aspects (copy, design, persuasion, flow, CTA)
- **Strengths**: What works exceptionally well
- **Weaknesses**: Where the funnel could improve
- **Optimization Suggestions**: How you could improve the funnel
- **Regenerated Funnel Proposal**: Describe step-by-step how you would rebuild/optimize the funnel

Respond ONLY with valid JSON (no markdown, no code blocks) with this structure:

{
  "funnel_overview": {
    "funnel_architecture": "description of the strategic architecture",
    "global_unique_mechanism": "the unique mechanism that differentiates the entire funnel",
    "big_promise": "the big promise of the funnel",
    "target_avatar": "ideal customer avatar",
    "awareness_level": "target awareness level (unaware, problem-aware, solution-aware, product-aware, most-aware)",
    "sophistication_level": "market sophistication level (1-5 according to Eugene Schwartz)",
    "customer_journey_emotions": ["emotion1", "emotion2", "emotion3"],
    "overall_effectiveness_score": 1-10,
    "copy_score": 1-10,
    "design_score": 1-10,
    "persuasion_score": 1-10,
    "flow_score": 1-10,
    "cta_score": 1-10,
    "strengths": ["strength 1", "strength 2"],
    "weaknesses": ["weakness 1", "weakness 2"],
    "optimization_suggestions": ["suggestion 1", "suggestion 2"]
  },
  "steps_analysis": [
    {
      "step_index": 1,
      "step_name": "step name/title",
      "step_type": "type (landing, quiz_question, lead_capture, checkout, upsell, info_screen, thank_you, other)",
      "unique_mechanism": "the unique mechanism of this specific step",
      "objective": "main objective of the step",
      "psychological_triggers": ["trigger1", "trigger2"],
      "copywriting_framework": "framework used",
      "hook": "main hook",
      "angle": "attack angle",
      "bridge_to_next": "how it guides to the next step",
      "conversion_elements": {
        "primary_cta": "primary CTA text",
        "cta_style": "CTA style/design",
        "secondary_ctas": ["secondary CTAs"],
        "form_elements": ["form elements if present"],
        "trust_signals": ["trust signals"]
      },
      "objections_handled": ["objection 1", "objection 2"],
      "micro_commitments": ["micro-commitment requested from the user"],
      "emotional_state": {
        "entry_emotion": "user's emotion when entering the step",
        "exit_emotion": "user's emotion when leaving the step"
      },
      "effectiveness_notes": "notes on the effectiveness of this step"
    }
  ],
  "regenerated_funnel": {
    "concept": "general concept of the regenerated/optimized funnel",
    "improvements_applied": ["improvement 1", "improvement 2"],
    "steps": [
      {
        "step_index": 1,
        "step_name": "regenerated step name",
        "step_type": "type",
        "headline": "proposed headline",
        "subheadline": "proposed subheadline",
        "body_copy": "summary of proposed body copy",
        "cta_text": "proposed CTA text",
        "key_elements": ["element 1", "element 2"],
        "why_improved": "why this step is better than the original"
      }
    ]
  }
}`;

interface MaterialFile {
  data: string;
  name: string;
}

interface Materials {
  links?: string[];
  images?: MaterialFile[];
  documents?: MaterialFile[];
  notes?: string;
  funnelName?: string;
}

function parseJsonResponse(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  let jsonStr = trimmed;
  const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) jsonStr = codeBlock[1].trim();
  try {
    return JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function fetchUrlContent(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    });
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#\d+;/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return text.substring(0, 10000);
  } catch (e) {
    return `[Error fetching ${url}: ${e instanceof Error ? e.message : 'unknown error'}]`;
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { funnel, materials } = body as {
      funnel?: Record<string, unknown>;
      materials?: Materials;
    };

    if (!funnel && !materials) {
      return NextResponse.json(
        { error: 'Provide a saved funnel or upload materials for analysis' },
        { status: 400 }
      );
    }

    const apiKey = (process.env.OPENAI_API_KEY ?? '').trim();
    if (!apiKey) {
      return NextResponse.json(
        { error: 'OPENAI_API_KEY not configured. Add the key in .env.local and restart the server.' },
        { status: 500 }
      );
    }

    const openai = new OpenAI({ apiKey });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contentParts: any[] = [];
    let contextText = '';

    if (funnel) {
      contextText += `\n\n## SAVED FUNNEL DATA:\n${JSON.stringify(funnel, null, 2)}`;
    }

    if (materials) {
      if (materials.funnelName) {
        contextText += `\n\n## FUNNEL NAME: ${materials.funnelName}`;
      }

      if (materials.links && materials.links.length > 0) {
        contextText += '\n\n## RETRIEVED WEB PAGE CONTENT:';
        const urlResults = await Promise.all(
          materials.links.map(async (link) => {
            const content = await fetchUrlContent(link);
            return `\n\n### URL: ${link}\n${content}`;
          })
        );
        contextText += urlResults.join('');
      }

      if (materials.notes) {
        contextText += `\n\n## ADDITIONAL ANALYST NOTES:\n${materials.notes}`;
      }
    }

    contentParts.push({
      type: 'text',
      text: `Analyze this funnel and perform a complete reverse engineering based on all provided materials. Identify each step, analyze it in depth, and propose a regenerated/optimized version.\n${contextText}`,
    });

    if (materials?.images && materials.images.length > 0) {
      for (const img of materials.images) {
        contentParts.push({
          type: 'image_url',
          image_url: { url: img.data, detail: 'high' as const },
        });
      }
    }

    if (materials?.documents && materials.documents.length > 0) {
      for (const doc of materials.documents) {
        try {
          contentParts.push({
            type: 'file',
            file: {
              filename: doc.name,
              file_data: doc.data,
            },
          });
        } catch {
          contextText += `\n\n[Document "${doc.name}" uploaded but not directly processable. Use screenshots for better results.]`;
        }
      }
    }

    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: contentParts },
      ],
      temperature: 0.4,
      max_tokens: 16384,
      response_format: { type: 'json_object' },
    });

    const rawText = completion.choices[0]?.message?.content ?? '';
    const analysis = parseJsonResponse(rawText);

    return NextResponse.json({
      success: true,
      analysis: analysis ?? rawText,
      analysisRaw: !analysis ? rawText : undefined,
      usage: completion.usage,
      model: MODEL,
    });
  } catch (error) {
    console.error('[reverse-funnel/analyze] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Error during reverse funnel analysis',
      },
      { status: 500 }
    );
  }
}
