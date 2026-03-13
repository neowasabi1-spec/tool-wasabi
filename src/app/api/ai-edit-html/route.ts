import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

type AIModel = 'claude' | 'gemini';

interface EditRequest {
  html: string;
  prompt: string;
  model: AIModel;
}

const CHUNK_SYSTEM_PROMPT = `You are an expert front-end developer and brand designer.
Your task is to MODIFY the provided HTML code according to the user's instructions.

FUNDAMENTAL RULES:
1. Return ONLY the modified HTML code, NOTHING else — no text, explanations or markdown.
2. DO NOT add \`\`\`html or other code blocks. Pure HTML output.
3. Keep the HTML structure intact — only modify what is relevant to the prompt.
4. If the prompt asks for a brand/style change, modify ALL elements consistently:
   - Colors (background, text, borders, buttons, gradients)
   - Font families and text styles
   - Text/copy if relevant to the new brand
   - Icons and images if they have modifiable URLs
   - Shadows, border-radius, spacing for consistency with the new style
5. Be COMPLETE: do not leave elements with the old style. Every modification must be uniform.
6. Preserve ALL links, forms, inputs, functional scripts and semantic structure.
7. If you find inline styles, modify them. If you find CSS classes in a <style> tag, modify those too.`;

function splitHtmlIntoChunks(html: string): { chunks: string[]; boundaries: number[] } {
  if (html.length < 15000) {
    return { chunks: [html], boundaries: [0] };
  }

  const bodyMatch = html.match(/<body[\s\S]*?<\/body>/i);

  if (!bodyMatch) {
    if (html.length < 60000) {
      return { chunks: [html], boundaries: [0] };
    }
    const mid = Math.floor(html.length / 2);
    const splitPoint = html.lastIndexOf('>', mid) + 1 || mid;
    return {
      chunks: [html.substring(0, splitPoint), html.substring(splitPoint)],
      boundaries: [0, splitPoint],
    };
  }

  const bodyContent = bodyMatch[0];
  const bodyStart = html.indexOf(bodyContent);
  const beforeBody = html.substring(0, bodyStart);
  const afterBody = html.substring(bodyStart + bodyContent.length);

  const bodyInner = bodyContent.replace(/^<body[^>]*>/i, '').replace(/<\/body>$/i, '');

  const topElements: { start: number; end: number }[] = [];
  let topDepth = 0;
  let topStart = 0;

  for (let i = 0; i < bodyInner.length; i++) {
    if (bodyInner[i] === '<') {
      const rest = bodyInner.substring(i);
      const tagMatch = rest.match(/^<(\/?)(\w+)([^>]*?)(\/?)>/);
      if (tagMatch) {
        const isClose = tagMatch[1] === '/';
        const isSelfClose = tagMatch[4] === '/' || /^(br|hr|img|input|meta|link|area|base|col|embed|source|track|wbr)$/i.test(tagMatch[2]);

        if (!isSelfClose) {
          if (isClose) {
            topDepth--;
            if (topDepth === 0) {
              topElements.push({ start: topStart, end: i + tagMatch[0].length });
            }
          } else {
            if (topDepth === 0) {
              topStart = i;
            }
            topDepth++;
          }
        }
      }
    }
  }

  if (topElements.length === 0) {
    return {
      chunks: [beforeBody + bodyContent, afterBody].filter(Boolean),
      boundaries: [0, beforeBody.length + bodyContent.length],
    };
  }

  const TARGET_CHUNK_SIZE = 12000;
  const chunks: string[] = [];
  const boundaries: number[] = [];
  let currentChunk = '';
  let chunkStart = 0;

  chunks.push(beforeBody + '<body' + (bodyContent.match(/^<body([^>]*)>/i)?.[1] || '') + '>');
  boundaries.push(0);

  for (let j = 0; j < topElements.length; j++) {
    const elem = topElements[j];
    const elemContent = bodyInner.substring(elem.start, elem.end);

    if (currentChunk.length + elemContent.length > TARGET_CHUNK_SIZE && currentChunk.length > 0) {
      chunks.push(currentChunk);
      boundaries.push(chunkStart);
      currentChunk = elemContent;
      chunkStart = elem.start;
    } else {
      if (currentChunk.length === 0) chunkStart = elem.start;
      currentChunk += elemContent;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
    boundaries.push(chunkStart);
  }

  chunks.push('</body>' + afterBody);
  boundaries.push(bodyStart + bodyContent.length);

  return { chunks, boundaries };
}

async function editWithClaude(
  html: string,
  prompt: string,
  onChunk: (data: Record<string, unknown>) => void
): Promise<string> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { chunks } = splitHtmlIntoChunks(html);

  const totalChunks = chunks.length;
  onChunk({ type: 'info', totalChunks, model: 'claude' });

  if (totalChunks <= 1) {
    onChunk({ type: 'chunk-start', chunkIndex: 0, totalChunks: 1, label: 'Full page' });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000,
      system: CHUNK_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `INSTRUCTIONS: ${prompt}\n\nHTML TO MODIFY:\n${html}`,
        },
      ],
    });

    const result =
      response.content[0].type === 'text' ? response.content[0].text : '';
    onChunk({ type: 'chunk-done', chunkIndex: 0, totalChunks: 1 });
    return cleanAiOutput(result);
  }

  const headChunk = chunks[0];
  const bodyChunks = chunks.slice(1, -1);
  const tailChunk = chunks[chunks.length - 1];

  onChunk({
    type: 'chunk-start',
    chunkIndex: 0,
    totalChunks,
    label: 'Head and initial structure',
  });

  const headResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    system: CHUNK_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `INSTRUCTIONS: ${prompt}\n\nThis is the FIRST PART (head + body opening) of an HTML page. Modify CSS styles, meta tags, and any relevant elements.\n\nHTML CHUNK:\n${headChunk}`,
      },
    ],
  });
  const modifiedHead =
    headResponse.content[0].type === 'text' ? headResponse.content[0].text : headChunk;
  onChunk({ type: 'chunk-done', chunkIndex: 0, totalChunks });

  const modifiedBodyChunks: string[] = [];
  for (let i = 0; i < bodyChunks.length; i++) {
    const chunkIdx = i + 1;
    onChunk({
      type: 'chunk-start',
      chunkIndex: chunkIdx,
      totalChunks,
      label: `Section ${i + 1} of ${bodyChunks.length}`,
    });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000,
      system: CHUNK_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `INSTRUCTIONS: ${prompt}\n\nThis is SECTION ${i + 1} of ${bodyChunks.length} of an HTML page body. Apply modifications consistently with the rest of the page.\nContext: you are modifying the brand/style of the entire page, so modify ALL visual elements in this section.\n\nHTML CHUNK:\n${bodyChunks[i]}`,
        },
      ],
    });

    const result =
      response.content[0].type === 'text' ? response.content[0].text : bodyChunks[i];
    modifiedBodyChunks.push(cleanAiOutput(result));
    onChunk({ type: 'chunk-done', chunkIndex: chunkIdx, totalChunks });
  }

  const finalHtml = cleanAiOutput(modifiedHead) + modifiedBodyChunks.join('') + tailChunk;
  return finalHtml;
}

async function editWithGemini(
  html: string,
  prompt: string,
  onChunk: (data: Record<string, unknown>) => void
): Promise<string> {
  const apiKey = (process.env.GOOGLE_GEMINI_API_KEY ?? '').trim();
  if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY not configured');

  const { chunks } = splitHtmlIntoChunks(html);
  const totalChunks = chunks.length;
  onChunk({ type: 'info', totalChunks, model: 'gemini' });

  const geminiCall = async (userContent: string): Promise<string> => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: CHUNK_SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userContent }] }],
        generationConfig: {
          maxOutputTokens: 65536,
          temperature: 0.7,
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  };

  if (totalChunks <= 1) {
    onChunk({ type: 'chunk-start', chunkIndex: 0, totalChunks: 1, label: 'Full page' });
    const result = await geminiCall(`INSTRUCTIONS: ${prompt}\n\nHTML TO MODIFY:\n${html}`);
    onChunk({ type: 'chunk-done', chunkIndex: 0, totalChunks: 1 });
    return cleanAiOutput(result);
  }

  const headChunk = chunks[0];
  const bodyChunks = chunks.slice(1, -1);
  const tailChunk = chunks[chunks.length - 1];

  onChunk({
    type: 'chunk-start',
    chunkIndex: 0,
    totalChunks,
    label: 'Head and initial structure',
  });

  const modifiedHead = await geminiCall(
    `INSTRUCTIONS: ${prompt}\n\nThis is the FIRST PART (head + body opening) of an HTML page. Modify CSS styles, meta tags, and any relevant elements.\n\nHTML CHUNK:\n${headChunk}`
  );
  onChunk({ type: 'chunk-done', chunkIndex: 0, totalChunks });

  const modifiedBodyChunks: string[] = [];
  for (let i = 0; i < bodyChunks.length; i++) {
    const chunkIdx = i + 1;
    onChunk({
      type: 'chunk-start',
      chunkIndex: chunkIdx,
      totalChunks,
      label: `Section ${i + 1} of ${bodyChunks.length}`,
    });

    const result = await geminiCall(
      `INSTRUCTIONS: ${prompt}\n\nThis is SECTION ${i + 1} of ${bodyChunks.length} of an HTML page body. Apply modifications consistently with the rest of the page.\nContext: you are modifying the brand/style of the entire page, so modify ALL visual elements in this section.\n\nHTML CHUNK:\n${bodyChunks[i]}`
    );

    modifiedBodyChunks.push(cleanAiOutput(result));
    onChunk({ type: 'chunk-done', chunkIndex: chunkIdx, totalChunks });
  }

  return cleanAiOutput(modifiedHead) + modifiedBodyChunks.join('') + tailChunk;
}

function cleanAiOutput(text: string): string {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```html?\s*\n?/i, '');
  cleaned = cleaned.replace(/\n?```\s*$/i, '');
  cleaned = cleaned.trim();
  return cleaned;
}

export async function POST(request: NextRequest) {
  try {
    const body: EditRequest = await request.json();
    const { html, prompt, model = 'claude' } = body;

    if (!html || !prompt) {
      return new Response(
        JSON.stringify({ error: 'html and prompt are required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        try {
          send({ type: 'start', model, htmlLength: html.length });

          let resultHtml: string;

          if (model === 'gemini') {
            resultHtml = await editWithGemini(html, prompt, send);
          } else {
            resultHtml = await editWithClaude(html, prompt, send);
          }

          send({ type: 'result', html: resultHtml });
          send({ type: 'done' });
        } catch (error) {
          console.error('[ai-edit-html] Error:', error);
          send({
            type: 'error',
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    console.error('[ai-edit-html] Request error:', error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Request error',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
